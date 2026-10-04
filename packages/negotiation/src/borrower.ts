// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The borrowing side.
 *
 * Symmetric to the lender in one respect that matters: it also refuses to keep
 * state a silent peer could strand. A request that is never answered expires on
 * this side too, and expiring means the borrower stops waiting — not that it
 * keeps a slot open in case the offer turns up eventually.
 *
 * ## Why the borrower may say no to an offer
 *
 * A lender is allowed to counter with less than was asked for. Two cores when
 * eight were needed is often still useful; 64 MiB when 2 GiB were needed is
 * not, and taking it would burn a lease to discover that. {@link BorrowerPolicy}
 * is where "not worth taking" is written down, so the decision is a policy
 * rather than a judgement made at the call site.
 */

import {
  MessageType,
  createMessage,
  isResourceOfferPayload,
  newId,
  type QianmoMessage,
  type ReleaseReason,
  type ResourceNeed,
} from '@qianmo/protocol'
import { NegotiationEventType, type NegotiationAuditLog } from './audit.js'
import { offerIsUsable, type BorrowerPolicy } from './policy.js'
import { timerScheduler, type CancelTimer, type Scheduler } from './schedule.js'

/** An offer this side has taken, or is waiting on. */
export interface BorrowedLease {
  readonly taskId: string
  readonly lender: string
  readonly offerId?: string
  readonly granted?: ResourceNeed
  /** The lender's token, to present when using the resource. */
  readonly capability?: string
  readonly state: 'requested' | 'held'
}

export interface BorrowerOptions {
  readonly address: string
  readonly policy: BorrowerPolicy
  readonly audit: NegotiationAuditLog
  readonly now?: () => number
  readonly scheduler?: Scheduler
  /** How long to wait for an offer before giving up. */
  readonly requestTimeoutMs?: number
  readonly newTaskId?: () => string
}

export interface BorrowerReply {
  readonly reply?: QianmoMessage
  readonly lease?: BorrowedLease
  /** Set when the borrower decided the offer was not worth taking. */
  readonly declined?: string
}

/** Default patience for an unanswered request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class BorrowerNegotiator {
  readonly address: string
  readonly #policy: BorrowerPolicy
  readonly #audit: NegotiationAuditLog
  readonly #now: () => number
  readonly #scheduler: Scheduler
  readonly #timeoutMs: number
  readonly #newTaskId: () => string
  readonly #leases = new Map<string, BorrowedLease>()
  readonly #timers = new Map<string, CancelTimer>()

  constructor(options: BorrowerOptions) {
    this.address = options.address
    this.#policy = options.policy
    this.#audit = options.audit
    this.#now = options.now ?? Date.now
    this.#scheduler = options.scheduler ?? timerScheduler
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#newTaskId = options.newTaskId ?? newId
  }

  get pending(): number {
    return this.#leases.size
  }

  lease(taskId: string): BorrowedLease | undefined {
    return this.#leases.get(taskId)
  }

  /** Open a negotiation. The returned envelope is the one to send. */
  request(
    lender: string,
    need: ResourceNeed,
    purpose: string,
  ): { readonly message: QianmoMessage; readonly taskId: string } {
    const now = this.#now()
    const taskId = this.#newTaskId()
    this.#leases.set(taskId, { taskId, lender, state: 'requested' })
    this.#timers.set(
      taskId,
      this.#scheduler.after(this.#timeoutMs, () => {
        // Nobody answered. Stop waiting rather than hold the slot: an offer
        // that arrives after this is refused by `handle` below, which is the
        // same answer the lender's own expiry would have given.
        this.#abandon(taskId, 'expired')
      }),
    )
    return {
      taskId,
      message: createMessage({
        from: this.address,
        to: lender,
        type: MessageType.ResourceRequest,
        taskId,
        payload: { need, purpose },
        createdAt: now,
      }),
    }
  }

  /** Handle an inbound offer (or a release the lender sent). */
  handle(message: QianmoMessage): BorrowerReply {
    if (message.type === MessageType.ResourceRelease) {
      this.#abandon(message.taskId, 'abandoned')
      return {}
    }
    if (message.type !== MessageType.ResourceOffer) return {}

    const now = this.#now()
    const lease = this.#leases.get(message.taskId)
    if (lease === undefined || lease.state !== 'requested') {
      // We are not waiting for this — either it timed out here, or it answers
      // a task we never opened.
      return { declined: 'no request is open for this task' }
    }
    const payload = message.payload
    if (!isResourceOfferPayload(payload)) {
      this.#abandon(message.taskId, 'failed')
      return { declined: 'offer payload is not well formed' }
    }
    if (now >= payload.offerExpiresAt) {
      this.#abandon(message.taskId, 'expired')
      return { declined: 'the offer had already expired when it arrived' }
    }
    if (!offerIsUsable(payload.granted, this.#policy.minimum)) {
      // Taking a lease we cannot use would spend the lender's capacity to
      // discover something the numbers already say.
      this.#abandon(message.taskId, 'abandoned')
      return {
        declined: 'the offer is below what this task needs to make progress',
        reply: this.#releaseMessage(
          message.from,
          message.taskId,
          payload.offerId,
          'abandoned',
          now,
        ),
      }
    }

    const held: BorrowedLease = {
      taskId: message.taskId,
      lender: message.from,
      offerId: payload.offerId,
      granted: payload.granted,
      ...(payload.capability === undefined
        ? {}
        : { capability: payload.capability }),
      state: 'held',
    }
    this.#leases.set(message.taskId, held)
    this.#timers.get(message.taskId)?.()
    this.#timers.delete(message.taskId)
    this.#audit.record(NegotiationEventType.Leased, now, {
      offerId: payload.offerId,
      taskId: message.taskId,
      lender: message.from,
      side: 'borrower',
    })

    return {
      lease: held,
      reply: createMessage({
        from: this.address,
        to: message.from,
        type: MessageType.ResourceGrant,
        taskId: message.taskId,
        traceId: message.traceId,
        payload: { offerId: payload.offerId, acceptedAt: now },
        createdAt: now,
      }),
    }
  }

  /** Give a lease back. Returns the envelope to send, when there is one. */
  release(
    taskId: string,
    reason: ReleaseReason = 'completed',
  ): QianmoMessage | undefined {
    const lease = this.#leases.get(taskId)
    if (lease?.offerId === undefined) {
      this.#abandon(taskId, reason)
      return undefined
    }
    const now = this.#now()
    const message = this.#releaseMessage(
      lease.lender,
      taskId,
      lease.offerId,
      reason,
      now,
    )
    this.#abandon(taskId, reason)
    return message
  }

  close(): void {
    for (const cancel of this.#timers.values()) cancel()
    this.#timers.clear()
    this.#leases.clear()
  }

  #releaseMessage(
    lender: string,
    taskId: string,
    offerId: string,
    reason: ReleaseReason,
    now: number,
  ): QianmoMessage {
    return createMessage({
      from: this.address,
      to: lender,
      type: MessageType.ResourceRelease,
      taskId,
      payload: { offerId, reason, releasedAt: now },
      createdAt: now,
    })
  }

  #abandon(taskId: string, reason: ReleaseReason): void {
    const lease = this.#leases.get(taskId)
    this.#timers.get(taskId)?.()
    this.#timers.delete(taskId)
    this.#leases.delete(taskId)
    if (lease === undefined) return
    this.#audit.record(
      lease.state === 'held'
        ? NegotiationEventType.Released
        : NegotiationEventType.Abandoned,
      this.#now(),
      {
        taskId,
        lender: lease.lender,
        reason,
        side: 'borrower',
        ...(lease.offerId === undefined ? {} : { offerId: lease.offerId }),
      },
    )
  }
}
