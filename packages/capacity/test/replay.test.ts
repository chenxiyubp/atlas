// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P6.2's DoD, as two replays.
 *
 * 1. **Lead time.** Replay a contest history against the seeded calendar and
 *    show the scale-up landing at least 30 minutes before the load.
 * 2. **False positives.** Replay flat load with nothing on the calendar and
 *    show at most one trigger per seven days.
 *
 * ## Why the flat replay warms up for two weeks first
 *
 * The baseline is keyed on slot of week, so a slot gains one observation per
 * week. A planner fed exactly seven cold days has *no* same-slot history at any
 * point, abstains from the deviation path throughout, and scores a perfect zero
 * — a number that says nothing about the detector because the detector never
 * ran. So each seed gets three weeks: two to learn from, and the seventh day
 * onward — **the seven days the DoD is about** — scored with the detector fully
 * armed. `the detector really was armed` below is the case that proves the
 * warm-up did its job rather than merely delaying the abstention.
 */

import { describe, expect, test } from 'bun:test'
import {
  CUMCM_2026,
  CapacityAuditLog,
  CapacityEventType,
  CapacityPlanner,
  loadOf,
  makeSeries,
  seedCalendar,
  type CapacityEvent,
  type ScaleUpDecision,
  type UsageSample,
} from '../src/index.js'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const BASE = 20

/** Three weeks of ordinary term-time load, ending in a 72-hour contest. */
function contestSeries(seed: number): UsageSample[] {
  return makeSeries({
    seed,
    startAt: CUMCM_2026.startAt - 21 * DAY,
    days: 24,
    base: BASE,
    diurnal: 0.2,
    weekly: 0.3,
    noise: 0.05,
    shapes: [
      { kind: 'contest', startAt: CUMCM_2026.startAt, endAt: CUMCM_2026.endAt },
    ],
  })
}

function replay(
  planner: CapacityPlanner,
  samples: readonly UsageSample[],
): ScaleUpDecision[] {
  const decisions: ScaleUpDecision[] = []
  for (const usage of samples) decisions.push(...planner.observe(usage))
  return decisions
}

describe('DoD 1 — a contest is scaled for before it arrives', () => {
  test('the scale-up lands well over 30 minutes ahead, by three separate clocks', () => {
    const series = contestSeries(6201)
    const audit = new CapacityAuditLog()
    const decisions = replay(
      new CapacityPlanner({ calendar: seedCalendar(), audit }),
      series,
    )
    const predicted = decisions.find(d => d.kind === 'scale-up-predicted')
    expect(predicted).toBeDefined()
    if (predicted === undefined) return

    // ① Against the calendar: how far ahead of the window's own start.
    const aheadOfWindow = CUMCM_2026.startAt - predicted.at
    expect(aheadOfWindow).toBeGreaterThanOrEqual(30 * MINUTE)

    // ② Against the load itself: the first bucket that is twice ordinary. The
    //    calendar could be right about the date and still be useless if the
    //    cluster had already been busy for hours by the time it fired.
    const firstRise = series.find(usage => loadOf(usage) >= 2 * BASE)
    expect(firstRise).toBeDefined()
    expect((firstRise?.at ?? 0) - predicted.at).toBeGreaterThanOrEqual(
      30 * MINUTE,
    )

    // ③ Against the audit line: the trail has to make the same claim the
    //    decision did. A DoD demonstrated from an in-memory object and reported
    //    from a file that disagrees is two systems, one of them wrong.
    const [event] = audit.of(CapacityEventType.Predicted)
    expect(event?.detail['leadMs']).toBe(aheadOfWindow)
    expect(event?.detail['windowId']).toBe(CUMCM_2026.id)
    expect(event?.at).toBe(predicted.at)
    expect(predicted.leadMs).toBe(aheadOfWindow)
  })

  test('the lead comes out the same for every seed — it is the calendar, not the load', () => {
    // Path A never looks at a usage number. Different noise, same answer, and
    // that identity is the honest description of what "predictive" means here.
    const leads = [6201, 6202, 6203, 6204].map(seed => {
      const decisions = replay(
        new CapacityPlanner({ calendar: seedCalendar() }),
        contestSeries(seed),
      )
      return decisions.find(d => d.kind === 'scale-up-predicted')?.leadMs
    })
    expect(new Set(leads).size).toBe(1)
    // 6 h ramp + the bucket the 45-minute horizon first reaches it in.
    expect(leads[0]).toBe(6 * HOUR + 45 * MINUTE)
  })

  test('one contest is one scale-up, with the near misses on the record', () => {
    // The cooldown and the in-window suppressor together: 72 hours at up to
    // eight times normal produce exactly one action, and the deviation path's
    // agreement is written down rather than silently discarded.
    const decisions = replay(
      new CapacityPlanner({ calendar: seedCalendar() }),
      contestSeries(6201),
    )
    expect(decisions.filter(d => d.kind === 'scale-up-predicted')).toHaveLength(
      1,
    )
    const suppressed = decisions.filter(d => d.kind === 'scale-up-suppressed')
    expect(suppressed.length).toBeGreaterThanOrEqual(1)
    expect(suppressed.some(d => d.reason === 'covered-by-calendar')).toBe(true)
  })
})

describe('DoD 2 — flat load is left alone', () => {
  const SEEDS = Array.from({ length: 24 }, (_, index) => 62_000 + index)
  const START = Date.UTC(2026, 5, 1, 0, 0, 0)
  const SCORE_FROM = START + 14 * DAY

  function flatSeries(seed: number): UsageSample[] {
    return makeSeries({
      seed,
      startAt: START,
      days: 21,
      base: BASE,
      diurnal: 0.25,
      weekly: 0.3,
      noise: 0.15,
    })
  }

  /** Triggers in the scored week. Suppressed decisions are not triggers. */
  function falsePositives(samples: readonly UsageSample[]): ScaleUpDecision[] {
    // Empty calendar: nothing here has an excuse to fire.
    const planner = new CapacityPlanner()
    const scored: ScaleUpDecision[] = []
    for (const usage of samples) {
      const decisions = planner.observe(usage)
      if (usage.at < SCORE_FROM) continue
      scored.push(...decisions.filter(d => d.kind !== 'scale-up-suppressed'))
    }
    return scored
  }

  test('at most one false positive per seed, and barely any in total', () => {
    const perSeed = SEEDS.map(seed => ({
      seed,
      count: falsePositives(flatSeries(seed)).length,
    }))
    // Per seed, which is what the DoD budgets. Reported as the offending
    // seeds rather than as a count, so a failure is reproducible on the spot.
    expect(perSeed.filter(entry => entry.count > 1)).toEqual([])
    // …and in aggregate, because "exactly one every single time" would satisfy
    // the per-seed bound while being a systematic misfire wearing a budget.
    const total = perSeed.reduce((sum, entry) => sum + entry.count, 0)
    expect(total).toBeLessThanOrEqual(3)
  })

  test('the detector really was armed — the same week with a real rise fires', () => {
    // Without this, a passing false-positive score could just mean the
    // deviation path abstained for three weeks.
    const withRise = makeSeries({
      seed: 62_000,
      startAt: START,
      days: 21,
      base: BASE,
      diurnal: 0.25,
      weekly: 0.3,
      noise: 0.15,
      shapes: [
        {
          kind: 'spike',
          at: SCORE_FROM + 2 * DAY + 9 * HOUR,
          durationMs: 3 * HOUR,
          multiplier: 5,
        },
      ],
    })
    const fired = falsePositives(withRise)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.kind).toBe('scale-up-reactive')
  })

  test('seven days of replay is a millisecond of work', () => {
    // Pure arithmetic in a for-loop: no clock read, no timer, no I/O. This is
    // what makes a 24-seed sweep a unit test instead of a nightly job.
    const week = flatSeries(62_000).slice(0, 7 * 96)
    expect(week).toHaveLength(672)
    const planner = new CapacityPlanner()
    const started = performance.now()
    for (const usage of week) planner.observe(usage)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(250)
  })
})

describe('the audit trail says exactly what the planner decided', () => {
  test('one line per decision, field for field', () => {
    // `safeAppend` in the P7.2 wiring swallows write failures on purpose, so a
    // decision that never reached the trail would otherwise be invisible. This
    // is the case that would notice.
    const written: CapacityEvent[] = []
    const audit = new CapacityAuditLog(4096, event => written.push(event))
    const decisions = replay(
      new CapacityPlanner({ calendar: seedCalendar(), audit }),
      contestSeries(6201),
    )

    expect(written).toHaveLength(decisions.length)
    expect(decisions.length).toBeGreaterThan(0)
    const expectedTypes: Readonly<Record<string, CapacityEventType>> = {
      'scale-up-predicted': CapacityEventType.Predicted,
      'scale-up-reactive': CapacityEventType.Reactive,
      'scale-up-suppressed': CapacityEventType.Suppressed,
    }
    for (const [index, decision] of decisions.entries()) {
      const event = written[index]
      expect(event?.type).toBe(
        expectedTypes[decision.kind] as CapacityEventType,
      )
      expect(event?.at).toBe(decision.at)
      expect(event?.detail['leadMs']).toBe(decision.leadMs)
      expect(event?.detail['zScore']).toBe(decision.zScore as number)
      expect(event?.detail['observed']).toBe(decision.observed)
      expect(event?.detail['reason']).toBe(decision.reason)
      expect(event?.detail['bucketAt']).toBe(decision.at)
      expect(event?.detail['decisionId']).toBe(decision.id)
      expect(event?.detail['baselineMedian']).toBe(
        decision.baselineMedian as number,
      )
      expect(event?.detail['baselineMad']).toBe(decision.baselineMad as number)
      expect(event?.detail['consecutive']).toBe(decision.consecutive as number)
      expect(event?.detail['windowId']).toBe(decision.windowId as string)
    }
  })

  test('every detail value is a scalar the trail can carry', () => {
    const audit = new CapacityAuditLog()
    replay(
      new CapacityPlanner({ calendar: seedCalendar(), audit }),
      contestSeries(6201),
    )
    for (const event of audit.events()) {
      for (const value of Object.values(event.detail)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value)
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
      }
    }
  })
})
