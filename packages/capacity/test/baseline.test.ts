// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turning a history into "normal for this hour of this weekday".
 *
 * Two claims are worth testing here rather than trusting: that the slot key
 * really is stable week over week, and that the median/MAD pair really does
 * survive having the peaks it is meant to detect mixed into its own training
 * data. The second one is the reason `baseline.ts` is not three lines of mean
 * and variance.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BUCKET_MS,
  buildBaseline,
  foldTrailToBuckets,
  mad,
  median,
  slotOfWeek,
  slotsPerWeek,
  type UsageSample,
} from '../src/index.js'

const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0)

function sample(at: number, concurrentTasks: number): UsageSample {
  return { at, tasks: concurrentTasks, messages: 0, concurrentTasks }
}

describe('slot of week', () => {
  test('the same wall-clock position maps to the same slot every week', () => {
    const at = T0 + 3 * DAY + 14 * HOUR + 30 * 60_000
    expect(slotOfWeek(at)).toBe(slotOfWeek(at + WEEK))
    expect(slotOfWeek(at)).toBe(slotOfWeek(at + 52 * WEEK))
  })

  test('neighbouring buckets are neighbouring slots, and the week wraps', () => {
    expect(slotOfWeek(T0 + DEFAULT_BUCKET_MS) - slotOfWeek(T0)).toBe(1)
    expect(slotsPerWeek()).toBe(672)
    const last = slotOfWeek(T0 + WEEK - DEFAULT_BUCKET_MS)
    expect(slotOfWeek(T0 + WEEK - DEFAULT_BUCKET_MS + DEFAULT_BUCKET_MS)).toBe(
      (last + 1) % 672,
    )
  })

  test('instants before the epoch still land in [0, slotsPerWeek)', () => {
    // A negative modulo is the classic way this function returns -1.
    const slot = slotOfWeek(-3 * DAY)
    expect(slot).toBeGreaterThanOrEqual(0)
    expect(slot).toBeLessThan(672)
  })

  test('a non-positive bucket width is refused, not divided by', () => {
    expect(() => slotOfWeek(T0, 0)).toThrow('positive number')
  })
})

describe('median and MAD', () => {
  test('the median of an even count is the mean of the middle two', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([5, 1, 3])).toBe(3)
    expect(median([])).toBe(0)
  })

  test('a constant series has a MAD of exactly zero', () => {
    // The case that breaks a pure z-score. `planner.ts` has the ratio floor
    // precisely for it, and `planner.test.ts` proves the floor holds.
    expect(mad([7, 7, 7, 7])).toBe(0)
  })

  test('one contest week does not drag the baseline with it', () => {
    // This is the whole argument for median/MAD over mean/σ. Three ordinary
    // weeks and one 8× one, in the same slot.
    const values = [20, 21, 19, 160]
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(median(values)).toBe(20.5)
    // The mean has already moved 2.5× as far as the median from "normal".
    expect(mean).toBeGreaterThan(50)
    // …and the MAD stays in the same units as an ordinary week's wobble,
    // whereas a standard deviation over the same numbers is above 60.
    expect(mad(values)).toBeLessThanOrEqual(2)
  })
})

describe('building a baseline', () => {
  test('slots pool across weeks and count the weeks that contributed', () => {
    const samples = [
      sample(T0, 10),
      sample(T0 + WEEK, 12),
      sample(T0 + 2 * WEEK, 11),
      sample(T0 + HOUR, 40),
    ]
    const baseline = buildBaseline(samples)
    const slot = baseline.slots.get(slotOfWeek(T0))
    expect(slot?.samples).toBe(3)
    expect(slot?.median).toBe(11)
    expect(baseline.slots.get(slotOfWeek(T0 + HOUR))?.median).toBe(40)
  })

  test('an empty history teaches nothing and says so', () => {
    expect(buildBaseline([]).slots.size).toBe(0)
  })
})

describe('folding a trail into buckets', () => {
  test('arrivals, messages and peak concurrency are three different counts', () => {
    const records = [
      // Two tasks overlapping for part of the bucket, one of them ending in it.
      { at: T0 + 60_000, kind: 'task.accepted', taskId: 't-1' },
      { at: T0 + 120_000, kind: 'message_accepted', taskId: 't-1' },
      { at: T0 + 180_000, kind: 'task.accepted', taskId: 't-2' },
      { at: T0 + 240_000, kind: 'message_accepted', taskId: 't-2' },
      { at: T0 + 300_000, kind: 'task.done', taskId: 't-1' },
      { at: T0 + 360_000, kind: 'task.done', taskId: 't-2' },
      { at: T0 + 420_000, kind: 'keepalive' },
    ]
    const [bucket] = foldTrailToBuckets(records)
    expect(bucket?.at).toBe(T0)
    expect(bucket?.tasks).toBe(2)
    // Only `message_accepted` counts; the keepalive and the task events do not.
    expect(bucket?.messages).toBe(2)
    expect(bucket?.concurrentTasks).toBe(2)
  })

  test('a task still running when the bucket opens is carried in', () => {
    const records = [
      { at: T0 + 60_000, kind: 'task.accepted', taskId: 't-1' },
      {
        at: T0 + 2 * DEFAULT_BUCKET_MS + 60_000,
        kind: 'task.done',
        taskId: 't-1',
      },
    ]
    const samples = foldTrailToBuckets(records)
    expect(samples).toHaveLength(3)
    // Arrivals only in the first bucket, occupancy in all three.
    expect(samples.map(s => s.tasks)).toEqual([1, 0, 0])
    expect(samples.map(s => s.concurrentTasks)).toEqual([1, 1, 1])
  })

  test('quiet buckets come back as zeroes, not as gaps', () => {
    // A sparse history makes "three consecutive buckets" count three buckets
    // that were hours apart, and teaches a baseline that the node is never idle.
    const samples = foldTrailToBuckets([
      { at: T0, kind: 'message_accepted' },
      { at: T0 + 4 * DEFAULT_BUCKET_MS, kind: 'message_accepted' },
    ])
    expect(samples).toHaveLength(5)
    expect(samples.map(s => s.messages)).toEqual([1, 0, 0, 0, 1])
  })

  test('records may arrive in any order', () => {
    const forwards = foldTrailToBuckets([
      { at: T0, kind: 'message_accepted', taskId: 't-1' },
      { at: T0 + DEFAULT_BUCKET_MS, kind: 'message_accepted', taskId: 't-1' },
    ])
    const backwards = foldTrailToBuckets([
      { at: T0 + DEFAULT_BUCKET_MS, kind: 'message_accepted', taskId: 't-1' },
      { at: T0, kind: 'message_accepted', taskId: 't-1' },
    ])
    expect(backwards).toEqual(forwards)
  })

  test('an empty trail folds to an empty history, not to one zero bucket', () => {
    expect(foldTrailToBuckets([])).toEqual([])
  })
})
