// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Usage, as the planner sees it: fixed-width buckets over the audit trail.
 *
 * ## Why a structural subset rather than `import type { AuditRecord }`
 *
 * The three fields read here — `at`, `kind`, `taskId` — arrive from the P7.2
 * trail on disk, from a layer's own in-memory ring, and (in the tests) from a
 * generator that never touched an audit log at all. Typing against
 * `@qianmo/audit`'s record would force all three to pretend to be a trail line,
 * and would put a dependency edge between two packages that have no business
 * knowing about each other. `@qianmo/diagnosis`'s `TaskResultLike` set the
 * precedent for exactly this situation; this is the same move.
 *
 * ## The three numbers, and which one the planner actually watches
 *
 * A bucket carries three counts because three different questions get asked of
 * a usage history later. Only one of them is load in the sense capacity is
 * bought for — see {@link loadOf}.
 */

/** Fifteen minutes. Short enough to see a ramp, long enough to be quiet. */
export const DEFAULT_BUCKET_MS = 900_000

/** One bucket of usage. `at` is the bucket **start**, epoch ms. */
export interface UsageSample {
  /** Bucket start, epoch ms. Always a multiple of the bucket width. */
  readonly at: number
  /** Tasks first seen in this bucket — arrivals, not occupancy. */
  readonly tasks: number
  /** `message_accepted` records in this bucket. */
  readonly messages: number
  /** Peak number of tasks in flight at any instant inside this bucket. */
  readonly concurrentTasks: number
}

/**
 * The scalar the planner watches.
 *
 * Peak concurrency, not arrivals and not message volume: capacity is bought to
 * run things at the same time, and a bucket with 200 one-second tasks needs
 * less of it than a bucket with 12 tasks that all overlap. Arrivals and
 * messages stay on the sample because they are what an operator asks for when
 * reading a history back, but nothing decides on them.
 */
export function loadOf(sample: UsageSample): number {
  return sample.concurrentTasks
}

/** The part of an audit record this fold reads. */
export interface UsageRecordLike {
  /** Epoch ms. */
  readonly at: number
  /** The writing layer's own event name. */
  readonly kind: string
  readonly taskId?: string | undefined
}

/** The transport's name for "a message got through", read verbatim. */
export const MESSAGE_ACCEPTED_KIND = 'message_accepted'

export interface FoldOptions {
  /** Bucket width in ms. Defaults to {@link DEFAULT_BUCKET_MS}. */
  readonly bucketMs?: number
  /** Force the first bucket, so a quiet start is still a run of zeroes. */
  readonly from?: number
  /** Force the last bucket, likewise for a quiet end. */
  readonly to?: number
}

interface Span {
  first: number
  last: number
}

function bucketStart(at: number, bucketMs: number): number {
  return Math.floor(at / bucketMs) * bucketMs
}

/**
 * Fold a stream of audit records into contiguous usage buckets.
 *
 * **Contiguous** is the load-bearing word: an hour with no traffic has to come
 * back as four zeroes rather than as nothing at all. A baseline built from a
 * history with the quiet hours missing thinks the system is always busy, and a
 * "three consecutive buckets" rule over a sparse array counts three buckets
 * that were days apart.
 *
 * Records may arrive in any order; the fold sorts what it needs to.
 */
export function foldTrailToBuckets(
  records: readonly UsageRecordLike[],
  options: FoldOptions = {},
): UsageSample[] {
  const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new RangeError(`bucketMs must be a positive number, got ${bucketMs}`)
  }

  const spans = new Map<string, Span>()
  let earliest = Number.POSITIVE_INFINITY
  let latest = Number.NEGATIVE_INFINITY
  const messagesPerBucket = new Map<number, number>()

  for (const record of records) {
    if (!Number.isFinite(record.at)) continue
    earliest = Math.min(earliest, record.at)
    latest = Math.max(latest, record.at)
    if (record.kind === MESSAGE_ACCEPTED_KIND) {
      const bucket = bucketStart(record.at, bucketMs)
      messagesPerBucket.set(bucket, (messagesPerBucket.get(bucket) ?? 0) + 1)
    }
    const taskId = record.taskId
    if (taskId === undefined || taskId.length === 0) continue
    const span = spans.get(taskId)
    if (span === undefined) {
      spans.set(taskId, { first: record.at, last: record.at })
    } else {
      span.first = Math.min(span.first, record.at)
      span.last = Math.max(span.last, record.at)
    }
  }

  const from =
    options.from ?? (Number.isFinite(earliest) ? earliest : undefined)
  const to = options.to ?? (Number.isFinite(latest) ? latest : undefined)
  if (from === undefined || to === undefined) return []

  const firstBucket = bucketStart(Math.min(from, to), bucketMs)
  const lastBucket = bucketStart(Math.max(from, to), bucketMs)

  const arrivals = new Map<number, number>()
  // A task's life is [first record, last record]; +1 sorts before -1 at the
  // same instant so a task that began and ended inside one bucket is still
  // counted as having been in flight.
  const transitions: { at: number; delta: number }[] = []
  for (const span of spans.values()) {
    const bucket = bucketStart(span.first, bucketMs)
    arrivals.set(bucket, (arrivals.get(bucket) ?? 0) + 1)
    transitions.push({ at: span.first, delta: 1 })
    transitions.push({ at: span.last, delta: -1 })
  }
  transitions.sort((a, b) => a.at - b.at || b.delta - a.delta)

  const samples: UsageSample[] = []
  let active = 0
  let cursor = 0
  for (let at = firstBucket; at <= lastBucket; at += bucketMs) {
    // Carry-in: tasks that were already running when this bucket opened.
    let peak = active
    const end = at + bucketMs
    while (cursor < transitions.length) {
      const transition = transitions[cursor]
      if (transition === undefined || transition.at >= end) break
      active += transition.delta
      if (active > peak) peak = active
      cursor += 1
    }
    samples.push({
      at,
      tasks: arrivals.get(at) ?? 0,
      messages: messagesPerBucket.get(at) ?? 0,
      concurrentTasks: peak,
    })
  }
  return samples
}
