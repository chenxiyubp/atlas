// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A reference model of the §5.1 fusion, for the evaluation harness only.
 *
 * `docs/dev/memory-m1.md` §5.1 (v1.0) fixes how a semantic ranking is laid
 * over the deterministic one: full mode is left alone; otherwise the first
 * ⌈|I_det|/2⌉ entries of the deterministic block are kept as a floor and the
 * remaining candidates are ordered by reciprocal-rank fusion (k = 60) of the
 * deterministic and the semantic rank, entries with zero deterministic
 * relevance sharing one tied rank, RRF ties broken by deterministic rank and
 * then by id; the result goes through the same `selectForInjection` budget.
 *
 * The production version is P16.6's job and does not exist yet. This one
 * exists so the corpus can be tested *before* it does: P16.2b's acceptance is
 * that a ranker which never reads the question cannot pass the retrieval
 * criteria through this fusion. When P16.6 lands, its `recallHybrid` replaces
 * this as the M1 arm, and the two should agree on the same semantic order.
 *
 * Also here: the "null" rankers — semantic stand-ins that look at the entries
 * only, never at the question or at any label. The review's outlier ranker is
 * the first of them, transcribed as it ran (`review-P16.md` §3.2).
 */

import type { MemoryEntry } from '@qianmo/memory'
import {
  INJECTION_BUDGET,
  type InjectionBudget,
  selectForInjection,
} from '../src/inject.js'
import type { RankedEntry } from '../src/rank.js'

/** §5.1's proposed RRF constant. A proposal, not a measured value (§10). */
const REFERENCE_RRF_K = 60

/**
 * Fuse a deterministic ranking with semantic scores.
 *
 * @param detRanked The full deterministic ranking over the candidate set —
 *   what `recall()` returns with an unbounded budget.
 * @param semScores One score per entry of `detRanked`, same order, higher is
 *   better.
 */
export function fuseReference(
  detRanked: readonly RankedEntry[],
  semScores: readonly number[],
  budget: InjectionBudget = INJECTION_BUDGET,
  k: number = REFERENCE_RRF_K,
): readonly RankedEntry[] {
  if (semScores.length !== detRanked.length) {
    throw new Error('fuseReference: one semantic score per candidate')
  }
  const deterministic = selectForInjection(detRanked, budget).chosen
  if (deterministic.length === detRanked.length) return deterministic
  const floorSize = Math.ceil(deterministic.length / 2)
  const floorIds = new Set(
    deterministic.slice(0, floorSize).map(ranked => ranked.entry.id),
  )
  // Competition ranking for the zero-relevance tail: every entry the
  // deterministic ranker had no signal for shares the first rank after the
  // last entry it did have a signal for. Otherwise RRF would read "newer" as
  // a vote of relevance (§5.1 平局规则).
  const zeroRank = 1 + detRanked.filter(ranked => ranked.relevance > 0).length
  const detRank = detRanked.map((ranked, index) =>
    ranked.relevance > 0 ? index + 1 : zeroRank,
  )
  const semOrder = detRanked
    .map((_, index) => index)
    .sort(
      (a, b) =>
        (semScores[b] ?? 0) - (semScores[a] ?? 0) ||
        a - b /* deterministic index */,
    )
  const semRank = new Array<number>(detRanked.length)
  for (const [rank, index] of semOrder.entries()) semRank[index] = rank + 1
  const rest = detRanked
    .map((ranked, index) => ({
      ranked,
      index,
      rrf:
        1 / (k + (detRank[index] ?? zeroRank)) +
        1 / (k + (semRank[index] ?? detRanked.length)),
    }))
    .filter(item => !floorIds.has(item.ranked.entry.id))
    .sort((a, b) => b.rrf - a.rrf || a.index - b.index)
  return selectForInjection(
    [...deterministic.slice(0, floorSize), ...rest.map(item => item.ranked)],
    budget,
  ).chosen
}

/** A semantic stand-in: one score per entry, higher is better. */
type EntryScorer = (entries: readonly MemoryEntry[]) => number[]

const textOf = (entry: MemoryEntry): string =>
  `${entry.title}\n${entry.summary}\n${entry.body}`

type Bag = Map<string, number>

function unigramBag(text: string): Bag {
  const bag: Bag = new Map()
  const lower = text.toLowerCase()
  for (const ch of lower.match(/[㐀-鿿]/gu) ?? []) {
    bag.set(ch, (bag.get(ch) ?? 0) + 1)
  }
  for (const word of lower.match(/[a-z0-9.]{2,}/g) ?? []) {
    bag.set(word, (bag.get(word) ?? 0) + 1)
  }
  return bag
}

function bigramBag(text: string): Bag {
  const bag: Bag = new Map()
  for (const run of text.toLowerCase().match(/[㐀-鿿]+/gu) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      bag.set(gram, (bag.get(gram) ?? 0) + 1)
    }
  }
  return bag
}

function cosine(a: Bag, b: Bag): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [key, value] of a) {
    normA += value * value
    const other = b.get(key)
    if (other !== undefined) dot += value * other
  }
  for (const value of b.values()) normB += value * value
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0
}

function outlier(bagOf: (text: string) => Bag): EntryScorer {
  return entries => {
    const bags = entries.map(entry => bagOf(textOf(entry)))
    const centroid: Bag = new Map()
    for (const bag of bags) {
      for (const [key, value] of bag) {
        centroid.set(key, (centroid.get(key) ?? 0) + value)
      }
    }
    return bags.map(bag => -cosine(bag, centroid))
  }
}

/**
 * Rankers that never read the question and never read a label. Anything they
 * gain over M0 is gained from how entries look, not from what was asked.
 */
export const NULL_RANKERS: Readonly<Record<string, EntryScorer>> = {
  /** The review's ranker: negative cosine to the character-unigram centroid. */
  'outlier-unigram': outlier(unigramBag),
  /** The same idea over CJK bigrams. */
  'outlier-bigram': outlier(bigramBag),
  /** Shortest entries first. */
  'length-short': entries => entries.map(entry => -textOf(entry).length),
  /** Longest entries first. */
  'length-long': entries => entries.map(entry => textOf(entry).length),
}

/**
 * Score a candidate set once and answer every later call over the same set
 * from the cache. A query-independent scorer sees the same candidates for
 * every question of a scope, only in a different order, so recomputing a
 * centroid per question is pure cost. Make one per dataset: ids repeat
 * across materialised datasets, contents do not.
 */
export function memoizeForCandidateSet(scorer: EntryScorer): EntryScorer {
  let cache: Map<string, number> | null = null
  return entries => {
    const known = cache
    if (
      known === null ||
      known.size !== entries.length ||
      entries.some(entry => !known.has(entry.id))
    ) {
      const scores = scorer(entries)
      cache = new Map(entries.map((entry, i) => [entry.id, scores[i] ?? 0]))
    }
    const current = cache
    return entries.map(entry => current?.get(entry.id) ?? 0)
  }
}
