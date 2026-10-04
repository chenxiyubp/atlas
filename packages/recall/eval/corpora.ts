// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The corpora of the M1 evaluation, by id: what each one's tiers, seeds and
 * query kinds are, how to build it, and its preregistration hash.
 *
 * The v0.1 corpus (`dataset.ts`) is deliberately not in this table. Its
 * baseline is the published M0 reference (`docs/dev/memory-m1.md` §3) and
 * keeps its own runner and output format, byte for byte.
 */

import {
  DOCS_CORPUS_ID,
  DOCS_KINDS,
  DOCS_SEED,
  DOCS_TIERS,
  buildDocsDataset,
  docsCorpusDigest,
} from './docs-corpus.js'
import {
  buildHardenedDataset,
  HARDENED_ANSWER_KINDS,
  HARDENED_CORPUS_ID,
  HARDENED_KINDS,
  HARDENED_POOLED_KINDS,
  HARDENED_SEEDS,
  HARDENED_TIERS,
  type HardenedQuery,
  hardenedCorpusDigest,
  hardenedSourceId,
} from './hardened.js'
import type { BaselineDataset, BaselineEntry } from './run.js'

export type CorpusId = typeof HARDENED_CORPUS_ID | typeof DOCS_CORPUS_ID

/** A query of any M1 corpus: the retrieval fields plus the answer labels. */
export type CorpusQuery = Omit<HardenedQuery, 'kind'> & {
  readonly kind: string
}

export type CorpusDataset = Omit<BaselineDataset, 'queries'> & {
  readonly queries: readonly CorpusQuery[]
}

type CorpusDescriptor = {
  readonly id: CorpusId
  readonly seeds: readonly number[]
  readonly tiers: readonly number[]
  readonly kinds: readonly string[]
  /** The kinds pooled into the 「正例合计」 row. */
  readonly pooledKinds: readonly string[]
  /** The kinds the answer layer asks, a subset of {@link kinds}. */
  readonly answerKinds: readonly string[]
  build(tier: number, seed: number): CorpusDataset
  /** The §9 preregistration hash of the whole corpus. */
  digest(): string
  sourceIdOf(entry: BaselineEntry, writeIndex: number): string
}

export const CORPORA: Readonly<Record<CorpusId, CorpusDescriptor>> = {
  [HARDENED_CORPUS_ID]: {
    id: HARDENED_CORPUS_ID,
    seeds: HARDENED_SEEDS,
    tiers: HARDENED_TIERS,
    kinds: HARDENED_KINDS,
    pooledKinds: HARDENED_POOLED_KINDS,
    answerKinds: HARDENED_ANSWER_KINDS,
    build: buildHardenedDataset,
    digest: hardenedCorpusDigest,
    sourceIdOf: hardenedSourceId,
  },
  [DOCS_CORPUS_ID]: {
    id: DOCS_CORPUS_ID,
    seeds: [DOCS_SEED],
    tiers: DOCS_TIERS,
    kinds: DOCS_KINDS,
    pooledKinds: DOCS_KINDS,
    answerKinds: DOCS_KINDS,
    build: tier => buildDocsDataset(tier),
    digest: docsCorpusDigest,
    sourceIdOf: hardenedSourceId,
  },
}

export function isCorpusId(value: string): value is CorpusId {
  return Object.hasOwn(CORPORA, value)
}
