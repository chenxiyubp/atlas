// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outbound `notify` — the one message a resident starts on its own, and the
 * accounting that keeps it from becoming a way to shout at a person.
 *
 * ## Why this does not go through `NodeRouter.outbound()`
 *
 * Every other envelope this node sends does. `notify` must not, and the reason
 * is arithmetic rather than taste: `outbound()` charges a non-reply to
 * `RuntimeThrottle`, whose ceiling is **20 per minute per (from, to) pair**
 * (`RUNTIME_RATE`, charter AC-3 ①). `LIMITS.notifyRatePerMinute` is **60**. Put
 * the 20 in front of the 60 and the 60 is unreachable — the protocol would
 * carry a number no implementation could ever spend, and the first person to
 * measure it would find the documented ceiling is a third of what it says.
 *
 * The two limits are asking different questions, which is exactly why
 * `rate.ts`'s module header forbids folding them together: the runtime bucket
 * asks "is this sender hammering one address", `NotifyBudget` asks "is this
 * node bothering a human". A notification is not traffic towards a peer, it is
 * an interruption of a person, and it is metered as one.
 *
 * What is *not* skipped: the §6.3 origin hop. `withHop` still stamps this node
 * into `hops[0]` before the envelope reaches a transport, so the audit chain
 * has a head and `maxHops` counts from one. The loop-table seeding
 * `outbound()` also does is deliberately left out — that seeding exists so a
 * *request* returning under the same `taskId` is caught, and a `notify`
 * carries a **fresh** `taskId` every time (§2.4②) which nothing will ever send
 * back. Seeding it would spend a loop-table slot per notification to protect
 * against a shape the protocol forbids by construction.
 *
 * ## Why the node still never dials (H-2)
 *
 * Nothing here opens a connection. A notification either rides a channel the
 * peer already established — the reverse direction of the bidirectional
 * channel the hub dialed to send work in — or it waits in the ledger until the
 * peer makes contact again. {@link ResidentNotifier.drain} is called from the
 * inbound path and from nowhere else, which is the same discipline P13.5's
 * reply redelivery follows and for the same reason: the moment a peer's
 * channel exists is the only moment anything owed to it can leave.
 *
 * ## Why the ledger is P13.5's, not a second one
 *
 * `FileDeliveryLedger` already implements exactly the obligation this needs —
 * four states, an attempt ceiling, crash-safe append, oldest-first
 * `outstanding()`. A second ledger with the same shape would be a second
 * recovery path to get right, and the first one to rot would be the one nobody
 * ships a crash into. Notifications get their own *file*, not their own
 * mechanism: a `task.result` this node owes and a notification it owes are
 * different obligations to the same peer, and mixing them in one file would
 * make "drain the replies but not the notifications" impossible to express.
 */

import {
  MessageType,
  createNotify,
  isNotifyPayload,
  type NotifyPayload,
  type QianmoMessage,
  withHop,
} from '@qianmo/protocol'
import { NotifyBudget } from '@qianmo/router'
import type { DeliveryLedger, DeliveryLedgerEntry } from './delivery-ledger.js'

/**
 * The slice of `TransportChannel` a notification needs.
 *
 * Structural rather than imported so this module — and its tests — never need
 * a live transport. A real `TransportChannel` satisfies it as-is.
 */
export interface NotifyChannel {
  supports(type: MessageType): boolean
  sendAndWait(message: QianmoMessage, timeoutMs?: number): Promise<unknown>
  /** Keep a disconnected server-side channel alive until the send resolves. */
  hold(): () => void
}

/** What the caller of {@link ResidentNotifier.announce} is told. */
export type NotifyOutcome =
  /** On the wire, receipt awaited. */
  | { readonly status: 'sent'; readonly taskId: string; readonly msgId: string }
  /**
   * Recorded and owed. Either no channel was available, or the sliding window
   * is closed — `retryAfterMs` is set only in the second case, because only
   * then is there an instant worth naming.
   */
  | {
      readonly status: 'queued'
      readonly taskId: string
      readonly retryAfterMs?: number
    }
  /**
   * The peer does not implement `notify` (§2.7). A determinate death, not a
   * transient one: nothing is queued, because nothing this node can do will
   * make an older peer understand the type.
   */
  | { readonly status: 'unsupported' }
  /**
   * Suppressed by `dedupKey` against something already outstanding for this
   * peer (§2.4③). Sender-side suppression is the whole of the contract — the
   * receiver never consumes the key.
   */
  | { readonly status: 'duplicate'; readonly taskId: string }
  /** The ledger could not record the obligation; nothing was sent. */
  | { readonly status: 'rejected'; readonly reason: string }

/**
 * What happened to one notification, for the audit trail.
 *
 * Every branch is recorded, refusals included — a trail that only carried the
 * ones that went out could not answer "the operator never saw it, why", which
 * is the only question anyone asks of this path after the fact.
 */
export enum ResidentNotifyEventType {
  /** Handed to the transport. `attempt > 1` means it is a repeat. */
  Sent = 'notify_sent',
  /** Receipted by the peer; the obligation is discharged. */
  Delivered = 'notify_delivered',
  /** Recorded and owed — no channel, or the window is shut. */
  Held = 'notify_held',
  /** Dropped by `dedupKey` against something already outstanding. */
  Suppressed = 'notify_suppressed',
  /** The peer does not implement the type (§2.7). */
  Unsupported = 'notify_unsupported',
  /** Retired without delivery: attempt ceiling, or an unusable ledger line. */
  Abandoned = 'notify_abandoned',
}

/**
 * Version stamp on every notify audit line (hermes B9).
 *
 * Without it, a record missing a field three days from now is ambiguous
 * between "written by an older build" and "edited" — and the hash chain can
 * only tell you *that* something changed, never which of those two it was.
 * Bump this whenever a field is added to or removed from any `detail` below.
 */
export const NOTIFY_EVENT_SCHEMA_VERSION = 1

export interface ResidentNotifyEvent {
  readonly type: ResidentNotifyEventType
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

export type ResidentNotifyAuditSink = (event: ResidentNotifyEvent) => void

export interface ResidentNotifierOptions {
  /** This node's segment, stamped into `hops[0]` (§6.3). */
  readonly node: string
  readonly ledger: DeliveryLedger
  /** Defaults to `LIMITS.notifyRatePerMinute` over a sliding minute. */
  readonly budget?: NotifyBudget
  readonly now?: () => number
  /** Receipt budget for one notification. Defaults to 5 s, as replies use. */
  readonly receiptTimeoutMs?: number
  readonly onError?: (error: unknown) => void
  /**
   * Audit sink. Observation only: a sink that throws is reported through
   * `onError` and changes nothing about what was sent (hermes B8).
   */
  readonly audit?: ResidentNotifyAuditSink
}

const DEFAULT_NOTIFY_RECEIPT_TIMEOUT_MS = 5_000

/**
 * Re-mint a stored notification for one more trip.
 *
 * Always a fresh envelope, never a retransmission, and the reason is the same
 * one P13.5's `redeliveryEnvelope` carries but sharper here:
 * `LIMITS.defaultNotifyTtlMs` is **two minutes**, so a notification that waited
 * for the hub to come back is certain to be past its delivery deadline. Sending
 * the stored bytes would buy an `E_TTL_EXPIRED` and nothing else.
 *
 * **The re-mint also takes a fresh `taskId`, and it must.** This is the one
 * place where notify's redelivery is the opposite of a `task.result`'s: a
 * reply keeps its `taskId` because `isReplyType` exempts it from the loop
 * table, while a `notify` is deliberately *not* exempt (§2.4①). `LoopGuard`
 * records `(to, taskId)` for every non-reply it admits and expires the entry
 * on the delivery deadline — so a second attempt carrying the first attempt's
 * `taskId` inside those two minutes is `Revisited`, i.e. `E_LOOP`, i.e. the
 * redelivery is cut by the very mechanism §2.4② warns about. `createNotify`
 * mints a new one, which is why it is used here rather than `createMessage`.
 *
 * What the receiver has left to recognize the repeat by is `redelivered` plus
 * the sender's `dedupKey`, which is exactly the pair §14.4 says it is — and
 * the honest cost of this design, stated plainly: a hub that ignores both will
 * display one notification twice.
 *
 * `redelivered` goes on from the second attempt. Unlike the `task.result`
 * marker it needs **no** N-1 downgrade: `isNotifyPayload` validates by
 * whitelist rather than by exact key count (§2.2), and `redelivered` has been
 * in that whitelist since `notify` itself existed. Any peer that accepts the
 * type at all accepts the field — so the one case the downgrade protects
 * against (a peer new enough for the type, too old for the field) cannot
 * occur.
 *
 * `undefined` when the stored line is not a notification this node can rebuild
 * — a hand-edited or truncated ledger. The caller abandons it rather than
 * guessing.
 */
function notifyEnvelope(
  entry: DeliveryLedgerEntry,
  attempt: number,
  node: string,
): QianmoMessage | undefined {
  const stored = entry.envelope as unknown as QianmoMessage
  if (
    typeof stored.from !== 'string' ||
    typeof stored.to !== 'string' ||
    typeof stored.contextId !== 'string' ||
    !isNotifyPayload(stored.payload)
  ) {
    return undefined
  }
  const payload: NotifyPayload =
    attempt > 1
      ? { ...stored.payload, redelivered: true as const }
      : stored.payload
  // The §6.3 origin hop goes on **here**, on the way out, rather than being
  // read back off the stored envelope. One stamping site for every attempt:
  // a hop copied from storage would be a hop this attempt never took, and the
  // first thing a chain reconstruction does is trust that list.
  return withHop(
    createNotify({
      from: stored.from,
      to: stored.to,
      contextId: stored.contextId,
      payload,
      ...(typeof stored.deliverTtlMs === 'number'
        ? { deliverTtlMs: stored.deliverTtlMs }
        : {}),
      ...(typeof stored.traceId === 'string'
        ? { traceId: stored.traceId }
        : {}),
    }),
    node,
  )
}

/** The `dedupKey` of a stored notification, when it declared one. */
function dedupKeyOf(entry: DeliveryLedgerEntry): string | undefined {
  const payload = (entry.envelope as unknown as QianmoMessage).payload
  return isNotifyPayload(payload) ? payload.dedupKey : undefined
}

export class ResidentNotifier {
  readonly #node: string
  readonly #ledger: DeliveryLedger
  readonly #budget: NotifyBudget
  readonly #now: () => number
  readonly #receiptTimeoutMs: number
  readonly #options: ResidentNotifierOptions
  /** Notifications on the wire right now, so two drains do not double up. */
  readonly #inFlight = new Set<string>()
  /** Sends awaiting a receipt, so teardown can wait for them. */
  readonly #settling = new Set<Promise<void>>()

  constructor(options: ResidentNotifierOptions) {
    this.#node = options.node
    this.#ledger = options.ledger
    this.#budget = options.budget ?? new NotifyBudget()
    this.#now = options.now ?? Date.now
    this.#receiptTimeoutMs =
      options.receiptTimeoutMs ?? DEFAULT_NOTIFY_RECEIPT_TIMEOUT_MS
    this.#options = options
  }

  /**
   * Record one audit line.
   *
   * The schema stamp is added here rather than by each call site, so a new
   * event type cannot be added without one — the failure B9 exists to prevent
   * is precisely a line that looks complete and is not.
   */
  #emit(
    type: ResidentNotifyEventType,
    detail: Readonly<Record<string, string | number | boolean>>,
  ): void {
    const audit = this.#options.audit
    if (audit === undefined) return
    try {
      audit({
        type,
        at: this.#now(),
        detail: { ...detail, schemaVersion: NOTIFY_EVENT_SCHEMA_VERSION },
      })
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  /** Slots left in the sliding window, for diagnostics and the console. */
  remaining(now = this.#now()): number {
    return this.#budget.remaining(now)
  }

  /** Notifications still owed to `peerNode`, oldest first. */
  outstanding(peerNode?: string): readonly DeliveryLedgerEntry[] {
    try {
      return this.#ledger.outstanding(peerNode)
    } catch (error) {
      this.#options.onError?.(error)
      return []
    }
  }

  /**
   * Record one notification and try to hand it over.
   *
   * The obligation is written down **before** anything is attempted, which is
   * what makes the hub's absence survivable: a notification that is only ever
   * "in flight" disappears with the process, and the whole point of this path
   * is that a watch job's finding outlives a hub restart.
   */
  async announce(input: {
    readonly from: string
    readonly to: string
    readonly peerNode: string
    readonly contextId: string
    readonly payload: NotifyPayload
    /** The peer's channel, when one is open right now. */
    readonly channel?: NotifyChannel
  }): Promise<NotifyOutcome> {
    // Capability discovery ahead of the ledger write (§2.7): a peer that
    // cannot parse the type will refuse every attempt identically, so queueing
    // it would only burn the attempt ceiling on a certainty. Only an open
    // channel can answer the question — with none open, the notification is
    // recorded and the check happens at drain time against whatever peer
    // actually returns.
    if (
      input.channel !== undefined &&
      !input.channel.supports(MessageType.Notify)
    ) {
      this.#emit(ResidentNotifyEventType.Unsupported, {
        peer: input.peerNode,
        summary: input.payload.summary,
      })
      return { status: 'unsupported' }
    }

    const duplicate = this.#duplicateOf(input.peerNode, input.payload.dedupKey)
    if (duplicate !== undefined) {
      this.#emit(ResidentNotifyEventType.Suppressed, {
        peer: input.peerNode,
        taskId: duplicate.taskId,
        dedupKey: input.payload.dedupKey ?? '',
      })
      return { status: 'duplicate', taskId: duplicate.taskId }
    }

    // Stored unstamped and un-sent. Every envelope that reaches the wire is
    // minted by `notifyEnvelope` from this record — including the first — so
    // the first attempt and the fourth differ in exactly one field rather than
    // in which code path built them.
    const draft = createNotify({
      from: input.from,
      to: input.to,
      contextId: input.contextId,
      payload: input.payload,
    })

    let deliveryId: string | undefined
    try {
      deliveryId = this.#ledger.open({
        taskId: draft.taskId,
        peerNode: input.peerNode,
        envelope: draft as unknown as Record<string, unknown>,
      })
    } catch (error) {
      this.#options.onError?.(error)
      return { status: 'rejected', reason: 'notify ledger write failed' }
    }
    if (deliveryId === undefined) {
      return { status: 'rejected', reason: 'notify ledger write failed' }
    }

    if (input.channel === undefined) {
      this.#emit(ResidentNotifyEventType.Held, {
        peer: input.peerNode,
        taskId: draft.taskId,
        traceId: draft.traceId,
        reason: 'no_channel',
      })
      return { status: 'queued', taskId: draft.taskId }
    }

    // Drains the whole backlog rather than just this one, and that ordering is
    // the contract: "按序排空" means a notification produced while the hub was
    // away goes out ahead of one produced after it came back.
    const sent = this.drain(input.channel, input.peerNode)
    if (sent.has(deliveryId)) {
      return {
        status: 'sent',
        taskId: draft.taskId,
        msgId: draft.msgId,
      }
    }
    const retryAfterMs = this.#budget.retryAfterMs(this.#now())
    this.#emit(ResidentNotifyEventType.Held, {
      peer: input.peerNode,
      taskId: draft.taskId,
      traceId: draft.traceId,
      reason: 'budget',
      retryAfterMs,
    })
    return retryAfterMs > 0
      ? { status: 'queued', taskId: draft.taskId, retryAfterMs }
      : { status: 'queued', taskId: draft.taskId }
  }

  /**
   * Hand a peer every notification this node owes it, oldest first.
   *
   * Called from the inbound path — peer contact is the only trigger, because
   * rule H-2 says this node never dials. Returns the delivery ids that reached
   * the wire, which is how {@link ResidentNotifier.announce} tells "sent" from
   * "held".
   *
   * A closed window **stops** the drain rather than skipping past it. Skipping
   * would reorder the backlog — the fifth notification would overtake the
   * first because the first happened to be the one the window refused — and
   * order is the one thing a stream of notifications about the same watch job
   * cannot lose.
   */
  drain(channel: NotifyChannel, peerNode: string): ReadonlySet<string> {
    const sent = new Set<string>()
    if (!channel.supports(MessageType.Notify)) {
      // Determinate death, per peer: retire the backlog rather than spending
      // three attempts each proving the same thing (§2.7, hermes B7).
      for (const entry of this.outstanding(peerNode)) {
        this.#abandon(entry.deliveryId, 'peer does not implement notify')
      }
      return sent
    }
    for (const entry of this.outstanding(peerNode)) {
      if (this.#inFlight.has(entry.deliveryId)) continue
      if (!this.#budget.admit(this.#now())) break
      let attempt = 0
      try {
        attempt = this.#ledger.attempt(entry.deliveryId)
      } catch (error) {
        this.#options.onError?.(error)
        continue
      }
      // `0` is the ledger saying it has just retired this at the ceiling, or
      // that it never knew it. Either way there is nothing left to send.
      if (attempt === 0) continue
      const message = notifyEnvelope(entry, attempt, this.#node)
      if (message === undefined) {
        this.#abandon(
          entry.deliveryId,
          'stored notification cannot be re-minted',
        )
        continue
      }
      this.#send(entry.deliveryId, channel, message, attempt)
      sent.add(entry.deliveryId)
    }
    return sent
  }

  /** Let sends already on the wire be receipted before a teardown. */
  async settle(): Promise<void> {
    while (this.#settling.size > 0) await Promise.all([...this.#settling])
  }

  #duplicateOf(
    peerNode: string,
    dedupKey: string | undefined,
  ): DeliveryLedgerEntry | undefined {
    if (dedupKey === undefined) return undefined
    // Bounded by what is still owed, and deliberately no wider. Suppressing
    // against everything ever *delivered* would need a per-context key set
    // with no retirement rule — the unbounded receiver-side state §2.4③
    // refuses to introduce, just moved to the sender. What this does cover is
    // the failure that actually happens: a watch job re-reporting the same
    // finding every period while the hub is away.
    return this.outstanding(peerNode).find(
      entry => dedupKeyOf(entry) === dedupKey,
    )
  }

  #abandon(deliveryId: string, reason: string): void {
    try {
      this.#ledger.abandon(deliveryId, reason)
    } catch (error) {
      this.#options.onError?.(error)
    }
    this.#emit(ResidentNotifyEventType.Abandoned, { deliveryId, reason })
  }

  #settleDelivery(deliveryId: string, outcome: 'delivered' | 'failed'): void {
    try {
      this.#ledger.settle(deliveryId, outcome)
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  #send(
    deliveryId: string,
    channel: NotifyChannel,
    message: QianmoMessage,
    attempt: number,
  ): void {
    this.#inFlight.add(deliveryId)
    const release = channel.hold()
    const sent = (async () => {
      try {
        await channel.sendAndWait(message, this.#receiptTimeoutMs)
        this.#settleDelivery(deliveryId, 'delivered')
        this.#emit(ResidentNotifyEventType.Delivered, {
          taskId: message.taskId,
          traceId: message.traceId,
          msgId: message.msgId,
          peer: message.to,
        })
      } catch (error) {
        // Left outstanding on purpose. The attempt was spent and the ceiling
        // is what ends this, not a judgement made here — the same fail-open
        // stance the reply ledger takes (invariant #26).
        this.#options.onError?.(error)
      } finally {
        this.#inFlight.delete(deliveryId)
        release()
      }
    })()
    this.#emit(ResidentNotifyEventType.Sent, {
      taskId: message.taskId,
      traceId: message.traceId,
      msgId: message.msgId,
      peer: message.to,
      attempt,
      kind: isNotifyPayload(message.payload) ? message.payload.kind : 'unknown',
      severity: isNotifyPayload(message.payload)
        ? message.payload.severity
        : 'unknown',
      redelivered: attempt > 1,
    })
    this.#settling.add(sent)
    void sent.finally(() => {
      this.#settling.delete(sent)
    })
  }
}
