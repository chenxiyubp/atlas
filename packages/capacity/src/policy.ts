// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When this node decides it will need more room, and how loudly it has to be
 * convinced.
 *
 * ## Why none of these belong in `LIMITS`
 *
 * `@qianmo/protocol`'s `LIMITS` is the set of numbers **every node has to agree
 * on** — envelope size, hop count, TTLs — because disagreeing about them
 * corrupts the wire. `@qianmo/negotiation`'s `policy.ts` already argued the
 * general case for keeping a local ceiling out of it: how much *this* machine
 * will lend differs per deployment and is nobody else's business.
 *
 * The case here is a step stronger than negotiation's. Negotiation at least
 * carries `ResourceNeed` **fields** on the wire, so part of it had to live in
 * the protocol. Nothing in this file reaches a wire at all: no message carries
 * a z-score, no peer can read a cooldown, and two nodes running different
 * `zScore` values interoperate perfectly and always will. Promoting these to
 * `LIMITS` would make a local tuning knob into a network-wide constant that
 * needs a charter amendment to turn (protocol.md §12.2 A), in exchange for
 * nothing.
 *
 * ## What the numbers are, and how hard it is to trip them
 *
 * The default is deliberately hard to trip: three consecutive buckets, four
 * robust deviations, **and** half again the slot's median. The DoD's budget is
 * one false positive per seven days of replay, and a detector that fires on any
 * one of those three would spend it before Tuesday.
 */

/** Bumped when a default changes, so an old audit line stays readable. */
export const CAPACITY_POLICY_VERSION = 'qianmo.capacity.policy.v0'

export interface CapacityPolicy {
  /** Bucket width the planner is being fed at. */
  readonly bucketMs: number
  /** How far ahead of `now` the planner looks when arming a calendar window. */
  readonly horizonMs: number
  /** Minimum gap between two triggers of the same kind. */
  readonly cooldownMs: number
  /** Buckets that must deviate in a row before path B fires. */
  readonly consecutiveBuckets: number
  /** Robust deviations above the slot median that count as a deviation. */
  readonly zScore: number
  /** …and the observation must also be this multiple of the slot median. */
  readonly minRatio: number
  /** Same-slot observations required before path B will speak at all. */
  readonly minBaselineSamples: number
  /** Ramp used for calendar windows that did not specify one. */
  readonly defaultRampBeforeMs: number
}

export const DEFAULT_CAPACITY_POLICY: CapacityPolicy = Object.freeze({
  // Fifteen minutes, matching `DEFAULT_BUCKET_MS`.
  bucketMs: 900_000,
  // Three buckets. Long enough that arming is not knife-edge on the grid,
  // short enough that "45 minutes ahead" is not doing the DoD's work for it —
  // the 30-minute lead the DoD asks for comes from the calendar's ramp, and
  // this only decides which bucket notices the ramp opening.
  horizonMs: 45 * 60_000,
  // Six hours. Two scale-ups in one afternoon are one scale-up and one echo,
  // and the echo is what fills an audit trail with noise.
  cooldownMs: 6 * 3_600_000,
  // Three buckets = 45 minutes of sustained deviation. One bucket is a batch
  // job; two is a coincidence; three is a trend somebody should be paid for.
  consecutiveBuckets: 3,
  // Four, not the textbook three: with only a handful of same-slot weeks the
  // MAD is itself noisy, and three lets an unusually tight pair of history
  // points turn an ordinary Tuesday into an alarm.
  zScore: 4,
  // The ratio floor. See `planner.ts` for the failure it exists to stop.
  minRatio: 1.5,
  // Two same-slot observations — at one per week, two weeks of history. Below
  // that the MAD of a single point is zero by definition and the z-test
  // degenerates into "not exactly equal to last week".
  minBaselineSamples: 2,
  // Six hours before the gun, for a calendar entry that did not say. Long
  // enough to be worth the word "predictive", short enough that a node is not
  // holding capacity through the night before.
  defaultRampBeforeMs: 6 * 3_600_000,
})
