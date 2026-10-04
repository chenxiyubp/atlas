// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The vector index of the semantic overlay (`docs/dev/memory-m1.md` §5.3).
 *
 * A RANKING CACHE, NOT A SOURCE
 *
 * The index maps a key to a vector and nothing else. Entry content and
 * liveness are read from the store on every recall (I-4); the index is only
 * ever *asked about* entries the store has just returned as candidates. An id
 * that exists only in the index is never looked up, so a poisoned or stale
 * index cannot put an entry in front of the model. What it can still do is
 * reorder the candidates it does hold vectors for — the floor quota in
 * `hybrid.ts` is the defence against that, not anything here.
 *
 * THE KEY
 *
 * `(entryId, contentHash, providerId, model, dimensions)`. Vectors from two
 * providers, two models or two dimension counts are different spaces and are
 * never compared; a key that does not match is a missing vector, not a
 * conversion. Persistence (`<memoryRoot>/index/`, file modes, pruning on
 * revoke) is P16.8; this file holds the contract and the in-process map.
 */

export type VectorKey = {
  readonly entryId: string
  readonly contentHash: string
  readonly providerId: string
  readonly model: string
  readonly dimensions: number
}

export type VectorIndex = {
  /** The vector stored under exactly this key, or `undefined`. */
  get(key: VectorKey): readonly number[] | undefined
  set(key: VectorKey, vector: readonly number[]): void
}

function keyString(key: VectorKey): string {
  return JSON.stringify([
    key.entryId,
    key.contentHash,
    key.providerId,
    key.model,
    key.dimensions,
  ])
}

/**
 * Process-local index. Empty after every restart, which the coverage gate in
 * `hybrid.ts` turns into `index-cold` rather than into a half-warm fusion.
 */
export class InMemoryVectorIndex implements VectorIndex {
  readonly #vectors = new Map<string, readonly number[]>()

  get(key: VectorKey): readonly number[] | undefined {
    return this.#vectors.get(keyString(key))
  }

  set(key: VectorKey, vector: readonly number[]): void {
    this.#vectors.set(keyString(key), [...vector])
  }

  get size(): number {
    return this.#vectors.size
  }
}
