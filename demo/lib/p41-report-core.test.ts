// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { buildP41Report, type P41Round } from './p41-report-core.js'

const OPTIONS = {
  expectedRounds: 3,
  ackLimitMs: 60_000,
  resultLimitMs: 300_000,
}

function round(index: number, overrides: Partial<P41Round> = {}): P41Round {
  return {
    round: index,
    msgId: `msg-${index}`,
    taskId: `task-${index}`,
    verdict: 'complete',
    receipt: 'accepted',
    sentAt: 1_000 * index,
    ackAt: 1_000 * index + 400,
    sendToAckMs: 400,
    ackClosed: true,
    ackFrom: 'qianmo://node-b/reviewer',
    resultAt: 1_000 * index + 900,
    sendToResultMs: 900,
    resultClosed: true,
    resultOutcome: 'completed',
    resultFrom: 'qianmo://node-b/reviewer',
    contentChars: 12,
    unexpected: [],
    frozenBefore: true,
    resolvedByRegistry: true,
    resolveMs: 3,
    resolvedEndpoint: 'ws://127.0.0.1:7350',
    ...overrides,
  }
}

describe('P4.1 report', () => {
  test('passes only when every judgement holds', () => {
    const report = buildP41Report([round(1), round(2), round(3)], OPTIONS)

    expect(report.pass).toBe(true)
    expect(report.complete).toBe(3)
    expect(report.sendToAck.p95Ms).toBe(400)
    expect(report.sendToResult.maxMs).toBe(900)
    expect(Object.values(report.checks).every(Boolean)).toBe(true)
  })

  test('a missing round is not a pass, however fast the ones that ran were', () => {
    const report = buildP41Report([round(1), round(2)], OPTIONS)

    expect(report.checks.rounds).toBe(false)
    expect(report.checks.successRate).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('an acked round with no result is not complete', () => {
    const report = buildP41Report(
      [
        round(1),
        round(2),
        round(3, {
          verdict: 'no-result',
          resultAt: undefined,
          sendToResultMs: undefined,
          resultClosed: undefined,
          resultOutcome: undefined,
        }),
      ],
      OPTIONS,
    )

    expect(report.complete).toBe(2)
    expect(report.checks.successRate).toBe(false)
    expect(report.checks.resultMax).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a failed task.result counts as delivered but not as success', () => {
    const report = buildP41Report(
      [
        round(1),
        round(2),
        round(3, {
          verdict: 'complete',
          resultOutcome: 'failed',
          resultCode: 'E_TASK_FAILED',
          contentChars: 0,
        }),
      ],
      OPTIONS,
    )

    // The result arrived in time — the round still fails on success rate.
    expect(report.checks.resultMax).toBe(true)
    expect(report.checks.successRate).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('one slow round past the result ceiling sinks the run', () => {
    const report = buildP41Report(
      [round(1), round(2), round(3, { sendToResultMs: 300_001 })],
      OPTIONS,
    )

    expect(report.checks.ackP95).toBe(true)
    expect(report.checks.resultMax).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('delivering to a sandbox that was not frozen proves nothing', () => {
    const report = buildP41Report(
      [round(1), round(2), round(3, { frozenBefore: false })],
      OPTIONS,
    )

    expect(report.checks.frozenBefore).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('dialling a URL instead of resolving the name is not the AC-2 chain', () => {
    const report = buildP41Report(
      [round(1), round(2), round(3, { resolvedByRegistry: false })],
      OPTIONS,
    )

    expect(report.checks.resolvedByRegistry).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a reply that is not field-closed, or not ours, fails the run', () => {
    const closure = buildP41Report(
      [round(1), round(2), round(3, { ackClosed: false })],
      OPTIONS,
    )
    const stray = buildP41Report(
      [round(1), round(2), round(3, { unexpected: ['ack:task-other'] })],
      OPTIONS,
    )

    expect(closure.checks.closedReplies).toBe(false)
    expect(closure.pass).toBe(false)
    expect(stray.checks.noStrayReplies).toBe(false)
    expect(stray.pass).toBe(false)
  })
})
