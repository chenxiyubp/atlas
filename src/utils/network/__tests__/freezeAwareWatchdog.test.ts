// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import {
  FreezeAwareWatchdog,
  clearFreezeAwareTimeout,
  setFreezeAwareTimeout,
} from '../freezeAwareWatchdog.js'

class ManualScheduler {
  callback: (() => void) | null = null

  schedule = (_delayMs: number, callback: () => void): { cancel(): void } => {
    this.callback = callback
    return {
      cancel: () => {
        if (this.callback === callback) this.callback = null
      },
    }
  }

  fire(): void {
    const callback = this.callback
    this.callback = null
    callback?.()
  }
}

describe('freeze-aware watchdog', () => {
  test('ordinary elapsed time still fires the watchdog', () => {
    let now = 0
    const scheduler = new ManualScheduler()
    const onTimeout = mock(() => {})
    const watchdog = new FreezeAwareWatchdog({
      timeoutMs: 90_000,
      cadenceMs: 10_000,
      now: () => now,
      schedule: scheduler.schedule,
      onTimeout,
    })
    watchdog.reset()

    for (let elapsed = 10_000; elapsed <= 90_000; elapsed += 10_000) {
      now = elapsed
      scheduler.fire()
    }

    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test.each([
    34_700, 97_000,
  ])('a %ims freeze rebases the idle deadline', freezeMs => {
    let now = 0
    const scheduler = new ManualScheduler()
    const onTimeout = mock(() => {})
    const watchdog = new FreezeAwareWatchdog({
      timeoutMs: 90_000,
      cadenceMs: 10_000,
      now: () => now,
      schedule: scheduler.schedule,
      onTimeout,
    })
    watchdog.reset()
    for (let elapsed = 10_000; elapsed <= 50_000; elapsed += 10_000) {
      now = elapsed
      scheduler.fire()
    }
    now += freezeMs
    scheduler.fire()

    expect(onTimeout).not.toHaveBeenCalled()

    while (now < 90_000 + freezeMs) {
      now = Math.min(now + 10_000, 90_000 + freezeMs)
      scheduler.fire()
    }
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test('reset starts a fresh idle budget after thaw', () => {
    let now = 0
    const scheduler = new ManualScheduler()
    const onTimeout = mock(() => {})
    const watchdog = new FreezeAwareWatchdog({
      timeoutMs: 90_000,
      cadenceMs: 10_000,
      now: () => now,
      schedule: scheduler.schedule,
      onTimeout,
    })
    watchdog.reset()
    now = 97_000
    scheduler.fire()
    watchdog.reset()
    const resetAt = now
    while (now < resetAt + 89_999) {
      now = Math.min(now + 10_000, resetAt + 89_999)
      scheduler.fire()
    }

    expect(onTimeout).not.toHaveBeenCalled()
    now = resetAt + 90_000
    scheduler.fire()
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test('a misconfigured non-positive timeout fires, it does not throw', () => {
    let now = 0
    const scheduler = new ManualScheduler()
    const onTimeout = mock(() => {})
    // `CLAUDE_STREAM_IDLE_TIMEOUT_MS=-1` survives `parseInt` untouched. The
    // `setTimeout` this replaced fired at once on a negative delay and produced
    // the proper timeout error; throwing from inside a stream reader instead
    // would escape that classification and kill the request.
    const watchdog = new FreezeAwareWatchdog({
      timeoutMs: -1,
      now: () => now,
      schedule: scheduler.schedule,
      onTimeout,
    })
    watchdog.reset()

    now = 1
    scheduler.fire()

    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test('a timeout that is not a number at all is still refused', () => {
    expect(
      () =>
        new FreezeAwareWatchdog({
          timeoutMs: Number.NaN,
          onTimeout: () => {},
        }),
    ).toThrow('must be finite')
  })
})

// The setTimeout-shaped pair the base files call (P10.3②). What is asserted
// here is the drop-in contract, not the freeze semantics above: argument order,
// trailing-args passthrough, one shot only, and a clear that also swallows null.
describe('setTimeout-shaped injection point', () => {
  // Real timers, so the freeze detection is live: an event-loop stall past the
  // 2 s jump threshold (seen on loaded CI runners) reads as a sandbox freeze
  // and holds the deadline for the 15 s grace (TimeJumpGate). The callback then
  // fires about 17 s in, which the default 5 s test budget cannot wait for.
  // Hence the explicit timeout; the ordinary run still finishes in milliseconds.
  test('passes the trailing arguments through and fires once', async () => {
    const seen: number[] = []
    const { promise: fired, resolve } = Promise.withResolvers<void>()
    setFreezeAwareTimeout(
      warnMs => {
        seen.push(warnMs)
        resolve()
      },
      1,
      45_000,
    )

    // Wait for the callback itself, not a fixed sleep. A callback that never
    // comes still fails, on the test timeout below.
    await fired
    // One shot: give a repeat the same window the old test allowed.
    await Bun.sleep(60)

    expect(seen).toEqual([45_000])
  }, 30_000)

  test('clearing before the deadline cancels the callback', async () => {
    const onTimeout = mock(() => {})
    const timer = setFreezeAwareTimeout(onTimeout, 1)
    clearFreezeAwareTimeout(timer)

    await Bun.sleep(60)

    expect(onTimeout).not.toHaveBeenCalled()
  })

  test('clearing a handle that was never set is a no-op', () => {
    expect(() => clearFreezeAwareTimeout(null)).not.toThrow()
  })
})
