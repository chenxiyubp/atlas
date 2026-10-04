// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { DEFAULT_BACKOFF, backoffMs } from '../src/backoff.js'

describe('failure backoff', () => {
  test('is zero at zero failures, so a success is observably a reset', () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(-1)).toBe(0)
  })

  test('is strictly increasing until the cap and then flat', () => {
    // The divergence from hermes cron's "no backoff" in one assertion: a watch
    // job has real side effects, so a failing one must slow down.
    const delays = Array.from({ length: 12 }, (_unused, index) =>
      backoffMs(index + 1),
    )
    let sawCap = false
    for (const [index, delay] of delays.entries()) {
      if (index === 0) continue
      const previous = delays[index - 1] as number
      if (
        delay === DEFAULT_BACKOFF.capMs &&
        previous === DEFAULT_BACKOFF.capMs
      ) {
        sawCap = true
        expect(delay).toBe(previous)
        continue
      }
      expect(delay).toBeGreaterThan(previous)
    }
    expect(delays[0]).toBe(DEFAULT_BACKOFF.baseMs)
    expect(sawCap).toBe(true)
    expect(delays.at(-1)).toBe(DEFAULT_BACKOFF.capMs)
  })

  test('doubles from the base', () => {
    expect(backoffMs(1)).toBe(30_000)
    expect(backoffMs(2)).toBe(60_000)
    expect(backoffMs(3)).toBe(120_000)
    expect(backoffMs(4)).toBe(240_000)
  })

  test('never overflows past the cap, however long the outage', () => {
    // `2 ** n` reaches Infinity somewhere past a thousand; the cap has to be
    // the answer rather than the multiplication.
    expect(backoffMs(5_000)).toBe(DEFAULT_BACKOFF.capMs)
    expect(Number.isFinite(backoffMs(5_000))).toBe(true)
  })

  test('needs no seeded RNG: jitter is off unless asked for', () => {
    expect(backoffMs(3)).toBe(backoffMs(3))
    expect(backoffMs(3, { jitter: (_n, delay) => delay + 7 })).toBe(120_007)
  })

  test('ignores a jitter that would turn the backoff into "retry now"', () => {
    expect(backoffMs(3, { jitter: () => -1 })).toBe(120_000)
    expect(backoffMs(3, { jitter: () => Number.NaN })).toBe(120_000)
  })

  test('rejects a cap below the base rather than silently inverting', () => {
    expect(() => backoffMs(1, { baseMs: 0 })).toThrow()
    expect(() => backoffMs(1, { baseMs: 1000, capMs: 500 })).toThrow()
  })
})
