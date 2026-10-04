// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The routing layer's two gates, as one per-node object.
 *
 * Everything a node has to decide about a message *besides* what it says lives
 * here: has this handler already been asked to do this task, has this hop count
 * run away, has this peer used up its inbound budget, may we send one more
 * message to this address. `@qianmo/transport` states in its own header that it
 * carries none of this, `@qianmo/adapter` states that these steps slot in ahead
 * of its mailbox write, and `@qianmo/activator` states that it does no loop
 * detection or rate accounting. This is the package all three point at.
 *
 * ## One object per node, both directions
 *
 * The loop table is shared between the two faces on purpose. Outbound seeding
 * writes the originating handler into it (D-2's second defect: the origin does
 * not seed itself); inbound admission reads it. Split them into two objects and
 * A→B→A stops being detectable at A on the first return — which is precisely
 * what AC-3 constructs.
 *
 * ## Ordering inside `inbound`
 *
 * Authorization, then hop backstop, then loop, then the inbound budget.
 *
 * Authorization first is rule S-2: nothing an unauthorized message asks for
 * should cost this node anything, down to a table entry.
 *
 * The last two are **inverted relative to S-2's listing**, which puts the rate
 * budget ahead of loop detection. Recorded rather than silent, with the reason:
 * a message that is a loop must be *reported as a loop*. Under a flood, a
 * budget-first order would replace the one event AC-3 asks for with a rate
 * rejection, and the operator would learn that a peer was noisy but not that
 * traffic was circling. What budget-first buys is protection of the loop table
 * from churn — and that is already bought, by the table's own capacity bound.
 * S-2's own stated rationale is about side effects and the mailbox write being
 * last, neither of which this ordering touches. protocol.md §10.1 carries the
 * same note.
 *
 * ## The two clocks
 *
 * Loop entries are judged on the **gated** clock when the host supplies one
 * (rule T-2): a node that just thawed must not prune the table in the same
 * instant its gated deadline check is still admitting the messages those
 * entries protect. A host with no gate to offer falls back to the raw clock and
 * accepts a short window after a thaw in which a loop reads as fresh traffic —
 * `activator/src/node.ts` says which side of that line it is on.
 *
 * Rate buckets are judged on the raw clock either way: a freeze really did
 * consume wall time, and a bucket that refused to refill across it would punish
 * a node for having been asleep.
 */

import {
  advanceTraceparent,
  CapabilityLevel,
  deliveryExpiresAt,
  isReplyType,
  ProtocolError,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  withHop,
  type NoticeTrust,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { CapabilityGate } from './capability.js'
import {
  chainDetail,
  RouterAuditLog,
  RouterEventType,
  type RouterAuditSink,
} from './audit.js'
import { LoopGuard, LoopVerdict } from './loop.js'
import { InboundBudget, RuntimeThrottle } from './rate.js'

/**
 * Refusal code of the runtime layer.
 *
 * Deliberately **not** a `ProtocolErrorCode` member. It never travels on the
 * wire: protocol.md §6.4 keeps the runtime token bucket out of the state
 * machine, and §11's code table is the set of things a peer can be told. Adding
 * it there would make the two layers indistinguishable to every reader of a log
 * line, which is the one thing charter AC-3 asks us not to do.
 */
export const E_RUNTIME_THROTTLED = 'E_RUNTIME_THROTTLED'

/** Every code {@link NodeRouter} can refuse with. */
export type RouterRejectionCode = ProtocolErrorCode | typeof E_RUNTIME_THROTTLED

/** Outcome of one gate. `message` is the envelope to actually use. */
export type RouterVerdict<C extends RouterRejectionCode = RouterRejectionCode> =
  | { readonly ok: true; readonly message: QianmoMessage }
  | { readonly ok: false; readonly code: C; readonly reason: string }

/**
 * What {@link NodeRouter.inbound} answers.
 *
 * The failure branch is narrowed to `ProtocolErrorCode` on purpose: an inbound
 * refusal is told to the peer as an `error` envelope, and the runtime layer's
 * code is not something a peer may be told (§6.4). The narrowing makes that a
 * type error rather than a review comment.
 *
 * The success branch carries the capability level the message presented — a
 * **ceiling** on what it may cause here, never a grant (rule S-3). With no
 * capability gate configured it is `read`, which is what an unauthenticated
 * message carries by definition.
 */
export type InboundVerdict =
  | {
      readonly ok: true
      readonly message: QianmoMessage
      readonly level: CapabilityLevel
      /** Issuing node of the presented token, when there was one. */
      readonly issuer?: string
      /**
       * Provenance tier, as the capability gate decided it (issue #28).
       * `untrusted` with no gate configured, which is what a node that cannot
       * verify anything has learned about a message: nothing.
       */
      readonly trust: NoticeTrust
    }
  | {
      readonly ok: false
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

/** What {@link NodeRouter.outbound} answers — local, so both codes are legal. */
export type OutboundVerdict = RouterVerdict

export interface NodeRouterOptions {
  /** This node's own segment, written into `hops` on the way out (§6.3). */
  readonly node: string
  readonly audit?: RouterAuditLog
  readonly auditSink?: RouterAuditSink
  /**
   * Authorization (P4.3). Absent means every message counts as `read` and the
   * node has no opinion about levels — which is a node with no keys, not a node
   * that skipped a check.
   */
  readonly capability?: CapabilityGate
  readonly loop?: LoopGuard
  readonly throttle?: RuntimeThrottle
  readonly budget?: InboundBudget
  /** Raw wall clock. */
  readonly now?: () => number
  /**
   * Time-jump-gated clock for deadline arithmetic, as
   * `ResidentDeadlineClock.nowFor` and the adapter's `deadlineNow` supply it.
   * Defaults to the raw clock.
   */
  readonly deadlineNow?: (createdAt: number) => number
}

/** The failure branch alone, so it fits both verdict shapes. */
function reject<C extends RouterRejectionCode>(
  code: C,
  reason: string,
): { readonly ok: false; readonly code: C; readonly reason: string } {
  return { ok: false, code, reason }
}

/** The loop guard and both rate layers, wired for one node. */
export class NodeRouter {
  readonly node: string
  readonly audit: RouterAuditLog
  readonly loop: LoopGuard
  readonly throttle: RuntimeThrottle
  readonly budget: InboundBudget
  readonly capability: CapabilityGate | undefined
  readonly #now: () => number
  readonly #deadlineNow: (createdAt: number) => number

  constructor(options: NodeRouterOptions) {
    this.node = options.node
    this.audit =
      options.audit ?? new RouterAuditLog(undefined, options.auditSink)
    this.loop = options.loop ?? new LoopGuard()
    this.throttle = options.throttle ?? new RuntimeThrottle()
    this.budget = options.budget ?? new InboundBudget()
    this.capability = options.capability
    this.#now = options.now ?? Date.now
    this.#deadlineNow = options.deadlineNow ?? (() => this.#now())
  }

  /**
   * Gate one message on its way to a transport, and stamp this node into it.
   *
   * This is protocol.md §6.3's call site for `withHop`, both halves of it: the
   * origin's initial seeding and a relay's append are the same act — "about to
   * hand this envelope to a transport" — so they are one method rather than two
   * that a caller could pick wrongly between.
   *
   * Replies pass the throttle untouched. A `task.result` that a token bucket
   * refused would leave the requester waiting out its task deadline for an
   * answer this node already has, i.e. throttling would convert a load problem
   * into a correctness one. Their volume is bounded by the requests that were
   * throttled on the way in.
   */
  outbound(message: QianmoMessage): OutboundVerdict {
    const now = this.#now()
    const subject = !isReplyType(message.type)

    if (subject && !this.throttle.admit(message.from, message.to, now)) {
      this.audit.record(RouterEventType.RuntimeThrottled, now, {
        ...chainDetail(message),
        code: E_RUNTIME_THROTTLED,
        tokensLeft: this.throttle.remaining(message.from, message.to, now),
      })
      return reject(
        E_RUNTIME_THROTTLED,
        `runtime throttle: ${message.from} has spent its budget towards ${message.to}`,
      )
    }

    const relaying = message.hops.length > 0
    let stamped: QianmoMessage
    try {
      // A relay continues the trace rather than repeating it (§7.1): same
      // trace-id, its own parent-id. The origin's header was minted moments
      // ago by `createMessage` and needs nothing.
      stamped = withHop(
        relaying
          ? { ...message, traceId: advanceTraceparent(message.traceId) }
          : message,
        this.node,
      )
    } catch (error) {
      const reason =
        error instanceof ProtocolError
          ? error.message
          : `withHop failed: ${String(error)}`
      return reject(ProtocolErrorCode.E_TOO_MANY_HOPS, reason)
    }

    if (subject && message.hops.length === 0) {
      // Origin seeding of the loop table, the counterpart of `hops[0]`: the
      // handler that starts a task owns it here, so a *request* coming back to
      // that address under the same task is caught on its first return rather
      // than on its second lap.
      this.loop.seed(message.from, message.taskId, deliveryExpiresAt(message))
    }
    return { ok: true, message: stamped }
  }

  /**
   * Gate one message arriving from a peer.
   *
   * Runs after envelope validation and dedup — both of which the transport has
   * already done by the time a handler sees the message — and before anything
   * with a side effect: the wake in `@qianmo/activator`, the mailbox write in
   * `@qianmo/adapter`. Rule L-1: a refused message must not consume the
   * recipient's inbox quota, or rate limiting would help an attacker evict
   * somebody else's unread mail.
   *
   * Authorization is first, per rule S-2 — an unauthorized message must not be
   * able to spend anything, not even a table entry. The order of the two
   * remaining gates is inverted relative to S-2's listing, and deliberately:
   * see the module header.
   */
  inbound(message: QianmoMessage): InboundVerdict {
    const now = this.#now()
    const gatedNow = this.#deadlineNow(message.createdAt)

    let level = CapabilityLevel.Read
    let issuer: string | undefined
    let trust: NoticeTrust = TRUST_UNTRUSTED
    if (this.capability !== undefined) {
      const decision = this.capability.check(message, now)
      if (!decision.ok) {
        this.audit.record(RouterEventType.CapabilityDenied, now, {
          ...chainDetail(message),
          code: decision.code,
          reason: decision.reason,
        })
        return reject(decision.code, decision.reason)
      }
      level = decision.level
      issuer = decision.issuer
      trust = decision.trust
    }

    const verdict = this.loop.admit(message, gatedNow)
    if (verdict === LoopVerdict.Revisited) {
      const reason = `loop: ${message.to} has already been asked to handle task ${message.taskId}`
      this.audit.record(RouterEventType.LoopDetected, now, {
        ...chainDetail(message),
        code: ProtocolErrorCode.E_LOOP,
        reason,
      })
      return reject(ProtocolErrorCode.E_LOOP, reason)
    }
    if (verdict === LoopVerdict.HopLimitExceeded) {
      const reason = `hop backstop: ${message.hops.length} hops recorded on task ${message.taskId}`
      this.audit.record(RouterEventType.LoopDetected, now, {
        ...chainDetail(message),
        code: ProtocolErrorCode.E_TOO_MANY_HOPS,
        reason,
      })
      return reject(ProtocolErrorCode.E_TOO_MANY_HOPS, reason)
    }

    if (!this.budget.admit(message.from, now)) {
      const reason = `inbound budget: sender ${message.from} exceeded this node's per-minute allowance`
      this.audit.record(RouterEventType.RateLimited, now, {
        ...chainDetail(message),
        code: ProtocolErrorCode.E_RATE_LIMITED,
        reason,
      })
      return reject(ProtocolErrorCode.E_RATE_LIMITED, reason)
    }

    return {
      ok: true,
      message,
      level,
      trust,
      ...(issuer === undefined ? {} : { issuer }),
    }
  }

  /** Release a task's loop keys once it has reached a terminal state (§8.2). */
  release(taskId: string): void {
    this.loop.release(taskId)
  }
}
