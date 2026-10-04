// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { ProtocolErrorCode } from '@qianmo/protocol'
import type { ActivationOutcome } from '@qianmo/activator'
import type { ResidentTimingEvent } from '@qianmo/resident/timings'
import { buildP31Report, checkP31Factors } from './p31-report-core.js'

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function outcome(
  msgId: string,
  acceptedAt: number,
  status: 'forwarded' | 'failed' = 'forwarded',
): ActivationOutcome {
  const timings = {
    requestId: `request-${msgId}`,
    sandboxName: 'sandbox-node-b',
    msgId,
    taskId: `task-${msgId}`,
    acceptedAt,
    wakeStartedAt: acceptedAt + 1,
    readyAt: acceptedAt + 20,
    ...(status === 'forwarded' ? { forwardedAt: acceptedAt + 80 } : {}),
    outcome: status,
    ...(status === 'failed' ? { reason: 'target failed' } : {}),
  } as const
  return status === 'forwarded'
    ? { status, requestId: timings.requestId, timings }
    : {
        status,
        requestId: timings.requestId,
        code: ProtocolErrorCode.E_UNDELIVERABLE,
        reason: 'target failed',
        timings,
      }
}

function events(
  msgId: string,
  acceptedAt: number,
  firstContentDelay: number,
): ResidentTimingEvent[] {
  const common = {
    sessionId: SESSION,
    inputMessageId: `input-${msgId}`,
    networkMsgId: msgId,
    agent: 'reviewer',
  }
  return [
    { ...common, stage: 'detected', at: acceptedAt + 25 },
    { ...common, stage: 'admitted', at: acceptedAt + 30 },
    { ...common, stage: 'read', at: acceptedAt + 35 },
    { ...common, stage: 'first_content', at: acceptedAt + firstContentDelay },
    {
      ...common,
      stage: 'turn_completed',
      at: acceptedAt + firstContentDelay + 10,
    },
  ]
}

describe('P3.1 benchmark report', () => {
  test('factor evidence comes from the latest resident generation', () => {
    const factor = checkP31Factors(
      [
        {
          stage: 'acp_ready',
          at: 1,
          sessionId: SESSION,
          activityReconnectFactor: 2,
        },
        {
          stage: 'acp_ready',
          at: 2,
          sessionId: SESSION,
          activityReconnectFactor: 1.1,
        },
      ],
      1.1,
      1.5,
      1.5,
    )
    expect(factor).toEqual({
      expectedResidentReconnect: 1.1,
      actualResidentReconnect: 1.1,
      expectedHostKeepalive: 1.5,
      actualHostKeepalive: 1.5,
      pass: true,
    })
    expect(checkP31Factors([], 1.1, 1.5, 1.5).pass).toBe(false)
  })

  test('requires the activator and every resident response stage', () => {
    const report = buildP31Report(
      [outcome('m1', 1_000)],
      events('m1', 1_000, 50),
      { expectedRounds: 1, latencyLimitMs: 60_000 },
    )

    expect(report.pass).toBe(true)
    expect(report.responsive).toBe(1)
    expect(report.entries[0]).toMatchObject({
      status: 'responsive',
      acceptToReadMs: 35,
      acceptToFirstContentMs: 50,
      readyToDetectedMs: 5,
    })
  })

  test('does not count a transport receipt as responsiveness without first content', () => {
    const resident = events('m1', 1_000, 50).filter(
      event => event.stage !== 'first_content',
    )
    const report = buildP31Report([outcome('m1', 1_000)], resident, {
      expectedRounds: 1,
      latencyLimitMs: 60_000,
    })

    expect(report.pass).toBe(false)
    expect(report.incomplete).toBe(1)
    expect(report.acceptToFirstContent.count).toBe(0)
  })

  test('preserves activator failure as a failed sample', () => {
    const report = buildP31Report([outcome('m1', 1_000, 'failed')], [], {
      expectedRounds: 1,
      latencyLimitMs: 60_000,
    })

    expect(report.pass).toBe(false)
    expect(report.failed).toBe(1)
    expect(report.entries[0]?.reason).toBe('target failed')
  })

  test('uses nearest-rank P95 and enforces the full expected sample count', () => {
    const outcomes = Array.from({ length: 10 }, (_, index) =>
      outcome(`m${index}`, 1_000 + index * 100_000),
    )
    const resident = outcomes.flatMap((entry, index) => {
      if (entry.status === 'refused') return []
      return events(
        entry.timings.msgId,
        entry.timings.acceptedAt,
        (index + 1) * 1_000,
      )
    })
    const report = buildP31Report(outcomes, resident, {
      expectedRounds: 10,
      latencyLimitMs: 9_999,
    })

    expect(report.acceptToFirstContent.p95Ms).toBe(10_000)
    expect(report.pass).toBe(false)
    expect(
      buildP31Report(outcomes.slice(0, 9), resident, {
        expectedRounds: 10,
        latencyLimitMs: 60_000,
      }).pass,
    ).toBe(false)
  })
})
