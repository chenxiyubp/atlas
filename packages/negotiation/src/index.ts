// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/negotiation` — lending capacity between nodes (P5.2, protocol.md §13).
 *
 * Four messages (`resource.request` → `offer` → `grant` → `release`, defined in
 * `@qianmo/protocol`) and two state machines that speak them. Everything here
 * follows from three decisions:
 *
 * 1. **No state outlives a silent peer.** Every reservation, on both sides, has
 *    a timer that ends it without the other end ever speaking again. The DoD's
 *    "报价阶段超时后自动放弃且不留悬挂状态" is not a feature bolted on at the
 *    end — it is why the offer carries an expiry at all.
 * 2. **The ceiling is local and unreachable from the wire.** How much this node
 *    lends is `LenderPolicy`, not a protocol constant, and no field a borrower
 *    can set feeds into it. The most a request can do is get a smaller offer.
 * 3. **Authorization to lend is obtained locally.** Charter C-5: a message
 *    cannot authorize on the user's behalf, so the "may we lend this" hook runs
 *    on the lender before an offer goes out and reads nothing from the request
 *    but the numbers.
 *
 * The tunnel that carries the borrowed work is P5.3's; this package stops at
 * "there is a lease, and here is the token that proves it".
 */

export {
  NegotiationAuditLog,
  NegotiationEventType,
  type NegotiationAuditSink,
  type NegotiationEvent,
} from './audit.js'

export {
  BorrowerNegotiator,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type BorrowedLease,
  type BorrowerOptions,
  type BorrowerReply,
} from './borrower.js'

export {
  LenderNegotiator,
  type LenderOptions,
  type LenderReply,
  type Reservation,
} from './lender.js'

export {
  DEFAULT_LENDER_POLICY,
  offerIsUsable,
  type BorrowerPolicy,
  type LenderPolicy,
} from './policy.js'

export {
  timerScheduler,
  type CancelTimer,
  type Scheduler,
} from './schedule.js'
