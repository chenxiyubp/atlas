// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Retrieval-layer metrics, as pure functions over id lists.
 *
 * Definitions are the ones in `docs/dev/memory-m1.md` §2.1; this file is where
 * they are executable. One convention runs through all of them: a query with
 * no gold entry has **no** recall — the functions return `null`, and averages
 * skip nulls. Scoring such a query as 0 or as 1 would let the mix of negative
 * queries in a dataset move a positive-query metric.
 */

/** |gold ∩ ranking[0..k)| / |gold|, or `null` when there is no gold. */
export function recallAtK(
  ranking: readonly string[],
  gold: readonly string[],
  k: number,
): number | null {
  if (gold.length === 0) return null
  const top = new Set(ranking.slice(0, Math.max(0, k)))
  return countIn(top, gold) / new Set(gold).size
}

/** 1 / rank of the first gold id; 0 when none is ranked; `null` without gold. */
export function reciprocalRank(
  ranking: readonly string[],
  gold: readonly string[],
): number | null {
  if (gold.length === 0) return null
  const wanted = new Set(gold)
  const index = ranking.findIndex(id => wanted.has(id))
  return index === -1 ? 0 : 1 / (index + 1)
}

/**
 * |gold ∩ selected| / |gold| — used both for the candidate set (candidate
 * recall) and for the injected block (injection coverage).
 */
export function coverage(
  selected: readonly string[],
  gold: readonly string[],
): number | null {
  if (gold.length === 0) return null
  return countIn(new Set(selected), gold) / new Set(gold).size
}

/** How many forbidden ids are present in `selected`. */
export function leakCount(
  selected: readonly string[],
  forbidden: readonly string[],
): number {
  return countIn(new Set(selected), forbidden)
}

/** 1-based rank of each gold id in `ranking`, `null` for an absent one. */
export function ranksOf(
  ranking: readonly string[],
  gold: readonly string[],
): readonly (number | null)[] {
  return gold.map(id => {
    const index = ranking.indexOf(id)
    return index === -1 ? null : index + 1
  })
}

/** Mean of the non-null values; `null` when there are none. */
export function meanOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return present.reduce((sum, value) => sum + value, 0) / present.length
}

/** Fixed-precision rounding so a report diff shows changes, not float noise. */
export function round4(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000
}

function countIn(set: ReadonlySet<string>, ids: readonly string[]): number {
  let count = 0
  for (const id of new Set(ids)) {
    if (set.has(id)) count += 1
  }
  return count
}
