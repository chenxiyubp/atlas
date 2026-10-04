// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  INJECTION_KINDS,
  buildChaosReport,
  type ChaosObservations,
  type InjectionKind,
} from './chaos-report-core.js'

function injection(kind: InjectionKind, progressAfter = 2) {
  return { kind, at: 1_800_000_000_000, progressAfter, recoveredInMs: 120 }
}

function observations(
  overrides: Partial<ChaosObservations> = {},
): ChaosObservations {
  return {
    durationMs: 3_600_000,
    seed: 42,
    injections: INJECTION_KINDS.map(kind => injection(kind)),
    skipped: [],
    failures: [
      {
        at: 1_800_000_000_001,
        summary: 'ENOSPC: no space left on device, write',
        boundary: 'disk full',
      },
    ],
    uncaught: 0,
    delivered: 138,
    trailIntact: true,
    ...overrides,
  }
}

describe('混沌跑批的判据', () => {
  test('五条都成立才算通过', () => {
    const report = buildChaosReport(observations())
    expect(report.pass).toBe(true)
    expect(Object.values(report.checks).filter(Boolean)).toHaveLength(5)
  })

  test('一次未捕获异常就判红', () => {
    expect(buildChaosReport(observations({ uncaught: 1 })).pass).toBe(false)
  })

  test('「什么都没发生」不算通过：一次注入之后停摆就判红', () => {
    // 这条是这份报告存在的主要理由。只看异常数的话，一个悄悄停摆的系统与一个
    // 完美恢复的系统长得一模一样。
    const stalled = INJECTION_KINDS.map(kind =>
      kind === 'cut-network' ? injection(kind, 0) : injection(kind),
    )
    const report = buildChaosReport(observations({ injections: stalled }))
    expect(report.checks.noUncaught).toBe(true)
    expect(report.checks.systemKeptWorking).toBe(false)
    expect(report.pass).toBe(false)
    expect(
      report.byKind.find(entry => entry.kind === 'cut-network')?.stalled,
    ).toBe(1)
  })

  test('全程一条都没处理成功，也判红', () => {
    expect(
      buildChaosReport(observations({ delivered: 0 })).checks.systemKeptWorking,
    ).toBe(false)
  })

  test('对不上已知边界的失败，一条就判红', () => {
    // 「我们见到了一个说不出名字的错误，但它没让进程崩」不是通过的理由。
    const report = buildChaosReport(
      observations({
        failures: [
          {
            at: 1,
            summary: 'TypeError: undefined is not a function',
            boundary: null,
          },
        ],
      }),
    )
    expect(report.unmapped).toHaveLength(1)
    expect(report.checks.everyFailureMapped).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('少注入一类就判红，而不是按跑到的那几类算', () => {
    const report = buildChaosReport(
      observations({
        injections: INJECTION_KINDS.filter(kind => kind !== 'clock-drift').map(
          kind => injection(kind),
        ),
      }),
    )
    expect(report.checks.everyKindInjected).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('平台造不出某一类时，skipped 同样判红', () => {
    // 四类里跑了三类的报告，不是四类的证据。
    const report = buildChaosReport(
      observations({
        skipped: [
          { kind: 'fill-disk', reason: 'no /dev/full on this platform' },
        ],
      }),
    )
    expect(report.checks.everyKindInjected).toBe(false)
  })

  test('跑完之后审计链断了也判红', () => {
    expect(
      buildChaosReport(observations({ trailIntact: false })).checks.trailIntact,
    ).toBe(false)
  })

  test('报告带着种子，红色跑批能被重放', () => {
    // 一条复现不了的红色只是传闻。
    expect(buildChaosReport(observations({ seed: 70101 })).seed).toBe(70101)
  })
})
