// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Normal for this hour of this weekday" — the slot-of-week baseline.
 *
 * ## Why slot-of-week and not a rolling window
 *
 * Load on a coursework cluster is not stationary. Tuesday 15:00 and Sunday
 * 04:00 differ by an order of magnitude, and a rolling mean over the last N
 * buckets spends every morning catching up and every evening lagging behind. A
 * baseline keyed on *position in the week* has the diurnal and weekly shape
 * built into the key, so what is left over is the thing worth alarming on.
 *
 * The cost is that each slot only gains one observation per week: three weeks
 * of history is three numbers per slot, not three hundred. That is why
 * `minBaselineSamples` exists and why path B abstains out loud instead of
 * guessing — see `policy.ts`.
 *
 * ## Why median and MAD, and not mean and standard deviation
 *
 * The history this baseline learns from **contains the peaks it is meant to
 * detect**. Last September's contest is in the same slots as this September's,
 * and every sample of it gets folded in.
 *
 * A mean moves with every outlier and a standard deviation moves with the
 * *square* of it: one 8× contest week in a three-week history drags the mean up
 * by ~2.3× and inflates σ enough that the next contest looks unremarkable —
 * the detector trains itself to ignore exactly the event it exists for. The
 * median ignores an outlier's magnitude entirely (it can move by at most one
 * rank), and the MAD is the median of the deviations, so it inherits the same
 * indifference. With ≤ 50 % of samples contaminated both stay put.
 *
 * The 1.4826 that appears with the MAD in `planner.ts` is the constant that
 * makes it a consistent estimator of σ for normally distributed data, so a
 * "z-score" built on it means roughly what a reader expects it to mean.
 */

import { DEFAULT_BUCKET_MS, loadOf, type UsageSample } from './usage.js'

const WEEK_MS = 7 * 24 * 3_600_000

/**
 * Which slot of the week an instant falls in.
 *
 * The week is anchored at the Unix epoch (Thursday 1970-01-01T00:00Z) rather
 * than at a locale's idea of Monday. Nothing here needs the slot to *mean*
 * Tuesday — it only needs the same wall-clock position to map to the same
 * number every week, which an epoch anchor does without dragging in a timezone
 * database.
 */
export function slotOfWeek(
  at: number,
  bucketMs: number = DEFAULT_BUCKET_MS,
): number {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new RangeError(`bucketMs must be a positive number, got ${bucketMs}`)
  }
  const intoWeek = ((at % WEEK_MS) + WEEK_MS) % WEEK_MS
  return Math.floor(intoWeek / bucketMs)
}

/** How many slots a week is divided into at this bucket width. */
export function slotsPerWeek(bucketMs: number = DEFAULT_BUCKET_MS): number {
  return Math.floor(WEEK_MS / bucketMs)
}

/** The middle value; the mean of the middle two when there is an even count. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/**
 * Median absolute deviation, around the median unless a centre is given.
 *
 * Returns 0 for a constant series, which is correct and is also the case that
 * breaks a pure z-score — the ratio floor in `policy.ts` exists for it.
 */
export function mad(values: readonly number[], center?: number): number {
  if (values.length === 0) return 0
  const middle = center ?? median(values)
  return median(values.map(value => Math.abs(value - middle)))
}

/** What the baseline knows about one slot of the week. */
export interface BaselineSlot {
  readonly slot: number
  /** How many weeks contributed. */
  readonly samples: number
  readonly median: number
  readonly mad: number
}

/** A whole week of slots, as learned from a history. */
export interface Baseline {
  readonly bucketMs: number
  readonly slots: ReadonlyMap<number, BaselineSlot>
}

/**
 * Build a baseline over a whole history at once.
 *
 * The planner keeps the same statistic incrementally as samples arrive (it has
 * to: a decision may only see history that is strictly older than the sample
 * being judged). This is the batch view of the same thing — for inspecting what
 * a history taught, and for tests that want to check the planner against it.
 */
export function buildBaseline(
  samples: readonly UsageSample[],
  options: { readonly bucketMs?: number } = {},
): Baseline {
  const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS
  const grouped = new Map<number, number[]>()
  for (const sample of samples) {
    const slot = slotOfWeek(sample.at, bucketMs)
    const values = grouped.get(slot)
    if (values === undefined) grouped.set(slot, [loadOf(sample)])
    else values.push(loadOf(sample))
  }
  const slots = new Map<number, BaselineSlot>()
  for (const [slot, values] of grouped) {
    const middle = median(values)
    slots.set(slot, {
      slot,
      samples: values.length,
      median: middle,
      mad: mad(values, middle),
    })
  }
  return { bucketMs, slots }
}
