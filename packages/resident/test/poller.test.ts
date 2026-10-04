// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import { ResidentPoller } from '../src/poller.js'

describe('resident mailbox poller', () => {
  test('reschedules after each completed poll instead of replaying missed ticks', async () => {
    const callbacks: Array<() => void> = []
    const delays: number[] = []
    let release!: () => void
    const poll = mock(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )
    const poller = new ResidentPoller({
      poll,
      intervalMs: 500,
      schedule: (delay, callback) => {
        delays.push(delay)
        callbacks.push(callback)
        return { cancel: () => {} }
      },
    })

    poller.start()
    callbacks.shift()?.()
    await Promise.resolve()
    expect(delays).toEqual([0])

    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(delays).toEqual([0, 500])
    poller.stop()
  })

  test('reports a poll failure and continues', async () => {
    const callbacks: Array<() => void> = []
    const onError = mock((_error: unknown) => {})
    const poller = new ResidentPoller({
      poll: async () => {
        throw new Error('mailbox unavailable')
      },
      onError,
      schedule: (_delay, callback) => {
        callbacks.push(callback)
        return { cancel: () => {} }
      },
    })

    poller.start()
    callbacks.shift()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(callbacks).toHaveLength(1)
    poller.stop()
  })

  describe('the ESTOP pause (design §3.B6)', () => {
    test('skips the poll while engaged and resumes when it clears, with no restart', async () => {
      const callbacks: Array<() => void> = []
      const poll = mock(async () => {})
      let engaged = true
      const poller = new ResidentPoller({
        poll,
        paused: () => engaged,
        schedule: (_delay, callback) => {
          callbacks.push(callback)
          return { cancel: () => {} }
        },
      })

      poller.start()
      callbacks.shift()?.()
      await Promise.resolve()
      await Promise.resolve()
      // No new work is admitted…
      expect(poll).toHaveBeenCalledTimes(0)
      // …and the timer keeps running, which is the difference between a pause
      // and a stop: clearing the file must not need anything restarted.
      expect(callbacks).toHaveLength(1)

      engaged = false
      callbacks.shift()?.()
      await Promise.resolve()
      await Promise.resolve()
      expect(poll).toHaveBeenCalledTimes(1)
      poller.stop()
    })

    test('a predicate that throws fails open: the poll still runs, and it is reported', async () => {
      const callbacks: Array<() => void> = []
      const onError = mock((_error: unknown) => {})
      const poll = mock(async () => {})
      const poller = new ResidentPoller({
        poll,
        paused: () => {
          throw new Error('the sentinel is unreadable')
        },
        onError,
        schedule: (_delay, callback) => {
          callbacks.push(callback)
          return { cancel: () => {} }
        },
      })

      poller.start()
      callbacks.shift()?.()
      await Promise.resolve()
      await Promise.resolve()

      // The reliability kit is never the reason a node stops serving.
      expect(poll).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledTimes(1)
      poller.stop()
    })
  })
})
