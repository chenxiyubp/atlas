// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The stage timings P3.1 and P4.1 will read.
 *
 * The stage boundaries are not arbitrary: E2 found the cost of a wake wildly
 * uneven across them — `unpause` in 46.6–55.5 ms, then a further 9.0–10.2 s
 * before a 400 MiB working set ran at speed. Reporting one end-to-end number
 * would average those together and hide the only thing worth knowing. So the
 * arithmetic that separates them is worth testing on its own.
 */

import { describe, expect, test } from 'bun:test'
import {
  StageTimeline,
  TimingRecorder,
  durationsOf,
  type StageTimings,
} from '../src/stages.js'

const BASE = 1_000_000

function timeline(): StageTimeline {
  return new StageTimeline({
    requestId: 'req-1',
    sandboxName: 'sandbox-1',
    msgId: 'msg-1',
    taskId: 'task-1',
    acceptedAt: BASE,
  })
}

describe('one timeline', () => {
  test('a full wake path yields all four spans', () => {
    const line = timeline()
    line.markWakeStarted(BASE + 20) // our own overhead
    line.markReady(BASE + 20 + 55) // unpause, E2's range
    line.markForwarded(BASE + 20 + 55 + 8)

    expect(durationsOf(line.snapshot())).toEqual({
      acceptToWakeMs: 20,
      wakeToReadyMs: 55,
      readyToForwardMs: 8,
      totalMs: 83,
    })
  })

  test('an already-running target measures readiness from acceptance', () => {
    // Otherwise a target that needed no wake would report an undefined wake
    // span and a total that skipped it.
    const line = timeline()
    line.markReady(BASE + 12)
    line.markForwarded(BASE + 15)
    const durations = durationsOf(line.snapshot())
    expect(durations.acceptToWakeMs).toBeUndefined()
    expect(durations.wakeToReadyMs).toBe(12)
    expect(durations.totalMs).toBe(15)
  })

  test('a request that never got there reports only what happened', () => {
    const line = timeline()
    line.markWakeStarted(BASE + 10)
    line.markFailed('target never became ready')
    const snapshot = line.snapshot()
    expect(snapshot.outcome).toBe('failed')
    expect(snapshot.reason).toBe('target never became ready')
    expect(durationsOf(snapshot)).toEqual({ acceptToWakeMs: 10 })
  })

  test('an untouched timeline is in flight, not forwarded', () => {
    expect(timeline().snapshot().outcome).toBe('in-flight')
  })

  test('a mark cannot be rewritten by a retry', () => {
    // Probing readiness three times must not shrink the wake span each time.
    const line = timeline()
    line.markWakeStarted(BASE + 10)
    line.markWakeStarted(BASE + 900)
    expect(line.snapshot().wakeStartedAt).toBe(BASE + 10)
  })
})

describe('the report', () => {
  const sample = (total: number, wake: number): StageTimings => ({
    requestId: `req-${total}`,
    sandboxName: 'sandbox-1',
    msgId: `msg-${total}`,
    taskId: `task-${total}`,
    acceptedAt: BASE,
    wakeStartedAt: BASE + 1,
    readyAt: BASE + 1 + wake,
    forwardedAt: BASE + total,
    outcome: 'forwarded',
  })

  test('percentiles are values that actually happened', () => {
    // Nearest-rank, not interpolated: a number in an acceptance report should
    // be a measurement, not an average of two.
    const recorder = new TimingRecorder()
    for (const total of [10, 20, 30, 40, 50]) recorder.record(sample(total, 5))
    const report = recorder.report()
    expect(report.total.p50Ms).toBe(30)
    expect(report.total.p95Ms).toBe(50)
    expect(report.total.minMs).toBe(10)
    expect(report.total.maxMs).toBe(50)
  })

  test('outcomes and wakes are counted separately from the spans', () => {
    const recorder = new TimingRecorder()
    recorder.record(sample(10, 5))
    recorder.record({
      ...sample(20, 5),
      outcome: 'failed',
      forwardedAt: undefined,
    })
    recorder.record({ ...sample(30, 5), wakeStartedAt: undefined })
    const report = recorder.report()
    expect(report.samples).toBe(3)
    expect(report.forwarded).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.wakes).toBe(2)
    // The failed sample has no total, so it contributes to no total statistic.
    expect(report.total.count).toBe(2)
  })

  test('an empty recorder reports zeroes rather than NaN', () => {
    const report = new TimingRecorder().report()
    expect(report.samples).toBe(0)
    expect(report.total).toEqual({
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    })
  })

  test('the ring keeps the most recent samples', () => {
    const recorder = new TimingRecorder(3)
    for (const total of [10, 20, 30, 40]) recorder.record(sample(total, 5))
    expect(recorder.samples().map(s => s.msgId)).toEqual([
      'msg-20',
      'msg-30',
      'msg-40',
    ])
  })

  test('a capacity of zero is refused', () => {
    expect(() => new TimingRecorder(0)).toThrow(RangeError)
  })
})
