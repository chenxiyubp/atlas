// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { LIMITS } from '@qianmo/protocol'
import {
  InboundBudget,
  NotifyBudget,
  RUNTIME_RATE,
  RuntimeThrottle,
  TokenBucket,
} from '../src/index.js'
import { ARCHIVIST, NODE_A, PLANNER, REVIEWER } from './helpers.js'

const CLOCK = 1_000_000

describe('runtime layer — one sender towards one target', () => {
  test('the 21st message in a minute is refused', () => {
    // Charter AC-3 ①, stated exactly as the criterion states it.
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      expect(throttle.admit(PLANNER, REVIEWER, CLOCK + index)).toBe(true)
    }
    expect(throttle.admit(PLANNER, REVIEWER, CLOCK + 20)).toBe(false)
    expect(RUNTIME_RATE.capacity).toBe(20)
    expect(RUNTIME_RATE.windowMs).toBe(60_000)
  })

  test('the budget is per target, not per sender', () => {
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    expect(throttle.admit(PLANNER, REVIEWER, CLOCK)).toBe(false)
    // Same sender, different target: untouched allowance.
    expect(throttle.admit(PLANNER, ARCHIVIST, CLOCK)).toBe(true)
  })

  test('tokens come back continuously, not in a step at the window edge', () => {
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    // A fixed window would still be refusing here and would then hand back the
    // whole allowance at once, letting a sender spend 40 across the boundary.
    const third = CLOCK + RUNTIME_RATE.windowMs / 3
    expect(throttle.remaining(PLANNER, REVIEWER, third)).toBeCloseTo(20 / 3, 5)
    expect(throttle.admit(PLANNER, REVIEWER, third)).toBe(true)
  })

  test('a full minute of silence restores the whole allowance', () => {
    const throttle = new RuntimeThrottle()
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    const later = CLOCK + RUNTIME_RATE.windowMs
    expect(throttle.remaining(PLANNER, REVIEWER, later)).toBe(
      RUNTIME_RATE.capacity,
    )
  })

  test('the key table stays bounded under a spray of distinct targets', () => {
    const throttle = new RuntimeThrottle({ maxKeys: 8 })
    for (let index = 0; index < 200; index += 1) {
      throttle.admit(PLANNER, `qianmo://node-x/agent-${index}`, CLOCK + index)
    }
    expect(throttle.size).toBeLessThanOrEqual(8)
  })
})

describe('protocol layer — one receiving node, per sending node', () => {
  test('the ceiling is the protocol number, taken from LIMITS', () => {
    const budget = new InboundBudget()
    for (let index = 0; index < LIMITS.ratePerMinute; index += 1) {
      expect(budget.admit(PLANNER, CLOCK)).toBe(true)
    }
    expect(budget.admit(PLANNER, CLOCK)).toBe(false)
  })

  test('two agents on one node share that node’s budget', () => {
    // Otherwise a peer buys itself more allowance by naming more agents.
    const budget = new InboundBudget({ perMinute: 4 })
    expect(budget.admit('qianmo://node-a/planner', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/archivist', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/third', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/fourth', CLOCK)).toBe(true)
    expect(budget.admit('qianmo://node-a/fifth', CLOCK)).toBe(false)
    // A different node is unaffected.
    expect(budget.admit('qianmo://node-b/reviewer', CLOCK)).toBe(true)
  })

  test('a burst that straddles 100 ms is handed one extra token', () => {
    // 600 per 60 s is one token every 100 ms, and the refill is continuous — so
    // how many messages a burst gets through depends on how long the burst
    // takes, not just on the ceiling. roadmap v2.34 writes it as `B·(1/T+1/60)`.
    //
    // Nobody had pinned that down as a test, and the AC-3 harness walked into
    // it: `demo/lib/ac3-loop-rate.ts` fired 601 messages on a real clock and
    // expected the 601st to be refused, which only holds while the burst fits
    // inside 100 ms. On a 2 vCPU box it does not (demo-env.md §7.5), one token
    // came back, and the harness read a healthy limiter as a failure. The
    // limiter is right; this test says what "right" means.
    const refillMs = 60_000 / LIMITS.ratePerMinute
    expect(refillMs).toBe(100)

    const budget = new InboundBudget()
    for (let index = 0; index < LIMITS.ratePerMinute; index += 1) {
      expect(budget.admit(PLANNER, CLOCK)).toBe(true)
    }
    // Same instant: the ceiling holds.
    expect(budget.admit(PLANNER, CLOCK)).toBe(false)
    // One millisecond short of the refill is still short.
    expect(budget.remaining(NODE_A, CLOCK + refillMs - 1)).toBeLessThan(1)
    expect(budget.admit(PLANNER, CLOCK + refillMs - 1)).toBe(false)
    // Across the line, exactly one more message gets in.
    expect(budget.remaining(NODE_A, CLOCK + refillMs)).toBeCloseTo(1, 5)
    expect(budget.admit(PLANNER, CLOCK + refillMs)).toBe(true)
    expect(budget.admit(PLANNER, CLOCK + refillMs)).toBe(false)
  })

  test('an unparseable sender is charged rather than waved through', () => {
    const budget = new InboundBudget({ perMinute: 1 })
    expect(budget.admit('not-an-address', CLOCK)).toBe(true)
    expect(budget.admit('not-an-address', CLOCK)).toBe(false)
  })
})

describe('the two layers are independent', () => {
  test('exhausting the runtime bucket leaves the inbound budget untouched', () => {
    const throttle = new RuntimeThrottle()
    const budget = new InboundBudget()
    for (let index = 0; index < 25; index += 1) {
      throttle.admit(PLANNER, REVIEWER, CLOCK)
    }
    expect(throttle.admit(PLANNER, REVIEWER, CLOCK)).toBe(false)
    expect(budget.remaining('node-a', CLOCK)).toBe(LIMITS.ratePerMinute)
    expect(budget.admit(PLANNER, CLOCK)).toBe(true)
  })

  test('the runtime ceiling is not a protocol number', () => {
    // CLAUDE.md §2.2 pins protocol-level numbers to `LIMITS`; protocol.md §6.4
    // puts the runtime layer outside that document. Both statements can only
    // stay true if this value is absent from `LIMITS`.
    expect(Object.values(LIMITS)).not.toContain(RUNTIME_RATE.capacity)
  })
})

describe('outbound notify budget — a promise, not an allowance', () => {
  test('the 61st notification in a minute is refused', () => {
    const budget = new NotifyBudget()
    for (let index = 0; index < LIMITS.notifyRatePerMinute; index += 1) {
      expect(budget.admit(CLOCK + index)).toBe(true)
    }
    expect(budget.admit(CLOCK + LIMITS.notifyRatePerMinute)).toBe(false)
    expect(LIMITS.notifyRatePerMinute).toBe(60)
  })

  test('a bucket would let a second batch through mid-window; this does not', () => {
    // The measurable difference between the two mechanisms, and the reason the
    // choice is not cosmetic. Same ceiling, same window, same clock: drain at
    // t=0, ask again halfway through.
    const bucket = new TokenBucket(LIMITS.notifyRatePerMinute, 60_000, CLOCK)
    const budget = new NotifyBudget()
    for (let index = 0; index < LIMITS.notifyRatePerMinute; index += 1) {
      bucket.tryConsume(CLOCK)
      budget.admit(CLOCK)
    }

    // Half a minute on, the bucket has refilled half its capacity and hands out
    // thirty more — sixty and then thirty inside one minute, i.e. ninety.
    expect(bucket.tryConsume(CLOCK + 30_000)).toBe(true)
    // The window still holds all sixty, so it says no. Sixty a minute means
    // sixty a minute.
    expect(budget.admit(CLOCK + 30_000)).toBe(false)
  })

  test('slots come back one at a time, as each admission ages out', () => {
    // Staggered rather than all at one instant, because that is the shape a
    // real sender has and it is what shows the window releasing individually
    // instead of in a batch.
    const budget = new NotifyBudget()
    for (let index = 0; index < LIMITS.notifyRatePerMinute; index += 1) {
      expect(budget.admit(CLOCK + index)).toBe(true)
    }
    expect(budget.remaining(CLOCK + 59)).toBe(0)

    // A millisecond before the oldest turns 60 s old, still nothing.
    expect(budget.admit(CLOCK + 59_999)).toBe(false)
    // The window is half-open — `(now - 60s, now]` — so at exactly 60 s the
    // first admission leaves it, and exactly one slot opens with it.
    expect(budget.admit(CLOCK + 60_000)).toBe(true)
    expect(budget.admit(CLOCK + 60_000)).toBe(false)
    // The second admission was a millisecond behind the first, and so is its
    // slot. No batch, ever.
    expect(budget.admit(CLOCK + 60_001)).toBe(true)
    expect(budget.admit(CLOCK + 60_001)).toBe(false)
  })

  test('a quiet hour restores the ceiling and not a token more', () => {
    const budget = new NotifyBudget()
    for (let index = 0; index < LIMITS.notifyRatePerMinute; index += 1) {
      budget.admit(CLOCK)
    }
    const later = CLOCK + 3_600_000
    expect(budget.remaining(later)).toBe(LIMITS.notifyRatePerMinute)
    for (let index = 0; index < LIMITS.notifyRatePerMinute; index += 1) {
      expect(budget.admit(later)).toBe(true)
    }
    // The silence bought a full window, never a doubled one.
    expect(budget.admit(later)).toBe(false)
  })

  test('retryAfterMs names the instant a slot opens', () => {
    const budget = new NotifyBudget({ perMinute: 2, windowMs: 1_000 })
    expect(budget.retryAfterMs(CLOCK)).toBe(0)
    budget.admit(CLOCK)
    budget.admit(CLOCK + 400)
    expect(budget.admit(CLOCK + 500)).toBe(false)
    // The oldest admission ages out 1000 ms after it happened.
    expect(budget.retryAfterMs(CLOCK + 500)).toBe(500)
    expect(budget.admit(CLOCK + 1_001)).toBe(true)
  })

  test('a clock that goes backwards does not open the window', () => {
    const budget = new NotifyBudget({ perMinute: 1, windowMs: 1_000 })
    expect(budget.admit(CLOCK)).toBe(true)
    expect(budget.admit(CLOCK - 10_000)).toBe(false)
  })

  test('the ceiling comes from LIMITS, and the window is not keyed', () => {
    // Unlike the other two limiters this one answers "is this node bothering a
    // person too much", which is one question per node, not one per peer.
    expect(new NotifyBudget().remaining(CLOCK)).toBe(LIMITS.notifyRatePerMinute)
    expect(new NotifyBudget().windowMs).toBe(60_000)
  })

  test('a non-positive ceiling or window is refused', () => {
    expect(() => new NotifyBudget({ perMinute: 0 })).toThrow(RangeError)
    expect(() => new NotifyBudget({ windowMs: 0 })).toThrow(RangeError)
  })

  test('the notify ceiling is a protocol number, unlike the runtime one', () => {
    // It is a promise every node on the network makes, so it belongs in LIMITS
    // — the opposite conclusion from `RUNTIME_RATE`, and for the opposite
    // reason (that one is a local knob protocol.md §6.4 keeps out of scope).
    expect(Object.values(LIMITS)).toContain(LIMITS.notifyRatePerMinute)
    expect(new NotifyBudget().remaining(CLOCK)).toBe(LIMITS.notifyRatePerMinute)
  })
})

describe('token bucket arithmetic', () => {
  test('a clock that goes backwards does not mint tokens', () => {
    const bucket = new TokenBucket(2, 1_000, CLOCK)
    expect(bucket.tryConsume(CLOCK)).toBe(true)
    expect(bucket.tryConsume(CLOCK)).toBe(true)
    expect(bucket.tryConsume(CLOCK - 10_000)).toBe(false)
  })

  test('a non-positive capacity or window is refused', () => {
    expect(() => new TokenBucket(0, 1_000, CLOCK)).toThrow(RangeError)
    expect(() => new TokenBucket(1, 0, CLOCK)).toThrow(RangeError)
  })
})
