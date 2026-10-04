// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The deterministic ranking of roadmap P3.3: 标签匹配 + 关键词 + 时间衰减排序.
 *
 * Three properties are load bearing, in this order:
 *
 *   1. **No model in the path.** Charter N-8 trades recall quality for
 *      explainability in M0. Every number below can be recomputed by hand from
 *      the entry and the question.
 *   2. **Relevance dominates recency.** Decay is a *multiplier* on relevance,
 *      never an addend, so a fresh entry that matches nothing can never
 *      outrank a stale entry that matches. An additive freshness bonus would
 *      make the top of the list drift as wall-clock time passes, which for a
 *      resident node that wakes weeks later is a silent recall regression.
 *   3. **Total order, no ties left to chance.** Score, then ingest time, then
 *      id — the same tie-break `@qianmo/memory`'s own scan uses. Directory read
 *      order never reaches an answer, so a citation a reviewer reproduces
 *      points at the entry the agent actually saw.
 *
 * Ranking is *not* filtering. Nothing here removes an entry from the candidate
 * set; a zero score only means "sorted last". Filtering on a word match is
 * exactly the failure D-6 measured, and `recall.ts` is where the full-injection
 * answer to it lives.
 */

import type { MemoryEntry } from '@qianmo/memory'
import { tokenize } from './tokenize.js'

/**
 * Ranking constants.
 *
 * These are recall-layer policy, not protocol values: they bound nothing that
 * crosses a node boundary, so `@qianmo/protocol`'s `LIMITS` (hops, envelope
 * bytes, TTLs, rate budget) is not their home. Changing one changes the order
 * of an injected block and nothing else on the wire.
 */
export const RANKING = {
  /** An explicit tag hit is worth more than any wording coincidence. */
  tagWeight: 4,
  /** Token found in title / summary / tags — the curated part of the entry. */
  headTokenWeight: 2,
  /** Token found only in the body. */
  bodyTokenWeight: 1,
  /** Relevance halves every 30 days of ingest age. */
  defaultHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
  /**
   * Scores are rounded to this many decimals before comparison. Decay is a
   * `Math.pow`, and two entries that "should" tie must actually tie, or the
   * order would depend on the last bit of a float.
   */
  decimals: 6,
} as const

export type RankedEntry = {
  readonly entry: MemoryEntry
  /** `relevance * recency`, rounded to {@link RANKING.decimals}. */
  readonly score: number
  /** Weighted tag and token hits, before decay. */
  readonly relevance: number
  /** Decay multiplier in `(0, 1]`. */
  readonly recency: number
  readonly matchedTags: readonly string[]
  readonly matchedTokens: readonly string[]
}

export type RankingInput = {
  /** Query tags. Matched against the entry's normalised tag list. */
  readonly tags?: readonly string[]
  /** Pre-tokenised query terms. See {@link tokenize}. */
  readonly tokens?: readonly string[]
  /** The point the decay is measured from. Required — never `Date.now()` here. */
  readonly asOf: Date
  readonly halfLifeMs?: number
}

function round(value: number): number {
  const factor = 10 ** RANKING.decimals
  return Math.round(value * factor) / factor
}

function headTextOf(entry: MemoryEntry): string {
  return [entry.title, entry.summary, entry.tags.join(' ')]
    .join('\n')
    .toLowerCase()
}

/**
 * Decay by ingest age.
 *
 * Clamped at 1 for entries whose `createdAt` is in the future relative to
 * `asOf` (an entry written by a node whose clock ran ahead must not be
 * *promoted* for it), and at 1 for a timestamp that will not parse — an
 * unreadable date is a reason to look, not a reason to bury the record.
 */
export function recencyFactor(
  entry: MemoryEntry,
  asOf: Date,
  halfLifeMs: number = RANKING.defaultHalfLifeMs,
): number {
  const created = Date.parse(entry.createdAt)
  if (!Number.isFinite(created) || halfLifeMs <= 0) {
    return 1
  }
  const age = asOf.getTime() - created
  if (!(age > 0)) {
    return 1
  }
  return 0.5 ** (age / halfLifeMs)
}

export function scoreEntry(
  entry: MemoryEntry,
  input: RankingInput,
): RankedEntry {
  const matchedTags: string[] = []
  for (const raw of input.tags ?? []) {
    const tag = raw.trim().toLowerCase()
    if (
      tag.length > 0 &&
      entry.tags.includes(tag) &&
      !matchedTags.includes(tag)
    ) {
      matchedTags.push(tag)
    }
  }

  const head = headTextOf(entry)
  const body = entry.body.toLowerCase()
  const matchedTokens: string[] = []
  let tokenScore = 0
  for (const token of input.tokens ?? []) {
    if (head.includes(token)) {
      tokenScore += RANKING.headTokenWeight
      matchedTokens.push(token)
    } else if (body.includes(token)) {
      tokenScore += RANKING.bodyTokenWeight
      matchedTokens.push(token)
    }
  }

  const relevance = matchedTags.length * RANKING.tagWeight + tokenScore
  const recency = recencyFactor(entry, input.asOf, input.halfLifeMs)
  return {
    entry,
    score: round(relevance * recency),
    relevance,
    recency: round(recency),
    matchedTags,
    matchedTokens,
  }
}

/** Score desc, then ingest time desc, then id asc. A total order. */
export function compareRanked(a: RankedEntry, b: RankedEntry): number {
  if (a.score !== b.score) {
    return a.score < b.score ? 1 : -1
  }
  if (a.entry.createdAt !== b.entry.createdAt) {
    return a.entry.createdAt < b.entry.createdAt ? 1 : -1
  }
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
}

export function rankEntries(
  entries: readonly MemoryEntry[],
  input: RankingInput,
): RankedEntry[] {
  return entries.map(entry => scoreEntry(entry, input)).sort(compareRanked)
}

/** Convenience for callers holding free text rather than tokens. */
export function tokensOf(question: string | undefined): readonly string[] {
  return question === undefined ? [] : tokenize(question)
}
