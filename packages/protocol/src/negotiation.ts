// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resource negotiation: the four messages that lend one node's capacity to
 * another (P5.2, protocol.md §13).
 *
 * ```
 *   borrower                                   lender
 *      │  resource.request  ────────────────▶    │   "I need this much, for this"
 *      │  ◀────────────────  resource.offer      │   "you may have this much, until T"
 *      │  resource.grant    ────────────────▶    │   "I take offer X"
 *      │  ◀───────────────  resource.release     │   (either side, any time)
 * ```
 *
 * ## Four messages, and why not five
 *
 * The obvious fifth is an explicit acknowledgement of the grant. It is absent
 * on purpose: the lease's proof is the **capability token the offer carries**,
 * and the borrower demonstrates possession by using it. A message whose only
 * job is to say "yes, really" adds a state to every timeout table for no fact
 * anyone can act on.
 *
 * ## Where the user's confirmation lives
 *
 * Lending a machine's CPU is the lender's user's decision, so it is made **at
 * the lender, locally**, before an offer goes out. It is deliberately not a
 * field on any of these messages: a borrower asserting "my user approved this"
 * is precisely the confused-deputy shape charter C-5 forbids, and rule S-1
 * already refuses a remote `user-confirmed` token. What crosses the wire is the
 * lender's own token, which the lender will accept back because it signed it.
 *
 * ## The ceilings are not protocol constants
 *
 * `LIMITS` holds the numbers every node on the network must agree on. How much
 * memory a particular machine is willing to lend is not one of them — it is
 * that machine's policy, it differs per deployment, and putting it in `LIMITS`
 * would turn a local decision into a network-wide one that needs a charter
 * amendment to change. The ceilings live with the code that enforces them, in
 * `@qianmo/negotiation`.
 */

/** What is being asked for, offered, or held. Three axes, no more. */
export interface ResourceNeed {
  /** How long the borrower wants it, in ms. */
  readonly durationMs: number
  /** Whole or fractional cores. */
  readonly cpuCores: number
  readonly memoryMb: number
}

const NEED_KEYS: readonly string[] = ['durationMs', 'cpuCores', 'memoryMb']

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every(key => keys.includes(key))
  )
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/** True when `value` is a well-formed, field-closed {@link ResourceNeed}. */
export function isResourceNeed(value: unknown): value is ResourceNeed {
  const need = asObject(value)
  if (need === null || !hasExactKeys(need, NEED_KEYS)) return false
  return NEED_KEYS.every(key => isPositiveFinite(need[key]))
}

/** True when every axis of `need` is within `ceiling`. */
export function needWithin(need: ResourceNeed, ceiling: ResourceNeed): boolean {
  return (
    need.durationMs <= ceiling.durationMs &&
    need.cpuCores <= ceiling.cpuCores &&
    need.memoryMb <= ceiling.memoryMb
  )
}

/** Per-axis minimum, i.e. the most a lender can offer without exceeding either. */
export function clampNeed(
  need: ResourceNeed,
  ceiling: ResourceNeed,
): ResourceNeed {
  return {
    durationMs: Math.min(need.durationMs, ceiling.durationMs),
    cpuCores: Math.min(need.cpuCores, ceiling.cpuCores),
    memoryMb: Math.min(need.memoryMb, ceiling.memoryMb),
  }
}

/** `resource.request` — what the borrower wants and what for. */
export interface ResourceRequestPayload {
  readonly need: ResourceNeed
  /** One line an operator can read on the lender's audit trail. */
  readonly purpose: string
}

const REQUEST_KEYS: readonly string[] = ['need', 'purpose']

export function isResourceRequestPayload(
  value: unknown,
): value is ResourceRequestPayload {
  const payload = asObject(value)
  if (payload === null || !hasExactKeys(payload, REQUEST_KEYS)) return false
  return (
    isResourceNeed(payload['need']) &&
    typeof payload['purpose'] === 'string' &&
    payload['purpose'].length > 0 &&
    payload['purpose'].length <= 256
  )
}

/** `resource.offer` — the terms, and how long they stand. */
export interface ResourceOfferPayload {
  /** The lender's identifier for this offer; the grant names it. */
  readonly offerId: string
  /** What the lender will actually lend — never more than was asked. */
  readonly granted: ResourceNeed
  /** Epoch ms after which the offer is void and the reservation is dropped. */
  readonly offerExpiresAt: number
  /**
   * The lender's own capability token, to be presented back when the resource
   * is used. Absent when the lender's policy needs no token.
   */
  readonly capability?: string
}

const OFFER_KEYS: readonly string[] = [
  'offerId',
  'granted',
  'offerExpiresAt',
  'capability',
]
const OFFER_KEYS_WITHOUT_CAP: readonly string[] = [
  'offerId',
  'granted',
  'offerExpiresAt',
]

export function isResourceOfferPayload(
  value: unknown,
): value is ResourceOfferPayload {
  const payload = asObject(value)
  if (payload === null) return false
  if (
    !hasExactKeys(payload, OFFER_KEYS) &&
    !hasExactKeys(payload, OFFER_KEYS_WITHOUT_CAP)
  ) {
    return false
  }
  if ('capability' in payload) {
    const capability = payload['capability']
    if (typeof capability !== 'string' || capability.length === 0) return false
  }
  return (
    typeof payload['offerId'] === 'string' &&
    payload['offerId'].length > 0 &&
    isResourceNeed(payload['granted']) &&
    isPositiveFinite(payload['offerExpiresAt'])
  )
}

/** `resource.grant` — the borrower takes an offer. */
export interface ResourceGrantPayload {
  readonly offerId: string
  readonly acceptedAt: number
}

const GRANT_KEYS: readonly string[] = ['offerId', 'acceptedAt']

export function isResourceGrantPayload(
  value: unknown,
): value is ResourceGrantPayload {
  const payload = asObject(value)
  if (payload === null || !hasExactKeys(payload, GRANT_KEYS)) return false
  return (
    typeof payload['offerId'] === 'string' &&
    payload['offerId'].length > 0 &&
    isPositiveFinite(payload['acceptedAt'])
  )
}

/** Why a lease ended. Closed set: an unexplained release is not one. */
export type ReleaseReason =
  /** The borrower finished with it. */
  | 'completed'
  /** The lease ran out of time. */
  | 'expired'
  /** The borrower walked away before using it, or the lender withdrew. */
  | 'abandoned'
  /** Something went wrong at either end. */
  | 'failed'

export const RELEASE_REASONS: readonly ReleaseReason[] = Object.freeze([
  'completed',
  'expired',
  'abandoned',
  'failed',
])

/** `resource.release` — either side ends the lease. */
export interface ResourceReleasePayload {
  readonly offerId: string
  readonly reason: ReleaseReason
  readonly releasedAt: number
}

const RELEASE_KEYS: readonly string[] = ['offerId', 'reason', 'releasedAt']

export function isResourceReleasePayload(
  value: unknown,
): value is ResourceReleasePayload {
  const payload = asObject(value)
  if (payload === null || !hasExactKeys(payload, RELEASE_KEYS)) return false
  return (
    typeof payload['offerId'] === 'string' &&
    payload['offerId'].length > 0 &&
    typeof payload['reason'] === 'string' &&
    (RELEASE_REASONS as readonly string[]).includes(payload['reason']) &&
    isPositiveFinite(payload['releasedAt'])
  )
}
