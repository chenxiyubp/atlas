// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_RESIDENT_INACTIVITY_MS,
  isCredentialHttpStatus,
  ResidentInactivityError,
  ResidentInactivityWatchdog,
  ResidentUpstreamHealth,
  type ResidentInactivityTurn,
} from '../src/inactivity.js'

const TURN: ResidentInactivityTurn = {
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  messageId: '11111111-2222-4333-8444-555555555555',
}

/**
 * A schedule under the test's control.
 *
 * The watchdog is a timer, and a test that raced a real one would be exactly
 * the flake this repository keeps finding in CI. Firing is explicit here, so
 * "did it re-arm" is an assertion rather than a sleep.
 */
class ManualSchedule {
  #pending = new Map<number, () => void>()
  #next = 1
  readonly delays: number[] = []

  readonly schedule = (
    delayMs: number,
    callback: () => void,
  ): { cancel(): void } => {
    const id = this.#next++
    this.delays.push(delayMs)
    this.#pending.set(id, callback)
    return {
      cancel: () => {
        this.#pending.delete(id)
      },
    }
  }

  get armed(): number {
    return this.#pending.size
  }

  /** Fire every timer currently armed. */
  fire(): void {
    for (const [id, callback] of [...this.#pending]) {
      this.#pending.delete(id)
      callback()
    }
  }
}

describe('the inactivity watchdog', () => {
  test('a silent turn fails, and the reason says why', async () => {
    const timers = new ManualSchedule()
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs: 1_000,
      schedule: timers.schedule,
    })

    const guarded = watchdog.guard(TURN, () => new Promise<string>(() => {}))
    timers.fire()

    const error = await guarded.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(ResidentInactivityError)
    const failure = error as ResidentInactivityError
    expect(failure.sessionId).toBe(TURN.sessionId)
    expect(failure.messageId).toBe(TURN.messageId)
    expect(failure.idleMs).toBe(1_000)
    // The deliverable is not "it failed" — a bare timeout already did that.
    // It is that the sender can tell inactivity apart from a refusal or a
    // crash, and knows the retry that would help.
    expect(failure.message).toContain('inactivity')
    expect(failure.message).toContain('taskTtlMs')
  })

  test('activity re-arms it, so a talkative turn is never killed', async () => {
    const timers = new ManualSchedule()
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs: 1_000,
      schedule: timers.schedule,
    })

    let finish!: (value: string) => void
    const work = new Promise<string>(resolve => {
      finish = resolve
    })
    const guarded = watchdog.guard(TURN, () => work)

    for (let chunk = 0; chunk < 5; chunk++) watchdog.touch(TURN.sessionId)
    // Five touches, five re-arms, and the original is cancelled each time —
    // so firing everything still armed fires only the latest.
    expect(timers.armed).toBe(1)

    finish('answered')
    await expect(guarded).resolves.toBe('answered')
    // Disarmed on the way out: nothing is left to fire at a finished turn.
    expect(timers.armed).toBe(0)
  })

  test('expiry asks the caller to cancel, once, before it rejects', async () => {
    const timers = new ManualSchedule()
    const cancelled: ResidentInactivityTurn[] = []
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs: 500,
      schedule: timers.schedule,
      onExpired: turn => cancelled.push(turn),
    })

    const guarded = watchdog.guard(TURN, () => new Promise<void>(() => {}))
    timers.fire()
    await guarded.catch(() => {})

    expect(cancelled).toEqual([TURN])
  })

  test('a cancel hook that throws does not swallow the failure', async () => {
    const timers = new ManualSchedule()
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs: 500,
      schedule: timers.schedule,
      onExpired: () => {
        throw new Error('the ACP link is already gone')
      },
    })

    const guarded = watchdog.guard(TURN, () => new Promise<void>(() => {}))
    timers.fire()
    // Cancelling is best effort; failing the turn is the deliverable.
    await expect(guarded).rejects.toBeInstanceOf(ResidentInactivityError)
  })

  test('a turn that fails on its own keeps its own error', async () => {
    const timers = new ManualSchedule()
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs: 1_000,
      schedule: timers.schedule,
    })
    const own = new Error('ACP refused the prompt')

    await expect(
      watchdog.guard(TURN, async () => {
        throw own
      }),
    ).rejects.toBe(own)
    expect(timers.armed).toBe(0)
  })

  test('a zero budget disables it entirely — no timer is ever armed', async () => {
    const timers = new ManualSchedule()
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs: 0,
      schedule: timers.schedule,
    })

    await expect(watchdog.guard(TURN, async () => 'through')).resolves.toBe(
      'through',
    )
    expect(timers.delays).toEqual([])
    expect(watchdog.watching).toBe(0)
  })

  test('touching a session with no turn under way is a no-op', () => {
    const timers = new ManualSchedule()
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs: 1_000,
      schedule: timers.schedule,
    })
    // An update for a session this port is not running a turn for must not
    // arm anything — the same discipline as "an unknown admission notice
    // flips nothing".
    watchdog.touch('some-other-session')
    expect(timers.armed).toBe(0)
    expect(watchdog.watching).toBe(0)
  })

  test('the default budget is under the protocol default task deadline', () => {
    // The whole direction of B10: atlas fails *earlier* than the wall clock,
    // never later. A watchdog set at or above `LIMITS.defaultTaskTtlMs`
    // (5 min) would never be the one to fire, which would make it decoration.
    expect(DEFAULT_RESIDENT_INACTIVITY_MS).toBeLessThan(300_000)
    expect(DEFAULT_RESIDENT_INACTIVITY_MS).toBeGreaterThan(0)
  })
})

describe('why the turn went quiet', () => {
  /** A clock the test moves by hand, so no staleness assertion races a timer. */
  class ManualClock {
    #now = 1_000_000
    readonly now = (): number => this.#now
    advance(ms: number): void {
      this.#now += ms
    }
  }

  function failedTurn(
    health: ResidentUpstreamHealth | undefined,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    const timers = new ManualSchedule()
    const watchdog = new ResidentInactivityWatchdog({
      timeoutMs,
      schedule: timers.schedule,
      ...(health === undefined ? {} : { upstreamHealth: health }),
    })
    const guarded = watchdog.guard(TURN, () => new Promise<void>(() => {}))
    timers.fire()
    return guarded.then(
      () => undefined,
      (reason: unknown) => reason,
    )
  }

  test('a 401 during the silence turns the failure into a credential answer', async () => {
    // The beta fleet's actual fault: the key was refused in 44ms and retried
    // quietly until the budget ran out, and the error that came back talked
    // about model latency (issue #37).
    const clock = new ManualClock()
    const health = new ResidentUpstreamHealth({ now: clock.now })
    health.record(401, '{"error":"Invalid API key"}')
    clock.advance(120_000)

    const error = (await failedTurn(health)) as ResidentInactivityError
    expect(error).toBeInstanceOf(ResidentInactivityError)
    expect(error.isCredentialFailure).toBe(true)
    expect(error.upstream?.status).toBe(401)
    // Points at the credential…
    expect(error.message).toContain('credential')
    expect(error.message).toContain('HTTP 401')
    expect(error.message).toContain('Invalid API key')
    // …and stops recommending the retry that cannot possibly work.
    expect(error.message).not.toContain("is the sender's call")
  })

  test('403 and 407 are credential answers too; 429 and 500 are not', async () => {
    for (const status of [401, 403, 407]) {
      const health = new ResidentUpstreamHealth()
      health.record(status)
      const error = (await failedTurn(health)) as ResidentInactivityError
      expect(error.isCredentialFailure).toBe(true)
      expect(isCredentialHttpStatus(status)).toBe(true)
    }
    for (const status of [429, 500, 400, 404]) {
      const health = new ResidentUpstreamHealth()
      health.record(status)
      const error = (await failedTurn(health)) as ResidentInactivityError
      // Still reported — knowing the endpoint said 429 is useful — but never
      // as "go rotate your key", which would send an operator to fix a
      // credential that was never broken.
      expect(error.isCredentialFailure).toBe(false)
      expect(error.message).toContain(`HTTP ${status}`)
      expect(error.message).toContain("is the sender's call")
      expect(error.message).not.toContain('credential')
    }
  })

  test('a status older than the silence is not offered as its cause', async () => {
    const clock = new ManualClock()
    const health = new ResidentUpstreamHealth({ now: clock.now })
    health.record(401)
    // One millisecond past the budget: the 401 happened before the silence
    // being reported, so it is not evidence about it. A key fixed an hour ago
    // must not be blamed for a turn that went quiet just now.
    clock.advance(120_001)

    const error = (await failedTurn(health)) as ResidentInactivityError
    expect(error.isCredentialFailure).toBe(false)
    expect(error.upstream).toBeUndefined()
    expect(error.message).toContain('inactivity')
    expect(error.message).toContain('taskTtlMs')
    expect(health.last?.status).toBe(401)
  })

  test('no health at all leaves the message exactly as it was', async () => {
    const withoutHealth = (await failedTurn(
      undefined,
    )) as ResidentInactivityError
    const emptyHealth = (await failedTurn(
      new ResidentUpstreamHealth(),
    )) as ResidentInactivityError
    expect(emptyHealth.message).toBe(withoutHealth.message)
    expect(withoutHealth.upstream).toBeUndefined()
  })

  test('a status off the HTTP range cannot make the node lie about itself', () => {
    // Fed from a wire message, so a malformed one must not be storable.
    const health = new ResidentUpstreamHealth()
    for (const bad of [0, 99, 600, -401, 401.5, Number.NaN]) {
      health.record(bad)
    }
    expect(health.last).toBeUndefined()
    health.record(401)
    expect(health.last?.status).toBe(401)
  })
})
