// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The semantic overlay (`docs/dev/memory-m1.md` §5, P16.6), driven only by
 * deterministic stand-in embedders. Nothing here measures retrieval quality:
 * the vectors are chosen by hand so each structural property can be shown in
 * isolation — floor kept, candidates only, failures equal M0, full mode
 * untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FileMemoryStore, type MemoryEntry } from '@qianmo/memory'
import { buildDataset } from '../eval/dataset.js'
import { estimateEmbeddingTokens } from '../src/embedding.js'
import {
  type EmbeddingBatch,
  type EmbeddingProvider,
  FileEmbeddingUsageMeter,
  HYBRID_DEFAULTS,
  type HybridConfig,
  type HybridRecallResult,
  InMemoryVectorIndex,
  type RecallRequest,
  type RecallResult,
  type RetrievalEvent,
  type SemanticRecall,
  type VectorIndex,
  type VectorKey,
  injectedIds,
  recall,
  recallHybrid,
  renderInjection,
  resolveHybridConfig,
} from '../src/index.js'
import { createSandbox, DAY_MS, PROJECT_KEY, type Sandbox } from './helpers.js'

const QUESTION = '语义搜索怎么做？'
const SCOPE = { layers: ['project'], projectKey: PROJECT_KEY } as const

/** Vectors by marker: the first marker found in a text decides its vector. */
class TableEmbedder implements EmbeddingProvider {
  readonly id = 'test-table'
  readonly model = 'table-v1'
  readonly dimensions = 2
  readonly calls: string[][] = []
  readonly #rules: readonly (readonly [string, readonly number[]])[]
  readonly #fallback: readonly number[]
  readonly #billed: number | undefined

  constructor(
    rules: readonly (readonly [string, readonly number[]])[],
    options: { fallback?: readonly number[]; billed?: number } = {},
  ) {
    this.#rules = rules
    this.#fallback = options.fallback ?? [0, 1]
    this.#billed = options.billed
  }

  vectorOf(text: string): readonly number[] {
    for (const [marker, vector] of this.#rules) {
      if (text.includes(marker)) return vector
    }
    return this.#fallback
  }

  async embed(texts: readonly string[]): Promise<EmbeddingBatch> {
    this.calls.push([...texts])
    return {
      vectors: texts.map(text => [...this.vectorOf(text)]),
      ...(this.#billed === undefined
        ? {}
        : { usage: { tokens: this.#billed } }),
    }
  }
}

/** The scenario's stand-in: the question and the gold share a direction. */
function scenarioEmbedder(options: { billed?: number } = {}): TableEmbedder {
  return new TableEmbedder(
    [
      ['语义搜索', [1, 0]],
      ['LanceDB', [1, 0]],
      ['搜索框', [0.2, 1]],
    ],
    options,
  )
}

/** Pseudo-random but reproducible directions, one stream per salt. */
class NoiseEmbedder implements EmbeddingProvider {
  readonly id = 'test-noise'
  readonly model = 'noise-v1'
  readonly dimensions = 4
  readonly #salt: string

  constructor(salt: string) {
    this.#salt = salt
  }

  async embed(texts: readonly string[]): Promise<EmbeddingBatch> {
    return {
      vectors: texts.map(text => {
        const digest = createHash('sha256')
          .update(`${this.#salt}\u0000${text}`)
          .digest()
        return [0, 1, 2, 3].map(offset => (digest[offset] as number) / 128 - 1)
      }),
    }
  }
}

/** An embedder whose every call fails in a chosen way. */
class BrokenEmbedder implements EmbeddingProvider {
  readonly id = 'test-broken'
  readonly model = 'broken-v1'
  readonly dimensions = 2
  readonly calls: string[][] = []
  signal: AbortSignal | undefined
  readonly #answer: (texts: readonly string[]) => Promise<EmbeddingBatch>

  constructor(answer: (texts: readonly string[]) => Promise<EmbeddingBatch>) {
    this.#answer = answer
  }

  embed(
    texts: readonly string[],
    options: { readonly signal: AbortSignal },
  ): Promise<EmbeddingBatch> {
    this.calls.push([...texts])
    this.signal = options.signal
    return this.#answer(texts)
  }
}

/** An index that answers every question it is asked with `answer(key)`. */
class HostileIndex implements VectorIndex {
  readonly asked: VectorKey[] = []
  readonly #answer: (key: VectorKey) => readonly number[] | undefined

  constructor(answer: (key: VectorKey) => readonly number[] | undefined) {
    this.#answer = answer
  }

  get(key: VectorKey): readonly number[] | undefined {
    this.asked.push(key)
    return this.#answer(key)
  }

  set(): void {}
}

type Seeded = {
  readonly gold: MemoryEntry
  readonly fillers: readonly MemoryEntry[]
  readonly decoys: readonly MemoryEntry[]
  readonly asOf: Date
}

/**
 * One old entry that answers the question with no shared wording (the D-6
 * shape), `fillers` newer unrelated entries, and three newest entries that
 * share the word 搜索 with the question but not its meaning.
 */
function seed(sandbox: Sandbox, fillers = 20): Seeded {
  const gold = sandbox.write({
    title: '检索方案',
    summary: '向量检索的选型',
    body: '统一用 LanceDB，按条目正文建向量。',
    tags: ['retrieval'],
  })
  const written: MemoryEntry[] = []
  for (let index = 1; index <= fillers; index += 1) {
    sandbox.clock.advance(DAY_MS)
    written.push(
      sandbox.write({
        title: `部署窗口 ${index}`,
        body: `第 ${index} 批在周四晚上发布。`,
      }),
    )
  }
  const decoys: MemoryEntry[] = []
  for (let index = 1; index <= 3; index += 1) {
    sandbox.clock.advance(DAY_MS)
    decoys.push(
      sandbox.write({
        title: `搜索框样式 ${index}`,
        body: `搜索框圆角改为 ${index} 像素。`,
      }),
    )
  }
  sandbox.clock.advance(DAY_MS)
  return { gold, fillers: written, decoys, asOf: sandbox.clock.now() }
}

function request(
  asOf: Date,
  overrides: Partial<RecallRequest> = {},
): RecallRequest {
  return {
    question: QUESTION,
    scope: SCOPE,
    asOf,
    budget: { maxEntries: 8 },
    ...overrides,
  }
}

/** The `RecallResult` half of a hybrid result, field by field. */
function deterministicHalf(result: RecallResult): RecallResult {
  return {
    asOf: result.asOf,
    mode: result.mode,
    entries: result.entries,
    candidateCount: result.candidateCount,
    omittedCount: result.omittedCount,
    tokens: result.tokens,
    events: result.events,
    degraded: result.degraded,
  }
}

function idsOf(result: RecallResult): string[] {
  return result.entries.map(entry => entry.entry.id)
}

let sandbox: Sandbox
let usagePath: string

beforeEach(() => {
  sandbox = createSandbox()
  usagePath = join(dirname(sandbox.root), 'usage', 'usage.json')
})

afterEach(() => {
  sandbox.dispose()
})

function meter(dailyTokenLimit = 1_000_000): FileEmbeddingUsageMeter {
  return new FileEmbeddingUsageMeter({ dailyTokenLimit, path: usagePath })
}

function overlay(
  embedder: EmbeddingProvider,
  overrides: Partial<SemanticRecall> = {},
): SemanticRecall {
  return {
    embedder,
    index: new InMemoryVectorIndex(),
    meter: meter(),
    ...overrides,
  }
}

/** A degraded recall must be the deterministic one, rendered identically. */
function expectEqualsRecall(
  hybrid: HybridRecallResult,
  deterministic: RecallResult,
): void {
  expect(hybrid.retrieval).toBe('hybrid-degraded')
  expect(hybrid.semanticIds).toEqual([])
  expect(deterministicHalf(hybrid)).toEqual(deterministic)
  expect(renderInjection(hybrid)).toBe(renderInjection(deterministic))
}

describe('full mode is M0 (I-2)', () => {
  test('below the budget the block is byte-identical and nothing is embedded', async () => {
    const { asOf } = seed(sandbox)
    const embedder = scenarioEmbedder()
    const full = request(asOf, { budget: undefined })

    const hybrid = await recallHybrid(sandbox.store, full, overlay(embedder))
    const deterministic = recall(sandbox.store, full)

    expect(deterministic.mode).toBe('full')
    expect(hybrid.retrieval).toBe('deterministic')
    expect(embedder.calls).toEqual([])
    expect(deterministicHalf(hybrid)).toEqual(deterministic)
    expect(renderInjection(hybrid)).toBe(renderInjection(deterministic))
  })

  test('every query of the 30-entry baseline tier renders the M0 block and never embeds', async () => {
    // The eval corpus itself (whatever P16.2b makes of it), not a fixture of
    // this file: I-2 is a claim about the baseline tier.
    const dataset = buildDataset(30)
    const directory = mkdtempSync(join(tmpdir(), 'qianmo-recall-hybrid-30-'))
    try {
      let clock = dataset.asOf
      let counter = 0
      const store = new FileMemoryStore({
        root: join(directory, 'memory'),
        now: () => clock,
        newId: () => {
          counter += 1
          return `qm-mem-eval${String(counter).padStart(6, '0')}`
        },
      })
      const idByKey = new Map<string, string>()
      for (const entry of dataset.entries) {
        clock = entry.createdAt
        const written = store.write({
          scope: entry.scope,
          title: entry.title,
          summary: entry.summary,
          body: entry.body,
          tags: entry.tags,
          source: { kind: 'import', id: `eval-${entry.key}` },
          ...(entry.invalidAt === undefined
            ? {}
            : { invalidAt: entry.invalidAt }),
        })
        idByKey.set(entry.key, written.id)
      }
      for (const entry of dataset.entries) {
        if (entry.revokedAt === undefined) continue
        clock = entry.revokedAt
        store.revoke(idByKey.get(entry.key) as string, {
          reason: 'eval: decision overturned',
          by: 'eval',
        })
      }

      const embedder = new BrokenEmbedder(async () => {
        throw new Error('full mode must not embed')
      })
      const semantic = {
        embedder,
        index: new InMemoryVectorIndex(),
        meter: meter(),
      }
      let compared = 0
      for (const query of dataset.queries) {
        for (const halfLifeMs of [undefined, 0]) {
          const input: RecallRequest = {
            question: query.question,
            scope: dataset.scope,
            asOf: dataset.asOf,
            ...(halfLifeMs === undefined ? {} : { halfLifeMs }),
          }
          const hybrid = await recallHybrid(store, input, semantic)
          const deterministic = recall(store, input)
          expect(deterministic.mode).toBe('full')
          expect(hybrid.retrieval).toBe('deterministic')
          expect(renderInjection(hybrid)).toBe(renderInjection(deterministic))
          compared += 1
        }
      }
      expect(compared).toBe(dataset.queries.length * 2)
      expect(embedder.calls).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('no question, no semantics: the deterministic result, no call', async () => {
    const { asOf } = seed(sandbox)
    const embedder = scenarioEmbedder()
    const input = request(asOf, { question: undefined })

    const hybrid = await recallHybrid(sandbox.store, input, overlay(embedder))

    expect(hybrid.retrieval).toBe('deterministic')
    expect(embedder.calls).toEqual([])
    expect(deterministicHalf(hybrid)).toEqual(recall(sandbox.store, input))
  })
})

describe('ranked mode: floor, then fusion (§5.1)', () => {
  test('the floor is kept in M0 order and the fill brings in the entry with no shared wording', async () => {
    const { gold, fillers, decoys, asOf } = seed(sandbox)
    const input = request(asOf)
    const deterministic = recall(sandbox.store, input)

    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(scenarioEmbedder()),
    )

    // M0 fills the free slots by age; the old answer never makes it.
    expect(idsOf(deterministic)).toEqual([
      ...[...decoys].reverse().map(entry => entry.id),
      ...fillers
        .slice(-5)
        .reverse()
        .map(entry => entry.id),
    ])
    expect(idsOf(deterministic)).not.toContain(gold.id)

    expect(hybrid.retrieval).toBe('hybrid')
    expect(hybrid.retrievalEvents).toEqual([])
    const floor = Math.ceil(deterministic.entries.length / 2)
    expect(idsOf(hybrid).slice(0, floor)).toEqual(
      idsOf(deterministic).slice(0, floor),
    )
    expect(idsOf(hybrid)).toEqual([
      ...idsOf(deterministic).slice(0, floor),
      gold.id,
      ...idsOf(deterministic).slice(floor, deterministic.entries.length - 1),
    ])
    expect(hybrid.semanticIds).toEqual([gold.id])
    expect(hybrid.mode).toBe('ranked')
    expect(hybrid.candidateCount).toBe(deterministic.candidateCount)
    expect(hybrid.omittedCount).toBe(
      hybrid.candidateCount - hybrid.entries.length,
    )
  })

  test('the block says it is hybrid and marks the one entry the fill added', async () => {
    const { gold, asOf } = seed(sandbox)
    const hybrid = await recallHybrid(
      sandbox.store,
      request(asOf),
      overlay(scenarioEmbedder()),
    )

    const block = renderInjection(hybrid)
    const lines = block.split('\n')
    expect(lines[0]).toContain(' retrieval="hybrid">')
    expect(lines.filter(line => line === 'via: semantic')).toHaveLength(1)
    const idLine = lines.indexOf(`entry_id: ${gold.id}`)
    expect(lines[idLine - 1]).toBe('via: semantic')
    expect(lines[idLine - 2]).toBe('--- entry 5/8 ---')
  })

  test('zero-relevance entries share one deterministic rank, so age casts no vote', async () => {
    // Two entries match the question's wording; six do not. Among the six,
    // the oldest is the most similar and the newest the second most. Were
    // their ingest order fed into RRF, the newest would win the first free
    // slot on recency alone (1/63 + 1/62 against 1/68 + 1/61).
    const zero: MemoryEntry[] = []
    for (const marker of ['甲', '丙', '丁', '戊', '己', '乙']) {
      sandbox.clock.advance(DAY_MS)
      zero.unshift(
        sandbox.write({ title: `归档规则 ${marker}`, body: '按月归档。' }),
      )
    }
    const decoys: MemoryEntry[] = []
    for (const index of [1, 2]) {
      sandbox.clock.advance(DAY_MS)
      decoys.unshift(sandbox.write({ title: `搜索框样式 ${index}` }))
    }
    sandbox.clock.advance(DAY_MS)
    const embedder = new TableEmbedder(
      [
        ['语义搜索', [1, 0]],
        ['甲', [1, 0]],
        ['乙', [0.8, 0.6]],
        ['搜索框', [0, 1]],
      ],
      { fallback: [0.1, 1] },
    )
    const input = request(sandbox.clock.now(), { budget: { maxEntries: 4 } })

    const hybrid = await recallHybrid(sandbox.store, input, overlay(embedder))

    const newest = zero[0] as MemoryEntry
    const oldest = zero[zero.length - 1] as MemoryEntry
    expect(newest.title).toBe('归档规则 乙')
    expect(oldest.title).toBe('归档规则 甲')
    expect(idsOf(recall(sandbox.store, input))).toEqual([
      ...decoys.map(entry => entry.id),
      newest.id,
      (zero[1] as MemoryEntry).id,
    ])
    expect(idsOf(hybrid)).toEqual([
      ...decoys.map(entry => entry.id),
      oldest.id,
      newest.id,
    ])
  })

  test('one source may not take more than its share of the free slots (V-8)', async () => {
    const write = (title: string, source: string): MemoryEntry => {
      sandbox.clock.advance(DAY_MS)
      return sandbox.write({
        title,
        source: { kind: 'session', id: source },
      })
    }
    const fromA = [1, 2, 3, 4, 5].map(index => write(`甲类 ${index}`, 'a'))
    const fromB = [1, 2, 3].map(index => write(`乙类 ${index}`, 'b'))
    write('搜索框样式 1', 'c')
    write('搜索框样式 2', 'c')
    sandbox.clock.advance(DAY_MS)
    const embedder = new TableEmbedder(
      [
        ['语义搜索', [1, 0]],
        ['甲类', [1, 0]],
        ['乙类', [0.5, 0.5]],
      ],
      { fallback: [0, 1] },
    )
    const input = request(sandbox.clock.now(), { budget: { maxEntries: 6 } })
    const fillOf = (result: HybridRecallResult): string[] =>
      idsOf(result).slice(3)

    const capped = await recallHybrid(sandbox.store, input, overlay(embedder))
    const uncapped = await recallHybrid(
      sandbox.store,
      input,
      overlay(embedder, { config: { sourceFillShare: 1 } }),
    )

    const aIds = new Set(fromA.map(entry => entry.id))
    expect(capped.retrieval).toBe('hybrid')
    expect(fillOf(capped).filter(id => aIds.has(id))).toHaveLength(2)
    expect(fillOf(capped)).toContain((fromB[1] as MemoryEntry).id)
    expect(fillOf(uncapped).filter(id => aIds.has(id))).toHaveLength(3)
    // Moved, never dropped: the block keeps its size.
    expect(capped.entries).toHaveLength(uncapped.entries.length)
  })

  test('with a single source the share changes nothing', async () => {
    const { asOf } = seed(sandbox)
    const shared = await recallHybrid(
      sandbox.store,
      request(asOf),
      overlay(scenarioEmbedder()),
    )
    const unlimited = await recallHybrid(
      sandbox.store,
      request(asOf),
      overlay(scenarioEmbedder(), { config: { sourceFillShare: 1 } }),
    )
    expect(idsOf(shared)).toEqual(idsOf(unlimited))
  })

  test('floorRatio 1 keeps exactly what M0 injected', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)
    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(scenarioEmbedder(), { config: { floorRatio: 1 } }),
    )
    expect(hybrid.retrieval).toBe('hybrid')
    expect(idsOf(hybrid)).toEqual(idsOf(recall(sandbox.store, input)))
    expect(hybrid.semanticIds).toEqual([])
  })

  test('property: floor ⊆ I_hybrid, I_hybrid ⊆ C, budget held, across random vectors and budgets', async () => {
    for (let index = 0; index < 40; index += 1) {
      sandbox.clock.advance(DAY_MS)
      sandbox.write({
        title: index % 3 === 0 ? `搜索记录 ${index}` : `杂项 ${index}`,
        body: 'x'.repeat(40 + ((index * 37) % 300)),
        source: { kind: 'session', id: `s${index % 4}` },
      })
    }
    sandbox.clock.advance(DAY_MS)
    const asOf = sandbox.clock.now()
    const candidates = new Set(
      sandbox.store.query({ asOf }).map(entry => entry.id),
    )
    let checked = 0
    for (let trial = 0; trial < 60; trial += 1) {
      const noise = new NoiseEmbedder(String(trial))
      const budget = {
        maxEntries: 1 + (trial % 30),
        maxChars: 800 + ((trial * 997) % 9000),
      }
      const floorRatio = [0.1, 0.25, 0.5, 0.75, 1][trial % 5] as number
      const input = request(asOf, { budget })
      const deterministic = recall(sandbox.store, input)
      const hybrid = await recallHybrid(
        sandbox.store,
        input,
        overlay(noise, {
          config: {
            floorRatio,
            sourceFillShare: trial % 2 === 0 ? 0.5 : 1,
            // A fresh index per trial: let one recall warm all 40.
            maxEmbedPerRecall: 64,
          },
        }),
      )
      if (deterministic.mode === 'full') continue
      expect(hybrid.retrievalEvents).toEqual([])
      expect(hybrid.retrieval).toBe('hybrid')
      const floor = Math.ceil(deterministic.entries.length * floorRatio)
      expect(idsOf(hybrid).slice(0, floor)).toEqual(
        idsOf(deterministic).slice(0, floor),
      )
      const injected = [...injectedIds(hybrid)]
      expect(injected).toHaveLength(hybrid.entries.length)
      expect(injected.every(id => candidates.has(id))).toBe(true)
      expect(hybrid.entries.length).toBeLessThanOrEqual(budget.maxEntries)
      const deterministicIds = new Set(idsOf(deterministic))
      expect(hybrid.semanticIds).toEqual(
        injected.filter(id => !deterministicIds.has(id)),
      )
      checked += 1
    }
    expect(checked).toBeGreaterThan(40)
  })
})

describe('the index is asked about candidates only (§5.3)', () => {
  test('ids that exist only in the index never reach the block', async () => {
    const { asOf } = seed(sandbox)
    const elsewhere = sandbox.store.write({
      scope: { layer: 'project', projectKey: 'elsewhere' },
      title: '语义搜索',
      summary: '语义搜索',
      body: '他处的条目。',
      source: { kind: 'session', id: 'test-session' },
    })
    const embedder = scenarioEmbedder()
    const index = new InMemoryVectorIndex()
    const poison = (entryId: string): void =>
      index.set(
        {
          entryId,
          contentHash: 'forged',
          providerId: embedder.id,
          model: embedder.model,
          dimensions: embedder.dimensions,
        },
        [1, 0],
      )
    poison('qm-mem-ffffffffffffffff')
    poison(elsewhere.id)

    const hybrid = await recallHybrid(
      sandbox.store,
      request(asOf),
      overlay(embedder, { index }),
    )

    const block = renderInjection(hybrid)
    expect(hybrid.retrieval).toBe('hybrid')
    expect(block).not.toContain('qm-mem-ffffffffffffffff')
    expect(block).not.toContain(elsewhere.id)
  })

  test('an index that answers every key with the question itself still cannot add an entry', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)
    const candidates = new Set(
      recall(sandbox.store, { ...input, budget: undefined }).entries.map(
        entry => entry.entry.id,
      ),
    )
    const index = new HostileIndex(() => [1, 0])

    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(scenarioEmbedder(), { index }),
    )

    expect(index.asked.length).toBe(candidates.size)
    expect(index.asked.every(key => candidates.has(key.entryId))).toBe(true)
    expect([...injectedIds(hybrid)].every(id => candidates.has(id))).toBe(true)
  })

  test('an index rewritten to bury the top entry cannot push it out of the floor', async () => {
    const { decoys, asOf } = seed(sandbox)
    const top = decoys[decoys.length - 1] as MemoryEntry
    const index = new HostileIndex(key =>
      key.entryId === top.id ? [-1, 0] : [1, 0],
    )

    const hybrid = await recallHybrid(
      sandbox.store,
      request(asOf),
      overlay(scenarioEmbedder(), { index }),
    )

    expect(hybrid.retrieval).toBe('hybrid')
    expect(idsOf(hybrid)[0]).toBe(top.id)
  })

  test('a vector of the wrong size is a missing vector, not a similarity', async () => {
    const { asOf } = seed(sandbox)
    const embedder = scenarioEmbedder()
    const index = new HostileIndex(() => [1, 0, 0])

    const hybrid = await recallHybrid(
      sandbox.store,
      request(asOf),
      overlay(embedder, { index }),
    )

    expect(hybrid.retrieval).toBe('hybrid')
    // Every candidate had to be embedded afresh, plus the question.
    expect(embedder.calls[0]).toHaveLength(index.asked.length + 1)
  })
})

describe('any semantic failure is M0 (I-7)', () => {
  const failures: readonly [
    string,
    () => BrokenEmbedder,
    RetrievalEvent['type'],
  ][] = [
    [
      'the embedder rejects',
      () =>
        new BrokenEmbedder(async () => {
          throw new Error('gateway unavailable')
        }),
      'embed-failed',
    ],
    [
      'the embedder throws before returning a promise',
      () => {
        const embedder = new BrokenEmbedder(async () => ({ vectors: [] }))
        embedder.embed = () => {
          throw new Error('synchronous failure')
        }
        return embedder
      },
      'embed-failed',
    ],
    [
      'one vector is missing',
      () =>
        new BrokenEmbedder(async texts => ({
          vectors: texts.slice(1).map(() => [1, 0]),
        })),
      'embed-failed',
    ],
    [
      'a vector has the wrong size',
      () =>
        new BrokenEmbedder(async texts => ({
          vectors: texts.map(() => [1, 0, 0]),
        })),
      'embed-failed',
    ],
    [
      'the answer is not a batch at all',
      () =>
        new BrokenEmbedder(async () => undefined as unknown as EmbeddingBatch),
      'embed-failed',
    ],
    [
      'a vector holds NaN',
      () =>
        new BrokenEmbedder(async texts => ({
          vectors: texts.map(() => [Number.NaN, 0]),
        })),
      'embed-failed',
    ],
  ]

  for (const [name, make, type] of failures) {
    test(`${name}: the result equals recall()`, async () => {
      const { asOf } = seed(sandbox)
      const input = request(asOf)
      const embedder = make()

      const hybrid = await recallHybrid(sandbox.store, input, overlay(embedder))

      expectEqualsRecall(hybrid, recall(sandbox.store, input))
      expect(hybrid.retrievalEvents.map(event => event.type)).toEqual([type])
    })
  }

  test('a timeout: the result equals recall() and the call is aborted', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)
    const embedder = new BrokenEmbedder(() => new Promise(() => {}))

    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(embedder, { config: { timeoutMs: 25 } }),
    )

    expectEqualsRecall(hybrid, recall(sandbox.store, input))
    expect(hybrid.retrievalEvents).toEqual([
      { type: 'embed-timeout', timeoutMs: 25 },
    ])
    expect(embedder.signal?.aborted).toBe(true)
  })

  test('an index that throws: the result equals recall()', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)
    const index: VectorIndex = {
      get: () => {
        throw new Error('index file unreadable')
      },
      set: () => {},
    }

    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(scenarioEmbedder(), { index }),
    )

    expectEqualsRecall(hybrid, recall(sandbox.store, input))
    expect(hybrid.retrievalEvents).toEqual([
      { type: 'semantic-error', reason: 'index file unreadable' },
    ])
  })

  test('an invalid configuration degrades instead of throwing', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)
    const embedder = scenarioEmbedder()

    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(embedder, { config: { floorRatio: 0 } }),
    )

    expectEqualsRecall(hybrid, recall(sandbox.store, input))
    expect(hybrid.retrievalEvents[0]?.type).toBe('semantic-error')
    expect(embedder.calls).toEqual([])
  })
})

describe('the coverage gate (§5.3)', () => {
  test('below 95% coverage there is no fusion; each recall embeds at most 32 entries', async () => {
    const { asOf } = seed(sandbox, 60)
    const input = request(asOf)
    const embedder = scenarioEmbedder()
    const semantic = overlay(embedder)
    const candidates = recall(sandbox.store, {
      ...input,
      budget: undefined,
    }).candidateCount
    expect(candidates).toBe(64)

    const cold = await recallHybrid(sandbox.store, input, semantic)

    expectEqualsRecall(cold, recall(sandbox.store, input))
    expect(cold.retrievalEvents).toEqual([
      {
        type: 'index-cold',
        coverage: 0.5,
        minCoverage: 0.95,
        candidates: 64,
      },
    ])
    expect(embedder.calls).toHaveLength(1)
    expect(embedder.calls[0]).toHaveLength(32)
    expect(embedder.calls[0]).not.toContain(QUESTION)

    const warm = await recallHybrid(sandbox.store, input, semantic)

    expect(warm.retrieval).toBe('hybrid')
    expect(embedder.calls[1]?.[0]).toBe(QUESTION)
    expect(embedder.calls[1]).toHaveLength(33)

    const hot = await recallHybrid(sandbox.store, input, semantic)
    expect(hot.retrieval).toBe('hybrid')
    expect(embedder.calls[2]).toEqual([QUESTION])
  })
})

describe('the cost cap (§5.5): tokens, persisted', () => {
  test('a cap of zero spends nothing and degrades', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)
    const embedder = scenarioEmbedder()

    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(embedder, { meter: meter(0) }),
    )

    expectEqualsRecall(hybrid, recall(sandbox.store, input))
    expect(hybrid.retrievalEvents.map(event => event.type)).toContain(
      'budget-exhausted',
    )
    expect(embedder.calls).toEqual([])
  })

  test('reported usage is what is charged, and a restarted meter still sees it', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)

    const first = await recallHybrid(
      sandbox.store,
      input,
      overlay(scenarioEmbedder({ billed: 100 }), { meter: meter(10_000) }),
    )
    expect(first.retrieval).toBe('hybrid')
    expect(JSON.parse(readFileSync(usagePath, 'utf8')).tokens).toBe(100)

    // A new meter over the same file is a restarted process.
    const restarted = new FileEmbeddingUsageMeter({
      dailyTokenLimit: 105,
      path: usagePath,
    })
    expect(restarted.used()).toBe(100)
    const embedder = scenarioEmbedder()
    const second = await recallHybrid(
      sandbox.store,
      input,
      overlay(embedder, { meter: restarted }),
    )

    expectEqualsRecall(second, recall(sandbox.store, input))
    expect(second.retrievalEvents[0]?.type).toBe('budget-exhausted')
    expect(embedder.calls).toEqual([])
  })

  test('the estimate is charged before the call, so a failed call is still paid for', async () => {
    const { asOf } = seed(sandbox)
    const embedder = new BrokenEmbedder(async () => {
      throw new Error('connection reset')
    })
    const usage = meter()

    await recallHybrid(
      sandbox.store,
      request(asOf),
      overlay(embedder, { meter: usage }),
    )

    const sent = embedder.calls[0] as string[]
    expect(usage.used()).toBe(
      sent.reduce((sum, text) => sum + estimateEmbeddingTokens(text), 0),
    )
    expect(usage.used()).toBeGreaterThan(0)
  })

  test('an unreadable counter is not a zero: recall degrades and the file is left alone', async () => {
    const { asOf } = seed(sandbox)
    const input = request(asOf)
    const usage = meter()
    usage.charge(1)
    writeFileSync(usagePath, 'not json')
    const embedder = scenarioEmbedder()

    const hybrid = await recallHybrid(
      sandbox.store,
      input,
      overlay(embedder, { meter: usage }),
    )

    expectEqualsRecall(hybrid, recall(sandbox.store, input))
    expect(hybrid.retrievalEvents[0]?.type).toBe('semantic-error')
    expect(readFileSync(usagePath, 'utf8')).toBe('not json')
    expect(embedder.calls).toEqual([])
    expect(readdirSync(dirname(usagePath))).toEqual(['usage.json'])
  })
})

describe('configuration', () => {
  test('the defaults are the proposed values of §5 and §10', () => {
    const expected: HybridConfig = {
      floorRatio: 0.5,
      rrfK: 60,
      maxEmbedPerRecall: 32,
      minIndexCoverage: 0.95,
      timeoutMs: 300,
      maxInputChars: 8_000,
      sourceFillShare: 0.5,
    }
    expect(HYBRID_DEFAULTS).toEqual(expected)
    expect(resolveHybridConfig()).toEqual(expected)
    expect(resolveHybridConfig({ rrfK: 10 }).rrfK).toBe(10)
  })

  test('values that cannot work are rejected', () => {
    for (const bad of [
      { floorRatio: 0 },
      { floorRatio: 1.5 },
      { floorRatio: Number.NaN },
      { rrfK: 0 },
      { maxEmbedPerRecall: -1 },
      { maxEmbedPerRecall: 1.5 },
      { minIndexCoverage: 1.2 },
      { timeoutMs: 0 },
      { maxInputChars: 0 },
      { sourceFillShare: 0 },
    ] satisfies Partial<HybridConfig>[]) {
      expect(() => resolveHybridConfig(bad)).toThrow()
    }
  })
})

describe('provider neutrality (I-5)', () => {
  test('no vendor name appears in the package source outside comments, nor anywhere in the semantic layer', () => {
    const vendors = [
      'openai',
      'anthropic',
      'claude',
      'gemini',
      'google',
      'cohere',
      'voyage',
      'ollama',
      'huggingface',
      'mistral',
      'deepseek',
      'qwen',
      'jina',
      'nomic',
      'bedrock',
      'azure',
    ]
    const sourceDir = join(import.meta.dir, '..', 'src')
    const semanticLayer = new Set([
      'embedding.ts',
      'hybrid.ts',
      'usage.ts',
      'vector-index.ts',
    ])
    for (const file of readdirSync(sourceDir)) {
      const text = readFileSync(join(sourceDir, file), 'utf8')
      const code = semanticLayer.has(file)
        ? text
        : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const vendor of vendors) {
        expect(`${file}: ${code.toLowerCase().includes(vendor)}`).toBe(
          `${file}: false`,
        )
      }
    }
  })
})
