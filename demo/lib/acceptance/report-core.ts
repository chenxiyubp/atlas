// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌端到端验收套件 —— 纯判定与渲染层。
 *
 * 这里**不碰进程、不碰网络、不碰文件系统**，只把一堆
 * {@link ScenarioResult} 折成 {@link SuiteRun} 再渲染成两种形态：
 *
 *   ① 机器可读：NDJSON，一行一个场景，最后一行是 `{"kind":"summary",…}`；
 *   ② 人可读：汇总表，一行一个场景 + 判定 + 红的时候带证据摘要。
 *
 * 与 `demo/lib/*-report-core.ts` 同一套路：判定逻辑单独成文件才测得动。
 * 驱动那半边要起真进程，进不了单测分片；这半边进得去，于是「判定规则本身
 * 有没有被改松」是有回归护栏的。
 *
 * 一条硬规则：**`knownIssue` 不改变判定。** 挂了缺陷编号的场景仍然按 `fail`
 * 计入 `counts` 与 `pass`，只是渲染时多一列标注。套件的用处就是把红的抓出来，
 * 给红的开豁免口子等于把用处删掉。
 */

import type {
  Dimension,
  Evidence,
  Outcome,
  ScenarioResult,
  SuiteRun,
  Target,
  TestedProvenance,
  TestedUnitProvenance,
} from './types.js'
import { DIMENSIONS } from './types.js'

const OUTCOMES: readonly Outcome[] = ['pass', 'fail', 'skip', 'error']

/** 汇总元信息（时间、目标、提交）。 */
export interface SuiteMeta {
  readonly target: Target
  readonly startedAt: string
  readonly finishedAt: string
  /** **跑套件那台机器**的检出提交。见 {@link SuiteMeta.testedProvenance}。 */
  readonly commit?: string
  /**
   * **被测端自报的**来源 commit。`target=local` 上是 `undefined`。
   *
   * 与 `commit` 分成两个字段而不是「fleet 时把 commit 换掉」：读报告的人要能
   * 分别回答「套件是哪版」和「被测的是哪版」，而那正是 issue #70 的全部内容。
   */
  readonly testedProvenance?: TestedProvenance
}

/** 把逐场景结果折成一轮运行。 */
export function summarize(
  results: readonly ScenarioResult[],
  meta: SuiteMeta,
): SuiteRun {
  const counts: Record<Outcome, number> = {
    pass: 0,
    fail: 0,
    skip: 0,
    error: 0,
  }
  for (const r of results) counts[r.outcome] += 1

  const started = Date.parse(meta.startedAt)
  const finished = Date.parse(meta.finishedAt)

  // 「真正触达目标」= 已执行（非 skip）且至少调用过一次驱动。
  // skip 不算：它本来就没跑。`read-repo-source` 那类静态断言也不算：它们读的
  // 是 runner 上的仓库源码，两条腿按设计本就相同，证明不了目标的任何事。
  const targetTouches = results.filter(
    r => r.outcome !== 'skip' && r.driverCalls.length > 0,
  ).length

  return {
    target: meta.target,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    durationMs:
      Number.isFinite(started) && Number.isFinite(finished)
        ? finished - started
        : 0,
    results,
    counts,
    targetTouches,
    // skip 不参与判定：一个能力在本目标上不存在，不是被测系统的失败。
    // 但它也不是通过 —— 覆盖率那张表会把它单列出来。
    //
    // `targetTouches > 0` 是 issue #61 之后加的第三项，它挡的不是「系统答错
    // 了」而是「这一轮根本没问过系统」：真机腿曾经在驱动零调用的情况下报出
    // exit 0 + 「判定: PASS」，而那 11 条绿全部跑在开发机上。全绿与没跑必须
    // 给出不同的退出码，否则修好之后的任何一次退化都会以同样的形态回来。
    pass: counts.fail === 0 && counts.error === 0 && targetTouches > 0,
    commit: meta.commit,
    testedProvenance: meta.testedProvenance,
  }
}

/**
 * 「被测端是哪一版」的完整结论 —— 五种，各说各的话（issue #96 ②）。
 *
 * 此前只有 `testedCommitConsensus` 一个函数，它把**四种**结局折成同一个
 * `undefined`，于是首栏一律写「被测端 未知」。实测后果：5 台里 4 台一致报
 * `fa80e006…`、1 台传输抖动，报告写成「被测端 未知」—— 读起来像「大家报的不
 * 一样」，而实际**没有任何一台报了别的 SHA**。
 *
 * 「4 台一致 + 1 台不可达」和「4 台里有 2 个不同 SHA」是完全不同的两件事，
 * 前者只缺一次重试，后者是舰队真的滚更新滚了一半。
 *
 * **五种里没有一种会从 4/5 编出共识**（`testedCommit` 那个标量仍然只在
 * `unanimous` 时出现），也没有一种会退回 runner 的 HEAD。变的只是措辞。
 */
export type TestedCommitVerdict =
  /** 根本没有探针（本地腿）。 */
  | { readonly kind: 'absent' }
  /** 有被测端，但一个都没答上。 */
  | {
      readonly kind: 'silent'
      readonly total: number
      readonly silent: readonly string[]
    }
  /** 全体答上且完全一致 —— 唯一给出标量的那种。 */
  | {
      readonly kind: 'unanimous'
      readonly commit: string
      readonly total: number
    }
  /** 答上的全一致，但有单位没答上。 */
  | {
      readonly kind: 'partial'
      readonly commit: string
      readonly answered: number
      readonly total: number
      readonly silent: readonly string[]
    }
  /** 答上的里面有不同的 commit。 */
  | {
      readonly kind: 'divergent'
      readonly commits: readonly string[]
      readonly answered: number
      readonly total: number
      readonly silent: readonly string[]
    }

/** 把逐台观察折成一条结论。见 {@link TestedCommitVerdict}。 */
export function testedCommitVerdict(
  provenance: TestedProvenance | undefined,
): TestedCommitVerdict {
  if (provenance === undefined || provenance.units.length === 0) {
    return { kind: 'absent' }
  }
  const total = provenance.units.length
  const silent = provenance.units
    .filter(u => u.commit === undefined)
    .map(u => u.unit)
  const answered = provenance.units.filter(u => u.commit !== undefined)
  if (answered.length === 0) return { kind: 'silent', total, silent }
  const commits = [...new Set(answered.map(u => u.commit as string))]
  const first = commits[0] as string
  if (commits.length > 1) {
    return {
      kind: 'divergent',
      commits,
      answered: answered.length,
      total,
      silent,
    }
  }
  if (silent.length === 0) return { kind: 'unanimous', commit: first, total }
  return {
    kind: 'partial',
    commit: first,
    answered: answered.length,
    total,
    silent,
  }
}

/**
 * 「被测端是哪一版」的**单一**答案 —— 只有全部被测端都报上来且完全一致时才有。
 *
 * 不一致时返回 `undefined` 而不是挑一个：舰队是一台一台滚更新的，四台节点停在
 * 两个 commit 上完全可能，而那恰恰是最该被看见的事实。一个都没问到时同样是
 * `undefined`。**这个函数的语义一个字没变** —— NDJSON 的 `testedCommit` 是给
 * `jq` 一把取的标量，它必须继续只在「全体一致」时出现。四种 `undefined` 之间
 * 的区别现在由 {@link testedCommitVerdict} 说，渲染层问它。
 */
export function testedCommitConsensus(
  provenance: TestedProvenance | undefined,
): string | undefined {
  const verdict = testedCommitVerdict(provenance)
  return verdict.kind === 'unanimous' ? verdict.commit : undefined
}

/** 单位名列表：最多点名三个，剩下的记个数。 */
function nameList(units: readonly string[]): string {
  if (units.length <= 3) return units.join('、')
  return `${units.slice(0, 3).join('、')} 等 ${units.length} 个`
}

/**
 * 首栏那一句「被测端 …」。
 *
 * 短，因为它和 target / 时长 / 套件 commit 挤在同一行；但**必须让人一眼分得清
 * 「有台没答上」和「大家报的不一样」**，那正是这条缺陷（issue #96 ②）。逐台原文
 * 在下面的来源段里，这一句只给结论。
 */
export function testedCommitStamp(
  provenance: TestedProvenance | undefined,
): string {
  const verdict = testedCommitVerdict(provenance)
  switch (verdict.kind) {
    case 'unanimous':
      return verdict.commit
    case 'partial':
      return (
        `${verdict.answered}/${verdict.total} 一致为 ${verdict.commit}` +
        `（${nameList(verdict.silent)} 未答）`
      )
    case 'divergent':
      return (
        `不一致 —— ${verdict.answered}/${verdict.total} 个被测端报了 ` +
        `${verdict.commits.length} 个不同的 commit` +
        (verdict.silent.length === 0
          ? ''
          : `，另有 ${nameList(verdict.silent)} 未答`)
      )
    case 'silent':
      return `未知（${verdict.total} 个被测端一个都没答上）`
    default:
      return '未知'
  }
}

/**
 * 两个值指不指同一个提交。
 *
 * 三条：短 SHA 与全 SHA **按前缀比**（套件那侧记的是 `--short`，被测端报的是
 * 40 位全 SHA，直接 `===` 会把每一轮都判成不一致）；少于 7 位不作数；任一侧带
 * `-dirty` 一律判不同 —— 一棵有未提交内容的树不等于它的 HEAD，那正是要报出来
 * 的差异。
 */
export function sameCommit(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (a === undefined || b === undefined) return false
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (left.endsWith('-dirty') || right.endsWith('-dirty')) return false
  const [short, long] =
    left.length <= right.length ? [left, right] : [right, left]
  return short.length >= 7 && long.startsWith(short)
}

/** 单维度的覆盖情况。 */
export interface DimensionCoverage {
  readonly dimension: Dimension
  readonly total: number
  readonly pass: number
  readonly fail: number
  readonly skip: number
  readonly error: number
}

/**
 * 按维度统计。
 *
 * 维度全表来自 {@link DIMENSIONS} 而不是结果里出现过的那些 —— 一个维度一条
 * 场景都没跑出来时，它必须以 `total: 0` 的形态出现在报告里。只统计「跑过的」
 * 就永远看不见整片没覆盖的地方，而那正是最该看见的。
 */
export function coverageByDimension(
  run: SuiteRun,
): readonly DimensionCoverage[] {
  return DIMENSIONS.map(dimension => {
    const rows = run.results.filter(r => r.dimension === dimension)
    return {
      dimension,
      total: rows.length,
      pass: rows.filter(r => r.outcome === 'pass').length,
      fail: rows.filter(r => r.outcome === 'fail').length,
      skip: rows.filter(r => r.outcome === 'skip').length,
      error: rows.filter(r => r.outcome === 'error').length,
    }
  })
}

/**
 * NDJSON 的三种行，以及「这份文件跑完了没有」怎么读出来。
 *
 * 一份完整的产物长这样：
 *
 * ```
 * {"kind":"start",   …}   ← 第一行，开跑就落盘
 * {"kind":"scenario",…}   ← 一条一行，出一条写一行
 * …
 * {"kind":"summary", …}   ← 最后一行，跑完才落盘
 * ```
 *
 * **为什么要有 `start` 这一行。** 结果是流式落盘的（见
 * `scripts/qianmo-acceptance.ts`），于是被打断的一轮会留下一份**没有末行**的
 * 文件 —— 那是好事（issue #85：以前是零产物），但「缺末行」本身不能是唯一的
 * 信号：读的人拿到一份没有 summary 的文件，分不出「跑了一半被杀」「一条都没
 * 跑起来」「文件被截断了」，也拿不到 target / startedAt（那两个字段以前只存在
 * 于 summary 行里）。首行把这些先写下来，于是判据是**正向**的：
 *
 * | 文件形态 | 结论 |
 * | --- | --- |
 * | 不存在 / 空 | 这一轮没开始 |
 * | 有 `start` 无 `summary` | **跑到一半被打断**；`start.planned` 与 scenario 行数之差就是没跑的条数 |
 * | 末行是 `summary` | 跑完了，判定看 `summary.pass` |
 *
 * 程序化的同一条判据是 {@link fromNdjson}：没有 summary 行就返回 `undefined`，
 * 绝不拿半份结果编一个 `SuiteRun` 出来。命令行侧是
 * `tail -n 1 … | jq -e '.kind == "summary"'`，CI 那道防假绿护栏就是这么读的。
 */
export function ndjsonStartLine(start: {
  readonly target: Target
  readonly startedAt: string
  readonly commit?: string
  /**
   * 被测端自报的来源 commit（issue #70 ③）。
   *
   * **它在首行，不只在末行**，理由和这一整行存在的理由是同一条：被打断的产物
   * 只剩首行，而「刚才那一轮测的是哪一版」恰恰是排查一次被打断的跑时最先要问
   * 的。等到末行才写，就等于只有跑完的那些轮才答得出来。
   *
   * 顺带一条：`local` 上它是 `undefined`，于是这两个键根本不出现在行里 ——
   * 本地腿的产物逐字节不变。
   */
  readonly testedProvenance?: TestedProvenance
  /** 本轮计划跑多少条（`--only` 过滤之后）。 */
  readonly planned: number
}): string {
  return JSON.stringify({
    kind: 'start',
    target: start.target,
    startedAt: start.startedAt,
    commit: start.commit,
    testedCommit: testedCommitConsensus(start.testedProvenance),
    testedUnits: start.testedProvenance?.units,
    planned: start.planned,
  })
}

/** 一条场景结果的一行。见 {@link ndjsonStartLine} 的表。 */
export function ndjsonScenarioLine(result: ScenarioResult): string {
  return JSON.stringify({ kind: 'scenario', ...result })
}

/** 末行汇总。**只有跑完了才写**，所以它的存在就是「这一轮完整」的判据。 */
export function ndjsonSummaryLine(run: SuiteRun): string {
  return JSON.stringify({
    kind: 'summary',
    target: run.target,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    counts: run.counts,
    targetTouches: run.targetTouches,
    pass: run.pass,
    commit: run.commit,
    // 与首行同名同形。`testedCommit` 是全体一致时的那个值（不一致或问不到就
    // 不出现），`testedUnits` 是逐个被测端的原文 —— 前者方便 `jq` 一把取到，
    // 后者是它取不到时的去处。见 {@link testedCommitConsensus}。
    testedCommit: testedCommitConsensus(run.testedProvenance),
    testedUnits: run.testedProvenance?.units,
    coverage: coverageByDimension(run),
  })
}

/**
 * 机器可读：首行 start、一行一个场景、末行 summary。
 *
 * 一次性渲染一份**完整**产物。真跑不走这条路（那边是流式追加的，见
 * `scripts/qianmo-acceptance.ts`），但两边逐字节同形 —— 三段都是上面那三个
 * 函数拼的，格式只有一份定义。
 */
export function toNdjson(run: SuiteRun): string {
  const lines = [
    ndjsonStartLine({
      target: run.target,
      startedAt: run.startedAt,
      commit: run.commit,
      testedProvenance: run.testedProvenance,
      planned: run.results.length,
    }),
    ...run.results.map(ndjsonScenarioLine),
    ndjsonSummaryLine(run),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * 反解 NDJSON。
 *
 * 存在是为了让「上一轮的结果」可以被后续工具（趋势对比、真机腿合并）重新
 * 读进来，而不是只能靠肉眼看表。解析失败的行直接跳过而不是抛 —— 结果文件
 * 可能被 tee 混进别的输出，为一行噪声丢掉整份结果是净亏损。
 *
 * **没有 summary 行就返回 `undefined`，这是「这一轮没跑完」的程序化判据**
 * （见 {@link ndjsonStartLine} 那张表）。结果是流式落盘的，半份文件是常态而
 * 不是异常；拿半份 scenario 行 `summarize()` 一下会得出一个**语法上完整、
 * 语义上假的** `SuiteRun`（counts 少一截、`pass` 却可能是 true），那正是这条
 * 修复要避免的另一种静默。`kind: 'start'` 行在这里被忽略：它的用处是让人和
 * shell 读半份文件，反解一轮完整结果不需要它。
 */
export function fromNdjson(text: string): SuiteRun | undefined {
  const results: ScenarioResult[] = []
  let summary: Record<string, unknown> | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const rec = parsed as Record<string, unknown>
    if (rec.kind === 'scenario') results.push(rec as unknown as ScenarioResult)
    else if (rec.kind === 'summary') summary = rec
  }
  if (summary === undefined) return undefined
  return summarize(results, {
    target: summary.target as Target,
    startedAt: String(summary.startedAt ?? ''),
    finishedAt: String(summary.finishedAt ?? ''),
    commit: typeof summary.commit === 'string' ? summary.commit : undefined,
    testedProvenance: parseTestedUnits(summary.testedUnits),
  })
}

/**
 * 反解 `testedUnits`。
 *
 * 逐条挑形状对的留下，而不是「有一条坏的就整份丢掉」—— 与 {@link fromNdjson}
 * 对坏行的态度一致。`testedCommit` 那个标量**不反解**：它是从 `units` 推出来
 * 的（{@link testedCommitConsensus}），反解时按同一条规则重算，一份事实一个
 * 出处。
 */
function parseTestedUnits(raw: unknown): TestedProvenance | undefined {
  if (!Array.isArray(raw)) return undefined
  const units: TestedUnitProvenance[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.unit !== 'string') continue
    units.push({
      unit: rec.unit,
      ...(typeof rec.commit === 'string' ? { commit: rec.commit } : {}),
      detail: typeof rec.detail === 'string' ? rec.detail : '',
    })
  }
  return { units }
}

const MARK: Record<Outcome, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
  error: ' ERR',
}

/**
 * 证据摘要：给汇总表用的一行内压缩形态。
 *
 * 只在渲染层截断，NDJSON 里存的永远是原文。截断标记用 `…+N` 而不是省略号
 * 单发，读的人才知道被吃掉了多少。
 */
export function briefEvidence(
  evidence: readonly Evidence[],
  limit = 160,
): string {
  if (evidence.length === 0) return ''
  const head = evidence[0]
  if (head === undefined) return ''
  const flat = `${head.label}=${head.value}`.replace(/\s+/g, ' ')
  const cut = flat.length > limit ? `${flat.slice(0, limit)}…` : flat
  const more = evidence.length > 1 ? ` (+${evidence.length - 1})` : ''
  return cut + more
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/**
 * 终端上的显示宽度：CJK / 全角字符占两格。
 *
 * 只给「一栏里同时有中文标签和 ASCII 标签」的地方用（被测端那张表：节点名是
 * `beta-1`，最后一行是「套件所在检出」）。按 `.length` 对齐会让中文那行短掉
 * 一半，而那一行恰恰是要和上面几行对着读的。
 */
function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1
  }
  return width
}

/** 按显示宽度右侧补空格。见 {@link displayWidth}。 */
function padWide(s: string, n: number): string {
  const w = displayWidth(s)
  return w >= n ? s : s + ' '.repeat(n - w)
}

/**
 * 汇总表里「被测的是哪一版」那一段。
 *
 * 没有 {@link SuiteRun.testedProvenance} 就一行都不出（`target=local`：被测
 * 对象就是这棵检出，表头那个 commit 已经答完了，再印一遍只是噪声）。
 *
 * 有的时候，这一段有三条硬规则：
 *
 * ① **被测端报不上来就写「未知」。** 不回退成套件那侧的值 —— 那个回退正是
 *    issue #70 报的缺陷本身：一份「看起来权威、实际证明不了」的产物。
 * ② **两个值都印。** 「套件是哪版」与「被测的是哪版」是两个问题，报告要能
 *    分别回答；只留一个的那一版报告在说一句它证明不了的话。
 * ③ **逐个被测端印，不合并。** 舰队是一台一台滚更新的，四台停在两个 commit
 *    上完全可能，而那正是最该被看见的事实。
 */
function renderProvenance(run: SuiteRun): string[] {
  const provenance = run.testedProvenance
  if (provenance === undefined) return []
  const suiteLabel = '套件所在检出'
  const width = Math.max(
    displayWidth(suiteLabel),
    ...provenance.units.map(u => displayWidth(u.unit)),
  )
  const out: string[] = []
  out.push('被测端来源 commit（issue #70 —— 报告盖的是被测端报上来的那个）:')
  if (provenance.units.length === 0) {
    out.push('  （一个被测端都没问到）')
  }
  for (const unit of provenance.units) {
    out.push(
      `  ${padWide(unit.unit, width)}  ${unit.commit ?? '未知'}` +
        (unit.detail === '' ? '' : `  ← ${unit.detail}`),
    )
  }
  out.push(`  ${padWide(suiteLabel, width)}  ${run.commit ?? '未知'}`)
  // 「有台没答上」与「大家报的不一样」曾经共用同一句话（issue #96 ②）——
  // 一次 SSH 抖动于是读起来像一次滚更新滚了一半。四种结局四句话。
  const verdict = testedCommitVerdict(provenance)
  switch (verdict.kind) {
    case 'partial':
      out.push(
        `  ← **没有任何一台报了别的 commit**：${verdict.answered}/${verdict.total} ` +
          `个被测端一致报 ${verdict.commit}，${nameList(verdict.silent)} 这次没答上` +
          '（原因见上面各自那一行）。缺的那几台答上之前，这一栏不给一个统一值 —— ' +
          '从 4/5 编出共识正是这条报告要避免的事',
      )
      break
    case 'divergent':
      out.push(
        `  ← 被测端**真的不一致**：${verdict.answered}/${verdict.total} 个报上来的里面有 ` +
          `${verdict.commits.length} 个不同的 commit（${verdict.commits
            .map(c => c.slice(0, 12))
            .join(
              ' / ',
            )}）。舰队是一台一台滚更新的，停在两个版本上完全可能 —— ` +
          '这一轮证明的是那几台此刻各自跑着的东西，不是上面那个套件 commit',
      )
      break
    case 'silent':
      out.push(
        `  ← ${verdict.total} 个被测端**一个都没答上**（不是「报的不一致」）：` +
          '各自的原因写在上面那几行里。这一轮到底验的是哪一版，报告答不出来',
      )
      break
    case 'unanimous':
      if (!sameCommit(verdict.commit, run.commit)) {
        out.push(
          `  ← 被测端与套件**不是同一版**：这一轮验的是 ${verdict.commit}，` +
            `套件停在 ${run.commit ?? '未知'}。两个值都记在这里，别把它们当成一个`,
        )
      }
      break
    default:
      break
  }
  out.push('')
  return out
}

/** 一条「清理没做干净」的观察：哪条场景、哪一句。 */
export interface CleanupFailure {
  readonly id: string
  readonly line: string
}

/**
 * 这一轮里清理没做干净的那几条（issue #96 ①）。
 *
 * 来源是 runner 自己那行 —— 它逐条 `try/catch` 跑 cleanup 栈，抛出的清理会被
 * 记成 `cleanup 失败: …` 追进本场景的 `log` 证据。所以这个函数**与驱动无关**：
 * 任何驱动的任何一条清理只要肯抛，就会在这里露头。
 *
 * **不参与判定。** 一次清理失败是套件自己的运维债（远端目录删不掉、进程没收
 * 干净），不是被测系统答错了；把它折进 `pass` 等于用套件侧的残留去否掉一条产品
 * 结论。它要的只是**可见**：那一轮 107 MB 留在演示机上，而报告里一个字都没有。
 */
export function cleanupFailures(run: SuiteRun): readonly CleanupFailure[] {
  const out: CleanupFailure[] = []
  for (const r of run.results) {
    for (const e of r.evidence) {
      if (e.label !== 'log') continue
      for (const line of e.value.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('cleanup 失败')) {
          out.push({ id: r.id, line: trimmed })
        }
      }
    }
  }
  return out
}

/**
 * 这一轮里**因为链路够不着目标机**而红的那几条（issue #96 ③）。
 *
 * 判据是驱动打的 `errorKind`，不是错误文本 —— 文本会随消息措辞漂移，而这一栏
 * 的用处恰恰是让人不必读文本就能分开数。
 *
 * **它们照样计入 `error`、照样把整轮判红。** 这个函数不改判定，只回答「这几条
 * 红里有几条问的根本不是被测系统」。分不开的后果是这类红被整批当成「套件不稳」
 * 而加豁免，那才是套件失去可信度的路径。
 */
export function transportErrors(run: SuiteRun): readonly ScenarioResult[] {
  return run.results.filter(
    r => r.outcome === 'error' && r.errorKind === 'transport',
  )
}

/** 人可读汇总表。 */
export function renderSummary(run: SuiteRun): string {
  const out: string[] = []
  // 表头那个 commit 在有被测端来源时**必须带标签**：issue #70 的病灶正是一个
  // 无标签的 commit 被读成「刚才验的就是这一版」。没有被测端来源时（本地腿）
  // 一字不改 —— 那条腿上它本来就没有歧义。
  const provenance = run.testedProvenance
  const stamp =
    run.commit === undefined && provenance === undefined
      ? ''
      : provenance === undefined
        ? ` · ${run.commit ?? ''}`
        : ` · 套件 ${run.commit ?? '未知'} · 被测端 ${testedCommitStamp(
            provenance,
          )}`
  out.push(
    `阡陌端到端验收套件 · target=${run.target} · ${run.startedAt} · ` +
      `${(run.durationMs / 1000).toFixed(1)}s` +
      stamp,
  )
  out.push('')
  out.push(...renderProvenance(run))

  const idWidth = Math.max(2, ...run.results.map(r => r.id.length))
  for (const r of run.results) {
    const known = r.knownIssue === undefined ? '' : `  [${r.knownIssue}]`
    out.push(`${MARK[r.outcome]}  ${pad(r.id, idWidth)}  ${r.title}${known}`)
    if (r.outcome === 'skip') {
      out.push(`      skip: ${r.skipReason ?? '(未给原因)'}`)
      continue
    }
    if (r.outcome === 'pass') continue
    // 红的行才展开：期望、实际、以及全部证据原文（不截断——汇总表存在的
    // 意义就是让人不用去翻 NDJSON 就能开始排查）。
    out.push(`      期望: ${r.expected}`)
    out.push(`      实际: ${r.actual}`)
    for (const e of r.evidence) {
      const value = e.value.includes('\n')
        ? `\n${e.value
            .split('\n')
            .map(l => `          ${l}`)
            .join('\n')}`
        : ` ${e.value}`
      out.push(`      · ${e.label}:${value}`)
    }
  }

  out.push('')
  out.push('维度覆盖:')
  for (const c of coverageByDimension(run)) {
    const flag = c.total === 0 ? '   ← 本轮零覆盖' : ''
    out.push(
      `  ${pad(c.dimension, 18)} total=${pad(String(c.total), 3)}` +
        ` pass=${pad(String(c.pass), 3)} fail=${pad(String(c.fail), 3)}` +
        ` skip=${pad(String(c.skip), 3)} err=${c.error}${flag}`,
    )
  }

  out.push('')
  const tally = OUTCOMES.map(o => `${o}=${run.counts[o]}`).join(' ')
  out.push(`合计: ${tally}`)

  // 链路失败 —— 它们仍然计入上面那个 `error=N`、仍然把整轮判红；这一行只是
  // 把「问的根本不是被测系统」的那几条点出来（issue #96 ③），免得整批红被当成
  // 「套件不稳」而加豁免。
  const transport = transportErrors(run)
  if (transport.length > 0) {
    out.push(
      `其中 ${transport.length} / ${run.counts.error} 条 error 是**套件到目标机的 ` +
        'SSH 链路失败**，不是被测系统的回答（重试打满仍不通 = 这一轮确实没能问完，' +
        '所以照样计入判定）: ' +
        transport.map(r => r.id).join(', '),
    )
  }

  // 清理残留 —— 汇总表**只展开红行的证据**，于是一条绿场景留下的残留在这张表
  // 上原本一个字都看不见（issue #96 ①：107 MB 静默留在演示机上）。单独一节。
  const residue = cleanupFailures(run)
  if (residue.length > 0) {
    out.push(
      `清理残留: ${residue.length} 条场景的清理没做干净` +
        '（不改判定 —— 那是套件自己的运维债，不是被测系统的回答；但得有人去收）',
    )
    for (const r of residue) {
      out.push(`  ${r.id}  ${r.line}`)
    }
  }

  // 目标触达 —— 这一行是 issue #61 的直接产物，读报告的人先看它再看判定。
  const executed = run.results.filter(r => r.outcome !== 'skip')
  if (run.targetTouches === 0) {
    out.push(
      `目标触达: 0 / ${executed.length} 条已执行场景调用过驱动` +
        ' ← 这一轮没有任何场景碰过被测目标，等于什么都没验（判定按 FAIL 计）',
    )
  } else {
    out.push(
      `目标触达: ${run.targetTouches} / ${executed.length} 条已执行场景调用过驱动`,
    )
    const blind = executed.filter(r => r.driverCalls.length === 0)
    if (blind.length > 0) {
      out.push(
        `  其中 ${blind.length} 条没碰驱动（静态断言应当如此，别的就是绕过了驱动）: ` +
          blind.map(r => r.id).join(', '),
      )
    }
  }
  const known = run.results.filter(
    r => r.outcome === 'fail' && r.knownIssue !== undefined,
  )
  if (known.length > 0) {
    out.push(
      `其中 ${known.length} 条红是已记录缺陷（仍按失败计）: ` +
        known.map(r => `${r.id}${r.knownIssue}`).join(', '),
    )
  }
  out.push(`判定: ${run.pass ? 'PASS' : 'FAIL'}`)
  return `${out.join('\n')}\n`
}
