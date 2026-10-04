// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The lending side of a negotiation.
 *
 * Four states and no fifth: **idle → offered → leased → released**. Every one
 * of them has an exit that does not depend on the peer ever speaking again,
 * which is the property roadmap P5.2's DoD asks for in the words "报价阶段超时
 * 后自动放弃且不留悬挂状态":
 *
 * - `offered` expires on its own timer and the reservation goes back;
 * - `leased` expires when the lease's own duration runs out;
 * - both can be ended early by a `resource.release` from either side.
 *
 * A peer that vanishes mid-negotiation therefore costs this node one timer, not
 * a permanent reservation. That is the whole reason the offer carries an
 * expiry: a reservation nobody can reclaim is indistinguishable from a leak.
 *
 * ## What the lender never does
 *
 * It never trusts the borrower's account of authorization. Charter C-5's rule
 * is that a message cannot authorize on the user's behalf, so if this node's
 * policy requires a human to agree before lending, that agreement is obtained
 * **here, locally**, before an offer is sent — there is no field on any of the
 * four messages a borrower could set to claim it happened.
 */

import {
  MessageType,
  ProtocolErrorCode,
  clampNeed,
  createMessage,
  errorReply,
  isResourceGrantPayload,
  isResourceReleasePayload,
  isResourceRequestPayload,
  needWithin,
  newId,
  type QianmoMessage,
  type ReleaseReason,
  type ResourceNeed,
  type ResourceOfferPayload,
} from '@qianmo/protocol'
import { NegotiationEventType, type NegotiationAuditLog } from './audit.js'
import { DEFAULT_LENDER_POLICY, type LenderPolicy } from './policy.js'
import type { CancelTimer, Scheduler } from './schedule.js'
import { timerScheduler } from './schedule.js'

/** A reservation the lender is holding. */
export interface Reservation {
  readonly offerId: string
  readonly taskId: string
  readonly borrower: string
  readonly granted: ResourceNeed
  readonly offerExpiresAt: number
  /** Set once the borrower has taken the offer. */
  readonly leaseExpiresAt?: number
  readonly state: 'offered' | 'leased'
}

export interface LenderOptions {
  /** This node's lending address, used as `from` on everything it sends. */
  readonly address: string
  readonly policy?: LenderPolicy
  readonly audit: NegotiationAuditLog
  readonly now?: () => number
  readonly scheduler?: Scheduler
  readonly newOfferId?: () => string
  /**
   * Local authorization hook: the lender's own answer to "may this node lend
   * that much to that peer". Runs **before** an offer is sent, and its answer
   * comes from this side of the wire only (charter C-5).
   */
  readonly authorize?: (request: {
    readonly borrower: string
    readonly need: ResourceNeed
    readonly purpose: string
  }) => boolean
  /**
   * Capability token to attach to an offer, minted by this node for the
   * borrower to present back. Optional: a deployment with no capability wiring
   * still negotiates, it just has nothing to hand over.
   */
  readonly mintCapability?: (offer: {
    readonly borrower: string
    readonly taskId: string
    readonly granted: ResourceNeed
    readonly expiresAt: number
  }) => string | undefined
}

/** What handling one inbound negotiation message produced. */
export interface LenderReply {
  /** The envelope to send back, if any. */
  readonly reply?: QianmoMessage
  readonly reservation?: Reservation
}

export class LenderNegotiator {
  readonly address: string
  readonly policy: LenderPolicy
  readonly #audit: NegotiationAuditLog
  readonly #now: () => number
  readonly #scheduler: Scheduler
  readonly #newOfferId: () => string
  readonly #options: LenderOptions
  readonly #reservations = new Map<string, Reservation>()
  readonly #timers = new Map<string, CancelTimer>()

  constructor(options: LenderOptions) {
    this.address = options.address
    this.policy = options.policy ?? DEFAULT_LENDER_POLICY
    this.#audit = options.audit
    this.#now = options.now ?? Date.now
    this.#scheduler = options.scheduler ?? timerScheduler
    this.#newOfferId = options.newOfferId ?? newId
    this.#options = options
  }

  /** Reservations currently held, offered or leased. */
  get pending(): number {
    return this.#reservations.size
  }

  reservation(offerId: string): Reservation | undefined {
    return this.#reservations.get(offerId)
  }

  /** Route one inbound negotiation message to the right handler. */
  handle(message: QianmoMessage): LenderReply {
    switch (message.type) {
      case MessageType.ResourceRequest:
        return this.#onRequest(message)
      case MessageType.ResourceGrant:
        return this.#onGrant(message)
      case MessageType.ResourceRelease:
        return this.#onRelease(message)
      default:
        return {}
    }
  }

  #onRequest(message: QianmoMessage): LenderReply {
    const now = this.#now()
    const payload = message.payload
    if (!isResourceRequestPayload(payload)) {
      return this.#refuse(message, 'request payload is not well formed', now)
    }
    if (message.costLimit !== 0) {
      // Belt and braces: `validateMessage` already refuses a non-zero ceiling
      // on the way in (charter N-1), and a negotiation is exactly where a
      // spend would try to enter the system.
      return this.#refuse(message, 'M0 lends nothing that costs money', now)
    }
    if (
      this.#reservations.size >= (this.policy.maxConcurrentLeases ?? Infinity)
    ) {
      return this.#refuse(message, 'this node is already fully committed', now)
    }

    const withinCeiling = needWithin(payload.need, this.policy.ceiling)
    if (!withinCeiling && this.policy.clampToCeiling === false) {
      return this.#refuse(
        message,
        'the request is over this node’s ceiling and it does not counter-offer',
        now,
      )
    }
    // Never more than was asked for, never more than the ceiling.
    const granted = clampNeed(payload.need, this.policy.ceiling)

    const authorized =
      this.#options.authorize?.({
        borrower: message.from,
        need: granted,
        purpose: payload.purpose,
      }) ?? true
    if (!authorized) {
      // The local answer to "may we lend this". A borrower cannot influence it:
      // there is no field on the wire that reaches this hook.
      return this.#refuse(message, 'the operator did not authorize this', now)
    }

    const offerId = this.#newOfferId()
    const offerExpiresAt = now + this.policy.offerTtlMs
    const capability = this.#options.mintCapability?.({
      borrower: message.from,
      taskId: message.taskId,
      granted,
      expiresAt: offerExpiresAt + granted.durationMs,
    })
    const reservation: Reservation = {
      offerId,
      taskId: message.taskId,
      borrower: message.from,
      granted,
      offerExpiresAt,
      state: 'offered',
    }
    this.#reservations.set(offerId, reservation)
    this.#arm(offerId, this.policy.offerTtlMs, () => {
      this.#drop(offerId, 'expired', now)
    })
    this.#audit.record(NegotiationEventType.Offered, now, {
      offerId,
      taskId: message.taskId,
      borrower: message.from,
      durationMs: granted.durationMs,
      cpuCores: granted.cpuCores,
      memoryMb: granted.memoryMb,
      clamped: !withinCeiling,
    })

    const offer: ResourceOfferPayload = {
      offerId,
      granted,
      offerExpiresAt,
      ...(capability === undefined ? {} : { capability }),
    }
    return {
      reservation,
      reply: createMessage({
        from: this.address,
        to: message.from,
        type: MessageType.ResourceOffer,
        taskId: message.taskId,
        traceId: message.traceId,
        payload: offer,
        createdAt: now,
      }),
    }
  }

  #onGrant(message: QianmoMessage): LenderReply {
    const now = this.#now()
    const payload = message.payload
    if (!isResourceGrantPayload(payload)) {
      return this.#refuse(message, 'grant payload is not well formed', now)
    }
    const reservation = this.#reservations.get(payload.offerId)
    if (reservation === undefined) {
      // Either it never existed or its timer already fired. The two are the
      // same answer from here, and saying which would tell a stranger whether
      // an id was ever real.
      return this.#refuse(message, 'no such offer is on the table', now)
    }
    if (reservation.borrower !== message.from) {
      return this.#refuse(message, 'that offer belongs to another peer', now)
    }
    if (reservation.state === 'leased') {
      return this.#refuse(message, 'that offer has already been taken', now)
    }
    if (now >= reservation.offerExpiresAt) {
      this.#drop(payload.offerId, 'expired', now)
      return this.#refuse(message, 'the offer expired before it was taken', now)
    }

    const leased: Reservation = {
      ...reservation,
      state: 'leased',
      leaseExpiresAt: now + reservation.granted.durationMs,
    }
    this.#reservations.set(payload.offerId, leased)
    this.#arm(payload.offerId, reservation.granted.durationMs, () => {
      this.#drop(payload.offerId, 'expired', this.#now())
    })
    this.#audit.record(NegotiationEventType.Leased, now, {
      offerId: payload.offerId,
      taskId: message.taskId,
      borrower: message.from,
      leaseExpiresAt: leased.leaseExpiresAt ?? 0,
    })
    return { reservation: leased }
  }

  #onRelease(message: QianmoMessage): LenderReply {
    const now = this.#now()
    const payload = message.payload
    if (!isResourceReleasePayload(payload)) {
      return this.#refuse(message, 'release payload is not well formed', now)
    }
    const reservation = this.#reservations.get(payload.offerId)
    if (reservation === undefined) {
      // Releasing something that is already gone is not an error: a release
      // that crossed with an expiry is the normal shape of the race.
      return {}
    }
    if (reservation.borrower !== message.from) {
      return this.#refuse(message, 'that lease belongs to another peer', now)
    }
    this.#drop(payload.offerId, payload.reason, now)
    return {}
  }

  /** Give back a reservation from this side — an operator withdrawing it. */
  withdraw(offerId: string, reason: ReleaseReason = 'abandoned'): void {
    this.#drop(offerId, reason, this.#now())
  }

  /** Drop every timer. Nothing here should outlive the process that made it. */
  close(): void {
    for (const cancel of this.#timers.values()) cancel()
    this.#timers.clear()
    this.#reservations.clear()
  }

  #arm(offerId: string, delayMs: number, fire: () => void): void {
    this.#timers.get(offerId)?.()
    this.#timers.set(offerId, this.#scheduler.after(delayMs, fire))
  }

  #drop(offerId: string, reason: ReleaseReason, at: number): void {
    const reservation = this.#reservations.get(offerId)
    this.#timers.get(offerId)?.()
    this.#timers.delete(offerId)
    this.#reservations.delete(offerId)
    if (reservation === undefined) return
    this.#audit.record(NegotiationEventType.Released, at, {
      offerId,
      taskId: reservation.taskId,
      borrower: reservation.borrower,
      reason,
      state: reservation.state,
    })
  }

  #refuse(message: QianmoMessage, reason: string, at: number): LenderReply {
    this.#audit.record(NegotiationEventType.Refused, at, {
      taskId: message.taskId,
      borrower: message.from,
      type: message.type,
      reason,
    })
    return {
      reply: errorReply(
        message,
        ProtocolErrorCode.E_RESOURCE_REFUSED,
        reason,
        at,
      ),
    }
  }
}
