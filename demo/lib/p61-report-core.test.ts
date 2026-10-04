// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { buildP61Report, type P61Observations } from './p61-report-core.js'

function observations(
  overrides: Partial<P61Observations> = {},
): P61Observations {
  return {
    mode: 'acceptance',
    startedAt: 1_800_000_000_000,
    durationMs: 600_000,
    requiredDurationMs: 600_000,
    seed: 6101,
    taskId: 'p61-task',
    versions: { bun: '1.3.0', node: 'v24.0.0' },
    beats: [1, 2, 3, 4, 5, 6].map(beat => ({
      beat: beat as 1 | 2 | 3 | 4 | 5 | 6,
      at: 1_800_000_000_000 + beat,
      ok: true,
    })),
    diagnosis: {
      cause: 'oom',
      confidence: 'high',
      evidence: ['captured output contains "javascript heap out of memory"'],
      runtime: 'node',
    },
    negotiation: {
      leased: true,
      requested: { durationMs: 600_000, cpuCores: 1, memoryMb: 512 },
      granted: { durationMs: 600_000, cpuCores: 1, memoryMb: 512 },
      offerId: 'offer-1',
    },
    authorization: {
      mode: 'scripted-hook',
      authorized: true,
      minted: true,
      tokenVerified: true,
      act: 'user-confirmed',
    },
    tunnel: { takenWork: 20, closedReason: 'released' },
    compute: {
      chunks: 20,
      completed: 20,
      workerOks: 20,
      spanMs: 540_000,
      resultDigest: 'digest',
      expectedDigest: 'digest',
    },
    teardown: {
      redialFailed: true,
      lenderPending: 0,
      released: true,
      openedClosedBalanced: true,
    },
    background: { delivered: 600, deliveredAfterTeardown: 3, uncaught: 0 },
    trail: {
      intact: true,
      counts: {
        'p61.task-submitted': 1,
        'qianmo.diagnosis.v1': 1,
        'negotiation.offered': 1,
        'negotiation.leased': 1,
        'p61.user-authorized': 1,
        'tunnel.opened': 1,
        'tunnel.admitted': 1,
        'tunnel.carried': 19,
        'p61.chunk-completed': 20,
        'tunnel.closed': 1,
        'negotiation.released': 1,
      },
    },
    failures: [],
    skipped: [],
    ...overrides,
  }
}

describe('P6.1 AC-7 report', () => {
  test('a complete ten-minute run passes and is AC-7 eligible', () => {
    const report = buildP61Report(observations())
    expect(Object.values(report.checks).every(Boolean)).toBe(true)
    expect(report.pass).toBe(true)
    expect(report.ac7Eligible).toBe(true)
  })

  test('a smoke run can pass without masquerading as AC-7 evidence', () => {
    const report = buildP61Report(
      observations({
        mode: 'smoke',
        durationMs: 60_000,
        requiredDurationMs: 60_000,
        compute: {
          ...observations().compute,
          chunks: 4,
          completed: 4,
          workerOks: 4,
          spanMs: 54_000,
        },
        tunnel: { takenWork: 4, closedReason: 'released' },
      }),
    )
    expect(report.pass).toBe(true)
    expect(report.ac7Eligible).toBe(false)
  })

  test('a generic failure name cannot satisfy the OOM beat', () => {
    const report = buildP61Report(
      observations({
        diagnosis: { ...observations().diagnosis, cause: 'unknown' },
      }),
    )
    expect(report.checks.diagnosisNamesOom).toBe(false)
  })

  test('remote-looking approval without a verified token fails', () => {
    const report = buildP61Report(
      observations({
        authorization: {
          ...observations().authorization,
          tokenVerified: false,
        },
      }),
    )
    expect(report.checks.authorizedAndTokenMinted).toBe(false)
  })

  test('missing worker output or a wrong digest fails borrowed computation', () => {
    const report = buildP61Report(
      observations({
        compute: {
          ...observations().compute,
          workerOks: 19,
          resultDigest: 'wrong',
        },
      }),
    )
    expect(report.checks.computedOnBorrowedResource).toBe(false)
  })

  test('a listener that still answers after release fails teardown', () => {
    const report = buildP61Report(
      observations({
        teardown: { ...observations().teardown, redialFailed: false },
      }),
    )
    expect(report.checks.tunnelTornDownClean).toBe(false)
  })

  test('finishing all beats early and then doing nothing does not pass', () => {
    const report = buildP61Report(
      observations({
        background: {
          ...observations().background,
          deliveredAfterTeardown: 0,
        },
      }),
    )
    expect(report.checks.continuousNoIntervention).toBe(false)
  })

  test('a host counter claiming full work cannot outvote an audit with no tunnel work', () => {
    // 宿主自己说接了 20 条，审计里却一条隧道工作都没有——两个来源打架时
    // 不认宿主。这条正是 `takenWork` 与审计拆分必须同时成立的理由。
    const report = buildP61Report(
      observations({
        tunnel: { takenWork: 20, closedReason: 'released' },
        trail: {
          intact: true,
          counts: {
            'p61.task-submitted': 1,
            'qianmo.diagnosis.v1': 1,
            'negotiation.offered': 1,
            'negotiation.leased': 1,
            'p61.user-authorized': 1,
            'tunnel.closed': 1,
            'negotiation.released': 1,
          },
        },
      }),
    )
    expect(report.checks.computedOnBorrowedResource).toBe(false)
    expect(report.pass).toBe(false)
    expect(report.ac7Eligible).toBe(false)
  })

  test('work that mostly arrived outside the tunnel fails even with chunks all done', () => {
    // 20 块都算完了、digest 也对，但审计里只有 1 条 carried：其余 18 块不是
    // 从隧道进去的。「借来的资源上算完」这句话要求路径也对，不只是结果对。
    const report = buildP61Report(
      observations({
        trail: {
          ...observations().trail,
          counts: {
            ...observations().trail.counts,
            'tunnel.carried': 1,
          },
        },
      }),
    )
    expect(report.checks.computedOnBorrowedResource).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a tunnel that took fewer work items than there were chunks fails', () => {
    const report = buildP61Report(
      observations({ tunnel: { takenWork: 19, closedReason: 'released' } }),
    )
    expect(report.checks.computedOnBorrowedResource).toBe(false)
  })

  test('an unmapped runtime failure fails the run', () => {
    const report = buildP61Report(
      observations({
        failures: [{ at: 1, summary: 'surprise', boundary: null }],
      }),
    )
    expect(report.pass).toBe(false)
  })

  test('an uncaught exception fails the continuity check', () => {
    // runner 真装了 uncaughtException / unhandledRejection 处理器，这个数才有
    // 意义；这条用例守的是「非零时必须变红」那一半。
    const report = buildP61Report(
      observations({
        background: { ...observations().background, uncaught: 1 },
      }),
    )
    expect(report.checks.continuousNoIntervention).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a chunk that was planned but never dispatched fails the run', () => {
    const report = buildP61Report(
      observations({
        skipped: [
          {
            what: 'chunk 19 of 20',
            reason:
              'planned but never dispatched; the run stopped at computing',
          },
        ],
      }),
    )
    expect(report.checks.continuousNoIntervention).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('runtime versions ride along as metadata and do not gate the run', () => {
    // 版本是留档用的元数据，不是第八条判据：量不到时报告照样能过，但那两格
    // 必须原样出现在报告里，否则「两者版本写入报告」这句话就没有落点。
    const report = buildP61Report(
      observations({ versions: { bun: '1.3.0', node: '' } }),
    )
    expect(report.versions).toEqual({ bun: '1.3.0', node: '' })
    expect(report.pass).toBe(true)
  })
})
