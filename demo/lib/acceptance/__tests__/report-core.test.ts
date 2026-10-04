// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 验收套件判定层的回归护栏。
 *
 * 这些用例守的不是「场景通不通过」，而是**判定规则本身有没有被改松**。
 * 驱动那半边要起真进程，进不了单测分片；这半边进得去，所以「已知缺陷不改
 * 判定」「skip 不算通过」「零覆盖维度必须出现在报告里」这三条被钉在这里。
 */

import { describe, expect, test } from 'bun:test'
import {
  briefEvidence,
  coverageByDimension,
  fromNdjson,
  ndjsonScenarioLine,
  ndjsonStartLine,
  ndjsonSummaryLine,
  renderSummary,
  sameCommit,
  summarize,
  type SuiteMeta,
  testedCommitConsensus,
  testedCommitStamp,
  testedCommitVerdict,
} from '../report-core.js'
import type {
  Dimension,
  Outcome,
  ScenarioResult,
  TestedProvenance,
} from '../types.js'
import { DIMENSIONS } from '../types.js'

const META: SuiteMeta = {
  target: 'local',
  startedAt: '2026-08-24T00:00:00.000Z',
  finishedAt: '2026-08-24T00:01:30.000Z',
  commit: 'c4ed9d8f',
}

function result(
  over: Partial<ScenarioResult> & { id: string; outcome: Outcome },
): ScenarioResult {
  return {
    dimension: (over.id.split('/')[0] ?? 'handshake') as Dimension,
    title: over.id,
    target: 'local',
    durationMs: 10,
    expected: '期望',
    actual: '实际',
    evidence: [],
    requires: ['raw-dial'],
    // 缺省「碰过驱动」：这些用例守的是别的规则，不该每条都去想触达那一项。
    // 触达规则自己的用例显式传 `driverCalls: []`。
    driverCalls: ['startNode'],
    ...over,
  }
}

describe('summarize', () => {
  test('counts 每个 outcome 各自成列', () => {
    const run = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'handshake/b', outcome: 'fail' }),
        result({ id: 'policy/c', outcome: 'skip', skipReason: '缺能力' }),
        result({ id: 'policy/d', outcome: 'error' }),
      ],
      META,
    )
    expect(run.counts).toEqual({ pass: 1, fail: 1, skip: 1, error: 1 })
    expect(run.durationMs).toBe(90_000)
  })

  test('skip 不拉低判定，fail 与 error 会', () => {
    const onlySkips = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'policy/b', outcome: 'skip', skipReason: 'x' }),
      ],
      META,
    )
    expect(onlySkips.pass).toBe(true)

    const withFail = summarize(
      [result({ id: 'handshake/a', outcome: 'fail' })],
      META,
    )
    expect(withFail.pass).toBe(false)

    const withError = summarize(
      [result({ id: 'handshake/a', outcome: 'error' })],
      META,
    )
    expect(withError.pass).toBe(false)
  })

  // 这条是整个套件的存在理由：给红开豁免口子等于把套件删掉。
  test('knownIssue 不把 fail 洗成 pass', () => {
    const run = summarize(
      [
        result({
          id: 'multi-agent/workspace-isolation',
          outcome: 'fail',
          knownIssue: '#44',
        }),
      ],
      META,
    )
    expect(run.counts.fail).toBe(1)
    expect(run.counts.pass).toBe(0)
    expect(run.pass).toBe(false)
  })

  // ── 目标触达（issue #61 那次假绿的直接护栏）─────────────────────────────
  //
  // 真机腿曾经报 `pass=11 fail=0 skip=104` + exit 0 + 「判定: PASS」，而驱动
  // **一次都没被调用过** —— 那 11 条绿全部跑在开发机上。下面三条钉住的是
  // 「全绿」与「没跑」必须给出不同的判定。
  describe('目标触达', () => {
    test('一条场景都没碰过驱动时不算通过，哪怕全绿', () => {
      const run = summarize(
        [
          result({
            id: 'policy/both-flags-refused',
            outcome: 'pass',
            driverCalls: [],
          }),
          result({
            id: 'trust/no-execution-gate',
            outcome: 'pass',
            driverCalls: [],
          }),
          result({ id: 'handshake/psk-ok', outcome: 'skip', skipReason: 'x' }),
        ],
        { ...META, target: 'fleet' },
      )
      expect(run.counts).toEqual({ pass: 2, fail: 0, skip: 1, error: 0 })
      expect(run.targetTouches).toBe(0)
      expect(run.pass).toBe(false)
      expect(renderSummary(run)).toContain('等于什么都没验')
    })

    test('哪怕只有一条碰过驱动，判定就回到看 fail/error', () => {
      const run = summarize(
        [
          result({
            id: 'trust/no-execution-gate',
            outcome: 'pass',
            driverCalls: [],
          }),
          result({
            id: 'policy/both-flags-refused',
            outcome: 'pass',
            driverCalls: ['execHost', 'startNode'],
          }),
        ],
        { ...META, target: 'fleet' },
      )
      expect(run.targetTouches).toBe(1)
      expect(run.pass).toBe(true)
    })

    // skip 的场景不该被算成触达 —— 它压根没跑。
    test('skip 不计入触达', () => {
      const run = summarize(
        [
          result({
            id: 'handshake/psk-ok',
            outcome: 'skip',
            skipReason: '缺 spawn-node',
            driverCalls: ['startNode'],
          }),
        ],
        { ...META, target: 'fleet' },
      )
      expect(run.targetTouches).toBe(0)
      expect(run.pass).toBe(false)
    })
  })
})

describe('coverageByDimension', () => {
  test('零覆盖的维度也必须出现在表里', () => {
    const run = summarize(
      [result({ id: 'handshake/a', outcome: 'pass' })],
      META,
    )
    const cov = coverageByDimension(run)
    expect(cov.length).toBe(DIMENSIONS.length)
    const wake = cov.find(c => c.dimension === 'wake')
    expect(wake).toBeDefined()
    expect(wake?.total).toBe(0)
  })

  test('逐维度分列 pass/fail/skip/error', () => {
    const run = summarize(
      [
        result({ id: 'audit/a', outcome: 'pass' }),
        result({ id: 'audit/b', outcome: 'fail' }),
        result({ id: 'audit/c', outcome: 'skip', skipReason: 'x' }),
        result({ id: 'audit/d', outcome: 'error' }),
      ],
      META,
    )
    const audit = coverageByDimension(run).find(c => c.dimension === 'audit')
    expect(audit).toEqual({
      dimension: 'audit',
      total: 4,
      pass: 1,
      fail: 1,
      skip: 1,
      error: 1,
    })
  })
})

describe('NDJSON 往返', () => {
  test('首行 start + 每个场景一行 + 末行 summary', () => {
    const run = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'policy/b', outcome: 'fail' }),
      ],
      META,
    )
    const lines = toNdjsonLines(run)
    expect(lines.length).toBe(4)
    const start = JSON.parse(lines[0] ?? '')
    expect(start.kind).toBe('start')
    // 被打断的文件只有首行这些字段可读 —— target / startedAt 以前只存在于
    // summary 行里，于是半份产物连「这是哪条腿」都答不出来。
    expect(start.target).toBe('local')
    expect(start.startedAt).toBe(META.startedAt)
    expect(start.commit).toBe('c4ed9d8f')
    expect(start.planned).toBe(2)
    expect(JSON.parse(lines[1] ?? '').kind).toBe('scenario')
    expect(JSON.parse(lines[2] ?? '').kind).toBe('scenario')
    const summary = JSON.parse(lines[3] ?? '')
    expect(summary.kind).toBe('summary')
    expect(summary.pass).toBe(false)
    expect(Array.isArray(summary.coverage)).toBe(true)
  })

  test('流式拼出来的一份与 toNdjson 逐字节相同', () => {
    // 真跑走的是「首行 → 每条追加 → 末行」，`toNdjson` 只有单测和一次性
    // 渲染在用。两条路各写各的格式是这类产物最典型的漂移，这里钉住。
    const results = [
      result({ id: 'handshake/a', outcome: 'pass' }),
      result({ id: 'policy/b', outcome: 'fail' }),
    ]
    const run = summarize(results, META)
    const streamed =
      `${ndjsonStartLine({
        target: run.target,
        startedAt: run.startedAt,
        commit: run.commit,
        planned: results.length,
      })}\n` +
      `${results.map(r => `${ndjsonScenarioLine(r)}\n`).join('')}` +
      `${ndjsonSummaryLine(run)}\n`
    expect(streamed).toBe(renderNdjson(run))
  })

  test('被打断的一份：有 start 无 summary，读得出跑到哪、也读得出没跑完', () => {
    const run = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'policy/b', outcome: 'pass' }),
      ],
      META,
    )
    // 计划 115 条，写到第 2 条被杀 —— 正是 issue #85 里那个现场的形状。
    const partial =
      `${ndjsonStartLine({
        target: run.target,
        startedAt: run.startedAt,
        commit: run.commit,
        planned: 115,
      })}\n` + run.results.map(r => `${ndjsonScenarioLine(r)}\n`).join('')

    const lines = partial.trimEnd().split('\n')
    // ① 末行不是 summary → 这一轮没跑完。CI 那道护栏与人都按这条读。
    expect(JSON.parse(lines.at(-1) ?? '').kind).not.toBe('summary')
    // ② 首行还在，于是「计划多少 / 跑了多少 / 哪条腿」都答得出来。
    const start = JSON.parse(lines[0] ?? '')
    expect(start.planned).toBe(115)
    expect(start.target).toBe('local')
    expect(lines.filter(l => JSON.parse(l).kind === 'scenario').length).toBe(2)
    // ③ 前面那些结果是真留下来了 —— 修复要的就是这一条。
    expect(JSON.parse(lines[1] ?? '').id).toBe('handshake/a')
    // ④ 而程序化反解**不会**拿半份编一个 SuiteRun 出来：那两条全绿，
    //    `summarize` 一下会得出 pass=true，恰好是最坏的那种静默。
    expect(fromNdjson(partial)).toBeUndefined()
  })

  test('fromNdjson 还原判定与逐条结果', () => {
    const run = summarize(
      [
        result({
          id: 'delivery/unknown-agent',
          outcome: 'fail',
          evidence: [{ label: 'code', value: 'E_UNKNOWN_AGENT' }],
        }),
      ],
      META,
    )
    const back = fromNdjson(renderNdjson(run))
    expect(back).toBeDefined()
    expect(back?.pass).toBe(false)
    expect(back?.results.length).toBe(1)
    expect(back?.results[0]?.evidence[0]?.value).toBe('E_UNKNOWN_AGENT')
    expect(back?.commit).toBe('c4ed9d8f')
  })

  test('混进噪声行不丢结果', () => {
    const run = summarize([result({ id: 'audit/a', outcome: 'pass' })], META)
    const dirty = `噪声一行\n${renderNdjson(run)}{ 不是 JSON\n`
    const back = fromNdjson(dirty)
    expect(back?.results.length).toBe(1)
  })

  test('没有 summary 行时返回 undefined，而不是编一个出来', () => {
    expect(fromNdjson('{"kind":"scenario","id":"a"}\n')).toBeUndefined()
    expect(fromNdjson('')).toBeUndefined()
  })
})

describe('renderSummary', () => {
  test('红的行展开期望/实际/全部证据；绿的行不展开', () => {
    const run = summarize(
      [
        result({ id: 'handshake/ok', outcome: 'pass', title: '正常握手' }),
        result({
          id: 'handshake/bad-psk',
          outcome: 'fail',
          title: '错 PSK',
          expected: 'close 4003',
          actual: 'close 1000',
          evidence: [
            { label: 'closeCode', value: '1000' },
            { label: 'closeReason', value: 'normal' },
          ],
        }),
      ],
      META,
    )
    const text = renderSummary(run)
    expect(text).toContain('PASS  handshake/ok')
    expect(text).toContain('FAIL  handshake/bad-psk')
    expect(text).toContain('期望: close 4003')
    expect(text).toContain('实际: close 1000')
    expect(text).toContain('closeCode: 1000')
    expect(text).toContain('closeReason: normal')
    // 绿的那条不该把 expected 也铺开——那样表就没法看了。
    expect(text).not.toContain('期望: 期望')
    expect(text).toContain('判定: FAIL')
  })

  test('skip 行给出原因', () => {
    const run = summarize(
      [
        result({
          id: 'launcher/beta-up',
          outcome: 'skip',
          skipReason: '驱动 fleet 缺少能力: run-launcher',
        }),
      ],
      META,
    )
    expect(renderSummary(run)).toContain('skip: 驱动 fleet 缺少能力')
  })

  test('已知缺陷标注出来，但判定仍是 FAIL', () => {
    const run = summarize(
      [
        result({
          id: 'multi-agent/workspace-isolation',
          outcome: 'fail',
          knownIssue: '#44',
        }),
      ],
      META,
    )
    const text = renderSummary(run)
    expect(text).toContain('[#44]')
    expect(text).toContain('已记录缺陷（仍按失败计）')
    expect(text).toContain('判定: FAIL')
  })

  test('零覆盖维度被点名', () => {
    const run = summarize([result({ id: 'audit/a', outcome: 'pass' })], META)
    expect(renderSummary(run)).toContain('← 本轮零覆盖')
  })
})

// ---------------------------------------------------------------------------
// 被测端来源 commit（issue #70 ③）
//
// 这一组守的是一句话：**报告盖的必须是被测端报上来的那个 commit**，而不是跑
// 套件那台机器的 HEAD。四条规矩逐条钉在下面 —— 被测端的值要记、与本地不一致
// 时两个都要记、拿不到时写「未知」而不是回退、`target=local` 一字不改。
// ---------------------------------------------------------------------------

/** 舰队上真实的那一版（2026-08-25 四节点 + 控制台实测值）。 */
const FLEET_SHA = 'fa80e006f18a931cb6386b99a7d5e6503991e2a9'

const FLEET_META: SuiteMeta = {
  target: 'fleet',
  startedAt: '2026-08-25T00:00:00.000Z',
  finishedAt: '2026-08-25T00:01:30.000Z',
  // 套件那侧是短 SHA（`git rev-parse --short`），被测端报的是 40 位全 SHA。
  // 两种拼写共存是这条特性的常态，不是待统一的瑕疵。
  commit: 'c4ed9d8f',
}

function provenance(
  units: readonly { unit: string; commit?: string; detail?: string }[],
): TestedProvenance {
  return {
    units: units.map(u => ({
      unit: u.unit,
      ...(u.commit === undefined ? {} : { commit: u.commit }),
      detail: u.detail ?? '',
    })),
  }
}

const ALL_AGREE = provenance([
  { unit: 'beta-1', commit: FLEET_SHA },
  { unit: 'beta-2', commit: FLEET_SHA },
  { unit: 'beta-3', commit: FLEET_SHA },
  { unit: 'beta-4', commit: FLEET_SHA },
  { unit: 'console (workbench-iap)', commit: FLEET_SHA },
])

describe('testedCommitConsensus', () => {
  test('全体一致才给出一个值', () => {
    expect(testedCommitConsensus(ALL_AGREE)).toBe(FLEET_SHA)
  })

  test('有一台停在别的版本上就没有共识 —— 不许挑一个当答案', () => {
    const mixed = provenance([
      { unit: 'beta-1', commit: FLEET_SHA },
      { unit: 'beta-2', commit: 'b'.repeat(40) },
    ])
    expect(testedCommitConsensus(mixed)).toBeUndefined()
  })

  test('有一台报不上来就没有共识（剩下几台一致也不算）', () => {
    const partial = provenance([
      { unit: 'beta-1', commit: FLEET_SHA },
      { unit: 'beta-2', detail: '读不到启动日志' },
    ])
    expect(testedCommitConsensus(partial)).toBeUndefined()
  })

  test('一个都没问到 / 根本没探针 → undefined', () => {
    expect(testedCommitConsensus(provenance([]))).toBeUndefined()
    expect(testedCommitConsensus(undefined)).toBeUndefined()
  })
})

describe('sameCommit', () => {
  test('短 SHA 与全 SHA 按前缀算同一个', () => {
    expect(sameCommit('fa80e006', FLEET_SHA)).toBe(true)
    expect(sameCommit(FLEET_SHA, 'fa80e006')).toBe(true)
  })

  test('前缀不够长不作数', () => {
    expect(sameCommit('fa80e0', FLEET_SHA)).toBe(false)
  })

  test('带 -dirty 的一律判不同 —— 有未提交内容的树不等于它的 HEAD', () => {
    expect(sameCommit(`${FLEET_SHA}-dirty`, FLEET_SHA)).toBe(false)
    expect(sameCommit('fa80e006', `${FLEET_SHA}-dirty`)).toBe(false)
  })

  test('任一侧缺失就是不同', () => {
    expect(sameCommit(undefined, FLEET_SHA)).toBe(false)
    expect(sameCommit(FLEET_SHA, undefined)).toBe(false)
  })
})

describe('被测端来源 commit 进产物', () => {
  test('target=local 的两行逐字节不变 —— 那条腿被测的就是本检出', () => {
    const run = summarize(
      [result({ id: 'handshake/a', outcome: 'pass' })],
      META,
    )
    const lines = toNdjsonLines(run)
    const start = JSON.parse(lines[0] ?? '')
    const summary = JSON.parse(lines[lines.length - 1] ?? '')
    // 两个键**根本不出现**，不是出现一个 null：本地腿的产物与这条特性之前
    // 一模一样，读它的工具（CI 那道防假绿护栏）不需要知道这件事存在。
    expect('testedCommit' in start).toBe(false)
    expect('testedUnits' in start).toBe(false)
    expect('testedCommit' in summary).toBe(false)
    expect('testedUnits' in summary).toBe(false)
    expect(renderSummary(run)).toContain('· c4ed9d8f')
    expect(renderSummary(run)).not.toContain('被测端')
  })

  test('首行就带被测端的值 —— 被打断的一轮只剩那一行', () => {
    const run = summarize([result({ id: 'handshake/a', outcome: 'pass' })], {
      ...FLEET_META,
      testedProvenance: ALL_AGREE,
    })
    const start = JSON.parse(toNdjsonLines(run)[0] ?? '')
    expect(start.testedCommit).toBe(FLEET_SHA)
    expect(start.testedUnits).toHaveLength(5)
    // 套件那侧的值仍在原位：两个问题，两个字段。
    expect(start.commit).toBe('c4ed9d8f')
  })

  test('末行同样带，且逐个被测端的原文都在', () => {
    const run = summarize([result({ id: 'handshake/a', outcome: 'pass' })], {
      ...FLEET_META,
      testedProvenance: ALL_AGREE,
    })
    const lines = toNdjsonLines(run)
    const summary = JSON.parse(lines[lines.length - 1] ?? '')
    expect(summary.testedCommit).toBe(FLEET_SHA)
    expect(summary.commit).toBe('c4ed9d8f')
    expect(summary.testedUnits[0].unit).toBe('beta-1')
    // CI 那道防假绿护栏读的三项不能被挤掉。
    expect(summary.counts).toBeDefined()
    expect(summary.targetTouches).toBe(1)
    expect(summary.pass).toBe(true)
  })

  test('流式拼出来的与 toNdjson 仍逐字节相同（带被测端字段）', () => {
    const results = [result({ id: 'handshake/a', outcome: 'pass' })]
    const run = summarize(results, {
      ...FLEET_META,
      testedProvenance: ALL_AGREE,
    })
    const streamed =
      `${ndjsonStartLine({
        target: run.target,
        startedAt: run.startedAt,
        commit: run.commit,
        testedProvenance: run.testedProvenance,
        planned: results.length,
      })}\n` +
      `${results.map(r => `${ndjsonScenarioLine(r)}\n`).join('')}` +
      `${ndjsonSummaryLine(run)}\n`
    expect(streamed).toBe(renderNdjson(run))
  })

  test('fromNdjson 把逐个被测端的观察原样带回来', () => {
    const run = summarize([result({ id: 'handshake/a', outcome: 'pass' })], {
      ...FLEET_META,
      testedProvenance: provenance([
        { unit: 'beta-1', commit: FLEET_SHA, detail: '读自 cornna-p2 上的 …' },
        { unit: 'beta-4', detail: '读不到该节点的启动日志' },
      ]),
    })
    const back = fromNdjson(renderNdjson(run))
    expect(back?.testedProvenance?.units).toEqual([
      { unit: 'beta-1', commit: FLEET_SHA, detail: '读自 cornna-p2 上的 …' },
      { unit: 'beta-4', detail: '读不到该节点的启动日志' },
    ])
    expect(testedCommitConsensus(back?.testedProvenance)).toBeUndefined()
  })
})

describe('renderSummary 的被测端来源那一段', () => {
  function render(p: TestedProvenance): string {
    return renderSummary(
      summarize([result({ id: 'handshake/a', outcome: 'pass' })], {
        ...FLEET_META,
        testedProvenance: p,
      }),
    )
  }

  test('两个值都印，并且点名它们不是同一版', () => {
    const text = render(ALL_AGREE)
    expect(text).toContain(`· 套件 c4ed9d8f · 被测端 ${FLEET_SHA}`)
    expect(text).toContain(`beta-1`)
    expect(text).toContain(FLEET_SHA)
    // 「套件是哪版」那一行不能因为多了被测端就消失。
    expect(text).toContain('套件所在检出')
    expect(text).toContain('不是同一版')
  })

  test('两边指同一个提交时不喊「不是同一版」', () => {
    const text = renderSummary(
      summarize([result({ id: 'handshake/a', outcome: 'pass' })], {
        ...FLEET_META,
        commit: FLEET_SHA.slice(0, 8),
        testedProvenance: ALL_AGREE,
      }),
    )
    expect(text).not.toContain('不是同一版')
  })

  test('拿不到就写「未知」，绝不回退成套件那侧的 HEAD', () => {
    const text = render(
      provenance([
        { unit: 'beta-1', detail: '读不到该节点的启动日志' },
        {
          unit: 'beta-2',
          detail:
            '它自己报的就是 sourceCommit=unknown —— 那份产物构建时没能确定来源',
        },
      ]),
    )
    expect(text).toContain('· 被测端 未知')
    expect(text).toContain('beta-1')
    expect(text).toContain('读不到该节点的启动日志')
    // 关键的一条：那一栏里不许出现套件那侧的值。
    const provenanceBlock = text.slice(
      text.indexOf('被测端来源 commit'),
      text.indexOf('PASS  handshake/a'),
    )
    expect(provenanceBlock).not.toContain('c4ed9d8f  ←')
    // 「一台都没答上」不许说成「大家报的不一样」（issue #96 ②）。
    expect(text).toContain('一个都没答上')
    expect(text).toContain('不是「报的不一致」')
  })

  test('一个被测端都没问到时也说清楚，而不是静默留白', () => {
    expect(render(provenance([]))).toContain('（一个被测端都没问到）')
  })

  test('四台停在两个版本上时，五行各自的值都在，而且说的是「真的不一致」', () => {
    const other = 'b'.repeat(40)
    const text = render(
      provenance([
        { unit: 'beta-1', commit: FLEET_SHA },
        { unit: 'beta-2', commit: other },
      ]),
    )
    expect(text).toContain(FLEET_SHA)
    expect(text).toContain(other)
    expect(text).toContain('· 被测端 不一致')
    expect(text).toContain('真的不一致')
    // 这一句是「有台没答上」专用的，不许漏到这里来。
    expect(text).not.toContain('没有任何一台报了别的 commit')
  })

  // -------------------------------------------------------------------------
  // issue #96 ②：「4 台一致 + 1 台不可达」与「4 台里有 2 个 SHA」必须长得不一样。
  //
  // 那一轮的现场：5 台里 4 台一致报 fa80e006…、beta-2 一次 SSH 抖动，报告首栏
  // 写成「被测端 未知」—— 读起来像「大家报的不一样」，而实际没有任何一台报了
  // 别的 SHA。
  // -------------------------------------------------------------------------

  const FOUR_OF_FIVE = provenance([
    { unit: 'beta-1', commit: FLEET_SHA },
    {
      unit: 'beta-2',
      detail: 'SSH 链路失败 (255，对端关闭了连接，已重发 2 次)',
    },
    { unit: 'beta-3', commit: FLEET_SHA },
    { unit: 'beta-4', commit: FLEET_SHA },
    { unit: 'console (workbench-iap)', commit: FLEET_SHA },
  ])

  test('4/5 一致 + 1 台未答：首栏点名是「谁没答上」，不是「大家不一致」', () => {
    const text = render(FOUR_OF_FIVE)
    expect(text).toContain(`· 被测端 4/5 一致为 ${FLEET_SHA}（beta-2 未答）`)
    expect(text).toContain('没有任何一台报了别的 commit')
    expect(text).not.toContain('真的不一致')
    // 但仍然不给一个统一标量 —— 不从 4/5 编共识（#94 的设计不变）。
    expect(testedCommitConsensus(FOUR_OF_FIVE)).toBeUndefined()
  })

  test('两种措辞不共用一个字：不一致那句里没有「未答」，反之亦然', () => {
    const partial = render(FOUR_OF_FIVE)
    const divergent = render(
      provenance([
        { unit: 'beta-1', commit: FLEET_SHA },
        { unit: 'beta-2', commit: 'b'.repeat(40) },
      ]),
    )
    expect(partial.includes('未答')).toBe(true)
    expect(divergent.includes('未答')).toBe(false)
    expect(divergent.includes('不同的 commit')).toBe(true)
    expect(partial.includes('不同的 commit')).toBe(false)
  })
})

describe('testedCommitVerdict（issue #96 ②）', () => {
  test('全体一致 → unanimous，并且是唯一给出标量的那种', () => {
    const v = testedCommitVerdict(ALL_AGREE)
    expect(v.kind).toBe('unanimous')
    expect(testedCommitConsensus(ALL_AGREE)).toBe(FLEET_SHA)
  })

  test('答上的全一致但有单位没答上 → partial，并点名是谁', () => {
    const v = testedCommitVerdict(
      provenance([
        { unit: 'beta-1', commit: FLEET_SHA },
        { unit: 'beta-2', detail: 'SSH 链路失败 (255)' },
      ]),
    )
    expect(v).toEqual({
      kind: 'partial',
      commit: FLEET_SHA,
      answered: 1,
      total: 2,
      silent: ['beta-2'],
    })
  })

  test('答上的里面有两个值 → divergent（哪怕还有台没答上）', () => {
    const v = testedCommitVerdict(
      provenance([
        { unit: 'beta-1', commit: FLEET_SHA },
        { unit: 'beta-2', commit: 'b'.repeat(40) },
        { unit: 'beta-3', detail: '读不到启动日志' },
      ]),
    )
    expect(v.kind).toBe('divergent')
    expect(v.kind === 'divergent' && v.commits.length).toBe(2)
    expect(v.kind === 'divergent' && v.silent).toEqual(['beta-3'])
  })

  test('一台都没答上 → silent；根本没探针 → absent', () => {
    expect(
      testedCommitVerdict(provenance([{ unit: 'beta-1', detail: 'x' }])).kind,
    ).toBe('silent')
    expect(testedCommitVerdict(provenance([])).kind).toBe('absent')
    expect(testedCommitVerdict(undefined).kind).toBe('absent')
  })

  test('未答的单位超过三个只点名三个，剩下记个数', () => {
    const many = provenance([
      { unit: 'beta-1', commit: FLEET_SHA },
      { unit: 'a', detail: 'x' },
      { unit: 'b', detail: 'x' },
      { unit: 'c', detail: 'x' },
      { unit: 'd', detail: 'x' },
    ])
    expect(testedCommitStamp(many)).toContain('a、b、c 等 4 个 未答')
  })
})

describe('briefEvidence', () => {
  test('空证据给空串', () => {
    expect(briefEvidence([])).toBe('')
  })

  test('超长只在渲染层截断并标注剩余条数', () => {
    const long = 'x'.repeat(300)
    const brief = briefEvidence(
      [
        { label: 'body', value: long },
        { label: 'b', value: '2' },
        { label: 'c', value: '3' },
      ],
      50,
    )
    expect(brief.startsWith('body=')).toBe(true)
    expect(brief).toContain('…')
    expect(brief).toContain('(+2)')
  })

  test('换行压平，便于放进一行表格', () => {
    expect(briefEvidence([{ label: 'l', value: 'a\n b\tc' }])).toBe('l=a b c')
  })
})

// --- 本地小工具：把 toNdjson 的输出拆行，避免每个用例重复 split -------------

import { toNdjson as renderNdjson } from '../report-core.js'

function toNdjsonLines(run: Parameters<typeof renderNdjson>[0]): string[] {
  return renderNdjson(run).trimEnd().split('\n')
}
