// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two ports DoD ① was missing: how the activator learns that the target is
 * answering, and where the envelope goes once it is.
 *
 * `activator.ts` declares {@link ReadyProbe} and {@link ForwardTarget} and
 * implements neither — deliberately, so the wake logic can be exercised without
 * a network. This file is the one implementation of both, over
 * `@qianmo/transport`, and it is what turns "catch → wake → forward" from a
 * shape into a chain that can be run end to end.
 *
 * ## Why the host dials into the sandbox, rather than waiting to be dialled
 *
 * Two reasons, both forced rather than chosen:
 *
 * 1. **A frozen node cannot dial.** It is not executing. A design in which the
 *    sandbox re-establishes the link after waking would make the activator wait
 *    on an event it can neither observe nor bound; the whole point of this
 *    component is that *it* holds the request and *it* decides when the wait is
 *    over.
 * 2. **`@qianmo/transport`'s server half cannot push.** It answers envelopes
 *    with receipts and offers no way to originate one towards a connected peer
 *    (`server.ts`). So the only direction in which a delivery can be *initiated*
 *    is client → server, which puts the client on the host.
 *
 * The activator therefore sits between two transport hops of the same protocol:
 * one it listens on (peer nodes reach it there) and one it dials (the node
 * inside the sandbox listens there). That is the same shape Knative's activator
 * has, and the reason the base's client-only transport was not enough.
 *
 * ## Why readiness is a fresh handshake and never a cached socket
 *
 * `TransportClient.isReady()` reports that the last handshake completed on a
 * socket that has not since closed. That is not the question. Freezing a
 * sandbox pauses the *process*; nothing closes its sockets, and the peer sees no
 * FIN until some timeout elsewhere fires. So a cached "ready" flag can be true
 * of a node that has been frozen for minutes. (Reasoning about what freezing
 * does and does not touch — not a measurement made here.)
 *
 * A completed pre-shared-key handshake is different: the far side has to read a
 * challenge, compute a MAC over it and answer. That is code running inside the
 * sandbox, which is exactly the claim {@link ReadyProbe} is documented to make.
 * So every probe opens a connection, completes the handshake, and drops it.
 *
 * The cost of that is one dial per poll and a connect/close pair in the target's
 * log; the knob for a deployment that minds is `readyPollIntervalMs` on the
 * activator, not a cached flag here.
 *
 * The probe is also *cheap in the sense E2 made matter*: a handshake touches
 * none of the agent's old working set, so it answers on the fast path while the
 * 9–10 s warm-up is still running. That is a feature, not a gap — protocol.md
 * §4.2 defines `ack` as class A precisely so the wake path does not have to wait
 * for a warm heap. What this probe asserts is what an A-class ack needs: the
 * node is executing and can take the envelope in.
 *
 * ## Why "forwarded" means "receipted"
 *
 * {@link TransportClient.send} returns as soon as the envelope is in the outbox,
 * whether or not the link is up. If forwarding stopped there, the activator
 * would journal `forwarded` for an envelope sitting in a queue on a link to a
 * node that may never come back — which is the silent drop DoD ④ exists to rule
 * out, only harder to see. So a forward waits for the receipt, and a link that
 * cannot produce one within the budget fails the request explicitly.
 */

import { type QianmoMessage, destinationNode } from '@qianmo/protocol'
import {
  type BackoffOptions,
  type ClientTlsOptions,
  type HandshakeIdentity,
  type InboundContext,
  TransportClient,
  type TransportClientOptions,
  type TransportEndpoint,
} from '@qianmo/transport'
import type { ForwardTarget, ReadyProbe } from './activator.js'
import { ActivatorEventType, type AuditLog } from './audit.js'
import { type Clock, systemClock } from './clock.js'

/** One deployed node, as far as this host is concerned. */
export interface TargetSite {
  /** Node segment, as it appears in a `qianmo://<node>/<agent>` address. */
  readonly node: string
  /**
   * The sandbox daemon's `name` for the sandbox hosting that node — the same
   * value `ActivationRequest.sandboxName` carries, and never the sandbox `id`
   * (see `daemon.ts` for what passing an id would quietly do).
   */
  readonly sandboxName: string
  /** Where the node inside that sandbox listens for envelopes. */
  readonly endpoint: TransportEndpoint
}

/**
 * The deployment's node ↔ sandbox ↔ endpoint table.
 *
 * **This is not a registry and does not replace one.** `@qianmo/registry` maps
 * an agent address to an endpoint; neither of the two facts needed here — which
 * sandbox hosts a node, and where inside that sandbox its listener is — appears
 * in an `AgentRecord`. They are deployment facts, they come from the operator,
 * and they are read through this interface so that a future source for them
 * (the registry growing a sandbox field, a node manifest) is a substitution
 * rather than a rewrite.
 *
 * `Activator` itself still resolves nothing: it is handed a `sandboxName` per
 * request and depends on no lookup at all. This table lives in the wiring
 * (`node.ts`), one layer out.
 */
export interface TargetDirectory {
  /** Where the node in this sandbox listens, or `undefined` if unknown. */
  endpointOf(sandboxName: string): TransportEndpoint | undefined
  /** Which node segment this sandbox hosts, or `undefined` if unknown. */
  nodeOf(sandboxName: string): string | undefined
  /** Which sandbox hosts this node segment, or `undefined` if unknown. */
  sandboxOf(node: string): string | undefined
}

/** Raised when the directory has no entry for a target. */
export class UnknownTargetError extends Error {
  readonly target: string

  constructor(
    kind: 'node' | 'sandbox',
    target: string,
    known: readonly string[],
  ) {
    super(
      `no directory entry for ${kind} ${JSON.stringify(target)}; ` +
        `known ${kind}s: ${known.length === 0 ? '(none)' : known.join(', ')}`,
    )
    this.name = 'UnknownTargetError'
    this.target = target
  }
}

/**
 * A fixed table, built once at startup.
 *
 * Refuses duplicates rather than letting a later row win: two rows claiming one
 * node is a configuration mistake whose symptom would otherwise be envelopes
 * going to whichever entry happened to be last.
 */
export class StaticTargetDirectory implements TargetDirectory {
  readonly #byNode = new Map<string, TargetSite>()
  readonly #bySandbox = new Map<string, TargetSite>()

  constructor(sites: readonly TargetSite[]) {
    for (const site of sites) {
      if (this.#byNode.has(site.node)) {
        throw new Error(`duplicate directory entry for node ${site.node}`)
      }
      if (this.#bySandbox.has(site.sandboxName)) {
        throw new Error(
          `duplicate directory entry for sandbox ${site.sandboxName}`,
        )
      }
      this.#byNode.set(site.node, site)
      this.#bySandbox.set(site.sandboxName, site)
    }
  }

  get sites(): readonly TargetSite[] {
    return [...this.#byNode.values()]
  }

  endpointOf(sandboxName: string): TransportEndpoint | undefined {
    return this.#bySandbox.get(sandboxName)?.endpoint
  }

  nodeOf(sandboxName: string): string | undefined {
    return this.#bySandbox.get(sandboxName)?.node
  }

  sandboxOf(node: string): string | undefined {
    return this.#byNode.get(node)?.sandboxName
  }

  /** Sandbox names in the table, for error messages and startup logs. */
  get sandboxNames(): readonly string[] {
    return [...this.#bySandbox.keys()]
  }

  /** Node segments in the table. */
  get nodes(): readonly string[] {
    return [...this.#byNode.keys()]
  }
}

export type LinkReplyHandler = (
  message: QianmoMessage,
  sandboxName: string,
  context: InboundContext,
) => void | Promise<void>

/** Knobs of {@link TransportLinks}. */
export interface TransportLinksOptions {
  /** This host's own node segment; it is what the handshake authenticates as. */
  readonly node: string
  /** Pre-shared key. Injected — never a literal (`@qianmo/transport`). */
  readonly psk: string
  readonly directory: TargetDirectory
  readonly audit: AuditLog
  /** Replies arriving from the resident over the long-lived sandbox link. */
  readonly onReply?: LinkReplyHandler
  readonly clock?: Clock
  readonly tls?: ClientTlsOptions
  /**
   * Sign this host's half of every outbound handshake, and check the node's
   * half back (key-distribution.md §7.1 / §7.1.1).
   *
   * Applied **only to a target the directory can name** — `nodeOf` has to
   * answer before there is anything to check a listener's signature against,
   * and `TransportClient` refuses the pair at construction rather than
   * signing into the void. A directory entry with no node segment therefore
   * dials on the pre-shared key exactly as before, which is also §8.2 phase
   * ①'s coexistence rule seen from the dialling side.
   *
   * The dialling side is the half that matters here: §11 T-B′'s second
   * defence is a *dialer* checking that the endpoint it reached can sign as
   * the node it meant to reach. A listener-only deployment has the guarantee
   * for inbound traffic and nothing at all for its own forwards.
   */
  readonly signing?: HandshakeIdentity
  /**
   * Ceiling on one probe dial. Short on purpose: a probe that has not completed
   * a handshake in this long has told us what we asked — not yet — and the
   * activator's own wake ceiling is the budget that matters.
   */
  readonly connectTimeoutMs?: number
  /** Ceiling on waiting for the receipt that makes a forward a delivery. */
  readonly forwardTimeoutMs?: number
  /** Keep-alive period on the forwarding link. `0` disables it. */
  readonly keepAliveIntervalMs?: number
  /**
   * Reconnect schedule of the forwarding link.
   *
   * Exposed because the link to a sandbox is expected to drop — that is what a
   * freeze does to it — so how fast it comes back is a deployment decision, not
   * an internal one. Nothing here retries a *forward*: the transport replays its
   * own outbox on reconnect, and a second retry loop stacked on top would double
   * every delivery and make the timing report unreadable.
   */
  readonly backoff?: Partial<BackoffOptions>
}

/** Default ceiling on one probe dial. */
export const DEFAULT_LINK_CONNECT_TIMEOUT_MS = 3_000

/** Default ceiling on waiting for a forwarded envelope's receipt. */
export const DEFAULT_FORWARD_TIMEOUT_MS = 10_000

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Readiness probe and forward target over one transport hop per sandbox.
 *
 * Holds two kinds of connection, for two different jobs:
 *
 * - **throwaway probe connections**, one per {@link isReady} call, which exist
 *   only to prove that something inside the sandbox executed the handshake;
 * - **one long-lived forwarding link per sandbox**, which keeps the transport's
 *   own reconnect-and-replay working across a freeze instead of being torn down
 *   and rebuilt underneath an in-flight delivery.
 *
 * Keeping those separate is what makes concurrent requests to one sandbox safe:
 * a probe issued for request 2 cannot close the socket request 1 is waiting for
 * a receipt on.
 */
export class TransportLinks implements ReadyProbe, ForwardTarget {
  readonly #options: TransportLinksOptions
  readonly #clock: Clock
  readonly #connectTimeoutMs: number
  readonly #forwardTimeoutMs: number
  /** One forwarding link per sandbox name. */
  readonly #links = new Map<string, TransportClient>()
  /** Dials in flight, so N concurrent forwards open one link, not N. */
  readonly #dials = new Map<string, Promise<TransportClient>>()

  constructor(options: TransportLinksOptions) {
    this.#options = options
    this.#clock = options.clock ?? systemClock
    this.#connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_LINK_CONNECT_TIMEOUT_MS
    this.#forwardTimeoutMs =
      options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS
  }

  /** Forwarding links currently held. */
  get linkCount(): number {
    return this.#links.size
  }

  /**
   * True once a handshake has completed against the node in this sandbox.
   *
   * Never throws for "not yet": a refused connection, a timeout and a rejected
   * key are all reported as `false` plus an audit record, because the activator
   * polls this and a rejection here would end the request on the first probe —
   * before the sandbox has had any chance to finish waking.
   *
   * A target that is not in the directory *does* throw. That is a configuration
   * error, not a slow wake, and polling it for 45 s before failing would hide
   * the one thing worth reporting.
   */
  async isReady(sandboxName: string): Promise<boolean> {
    const endpoint = this.#endpointOf(sandboxName)
    const probe = new TransportClient(
      this.#clientOptions(endpoint, sandboxName, false),
    )
    try {
      await probe.connect(this.#connectTimeoutMs)
    } catch (error) {
      this.#audit.record(
        ActivatorEventType.LinkProbeFailed,
        this.#clock.now(),
        {
          sandboxName,
          reason: reasonOf(error),
        },
      )
      return false
    } finally {
      // Closed either way: on success the evidence has been collected, and the
      // envelope travels on the long-lived link rather than on this one. A
      // `connect` that rejected leaves its retry loop running, so this is also
      // what keeps a failed probe from becoming a background reconnect storm.
      await probe.close()
    }
    return true
  }

  /**
   * Hand the envelope to the node that owns its destination address.
   *
   * Routing is by the envelope's `to`, not by the sandbox name the activator
   * was given, because this is the point at which the delivery becomes a
   * protocol act again: the address is what the sender wrote and what the
   * receiver will check.
   *
   * @throws when there is no route, no link can be established, or no receipt
   * arrives inside the budget. All three land in `Activator`'s catch, which
   * fails the request explicitly and tells the sender.
   */
  async forward(envelope: QianmoMessage): Promise<void> {
    const node = destinationNode(envelope)
    if (node === null) {
      throw new Error(
        `cannot forward: "to" is not a qianmo address (${JSON.stringify(envelope.to)})`,
      )
    }
    const sandboxName = this.#directory.sandboxOf(node)
    if (sandboxName === undefined) {
      throw new UnknownTargetError('node', node, this.#knownNodes())
    }
    const link = await this.#link(sandboxName)
    await link.sendAndWait(envelope, this.#forwardTimeoutMs)
  }

  /** Close every link. Safe to call twice. */
  async close(): Promise<void> {
    const links = [...this.#links.values()]
    this.#links.clear()
    this.#dials.clear()
    for (const link of links) await link.close()
  }

  get #audit(): AuditLog {
    return this.#options.audit
  }

  get #directory(): TargetDirectory {
    return this.#options.directory
  }

  /**
   * What the directory holds, for an error message — nothing else reads these.
   *
   * `TargetDirectory` deliberately has no "list everything" member: a directory
   * backed by a live registry could not answer it cheaply, and requiring it
   * would rule that implementation out for the sake of a diagnostic. So the
   * static table's listing is used when there *is* one, and the message says
   * "(none)" when there is not.
   */
  #knownNodes(): readonly string[] {
    const directory = this.#directory
    return directory instanceof StaticTargetDirectory ? directory.nodes : []
  }

  #knownSandboxes(): readonly string[] {
    const directory = this.#directory
    return directory instanceof StaticTargetDirectory
      ? directory.sandboxNames
      : []
  }

  #endpointOf(sandboxName: string): TransportEndpoint {
    const endpoint = this.#directory.endpointOf(sandboxName)
    if (endpoint === undefined) {
      throw new UnknownTargetError(
        'sandbox',
        sandboxName,
        this.#knownSandboxes(),
      )
    }
    return endpoint
  }

  #clientOptions(
    endpoint: TransportEndpoint,
    sandboxName: string,
    receiveReplies: boolean,
  ): TransportClientOptions {
    const { node, psk, tls, signing, keepAliveIntervalMs, backoff, onReply } =
      this.#options
    const peerNode = this.#directory.nodeOf(sandboxName)
    return {
      endpoint,
      node,
      psk,
      ...(peerNode === undefined ? {} : { peerNode }),
      // Both or neither: `signing` without `peerNode` is refused by the
      // client's constructor, and refusing it here instead would turn a
      // directory gap into a crash on a forward rather than a PSK dial.
      ...(signing === undefined || peerNode === undefined ? {} : { signing }),
      ...(receiveReplies && onReply !== undefined
        ? {
            onMessage: (message, context) =>
              onReply(message, sandboxName, context),
          }
        : {}),
      ...(tls === undefined ? {} : { tls }),
      ...(keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs }),
      ...(backoff === undefined ? {} : { backoff }),
    }
  }

  /**
   * The forwarding link for a sandbox, dialled on first use.
   *
   * A link that exists but is momentarily down is **kept**, not replaced: the
   * transport reconnects and replays its outbox on its own, and swapping in a
   * fresh client would throw away exactly the envelopes that replay is for.
   *
   * A link that has *given up* is a different case and is replaced. A client
   * whose reconnect budget expired — ten minutes by default, and a sandbox can
   * easily be frozen for longer than that — is closed for good, and `send` on
   * it throws. Replacing it costs whatever was still in its outbox, which was
   * already lost; not replacing it would cost every future request to that
   * sandbox for the lifetime of the process.
   */
  async #link(sandboxName: string): Promise<TransportClient> {
    const existing = this.#links.get(sandboxName)
    if (existing !== undefined && !existing.isClosed()) return existing
    if (existing !== undefined) {
      this.#links.delete(sandboxName)
      this.#audit.record(ActivatorEventType.LinkGaveUp, this.#clock.now(), {
        sandboxName,
        lostFromOutbox: existing.pending,
      })
    }
    const pending = this.#dials.get(sandboxName)
    if (pending !== undefined) return await pending

    const endpoint = this.#endpointOf(sandboxName)
    const dial = (async (): Promise<TransportClient> => {
      const client = new TransportClient(
        this.#clientOptions(endpoint, sandboxName, true),
      )
      try {
        await client.connect(this.#connectTimeoutMs)
      } catch (error) {
        // Nothing is queued on it yet, so closing loses no envelope — and
        // leaving it open would leave a reconnect loop running for a link
        // nobody holds a reference to.
        await client.close()
        throw new Error(
          `no forwarding link to sandbox ${sandboxName}: ${reasonOf(error)}`,
        )
      }
      this.#links.set(sandboxName, client)
      this.#audit.record(ActivatorEventType.LinkOpened, this.#clock.now(), {
        sandboxName,
      })
      return client
    })()
    this.#dials.set(sandboxName, dial)
    try {
      return await dial
    } finally {
      this.#dials.delete(sandboxName)
    }
  }
}
