// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retrieval-layer criteria of `docs/dev/memory-m1.md` §9 D-1 (R1–R4),
 * as pure functions over paired per-question outcomes.
 *
 * Retrieval is deterministic, so nothing here estimates anything: for every
 * question the M0 arm either injected its gold entry or it did not, and so
 * did the M1 arm. The comparison is the exact per-question difference —
 * "lost two lexical questions, gained three zero-overlap ones" is visible as
 * two losses, not averaged away into a better pooled rate.
 *
 * Thresholds (α) are not constants here: callers pass the preregistered
 * value (`prereg.ts`). Nothing in this file defaults one.
 */

import { createHash } from 'node:crypto'
import type { FileMemoryStore, MemoryEntry } from '@qianmo/memory'
import {
  INJECTION_BUDGET,
  type InjectionBudget,
  selectForInjection,
} from '../src/inject.js'
import { rankEntries, type RankedEntry, tokensOf } from '../src/rank.js'
import { recall, type RecallScope } from '../src/recall.js'
import { mulberry32 } from './dataset.js'
import { fuseReference } from './fusion-reference.js'
import {
  type BaselineDataset,
  type BaselineQuery,
  type Materialised,
  UNBOUNDED,
} from './run.js'

/** One question under one seed and tier: did each arm inject all its gold? */
export type PairedCell = {
  readonly seed: number
  readonly tier: number
  readonly kind: string
  readonly queryId: string
  readonly m0: boolean
  readonly m1: boolean
}

export type Tally = {
  /** M1 injected gold, M0 did not. */
  readonly wins: readonly string[]
  /** M0 injected gold, M1 did not. */
  readonly losses: readonly string[]
}

export function tally(cells: readonly PairedCell[]): Tally {
  return {
    wins: cells.filter(c => c.m1 && !c.m0).map(c => c.queryId),
    losses: cells.filter(c => c.m0 && !c.m1).map(c => c.queryId),
  }
}

/**
 * Exact one-sided sign test: P(X ≥ wins) for X ~ Binomial(wins + losses,
 * 1/2). Ties (both or neither) carry no information and are not counted.
 * With zero losses, 5 wins give 0.03125 and 6 give 0.015625.
 */
export function exactSignTestOneSided(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  let coefficient = 1
  let tail = 0
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i
    if (i >= wins) tail += coefficient
  }
  return tail / 2 ** n
}

type SignVerdict = {
  readonly seed: number
  readonly wins: number
  readonly losses: number
  readonly p: number
  readonly pass: boolean
}

/**
 * R3 (and, fed the shuffled arm as M0, R4): per seed, on the given questions
 * of one tier, the exact one-sided sign test at the preregistered α.
 *
 * A question's paired difference is d = [M1 injected gold] − [M0 injected
 * gold] ∈ {−1, 0, +1}. Without `clusterOf` each question is a unit. With it
 * the unit is the cluster, and a cluster's paired difference is the mean d
 * of its questions (all of them, ties included). Either way a unit with a
 * positive difference is a win, a negative one a loss, and a zero one is
 * dropped from n. Several questions on one gold entry are not independent
 * evidence, and counting them singly lets anything that reaches that entry
 * regardless of the question score once per question.
 */
export function signGate(
  cells: readonly PairedCell[],
  options: {
    readonly tier: number
    readonly queryIds: ReadonlySet<string>
    readonly alpha: number
    readonly clusterOf?: (queryId: string) => string
  },
): readonly SignVerdict[] {
  const seeds = [...new Set(cells.map(c => c.seed))].sort((a, b) => a - b)
  return seeds.map(seed => {
    const scoped = cells.filter(
      c =>
        c.seed === seed &&
        c.tier === options.tier &&
        options.queryIds.has(c.queryId),
    )
    const unitOf = options.clusterOf ?? ((queryId: string) => queryId)
    const differences = new Map<string, number[]>()
    for (const c of scoped) {
      const unit = unitOf(c.queryId)
      const list = differences.get(unit) ?? []
      list.push(Number(c.m1) - Number(c.m0))
      differences.set(unit, list)
    }
    const means = [...differences.values()].map(
      list => list.reduce((sum, d) => sum + d, 0) / list.length,
    )
    const up = means.filter(mean => mean > 0).length
    const down = means.filter(mean => mean < 0).length
    const p = exactSignTestOneSided(up, down)
    return {
      seed,
      wins: up,
      losses: down,
      p,
      pass: p < options.alpha,
    }
  })
}

type RegressionFailure = {
  readonly seed: number
  readonly tier: number
  readonly kind: string
  readonly lost: readonly string[]
}

/**
 * R2: no question M0 answered is lost by M1, in any ranked tier, positive
 * kind or seed (b = 0). Returns every failing cell, not just the first.
 */
export function noRegression(
  cells: readonly PairedCell[],
  options: { readonly tiers: readonly number[] },
): readonly RegressionFailure[] {
  const failures: RegressionFailure[] = []
  const keys = new Set(
    cells
      .filter(c => options.tiers.includes(c.tier))
      .map(c => `${c.seed}\u0000${c.tier}\u0000${c.kind}`),
  )
  for (const key of [...keys].sort()) {
    const [seed = '', tier = '', kind = ''] = key.split('\u0000')
    const scoped = cells.filter(
      c =>
        String(c.seed) === seed && String(c.tier) === tier && c.kind === kind,
    )
    const { losses } = tally(scoped)
    if (losses.length > 0) {
      failures.push({
        seed: Number(seed),
        tier: Number(tier),
        kind,
        lost: losses,
      })
    }
  }
  return failures
}

/**
 * A fixed derangement π of the question ids (R4): question i borrows the
 * query vector of question π(i), and no question keeps its own. Sattolo's
 * algorithm on a seeded PRNG yields a single cycle, which is a derangement
 * whenever there are at least two ids.
 */
export function derangement(
  ids: readonly string[],
  seed: number,
): ReadonlyMap<string, string> {
  const sorted = [...ids].sort()
  if (sorted.length < 2) {
    throw new RangeError('derangement: need at least two question ids')
  }
  const random = mulberry32(seed)
  const order = sorted.map((_, index) => index)
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * i)
    const held = order[i] as number
    order[i] = order[j] as number
    order[j] = held
  }
  return new Map(
    sorted.map((id, index) => [id, sorted[order[index] ?? index] ?? id]),
  )
}

/** SHA-256 of a sorted id list — the held-out set's preregistration hash. */
export function idListDigest(ids: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...ids].sort()))
    .digest('hex')
}

/**
 * The full deterministic ranking of every question, reading each distinct
 * scope from the store once.
 *
 * This is `recall()`'s own sequence — `store.query` by scope and `asOf`,
 * then `rankEntries` over `tokensOf(question)` — without re-reading two
 * thousand files per question. The test suite checks it against `recall()`
 * so the shortcut cannot drift from the shipped path.
 */
export function deterministicRankings(
  store: FileMemoryStore,
  dataset: Pick<BaselineDataset, 'asOf' | 'scope' | 'queries'>,
): ReadonlyMap<string, readonly RankedEntry[]> {
  const candidatesByScope = new Map<string, readonly MemoryEntry[]>()
  const candidatesOf = (scope: RecallScope): readonly MemoryEntry[] => {
    const key = JSON.stringify(scope)
    const cached = candidatesByScope.get(key)
    if (cached !== undefined) return cached
    const fresh = store.query({
      layers: scope.layers,
      projectKey: scope.projectKey,
      taskId: scope.taskId,
      period: scope.period,
      asOf: dataset.asOf,
    })
    candidatesByScope.set(key, fresh)
    return fresh
  }
  return new Map(
    dataset.queries.map(query => [
      query.id,
      rankEntries(candidatesOf(query.scope ?? dataset.scope), {
        tokens: tokensOf(query.question),
        asOf: dataset.asOf,
      }),
    ]),
  )
}

/** Cross-check one question of {@link deterministicRankings} against `recall()`. */
export function matchesRecall(
  store: FileMemoryStore,
  dataset: Pick<BaselineDataset, 'asOf' | 'scope'>,
  query: BaselineQuery,
  ranking: readonly RankedEntry[],
): boolean {
  const shipped = recall(store, {
    question: query.question,
    scope: query.scope ?? dataset.scope,
    asOf: dataset.asOf,
    budget: UNBOUNDED,
  })
  return (
    shipped.entries.length === ranking.length &&
    shipped.entries.every(
      (ranked, index) => ranked.entry.id === ranking[index]?.entry.id,
    )
  )
}

/** A semantic stand-in that may read the question. */
type QueryScorer = (
  entries: readonly MemoryEntry[],
  question: string,
) => number[]

export type ArmSet = {
  /** Injected keys per question id, per arm. */
  readonly m0: ReadonlyMap<string, ReadonlySet<string>>
  readonly m1: ReadonlyMap<string, ReadonlySet<string>>
  /** The same fusion fed the query of π(q) instead of q (R4). */
  readonly shuffledM1: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Both arms and the shuffled control for every question of one materialised
 * dataset, through the reference fusion.
 */
export function referenceArms(
  materialised: Materialised,
  dataset: BaselineDataset,
  scorer: QueryScorer,
  permutation: ReadonlyMap<string, string>,
  budget: InjectionBudget = INJECTION_BUDGET,
): ArmSet {
  const rankings = deterministicRankings(materialised.store, dataset)
  const questionOf = new Map(dataset.queries.map(q => [q.id, q.question]))
  const keysOf = (ranked: readonly RankedEntry[]): ReadonlySet<string> =>
    new Set(ranked.map(r => materialised.keyOf(r.entry.id)))
  const m0 = new Map<string, ReadonlySet<string>>()
  const m1 = new Map<string, ReadonlySet<string>>()
  const shuffledM1 = new Map<string, ReadonlySet<string>>()
  for (const query of dataset.queries) {
    const det = rankings.get(query.id) ?? []
    const entries = det.map(r => r.entry)
    m0.set(query.id, keysOf(selectForInjection(det, budget).chosen))
    m1.set(
      query.id,
      keysOf(fuseReference(det, scorer(entries, query.question), budget)),
    )
    const donor = permutation.get(query.id)
    const donorQuestion =
      donor === undefined ? query.question : (questionOf.get(donor) ?? '')
    shuffledM1.set(
      query.id,
      keysOf(fuseReference(det, scorer(entries, donorQuestion), budget)),
    )
  }
  return { m0, m1, shuffledM1 }
}

/** Turn two arms into paired cells over the questions that have gold. */
export function pairCells(
  dataset: Pick<BaselineDataset, 'seed' | 'liveInScope' | 'queries'>,
  control: ReadonlyMap<string, ReadonlySet<string>>,
  treatment: ReadonlyMap<string, ReadonlySet<string>>,
): PairedCell[] {
  const hasGold = (
    injected: ReadonlySet<string> | undefined,
    gold: readonly string[],
  ): boolean => injected !== undefined && gold.every(key => injected.has(key))
  return dataset.queries
    .filter(query => query.gold.length > 0)
    .map(query => ({
      seed: dataset.seed,
      tier: dataset.liveInScope,
      kind: query.kind,
      queryId: query.id,
      m0: hasGold(control.get(query.id), query.gold),
      m1: hasGold(treatment.get(query.id), query.gold),
    }))
}

/** R1's leak half: forbidden entries that reached an arm's block. */
export function leaks(
  dataset: Pick<BaselineDataset, 'queries'>,
  arm: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  return dataset.queries.flatMap(query =>
    query.forbidden
      .filter(key => arm.get(query.id)?.has(key) === true)
      .map(key => `${query.id}:${key}`),
  )
}
