// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hardened corpus (`eval/hardened.ts`, P16.2b). Like `eval.test.ts`,
 * these pin the instrument — composition, determinism, labels — and assert
 * no retrieval number.
 */

import { describe, expect, test } from 'bun:test'
import { EVAL_AS_OF, TARGET_PROJECT } from '../eval/dataset.js'
import {
  buildHardenedDataset,
  CONTEXT_A_SCOPE,
  DECISION_ENTRY_COUNT,
  EMBEDDING_INPUT_MAX_CODE_POINTS,
  embeddingInputOf,
  HARDENED_KINDS,
  HARDENED_SEEDS,
  HARDENED_TIERS,
  type HardenedDataset,
  type HardenedEntry,
  hardenedSourceId,
  renderTeammateBatch,
} from '../eval/hardened.js'
import { FORBIDDEN_IN_DISTRACTORS, SIBLINGS } from '../eval/hardened-data.js'
import { deterministicRankings } from '../eval/retrieval-gates.js'
import { materialise } from '../eval/run.js'
import { renderInjection } from '../src/inject.js'
import { recall } from '../src/recall.js'
import { scoreEntry, tokensOf } from '../src/rank.js'

const SEED = HARDENED_SEEDS[0] ?? 0

function liveIn(
  entry: HardenedEntry,
  scope: { layer: string; projectKey?: string; taskId?: string },
): boolean {
  return (
    entry.revokedAt === undefined &&
    entry.invalidAt === undefined &&
    JSON.stringify(entry.scope) === JSON.stringify(scope)
  )
}

const TARGET = { layer: 'project', projectKey: TARGET_PROJECT }

function liveInTarget(dataset: HardenedDataset): HardenedEntry[] {
  return dataset.entries.filter(entry => liveIn(entry, TARGET))
}

describe('composition', () => {
  test('decision-shaped entries are at least 141 in every ranked tier', () => {
    expect(DECISION_ENTRY_COUNT).toBeGreaterThanOrEqual(141)
    for (const tier of HARDENED_TIERS.filter(t => t > 50)) {
      const live = liveInTarget(buildHardenedDataset(tier, SEED))
      const decisions = live.filter(
        entry => entry.role === 'gold' || entry.role === 'sibling',
      )
      expect(decisions.length).toBeGreaterThanOrEqual(141)
      expect(decisions.length).toBe(DECISION_ENTRY_COUNT)
    }
  })

  test('every gold decision has at least five siblings with its tag', () => {
    const dataset = buildHardenedDataset(2000, SEED)
    const byKey = new Map(dataset.entries.map(entry => [entry.key, entry]))
    for (const [family, siblings] of Object.entries(SIBLINGS)) {
      expect(siblings.length).toBeGreaterThanOrEqual(5)
      const gold = byKey.get(family)
      for (const index of siblings.keys()) {
        const sibling = byKey.get(`sib-${family}-${index + 1}`)
        expect(sibling?.tags).toEqual(gold?.tags ?? [])
      }
    }
  })

  test('the tier is the live in-scope count; the 30 tier holds no filler', () => {
    for (const tier of HARDENED_TIERS) {
      const dataset = buildHardenedDataset(tier, SEED)
      const live = liveInTarget(dataset)
      expect(live.length).toBe(tier)
      if (tier < DECISION_ENTRY_COUNT) {
        expect(live.some(entry => entry.role === 'filler')).toBe(false)
      }
    }
    expect(() => buildHardenedDataset(20, SEED)).toThrow(RangeError)
    expect(() => buildHardenedDataset(40.5, SEED)).toThrow(RangeError)
  })

  test('question counts per kind', () => {
    const { queries } = buildHardenedDataset(30, SEED)
    const count = (kind: string) => queries.filter(q => q.kind === kind).length
    expect(count('positive-lexical')).toBe(20)
    expect(count('positive-mismatch')).toBe(20)
    expect(count('positive-lexical-batch')).toBe(20)
    expect(count('positive-mismatch-batch')).toBe(20)
    // §2.4 item 6: fabricated and "related but unsupported" ≥ 30 per tier.
    expect(count('negative-fabricated')).toBeGreaterThanOrEqual(30)
    expect(count('negative-unsupported')).toBeGreaterThanOrEqual(20)
    expect(count('negative-cross-context')).toBeGreaterThan(0)
    expect(queries.map(q => q.kind)).toEqual(
      [...queries.map(q => q.kind)].sort(
        (a, b) => HARDENED_KINDS.indexOf(a) - HARDENED_KINDS.indexOf(b),
      ),
    )
    expect(new Set(queries.map(q => q.id)).size).toBe(queries.length)
  })
})

describe('determinism', () => {
  test('same tier and seed, same corpus; another seed, another corpus', () => {
    const one = buildHardenedDataset(500, SEED)
    const two = buildHardenedDataset(500, SEED)
    expect(JSON.stringify(two)).toBe(JSON.stringify(one))
    const other = buildHardenedDataset(500, HARDENED_SEEDS[1] ?? SEED + 1)
    expect(JSON.stringify(other.entries)).not.toBe(JSON.stringify(one.entries))
    expect(other.queries).toEqual(one.queries)
    expect(one.asOf).toEqual(EVAL_AS_OF)
  })

  test('the five seeds are fixed and distinct', () => {
    expect(HARDENED_SEEDS.length).toBe(5)
    expect(new Set(HARDENED_SEEDS).size).toBe(5)
  })
})

describe('labels', () => {
  test('every label names an entry and means what it says', () => {
    const dataset = buildHardenedDataset(500, SEED)
    const byKey = new Map(dataset.entries.map(entry => [entry.key, entry]))
    expect(byKey.size).toBe(dataset.entries.length)
    for (const query of dataset.queries) {
      const scope =
        query.scope === undefined
          ? TARGET
          : {
              layer: 'working',
              projectKey: CONTEXT_A_SCOPE.projectKey,
              taskId: CONTEXT_A_SCOPE.taskId,
            }
      for (const key of [...query.gold, ...query.acceptable]) {
        const entry = byKey.get(key)
        expect(entry === undefined ? null : liveIn(entry, scope)).toBe(true)
      }
      for (const key of query.forbidden) {
        const entry = byKey.get(key)
        expect(entry === undefined ? null : liveIn(entry, scope)).toBe(false)
      }
      if (query.kind.startsWith('positive-')) {
        expect(query.gold.length).toBe(1)
        expect(query.mustMentionAny.length).toBeGreaterThan(0)
      }
      if (query.kind === 'negative-fabricated') {
        expect([query.gold, query.forbidden, query.acceptable]).toEqual([
          [],
          [],
          [],
        ])
      }
      if (query.kind === 'negative-unsupported') {
        expect(query.gold).toEqual([])
        expect(query.acceptable.length).toBe(1)
      }
    }
  })

  test('no sibling or filler says anything a question could be answered by', () => {
    for (const tier of [30, 2000]) {
      const dataset = buildHardenedDataset(tier, SEED)
      for (const entry of dataset.entries) {
        if (entry.role !== 'sibling' && entry.role !== 'filler') continue
        const text =
          `${entry.title}\n${entry.summary}\n${entry.body}`.toLowerCase()
        for (const word of FORBIDDEN_IN_DISTRACTORS) {
          if (text.includes(word)) {
            throw new Error(`${entry.key} contains «${word}»: ${text}`)
          }
        }
      }
    }
  })

  test('zero-overlap questions give their gold no ranking signal', () => {
    // Checked against the shipped scorer, as in eval.test.ts. A batch
    // variant's wrapper tokens (`teammate`, `message`, `id`, `peer`) may add
    // incidental overlap — that is what the resident's real query looks
    // like — so for batches the check is on the question text itself.
    const dataset = buildHardenedDataset(30, SEED)
    const materialised = materialise(dataset, { sourceIdOf: hardenedSourceId })
    try {
      const plainQuestion = new Map(
        dataset.queries.map(query => [query.id, query.question]),
      )
      const entryOf = (key: string) =>
        materialised.store.getEntry(materialised.idOf(key))
      for (const query of dataset.queries) {
        const [goldKey] = query.gold
        if (goldKey === undefined) continue
        const entry = entryOf(goldKey)
        if (entry === null) throw new Error(`${goldKey} not written`)
        const bare = query.kind.endsWith('-batch')
          ? (plainQuestion.get(query.id.slice(1)) ?? '')
          : query.question
        const relevance = scoreEntry(entry, {
          tokens: tokensOf(bare),
          asOf: dataset.asOf,
        }).relevance
        if (query.kind.startsWith('positive-mismatch')) {
          expect(relevance).toBe(0)
        }
        if (query.kind.startsWith('positive-lexical')) {
          expect(relevance).toBeGreaterThan(0)
        }
      }
    } finally {
      materialised.dispose()
    }
  })
})

describe('the rendered block carries no label', () => {
  test('source ids are opaque and the same length for every entry', () => {
    const dataset = buildHardenedDataset(500, SEED)
    const materialised = materialise(dataset, { sourceIdOf: hardenedSourceId })
    try {
      const result = recall(materialised.store, {
        question: dataset.queries[0]?.question,
        scope: dataset.scope,
        asOf: dataset.asOf,
      })
      const block = renderInjection(result)
      expect(block).not.toMatch(/eval-(filler|sib|gold|twin|retired)/)
      for (const key of ['runtime', 'vector', 'ndjson']) {
        expect(block).not.toContain(`eval-${key}`)
      }
      const sources = block.match(/^source: .*$/gm) ?? []
      expect(new Set(sources.map(line => line.length)).size).toBe(1)
    } finally {
      materialised.dispose()
    }
  })
})

describe('working-layer partition', () => {
  test('a context-A question never sees context B', () => {
    const dataset = buildHardenedDataset(30, SEED)
    const materialised = materialise(dataset, { sourceIdOf: hardenedSourceId })
    try {
      const context = dataset.queries.filter(
        q => q.kind === 'negative-cross-context',
      )
      const rankings = deterministicRankings(materialised.store, {
        ...dataset,
        queries: context,
      })
      for (const query of context) {
        const keys = (rankings.get(query.id) ?? []).map(ranked =>
          materialised.keyOf(ranked.entry.id),
        )
        expect(keys.length).toBeGreaterThan(0)
        for (const key of keys) expect(key.startsWith('ctx-a-')).toBe(true)
        for (const key of query.forbidden) expect(keys).not.toContain(key)
      }
    } finally {
      materialised.dispose()
    }
  })
})

describe('batch shape and the embedding input rule', () => {
  test('a batch renders like formatTeammateMessages', () => {
    expect(renderTeammateBatch(['a', 'b'])).toBe(
      '<teammate-message teammate_id="peer-a">\na\n</teammate-message>\n\n' +
        '<teammate-message teammate_id="peer-a">\nb\n</teammate-message>',
    )
  })

  test('wrappers are dropped and message bodies joined in order', () => {
    expect(embeddingInputOf(renderTeammateBatch(['一', '二', '三']))).toBe(
      '一\n二\n三',
    )
    expect(embeddingInputOf('plain question')).toBe('plain question')
  })

  test('over the limit, whole messages go from the oldest end first', () => {
    const long = 'x'.repeat(EMBEDDING_INPUT_MAX_CODE_POINTS - 5)
    expect(embeddingInputOf(renderTeammateBatch(['old message', long]))).toBe(
      long,
    )
    const tooLong = '字'.repeat(EMBEDDING_INPUT_MAX_CODE_POINTS + 10)
    const kept = embeddingInputOf(renderTeammateBatch([tooLong]))
    expect([...kept].length).toBe(EMBEDDING_INPUT_MAX_CODE_POINTS)
  })

  test('every batch variant contains its plain question verbatim', () => {
    const { queries } = buildHardenedDataset(30, SEED)
    const plain = new Map(queries.map(q => [q.id, q.question]))
    for (const query of queries.filter(q => q.kind.endsWith('-batch'))) {
      const original = plain.get(query.id.slice(1))
      expect(original).toBeDefined()
      expect(query.messages).toContain(original ?? '')
      expect(query.question).toContain(original ?? '')
    }
  })
})
