// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a lender is willing to lend, and for how long an offer stands.
 *
 * ## Why these numbers are not in `LIMITS`
 *
 * `LIMITS` is the set of numbers every node on the network has to agree on —
 * envelope size, hop count, the deadlines. How much memory *this* machine will
 * lend is not one of them: it differs per deployment, it is nobody else's
 * business, and putting it in `LIMITS` would make a local decision into a
 * network-wide constant that needs a charter amendment to change (protocol.md
 * §12.2 A sets that bar for good reasons). So the ceiling lives with the code
 * that enforces it, and the *fields* — which are the protocol's business — live
 * in `@qianmo/protocol`.
 *
 * ## The ceiling is a refusal, not a clamp — except when it is both
 *
 * A request over the ceiling is refused outright when `clampToCeiling` is off,
 * and answered with a smaller offer when it is on. Both are honest; the default
 * is to offer less, because a borrower that asked for eight cores and can use
 * two is better served by two than by a rejection. What never happens is an
 * offer larger than the request: lending more than was asked for is not
 * generosity, it is a resource leak with a friendly face.
 */

import type { ResourceNeed } from '@qianmo/protocol'

export interface LenderPolicy {
  /** The most this node will lend on any single lease. */
  readonly ceiling: ResourceNeed
  /** How long an offer stands before the reservation is dropped. */
  readonly offerTtlMs: number
  /**
   * Offer the ceiling when the request exceeds it, rather than refusing.
   * Defaults to true.
   */
  readonly clampToCeiling?: boolean
  /** Leases held at once. Over this, requests are refused rather than queued. */
  readonly maxConcurrentLeases?: number
}

/**
 * A deliberately small default, and small on purpose: a node that lends more
 * than it can spare has not helped anybody. Deployments override it.
 */
export const DEFAULT_LENDER_POLICY: LenderPolicy = Object.freeze({
  ceiling: Object.freeze({
    durationMs: 15 * 60_000,
    cpuCores: 2,
    memoryMb: 2_048,
  }),
  offerTtlMs: 60_000,
  clampToCeiling: true,
  maxConcurrentLeases: 4,
})

/** What a borrower will accept, so it does not take an offer it cannot use. */
export interface BorrowerPolicy {
  /** Below any of these, the offer is not worth taking. */
  readonly minimum: ResourceNeed
}

/** True when `offer` clears every axis of `minimum`. */
export function offerIsUsable(
  offer: ResourceNeed,
  minimum: ResourceNeed,
): boolean {
  return (
    offer.durationMs >= minimum.durationMs &&
    offer.cpuCores >= minimum.cpuCores &&
    offer.memoryMb >= minimum.memoryMb
  )
}
