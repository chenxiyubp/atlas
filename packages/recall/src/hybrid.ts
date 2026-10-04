// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The semantic overlay on recall (`docs/dev/memory-m1.md` §5, P16.6).
 *
 * OVERLAY, NOT REPLACEMENT
 *
 * Everything `recall()` guarantees still holds, because `recallHybrid()` starts
 * from the very same deterministic pass (`rankForRecall`) and only ever
 * reorders its candidates:
 *
 *   - The candidate set is still scope only (I-1). Similarity is a ranking
 *     signal; it never removes an entry, and nothing outside the candidate set
 *     can be added — the index is asked about candidates, never the reverse.
 *   - Full mode is untouched (I-2). When every entry fits, there is nothing to
 *     rank for and the embedder is not even called.
 *   - In ranked mode the first ⌈|I_det| · floorRatio⌉ entries M0 would have
 *     injected are kept, in M0's order, before anything else is considered.
 *     That floor is what a poisoned index cannot move, and it is checked on
 *     every result rather than trusted.
 *   - The remaining slots are filled from the rest of the candidates by
 *     reciprocal rank fusion of the deterministic and semantic ranks, under the
 *     same budget walk (`selectForInjection`).
 *
 * TIES
 *
 * An entry with zero deterministic relevance is ordered among its peers only
 * by ingest time. Fed into RRF as-is, "newer" would count as a vote of
 * relevance, so all zero-relevance entries share one deterministic rank.
 * Similarities are rounded before ranking (same reason as `RANKING.decimals`)
 * and equal ones share a rank. Remaining RRF ties fall back to the
 * deterministic position, which is already a total order ending in the id.
 *
 * FAILURE IS M0 (I-7)
 *
 * Any failure on the semantic side — the embedder throwing, timing out or
 * answering with the wrong shape, the index or the cost meter throwing, the
 * budget running out, the index covering too little of the candidate set —
 * returns the deterministic result itself, marked `hybrid-degraded`, with the
 * reason on `retrievalEvents`. Store failures are not semantic failures: they
 * surface exactly as they do from `recall()`.
 *
 * Every parameter is a proposed value, not a measured one (§10). They are
 * configuration so they can be tuned on the development split only (D-1 R5).
 */

import type { FileMemoryStore, MemoryEntry } from '@qianmo/memory'
import {
  contentHash,
  cosine,
  type EmbeddingBatch,
  type EmbeddingProvider,
  entryEmbeddingText,
  estimateEmbeddingTokens,
  isUsableVector,
  truncateForEmbedding,
} from './embedding.js'
import {
  type InjectionBudget,
  type RetrievalMode,
  selectForInjection,
} from './inject.js'
import type { RankedEntry } from './rank.js'
import {
  type RecallRequest,
  type RecallResult,
  rankForRecall,
} from './recall.js'
import type { EmbeddingUsageMeter } from './usage.js'
import type { VectorIndex, VectorKey } from './vector-index.js'

export type HybridConfig = {
  /** Share of M0's injected set kept as the floor: ⌈|I_det| · floorRatio⌉. In (0, 1]. */
  readonly floorRatio: number
  /** The `k` of reciprocal rank fusion. */
  readonly rrfK: number
  /** Candidates without a vector that one recall may embed (index top-up). */
  readonly maxEmbedPerRecall: number
  /** Below this share of candidates with a vector, no fusion (`index-cold`). */
  readonly minIndexCoverage: number
  /** How long one recall waits for the embedder. */
  readonly timeoutMs: number
  /** Code points of query or entry text sent to the embedder. */
  readonly maxInputChars: number
  /**
   * Share of the free (non-floor) slots one `source` may take in fill order
   * (V-8). Entries over it are moved behind the others, never dropped.
   */
  readonly sourceFillShare: number
}

/** Proposed values, none measured (`memory-m1.md` §10). */
export const HYBRID_DEFAULTS: HybridConfig = {
  floorRatio: 0.5,
  rrfK: 60,
  maxEmbedPerRecall: 32,
  minIndexCoverage: 0.95,
  timeoutMs: 300,
  maxInputChars: 8_000,
  sourceFillShare: 0.5,
}

/** Merge overrides onto {@link HYBRID_DEFAULTS} and reject what cannot work. */
export function resolveHybridConfig(
  overrides: Partial<HybridConfig> = {},
): HybridConfig {
  const pick = <K extends keyof HybridConfig>(key: K): HybridConfig[K] =>
    overrides[key] ?? HYBRID_DEFAULTS[key]
  const config: HybridConfig = {
    floorRatio: pick('floorRatio'),
    rrfK: pick('rrfK'),
    maxEmbedPerRecall: pick('maxEmbedPerRecall'),
    minIndexCoverage: pick('minIndexCoverage'),
    timeoutMs: pick('timeoutMs'),
    maxInputChars: pick('maxInputChars'),
    sourceFillShare: pick('sourceFillShare'),
  }
  const rules: readonly [keyof HybridConfig, boolean, string][] = [
    [
      'floorRatio',
      config.floorRatio > 0 && config.floorRatio <= 1,
      'in (0, 1]',
    ],
    [
      'rrfK',
      Number.isFinite(config.rrfK) && config.rrfK > 0,
      'a positive number',
    ],
    [
      'maxEmbedPerRecall',
      Number.isSafeInteger(config.maxEmbedPerRecall) &&
        config.maxEmbedPerRecall >= 0,
      'a non-negative integer',
    ],
    [
      'minIndexCoverage',
      config.minIndexCoverage >= 0 && config.minIndexCoverage <= 1,
      'in [0, 1]',
    ],
    [
      'timeoutMs',
      Number.isFinite(config.timeoutMs) && config.timeoutMs > 0,
      'a positive number',
    ],
    [
      'maxInputChars',
      Number.isSafeInteger(config.maxInputChars) && config.maxInputChars >= 1,
      'a positive integer',
    ],
    [
      'sourceFillShare',
      config.sourceFillShare > 0 && config.sourceFillShare <= 1,
      'in (0, 1]',
    ],
  ]
  for (const [key, ok, rule] of rules) {
    if (!ok) {
      throw new Error(
        `hybrid recall ${key} must be ${rule}, got ${String(config[key])}`,
      )
    }
  }
  return config
}

/** What the overlay needs besides the store. */
export type SemanticRecall = {
  readonly embedder: EmbeddingProvider
  readonly index: VectorIndex
  readonly meter: EmbeddingUsageMeter
  readonly config?: Partial<HybridConfig>
}

/** Why a recall did not fuse, or fused on less than it asked for. */
export type RetrievalEvent =
  | {
      readonly type: 'index-cold'
      /** Share of candidates with a vector after this recall's top-up. */
      readonly coverage: number
      readonly minCoverage: number
      readonly candidates: number
    }
  | {
      readonly type: 'budget-exhausted'
      readonly remaining: number
      readonly needed: number
    }
  | { readonly type: 'embed-timeout'; readonly timeoutMs: number }
  | { readonly type: 'embed-failed'; readonly reason: string }
  | { readonly type: 'semantic-error'; readonly reason: string }

export type HybridRecallResult = RecallResult & {
  readonly retrieval: RetrievalMode
  /** Semantic-side events of this recall. Store events stay on `events`. */
  readonly retrievalEvents: readonly RetrievalEvent[]
  /** Ids injected only because of the fill: I_hybrid \ I_det, block order. */
  readonly semanticIds: readonly string[]
}

const SIMILARITY_DECIMALS = 6
const RRF_DECIMALS = 12
const MAX_REASON_LENGTH = 200

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length <= MAX_REASON_LENGTH
    ? text
    : `${text.slice(0, MAX_REASON_LENGTH)}…`
}

function settle(
  result: RecallResult,
  retrieval: RetrievalMode,
  events: readonly RetrievalEvent[],
): HybridRecallResult {
  return { ...result, retrieval, retrievalEvents: events, semanticIds: [] }
}

/**
 * Recall with the semantic overlay. Asynchronous only because the embedder
 * is; `recall()` stays synchronous and unchanged.
 */
export async function recallHybrid(
  store: FileMemoryStore,
  request: RecallRequest,
  semantic: SemanticRecall,
): Promise<HybridRecallResult> {
  // One instant for the whole call, fixed before the store is read — the same
  // rule `recall()` follows. The cost meter keeps its own clock: a question
  // asked "as of last month" is still paid for today.
  const asOf = request.asOf ?? new Date()
  const { result, ranked, budget } = rankForRecall(store, {
    ...request,
    asOf,
  })
  const question = request.question ?? ''
  if (
    result.mode === 'full' ||
    result.entries.length === 0 ||
    question.trim() === ''
  ) {
    return settle(result, 'deterministic', [])
  }

  const events: RetrievalEvent[] = []
  try {
    const fused = await fuse(result, ranked, budget, question, semantic, events)
    return fused ?? settle(result, 'hybrid-degraded', events)
  } catch (error) {
    events.push({ type: 'semantic-error', reason: describe(error) })
    return settle(result, 'hybrid-degraded', events)
  }
}

type Candidate = {
  readonly ranked: RankedEntry
  readonly text: string
  readonly key: VectorKey
}

async function fuse(
  deterministic: RecallResult,
  ranked: readonly RankedEntry[],
  budget: InjectionBudget,
  question: string,
  semantic: SemanticRecall,
  events: RetrievalEvent[],
): Promise<HybridRecallResult | undefined> {
  const config = resolveHybridConfig(semantic.config)
  const { embedder, index, meter } = semantic

  // 1. What the index already holds — asked about candidates only.
  const vectors = new Map<string, readonly number[]>()
  const missing: Candidate[] = []
  for (const entry of ranked) {
    const text = entryEmbeddingText(entry.entry, config.maxInputChars)
    const key = keyOf(embedder, entry.entry, contentHash(text))
    const stored = index.get(key)
    if (isUsableVector(stored, embedder.dimensions)) {
      vectors.set(entry.entry.id, stored)
    } else {
      missing.push({ ranked: entry, text, key })
    }
  }

  // 2. Plan one call: the query, when fusion can happen at all, and top-ups,
  //    both inside what the meter still allows today.
  const covered = (count: number): boolean =>
    count / ranked.length >= config.minIndexCoverage
  let allowance = meter.remaining()
  const queryText = truncateForEmbedding(question, config.maxInputChars)
  const queryCost = estimateEmbeddingTokens(queryText)
  const topUpLimit = Math.min(missing.length, config.maxEmbedPerRecall)
  let withQuery = covered(vectors.size + topUpLimit)
  if (withQuery && queryCost > allowance) {
    events.push({
      type: 'budget-exhausted',
      remaining: allowance,
      needed: queryCost,
    })
    withQuery = false
  } else if (withQuery) {
    allowance -= queryCost
  }
  const topUp: Candidate[] = []
  let reserved = withQuery ? queryCost : 0
  for (const candidate of missing.slice(0, topUpLimit)) {
    const cost = estimateEmbeddingTokens(candidate.text)
    if (cost > allowance) {
      if (!events.some(event => event.type === 'budget-exhausted')) {
        events.push({
          type: 'budget-exhausted',
          remaining: allowance,
          needed: cost,
        })
      }
      break
    }
    allowance -= cost
    reserved += cost
    topUp.push(candidate)
  }
  if (!covered(vectors.size + topUp.length)) {
    events.push({
      type: 'index-cold',
      coverage: round((vectors.size + topUp.length) / ranked.length, 4),
      minCoverage: config.minIndexCoverage,
      candidates: ranked.length,
    })
    if (withQuery) reserved -= queryCost
    withQuery = false
  }

  const texts = [
    ...(withQuery ? [queryText] : []),
    ...topUp.map(candidate => candidate.text),
  ]
  if (texts.length === 0) return undefined

  // 3. The call. Paid for before it is made: a process that dies waiting has
  //    still spent the tokens.
  meter.charge(reserved)
  const answer = await embedWithin(embedder, texts, config.timeoutMs)
  if ('event' in answer) {
    events.push(answer.event)
    return undefined
  }
  // Checked, not trusted: an adapter is outside this package and its answer
  // is only data until it has the shape the fusion needs.
  const batch: unknown = answer.batch
  const vectorsOf = (value: unknown): unknown =>
    typeof value === 'object' && value !== null
      ? (value as { vectors?: unknown }).vectors
      : undefined
  const received = vectorsOf(batch)
  if (
    !Array.isArray(received) ||
    received.length !== texts.length ||
    !received.every(vector => isUsableVector(vector, embedder.dimensions))
  ) {
    events.push({
      type: 'embed-failed',
      reason: `expected ${texts.length} vectors of ${embedder.dimensions} finite numbers`,
    })
    return undefined
  }
  const answered = received as readonly (readonly number[])[]
  const billed = answer.batch.usage?.tokens
  if (typeof billed === 'number' && Number.isFinite(billed) && billed >= 0) {
    meter.charge(billed - reserved)
  }
  const offset = withQuery ? 1 : 0
  for (const [position, candidate] of topUp.entries()) {
    const vector = answered[offset + position] as readonly number[]
    index.set(candidate.key, vector)
    vectors.set(candidate.ranked.entry.id, vector)
  }
  if (!withQuery) return undefined

  return {
    ...deterministic,
    ...fill(
      deterministic,
      ranked,
      budget,
      vectors,
      answered[0] as readonly number[],
      config,
    ),
    retrieval: 'hybrid',
    retrievalEvents: events,
  }
}

function keyOf(
  embedder: EmbeddingProvider,
  entry: MemoryEntry,
  hash: string,
): VectorKey {
  return {
    entryId: entry.id,
    contentHash: hash,
    providerId: embedder.id,
    model: embedder.model,
    dimensions: embedder.dimensions,
  }
}

async function embedWithin(
  embedder: EmbeddingProvider,
  texts: readonly string[],
  timeoutMs: number,
): Promise<
  { readonly batch: EmbeddingBatch } | { readonly event: RetrievalEvent }
> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const call = Promise.resolve().then(() =>
      embedder.embed(texts, { signal: controller.signal }),
    )
    // A rejection that lands after the timeout has nobody left to hear it.
    call.catch(() => undefined)
    const winner = await Promise.race([call, expired])
    if (winner === 'timeout') {
      controller.abort()
      return { event: { type: 'embed-timeout', timeoutMs } }
    }
    return { batch: winner }
  } catch (error) {
    return { event: { type: 'embed-failed', reason: describe(error) } }
  } finally {
    clearTimeout(timer)
  }
}

/** Floor, then RRF fill, then the M0 budget walk. */
function fill(
  deterministic: RecallResult,
  ranked: readonly RankedEntry[],
  budget: InjectionBudget,
  vectors: ReadonlyMap<string, readonly number[]>,
  query: readonly number[],
  config: HybridConfig,
): Pick<
  HybridRecallResult,
  'mode' | 'entries' | 'omittedCount' | 'semanticIds'
> {
  const injected = deterministic.entries
  const floorCount = Math.ceil(injected.length * config.floorRatio)
  const floor = injected.slice(0, floorCount)
  const floorIds = new Set(floor.map(entry => entry.entry.id))

  const relevant = ranked.filter(entry => entry.relevance > 0).length
  const similarity = new Map<string, number>()
  for (const entry of ranked) {
    const vector = vectors.get(entry.entry.id)
    if (vector !== undefined) {
      similarity.set(
        entry.entry.id,
        round(cosine(query, vector), SIMILARITY_DECIMALS),
      )
    }
  }
  // Competition ranking: equal similarities share the best rank among them.
  const semanticRankOf = new Map<number, number>()
  for (const [position, value] of [...similarity.values()]
    .sort((a, b) => b - a)
    .entries()) {
    if (!semanticRankOf.has(value)) semanticRankOf.set(value, position + 1)
  }
  const unranked = similarity.size + 1

  const k = config.rrfK
  const rest = ranked
    .map((entry, position) => {
      const deterministicRank =
        entry.relevance > 0 ? position + 1 : relevant + 1
      const value = similarity.get(entry.entry.id)
      const semanticRank =
        value === undefined ? unranked : (semanticRankOf.get(value) ?? unranked)
      return {
        entry,
        position,
        score: round(
          1 / (k + deterministicRank) + 1 / (k + semanticRank),
          RRF_DECIMALS,
        ),
      }
    })
    .filter(item => !floorIds.has(item.entry.entry.id))
    // Position is unique, so this is a total order (§5.1's final id rule is
    // already inside it, via `compareRanked`).
    .sort((a, b) => b.score - a.score || a.position - b.position)

  // V-8: one source may not monopolise the free slots. Over the share, an
  // entry moves behind everything else instead of leaving — with one source
  // only, nothing moves and the block keeps its size.
  const perSource = Math.ceil(
    (injected.length - floorCount) * config.sourceFillShare,
  )
  const taken = new Map<string, number>()
  const kept: RankedEntry[] = []
  const deferred: RankedEntry[] = []
  for (const { entry } of rest) {
    const source = `${entry.entry.source.kind}:${entry.entry.source.id}`
    const count = taken.get(source) ?? 0
    if (count < perSource) {
      taken.set(source, count + 1)
      kept.push(entry)
    } else {
      deferred.push(entry)
    }
  }

  const selection = selectForInjection([...floor, ...kept, ...deferred], budget)
  const chosen = new Set(selection.chosen.map(entry => entry.entry.id))
  if (!floor.every(entry => chosen.has(entry.entry.id))) {
    // Unreachable by construction (the floor is a prefix of a selection that
    // already fit this budget). Checked anyway: it is the property that makes
    // this an overlay, and a violation must degrade, not ship.
    throw new Error('floor quota not preserved by the fused selection')
  }
  const deterministicIds = new Set(injected.map(entry => entry.entry.id))
  return {
    mode: selection.mode,
    entries: selection.chosen,
    omittedCount: selection.omittedCount,
    semanticIds: selection.chosen
      .map(entry => entry.entry.id)
      .filter(id => !deterministicIds.has(id)),
  }
}
