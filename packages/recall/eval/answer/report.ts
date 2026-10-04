// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer-layer report, `qianmo-recall-answer-eval/v1`: the call log line,
 * the per-cell summary, and the D-1 A0–A6 gates.
 *
 * The report is a pure function of the call log (plus the corpus text needed
 * for the blinded adjudication list), so a run that stopped can be reported,
 * a resumed run reports everything it has, and a replayed run reports the
 * same numbers as the run it replays.
 *
 * Only complete pairs enter the summary and the gates when two arms run: a
 * question answered under one arm and not yet under the other would compare
 * unlike with unlike.
 *
 * A gate that needs a preregistered value the file does not hold yet is
 * `not-evaluable` and names the key. It is not given a default and it does
 * not stop the report from being written: the calls behind it were paid for.
 */

import type { InjectionMode } from '../../src/inject.js'
import type { Preregistration } from '../prereg.js'
import type { LedgerSnapshot, Phase } from './ledger.js'
import { scheduleSeed, type Unit, unitKey } from './schedule.js'
import type { CallScore, CitedCheck, RoundVerdict } from './score.js'
import {
  bootstrapQuantile,
  clusterBootstrap,
  clusterDifferences,
  holm,
  meanDifference,
  type PairedObservation,
  signFlipPValue,
} from './stats.js'
import { mulberry32 } from '../dataset.js'
import type { Arm, TokenUsage } from './types.js'

export const ANSWER_REPORT_SCHEMA = 'qianmo-recall-answer-eval/v1'

export type RunStatus = 'complete' | 'capped' | 'invalid' | 'aborted'

export type RoundRecord = {
  readonly verdict: RoundVerdict
  readonly citations: readonly CitedCheck[]
  readonly acceptedKeys: readonly string[]
  readonly answerHead: string
  readonly model: string | null
  readonly stopReason: string | null
  readonly usage: TokenUsage | null
}

/**
 * One line of `calls.ndjson` (§4 「留档」): no key, no request body, no host.
 * Written only once the call — and its second round, if any — is complete.
 */
export type CallRecord = {
  readonly key: string
  readonly unit: Unit
  readonly arm: Arm
  readonly mode: InjectionMode
  readonly requestedModel: string
  readonly at: string
  readonly rounds: readonly RoundRecord[]
  /** Scored on the first round: the primary reading. */
  readonly first: CallScore
  /** Scored after at most one rejection was fed back. */
  readonly final: CallScore
}

export function recordKey(unit: Unit, arm: Arm): string {
  return `${unitKey(unit)}/${arm}`
}

export const isPositiveKind = (kind: string): boolean =>
  kind.startsWith('positive-')

export type SummaryRow = {
  readonly corpus: string
  readonly tier: number
  readonly arm: Arm
  readonly kind: string
  readonly calls: number
  readonly hits: number
  readonly hitsWithoutMention: number
  readonly misattributed: number
  readonly finalHits: number
  readonly finalMisattributed: number
  readonly callsWithFabricated: number
  readonly citations: number
  readonly fabricatedCitations: number
  readonly outOfBoundsCitations: number
  readonly secondRounds: number
}

type GateStatus = 'pass' | 'fail' | 'not-evaluable' | 'not-applicable'

type Comparison = {
  readonly name: string
  readonly questions: number
  readonly meanDifference: number
  readonly p: number
}

type Gates = {
  readonly A0: {
    readonly status: GateStatus
    readonly reason: string | null
    readonly alpha: number | null
    readonly tests: readonly Comparison[]
  }
  readonly E1: {
    readonly status: GateStatus
    readonly reason: string | null
    readonly method: 'bootstrap' | 'signflip' | null
    readonly alpha: number | null
    readonly questions: number
    readonly meanDifference: number | null
    readonly p: number | null
    readonly lowerBound: number | null
  }
  readonly E2: {
    readonly status: GateStatus
    readonly reason: string | null
    readonly alpha: number | null
    readonly delta: number | null
    readonly questions: number
    readonly meanDifference: number | null
    readonly upperBound: number | null
  }
  readonly A4: {
    readonly status: GateStatus
    readonly reason: string | null
    readonly m0: number
    readonly m1: number
    readonly newCases: readonly {
      readonly tier: number
      readonly queryId: string
      readonly provider: string
      readonly m0: number
      readonly m1: number
    }[]
  }
  readonly A5: {
    readonly status: GateStatus
    readonly reason: string | null
    readonly comparisons: readonly (Comparison & { readonly pHolm: number })[]
  }
  readonly A6: {
    readonly status: GateStatus
    readonly reason: string | null
    readonly cases: number
    readonly file: string | null
  }
}

export type CorpusSection = {
  readonly id: string
  readonly sha256: string
  readonly preregisteredSha256: string | null
  readonly seed: number
  readonly tiers: readonly { readonly tier: number; readonly mode: string }[]
}

export type AnswerReport = {
  readonly schema: typeof ANSWER_REPORT_SCHEMA
  readonly status: RunStatus
  readonly runId: string
  readonly phase: Phase
  readonly finishedAt: string
  readonly protocol: {
    readonly arms: readonly Arm[]
    readonly repetitions: number
    readonly concurrency: number
    readonly placement: 'system-prompt'
    readonly requireCitation: false
    readonly secondRoundAfterRejection: true
    readonly seedControl: 'uncontrolled'
  }
  readonly preregistration: {
    readonly sha256: string
    readonly values: Preregistration
  }
  readonly corpora: readonly CorpusSection[]
  readonly providers: readonly {
    readonly id: string
    readonly requestedModel: string
    readonly maxOutputTokens: number
    readonly observedModels: readonly string[]
  }[]
  readonly calls: {
    readonly planned: number
    readonly completed: number
    readonly pairsPlanned: number
    readonly pairsCompleted: number
    readonly failed: number
  }
  readonly tokens: {
    readonly reported: TokenUsage
    readonly callsWithoutUsage: number
    readonly ledger: LedgerSnapshot
  }
  readonly summary: readonly SummaryRow[]
  readonly gates: Gates
  readonly validity: {
    readonly valid: boolean
    readonly reasons: readonly string[]
  }
  readonly stop: { readonly reason: string; readonly detail: string } | null
}

/** The blinded A6 list and its key, written next to the report. */
type Adjudication = {
  readonly blinded: readonly {
    readonly item: number
    readonly corpus: string
    readonly tier: number
    readonly queryId: string
    readonly question: string
    readonly provider: string
    readonly rep: number
    readonly answers: readonly {
      readonly label: 'X' | 'Y'
      readonly answerHead: string
      readonly cited: readonly {
        readonly key: string
        readonly title: string
      }[]
    }[]
  }[]
  readonly key: readonly {
    readonly item: number
    readonly X: Arm
    readonly Y: Arm
  }[]
}

export const ADJUDICATION_FILE = 'adjudication.json'
export const ADJUDICATION_KEY_FILE = 'adjudication-key.json'

// ── pairing ────────────────────────────────────────────────────────────────

type Pair = {
  readonly unit: Unit
  readonly m0: CallRecord
  readonly m1: CallRecord
}

function completePairs(records: readonly CallRecord[]): Pair[] {
  const byUnit = new Map<
    string,
    { unit: Unit; m0?: CallRecord; m1?: CallRecord }
  >()
  for (const record of records) {
    const key = unitKey(record.unit)
    const slot = byUnit.get(key) ?? { unit: record.unit }
    slot[record.arm] = record
    byUnit.set(key, slot)
  }
  return [...byUnit.values()].flatMap(slot =>
    slot.m0 !== undefined && slot.m1 !== undefined
      ? [{ unit: slot.unit, m0: slot.m0, m1: slot.m1 }]
      : [],
  )
}

/** Records that count: complete pairs under two arms, everything under one. */
export function countedRecords(
  records: readonly CallRecord[],
  arms: readonly Arm[],
): CallRecord[] {
  if (arms.length < 2) return [...records]
  return completePairs(records).flatMap(pair => [pair.m0, pair.m1])
}

// ── summary ────────────────────────────────────────────────────────────────

export function summarise(
  records: readonly CallRecord[],
  corpusOrder: readonly string[],
  kindOrder: (corpus: string) => readonly string[],
): SummaryRow[] {
  const rows = new Map<string, SummaryRow>()
  for (const record of records) {
    const { corpus, tier, kind } = record.unit
    const key = JSON.stringify([corpus, tier, record.arm, kind])
    const row = rows.get(key) ?? {
      corpus,
      tier,
      arm: record.arm,
      kind,
      calls: 0,
      hits: 0,
      hitsWithoutMention: 0,
      misattributed: 0,
      finalHits: 0,
      finalMisattributed: 0,
      callsWithFabricated: 0,
      citations: 0,
      fabricatedCitations: 0,
      outOfBoundsCitations: 0,
      secondRounds: 0,
    }
    const add = (flag: boolean) => (flag ? 1 : 0)
    rows.set(key, {
      ...row,
      calls: row.calls + 1,
      hits: row.hits + add(record.first.hit),
      hitsWithoutMention:
        row.hitsWithoutMention + add(record.first.hitWithoutMention),
      misattributed: row.misattributed + add(record.first.misattributed),
      finalHits: row.finalHits + add(record.final.hit),
      finalMisattributed:
        row.finalMisattributed + add(record.final.misattributed),
      callsWithFabricated:
        row.callsWithFabricated + add(record.first.fabricated > 0),
      citations: row.citations + record.first.citations,
      fabricatedCitations: row.fabricatedCitations + record.first.fabricated,
      outOfBoundsCitations: row.outOfBoundsCitations + record.first.outOfBounds,
      secondRounds: row.secondRounds + add(record.rounds.length > 1),
    })
  }
  const rank = (list: readonly string[], value: string) => {
    const index = list.indexOf(value)
    return index === -1 ? list.length : index
  }
  return [...rows.values()].sort(
    (a, b) =>
      rank(corpusOrder, a.corpus) - rank(corpusOrder, b.corpus) ||
      a.tier - b.tier ||
      rank(kindOrder(a.corpus), a.kind) - rank(kindOrder(b.corpus), b.kind) ||
      (a.arm < b.arm ? -1 : a.arm > b.arm ? 1 : 0),
  )
}

// ── gates ──────────────────────────────────────────────────────────────────

type Metric = (score: CallScore) => number
const HIT: Metric = s => (s.hit ? 1 : 0)
const HIT_NO_MENTION: Metric = s => (s.hitWithoutMention ? 1 : 0)
const MISATTRIBUTED: Metric = s => (s.misattributed ? 1 : 0)
const ANY_FABRICATED: Metric = s => (s.fabricated > 0 ? 1 : 0)
const ANY_OUT_OF_BOUNDS: Metric = s => (s.outOfBounds > 0 ? 1 : 0)

type Selection = {
  readonly corpus: string
  readonly tiers: readonly number[]
  readonly kinds: (kind: string) => boolean
  readonly metric: Metric
  readonly reading: 'first' | 'final'
}

function observe(pairs: readonly Pair[], selection: Selection) {
  return pairs
    .filter(
      ({ unit }) =>
        unit.corpus === selection.corpus &&
        selection.tiers.includes(unit.tier) &&
        selection.kinds(unit.kind),
    )
    .map(
      ({ unit, m0, m1 }): PairedObservation => ({
        cluster: `${unit.corpus}/${unit.queryId}`,
        stratum: `${unit.tier}/${unit.provider}`,
        m0: selection.metric(m0[selection.reading]),
        m1: selection.metric(m1[selection.reading]),
      }),
    )
}

function compare(
  name: string,
  pairs: readonly Pair[],
  selection: Selection,
  alternative: 'greater' | 'two-sided',
): Comparison | null {
  const differences = clusterDifferences(observe(pairs, selection))
  if (differences.length === 0) return null
  return {
    name,
    questions: differences.length,
    meanDifference: meanDifference(differences),
    p: signFlipPValue(differences, alternative),
  }
}

type GateContext = {
  readonly arms: readonly Arm[]
  /** The corpus E1, E2, A0 and A4 are judged on (`[plan] primary_corpus`). */
  readonly primaryCorpus: string
  readonly prereg: Preregistration
  /** Tiers whose M0 injection is `ranked`, per corpus. */
  readonly rankedTiers: (corpus: string) => readonly number[]
  readonly smallTier: (corpus: string) => number | null
  readonly positiveKinds: (corpus: string) => readonly string[]
  readonly corpora: readonly string[]
}

const missing = (key: string) => `preregistration: ${key} not generated`

export function evaluateGates(
  records: readonly CallRecord[],
  context: GateContext,
): Gates {
  const { prereg } = context
  const primary = context.primaryCorpus
  if (context.arms.length < 2) {
    const reason = 'one arm: nothing to compare'
    return {
      A0: { status: 'not-applicable', reason, alpha: null, tests: [] },
      E1: {
        status: 'not-applicable',
        reason,
        method: null,
        alpha: null,
        questions: 0,
        meanDifference: null,
        p: null,
        lowerBound: null,
      },
      E2: {
        status: 'not-applicable',
        reason,
        alpha: null,
        delta: null,
        questions: 0,
        meanDifference: null,
        upperBound: null,
      },
      A4: { status: 'not-applicable', reason, m0: 0, m1: 0, newCases: [] },
      A5: { status: 'not-applicable', reason, comparisons: [] },
      A6: { status: 'not-applicable', reason, cases: 0, file: null },
    }
  }
  const pairs = completePairs(records)
  const ranked = context.rankedTiers(primary)
  const all = () => true

  // A0: the small tier, where both arms get the same block (R1).
  const small = context.smallTier(primary)
  const aaTests =
    small === null
      ? []
      : [
          compare(
            'A0·H',
            pairs,
            {
              corpus: primary,
              tiers: [small],
              kinds: isPositiveKind,
              metric: HIT,
              reading: 'first',
            },
            'two-sided',
          ),
          compare(
            'A0·HR_mis',
            pairs,
            {
              corpus: primary,
              tiers: [small],
              kinds: all,
              metric: MISATTRIBUTED,
              reading: 'first',
            },
            'two-sided',
          ),
        ].flatMap(c => (c === null ? [] : [c]))
  const aaAlpha = prereg.answer.aaAlpha
  const A0: Gates['A0'] =
    aaAlpha === null
      ? {
          status: 'not-evaluable',
          reason: missing('answer.aa_alpha'),
          alpha: null,
          tests: aaTests,
        }
      : aaTests.length === 0
        ? {
            status: 'not-evaluable',
            reason: 'no complete pairs at the small tier',
            alpha: aaAlpha,
            tests: [],
          }
        : {
            status: aaTests.some(t => t.p < aaAlpha) ? 'fail' : 'pass',
            reason: null,
            alpha: aaAlpha,
            tests: aaTests,
          }

  // E1: positives' H, ranked tiers pooled, superiority.
  const e1Differences = clusterDifferences(
    observe(pairs, {
      corpus: primary,
      tiers: ranked,
      kinds: isPositiveKind,
      metric: HIT,
      reading: 'first',
    }),
  )
  const alpha = prereg.answer.alphaPrimary
  const method = prereg.answer.e1Inference
  const iterations = prereg.answer.bootstrapIterations
  const seed = prereg.answer.bootstrapSeed
  const e1Base = {
    method,
    alpha,
    questions: e1Differences.length,
    meanDifference:
      e1Differences.length === 0 ? null : meanDifference(e1Differences),
  }
  let E1: Gates['E1']
  if (alpha === null || method === null) {
    E1 = {
      ...e1Base,
      status: 'not-evaluable',
      reason: missing(
        alpha === null ? 'answer.alpha_primary' : 'answer.e1_inference',
      ),
      p: null,
      lowerBound: null,
    }
  } else if (e1Differences.length === 0) {
    E1 = {
      ...e1Base,
      status: 'not-evaluable',
      reason: 'no complete pairs on the ranked tiers',
      p: null,
      lowerBound: null,
    }
  } else if (method === 'signflip') {
    const p = signFlipPValue(e1Differences, 'greater')
    E1 = {
      ...e1Base,
      status: p < alpha ? 'pass' : 'fail',
      reason: null,
      p,
      lowerBound: null,
    }
  } else if (iterations === null || seed === null) {
    E1 = {
      ...e1Base,
      status: 'not-evaluable',
      reason: missing(
        iterations === null
          ? 'answer.bootstrap_iterations'
          : 'answer.bootstrap_seed',
      ),
      p: null,
      lowerBound: null,
    }
  } else {
    const means = clusterBootstrap(e1Differences, iterations, seed)
    const lowerBound = bootstrapQuantile(means, alpha)
    const atOrBelowZero = means.filter(m => m <= 0).length
    E1 = {
      ...e1Base,
      status: lowerBound > 0 ? 'pass' : 'fail',
      reason: null,
      p: atOrBelowZero / means.length,
      lowerBound,
    }
  }

  // E2: HR_mis over every question, ranked tiers pooled, non-inferiority.
  const e2Differences = clusterDifferences(
    observe(pairs, {
      corpus: primary,
      tiers: ranked,
      kinds: all,
      metric: MISATTRIBUTED,
      reading: 'first',
    }),
  )
  const delta = prereg.answer.noninferiorityDelta
  const e2Base = {
    alpha,
    delta,
    questions: e2Differences.length,
    meanDifference:
      e2Differences.length === 0 ? null : meanDifference(e2Differences),
  }
  const e2Missing =
    alpha === null
      ? 'answer.alpha_primary'
      : delta === null
        ? 'answer.noninferiority_delta'
        : iterations === null
          ? 'answer.bootstrap_iterations'
          : seed === null
            ? 'answer.bootstrap_seed'
            : null
  let E2: Gates['E2']
  if (e2Missing !== null || alpha === null || delta === null) {
    E2 = {
      ...e2Base,
      status: 'not-evaluable',
      reason: missing(e2Missing ?? 'answer'),
      upperBound: null,
    }
  } else if (
    e2Differences.length === 0 ||
    iterations === null ||
    seed === null
  ) {
    E2 = {
      ...e2Base,
      status: 'not-evaluable',
      reason: 'no complete pairs on the ranked tiers',
      upperBound: null,
    }
  } else {
    const means = clusterBootstrap(e2Differences, iterations, seed)
    const upperBound = bootstrapQuantile(means, 1 - alpha)
    E2 = {
      ...e2Base,
      status: upperBound < delta ? 'pass' : 'fail',
      reason: null,
      upperBound,
    }
  }

  // A4: fabricated decisions — accepted citations, the per-(question,
  // provider) median over repetitions, summed per arm.
  const cells = new Map<
    string,
    {
      tier: number
      queryId: string
      provider: string
      m0: number[]
      m1: number[]
    }
  >()
  for (const { unit, m0, m1 } of pairs) {
    if (
      unit.corpus !== primary ||
      unit.kind !== 'negative-fabricated' ||
      !ranked.includes(unit.tier)
    ) {
      continue
    }
    const key = `${unit.tier}/${unit.queryId}/${unit.provider}`
    const cell = cells.get(key) ?? {
      tier: unit.tier,
      queryId: unit.queryId,
      provider: unit.provider,
      m0: [],
      m1: [],
    }
    cell.m0.push(m0.first.acceptedCitations)
    cell.m1.push(m1.first.acceptedCitations)
    cells.set(key, cell)
  }
  const median = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
  }
  const voted = [...cells.values()]
    .map(cell => ({
      tier: cell.tier,
      queryId: cell.queryId,
      provider: cell.provider,
      m0: median(cell.m0),
      m1: median(cell.m1),
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (a.queryId < b.queryId ? -1 : a.queryId > b.queryId ? 1 : 0) ||
        (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
    )
  const sum0 = voted.reduce((acc, v) => acc + v.m0, 0)
  const sum1 = voted.reduce((acc, v) => acc + v.m1, 0)
  const A4: Gates['A4'] =
    voted.length === 0
      ? {
          status: 'not-evaluable',
          reason: 'no complete fabricated-question pairs on the ranked tiers',
          m0: 0,
          m1: 0,
          newCases: [],
        }
      : {
          status: sum1 <= sum0 ? 'pass' : 'fail',
          reason: null,
          m0: sum0,
          m1: sum1,
          newCases: voted.filter(v => v.m1 > v.m0),
        }

  // A5: everything else, two-sided, Holm-adjusted.
  const secondary: [string, Selection][] = []
  for (const corpus of context.corpora) {
    const tiers = context.rankedTiers(corpus)
    if (tiers.length === 0) continue
    const base = { corpus, tiers, reading: 'first' as const }
    if (corpus === primary) {
      for (const kind of context.positiveKinds(corpus)) {
        secondary.push([
          `${corpus}·H·${kind}`,
          { ...base, kinds: k => k === kind, metric: HIT },
        ])
      }
      for (const tier of tiers) {
        secondary.push([
          `${corpus}·H·tier${tier}`,
          { ...base, tiers: [tier], kinds: isPositiveKind, metric: HIT },
        ])
      }
    } else {
      secondary.push([
        `${corpus}·H`,
        { ...base, kinds: isPositiveKind, metric: HIT },
      ])
      secondary.push([
        `${corpus}·HR_mis`,
        { ...base, kinds: all, metric: MISATTRIBUTED },
      ])
    }
    secondary.push(
      [
        `${corpus}·H(no mustMention)`,
        { ...base, kinds: isPositiveKind, metric: HIT_NO_MENTION },
      ],
      [
        `${corpus}·H(after one rejection)`,
        { ...base, reading: 'final', kinds: isPositiveKind, metric: HIT },
      ],
      [
        `${corpus}·HR_mis(after one rejection)`,
        { ...base, reading: 'final', kinds: all, metric: MISATTRIBUTED },
      ],
      [
        `${corpus}·HR_fab(per call)`,
        { ...base, kinds: all, metric: ANY_FABRICATED },
      ],
      [
        `${corpus}·out-of-bounds(per call)`,
        { ...base, kinds: all, metric: ANY_OUT_OF_BOUNDS },
      ],
    )
  }
  const comparisons = secondary.flatMap(([name, selection]) => {
    const c = compare(name, pairs, selection, 'two-sided')
    return c === null ? [] : [c]
  })
  const adjusted = holm(comparisons.map(c => c.p))
  const A5: Gates['A5'] = {
    status: comparisons.length === 0 ? 'not-evaluable' : 'not-applicable',
    reason:
      comparisons.length === 0
        ? 'no complete pairs on any ranked tier'
        : 'reported only; not a gate',
    comparisons: comparisons.map((c, index) => ({
      ...c,
      pHolm: adjusted[index] ?? 1,
    })),
  }

  const disagreements = pairs.filter(
    ({ m0, m1 }) => m0.first.misattributed !== m1.first.misattributed,
  )
  const A6: Gates['A6'] = {
    status: disagreements.length === 0 ? 'pass' : 'not-evaluable',
    reason:
      disagreements.length === 0
        ? null
        : 'the arms disagree on HR_mis; blinded adjudication pending',
    cases: disagreements.length,
    file: disagreements.length === 0 ? null : ADJUDICATION_FILE,
  }

  return { A0, E1, E2, A4, A5, A6 }
}

/**
 * The A6 list: every pair whose arms disagree on HR_mis, with the arms hidden
 * behind X / Y assigned by a seed from the run id. The key is a separate file.
 */
export function adjudicationList(
  records: readonly CallRecord[],
  runId: string,
  describe: {
    readonly question: (unit: Unit) => string
    readonly title: (unit: Unit, key: string) => string
  },
): Adjudication {
  const random = mulberry32(scheduleSeed(`${runId}/A6`))
  const blinded: Adjudication['blinded'][number][] = []
  const key: Adjudication['key'][number][] = []
  const pairs = completePairs(records)
    .filter(({ m0, m1 }) => m0.first.misattributed !== m1.first.misattributed)
    .sort((a, b) => {
      const ka = unitKey(a.unit)
      const kb = unitKey(b.unit)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  for (const [index, { unit, m0, m1 }] of pairs.entries()) {
    const swap = random() < 0.5
    const [x, y] = swap ? [m1, m0] : [m0, m1]
    const view = (label: 'X' | 'Y', record: CallRecord) => {
      const round = record.rounds[0]
      return {
        label,
        answerHead: round?.answerHead ?? '',
        cited: (round?.acceptedKeys ?? []).map(k => ({
          key: k,
          title: describe.title(unit, k),
        })),
      }
    }
    blinded.push({
      item: index + 1,
      corpus: unit.corpus,
      tier: unit.tier,
      queryId: unit.queryId,
      question: describe.question(unit),
      provider: unit.provider,
      rep: unit.rep,
      answers: [view('X', x), view('Y', y)],
    })
    key.push({ item: index + 1, X: x.arm, Y: y.arm })
  }
  return { blinded, key }
}

/** Why a run's numbers may not be used for a verdict. */
export function validityReasons(
  status: RunStatus,
  gates: Gates,
  corpora: readonly CorpusSection[],
): string[] {
  const reasons: string[] = []
  if (status !== 'complete') reasons.push(`run ${status}`)
  if (gates.A0.status === 'fail') {
    reasons.push('A0: the arms differ at the small tier; provider unstable')
  }
  for (const corpus of corpora) {
    if (corpus.preregisteredSha256 === null) {
      reasons.push(`R0: ${corpus.id} sha256 not preregistered`)
    } else if (corpus.preregisteredSha256 !== corpus.sha256) {
      reasons.push(`R0: ${corpus.id} sha256 differs from the preregistration`)
    }
  }
  return reasons
}

export function reportedUsage(records: readonly CallRecord[]): {
  usage: TokenUsage
  withoutUsage: number
} {
  let input = 0
  let output = 0
  let withoutUsage = 0
  for (const record of records) {
    for (const round of record.rounds) {
      if (round.usage === null) {
        withoutUsage += 1
      } else {
        input += round.usage.input
        output += round.usage.output
      }
    }
  }
  return { usage: { input, output }, withoutUsage }
}
