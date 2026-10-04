// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 检索唤醒 — the query half of charter §1.5's two motions, and the entry point
 * of roadmap P3.3.
 *
 * WHAT IS *NOT* USED, AND WHY THAT IS THE DESIGN
 *
 * `@qianmo/memory`'s query supports `text` and `tags` filters. Recall passes
 * neither. Candidates are selected by **scope only** — layer, project, task,
 * period — because those are the store's table partitions, facts about where a
 * record lives rather than guesses about what a question meant. A word filter
 * here would reinstate exactly the failure D-6 measured: question wording that
 * misses the entry's wording returns zero rows, and zero rows is an answer with
 * no memory at all. Tags and keywords are ranking signals (`rank.ts`), never
 * gates.
 *
 * ONLY LIVE ENTRIES, EVERY TIME
 *
 * `query()` is called without `includeRetired`, so a revoked record is gone
 * from the very next recall — the ingest axis is not a point-in-time question
 * and no `asOf` brings it back. Nothing here caches: the block is rebuilt from
 * disk on each call, which is what makes 「废止后必须重投」 automatic rather
 * than a procedure someone has to remember.
 *
 * FAILURES ARE CARRIED OUT, NOT SWALLOWED
 *
 * The store returns partial results and records what it could not read on its
 * event channel. This function lifts those records onto the result
 * ({@link RecallResult.events}) and raises {@link RecallResult.degraded}. That
 * lift is the point: the store was fixed so one corrupt file could not take
 * recall down, and re-burying the report in the layer above would restore the
 * silence the fix removed — a node waking with less memory than it has, and
 * nothing anywhere saying so.
 */

import {
  MemoryEventType,
  type FileMemoryStore,
  type MemoryEvent,
  type MemoryLayer,
} from '@qianmo/memory'
import {
  INJECTION_BUDGET,
  selectForInjection,
  type InjectionBudget,
  type InjectionMode,
  type InjectionView,
} from './inject.js'
import { rankEntries, tokensOf, type RankedEntry } from './rank.js'

/** Which tables to look in. Mirrors the store's own scope keys. */
export type RecallScope = {
  readonly layers?: readonly MemoryLayer[]
  readonly projectKey?: string
  readonly taskId?: string
  readonly period?: string
}

export type RecallRequest = {
  /** The question, verbatim. Tokenised for ranking; never used as a filter. */
  readonly question?: string
  /** Tags to reward in ranking. Not required to be present on an entry. */
  readonly tags?: readonly string[]
  readonly scope?: RecallScope
  /** Validity point and decay origin. Defaults to the store's clock via `now`. */
  readonly asOf?: Date
  readonly halfLifeMs?: number
  readonly budget?: Partial<InjectionBudget>
}

export type RecallResult = InjectionView & {
  readonly asOf: string
  readonly mode: InjectionMode
  readonly entries: readonly RankedEntry[]
  /** Live entries in scope before the budget was applied. */
  readonly candidateCount: number
  readonly omittedCount: number
  /** The ranking tokens, so a ranking decision can be explained after the fact. */
  readonly tokens: readonly string[]
  /** Store events recorded during *this* recall. Empty on a clean scan. */
  readonly events: readonly MemoryEvent[]
  readonly degraded: boolean
}

/** Event types that mean recall itself returned less than the store holds. */
const DEGRADING = new Set<MemoryEventType>([
  MemoryEventType.EntryUnreadable,
  MemoryEventType.LayerUnreadable,
])

/**
 * Run `scan` and return the events it produced.
 *
 * The recorder is a bounded ring shared by every caller of the store, so the
 * new events are found by locating the last previously-seen record **by
 * identity** rather than by counting. When that record has already been evicted
 * — a scan that produced more failures than the ring holds — the whole ring is
 * returned instead. Over-reporting on a failure channel is recoverable;
 * under-reporting is the silence this channel exists to prevent.
 */
function captureEvents<T>(
  store: FileMemoryStore,
  scan: () => T,
): { value: T; events: readonly MemoryEvent[] } {
  const before = store.events.all()
  const marker = before[before.length - 1]
  const value = scan()
  const after = store.events.all()
  if (marker === undefined) {
    return { value, events: after }
  }
  const index = after.lastIndexOf(marker)
  return { value, events: index === -1 ? after : after.slice(index + 1) }
}

/**
 * The deterministic pass, with the full ranking kept alongside the result.
 *
 * `recall()` is this function's `result` and nothing else, so the semantic
 * overlay (`hybrid.ts`) and the deterministic path cannot disagree about what
 * M0 would have injected: there is one implementation of it, not two.
 */
export function rankForRecall(
  store: FileMemoryStore,
  request: RecallRequest = {},
): {
  readonly result: RecallResult
  /** Every live candidate in scope, in deterministic order. */
  readonly ranked: readonly RankedEntry[]
  readonly budget: InjectionBudget
} {
  const scope = request.scope ?? {}
  // One instant for the whole recall, resolved before anything reads the disk.
  // The validity filter and the decay origin must be the same moment: if the
  // store answered from its clock while ranking measured age against another,
  // an entry could be admitted as current and aged as stale in the same call.
  const asOf = request.asOf ?? new Date()
  const { value: candidates, events } = captureEvents(store, () =>
    store.query({
      layers: scope.layers,
      projectKey: scope.projectKey,
      taskId: scope.taskId,
      period: scope.period,
      asOf,
    }),
  )

  const tokens = tokensOf(request.question)
  const ranked = rankEntries(candidates, {
    tags: request.tags,
    tokens,
    asOf,
    halfLifeMs: request.halfLifeMs,
  })

  const budget: InjectionBudget = {
    maxEntries: request.budget?.maxEntries ?? INJECTION_BUDGET.maxEntries,
    maxChars: request.budget?.maxChars ?? INJECTION_BUDGET.maxChars,
  }
  const selection = selectForInjection(ranked, budget)

  return {
    result: {
      asOf: asOf.toISOString(),
      mode: selection.mode,
      entries: selection.chosen,
      candidateCount: candidates.length,
      omittedCount: selection.omittedCount,
      tokens,
      events,
      degraded: events.some(event => DEGRADING.has(event.type)),
    },
    ranked,
    budget,
  }
}

export function recall(
  store: FileMemoryStore,
  request: RecallRequest = {},
): RecallResult {
  return rankForRecall(store, request).result
}

/** The ids the model was actually shown. The verifier's allow-list. */
export function injectedIds(result: RecallResult): ReadonlySet<string> {
  return new Set(result.entries.map(ranked => ranked.entry.id))
}
