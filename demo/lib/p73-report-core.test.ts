// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  buildP73Report,
  type P73Config,
  type P73MemorySample,
  type P73Observations,
  type P73TierObservation,
} from './p73-report-core.js'

const T0 = 1_800_000_000_000
const INTERVAL_MS = 60_000

function tier(
  overrides: Partial<P73TierObservation> & { targetRate: number },
): P73TierObservation {
  const seconds = overrides.seconds ?? 120
  const delivered =
    overrides.deliveredBySender ?? overrides.targetRate * seconds
  return {
    config: 'T3' as P73Config,
    seconds,
    senders: 1,
    attempted: delivered,
    deliveredBySender: delivered,
    deliveredByAudit: delivered,
    duplicate: 0,
    rejected: 0,
    outboxFull: 0,
    rateLimited: 0,
    p50Ms: 3,
    p95Ms: 8,
    latencySamples: delivered,
    ...overrides,
  }
}

function memorySamples(count = 5, role = 'resident'): P73MemorySample[] {
  return Array.from({ length: count }, (_, index) => ({
    at: T0 + index * INTERVAL_MS,
    role,
    channel: 'proc',
  }))
}

function observations(
  overrides: Partial<P73Observations> = {},
): P73Observations {
  return {
    tiers: [tier({ targetRate: 1 }), tier({ targetRate: 5 })],
    memory: { intervalMs: INTERVAL_MS, samples: memorySamples() },
    writerOverflows: [],
    ...overrides,
  }
}

describe('P7.3 基线判读', () => {
  test('六条都成立才算「这份数据能当基线读」', () => {
    const report = buildP73Report(observations())
    expect(report.pass).toBe(true)
    expect(Object.values(report.checks).filter(Boolean)).toHaveLength(6)
  })

  test('空数据集不许长得像通过', () => {
    const report = buildP73Report(observations({ tiers: [] }))
    expect(report.checks.tiersObserved).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('没撞任何天花板又一条都没成功，才判 unclassified 并让整份数据不可读', () => {
    // 「没撞上限」与「没测到东西」在只看计数的报告里长得一模一样。
    const report = buildP73Report(
      observations({
        tiers: [
          tier({
            targetRate: 400,
            deliveredBySender: 0,
            deliveredByAudit: 0,
            latencySamples: 0,
            p95Ms: 0,
          }),
        ],
      }),
    )
    expect(report.tierReadings[0]?.verdict).toBe('unclassified')
    expect(report.checks.everyTierClassified).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('预算把一档撞穿到一条都没通过，判 budget 而不是 unclassified', () => {
    // 这一档是被解释过的——解释就是「撞上了预算」。先看延迟样本的顺序会把这条
    // 阶梯上信息量最大的一档判成「说不清」，并连累整份数据。
    const report = buildP73Report(
      observations({
        tiers: [
          tier({
            targetRate: 400,
            deliveredBySender: 0,
            deliveredByAudit: 0,
            latencySamples: 0,
            p95Ms: 0,
            rateLimited: 8_000,
          }),
        ],
      }),
    )
    expect(report.tierReadings[0]?.verdict).toBe('budget')
    expect(report.checks.everyTierClassified).toBe(true)
    expect(report.pass).toBe(true)
  })

  test('队列把一档撞穿到一条都没通过，同样判 queue', () => {
    const report = buildP73Report(
      observations({
        tiers: [
          tier({
            targetRate: 400,
            deliveredBySender: 0,
            deliveredByAudit: 0,
            latencySamples: 0,
            p95Ms: 0,
            outboxFull: 8_000,
          }),
        ],
      }),
    )
    expect(report.tierReadings[0]?.verdict).toBe('queue')
    expect(report.checks.everyTierClassified).toBe(true)
  })

  test('两个计数来源对不上，这一档的吞吐就不能引用', () => {
    const report = buildP73Report(
      observations({
        tiers: [
          tier({
            targetRate: 50,
            deliveredBySender: 6_000,
            deliveredByAudit: 4_100,
          }),
        ],
      }),
    )
    expect(report.tierReadings[0]?.sourceDelta).toBe(1_900)
    expect(report.checks.throughputSourcesAgree).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('单来源（T1 无审计）不因为「只有一个来源」被判红', () => {
    // T1 没有审计可数，如实记 null。缺少交叉核对要在报告里标明，不是判红的理由。
    const report = buildP73Report(
      observations({
        tiers: [tier({ config: 'T1', targetRate: 10, deliveredByAudit: null })],
      }),
    )
    expect(report.tierReadings[0]?.sourceDelta).toBeNull()
    expect(report.checks.throughputSourcesAgree).toBe(true)
  })

  test('内存采样断档要被标成区间，而不是无声跳过', () => {
    const samples: P73MemorySample[] = [
      { at: T0, role: 'resident', channel: 'proc' },
      // 中间少了三轮。
      { at: T0 + 4 * INTERVAL_MS, role: 'resident', channel: 'proc' },
    ]
    const report = buildP73Report(
      observations({ memory: { intervalMs: INTERVAL_MS, samples } }),
    )
    expect(report.memoryGaps).toHaveLength(1)
    expect(report.memoryGaps[0]).toMatchObject({
      role: 'resident',
      fromAt: T0,
      toAt: T0 + 4 * INTERVAL_MS,
      gapMs: 4 * INTERVAL_MS,
      expectedMs: INTERVAL_MS,
    })
    expect(report.checks.memorySamplesContinuous).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('断档按 role 各算各的：ACP 子进程重启不该算常驻进程断档', () => {
    const samples: P73MemorySample[] = [
      ...memorySamples(3, 'resident'),
      { at: T0, role: 'acp', channel: 'proc' },
      { at: T0 + INTERVAL_MS, role: 'acp', channel: 'proc' },
      { at: T0 + 2 * INTERVAL_MS, role: 'acp', channel: 'proc' },
    ]
    const report = buildP73Report(
      observations({ memory: { intervalMs: INTERVAL_MS, samples } }),
    )
    expect(report.memoryGaps).toHaveLength(0)
    expect(report.checks.memorySamplesContinuous).toBe(true)
  })

  test('通道降级（macOS 的 ps 兜底）判红——这份数据只能当仪器校准', () => {
    const report = buildP73Report(
      observations({
        memory: {
          intervalMs: INTERVAL_MS,
          samples: memorySamples().map(sample => ({
            ...sample,
            channel: 'ps',
          })),
        },
      }),
    )
    expect(report.degradedChannels).toEqual(['ps'])
    expect(report.checks.memoryChannelsIntact).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('一条 writer 溢出警告就让整个数据集不可用', () => {
    // 溢出之后缺了多少条无从得知，所以不是「少几条」，是「不知道少几条」。
    const report = buildP73Report(
      observations({
        writerOverflows: [{ writer: 'resident memory', at: T0 }],
      }),
    )
    expect(report.checks.writerOverflowFree).toBe(false)
    expect(report.pass).toBe(false)
  })
})

describe('档位判读', () => {
  test('RateLimited > 0 判为撞上入站预算', () => {
    const report = buildP73Report(
      observations({
        tiers: [tier({ targetRate: 100, rateLimited: 4_800 })],
      }),
    )
    expect(report.tierReadings[0]?.verdict).toBe('budget')
    // 撞设计值不是缺陷：这一条不参与 pass。
    expect(report.pass).toBe(true)
  })

  test('OutboxFullError > 0 判为撞上队列', () => {
    const report = buildP73Report(
      observations({ tiers: [tier({ targetRate: 400, outboxFull: 37 })] }),
    )
    expect(report.tierReadings[0]?.verdict).toBe('queue')
  })

  test('两者都撞上时两条都留痕，不靠优先级把一条盖掉', () => {
    const report = buildP73Report(
      observations({
        tiers: [tier({ targetRate: 400, rateLimited: 12, outboxFull: 5 })],
      }),
    )
    expect(report.tierReadings[0]?.verdict).toBe('budget-and-queue')
  })

  test('两者全 0 且 p95 涨得比档位快 → 记为拐点档位', () => {
    // 去重表全表扫描的 O(N) 成本显形时的样子：档位翻 4 倍，p95 翻了 10 倍。
    const report = buildP73Report(
      observations({
        tiers: [
          tier({ config: 'T1', targetRate: 25, p95Ms: 6 }),
          tier({ config: 'T1', targetRate: 100, p95Ms: 60 }),
        ],
      }),
    )
    expect(report.tierReadings[1]?.verdict).toBe('knee')
    expect(report.kneeAt).toEqual([{ config: 'T1', rate: 100 }])
    // 拐点是观测，不是门禁——N-12：记录它，不修它。
    expect(report.pass).toBe(true)
  })

  test('p95 涨幅不超过档位涨幅就是 linear，不记拐点', () => {
    const report = buildP73Report(
      observations({
        tiers: [
          tier({ config: 'T1', targetRate: 25, p95Ms: 6 }),
          tier({ config: 'T1', targetRate: 100, p95Ms: 20 }),
        ],
      }),
    )
    expect(report.tierReadings[1]?.verdict).toBe('linear')
    expect(report.kneeAt).toEqual([])
  })

  test('撞过天花板的档位不能当拐点基线', () => {
    // 被限流的那一档，p95 反映的是节流之后的负载。拿它当基线，下一档涨了多少
    // 都说明不了任何事——会凭空造出一个拐点。
    const report = buildP73Report(
      observations({
        tiers: [
          tier({ config: 'T2', targetRate: 25, p95Ms: 2, rateLimited: 300 }),
          tier({ config: 'T2', targetRate: 50, p95Ms: 90 }),
        ],
      }),
    )
    expect(report.tierReadings[0]?.verdict).toBe('budget')
    expect(report.tierReadings[1]?.verdict).toBe('linear')
    expect(report.kneeAt).toEqual([])
  })

  test('拐点只在同一条曲线内部比较，不跨配置比', () => {
    // T3 每条都 fsync，它的 p95 天然比 T1 高一个量级；拿 T1 的上一档去比 T3
    // 的这一档，会把「换了配置」记成「出现了拐点」。
    const report = buildP73Report(
      observations({
        tiers: [
          tier({ config: 'T1', targetRate: 25, p95Ms: 4 }),
          tier({ config: 'T3', targetRate: 50, p95Ms: 90 }),
        ],
      }),
    )
    expect(report.tierReadings[1]?.verdict).toBe('linear')
    expect(report.kneeAt).toEqual([])
  })

  test('同一配置出现多个拐点时取最低那一档', () => {
    const report = buildP73Report(
      observations({
        tiers: [
          tier({ config: 'T2', targetRate: 10, p95Ms: 5 }),
          tier({ config: 'T2', targetRate: 25, p95Ms: 40 }),
          tier({ config: 'T2', targetRate: 50, p95Ms: 400 }),
        ],
      }),
    )
    expect(report.kneeAt).toEqual([{ config: 'T2', rate: 25 }])
  })

  test('实测吞吐按发送端计数与档位时长算', () => {
    const report = buildP73Report(
      observations({
        tiers: [
          tier({ targetRate: 100, seconds: 20, deliveredBySender: 1_600 }),
        ],
      }),
    )
    expect(report.tierReadings[0]?.achievedRate).toBe(80)
  })
})
