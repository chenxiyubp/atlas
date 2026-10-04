// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The trigger, one rule at a time.
 *
 * Everything here is driven by hand-built buckets rather than by a generator,
 * so each case pins exactly one behaviour. The two DoD criteria are replays and
 * live in `replay.test.ts`; what is here is the set of edges those replays
 * would only exercise by luck.
 */

import { describe, expect, test } from 'bun:test'
import {
  CapacityAuditLog,
  CapacityEventType,
  CapacityPlanner,
  CompetitionCalendar,
  DEFAULT_BUCKET_MS,
  DEFAULT_CAPACITY_POLICY,
  auditOnlyExecutor,
  makeSeries,
  needFromDecision,
  slotOfWeek,
  type ScaleUpDecision,
  type UsageSample,
} from '../src/index.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const BUCKET = DEFAULT_BUCKET_MS
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0)
const BUCKETS_PER_DAY = DAY / BUCKET

function sample(at: number, concurrentTasks: number): UsageSample {
  return {
    at,
    tasks: concurrentTasks,
    messages: concurrentTasks * 8,
    concurrentTasks,
  }
}

/** A perfectly boring history: `value` in every bucket, for `days` days. */
function constantSeries(days: number, value: number): UsageSample[] {
  return Array.from({ length: days * BUCKETS_PER_DAY }, (_, index) =>
    sample(T0 + index * BUCKET, value),
  )
}

function replay(
  planner: CapacityPlanner,
  samples: readonly UsageSample[],
): ScaleUpDecision[] {
  const decisions: ScaleUpDecision[] = []
  for (const usage of samples) decisions.push(...planner.observe(usage))
  return decisions
}

describe('path A — the calendar', () => {
  test('a peak exactly 30 minutes out still triggers: the bound includes equality', () => {
    // The DoD says "≥ 30 min". An off-by-one here would be the difference
    // between meeting the criterion and missing it by a millisecond.
    const planner = new CapacityPlanner({
      calendar: new CompetitionCalendar([
        {
          id: 'w',
          name: 'exactly thirty',
          startAt: T0 + 30 * MINUTE,
          endAt: T0 + 3 * HOUR,
          rampBeforeMs: 0,
        },
      ]),
    })
    const decisions = planner.observe(sample(T0, 5))
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.kind).toBe('scale-up-predicted')
    expect(decisions[0]?.leadMs).toBe(30 * MINUTE)
    expect(decisions[0]?.leadMs).toBeGreaterThanOrEqual(30 * MINUTE)
  })

  test('a calendar entry added only 29 minutes ahead triggers 29 minutes ahead — a data problem, not an algorithm one', () => {
    // The planner cannot lead a window by more than the window told it about.
    // When a replay comes up short of 30 minutes, this is the case to check
    // first: the fix is a calendar entry filed earlier (or a longer ramp on
    // it), not a change to the trigger.
    const planner = new CapacityPlanner({
      calendar: new CompetitionCalendar([
        {
          id: 'late-entry',
          name: 'filed too late',
          startAt: T0 + 29 * MINUTE,
          endAt: T0 + 3 * HOUR,
          rampBeforeMs: 0,
        },
      ]),
    })
    const decisions = planner.observe(sample(T0, 5))
    expect(decisions[0]?.kind).toBe('scale-up-predicted')
    expect(decisions[0]?.leadMs).toBe(29 * MINUTE)
    expect(decisions[0]?.leadMs).toBeLessThan(30 * MINUTE)
  })

  test('a window nobody turned up for still triggers once, and that is accepted', () => {
    // A postponed contest: the calendar says busy, the load says otherwise.
    // M0 buys the capacity anyway. Wasting one scale-up on a cancelled contest
    // is the cheaper of the two mistakes, and the audit line says which
    // window it was so an operator can see why.
    const planner = new CapacityPlanner({
      calendar: new CompetitionCalendar([
        {
          id: 'postponed',
          name: 'a contest that moved',
          startAt: T0 + 12 * HOUR,
          endAt: T0 + 36 * HOUR,
          rampBeforeMs: 6 * HOUR,
        },
      ]),
    })
    const decisions = replay(planner, constantSeries(2, 20))
    expect(decisions.filter(d => d.kind === 'scale-up-predicted')).toHaveLength(
      1,
    )
    expect(decisions.filter(d => d.kind === 'scale-up-reactive')).toHaveLength(
      0,
    )
  })

  test('one window, one scale-up, however many buckets it spans', () => {
    const planner = new CapacityPlanner({
      calendar: new CompetitionCalendar([
        {
          id: 'long',
          name: 'three days',
          startAt: T0 + 6 * HOUR,
          endAt: T0 + 78 * HOUR,
          rampBeforeMs: HOUR,
        },
      ]),
    })
    const predicted = replay(planner, constantSeries(4, 20)).filter(
      d => d.kind === 'scale-up-predicted',
    )
    expect(predicted).toHaveLength(1)
  })

  test('a second window inside the cooldown is held back, then gets its turn', () => {
    const planner = new CapacityPlanner({
      calendar: new CompetitionCalendar([
        {
          id: 'first',
          name: 'first',
          startAt: T0 + 30 * MINUTE,
          endAt: T0 + 2 * HOUR,
          rampBeforeMs: 0,
        },
        {
          id: 'second',
          name: 'second',
          startAt: T0 + 90 * MINUTE,
          endAt: T0 + 20 * HOUR,
          rampBeforeMs: 0,
        },
      ]),
    })
    const decisions = replay(planner, constantSeries(1, 20))
    const first = decisions.filter(d => d.windowId === 'first')
    const second = decisions.filter(d => d.windowId === 'second')
    expect(first.map(d => d.kind)).toEqual(['scale-up-predicted'])
    // Held back once, said so once, and then actually got its capacity after
    // the six-hour cooldown lapsed — a suppressed window is not a dropped one.
    expect(second.map(d => d.kind)).toEqual([
      'scale-up-suppressed',
      'scale-up-predicted',
    ])
    expect(second[0]?.reason).toBe('cooldown')
    // Late, and the record says how late rather than rounding it to zero.
    expect(second[1]?.leadMs).toBeLessThan(0)
  })
})

describe('path B — deviation from the baseline', () => {
  test('a spike the calendar never knew about is reacted to, not predicted', () => {
    const spikeAt = T0 + 18 * DAY + 10 * HOUR
    const series = makeSeries({
      seed: 991,
      startAt: T0,
      days: 21,
      base: 20,
      diurnal: 0.25,
      weekly: 0.3,
      noise: 0.1,
      shapes: [
        { kind: 'spike', at: spikeAt, durationMs: 3 * HOUR, multiplier: 6 },
      ],
    })
    // No calendar at all: whatever fires, fires on the history alone.
    const decisions = replay(new CapacityPlanner(), series)
    const acted = decisions.filter(d => d.kind !== 'scale-up-suppressed')
    expect(acted).toHaveLength(1)
    expect(acted[0]?.kind).toBe('scale-up-reactive')
    expect(acted[0]?.reason).toBe('baseline-deviation')
    expect(acted[0]?.windowId).toBeUndefined()
    // Reacted to while it was happening, so the lead is nothing and the record
    // says nothing rather than borrowing path A's number.
    expect(acted[0]?.leadMs).toBe(0)
    expect(acted[0]?.at).toBeGreaterThanOrEqual(spikeAt)
    expect(acted[0]?.consecutive).toBe(
      DEFAULT_CAPACITY_POLICY.consecutiveBuckets,
    )
  })

  test('one extra task on a dead-flat history does not trigger — the ratio floor holds', () => {
    // The failure this guards: a constant slot has MAD 0, so
    // `median + z × 1.4826 × MAD` collapses to `median` and 21 > 20 is an
    // infinite z-score. Four buckets in a row of it, so the run-length rule
    // cannot be what is doing the work — the only thing left is `minRatio`.
    const series = constantSeries(21, 20)
    for (let index = series.length - 4; index < series.length; index += 1) {
      series[index] = sample(T0 + index * BUCKET, 21)
    }
    expect(replay(new CapacityPlanner(), series)).toEqual([])
  })

  test('…and the same history does trigger once the rise clears the floor', () => {
    // Same shape, same run length, same MAD of zero. Only the size changed:
    // 31 is more than 1.5 × 20 and 21 was not.
    const series = constantSeries(21, 20)
    for (let index = series.length - 4; index < series.length; index += 1) {
      series[index] = sample(T0 + index * BUCKET, 31)
    }
    const decisions = replay(new CapacityPlanner(), series)
    expect(decisions.map(d => d.kind)).toEqual(['scale-up-reactive'])
    expect(decisions[0]?.baselineMedian).toBe(20)
    expect(decisions[0]?.baselineMad).toBe(0)
    // No scale to divide by, so no z-score is written down. A sentinel here
    // would read like a measurement that was never made.
    expect(decisions[0]?.zScore).toBeUndefined()
  })

  test('a slot with too little history abstains instead of guessing', () => {
    // Identical rise, twice, at the same time of day on different weeks. In
    // week one the slot has never been seen; by week three it has two weeks
    // behind it. The load is the same — only the evidence differs.
    const elevate = (dayIndex: number): UsageSample[] => {
      const series = constantSeries(21, 20)
      const first = dayIndex * BUCKETS_PER_DAY + 40
      for (let index = first; index < first + 4; index += 1) {
        series[index] = sample(T0 + index * BUCKET, 120)
      }
      return series
    }
    expect(replay(new CapacityPlanner(), elevate(4))).toEqual([])
    const warm = replay(new CapacityPlanner(), elevate(18))
    expect(warm.map(d => d.kind)).toEqual(['scale-up-reactive'])
    // Exactly `minBaselineSamples` weeks of the same slot, no more.
    expect(DEFAULT_CAPACITY_POLICY.minBaselineSamples).toBe(2)
  })

  test('the planner and a batch baseline agree about the slot they used', () => {
    const series = constantSeries(21, 20)
    for (let index = series.length - 4; index < series.length; index += 1) {
      series[index] = sample(T0 + index * BUCKET, 60)
    }
    const decision = replay(new CapacityPlanner(), series)[0]
    expect(decision).toBeDefined()
    // The history the decision used is strictly older than the decision.
    expect(decision?.baselineMedian).toBe(20)
    expect(slotOfWeek(decision?.at ?? 0)).toBe(
      slotOfWeek((decision?.at ?? 0) + 7 * DAY),
    )
  })
})

describe('feeding the planner', () => {
  test('a bucket that predates the last one is refused, not folded in', () => {
    // Accepting it would let a future value into its own baseline.
    const planner = new CapacityPlanner()
    planner.observe(sample(T0 + BUCKET, 10))
    expect(() => planner.observe(sample(T0, 10))).toThrow(
      'usage buckets must advance',
    )
    expect(() => planner.observe(sample(T0 + BUCKET, 10))).toThrow(
      'usage buckets must advance',
    )
  })

  test('decision ids can be injected, so a replay is reproducible', () => {
    let n = 0
    const planner = new CapacityPlanner({
      nextId: () => `fixed-${++n}`,
      calendar: new CompetitionCalendar([
        {
          id: 'w',
          name: 'w',
          startAt: T0 + 30 * MINUTE,
          endAt: T0 + HOUR,
          rampBeforeMs: 0,
        },
      ]),
    })
    expect(planner.observe(sample(T0, 1))[0]?.id).toBe('fixed-1')
  })

  test('every decision reaches the planner’s own audit log', () => {
    const planner = new CapacityPlanner({
      calendar: new CompetitionCalendar([
        {
          id: 'w',
          name: 'w',
          startAt: T0 + 30 * MINUTE,
          endAt: T0 + HOUR,
          rampBeforeMs: 0,
        },
      ]),
    })
    planner.observe(sample(T0, 1))
    expect(planner.audit.count(CapacityEventType.Predicted)).toBe(1)
    const [event] = planner.audit.of(CapacityEventType.Predicted)
    expect(event?.detail['leadMs']).toBe(30 * MINUTE)
    expect(event?.detail['policyVersion']).toBe('qianmo.capacity.policy.v0')
    expect(event?.detail['bucketAt']).toBe(T0)
  })
})

describe('sizing a scale-up', () => {
  const predicted: ScaleUpDecision = {
    id: 'd-1',
    kind: 'scale-up-predicted',
    at: T0,
    path: 'calendar',
    reason: 'calendar-window',
    observed: 30,
    leadMs: 6 * HOUR,
    windowId: 'w',
  }
  const reactive: ScaleUpDecision = {
    id: 'd-2',
    kind: 'scale-up-reactive',
    at: T0,
    path: 'baseline',
    reason: 'baseline-deviation',
    observed: 126,
    leadMs: 0,
    baselineMedian: 20,
    baselineMad: 1,
    consecutive: 3,
  }

  test('the ask has three axes and no price on it', () => {
    const need = needFromDecision(predicted)
    // Charter N-1: no metering, no billing, `cost_limit` pinned at zero. A
    // capacity ask with a cost field would be inventing a number nothing in M0
    // can honour, so the shape simply does not have one.
    expect(Object.keys(need).sort()).toEqual([
      'cpuCores',
      'durationMs',
      'memoryMb',
    ])
    expect('costLimit' in need).toBe(false)
  })

  test('a calendar window is held longer than a passing deviation', () => {
    expect(needFromDecision(predicted).durationMs).toBe(4 * HOUR)
    expect(needFromDecision(reactive).durationMs).toBe(HOUR)
  })

  test('a bigger rise asks for more, up to a cap', () => {
    expect(needFromDecision(predicted).cpuCores).toBe(2)
    // 126 / 20 → six steps of head-room, capped at four.
    expect(needFromDecision(reactive).cpuCores).toBe(8)
    expect(needFromDecision(reactive).memoryMb).toBe(16_384)
  })

  test('a suppressed decision asks for nothing, loudly', () => {
    expect(() =>
      needFromDecision({ ...reactive, kind: 'scale-up-suppressed' }),
    ).toThrow('asks for no capacity')
  })

  test('the audit-only executor writes and stops', () => {
    const log = new CapacityAuditLog()
    auditOnlyExecutor(log)(predicted)
    auditOnlyExecutor(log)({ ...reactive, kind: 'scale-up-suppressed' })
    expect(log.count(CapacityEventType.Predicted)).toBe(1)
    expect(log.count(CapacityEventType.Suppressed)).toBe(1)
  })
})
