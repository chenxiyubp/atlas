// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BACKOFF,
  ReconnectSchedule,
  backoffDelay,
} from '../src/index.js'

/** Jitter is `2 × random() - 1`, so 0.5 means "no jitter" and pins the maths. */
const noJitter = (): number => 0.5

describe('backoffDelay', () => {
  test('doubles from the base delay and then holds at the ceiling', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map(attempt =>
      backoffDelay(attempt, DEFAULT_BACKOFF, noJitter),
    )
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })

  test('jitter stays inside ±25 % and never goes negative', () => {
    for (const random of [() => 0, () => 1, () => 0.13]) {
      const delay = backoffDelay(3, DEFAULT_BACKOFF, random)
      expect(delay).toBeGreaterThanOrEqual(3_000)
      expect(delay).toBeLessThanOrEqual(5_000)
    }
  })
})

describe('ReconnectSchedule', () => {
  test('a 30 s outage is covered by five attempts under the defaults', () => {
    // The P2.2 acceptance line, arithmetic first: pull the network for 30 s
    // and the schedule must still be retrying, not have given up.
    const schedule = new ReconnectSchedule(DEFAULT_BACKOFF, noJitter)
    let now = 0
    const attempts: number[] = []
    while (now < 30_000) {
      const decision = schedule.next(now)
      expect(decision.action).toBe('retry')
      if (decision.action !== 'retry') break
      attempts.push(now)
      now += decision.delayMs
    }
    expect(attempts).toEqual([0, 1_000, 3_000, 7_000, 15_000])
    // Still alive at the 30 s mark, with budget to spare.
    const afterOutage = schedule.next(30_000)
    expect(afterOutage.action).toBe('retry')
  })

  test('gives up only after the whole budget is spent', () => {
    // Walk the schedule the way a client does — retry at exactly the delay it
    // was handed — so no gap ever looks like a freeze and the budget is spent
    // honestly.
    const schedule = new ReconnectSchedule(DEFAULT_BACKOFF, noJitter)
    let now = 0
    let attempts = 0
    for (;;) {
      const decision = schedule.next(now)
      if (decision.action === 'give-up') {
        expect(decision.elapsedMs).toBeGreaterThanOrEqual(
          DEFAULT_BACKOFF.giveUpAfterMs,
        )
        break
      }
      attempts += 1
      now += decision.delayMs
      expect(attempts).toBeLessThan(100)
    }
    // 1+2+4+8+16 s of ramp, then 30 s steps to fill out ten minutes.
    expect(attempts).toBe(24)
  })

  test('a success clears the outage', () => {
    const schedule = new ReconnectSchedule(DEFAULT_BACKOFF, noJitter)
    schedule.next(0)
    schedule.next(1_000)
    expect(schedule.attemptCount).toBe(2)
    schedule.succeeded()
    expect(schedule.attemptCount).toBe(0)
    const decision = schedule.next(2_000)
    expect(decision).toEqual({
      action: 'retry',
      attempt: 1,
      delayMs: DEFAULT_BACKOFF.baseDelayMs,
      timeJumpDetected: false,
    })
  })

  test('a freeze resets the budget instead of consuming it', () => {
    // E4: a frozen node's wall clock keeps running, so on thaw the elapsed
    // time looks like a spent budget. Without this reset a node that slept
    // longer than the budget would wake up and immediately declare its peer
    // gone — every single time it thaws.
    const schedule = new ReconnectSchedule(DEFAULT_BACKOFF, noJitter)
    schedule.next(0)
    const frozenFor = DEFAULT_BACKOFF.giveUpAfterMs * 3
    const decision = schedule.next(frozenFor)
    expect(decision).toEqual({
      action: 'retry',
      attempt: 1,
      delayMs: DEFAULT_BACKOFF.baseDelayMs,
      timeJumpDetected: true,
    })
  })

  test('the 34.7 s E4 gap distinguishes factor 2 from the A/B candidate', () => {
    const baseline = new ReconnectSchedule(DEFAULT_BACKOFF, noJitter)
    baseline.next(0)
    const baselineDecision = baseline.next(34_700)
    expect(baselineDecision.action).toBe('retry')
    if (baselineDecision.action === 'retry') {
      expect(baselineDecision.timeJumpDetected).toBe(false)
    }

    const candidate = new ReconnectSchedule(
      { ...DEFAULT_BACKOFF, timeJumpFactor: 1.1 },
      noJitter,
    )
    candidate.next(0)
    const candidateDecision = candidate.next(34_700)
    expect(candidateDecision.action).toBe('retry')
    if (candidateDecision.action === 'retry') {
      expect(candidateDecision.timeJumpDetected).toBe(true)
    }
  })

  test('maximum legal jitter is never mistaken for a freeze by the candidate', () => {
    const maximumJitter = (): number => 1
    const schedule = new ReconnectSchedule(
      { ...DEFAULT_BACKOFF, timeJumpFactor: 1.1 },
      maximumJitter,
    )
    let now = 0
    for (let index = 0; index < 8; index++) {
      const decision = schedule.next(now)
      expect(decision.action).toBe('retry')
      if (decision.action !== 'retry') break
      expect(decision.timeJumpDetected).toBe(false)
      now += decision.delayMs
    }
  })

  test('a gap inside the threshold is ordinary elapsed time, not a freeze', () => {
    const schedule = new ReconnectSchedule(DEFAULT_BACKOFF, noJitter)
    schedule.next(0)
    const threshold =
      DEFAULT_BACKOFF.maxDelayMs * DEFAULT_BACKOFF.timeJumpFactor
    const decision = schedule.next(threshold)
    expect(decision).toEqual({
      action: 'retry',
      attempt: 2,
      delayMs: 2 * DEFAULT_BACKOFF.baseDelayMs,
      timeJumpDetected: false,
    })
  })
})
