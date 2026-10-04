// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The wiring: one call that stands up a host-side activator and holds the
 * whole of DoD ① — catch, wake, probe, forward, ack — in one process.
 *
 * `activator.ts` is deliberately portless; `link.ts` supplies the two ports it
 * declares. Neither of them decides *where requests come from*, and until
 * something did, DoD ① could not be run at all. That is this file: an inbound
 * `@qianmo/transport` listener whose handler is {@link Activator.handle}.
 *
 * ## What the receipt to the sender means here
 *
 * The transport server awaits its `onMessage` handler and only then sends a
 * receipt (`server.ts`), so wiring `handle` in directly means the sender's
 * receipt arrives **after the wake completes** — seconds, per E2, not
 * milliseconds. That is a deliberate choice between two honest options:
 *
 * - *Receipt on acceptance* would be prompt, but the sender would then have no
 *   channel at all through which to hear that the wake failed: this host holds
 *   no client back to the sender, and `@qianmo/transport`'s server half cannot
 *   originate an envelope towards a connected peer. A failure would be visible
 *   only in this host's own logs — which is precisely the silence DoD ④ forbids.
 * - *Receipt on outcome* — what this does — costs the sender a longer wait and
 *   buys it an explicit verdict: `Accepted` iff the envelope reached the node
 *   inside the sandbox, `Rejected(E_UNDELIVERABLE)` otherwise, with the
 *   transport's dedup entry dropped so the sender's at-least-once retry can land
 *   rather than being absorbed as a duplicate.
 *
 * Callers must therefore give their client a drain budget larger than this
 * node's `readyTimeoutMs`; a shorter one turns a successful slow wake into a
 * client-side timeout. This node cannot see the sender's budget, so the rule is
 * written down here rather than enforced.
 *
 * ## Known limitation: the receipt carries one code, not ours
 *
 * `@qianmo/transport`'s server answers a handler that threw with a fixed
 * `E_UNDELIVERABLE`; it has no channel for a code chosen by the handler
 * (`server.ts`). So a sender can always tell *that* its envelope was refused,
 * but not *why* — `E_TTL_EXPIRED`, `E_RATE_LIMITED` and `E_UNKNOWN_AGENT` all
 * reach it as `E_UNDELIVERABLE`. The specific code is not lost, it is just
 * local: it is on the audit trail, on the error envelope in
 * {@link ActivatorNodeHandle.failures}, and on the outcome handed to
 * `onOutcome`. Widening the receipt is a `@qianmo/transport` change and belongs
 * to whoever owns the frame grammar, not to this file.
 *
 * ## Where the routing gates sit
 *
 * `activator.ts` still holds none of them: it does one lookup (destination node
 * → sandbox) and knows nothing about loops, hop counts or budgets. This file
 * composes `@qianmo/router` in front of it, in this order per inbound envelope:
 *
 *   unknown target → routing gates (hop backstop, loop key, inbound budget)
 *   → task route registration → catch/wake/forward
 *
 * The unknown-target lookup comes first because a message for a node we do not
 * host is nobody's traffic to account for; the gates come before route
 * registration and before the wake because both of those have costs a refused
 * message must not be able to spend — a wake is seconds of daemon work per
 * E2, and a route holds a channel open until the task deadline.
 *
 * Name resolution is still not here: that is the registry's.
 */

import {
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
  destinationNode,
  errorReply,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import {
  type BackoffOptions,
  type ClientTlsOptions,
  type HandshakeIdentity,
  type InboundContext,
  type TransportServerHandle,
  type TransportServerOptions,
  startTransportServer,
} from '@qianmo/transport'
import {
  type ActivationOutcome,
  Activator,
  DEFAULT_READY_POLL_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  type FailureSink,
  type RecoveryReport,
} from './activator.js'
import { ActivatorEventType, AuditLog } from './audit.js'
import { type Clock, type Scheduler, systemClock } from './clock.js'
import type { SandboxDaemon } from './daemon.js'
import { FileRequestJournal, type RequestJournal } from './journal.js'
import {
  DEFAULT_FORWARD_TIMEOUT_MS,
  DEFAULT_LINK_CONNECT_TIMEOUT_MS,
  type TargetDirectory,
  TransportLinks,
} from './link.js'
import {
  DEFAULT_TASK_ROUTE_CAPACITY,
  TaskRouteError,
  TaskRouteRegistry,
} from './routes.js'
import type { StageTimings, TimingReport, TimingRecorder } from './stages.js'

/** Where the inbound listener binds. */
export interface ActivatorListenOptions {
  /** TCP port. `0` lets the OS choose. Mutually exclusive with `unix`. */
  readonly port?: number
  readonly hostname?: string
  /** Unix socket path. Mutually exclusive with `port`. */
  readonly unix?: string
  /** TLS materials for a public `wss://` listener. */
  readonly tls?: TransportServerOptions['tls']
  /** Seconds of silence before a peer connection is reaped. */
  readonly idleTimeoutSec?: number
}

/** Knobs of {@link startActivatorNode}. */
export interface ActivatorNodeOptions {
  /**
   * This host's node segment. It is what both transport hops authenticate as —
   * inbound from peers and outbound into the sandbox.
   */
  readonly node: string
  /** Pre-shared key for both hops. Injected — never a literal. */
  readonly psk: string
  readonly listen: ActivatorListenOptions
  /**
   * The sandbox supervisor port. Injected rather than built from a URL here so
   * that the loopback assertion and the credential getter stay in `daemon.ts`,
   * the one file allowed to reach the network.
   */
  readonly daemon: SandboxDaemon
  readonly directory: TargetDirectory
  /**
   * The routing gates (P4.2). Defaults to a fresh {@link NodeRouter} for this
   * node — on by default, because a loop detector a deployment has to opt into
   * is one that will be missing from the deployment that needed it. Pass one in
   * to share the loop table with this node's outbound path, which is what makes
   * A→B→A detectable on its first return.
   */
  readonly router?: NodeRouter
  /** Defaults to a file journal under the config root. */
  readonly journal?: RequestJournal
  readonly audit?: AuditLog
  readonly clock?: Clock
  readonly scheduler?: Scheduler
  readonly timings?: TimingRecorder
  readonly maxInFlight?: number
  readonly readyTimeoutMs?: number
  readonly readyPollIntervalMs?: number
  readonly connectTimeoutMs?: number
  readonly forwardTimeoutMs?: number
  readonly linkTls?: ClientTlsOptions
  /**
   * Ed25519 identity and peer directory for the links **out** of this host
   * (key-distribution.md §7.1.1). Forwarded to {@link TransportLinks}; see
   * `TransportLinksOptions.signing` for why it only applies to targets the
   * directory can name.
   *
   * Separate from whatever the listener half of this node is configured with,
   * and deliberately so: a host may be dialling into sandboxes that have
   * already adopted signatures while its own listener still serves peers that
   * have not, and §8.2's phases are per-direction for exactly that reason.
   */
  readonly linkSigning?: HandshakeIdentity
  readonly taskRouteCapacity?: number
  /** Reconnect schedule of the links into sandboxes. */
  readonly backoff?: Partial<BackoffOptions>
  /** Injected in tests so request ids are readable. */
  readonly newRequestId?: () => string
  /**
   * Called once per request that reached a terminal state, in order.
   *
   * This is the seam the P2.5 acceptance script and the P3.1 / P4.1 baselines
   * read: the stage timings are on the outcome, and a refusal — which has no
   * timings, because it was never accepted — arrives here too rather than being
   * visible only as a receipt the sender got.
   */
  readonly onOutcome?: (outcome: ActivationOutcome) => void
}

/** A running activator node. */
export interface ActivatorNodeHandle {
  readonly activator: Activator
  readonly audit: AuditLog
  readonly links: TransportLinks
  readonly routes: TaskRouteRegistry
  /** The routing gates in force, with their own audit trail (AC-3). */
  readonly router: NodeRouter
  readonly journal: RequestJournal
  /** Dial URL for peers, when listening on TCP. */
  readonly url?: string
  readonly port?: number
  readonly unix?: string
  /** What the startup replay of the journal did. */
  readonly recovery: RecoveryReport
  /** Explicit failures sent back, most recent last, bounded. */
  failures(): readonly QianmoMessage[]
  report(): TimingReport
  samples(): readonly StageTimings[]
  stop(): Promise<void>
}

/** How many failure replies the handle keeps for inspection. */
export const DEFAULT_FAILURE_CAPACITY = 64

/**
 * Raised out of the inbound handler so the transport rejects the envelope.
 *
 * Carries the protocol code the activator settled on, so the reason an operator
 * reads in the transport's records is the activator's reason and not a generic
 * one invented at this boundary.
 */
class ActivationRejected extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = 'ActivationRejected'
    this.code = code
  }
}

/** Keeps the last N failure replies and relays them when a route exists. */
class BoundedFailures implements FailureSink {
  readonly #replies: QianmoMessage[] = []
  readonly #routes: TaskRouteRegistry
  readonly #capacity: number

  constructor(
    routes: TaskRouteRegistry,
    capacity: number = DEFAULT_FAILURE_CAPACITY,
  ) {
    this.#routes = routes
    this.#capacity = capacity
  }

  fail(reply: QianmoMessage): void {
    this.record(reply)
    this.#routes.forward(reply)
  }

  record(reply: QianmoMessage): void {
    this.#replies.push(reply)
    if (this.#replies.length > this.#capacity) this.#replies.shift()
  }

  replies(): readonly QianmoMessage[] {
    return [...this.#replies]
  }
}

/**
 * Stand up an activator node: listener, journal, links, and a startup replay.
 *
 * The replay runs **before** the listener binds. A node that started taking new
 * requests while its journal still held unanswered ones would be racing itself
 * for the same wake, and a request that survived a crash deserves to be settled
 * ahead of one that has not yet been made.
 */
export async function startActivatorNode(
  options: ActivatorNodeOptions,
): Promise<ActivatorNodeHandle> {
  const audit = options.audit ?? new AuditLog()
  const clock = options.clock ?? systemClock
  const journal = options.journal ?? new FileRequestJournal(undefined, audit)
  const routes = new TaskRouteRegistry({
    audit,
    clock,
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
    capacity: options.taskRouteCapacity ?? DEFAULT_TASK_ROUTE_CAPACITY,
  })
  // No `deadlineNow` here, and that is a limitation rather than an oversight:
  // this process has no process-wide time-jump observer to supply one (the
  // activator's gate lives inside its own wait loop). So after a freeze *of the
  // host*, loop keys may expire a little early — a window in which a loop would
  // read as fresh traffic. The terminal node's router is the gated one
  // (`resident.ts` passes `ResidentDeadlineClock.nowFor`), so the guard closest
  // to the mailbox write does not have this gap.
  const router =
    options.router ??
    new NodeRouter({ node: options.node, now: () => clock.now() })
  const failures = new BoundedFailures(routes)
  const links = new TransportLinks({
    node: options.node,
    psk: options.psk,
    directory: options.directory,
    audit,
    clock,
    onReply: (message, sandboxName) => {
      routes.forward(message, sandboxName)
      // A terminal reply ends the task here, so its loop keys can go now
      // rather than at the delivery deadline (protocol.md §8.2 rows 19–20).
      // An `ack` keeps them: the task is still running and a second request
      // for the same handler is still a loop.
      if (message.type !== MessageType.Ack) router.release(message.taskId)
    },
    ...(options.linkTls === undefined ? {} : { tls: options.linkTls }),
    ...(options.linkSigning === undefined
      ? {}
      : { signing: options.linkSigning }),
    connectTimeoutMs:
      options.connectTimeoutMs ?? DEFAULT_LINK_CONNECT_TIMEOUT_MS,
    forwardTimeoutMs: options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS,
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
  })

  const activator = new Activator({
    daemon: options.daemon,
    readyProbe: links,
    forward: links,
    failures,
    journal,
    audit,
    clock,
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
    ...(options.timings === undefined ? {} : { timings: options.timings }),
    ...(options.maxInFlight === undefined
      ? {}
      : { maxInFlight: options.maxInFlight }),
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    readyPollIntervalMs:
      options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS,
    ...(options.newRequestId === undefined
      ? {}
      : { newRequestId: options.newRequestId }),
  })

  const recovery = await activator.recover()

  const report = (outcome: ActivationOutcome): void => {
    options.onOutcome?.(outcome)
  }

  let server: TransportServerHandle
  try {
    server = startTransportServer({
      psk: options.psk,
      ...(options.listen.port === undefined
        ? {}
        : { port: options.listen.port }),
      ...(options.listen.hostname === undefined
        ? {}
        : { hostname: options.listen.hostname }),
      ...(options.listen.unix === undefined
        ? {}
        : { unix: options.listen.unix }),
      ...(options.listen.tls === undefined ? {} : { tls: options.listen.tls }),
      ...(options.listen.idleTimeoutSec === undefined
        ? {}
        : { idleTimeoutSec: options.listen.idleTimeoutSec }),
      onMessage: async (
        message: QianmoMessage,
        context: InboundContext,
      ): Promise<void> => {
        const node = destinationNode(message)
        const sandboxName =
          node === null ? undefined : options.directory.sandboxOf(node)
        if (sandboxName === undefined) {
          const at = clock.now()
          const reason = `no sandbox is mapped for node ${JSON.stringify(node ?? message.to)}`
          audit.record(ActivatorEventType.RequestRefused, at, {
            msgId: message.msgId,
            taskId: message.taskId,
            code: ProtocolErrorCode.E_UNKNOWN_AGENT,
            reason,
          })
          const reply = errorReply(
            message,
            ProtocolErrorCode.E_UNKNOWN_AGENT,
            reason,
            at,
          )
          failures.record(reply)
          context.channel.send(reply)
          throw new ActivationRejected(
            ProtocolErrorCode.E_UNKNOWN_AGENT,
            reason,
          )
        }

        const routed = router.inbound(message)
        if (!routed.ok) {
          // The router has already written the AC-3 audit event with the whole
          // message chain on it; what is left is telling the sender, in the
          // same shape the unknown-target path uses.
          const reply = errorReply(
            message,
            routed.code,
            routed.reason,
            clock.now(),
          )
          failures.record(reply)
          context.channel.send(reply)
          throw new ActivationRejected(routed.code, routed.reason)
        }

        if (message.type === MessageType.TaskRequest) {
          try {
            routes.register(message, sandboxName, context.channel)
          } catch (error) {
            const code =
              error instanceof TaskRouteError
                ? error.code
                : ProtocolErrorCode.E_UNDELIVERABLE
            const reason =
              error instanceof Error ? error.message : String(error)
            const reply = errorReply(message, code, reason, clock.now())
            failures.record(reply)
            context.channel.send(reply)
            throw new ActivationRejected(code, reason)
          }
        }

        const outcome = await activator.handle({
          envelope: message,
          sandboxName,
        })
        report(outcome)
        if (outcome.status !== 'forwarded') {
          throw new ActivationRejected(outcome.code, outcome.reason)
        }
      },
    })
  } catch (error) {
    routes.close()
    await links.close()
    throw error
  }

  return {
    activator,
    audit,
    links,
    routes,
    router,
    journal,
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.port === undefined ? {} : { port: server.port }),
    ...(server.unix === undefined ? {} : { unix: server.unix }),
    recovery,
    failures: () => failures.replies(),
    report: () => activator.report(),
    samples: () => activator.samples(),
    stop: async (): Promise<void> => {
      routes.close()
      await server.stop()
      await links.close()
    },
  }
}
