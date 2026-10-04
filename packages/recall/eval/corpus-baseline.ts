// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retrieval-layer M0 baseline on the M1 corpora (`corpora.ts`), under
 * every preregistered seed. Same measurement as `run.ts` — the real store,
 * the real `recall()`, two recalls per question with a prefix check — in a
 * second report format (`qianmo-recall-baseline/v2`) that carries the corpus
 * id, its hash and the seed of every table row.
 *
 * `run.ts`'s own report and markdown stay exactly as they were: they are the
 * published v0.1 baseline, and this module does not route through them.
 */

import { INJECTION_BUDGET, type InjectionBudget } from '../src/inject.js'
import { RANKING } from '../src/rank.js'
import type { RecallScope } from '../src/recall.js'
import { CORPORA, type CorpusId } from './corpora.js'
import {
  cell,
  type DecayMode,
  evaluateQueries,
  KIND_LABELS,
  type KindSummary,
  materialise,
  type TierReport,
  tierReport,
} from './run.js'

type CorpusBaselineReport = {
  readonly schema: 'qianmo-recall-baseline/v2'
  readonly corpus: CorpusId
  readonly corpusSha256: string
  readonly asOf: string
  readonly scope: RecallScope
  readonly budget: InjectionBudget
  readonly ranking: typeof RANKING
  readonly kinds: readonly string[]
  readonly runs: readonly {
    readonly seed: number
    readonly tiers: readonly TierReport[]
  }[]
}

type CorpusBaselineOptions = {
  readonly decay?: readonly DecayMode[]
}

/** Every tier under every seed and decay mode. Deterministic. */
export function runCorpusBaseline(
  corpusId: CorpusId,
  options: CorpusBaselineOptions = {},
): CorpusBaselineReport {
  const corpus = CORPORA[corpusId]
  const decays = options.decay ?? ['default']
  let asOf = ''
  let scope: RecallScope = {}
  const runs = corpus.seeds.map(seed => {
    const tiers: TierReport[] = []
    for (const tier of corpus.tiers) {
      const dataset = corpus.build(tier, seed)
      asOf = dataset.asOf.toISOString()
      scope = dataset.scope
      const materialised = materialise(dataset, {
        sourceIdOf: corpus.sourceIdOf,
      })
      try {
        for (const decay of decays) {
          tiers.push(
            tierReport(
              tier,
              decay,
              evaluateQueries(dataset, materialised, decay),
              corpus.kinds,
              corpus.pooledKinds,
            ),
          )
        }
      } finally {
        materialised.dispose()
      }
    }
    return { seed, tiers }
  })
  return {
    schema: 'qianmo-recall-baseline/v2',
    corpus: corpusId,
    corpusSha256: corpus.digest(),
    asOf,
    scope,
    budget: INJECTION_BUDGET,
    ranking: RANKING,
    kinds: corpus.kinds,
    runs,
  }
}

/**
 * The report as `--json` writes it. The preregistered M0 baseline hash is
 * the SHA-256 of exactly these bytes, so the command and the freeze share it.
 */
export function corpusBaselineJson(report: CorpusBaselineReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

const MORE_LABELS: Readonly<Record<string, string>> = {
  'positive-lexical-batch': '正例·词面重叠·批',
  'positive-mismatch-batch': '正例·零词面重叠·批',
  'negative-unsupported': '负例·相关但不支持',
  'negative-cross-context': '负例·跨 context',
  'positive-docs': '正例·docs 议题',
}

function labelOf(kind: string): string {
  return (
    (KIND_LABELS as Readonly<Record<string, string>>)[kind] ??
    MORE_LABELS[kind] ??
    kind
  )
}

/** Summary tables, one row per seed × tier × decay × kind, plus pooled. */
export function renderCorpusMarkdown(report: CorpusBaselineReport): string {
  const lines = [
    `corpus=${report.corpus} · sha256=${report.corpusSha256} · asOf=${report.asOf} · budget=${report.budget.maxEntries} 条 / ${report.budget.maxChars} 字符 · 半衰期=${report.ranking.defaultHalfLifeMs / 86_400_000} 天`,
    '',
    '| 种子 | live 条目 | 衰减 | 查询类型 | 查询数 | full 模式 | recall@1 | recall@5 | recall@10 | MRR | 候选集召回 | 注入覆盖率 | 禁入·候选 | 禁入·注入 | top-1 诱饵 |',
    '| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const run of report.runs) {
    for (const tier of run.tiers) {
      const rows: [string, KindSummary][] = [
        ...report.kinds.flatMap(kind => {
          const summary = tier.byKind[kind]
          return summary === undefined
            ? []
            : [[labelOf(kind), summary] as [string, KindSummary]]
        }),
        ['正例合计', tier.positives],
      ]
      for (const [label, s] of rows) {
        lines.push(
          `| ${run.seed} | ${tier.liveInScope} | ${tier.decay} | ${label} | ${s.queries} | ${s.fullMode}/${s.queries} | ${cell(s.recallAt1)} | ${cell(s.recallAt5)} | ${cell(s.recallAt10)} | ${cell(s.mrr)} | ${cell(s.candidateRecall)} | ${cell(s.injectionCoverage)} | ${s.forbiddenInCandidates}/${s.forbiddenLabels} | ${s.forbiddenInjected}/${s.forbiddenLabels} | ${s.lureAtTop1}/${s.queries} |`,
        )
      }
    }
  }
  return lines.join('\n')
}
