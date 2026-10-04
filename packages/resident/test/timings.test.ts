// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { ResidentTimingRecorder } from '../src/timings.js'

const event = (at: number) => ({
  stage: 'acp_ready' as const,
  at,
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
})

describe('resident timing recorder', () => {
  test('bounds retained evidence while continuing to emit every event', () => {
    const emitted: number[] = []
    const recorder = new ResidentTimingRecorder(
      value => emitted.push(value.at),
      2,
    )

    recorder.record(event(1))
    recorder.record(event(2))
    recorder.record(event(3))

    expect(emitted).toEqual([1, 2, 3])
    expect(recorder.all().map(value => value.at)).toEqual([2, 3])
  })

  test('contains sink failure so evidence cannot change runtime semantics', () => {
    const recorder = new ResidentTimingRecorder(() => {
      throw new Error('evidence store unavailable')
    })

    expect(() => recorder.record(event(1))).not.toThrow()
    expect(recorder.all()).toEqual([event(1)])
  })

  test('rejects non-positive or fractional capacities', () => {
    expect(() => new ResidentTimingRecorder(undefined, 0)).toThrow(RangeError)
    expect(() => new ResidentTimingRecorder(undefined, 1.5)).toThrow(RangeError)
  })
})
