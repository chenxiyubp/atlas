// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The M1 arm of the answer-layer eval: P16.6's `recallHybrid` behind the
 * executor's `ArmRetriever`, fed by one of two embedders that never touch a
 * network.
 *
 *   replay     the vectors recorded with a run (`docs/dev/memory-m1.md`:
 *              query and entry vectors are filed with the report, and
 *              recomputing from them must be byte-identical), looked up by the
 *              SHA-256 of the exact text embedded. A text that was not recorded
 *              is an error, never a made-up vector.
 *   stand-in   the dry run's: a vector drawn from the text's hash. It is not
 *              semantic. It only lets the dry run build the M1 arm's own block
 *              — the hybrid header, the `via: semantic` marks, the entries the
 *              fill brings in — instead of sizing M1 with M0's prompt.
 *
 * A live embedder is P16.7's adapter; until it exists the command line refuses
 * the M1 arm with `--live`.
 *
 * THE INDEX IS WARM BEFORE THE FIRST QUESTION
 *
 * P16.6's coverage gate (95 %) turns a cold index into M0 (`index-cold`).
 * Production fills the index with P16.8's backfill command; the eval fills it
 * itself, once per materialised tier, with every live entry, keyed the way
 * `vector-index.ts` defines a key: entry id, SHA-256 of the embedded text
 * (`entryEmbeddingText` cut at the config's `maxInputChars`), provider id,
 * model, dimensions. Should `hybrid.ts` ever key differently, every lookup
 * misses, the recall degrades, and the rule below stops the run.
 *
 * A DEGRADED M1 IS NOT M1
 *
 * In production a semantic-side failure quietly returns the deterministic
 * block (I-7). In the eval that would score M0 under M1's name, so a
 * `hybrid-degraded` result stops the run with its reasons.
 */

import { createHash } from 'node:crypto'
import type { FileMemoryStore } from '@qianmo/memory'
import {
  contentHash,
  type EmbeddingProvider,
  entryEmbeddingText,
  estimateEmbeddingTokens,
  isUsableVector,
} from '../../src/embedding.js'
import { recallHybrid, resolveHybridConfig } from '../../src/hybrid.js'
import type { EmbeddingUsageMeter } from '../../src/usage.js'
import { InMemoryVectorIndex } from '../../src/vector-index.js'
import type { ArmRetriever } from './types.js'

/** Vectors recorded with a run, by `contentHash` of the embedded text. */
export type RecordedVectors = {
  readonly embedder: {
    readonly id: string
    readonly model: string
    readonly dimensions: number
  }
  readonly vectors: Readonly<Record<string, readonly number[]>>
}

/** Answers every text from `recorded`; a text it does not hold is an error. */
export function replayEmbedder(recorded: RecordedVectors): EmbeddingProvider {
  const { id, model, dimensions } = recorded.embedder
  return {
    id,
    model,
    dimensions,
    embed: async texts => ({
      vectors: texts.map(text => {
        const hash = contentHash(text)
        const vector = recorded.vectors[hash]
        if (vector === undefined) {
          throw new Error(`replay: no recorded vector for text ${hash}`)
        }
        return vector
      }),
    }),
  }
}

const STAND_IN_DIMENSIONS = 16

/** The dry run's embedder: reproducible, offline, and not semantic at all. */
export const standInEmbedder: EmbeddingProvider = {
  id: 'eval-stand-in',
  model: 'sha256-direction-v1',
  dimensions: STAND_IN_DIMENSIONS,
  embed: async texts => ({
    vectors: texts.map(text => {
      const digest = createHash('sha256').update(text, 'utf8').digest()
      return Array.from(
        { length: STAND_IN_DIMENSIONS },
        (_, index) => (digest[index] ?? 0) / 128 - 1,
      )
    }),
  }),
}

/**
 * Counts what the arm is charged and never refuses: nothing is paid in a
 * replay or a dry run, and a refusal would degrade the arm.
 */
class CountingMeter implements EmbeddingUsageMeter {
  charged = 0

  remaining(): number {
    return Number.MAX_SAFE_INTEGER
  }

  charge(tokens: number): void {
    this.charged = Math.max(0, this.charged + tokens)
  }
}

export type M1Arm = {
  readonly retrieve: ArmRetriever
  /**
   * Embedding tokens so far, by `estimateEmbeddingTokens` (the pessimistic
   * rate the production meter reserves with): the backfills, and the recalls.
   */
  readonly embeddingTokens: () => {
    readonly backfill: number
    readonly recall: number
  }
}

/** The M1 arm with P16.6's proposed defaults, on `embedder`. */
export function m1Arm(embedder: EmbeddingProvider): M1Arm {
  const config = resolveHybridConfig()
  const index = new InMemoryVectorIndex()
  const meter = new CountingMeter()
  const warmed = new WeakSet<FileMemoryStore>()
  let backfill = 0

  const warm = async (store: FileMemoryStore, asOf: Date): Promise<void> => {
    const entries = store.query({ asOf })
    const texts = entries.map(entry =>
      entryEmbeddingText(entry, config.maxInputChars),
    )
    if (texts.length === 0) return
    const batch = await embedder.embed(texts, {
      signal: new AbortController().signal,
    })
    for (const [position, entry] of entries.entries()) {
      const text = texts[position] ?? ''
      const vector = batch.vectors[position]
      if (!isUsableVector(vector, embedder.dimensions)) {
        throw new Error(
          `answer eval: backfill got no usable vector for ${entry.id}`,
        )
      }
      index.set(
        {
          entryId: entry.id,
          contentHash: contentHash(text),
          providerId: embedder.id,
          model: embedder.model,
          dimensions: embedder.dimensions,
        },
        vector,
      )
      backfill += estimateEmbeddingTokens(text)
    }
  }

  return {
    retrieve: async (store, request) => {
      if (!warmed.has(store)) {
        await warm(store, request.asOf ?? new Date())
        warmed.add(store)
      }
      const result = await recallHybrid(store, request, {
        embedder,
        index,
        meter,
        config,
      })
      if (result.retrieval === 'hybrid-degraded') {
        const reasons = result.retrievalEvents.map(event =>
          'reason' in event ? `${event.type}: ${event.reason}` : event.type,
        )
        throw new Error(
          `answer eval: the M1 arm degraded to M0 (${reasons.join('; ')})`,
        )
      }
      return result
    },
    embeddingTokens: () => ({ backfill, recall: meter.charged }),
  }
}
