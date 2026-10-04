// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The embedding contract of the semantic overlay (`docs/dev/memory-m1.md`
 * §5.2, P16.6).
 *
 * PLAIN DATA, NO VENDOR
 *
 * Same rule as the tool declaration in `tool.ts` (I-5): the interface names no
 * SDK, no endpoint and no vendor. A provider is an id, a model string, a
 * dimension count and one batch call. A local model and a remote embeddings
 * endpoint are both adapters behind this shape (P16.7); nothing in this package
 * knows which one it is talking to, so switching between them is a
 * configuration change and never a code change here.
 *
 * WHAT GETS EMBEDDED
 *
 * An entry's text is its title, summary, tags and body — the same fields
 * `rank.ts` reads, so the two rankings look at the same evidence. The text is
 * cut to a fixed number of code points before it is hashed or sent, which
 * makes the index key describe exactly what was embedded: change the cut, and
 * every key changes with it instead of silently reusing vectors of a different
 * input.
 */

import { createHash } from 'node:crypto'
import type { MemoryEntry } from '@qianmo/memory'
import { CJK_CLASS } from './tokenize.js'

/** One batch answer. `vectors[i]` belongs to `texts[i]`. */
export type EmbeddingBatch = {
  readonly vectors: readonly (readonly number[])[]
  /**
   * Tokens the provider billed for this batch, when it reports them. Absent,
   * the caller charges {@link estimateEmbeddingTokens} instead.
   */
  readonly usage?: { readonly tokens: number }
}

export type EmbeddingProvider = {
  /** Stable identity of the configured provider. Part of every index key. */
  readonly id: string
  readonly model: string
  readonly dimensions: number
  /**
   * Embed a batch. Must resolve with exactly one vector per text, each of
   * `dimensions` finite numbers. Anything else is treated as a failed call.
   *
   * `signal` is aborted when the caller stops waiting (timeout). A provider
   * that ignores it is still safe — its late answer is discarded — but keeps
   * spending until it finishes.
   */
  embed(
    texts: readonly string[],
    options: { readonly signal: AbortSignal },
  ): Promise<EmbeddingBatch>
}

/** Cut `text` to at most `maxChars` code points. */
export function truncateForEmbedding(text: string, maxChars: number): string {
  const points = Array.from(text)
  return points.length <= maxChars ? text : points.slice(0, maxChars).join('')
}

/** The text an entry is embedded as. */
export function entryEmbeddingText(
  entry: MemoryEntry,
  maxChars: number,
): string {
  return truncateForEmbedding(
    [entry.title, entry.summary, entry.tags.join(' '), entry.body].join('\n'),
    maxChars,
  )
}

/**
 * The content half of an index key: SHA-256 of the exact embedded text.
 *
 * Entries are not rewritten in place today, but the key does not rely on it —
 * a vector whose input no longer matches is simply a vector for another text.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Cosine similarity. Zero when either side has no length, so a degenerate
 * vector ranks as "unrelated" instead of producing `NaN`.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

/** True when `vector` has `dimensions` entries and every one is finite. */
export function isUsableVector(
  vector: unknown,
  dimensions: number,
): vector is readonly number[] {
  return (
    Array.isArray(vector) &&
    vector.length === dimensions &&
    vector.every(value => typeof value === 'number' && Number.isFinite(value))
  )
}

/** Ideographs, kana and Hangul: roughly one token per character. */
const DENSE_CHARACTER = new RegExp(`[${CJK_CLASS}\\uac00-\\ud7af]`, 'u')

/**
 * Upper-end token estimate for one text, used to reserve budget before a call
 * and as the charge when a provider reports no usage.
 *
 * Dense scripts count one token per character and everything else one per 2.5
 * characters — the pessimistic ends of the ranges `memory-m1.md` §10 used for
 * its own estimates. Deliberately model-free: a tokenizer would tie the cost
 * cap to one vendor's vocabulary.
 */
export function estimateEmbeddingTokens(text: string): number {
  let dense = 0
  let other = 0
  for (const character of text) {
    if (DENSE_CHARACTER.test(character)) dense += 1
    else other += 1
  }
  return dense + Math.ceil((other * 2) / 5)
}
