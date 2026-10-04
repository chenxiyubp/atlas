// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Usage histories to replay against — the question, not the answer.
 *
 * ## The rule this file exists under
 *
 * **No parameter here may be derived from, or refer to, anything in
 * `policy.ts`.** A generator that knew the planner's `zScore` or
 * `consecutiveBuckets` could be tuned until the replay passed, and the replay
 * would then be measuring the tuning. The two sets of numbers are written down
 * independently and are allowed to disagree; a false positive is a real result
 * about the detector, not a mismatch to be smoothed over. The bucket width
 * below is therefore its own constant with its own name, even though it holds
 * the same 15 minutes — the duplication is the point.
 *
 * ## Why the PRNG is re-implemented here
 *
 * `demo/lib/p61-dataset.ts` has a nine-line xorshift32 that produces the AC-7
 * dataset. It is not imported and must not be: that dataset is a **frozen
 * contract** — its digests are quoted in an acceptance record — and a shared
 * generator would mean a change made for a capacity test could invalidate an
 * acceptance already signed off. Nine lines is a cheap price for that
 * independence. (It is also the wrong direction: a package importing from
 * `demo/`.)
 *
 * ## The contest profile is a modelling assumption
 *
 * The multipliers in {@link contestFactor} — quiet build-up the night before,
 * three to five times normal through the middle, a submission sprint at the
 * end, exponential decay afterwards — are what the P2.4 scenario document
 * assumes a CUMCM weekend looks like. **No measured history backs them.** They
 * are stated as a shape so a reviewer can disagree with the shape rather than
 * with a number buried in a fixture.
 */

import type { UsageSample } from './usage.js'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** Deliberately this package's own constant — see the header. */
const SYNTHETIC_BUCKET_MS = 900_000
/** Beijing time, which is when the load in question happens. */
const CST_OFFSET_MS = 8 * HOUR_MS
/** Epoch day 0 was a Thursday, so Saturday and Sunday land on 2 and 3. */
const WEEKEND_DAYS: ReadonlySet<number> = new Set([2, 3])

/** Arrivals per unit of concurrency: most tasks are shorter than a bucket. */
const ARRIVALS_PER_CONCURRENT = 1.5
/** Messages per task — a request, a reply, and the chatter in between. */
const MESSAGES_PER_TASK = 8

/** The four shapes a history can be given. */
export type SyntheticShape =
  /** Nothing on top of the daily and weekly rhythm. Named so a spec can say so. */
  | { readonly kind: 'flat' }
  /** Linear growth from 1× at `from` to `multiplier` at `to`, held after. */
  | {
      readonly kind: 'ramp'
      readonly from: number
      readonly to: number
      readonly multiplier: number
    }
  /** A rectangle: `multiplier` for `durationMs` from `at`, nothing either side. */
  | {
      readonly kind: 'spike'
      readonly at: number
      readonly durationMs: number
      readonly multiplier: number
    }
  /** The CUMCM profile. See {@link contestFactor}. */
  | {
      readonly kind: 'contest'
      readonly startAt: number
      readonly endAt: number
    }

export interface SyntheticSpec {
  /** Any integer. The same seed gives the same series, forever. */
  readonly seed: number
  /** Epoch ms; rounded down to a bucket boundary. */
  readonly startAt: number
  readonly days: number
  readonly bucketMs?: number
  /** Concurrent tasks at an average hour of an average day. */
  readonly base: number
  /** Peak-to-mean fraction of the daily rhythm, e.g. 0.25 for ±25 %. */
  readonly diurnal: number
  /** Fraction the weekend sits below the working week. */
  readonly weekly: number
  /** Half-width of the uniform multiplicative noise, e.g. 0.1 for ±10 %. */
  readonly noise: number
  readonly shapes?: readonly SyntheticShape[]
}

/**
 * xorshift32. Nine lines, and not the nine lines in `demo/lib/p61-dataset.ts` —
 * see the header for why that separation is deliberate.
 */
function makeRandom(seed: number): () => number {
  let state = seed === 0 ? 1 : seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

/** Hour of the day in Beijing time, as a fraction. */
function hourOfDay(at: number): number {
  const intoDay = (((at + CST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS
  return intoDay / HOUR_MS
}

function dayIndex(at: number): number {
  const days = Math.floor((at + CST_OFFSET_MS) / DAY_MS)
  return ((days % 7) + 7) % 7
}

/** Peaks mid-afternoon, troughs before dawn. One sine; nobody needs two. */
function diurnalFactor(at: number, amplitude: number): number {
  return 1 + amplitude * Math.sin((2 * Math.PI * (hourOfDay(at) - 9)) / 24)
}

function weeklyFactor(at: number, dip: number): number {
  return WEEKEND_DAYS.has(dayIndex(at)) ? 1 - dip : 1
}

/** The night before the contest, in multiples of an ordinary evening. */
const CONTEST_PRE_MS = 12 * HOUR_MS
const CONTEST_PRE_FROM = 1.2
const CONTEST_PRE_TO = 1.5
/** The middle of the contest. */
const CONTEST_BODY_FROM = 3
const CONTEST_BODY_TO = 5
/** The last hours, when everybody is assembling a paper at once. */
const CONTEST_SPRINT_MS = 6 * HOUR_MS
const CONTEST_SPRINT_FROM = 5
const CONTEST_SPRINT_TO = 8
/** After the deadline: half of what is left every three hours. */
const CONTEST_DECAY_HALF_LIFE_MS = 3 * HOUR_MS

function lerp(from: number, to: number, fraction: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, fraction))
}

/**
 * The contest multiplier at `at`, for a window `[startAt, endAt)`.
 *
 * Four phases, all of them assumptions (see the header): a build-up over the
 * twelve hours before the start, three-to-five times normal through the body,
 * a five-to-eight sprint over the final six hours, and an exponential decay
 * back to ordinary afterwards. The load never drops below 1× — the cluster does
 * not get quieter than usual because a contest happened.
 */
export function contestFactor(
  at: number,
  startAt: number,
  endAt: number,
): number {
  if (at < startAt - CONTEST_PRE_MS) return 1
  if (at < startAt) {
    return lerp(
      CONTEST_PRE_FROM,
      CONTEST_PRE_TO,
      (at - (startAt - CONTEST_PRE_MS)) / CONTEST_PRE_MS,
    )
  }
  if (at >= endAt) {
    const decayed =
      CONTEST_SPRINT_TO * 0.5 ** ((at - endAt) / CONTEST_DECAY_HALF_LIFE_MS)
    return Math.max(1, decayed)
  }
  const sprintFrom = Math.max(startAt, endAt - CONTEST_SPRINT_MS)
  if (at >= sprintFrom) {
    return lerp(
      CONTEST_SPRINT_FROM,
      CONTEST_SPRINT_TO,
      (at - sprintFrom) / Math.max(1, endAt - sprintFrom),
    )
  }
  return lerp(
    CONTEST_BODY_FROM,
    CONTEST_BODY_TO,
    (at - startAt) / Math.max(1, sprintFrom - startAt),
  )
}

function shapeFactor(shape: SyntheticShape, at: number): number {
  switch (shape.kind) {
    case 'flat':
      return 1
    case 'ramp':
      if (at < shape.from) return 1
      return lerp(
        1,
        shape.multiplier,
        (at - shape.from) / Math.max(1, shape.to - shape.from),
      )
    case 'spike':
      return at >= shape.at && at < shape.at + shape.durationMs
        ? shape.multiplier
        : 1
    case 'contest':
      return contestFactor(at, shape.startAt, shape.endAt)
  }
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number, got ${value}`)
  }
}

/**
 * Build a usage history.
 *
 * Shapes multiply: a contest on a Saturday is still quieter than a contest on a
 * Wednesday, which is the honest composition and also the one that makes the
 * slot-of-week baseline earn its place.
 */
export function makeSeries(spec: SyntheticSpec): UsageSample[] {
  if (!Number.isInteger(spec.seed)) {
    throw new RangeError(`seed must be an integer, got ${spec.seed}`)
  }
  positive(spec.days, 'days')
  positive(spec.base, 'base')
  const bucketMs = spec.bucketMs ?? SYNTHETIC_BUCKET_MS
  positive(bucketMs, 'bucketMs')
  for (const name of ['diurnal', 'weekly', 'noise'] as const) {
    const value = spec[name]
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${name} must be within [0, 1], got ${value}`)
    }
  }

  const random = makeRandom(spec.seed)
  const start = Math.floor(spec.startAt / bucketMs) * bucketMs
  const buckets = Math.round((spec.days * DAY_MS) / bucketMs)
  const shapes = spec.shapes ?? []

  const samples: UsageSample[] = []
  for (let index = 0; index < buckets; index += 1) {
    const at = start + index * bucketMs
    let load =
      spec.base *
      diurnalFactor(at, spec.diurnal) *
      weeklyFactor(at, spec.weekly)
    for (const shape of shapes) load *= shapeFactor(shape, at)
    // One draw per bucket, always, so a spec's shape list cannot change the
    // noise a seed produces at an unrelated hour.
    load *= 1 + spec.noise * (2 * random() - 1)

    const concurrentTasks = Math.max(0, Math.round(load))
    const tasks = Math.max(0, Math.round(load * ARRIVALS_PER_CONCURRENT))
    samples.push({
      at,
      tasks,
      messages: tasks * MESSAGES_PER_TASK,
      concurrentTasks,
    })
  }
  return samples
}
