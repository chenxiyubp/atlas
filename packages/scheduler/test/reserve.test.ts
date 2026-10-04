// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { assertJob } from '../src/job.js'
import {
  MAX_CATCH_UP_GRACE_MS,
  MIN_CATCH_UP_GRACE_MS,
  catchUpGraceMs,
  planFire,
} from '../src/reserve.js'

const MINUTE = 60_000
const HOUR = 3_600_000

function job(everyMs: number, anchorMs?: number) {
  return assertJob({
    id: 'watch-ci',
    title: 'watch',
    target: 'qianmo://beta-1/planner',
    prompt: 'look',
    schedule: anchorMs === undefined ? { everyMs } : { everyMs, anchorMs },
    taskTtlMs: 900_000,
    notifyPolicy: 'agent-initiated',
  })
}

describe('the catch-up grace window', () => {
  test('is half a period, clamped to hermes’ two-minute and two-hour bounds', () => {
    expect(catchUpGraceMs(10 * MINUTE)).toBe(5 * MINUTE)
    expect(catchUpGraceMs(MINUTE)).toBe(MIN_CATCH_UP_GRACE_MS)
    expect(catchUpGraceMs(24 * HOUR)).toBe(MAX_CATCH_UP_GRACE_MS)
  })

  test('the ceiling is what stops a restarted hub from firing everything at once', () => {
    // Without the clamp a daily job would carry a twelve-hour grace, so a hub
    // back from a long weekend would fire every job it owns in one second, at
    // every node it owns, all with real side effects.
    expect(catchUpGraceMs(24 * HOUR)).toBeLessThan((24 * HOUR) / 2)
  })
})

describe('catch-up collapse', () => {
  test('collapses five missed periods into a single make-up run', () => {
    // The DoD case. Note both assertions: a count of one dispatch alone would
    // also pass for an implementation that silently lost all five.
    const anchor = 1_000_000
    const plan = planFire({
      job: job(MINUTE, anchor),
      lastFiredAt: anchor,
      now: anchor + 5 * MINUTE + 1_000,
    })
    expect(plan.kind).toBe('fire')
    if (plan.kind !== 'fire') return
    expect(plan.fireAtMs).toBe(anchor + 5 * MINUTE)
    expect(plan.collapsed).toBe(4)
  })

  test('the make-up run is the latest missed slot, never the oldest', () => {
    // Running the oldest would be a report about a moment five periods gone,
    // delivered as if it were current.
    const anchor = 0
    const plan = planFire({
      job: job(MINUTE, anchor),
      lastFiredAt: 0,
      now: 5 * MINUTE,
    })
    expect(plan.kind === 'fire' && plan.fireAtMs).toBe(5 * MINUTE)
  })

  test('a single missed slot collapses nothing', () => {
    const anchor = 0
    const plan = planFire({
      job: job(MINUTE, anchor),
      lastFiredAt: 0,
      now: MINUTE + 1,
    })
    expect(plan.kind).toBe('fire')
    if (plan.kind !== 'fire') return
    expect(plan.collapsed).toBe(0)
  })
})

describe('a window older than the grace is given up, not deferred', () => {
  test('an outage past the grace skips the window and reserves the next one', () => {
    // The cost, stated: this job loses that window entirely and forever. A
    // stale watch result is worse than none, because someone reads it as
    // current.
    const anchor = 0
    const everyMs = 10 * MINUTE
    const now = 56 * MINUTE // the 50-minute slot is 6 minutes late; grace is 5
    const plan = planFire({ job: job(everyMs, anchor), lastFiredAt: 0, now })
    expect(plan.kind).toBe('skip')
    if (plan.kind !== 'skip') return
    expect(plan.staleFireAtMs).toBe(50 * MINUTE)
    expect(plan.collapsed).toBe(5)
    expect(plan.fireAtMs).toBe(60 * MINUTE)
    expect(plan.delayMs).toBe(4 * MINUTE)
  })

  test('a slot exactly at the grace boundary still runs', () => {
    const everyMs = 10 * MINUTE
    const grace = catchUpGraceMs(everyMs)
    expect(
      planFire({
        job: job(everyMs, 0),
        lastFiredAt: 0,
        now: everyMs + grace,
      }).kind,
    ).toBe('fire')
    expect(
      planFire({
        job: job(everyMs, 0),
        lastFiredAt: 0,
        now: everyMs + grace + 1,
      }).kind,
    ).toBe('skip')
  })
})

describe('the schedule grid', () => {
  test('an unanchored job fires on its first plan, which is what pins its grid', () => {
    // Without this the anchor would float to the current `now` on every plan
    // and the first instant would be pushed one period further out each time —
    // the job would never run at all.
    const now = 1_700_000_000_000
    const first = planFire({ job: job(HOUR), lastFiredAt: undefined, now })
    expect(first.kind).toBe('fire')
    if (first.kind !== 'fire') return
    expect(first.fireAtMs).toBe(now)

    const second = planFire({
      job: job(HOUR),
      lastFiredAt: first.fireAtMs,
      now: now + 60_000,
    })
    expect(second.kind).toBe('wait')
    if (second.kind !== 'wait') return
    expect(second.fireAtMs).toBe(now + HOUR)
    expect(second.delayMs).toBe(HOUR - 60_000)
  })

  test('an anchor in the future is a start date, not a due instant', () => {
    const now = 1_000
    const anchor = now + 10 * MINUTE
    const plan = planFire({
      job: job(HOUR, anchor),
      lastFiredAt: undefined,
      now,
    })
    expect(plan.kind).toBe('wait')
    if (plan.kind !== 'wait') return
    expect(plan.fireAtMs).toBe(anchor)
  })

  test('does not drift when every plan lands a little late', () => {
    // `lastFiredAt` is the scheduled instant, not the completion clock. Feeding
    // the completion clock back in would walk the job forward by its own
    // lateness every lap, until a five-minute job ran every six.
    const anchor = 0
    const everyMs = 5 * MINUTE
    let lastFiredAt: number | undefined
    const fired: number[] = []
    for (let lap = 0; lap < 5; lap++) {
      // Each pass is a little later than the last: scheduler latency, a slow
      // dispatch, a busy hub.
      const now = lap * everyMs + lap * 11_000
      const plan = planFire({ job: job(everyMs, anchor), lastFiredAt, now })
      expect(plan.kind).toBe('fire')
      if (plan.kind !== 'fire') return
      fired.push(plan.fireAtMs)
      lastFiredAt = plan.fireAtMs
    }
    expect(fired).toEqual([
      0,
      5 * MINUTE,
      10 * MINUTE,
      15 * MINUTE,
      20 * MINUTE,
    ])
  })

  test('a clock that stepped backwards reserves forward, never re-fires', () => {
    const anchor = 0
    const plan = planFire({
      job: job(MINUTE, anchor),
      lastFiredAt: 10 * MINUTE,
      now: 5 * MINUTE,
    })
    expect(plan.kind).toBe('wait')
    if (plan.kind !== 'wait') return
    expect(plan.fireAtMs).toBe(11 * MINUTE)
  })

  test('an off-grid lastFiredAt still yields the first instant strictly after it', () => {
    // An operator editing state by hand will not land on the grid.
    const plan = planFire({
      job: job(MINUTE, 0),
      lastFiredAt: 90_000,
      now: 90_001,
    })
    expect(plan.kind).toBe('wait')
    if (plan.kind !== 'wait') return
    expect(plan.fireAtMs).toBe(2 * MINUTE)
  })

  test('is a pure function of its three inputs', () => {
    const input = {
      job: job(MINUTE, 0),
      lastFiredAt: 0,
      now: 5 * MINUTE,
    } as const
    expect(planFire(input)).toEqual(planFire(input))
  })
})
