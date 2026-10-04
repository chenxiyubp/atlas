// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retrieval-layer baseline runner (`docs/dev/memory-m1.md` §3).
 *
 * It writes a {@link buildDataset} corpus into a real `FileMemoryStore` in a
 * temporary directory and asks the real {@link recall} every question — the
 * same function the resident sidecar and the AC-4 leg call. Nothing is
 * re-implemented here: scope selection, liveness, ranking and the budget are
 * all the shipped code.
 *
 * Each question is recalled twice: once with an unbounded budget, which yields
 * the full ranking over the candidate set (for recall@k and MRR), and once with
 * the default budget, which yields what a model would actually be shown (for
 * injection coverage and leaks). The second must be a prefix of the first; the
 * runner checks that and throws if it is not, because a disagreement would
 * mean the two numbers describe different pipelines.
 *
 * The output contains no timings and no wall-clock values, so the same seed
 * produces the same report byte for byte.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMemoryStore } from '@qianmo/memory'
import {
  INJECTION_BUDGET,
  type InjectionBudget,
  type InjectionMode,
} from '../src/inject.js'
import { RANKING } from '../src/rank.js'
import { recall, type RecallScope } from '../src/recall.js'
import {
  buildDataset,
  DEFAULT_SEED,
  DEFAULT_TIERS,
  EVAL_QUERY_KINDS,
  type EvalEntry,
  type EvalQuery,
  type EvalQueryKind,
} from './dataset.js'
import {
  coverage,
  leakCount,
  meanOf,
  ranksOf,
  recallAtK,
  reciprocalRank,
  round4,
} from './metrics.js'

/** `default` is the shipped 30-day half-life; `off` is an ablation. */
export type DecayMode = 'default' | 'off'

/**
 * What the runner needs from an entry. The v0.1 corpus (`dataset.ts`) and
 * the later corpora (`hardened.ts`, the `docs/dev` corpus) all fit it; the
 * role label is carried for the corpora's own use and never read here.
 */
export type BaselineEntry = Omit<EvalEntry, 'role'> & {
  readonly role: string
}

/**
 * What the runner needs from a query. `scope` overrides the dataset's scope
 * for one query — the working-layer partition cases recall from a different
 * table than the rest of their corpus.
 */
export type BaselineQuery = Omit<EvalQuery, 'kind'> & {
  readonly kind: string
  readonly scope?: RecallScope
}

export type BaselineDataset = {
  readonly seed: number
  readonly liveInScope: number
  readonly asOf: Date
  readonly scope: RecallScope
  readonly entries: readonly BaselineEntry[]
  readonly queries: readonly BaselineQuery[]
}

export type QueryOutcome = {
  readonly id: string
  readonly kind: string
  readonly mode: InjectionMode
  readonly candidates: number
  readonly injected: number
  readonly gold: readonly string[]
  /** 1-based rank of each gold entry over the whole candidate set. */
  readonly goldRanks: readonly (number | null)[]
  /** Pre-decay relevance of each gold entry; 0 means no ranking signal. */
  readonly goldRelevance: readonly (number | null)[]
  readonly recallAt1: number | null
  readonly recallAt5: number | null
  readonly recallAt10: number | null
  readonly reciprocalRank: number | null
  readonly candidateRecall: number | null
  readonly injectionCoverage: number | null
  readonly forbiddenLabels: number
  readonly forbiddenInCandidates: number
  readonly forbiddenInjected: number
  readonly top1: string | null
  /** The top entry is a lexical match that is not a gold entry. */
  readonly lureAtTop1: boolean
}

export type KindSummary = {
  readonly queries: number
  readonly withGold: number
  readonly fullMode: number
  readonly recallAt1: number | null
  readonly recallAt5: number | null
  readonly recallAt10: number | null
  readonly mrr: number | null
  readonly candidateRecall: number | null
  readonly injectionCoverage: number | null
  readonly forbiddenLabels: number
  readonly forbiddenInCandidates: number
  readonly forbiddenInjected: number
  readonly lureAtTop1: number
}

export type TierReport = {
  readonly liveInScope: number
  readonly decay: DecayMode
  readonly meanCandidates: number | null
  readonly meanInjected: number | null
  /** One summary per query kind of the corpus, in the corpus's kind order. */
  readonly byKind: Readonly<Record<string, KindSummary>>
  /** Both positive kinds pooled. */
  readonly positives: KindSummary
  readonly queries: readonly QueryOutcome[]
}

export type BaselineReport = {
  readonly schema: 'qianmo-recall-baseline/v1'
  readonly seed: number
  readonly asOf: string
  readonly scope: RecallScope
  readonly budget: InjectionBudget
  readonly ranking: typeof RANKING
  readonly tiers: readonly TierReport[]
}

export type BaselineOptions = {
  readonly seed?: number
  readonly tiers?: readonly number[]
  readonly decay?: readonly DecayMode[]
}

export const UNBOUNDED: InjectionBudget = {
  maxEntries: Number.MAX_SAFE_INTEGER,
  maxChars: Number.MAX_SAFE_INTEGER,
}

export type Materialised = {
  readonly store: FileMemoryStore
  readonly keyOf: (id: string) => string
  readonly idOf: (key: string) => string
  dispose(): void
}

export type MaterialiseOptions = {
  /**
   * The `source.id` written for an entry. The block prints it, so it is part
   * of what a model — or an embedding of the rendered entry — sees. The v0.1
   * corpus keeps `eval-<key>` because its character budget, and with it the
   * pinned baseline, depends on that exact length. Later corpora pass an
   * opaque id so a label such as `filler-0001` never reaches the block.
   */
  readonly sourceIdOf?: (entry: BaselineEntry, writeIndex: number) => string
}

/** Write the corpus to disk through the store's own write / revoke paths. */
export function materialise(
  dataset: Pick<BaselineDataset, 'asOf' | 'entries'>,
  options: MaterialiseOptions = {},
): Materialised {
  const sourceIdOf =
    options.sourceIdOf ?? ((entry: BaselineEntry) => `eval-${entry.key}`)
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-recall-eval-'))
  let clock = dataset.asOf
  let counter = 0
  const store = new FileMemoryStore({
    root: join(directory, 'memory'),
    now: () => clock,
    newId: () => {
      counter += 1
      return `qm-mem-eval${String(counter).padStart(6, '0')}`
    },
  })
  const idByKey = new Map<string, string>()
  const keyById = new Map<string, string>()
  try {
    for (const [writeIndex, entry] of dataset.entries.entries()) {
      clock = entry.createdAt
      const written = store.write({
        scope: entry.scope,
        title: entry.title,
        summary: entry.summary,
        body: entry.body,
        tags: entry.tags,
        source: { kind: 'import', id: sourceIdOf(entry, writeIndex) },
        ...(entry.invalidAt === undefined
          ? {}
          : { invalidAt: entry.invalidAt }),
      })
      idByKey.set(entry.key, written.id)
      keyById.set(written.id, entry.key)
    }
    for (const entry of dataset.entries) {
      if (entry.revokedAt === undefined) continue
      const id = idByKey.get(entry.key)
      if (id === undefined) throw new Error(`eval: ${entry.key} not written`)
      clock = entry.revokedAt
      store.revoke(id, { reason: 'eval: decision overturned', by: 'eval' })
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    store,
    keyOf: id => {
      const key = keyById.get(id)
      if (key === undefined) throw new Error(`eval: unknown id ${id}`)
      return key
    },
    idOf: key => {
      const id = idByKey.get(key)
      if (id === undefined) throw new Error(`eval: unknown key ${key}`)
      return id
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

export function evaluateQueries(
  dataset: BaselineDataset,
  materialised: Materialised,
  decay: DecayMode,
): QueryOutcome[] {
  const { store, keyOf } = materialised
  return dataset.queries.map(query => {
    const request = {
      question: query.question,
      scope: query.scope ?? dataset.scope,
      asOf: dataset.asOf,
      ...(decay === 'off' ? { halfLifeMs: 0 } : {}),
    }
    const full = recall(store, { ...request, budget: UNBOUNDED })
    const shown = recall(store, request)
    if (full.degraded || shown.degraded) {
      throw new Error(`eval: store degraded while recalling ${query.id}`)
    }
    const ranking = full.entries.map(ranked => keyOf(ranked.entry.id))
    const injected = shown.entries.map(ranked => keyOf(ranked.entry.id))
    if (injected.some((key, index) => ranking[index] !== key)) {
      throw new Error(
        `eval: injected block for ${query.id} is not a prefix of the full ranking`,
      )
    }
    const relevanceByKey = new Map(
      full.entries.map(ranked => [keyOf(ranked.entry.id), ranked.relevance]),
    )
    const top = full.entries[0]
    const top1 = top === undefined ? null : keyOf(top.entry.id)
    return {
      id: query.id,
      kind: query.kind,
      mode: shown.mode,
      candidates: full.candidateCount,
      injected: injected.length,
      gold: query.gold,
      goldRanks: ranksOf(ranking, query.gold),
      goldRelevance: query.gold.map(key => relevanceByKey.get(key) ?? null),
      recallAt1: recallAtK(ranking, query.gold, 1),
      recallAt5: recallAtK(ranking, query.gold, 5),
      recallAt10: recallAtK(ranking, query.gold, 10),
      reciprocalRank: reciprocalRank(ranking, query.gold),
      candidateRecall: coverage(ranking, query.gold),
      injectionCoverage: coverage(injected, query.gold),
      forbiddenLabels: query.forbidden.length,
      forbiddenInCandidates: leakCount(ranking, query.forbidden),
      forbiddenInjected: leakCount(injected, query.forbidden),
      top1,
      lureAtTop1:
        top !== undefined &&
        top1 !== null &&
        !query.gold.includes(top1) &&
        top.relevance > 0,
    }
  })
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0)

/** Aggregate a set of outcomes. Rates are means over queries that have gold. */
export function summarise(outcomes: readonly QueryOutcome[]): KindSummary {
  return {
    queries: outcomes.length,
    withGold: outcomes.filter(outcome => outcome.gold.length > 0).length,
    fullMode: outcomes.filter(outcome => outcome.mode === 'full').length,
    recallAt1: round4(meanOf(outcomes.map(o => o.recallAt1))),
    recallAt5: round4(meanOf(outcomes.map(o => o.recallAt5))),
    recallAt10: round4(meanOf(outcomes.map(o => o.recallAt10))),
    mrr: round4(meanOf(outcomes.map(o => o.reciprocalRank))),
    candidateRecall: round4(meanOf(outcomes.map(o => o.candidateRecall))),
    injectionCoverage: round4(meanOf(outcomes.map(o => o.injectionCoverage))),
    forbiddenLabels: sum(outcomes.map(o => o.forbiddenLabels)),
    forbiddenInCandidates: sum(outcomes.map(o => o.forbiddenInCandidates)),
    forbiddenInjected: sum(outcomes.map(o => o.forbiddenInjected)),
    lureAtTop1: outcomes.filter(outcome => outcome.lureAtTop1).length,
  }
}

export function tierReport(
  liveInScope: number,
  decay: DecayMode,
  outcomes: readonly QueryOutcome[],
  kinds: readonly string[] = EVAL_QUERY_KINDS,
  pooledKinds: readonly string[] | null = null,
): TierReport {
  const byKind: Record<string, KindSummary> = Object.fromEntries(
    kinds.map(kind => [
      kind,
      summarise(outcomes.filter(outcome => outcome.kind === kind)),
    ]),
  )
  return {
    liveInScope,
    decay,
    meanCandidates: round4(meanOf(outcomes.map(o => o.candidates))),
    meanInjected: round4(meanOf(outcomes.map(o => o.injected))),
    byKind,
    positives: summarise(
      outcomes.filter(outcome =>
        pooledKinds === null
          ? outcome.kind.startsWith('positive-')
          : pooledKinds.includes(outcome.kind),
      ),
    ),
    queries: outcomes,
  }
}

/** Run every tier under every decay mode. Deterministic for a given seed. */
export function runBaseline(options: BaselineOptions = {}): BaselineReport {
  const seed = options.seed ?? DEFAULT_SEED
  const tiers = options.tiers ?? DEFAULT_TIERS
  const decays = options.decay ?? ['default']
  const reports: TierReport[] = []
  let asOf = ''
  let scope: RecallScope = {}
  for (const tier of tiers) {
    const dataset = buildDataset(tier, seed)
    asOf = dataset.asOf.toISOString()
    scope = dataset.scope
    const materialised = materialise(dataset)
    try {
      for (const decay of decays) {
        reports.push(
          tierReport(
            tier,
            decay,
            evaluateQueries(dataset, materialised, decay),
          ),
        )
      }
    } finally {
      materialised.dispose()
    }
  }
  return {
    schema: 'qianmo-recall-baseline/v1',
    seed,
    asOf,
    scope,
    budget: INJECTION_BUDGET,
    ranking: RANKING,
    tiers: reports,
  }
}

export const KIND_LABELS: Readonly<Record<EvalQueryKind, string>> = {
  'positive-lexical': '正例·词面重叠',
  'positive-mismatch': '正例·零词面重叠',
  'negative-fabricated': '负例·伪造决策',
  'negative-retired': '负例·已废止',
  'negative-cross-scope': '负例·跨 scope',
}

export function cell(value: number | null): string {
  return value === null ? '—' : value.toFixed(3)
}

/** The summary tables, as they are pasted into the design document. */
export function renderMarkdown(report: BaselineReport): string {
  const lines = [
    `seed=${report.seed} · asOf=${report.asOf} · budget=${report.budget.maxEntries} 条 / ${report.budget.maxChars} 字符 · 半衰期=${report.ranking.defaultHalfLifeMs / 86_400_000} 天`,
    '',
    '| live 条目 | 衰减 | 查询类型 | 查询数 | full 模式 | recall@1 | recall@5 | recall@10 | MRR | 候选集召回 | 注入覆盖率 | 禁入·候选 | 禁入·注入 | top-1 诱饵 |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const tier of report.tiers) {
    const rows: [string, KindSummary][] = [
      ...EVAL_QUERY_KINDS.map(
        kind => [KIND_LABELS[kind], tier.byKind[kind]] as [string, KindSummary],
      ),
      ['正例合计', tier.positives],
    ]
    for (const [label, s] of rows) {
      lines.push(
        `| ${tier.liveInScope} | ${tier.decay} | ${label} | ${s.queries} | ${s.fullMode}/${s.queries} | ${cell(s.recallAt1)} | ${cell(s.recallAt5)} | ${cell(s.recallAt10)} | ${cell(s.mrr)} | ${cell(s.candidateRecall)} | ${cell(s.injectionCoverage)} | ${s.forbiddenInCandidates}/${s.forbiddenLabels} | ${s.forbiddenInjected}/${s.forbiddenLabels} | ${s.lureAtTop1}/${s.queries} |`,
      )
    }
  }
  lines.push('')
  for (const tier of report.tiers) {
    lines.push(
      `- live=${tier.liveInScope} decay=${tier.decay}: 平均候选 ${cell(tier.meanCandidates)} 条，平均注入 ${cell(tier.meanInjected)} 条`,
    )
  }
  return lines.join('\n')
}
