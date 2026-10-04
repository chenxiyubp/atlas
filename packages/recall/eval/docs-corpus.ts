// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The second corpus, `docs-dev-v1`: the repository's own decision records,
 * as memory entries (`docs/dev/memory-m1.md` §2.4 item 7, D-8).
 *
 * Non-synthetic, fixed at one commit (`docs-sources.ts`), redacted of
 * personal details (`docs-extract.ts`). Every decision record carries the
 * question its own document asked; change-log rows are entries no question
 * targets.
 *
 * Two tiers: 30 (below the injection threshold — 20 question-bearing records
 * and 10 change-log rows, chosen by a fixed seed) and all records. There is no
 * 500 or 2000 tier: the corpus is as large as the decision record is.
 *
 * Entry dates are the records' own dates, so ranking decay acts on real
 * ages. Write order, and with it the tie-break between records of the same
 * date, comes from the seed.
 */

import { createHash } from 'node:crypto'
import type { RecallScope } from '../src/recall.js'
import {
  DOCS_DEV_RECORD_COUNT,
  DOCS_DEV_RECORDS_JSON,
  DOCS_DEV_RECORDS_SHA256,
  DOCS_DEV_SOURCE_COMMIT,
} from './corpus/docs-dev.generated.js'
import { mulberry32, shuffled } from './dataset.js'
import type { DocsRecord } from './docs-extract.js'
import type { HardenedEntry, HardenedQuery } from './hardened.js'

export const DOCS_CORPUS_ID = 'docs-dev-v1'

/** Fixes the 30-tier subset and the write order. */
export const DOCS_SEED = 20260926

/** The day after the pinned commit: every record is in the past. */
const DOCS_AS_OF = new Date(Date.UTC(2026, 8, 27, 0, 0, 0))

const DOCS_PROJECT = 'eval-docs'

const DOCS_SCOPE: RecallScope = {
  layers: ['project'],
  projectKey: DOCS_PROJECT,
}

export const DOCS_KINDS = ['positive-docs'] as const

const SMALL_TIER_DECISIONS = 20
const SMALL_TIER_CHANGELOG = 10

export const DOCS_TIERS: readonly number[] = [
  SMALL_TIER_DECISIONS + SMALL_TIER_CHANGELOG,
  DOCS_DEV_RECORD_COUNT,
]

type DocsDataset = {
  readonly corpus: typeof DOCS_CORPUS_ID
  readonly sourceCommit: string
  readonly seed: number
  readonly liveInScope: number
  readonly asOf: Date
  readonly scope: RecallScope
  readonly entries: readonly HardenedEntry[]
  readonly queries: readonly (HardenedQuery | DocsQuery)[]
}

type DocsQuery = Omit<HardenedQuery, 'kind'> & {
  readonly kind: (typeof DOCS_KINDS)[number]
}

/** The records, after checking they are the ones the generator wrote. */
export function docsRecords(): readonly DocsRecord[] {
  const digest = createHash('sha256')
    .update(DOCS_DEV_RECORDS_JSON)
    .digest('hex')
  if (digest !== DOCS_DEV_RECORDS_SHA256) {
    throw new Error(
      'docs-dev corpus: records do not match their recorded SHA-256; regenerate with scripts/qianmo-recall-docs-corpus.ts',
    )
  }
  return JSON.parse(DOCS_DEV_RECORDS_JSON) as DocsRecord[]
}

/**
 * One tag for every record. A per-file tag would tell a ranker which records
 * carry a question (the decision files) and which do not (the change logs).
 */
const DOCS_TAG = 'decision-record'

/**
 * Build one tier of the docs corpus.
 *
 * @param liveInScope 30, or {@link DOCS_DEV_RECORD_COUNT} for all records.
 */
export function buildDocsDataset(liveInScope: number): DocsDataset {
  const records = docsRecords()
  if (!DOCS_TIERS.includes(liveInScope)) {
    throw new RangeError(
      `docs-dev tiers are ${DOCS_TIERS.join(', ')} (got ${liveInScope})`,
    )
  }
  const random = mulberry32(DOCS_SEED)
  const decisions = records.filter(record => record.question !== null)
  const changelog = records.filter(record => record.question === null)
  const chosen =
    liveInScope === DOCS_DEV_RECORD_COUNT
      ? records
      : [
          ...shuffled(decisions, random).slice(0, SMALL_TIER_DECISIONS),
          ...shuffled(changelog, random).slice(0, SMALL_TIER_CHANGELOG),
        ]
  const entries: HardenedEntry[] = chosen.map((record, index) => ({
    key: record.key,
    role: record.question === null ? 'distractor' : 'gold',
    scope: { layer: 'project', projectKey: DOCS_PROJECT },
    title: record.title,
    summary: record.summary,
    body: record.body,
    tags: [DOCS_TAG],
    // Whole seconds after midnight keep same-day records distinct and in
    // document order before the seeded shuffle below fixes write order.
    createdAt: new Date(Date.parse(`${record.date}T00:00:00Z`) + index * 1000),
  }))
  const present = new Set(chosen.map(record => record.key))
  const queries: DocsQuery[] = decisions
    .filter(record => present.has(record.key))
    .map(record => ({
      id: `docs-${record.key}`,
      kind: 'positive-docs',
      question: record.question ?? '',
      gold: [record.key],
      forbidden: [],
      mustMention: [],
      mustMentionAny: [],
      acceptable: [],
    }))
  return {
    corpus: DOCS_CORPUS_ID,
    sourceCommit: DOCS_DEV_SOURCE_COMMIT,
    seed: DOCS_SEED,
    liveInScope,
    asOf: DOCS_AS_OF,
    scope: DOCS_SCOPE,
    entries: shuffled(entries, random),
    queries,
  }
}

/** The corpus hash of §9's preregistration table for `docs-dev-v1`. */
export function docsCorpusDigest(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        corpus: DOCS_CORPUS_ID,
        sourceCommit: DOCS_DEV_SOURCE_COMMIT,
        records: DOCS_DEV_RECORDS_SHA256,
        tiers: DOCS_TIERS.map(tier =>
          createHash('sha256')
            .update(JSON.stringify(buildDocsDataset(tier)))
            .digest('hex'),
        ),
      }),
    )
    .digest('hex')
}
