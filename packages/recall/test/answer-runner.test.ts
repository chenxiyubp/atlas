// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer-layer executor end to end, without a network (P16.3 DoD):
 *
 *   - a scripted "model" answers a small plan; the exchanges are recorded to
 *     a fixture file, replayed with `fetch` disabled, and both reports equal
 *     the numbers worked out by hand below;
 *   - the two arms are interleaved, pair by pair;
 *   - a preset ledger spend stops the run before the first call, and a cap
 *     reached mid-run stays reached after a restart;
 *   - an `unreadable` citation voids the round;
 *   - the report's schema is the same whatever the run's status.
 *
 * The scripted model reads only the system prompt, the question and the
 * repetition — never the arm — so where both arms see the same block (the
 * 30 tier) they answer alike, as a real model would on average.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenLedger } from '../eval/answer/ledger.js'
import {
  type Exchange,
  FIXTURE_SCHEMA,
  readFixture,
  recordingTransport,
  replayTransport,
  writeFixture,
} from '../eval/answer/replay.js'
import {
  ADJUDICATION_FILE,
  ADJUDICATION_KEY_FILE,
  type AnswerReport,
  countedRecords,
  evaluateGates,
  type SummaryRow,
} from '../eval/answer/report.js'
import {
  type AnswerPlan,
  answerPlanOf,
  CALLS_FILE,
  checkPlan,
  m0Retriever,
  prepareTier,
  readCallLog,
  REPORT_FILE,
  runAnswerEval,
  secondRoundBound,
} from '../eval/answer/runner.js'
import { InvalidRound } from '../eval/answer/score.js'
import {
  m1Arm,
  replayEmbedder,
  standInEmbedder,
} from '../eval/answer/semantic.js'
import type {
  AnswerRequest,
  AnswerResponse,
  AnswerTransport,
  ArmRetriever,
} from '../eval/answer/types.js'
import { CORPORA } from '../eval/corpora.js'
import { parsePreregistration, type Preregistration } from '../eval/prereg.js'
import { UNBOUNDED } from '../eval/run.js'
import { contentHash, type EmbeddingProvider } from '../src/embedding.js'
import { buildRecallSystemPrompt } from '../src/inject.js'
import { recall } from '../src/recall.js'

const CORPUS = CORPORA['synthetic-v1']
const SEED = CORPUS.seeds[0] ?? 0
const DIGEST = CORPUS.digest()

function prereg(extra = ''): {
  values: Preregistration
  sha256: string
} {
  const text = [
    '[retrieval]',
    'alpha_primary = 0.025',
    '[answer]',
    'alpha_primary = 0.025',
    'noninferiority_delta = 0.05',
    'aa_alpha = 0.05',
    'bootstrap_iterations = 10000',
    extra,
    '[corpus]',
    `synthetic_v1_sha256 = "${DIGEST}"`,
  ].join('\n')
  return { values: parsePreregistration(text), sha256: 'test' }
}

const FULL_PREREG = prereg(
  'bootstrap_seed = 20260926\ne1_inference = "signflip"',
)

// ── the scripted model ──────────────────────────────────────────────────────

const TITLES = new Map(
  [30, 500].flatMap(tier =>
    CORPUS.build(tier, SEED).entries.map(entry => [entry.key, entry.title]),
  ),
)
const title = (key: string) => {
  const found = TITLES.get(key)
  if (found === undefined) throw new Error(`no entry ${key}`)
  return found
}

/** entry_id per title, in block order, read off the rendered system prompt. */
function idsByTitle(system: readonly string[]): Map<string, string> {
  const ids = new Map<string, string>()
  let current: string | null = null
  for (const line of system.join('\n').split('\n')) {
    if (line.startsWith('entry_id: ')) current = line.slice(10)
    else if (line.startsWith('title: ') && current !== null) {
      ids.set(line.slice(7), current)
      current = null
    }
  }
  return ids
}

function parseKey(callKey: string) {
  const [, tier, , queryId, provider, rep, , round] = callKey.split('/')
  return {
    tier: Number(tier),
    queryId: queryId ?? '',
    provider: provider ?? '',
    rep: Number((rep ?? '').slice(3)),
    round: Number((round ?? '').slice(1)),
  }
}

const NOTHING = '记忆里没有记录这件事。'

function fail(): never {
  throw new Error('expected a value')
}

function respond(request: AnswerRequest): AnswerResponse {
  const { queryId, provider, rep, round } = parseKey(request.callKey)
  const tool = (answer: string, citations: string[]): AnswerResponse => ({
    model: `${provider}-model-v1`,
    thinking: provider === 'prov-a' ? '先查记忆块。' : '',
    text: '',
    toolCalls: [
      {
        id: `call-${round}`,
        name: 'qianmo_memory_answer',
        input: { answer, citations },
      },
    ],
    stopReason: 'tool_use',
    usage: { input: 1000 + round, output: 100 },
  })
  if (round === 2) return tool(NOTHING, [])
  const ids = idsByTitle(request.system)
  const wake = ids.get(title('wake'))
  switch (queryId) {
    case 'lex-wake':
    case 'mis-wake': {
      if (queryId === 'mis-wake' && provider === 'prov-b' && rep === 3) {
        return { ...tool('', []), toolCalls: [], text: '大概是一分钟吧。' }
      }
      if (wake === undefined) return tool(NOTHING, [])
      const answer =
        rep === 3
          ? '见记忆条目。'
          : queryId === 'lex-wake'
            ? '唤醒间隔定为六十秒。'
            : '唤醒间隔是 ６０ 秒。'
      return tool(answer, [wake])
    }
    case 'fab-react':
      return provider === 'prov-a' && rep === 1
        ? tool('定了用 React。', ['qm-mem-deadbeef00000000'])
        : tool(NOTHING, [])
    case 'uns-wake': {
      if (ids.size > 100) {
        const first = [...ids.values()].find(id => id !== wake)
        return tool('有相关记录。', first === undefined ? [] : [first])
      }
      return tool('相关的只有唤醒间隔这条。', wake === undefined ? [] : [wake])
    }
    default:
      return tool(NOTHING, [])
  }
}

function scripted(providerId: string, log?: string[]): AnswerTransport {
  return {
    providerId,
    requestedModel: `${providerId}-model`,
    maxOutputTokens: 8192,
    inputUpperBound: () => 2000,
    send: async request => {
      log?.push(request.callKey)
      return respond(request)
    },
  }
}

/** A stand-in M1 for the test: every entry injected. */
const everything: ArmRetriever = (store, request) =>
  recall(store, { ...request, budget: UNBOUNDED })

const QUERIES = ['lex-wake', 'mis-wake', 'fab-react', 'uns-wake']

const PLAN: AnswerPlan = {
  runId: 'replay-check',
  phase: 'trial',
  corpora: [{ id: 'synthetic-v1', tiers: [30, 500] }],
  repetitions: 3,
  arms: ['m0', 'm1'],
  providers: ['prov-a', 'prov-b'],
  seed: SEED,
  primaryCorpus: 'synthetic-v1',
  concurrency: 2,
  queryIds: QUERIES,
}

/** The executor's hold for a second round, for these scripted transports. */
const HOLD = secondRoundBound({ input: 2000 }, 8192)

const CAP = { input: 500_000, output: 200_000 }
const FIXED_NOW = () => new Date(Date.UTC(2026, 8, 26, 12, 0, 0))

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-answer-eval-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

async function run(
  plan: AnswerPlan,
  transports: readonly AnswerTransport[],
  options: {
    out: string
    ledger: string
    cap?: { input: number; output: number }
    retrievers?: Partial<Record<'m0' | 'm1', ArmRetriever>>
    prereg?: { values: Preregistration; sha256: string }
  },
): Promise<AnswerReport> {
  const ledger = TokenLedger.open(options.ledger, {
    runId: plan.runId,
    phase: plan.phase,
    cap: options.cap ?? CAP,
  })
  try {
    return await runAnswerEval(plan, {
      transports,
      retrievers: options.retrievers ?? { m0: m0Retriever, m1: everything },
      ledger,
      outDir: options.out,
      prereg: options.prereg ?? FULL_PREREG,
      now: FIXED_NOW,
    })
  } finally {
    ledger.close()
  }
}

// ── hand computation ────────────────────────────────────────────────────────
//
// Facts the arithmetic rests on (asserted in the test): in the 30 tier every
// decision is in the block for both arms; in the 500 tier M0 injects the gold
// of lex-wake and the acceptable entry of uns-wake but not the gold of
// mis-wake, and the stand-in M1 injects all 500 entries.
//
// Per (tier, arm, question), over 2 providers × 3 repetitions = 6 calls:
//   lex-wake   gold cited every time; reps 1–2 say 「六十」, rep 3 does not
//              → hits 4, without mention 6, citations 6
//   mis-wake   gold in the block: reps 1–2 hit (「６０」 → NFKC 60), rep 3 of
//              prov-a cites without the mention, rep 3 of prov-b calls no tool
//              → hits 4, without mention 5, citations 5
//              gold not in the block (500·M0): cites nothing → all 0
//   fab-react  prov-a rep 1 cites a fabricated id → rejected, second round
//              cites nothing → citations 1, fabricated 1, one second round
//   uns-wake   ≤ 100 entries: cites its acceptable entry → citations 6, no
//              misattribution; 500 entries (500·M1): cites the first other
//              entry → accepted, outside S → misattributed 6

const ZERO_ROW = {
  calls: 6,
  hits: 0,
  hitsWithoutMention: 0,
  misattributed: 0,
  finalHits: 0,
  finalMisattributed: 0,
  callsWithFabricated: 0,
  citations: 0,
  fabricatedCitations: 0,
  outOfBoundsCitations: 0,
  secondRounds: 0,
}

const row = (
  tier: number,
  arm: 'm0' | 'm1',
  kind: string,
  counts: Partial<typeof ZERO_ROW>,
): SummaryRow => ({
  corpus: 'synthetic-v1',
  tier,
  arm,
  kind,
  ...ZERO_ROW,
  ...counts,
})

const LEX_HIT = { hits: 4, hitsWithoutMention: 6, finalHits: 4, citations: 6 }
const MIS_HIT = { hits: 4, hitsWithoutMention: 5, finalHits: 4, citations: 5 }
const FAB = {
  callsWithFabricated: 1,
  citations: 1,
  fabricatedCitations: 1,
  secondRounds: 1,
}
const UNS = { citations: 6 }

const HAND_SUMMARY: SummaryRow[] = [
  row(30, 'm0', 'positive-lexical', LEX_HIT),
  row(30, 'm1', 'positive-lexical', LEX_HIT),
  row(30, 'm0', 'positive-mismatch', MIS_HIT),
  row(30, 'm1', 'positive-mismatch', MIS_HIT),
  row(30, 'm0', 'negative-fabricated', FAB),
  row(30, 'm1', 'negative-fabricated', FAB),
  row(30, 'm0', 'negative-unsupported', UNS),
  row(30, 'm1', 'negative-unsupported', UNS),
  row(500, 'm0', 'positive-lexical', LEX_HIT),
  row(500, 'm1', 'positive-lexical', LEX_HIT),
  row(500, 'm0', 'positive-mismatch', {}),
  row(500, 'm1', 'positive-mismatch', MIS_HIT),
  row(500, 'm0', 'negative-fabricated', FAB),
  row(500, 'm1', 'negative-fabricated', FAB),
  row(500, 'm0', 'negative-unsupported', UNS),
  row(500, 'm1', 'negative-unsupported', {
    ...UNS,
    misattributed: 6,
    finalMisattributed: 6,
  }),
]

describe('record, then replay without a network', () => {
  test('both reports equal the hand computation', async () => {
    // The premises of the hand computation.
    const premise = await prepareTier(
      'synthetic-v1',
      500,
      { arms: ['m0', 'm1'], queryIds: QUERIES, seed: SEED },
      { m0: m0Retriever, m1: everything },
    )
    try {
      const injected = (queryId: string, arm: 'm0' | 'm1') =>
        (premise.queries.get(queryId)?.results[arm]?.entries ?? []).map(e =>
          premise.materialised.keyOf(e.entry.id),
        )
      expect(injected('lex-wake', 'm0')).toContain('wake')
      expect(injected('mis-wake', 'm0')).not.toContain('wake')
      expect(injected('uns-wake', 'm0')).toContain('wake')
      expect(injected('uns-wake', 'm0').length).toBe(50)
      expect(injected('mis-wake', 'm1').length).toBe(500)
    } finally {
      premise.materialised.dispose()
    }
    const sink: Record<string, Exchange> = {}
    const recorded = await run(
      PLAN,
      ['prov-a', 'prov-b'].map(id => recordingTransport(scripted(id), sink)),
      { out: join(directory, 'live'), ledger: join(directory, 'ledger.json') },
    )
    const fixturePath = join(directory, 'fixture.json')
    writeFixture(fixturePath, { schema: FIXTURE_SCHEMA, exchanges: sink })

    // 48 pairs; four fabricated calls went to a second round.
    expect(Object.keys(sink).length).toBe(96 + 4)
    expect(recorded.status).toBe('complete')
    expect(recorded.calls).toEqual({
      planned: 96,
      completed: 96,
      pairsPlanned: 48,
      pairsCompleted: 48,
      failed: 0,
    })
    expect(recorded.corpora[0]?.tiers).toEqual([
      { tier: 30, mode: 'full' },
      { tier: 500, mode: 'ranked' },
    ])
    expect(recorded.summary).toEqual(HAND_SUMMARY)

    // Tokens: 96 first rounds at 1001 in, 4 second rounds at 1002 in,
    // 100 out each — the reported usage, and exactly what the ledger holds.
    const spent = { input: 96 * 1001 + 4 * 1002, output: 100 * 100 }
    expect(recorded.tokens.reported).toEqual(spent)
    expect(recorded.tokens.ledger.run.spent).toEqual(spent)
    expect(recorded.providers.map(p => p.observedModels)).toEqual([
      ['prov-a-model-v1'],
      ['prov-b-model-v1'],
    ])

    const gates = recorded.gates
    // A0: the 30 tier gives both arms the same block; no difference.
    expect(gates.A0.status).toBe('pass')
    expect(gates.A0.tests.map(t => [t.name, t.questions, t.p])).toEqual([
      ['A0·H', 2, 1],
      ['A0·HR_mis', 4, 1],
    ])
    // E1: per-question H differences at 500 are lex 0 and mis
    // (2/3 + 2/3) / 2 = 2/3; mean 1/3; one non-zero difference → p = 1/2.
    expect(gates.E1.status).toBe('fail')
    expect(gates.E1.questions).toBe(2)
    expect(gates.E1.meanDifference).toBeCloseTo(1 / 3, 12)
    expect(gates.E1.p).toBe(0.5)
    // E2: HR_mis differences 0, 0, 0, 1 → mean 1/4; the 97.5 % bootstrap
    // point of a 4-draw mean from {0,0,0,1} is 3/4 (see the stats test).
    expect(gates.E2.status).toBe('fail')
    expect(gates.E2.meanDifference).toBe(0.25)
    expect(gates.E2.upperBound).toBe(0.75)
    // A4: the fabricated question has no accepted citation in either arm.
    expect(gates.A4).toEqual({
      status: 'pass',
      reason: null,
      m0: 0,
      m1: 0,
      newCases: [],
    })
    expect(gates.A5.comparisons.map(c => [c.name, c.p, c.pHolm])).toEqual(
      [
        'synthetic-v1·H·positive-lexical',
        'synthetic-v1·H·positive-mismatch',
        'synthetic-v1·H·tier500',
        'synthetic-v1·H(no mustMention)',
        'synthetic-v1·H(after one rejection)',
        'synthetic-v1·HR_mis(after one rejection)',
        'synthetic-v1·HR_fab(per call)',
        'synthetic-v1·out-of-bounds(per call)',
      ].map(name => [name, 1, 1]),
    )
    // A6: uns-wake at 500, 2 providers × 3 repetitions.
    expect(gates.A6.cases).toBe(6)
    const blinded = readFileSync(
      join(directory, 'live', ADJUDICATION_FILE),
      'utf8',
    )
    expect(JSON.parse(blinded).length).toBe(6)
    expect(blinded).not.toContain('"m0"')
    expect(blinded).not.toContain('"m1"')
    const key = JSON.parse(
      readFileSync(join(directory, 'live', ADJUDICATION_KEY_FILE), 'utf8'),
    ) as { X: string; Y: string }[]
    expect(key.every(k => new Set([k.X, k.Y]).size === 2)).toBe(true)
    expect(recorded.validity).toEqual({ valid: true, reasons: [] })

    // Replay from the file, with the network disabled.
    const realFetch = globalThis.fetch
    let networkAttempts = 0
    globalThis.fetch = (() => {
      networkAttempts += 1
      throw new Error('network used during replay')
    }) as unknown as typeof fetch
    let replayed: AnswerReport
    try {
      const fixture = readFixture(fixturePath)
      replayed = await run(
        { ...PLAN, runId: 'replay-check-2' },
        ['prov-a', 'prov-b'].map(id =>
          replayTransport(fixture, {
            providerId: id,
            requestedModel: `${id}-model`,
            maxOutputTokens: 8192,
          }),
        ),
        {
          out: join(directory, 'replay'),
          ledger: join(directory, 'replay-ledger.json'),
        },
      )
    } finally {
      globalThis.fetch = realFetch
    }
    expect(networkAttempts).toBe(0)
    expect(replayed.summary).toEqual(HAND_SUMMARY)
    expect(replayed.gates).toEqual(recorded.gates)
    expect(replayed.tokens.reported).toEqual(spent)
    const byKey = (path: string) =>
      readCallLog(path)
        .map(record => JSON.stringify(record))
        .sort()
    expect(byKey(join(directory, 'replay', CALLS_FILE))).toEqual(
      byKey(join(directory, 'live', CALLS_FILE)),
    )

    // Other preregistered choices, on the same log: the bootstrap reading
    // of E1 (reproducible), and missing values → not evaluable, by name.
    const records = countedRecords(
      readCallLog(join(directory, 'live', CALLS_FILE)),
      PLAN.arms,
    )
    const context = {
      arms: PLAN.arms,
      primaryCorpus: 'synthetic-v1',
      rankedTiers: () => [500],
      smallTier: () => 30,
      positiveKinds: () => ['positive-lexical', 'positive-mismatch'],
      corpora: ['synthetic-v1'],
    }
    const bootstrap = prereg(
      'bootstrap_seed = 20260926\ne1_inference = "bootstrap"',
    ).values
    const once = evaluateGates(records, { ...context, prereg: bootstrap })
    const twice = evaluateGates(records, { ...context, prereg: bootstrap })
    expect(once.E1).toEqual(twice.E1)
    // Two questions, differences {0, 2/3}: resampled means 0, 1/3, 2/3
    // with P(0) = 1/4 → the 2.5 % point is 0 and E1 fails.
    expect(once.E1.lowerBound).toBe(0)
    expect(once.E1.status).toBe('fail')
    expect(once.E1.p).toBeGreaterThan(0.23)
    expect(once.E1.p).toBeLessThan(0.27)
    const bare = evaluateGates(records, {
      ...context,
      prereg: prereg('').values,
    })
    expect([bare.E1.status, bare.E1.reason]).toEqual([
      'not-evaluable',
      'preregistration: answer.e1_inference not generated',
    ])
    expect([bare.E2.status, bare.E2.reason]).toEqual([
      'not-evaluable',
      'preregistration: answer.bootstrap_seed not generated',
    ])
  }, 120_000)

  test('a request that differs from the recorded one is refused', async () => {
    const fixture = {
      schema: FIXTURE_SCHEMA,
      exchanges: {
        k: {
          provider: 'prov-a',
          requestSha256: '0'.repeat(64),
          response: respond({
            callKey: 'x/30/1/q/prov-a/rep1/m0/r1',
            system: [],
            turns: [],
          }),
        },
      },
    } as const
    const transport = replayTransport(fixture, {
      providerId: 'prov-a',
      requestedModel: 'm',
      maxOutputTokens: 1,
    })
    await expect(
      transport.send({ callKey: 'k', system: ['s'], turns: [] }),
    ).rejects.toThrow(/differs from the recorded one/)
    await expect(
      transport.send({ callKey: 'missing', system: [], turns: [] }),
    ).rejects.toThrow(/not in the fixture/)
  })
})

describe('the M1 arm: P16.6 hybrid retrieval, replayed from recorded vectors', () => {
  const retrievalOf = (result: object | undefined): unknown =>
    result !== undefined && 'retrieval' in result ? result.retrieval : null

  /** A stand-in live embedder that files every vector it hands out. */
  function recording(vectors: Record<string, number[]>): EmbeddingProvider {
    return {
      id: 'test-embedder',
      model: 'test-v1',
      dimensions: standInEmbedder.dimensions,
      embed: async (texts, options) => {
        const batch = await standInEmbedder.embed(texts, options)
        for (const [index, text] of texts.entries()) {
          vectors[contentHash(text)] = [...(batch.vectors[index] ?? [])]
        }
        return batch
      },
    }
  }

  test('ranked: hybrid on a warm index with the floor kept; full: the M0 block', async () => {
    const arm = m1Arm(standInEmbedder)
    const retrievers = { m0: m0Retriever, m1: arm.retrieve }
    const plan = { arms: ['m0', 'm1'] as const, queryIds: QUERIES, seed: SEED }
    const ranked = await prepareTier('synthetic-v1', 500, plan, retrievers)
    try {
      let filled = 0
      for (const { results } of ranked.queries.values()) {
        const [m0, m1] = [results.m0, results.m1]
        if (m0 === undefined || m1 === undefined) fail()
        expect(retrievalOf(m1)).toBe('hybrid')
        const floor = Math.ceil(m0.entries.length / 2)
        const ids = (r: typeof m0) => r.entries.map(e => e.entry.id)
        expect(ids(m1).slice(0, floor)).toEqual(ids(m0).slice(0, floor))
        expect(buildRecallSystemPrompt(m1).join('\n')).toContain(
          'retrieval="hybrid"',
        )
        if (ids(m1).some(id => !ids(m0).includes(id))) filled += 1
      }
      // The stand-in is not semantic, but its fill does change the block.
      expect(filled).toBeGreaterThan(0)
    } finally {
      ranked.materialised.dispose()
    }
    const full = await prepareTier('synthetic-v1', 30, plan, retrievers)
    try {
      for (const { results } of full.queries.values()) {
        const [m0, m1] = [results.m0, results.m1]
        if (m0 === undefined || m1 === undefined) fail()
        expect(retrievalOf(m1)).toBe('deterministic')
        expect(buildRecallSystemPrompt(m1)).toEqual(buildRecallSystemPrompt(m0))
      }
    } finally {
      full.materialised.dispose()
    }
    // One backfill per tier, one query embedded per ranked question; full
    // mode embeds no query.
    const tokens = arm.embeddingTokens()
    expect(tokens.backfill).toBeGreaterThan(0)
    expect(tokens.recall).toBeGreaterThan(0)
  }, 60_000)

  test('record, then replay: same report; a missing or changed vector is refused', async () => {
    const plan = { ...PLAN, runId: 'm1-record', repetitions: 1 }
    const vectors: Record<string, number[]> = {}
    const sink: Record<string, Exchange> = {}
    const recorded = await run(
      plan,
      ['prov-a', 'prov-b'].map(id => recordingTransport(scripted(id), sink)),
      {
        out: join(directory, 'live'),
        ledger: join(directory, 'ledger.json'),
        retrievers: { m0: m0Retriever, m1: m1Arm(recording(vectors)).retrieve },
      },
    )
    expect(recorded.status).toBe('complete')
    const fixturePath = join(directory, 'fixture.json')
    writeFixture(fixturePath, {
      schema: FIXTURE_SCHEMA,
      exchanges: sink,
      embeddings: {
        embedder: {
          id: 'test-embedder',
          model: 'test-v1',
          dimensions: standInEmbedder.dimensions,
        },
        vectors,
      },
    })
    const fixture = readFixture(fixturePath)
    const embeddings = fixture.embeddings ?? fail()
    const transports = () =>
      ['prov-a', 'prov-b'].map(id =>
        replayTransport(fixture, {
          providerId: id,
          requestedModel: `${id}-model`,
          maxOutputTokens: 8192,
        }),
      )

    const realFetch = globalThis.fetch
    let networkAttempts = 0
    globalThis.fetch = (() => {
      networkAttempts += 1
      throw new Error('network used during replay')
    }) as unknown as typeof fetch
    let replayed: AnswerReport
    try {
      replayed = await run({ ...plan, runId: 'm1-replay' }, transports(), {
        out: join(directory, 'replay'),
        ledger: join(directory, 'replay-ledger.json'),
        retrievers: {
          m0: m0Retriever,
          m1: m1Arm(replayEmbedder(embeddings)).retrieve,
        },
      })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(networkAttempts).toBe(0)
    expect(replayed.status).toBe('complete')
    expect(replayed.summary).toEqual(recorded.summary)
    expect(replayed.gates).toEqual(recorded.gates)
    const byKey = (path: string) =>
      readCallLog(path)
        .map(record => JSON.stringify(record))
        .sort()
    expect(byKey(join(directory, 'replay', CALLS_FILE))).toEqual(
      byKey(join(directory, 'live', CALLS_FILE)),
    )

    // A vector the run used is missing: the M1 arm degrades, and the
    // eval stops instead of scoring M0 under M1's name.
    const question =
      CORPUS.build(500, SEED).queries.find(q => q.id === 'mis-wake')
        ?.question ?? fail()
    const queryHash = contentHash(question)
    expect(embeddings.vectors[queryHash]).toBeDefined()
    const rest = Object.fromEntries(
      Object.entries(embeddings.vectors).filter(([hash]) => hash !== queryHash),
    )
    await expect(
      run({ ...plan, runId: 'm1-missing' }, transports(), {
        out: join(directory, 'missing'),
        ledger: join(directory, 'missing-ledger.json'),
        retrievers: {
          m0: m0Retriever,
          m1: m1Arm(replayEmbedder({ ...embeddings, vectors: rest })).retrieve,
        },
      }),
    ).rejects.toThrow(
      /the M1 arm degraded to M0 \(embed-failed: replay: no recorded vector/,
    )

    // A vector that differs changes the M1 block, and the recorded answer
    // no longer belongs to the request.
    const flipped = (embeddings.vectors[queryHash] ?? fail()).map(v => -v)
    const changed = await prepareTier(
      'synthetic-v1',
      500,
      { arms: ['m1'], queryIds: ['mis-wake'], seed: SEED },
      {
        m1: m1Arm(
          replayEmbedder({
            ...embeddings,
            vectors: { ...embeddings.vectors, [queryHash]: flipped },
          }),
        ).retrieve,
      },
    )
    try {
      const result = changed.queries.get('mis-wake')?.results.m1 ?? fail()
      const key =
        Object.keys(sink).find(k =>
          /\/500\/.*\/mis-wake\/prov-a\/rep1\/m1\/r1$/.test(k),
        ) ?? fail()
      await expect(
        transports()[0]?.send({
          callKey: key,
          system: buildRecallSystemPrompt(result),
          turns: [{ role: 'user', text: question }],
        }),
      ).rejects.toThrow(/differs from the recorded one/)
    } finally {
      changed.materialised.dispose()
    }
  }, 120_000)
})

describe('schedule', () => {
  test('the arms are interleaved pair by pair, and the coin decides who goes first', async () => {
    const ids = CORPUS.build(30, SEED)
      .queries.slice(0, 10)
      .map(q => q.id)
    const plan: AnswerPlan = {
      ...PLAN,
      runId: 'interleave',
      corpora: [{ id: 'synthetic-v1', tiers: [30] }],
      queryIds: ids,
      concurrency: 1,
    }
    const log: string[] = []
    await run(plan, [scripted('prov-a', log), scripted('prov-b', log)], {
      out: join(directory, 'serial'),
      ledger: join(directory, 'l1.json'),
    })
    const firsts = log.filter(key => key.endsWith('/r1'))
    expect(firsts.length).toBe(10 * 2 * 3 * 2)
    let m1First = 0
    for (let i = 0; i < firsts.length; i += 2) {
      const a = firsts[i] ?? ''
      const b = firsts[i + 1] ?? ''
      // Same unit, the other arm, immediately after.
      expect(a.split('/').slice(0, 6)).toEqual(b.split('/').slice(0, 6))
      expect(new Set([a.split('/')[6], b.split('/')[6]])).toEqual(
        new Set(['m0', 'm1']),
      )
      if (a.split('/')[6] === 'm1') m1First += 1
    }
    expect(m1First).toBeGreaterThan(15)
    expect(m1First).toBeLessThan(45)

    const parallel: string[] = []
    await run(
      { ...plan, runId: 'interleave-4', concurrency: 4 },
      [scripted('prov-a', parallel), scripted('prov-b', parallel)],
      { out: join(directory, 'parallel'), ledger: join(directory, 'l2.json') },
    )
    let balance = 0
    for (const key of parallel.filter(k => k.endsWith('/r1'))) {
      balance += key.split('/')[6] === 'm0' ? 1 : -1
      expect(Math.abs(balance)).toBeLessThanOrEqual(4)
    }
    expect(balance).toBe(0)
  }, 60_000)
})

describe('token cap', () => {
  const small: AnswerPlan = {
    ...PLAN,
    runId: 'cap',
    corpora: [{ id: 'synthetic-v1', tiers: [30] }],
    concurrency: 1,
  }

  test('a preset spend at the ceiling stops the run before the first call', async () => {
    const ledgerPath = join(directory, 'ledger.json')
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema: 'qianmo-recall-answer-ledger/v1',
        spent: { input: 18_500_000 - 1_999, output: 0 },
        byPhase: {
          trial: { input: 0, output: 0 },
          comparison: { input: 18_500_000 - 1_999, output: 0 },
        },
        runs: {},
        pending: {},
        orphaned: { reservations: 0, charged: { input: 0, output: 0 } },
        overshoots: 0,
      }),
    )
    const log: string[] = []
    const report = await run(
      small,
      [scripted('prov-a', log), scripted('prov-b', log)],
      {
        out: join(directory, 'out'),
        ledger: ledgerPath,
        cap: { input: 1_999, output: 100_000 },
      },
    )
    expect(log).toEqual([])
    expect(report.status).toBe('capped')
    expect(report.calls.completed).toBe(0)
    expect(report.stop?.detail).toContain('ceiling input has 1999 left')
    expect(existsSync(join(directory, 'out', REPORT_FILE))).toBe(true)
    expect(report.validity.valid).toBe(false)
  }, 30_000)

  test('a call whose second round would not fit is not started', async () => {
    // Room for the first round's 2000, but not also for the held second
    // round: the run stops before anything is sent.
    const tight = { input: 2000 + HOLD.input - 1, output: 100_000 }
    const log: string[] = []
    const refused = await run(
      small,
      [scripted('prov-a', log), scripted('prov-b', log)],
      {
        out: join(directory, 'tight'),
        ledger: join(directory, 'tight.json'),
        cap: tight,
      },
    )
    expect(log).toEqual([])
    expect(refused.status).toBe('capped')
    expect(refused.stop?.detail).toContain('token cap reached: run input')
    // One token more and the first call goes out.
    const roomy = await run(
      { ...small, runId: 'cap-roomy' },
      [scripted('prov-a', log), scripted('prov-b', log)],
      {
        out: join(directory, 'roomy'),
        ledger: join(directory, 'roomy.json'),
        cap: { input: tight.input + 1, output: 100_000 },
      },
    )
    expect(log.length).toBeGreaterThan(0)
    expect(roomy.calls.completed).toBeGreaterThan(0)
  }, 30_000)

  test('a cap reached mid-run keeps what was done and stays reached after a restart', async () => {
    const ledgerPath = join(directory, 'ledger.json')
    const out = join(directory, 'out')
    // Each call needs 2000 reserved plus the second-round hold free, and
    // settles 1001 (second rounds 1002).
    const cap = { input: 2000 + HOLD.input + 20_000, output: 100_000 }
    const log: string[] = []
    const transports = [scripted('prov-a', log), scripted('prov-b', log)]
    const first = await run(small, transports, { out, ledger: ledgerPath, cap })
    expect(first.status).toBe('capped')
    expect(first.calls.completed).toBeGreaterThan(0)
    expect(first.calls.completed).toBeLessThan(first.calls.planned)
    expect(readCallLog(join(out, CALLS_FILE)).length).toBe(
      first.calls.completed,
    )
    const spent = first.tokens.ledger.run.spent
    expect(spent.input).toBeLessThanOrEqual(cap.input)
    // Every send is a recorded round: with the hold, no first round was paid
    // for and then lost because its second round no longer fitted.
    const rounds = readCallLog(join(out, CALLS_FILE)).reduce(
      (sum, record) => sum + record.rounds.length,
      0,
    )
    expect(log.length).toBe(rounds)
    expect(rounds).toBeGreaterThan(first.calls.completed)

    // "Restart": a new ledger instance on the same file, the same run.
    const before = log.length
    const second = await run(small, transports, {
      out,
      ledger: ledgerPath,
      cap,
    })
    expect(log.length).toBe(before)
    expect(second.status).toBe('capped')
    expect(second.tokens.ledger.run.spent).toEqual(spent)
    expect(second.calls.completed).toBe(first.calls.completed)
  }, 30_000)
})

describe('failure modes', () => {
  test('an unreadable citation voids the round, after writing the report', async () => {
    const roots: string[] = []
    const capture: ArmRetriever = (store, request) => {
      roots.push(store.root)
      return recall(store, request)
    }
    const projectKey = CORPUS.build(30, SEED).scope.projectKey ?? ''
    const corrupting: AnswerTransport = {
      ...scripted('prov-a'),
      send: async request => {
        const wake = idsByTitle(request.system).get(title('wake')) ?? ''
        writeFileSync(
          join(roots[0] ?? '', 'project', projectKey, `${wake}.md`),
          'damaged',
        )
        return respond(request)
      },
    }
    const out = join(directory, 'out')
    await expect(
      run(
        {
          ...PLAN,
          runId: 'unreadable',
          corpora: [{ id: 'synthetic-v1', tiers: [30] }],
          arms: ['m0'],
          providers: ['prov-a'],
          repetitions: 1,
          queryIds: ['lex-wake'],
        },
        [corrupting],
        { out, ledger: join(directory, 'l.json'), retrievers: { m0: capture } },
      ),
    ).rejects.toThrow(InvalidRound)
    const report = JSON.parse(
      readFileSync(join(out, REPORT_FILE), 'utf8'),
    ) as AnswerReport
    expect(report.status).toBe('invalid')
    expect(report.validity.reasons).toContain('run invalid')
  }, 30_000)

  test('two arms without an M1 retriever, or transports other than the plan providers, are refused', async () => {
    const both = [scripted('prov-a'), scripted('prov-b')]
    await expect(
      run(PLAN, both, {
        out: join(directory, 'a'),
        ledger: join(directory, 'a.json'),
        retrievers: { m0: m0Retriever },
      }),
    ).rejects.toThrow(/M1 arm has no retriever/)
    await expect(
      run(PLAN, [scripted('prov-a')], {
        out: join(directory, 'b'),
        ledger: join(directory, 'b.json'),
      }),
    ).rejects.toThrow(/exactly the plan's providers/)
  })

  test('the comparison is the preregistered [plan] and nothing else', () => {
    const planText = [
      '[plan]',
      'arms = ["m0", "m1"]',
      'repetitions = 1',
      'providers = ["prov-a", "prov-b"]',
      `seed = ${SEED}`,
      'synthetic_v1_tiers = [30, 500, 2000]',
      'docs_dev_v1_tiers = [599]',
      'primary_corpus = "synthetic-v1"',
    ].join('\n')
    const withPlan = parsePreregistration(planText)
    const preregistered = answerPlanOf(withPlan.plan ?? fail(), {
      runId: 'p',
      phase: 'comparison',
      concurrency: 2,
    })
    expect(preregistered.corpora).toEqual([
      { id: 'synthetic-v1', tiers: [30, 500, 2000] },
      { id: 'docs-dev-v1', tiers: [599] },
    ])
    expect(() => checkPlan(preregistered, withPlan)).not.toThrow()
    for (const narrowed of [
      { ...preregistered, repetitions: 3 },
      { ...preregistered, arms: ['m0' as const] },
      { ...preregistered, corpora: preregistered.corpora.slice(0, 1) },
      { ...preregistered, providers: ['prov-a'] },
      { ...preregistered, queryIds: ['lex-wake'] },
    ]) {
      expect(() => checkPlan(narrowed, withPlan)).toThrow(
        /preregistered plan of prereg.toml \[plan\] exactly/,
      )
    }
    // docs-dev-v1 has one seed, so another seed is refused even earlier.
    expect(() =>
      checkPlan({ ...preregistered, seed: SEED + 1 }, withPlan),
    ).toThrow(/docs-dev-v1 has no seed/)
    // No [plan] in the file: the comparison cannot run at all.
    expect(() => checkPlan(preregistered, prereg().values)).toThrow(
      /plan is not generated yet/,
    )
  })
})

describe('report schema', () => {
  const TOP = [
    'schema',
    'status',
    'runId',
    'phase',
    'finishedAt',
    'protocol',
    'preregistration',
    'corpora',
    'providers',
    'calls',
    'tokens',
    'summary',
    'gates',
    'validity',
    'stop',
  ]
  const GATES = {
    A0: ['status', 'reason', 'alpha', 'tests'],
    E1: [
      'method',
      'alpha',
      'questions',
      'meanDifference',
      'status',
      'reason',
      'p',
      'lowerBound',
    ],
    E2: [
      'alpha',
      'delta',
      'questions',
      'meanDifference',
      'status',
      'reason',
      'upperBound',
    ],
    A4: ['status', 'reason', 'm0', 'm1', 'newCases'],
    A5: ['status', 'reason', 'comparisons'],
    A6: ['status', 'reason', 'cases', 'file'],
  }
  const sorted = (keys: string[]) => [...keys].sort()

  test('the same keys whether the run completed, was capped or had one arm', async () => {
    const plan: AnswerPlan = {
      ...PLAN,
      runId: 'schema',
      corpora: [{ id: 'synthetic-v1', tiers: [30] }],
      providers: ['prov-a'],
      repetitions: 1,
    }
    const complete = await run(plan, [scripted('prov-a')], {
      out: join(directory, 'c'),
      ledger: join(directory, 'c.json'),
    })
    const capped = await run(plan, [scripted('prov-a')], {
      out: join(directory, 'd'),
      ledger: join(directory, 'd.json'),
      cap: { input: 100, output: 100_000 },
    })
    const single = await run({ ...plan, arms: ['m0'] }, [scripted('prov-a')], {
      out: join(directory, 'e'),
      ledger: join(directory, 'e.json'),
    })
    expect([complete.status, capped.status, single.status]).toEqual([
      'complete',
      'capped',
      'complete',
    ])
    for (const report of [complete, capped, single]) {
      expect(report.schema).toBe('qianmo-recall-answer-eval/v1')
      expect(Object.keys(report)).toEqual(TOP)
      for (const [gate, keys] of Object.entries(GATES)) {
        expect(
          sorted(Object.keys(report.gates[gate as keyof typeof GATES])),
        ).toEqual(sorted(keys))
      }
      for (const summaryRow of report.summary) {
        expect(Object.keys(summaryRow)).toEqual([
          'corpus',
          'tier',
          'arm',
          'kind',
          ...Object.keys(ZERO_ROW),
        ])
      }
    }
    // The call log carries no request body, key or host.
    const log = readFileSync(join(directory, 'c', CALLS_FILE), 'utf8')
    expect(log).not.toContain('entry_id:')
    expect(log).not.toContain('http')
  }, 60_000)
})
