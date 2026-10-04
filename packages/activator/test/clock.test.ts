// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The time-jump gate, against the shape E4 actually measured.
 *
 * E4 froze a long-running Bun process three times and found the process intact
 * afterwards — same PID, 200 MiB of state byte-identical, port still LISTEN —
 * but the clock unforgiving: `CLOCK_MONOTONIC` advanced across the freeze just
 * as the wall clock did (34 s and 97 s gaps agreed within 10 ms), and
 * `setInterval` produced exactly one tick for a 34.7 s gap instead of replaying
 * the missed ones. The two numbers below, 34_700 and 97_000, come from those
 * runs.
 *
 * The gate exists so that the instant of thaw is not also the instant every
 * deadline in the process expires at once.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_GRACE_MS,
  DEFAULT_MIN_JUMP_GAP_MS,
  DEFAULT_TIME_JUMP_FACTOR,
  TimeJumpGate,
} from '../src/clock.js'

const PERIOD = 1_000

/** The two freeze durations E4 measured, in milliseconds. */
const E4_SHORT_FREEZE_MS = 34_700
const E4_LONG_FREEZE_MS = 97_000

describe('detection', () => {
  test('the first observation is never a jump', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    expect(gate.observe(1_000_000).jumped).toBe(false)
    expect(gate.jumpCount).toBe(0)
  })

  test('an on-time observation is not a jump', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    expect(gate.observe(PERIOD).jumped).toBe(false)
  })

  test('a gap right at the threshold is not a jump', () => {
    // Strictly greater, so ordinary jitter up to the threshold is tolerated.
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    const at = PERIOD * DEFAULT_TIME_JUMP_FACTOR
    expect(gate.observe(at).jumped).toBe(false)
  })

  test('one millisecond past the threshold is a jump', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    const observation = gate.observe(PERIOD * DEFAULT_TIME_JUMP_FACTOR + 1)
    expect(observation.jumped).toBe(true)
    expect(observation.gapMs).toBe(2_001)
  })

  test.each([
    ['E4 short freeze', E4_SHORT_FREEZE_MS],
    ['E4 long freeze', E4_LONG_FREEZE_MS],
  ])('%s is detected', (_label, gapMs) => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(500_000)
    const observation = gate.observe(500_000 + gapMs)
    expect(observation.jumped).toBe(true)
    expect(observation.gapMs).toBe(gapMs)
    expect(gate.jumpCount).toBe(1)
  })

  test('three freezes are three jumps, as E4 ran them', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    let now = 0
    gate.observe(now)
    for (let round = 0; round < 3; round += 1) {
      now += E4_SHORT_FREEZE_MS
      expect(gate.observe(now).jumped).toBe(true)
      now += PERIOD
      expect(gate.observe(now).jumped).toBe(false)
    }
    expect(gate.jumpCount).toBe(3)
  })
})

describe('the grace window', () => {
  test('deadlines are not enforced while grace is open', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    const thawAt = E4_SHORT_FREEZE_MS
    gate.observe(thawAt)

    // Everything in flight is past its deadline at the moment of thaw — that
    // is exactly the failure mode. The gate refuses to act on it.
    expect(gate.expired(thawAt - 30_000, thawAt)).toBe(false)
    expect(gate.inGrace(thawAt)).toBe(true)
  })

  test('the window covers E2 working-set warm-up with margin', () => {
    // E2: unpause is 46.6–55.5 ms, but a 400 MiB working set needed a further
    // 9.0–10.2 s. A window that closes inside that is no window at all.
    expect(DEFAULT_GRACE_MS).toBeGreaterThan(10_200)
  })

  test('enforcement resumes once the window closes', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD, graceMs: 5_000 })
    gate.observe(0)
    const thawAt = E4_LONG_FREEZE_MS
    gate.observe(thawAt)
    expect(gate.expired(thawAt, thawAt + 4_999)).toBe(false)
    expect(gate.expired(thawAt, thawAt + 5_000)).toBe(true)
  })

  test('without a jump, a passed deadline is a passed deadline', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    gate.observe(PERIOD)
    expect(gate.expired(PERIOD - 1, PERIOD)).toBe(true)
    expect(gate.expired(PERIOD + 1, PERIOD)).toBe(false)
  })
})

describe('rebasing', () => {
  test('a deadline moves out by exactly the frozen interval', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    const observation = gate.observe(E4_LONG_FREEZE_MS)
    expect(gate.rebase(60_000, observation)).toBe(60_000 + E4_LONG_FREEZE_MS)
  })

  test('a deadline is untouched when nothing jumped', () => {
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    const observation = gate.observe(PERIOD)
    expect(gate.rebase(60_000, observation)).toBe(60_000)
  })

  test('rebasing adds the freeze back rather than restarting the budget', () => {
    // Restarting from `now` would hand a long enough freeze an unlimited
    // budget; the sender's deadline was meant to bound delivery work, and the
    // freeze is not delivery work — but neither is it free time.
    const gate = new TimeJumpGate({ periodMs: PERIOD })
    gate.observe(0)
    const spentBeforeFreeze = 20_000
    const deadline = 30_000
    const observation = gate.observe(spentBeforeFreeze + E4_SHORT_FREEZE_MS)
    const rebased = gate.rebase(deadline, observation)
    const remaining = rebased - observation.gapMs - spentBeforeFreeze
    expect(remaining).toBe(deadline - spentBeforeFreeze)
  })
})

describe('construction', () => {
  test('a non-positive period is refused', () => {
    expect(() => new TimeJumpGate({ periodMs: 0 })).toThrow(RangeError)
  })

  test('a factor of one or less is refused', () => {
    // Factor 1 would call every ordinary tick a freeze.
    expect(() => new TimeJumpGate({ periodMs: PERIOD, factor: 1 })).toThrow(
      RangeError,
    )
  })

  test('the threshold is period times factor once past the floor', () => {
    const gate = new TimeJumpGate({ periodMs: 10_000, factor: 4 })
    expect(gate.thresholdMs).toBe(40_000)
  })

  test('the floor keeps a fast observer from calling every hiccup a freeze', () => {
    // A ten-millisecond poll loop would otherwise treat a 25 ms scheduling
    // delay as a thaw and hand out a grace window on every busy moment.
    const gate = new TimeJumpGate({ periodMs: 10 })
    expect(gate.thresholdMs).toBe(DEFAULT_MIN_JUMP_GAP_MS)
    gate.observe(0)
    expect(gate.observe(25).jumped).toBe(false)
    expect(gate.observe(25 + DEFAULT_MIN_JUMP_GAP_MS + 1).jumped).toBe(true)
  })

  test('the floor can be lowered when the caller knows its own cadence', () => {
    const gate = new TimeJumpGate({ periodMs: 250, factor: 4, minJumpGapMs: 0 })
    expect(gate.thresholdMs).toBe(1_000)
  })
})

describe('a gap the caller measured itself', () => {
  test('observeGap judges the gap it is given, not the wall clock', () => {
    // The activator sleeps for a known interval and measures across it: a probe
    // that legitimately blocks for six seconds is the process running, and must
    // not be read as a freeze.
    const gate = new TimeJumpGate({ periodMs: 10 })
    expect(gate.observeGap(12, 6_000_000).jumped).toBe(false)
    expect(gate.jumpCount).toBe(0)
  })

  test('observeGap detects a sleep that came back far too late', () => {
    const gate = new TimeJumpGate({ periodMs: 10 })
    const observation = gate.observeGap(E4_SHORT_FREEZE_MS, 1_000_000)
    expect(observation.jumped).toBe(true)
    expect(observation.gapMs).toBe(E4_SHORT_FREEZE_MS)
    expect(gate.inGrace(1_000_000)).toBe(true)
  })

  test('the first observeGap can jump — unlike the first observe', () => {
    // There is no bootstrapping problem here: the caller supplied the gap, so
    // there is nothing to guess.
    const gate = new TimeJumpGate({ periodMs: 10 })
    expect(gate.observeGap(E4_LONG_FREEZE_MS, 1).jumped).toBe(true)
  })
})
