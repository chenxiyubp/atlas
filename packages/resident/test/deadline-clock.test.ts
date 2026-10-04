// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { ResidentDeadlineClock } from '../src/deadline-clock.js'

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

describe('resident deadline clock', () => {
  test('ordinary time advances without adjustment', () => {
    let wall = 1_000
    const scheduler = new ManualScheduler()
    const clock = new ResidentDeadlineClock({
      periodMs: 10_000,
      now: () => wall,
      schedule: scheduler.schedule,
    })
    clock.start()

    wall += 10_000
    scheduler.fire()

    expect(clock.nowFor(1_000)).toBe(wall)
  })

  test('the first deadline query after thaw observes the freeze', () => {
    let wall = 1_000
    const scheduler = new ManualScheduler()
    const clock = new ResidentDeadlineClock({
      periodMs: 10_000,
      now: () => wall,
      schedule: scheduler.schedule,
    })
    clock.start()

    wall += 34_700

    expect(clock.nowFor(1_000)).toBe(1_000)
  })

  test('excludes only the overlapping parts of multiple freezes', () => {
    let wall = 1_000
    const scheduler = new ManualScheduler()
    const clock = new ResidentDeadlineClock({
      periodMs: 10_000,
      now: () => wall,
      schedule: scheduler.schedule,
    })
    clock.start()

    wall += 30_000
    scheduler.fire()
    const betweenFreezes = wall
    wall += 10_000
    scheduler.fire()
    wall += 30_000
    scheduler.fire()

    expect(clock.nowFor(1_000)).toBe(11_000)
    expect(clock.nowFor(betweenFreezes)).toBe(betweenFreezes + 10_000)
    expect(clock.nowFor(wall - 15_000)).toBe(wall - 15_000)
  })

  test.each([
    34_700, 97_000,
  ])('an E4-sized %ims freeze is excluded from deadline time', freezeMs => {
    let wall = 1_000
    const scheduler = new ManualScheduler()
    const clock = new ResidentDeadlineClock({
      periodMs: 10_000,
      now: () => wall,
      schedule: scheduler.schedule,
    })
    clock.start()
    const before = clock.nowFor(1_000)

    wall += freezeMs
    scheduler.fire()

    expect(clock.nowFor(1_000)).toBe(before)
    const duringFreeze = wall - Math.floor(freezeMs / 2)
    expect(clock.nowFor(duringFreeze)).toBe(duringFreeze)
    expect(clock.nowFor(wall)).toBe(wall)
    wall += 10_000
    scheduler.fire()
    expect(clock.nowFor(1_000)).toBe(before + 10_000)
  })
})
