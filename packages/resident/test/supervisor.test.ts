// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import { ResidentSupervisor } from '../src/supervisor.js'

describe('resident ACP supervisor', () => {
  test('restarts a crashed child with exponential backoff', async () => {
    let startCount = 0
    const waits: number[] = []
    let stop!: () => void
    const supervisor = new ResidentSupervisor({
      start: async () => {
        startCount += 1
        if (startCount < 3) {
          return { closed: Promise.reject(new Error('crash')), stop: () => {} }
        }
        return {
          closed: new Promise<void>(resolve => {
            stop = resolve
          }),
          stop: () => stop(),
        }
      },
      initialBackoffMs: 10,
      maxBackoffMs: 40,
      now: () => 0,
      wait: async delay => {
        waits.push(delay)
      },
    })

    const running = supervisor.run()
    while (startCount < 3) await Promise.resolve()
    supervisor.stop()
    await running

    expect(waits).toEqual([10, 20])
    expect(supervisor.parked).toBe(false)
  })

  test('awaits crashed generation cleanup before restarting', async () => {
    const events: string[] = []
    let finishSecond!: () => void
    const supervisor = new ResidentSupervisor({
      start: async () => {
        const generation =
          events.filter(event => event.startsWith('start')).length + 1
        events.push(`start-${generation}`)
        if (generation === 1) {
          return {
            closed: Promise.reject(new Error('crash')),
            stop: async () => {
              events.push('stop-1-begin')
              await Promise.resolve()
              events.push('stop-1-end')
            },
          }
        }
        return {
          closed: new Promise<void>(resolve => {
            finishSecond = resolve
          }),
          stop: () => finishSecond(),
        }
      },
      wait: async () => {
        events.push('wait')
      },
      now: () => 0,
    })

    const running = supervisor.run()
    while (!events.includes('start-2')) await Promise.resolve()
    supervisor.stop()
    await running

    expect(events.slice(0, 5)).toEqual([
      'start-1',
      'stop-1-begin',
      'stop-1-end',
      'wait',
      'start-2',
    ])
  })

  test('parks after repeated rapid failures', async () => {
    const onParked = mock((_failures: number) => {})
    const supervisor = new ResidentSupervisor({
      start: async () => {
        throw new Error('bad configuration')
      },
      maxRapidFailures: 3,
      now: () => 0,
      wait: async () => {},
      onParked,
    })

    await supervisor.run()

    expect(supervisor.parked).toBe(true)
    expect(onParked).toHaveBeenCalledWith(3)
  })
})
