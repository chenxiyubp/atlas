// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retrieval criteria (R2–R4) and the reference fusion, plus P16.2b's
 * acceptance: on the hardened corpus, a ranker that never reads the question
 * cannot pass R3 through the §5.1 fusion — and on the v0.1 corpus the same
 * code, same ranker, does pass, which is what shows the check can fail.
 */

import { describe, expect, test } from 'bun:test'
import type { MemoryEntry } from '@qianmo/memory'
import { buildDataset, DEFAULT_SEED } from '../eval/dataset.js'
import {
  fuseReference,
  memoizeForCandidateSet,
  NULL_RANKERS,
} from '../eval/fusion-reference.js'
import {
  buildHardenedDataset,
  HARDENED_SEEDS,
  hardenedSourceId,
} from '../eval/hardened.js'
import { loadPreregistration, required } from '../eval/prereg.js'
import {
  derangement,
  deterministicRankings,
  exactSignTestOneSided,
  idListDigest,
  matchesRecall,
  noRegression,
  type PairedCell,
  pairCells,
  referenceArms,
  signGate,
  tally,
} from '../eval/retrieval-gates.js'
import {
  type BaselineDataset,
  type MaterialiseOptions,
  materialise,
} from '../eval/run.js'
import { selectForInjection } from '../src/inject.js'
import type { RankedEntry } from '../src/rank.js'

const ALPHA = required(
  loadPreregistration().retrieval.alphaPrimary,
  'retrieval.alpha_primary',
)

describe('exact sign test', () => {
  test('matches hand-computed binomial tails', () => {
    expect(exactSignTestOneSided(0, 0)).toBe(1)
    expect(exactSignTestOneSided(1, 0)).toBe(0.5)
    expect(exactSignTestOneSided(5, 0)).toBe(1 / 32)
    expect(exactSignTestOneSided(6, 0)).toBe(1 / 64)
    // n = 7, P(X ≥ 6) = (C(7,6) + C(7,7)) / 128 = 8 / 128.
    expect(exactSignTestOneSided(6, 1)).toBe(8 / 128)
    expect(exactSignTestOneSided(0, 3)).toBe(1)
  })

  test('with no losses, R3 needs six wins at α = 0.025', () => {
    expect(exactSignTestOneSided(5, 0) < ALPHA).toBe(false)
    expect(exactSignTestOneSided(6, 0) < ALPHA).toBe(true)
  })
})

describe('paired tallies and gates', () => {
  const cell = (
    queryId: string,
    m0: boolean,
    m1: boolean,
    extra: Partial<PairedCell> = {},
  ): PairedCell => ({
    seed: 1,
    tier: 2000,
    kind: 'positive-mismatch',
    queryId,
    m0,
    m1,
    ...extra,
  })

  test('ties carry nothing; wins and losses are listed by id', () => {
    const cells = [
      cell('a', false, true),
      cell('b', true, false),
      cell('c', true, true),
      cell('d', false, false),
    ]
    expect(tally(cells)).toEqual({ wins: ['a'], losses: ['b'] })
  })

  test('R2 reports every losing cell, per seed, tier and kind', () => {
    const cells = [
      cell('a', true, false),
      cell('b', true, true, { kind: 'positive-lexical' }),
      cell('c', true, false, { seed: 2 }),
      cell('d', true, false, { tier: 30 }),
    ]
    expect(noRegression(cells, { tiers: [2000] })).toEqual([
      { seed: 1, tier: 2000, kind: 'positive-mismatch', lost: ['a'] },
      { seed: 2, tier: 2000, kind: 'positive-mismatch', lost: ['c'] },
    ])
  })

  test('R3 is judged per seed on the named questions of one tier', () => {
    const wins = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(id =>
      cell(id, false, true),
    )
    const verdicts = signGate([...wins, cell('other', true, false)], {
      tier: 2000,
      queryIds: new Set(wins.map(c => c.queryId)),
      alpha: ALPHA,
    })
    expect(verdicts).toEqual([
      { seed: 1, wins: 6, losses: 0, p: 1 / 64, pass: true },
    ])
  })

  test('per gold: the mean paired difference of its questions, zero dropped', () => {
    // d = m1 − m0 per question; the letter is the gold.
    const cells = [
      cell('a1', false, true), // A: (+1 + 0) / 2 > 0 → win
      cell('a2', false, false),
      cell('b1', false, true), // B: (+1 − 1) / 2 = 0 → dropped
      cell('b2', true, false),
      cell('c1', true, false), // C: (−1 + 0) / 2 < 0 → loss
      cell('c2', true, true),
      cell('d1', true, true), // D: every question ties → dropped
      cell('d2', false, false),
      cell('e1', false, true), // E: +1 → win
      cell('e2', false, true),
      cell('e3', false, true, { seed: 2 }), // another seed: its own test
    ]
    const queryIds = new Set(cells.map(c => c.queryId))
    const byGold = signGate(cells, {
      tier: 2000,
      queryIds,
      alpha: ALPHA,
      clusterOf: id => id.slice(0, 1),
    })
    expect(byGold).toEqual([
      { seed: 1, wins: 2, losses: 1, p: 0.5, pass: false },
      { seed: 2, wins: 1, losses: 0, p: 0.5, pass: false },
    ])
    // Per question the same seed-1 cells are 4 wins (a1 b1 e1 e2), 2 losses.
    expect(signGate(cells, { tier: 2000, queryIds, alpha: ALPHA })[0]).toEqual({
      seed: 1,
      wins: 4,
      losses: 2,
      p: 22 / 64,
      pass: false,
    })
  })
})

describe('shuffle permutation', () => {
  test('a derangement: a bijection with no fixed point, fixed by its seed', () => {
    const ids = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']
    const pi = derangement(ids, 7)
    expect([...pi.values()].sort()).toEqual([...ids].sort())
    for (const [from, to] of pi) expect(to).not.toBe(from)
    expect([...derangement([...ids].reverse(), 7)]).toEqual([...pi])
    expect([...derangement(ids, 8)]).not.toEqual([...pi])
    expect(() => derangement(['only'], 1)).toThrow(RangeError)
  })

  test('the id-list digest ignores order', () => {
    expect(idListDigest(['b', 'a'])).toBe(idListDigest(['a', 'b']))
    expect(idListDigest(['a'])).not.toBe(idListDigest(['a', 'b']))
  })
})

describe('reference fusion (§5.1)', () => {
  const entry = (id: string): MemoryEntry => ({
    id,
    scope: { layer: 'project', projectKey: 'p' },
    title: id,
    summary: '',
    body: 'x'.repeat(10),
    tags: [],
    source: { kind: 'import', id: 'fixture' },
    createdAt: '2026-01-01T00:00:00.000Z',
    expiredAt: null,
    validAt: '2026-01-01T00:00:00.000Z',
    invalidAt: null,
    retirement: null,
    derivedFrom: [],
  })
  const ranked = (id: string, relevance: number): RankedEntry => ({
    entry: entry(id),
    score: relevance,
    relevance,
    recency: 1,
    matchedTags: [],
    matchedTokens: [],
  })
  const budget = { maxEntries: 4, maxChars: 1_000_000 }

  test('full mode is left exactly as the deterministic block', () => {
    const det = [ranked('a', 2), ranked('b', 0), ranked('c', 0)]
    expect(fuseReference(det, [0, 9, 8], budget)).toEqual(
      selectForInjection(det, budget).chosen,
    )
  })

  test('the floor survives any semantic order', () => {
    const det = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
      ranked(id, i < 3 ? 3 - i : 0),
    )
    const fused = fuseReference(det, [0, 0, 0, 0, 0, 9], budget)
    expect(fused.slice(0, 2).map(r => r.entry.id)).toEqual(['a', 'b'])
    expect(fused.length).toBe(4)
  })

  test('zero-relevance entries share one rank, so recency casts no vote', () => {
    // After the floor (a, b), c has relevance 1; d, e, f have none and tie.
    // Semantic order among the tied three decides: f before e before d.
    const det = [
      ranked('a', 3),
      ranked('b', 2),
      ranked('c', 1),
      ranked('d', 0),
      ranked('e', 0),
      ranked('f', 0),
    ]
    const fused = fuseReference(det, [0, 0, 0, 1, 2, 3], {
      maxEntries: 5,
      maxChars: 1_000_000,
    })
    expect(fused.map(r => r.entry.id)).toEqual(['a', 'b', 'c', 'f', 'e'])
  })
})

type NamedRun = {
  readonly label: string
  readonly dataset: BaselineDataset
  readonly options: MaterialiseOptions
}

/** Plain positives only: R2 / R3 need nothing else, and it keeps this fast. */
function positivesOnly(dataset: BaselineDataset): BaselineDataset {
  return {
    ...dataset,
    queries: dataset.queries.filter(
      q => q.kind === 'positive-lexical' || q.kind === 'positive-mismatch',
    ),
  }
}

function nullRankerCells(run: NamedRun, name: string) {
  const scorer = NULL_RANKERS[name]
  if (scorer === undefined) throw new Error(`no null ranker ${name}`)
  const memo = memoizeForCandidateSet(scorer)
  const materialised = materialise(run.dataset, run.options)
  try {
    const ids = run.dataset.queries.map(q => q.id)
    const arms = referenceArms(
      materialised,
      run.dataset,
      entries => memo(entries),
      derangement(ids, 1),
    )
    return {
      real: pairCells(run.dataset, arms.m0, arms.m1),
      shuffled: pairCells(run.dataset, arms.shuffledM1, arms.m1),
    }
  } finally {
    materialised.dispose()
  }
}

function mismatchIds(dataset: BaselineDataset): ReadonlySet<string> {
  return new Set(
    dataset.queries.filter(q => q.kind === 'positive-mismatch').map(q => q.id),
  )
}

describe('the ranking shortcut is recall() itself', () => {
  test('one scope read, then rank per question, equals recall()', () => {
    const dataset = buildHardenedDataset(500, HARDENED_SEEDS[0] ?? 0)
    const materialised = materialise(dataset, { sourceIdOf: hardenedSourceId })
    try {
      const sample = dataset.queries.filter((_, index) => index % 9 === 0)
      const rankings = deterministicRankings(materialised.store, {
        ...dataset,
        queries: sample,
      })
      for (const query of sample) {
        expect(
          matchesRecall(
            materialised.store,
            dataset,
            query,
            rankings.get(query.id) ?? [],
          ),
        ).toBe(true)
      }
    } finally {
      materialised.dispose()
    }
  })
})

describe('P16.2b acceptance: null rankers on the hardened corpus', () => {
  test('positive control: on v0.1 the review outlier ranker passes R3 at 2000', () => {
    const dataset = positivesOnly(buildDataset(2000, DEFAULT_SEED))
    const { real } = nullRankerCells(
      { label: 'v0.1', dataset, options: {} },
      'outlier-unigram',
    )
    const [verdict] = signGate(real, {
      tier: 2000,
      queryIds: mismatchIds(dataset),
      alpha: ALPHA,
    })
    // If this stops passing, the check below proves nothing: it would no
    // longer be able to go red on the corpus it was written against.
    expect(verdict?.pass).toBe(true)
    expect(verdict?.losses).toBe(0)
  }, 60_000)

  for (const name of Object.keys(NULL_RANKERS)) {
    test(`${name} fails R3 at 2000 on every seed; R4 is not needed for that`, () => {
      for (const seed of HARDENED_SEEDS) {
        const dataset = positivesOnly(buildHardenedDataset(2000, seed))
        const { real, shuffled } = nullRankerCells(
          {
            label: `hardened/${seed}`,
            dataset,
            options: { sourceIdOf: hardenedSourceId },
          },
          name,
        )
        const ids = mismatchIds(dataset)
        const [r3] = signGate(real, { tier: 2000, queryIds: ids, alpha: ALPHA })
        if (r3 === undefined) throw new Error('no verdict')
        if (r3.pass) {
          throw new Error(
            `${name} passes R3 on seed ${seed}: ${r3.wins} wins / ${r3.losses} losses, p = ${r3.p}`,
          )
        }
        // R4 fails for any query-independent ranker by construction: the
        // shuffled arm injects exactly what the real arm injects.
        const [r4] = signGate(shuffled, {
          tier: 2000,
          queryIds: ids,
          alpha: ALPHA,
        })
        expect(r4?.wins).toBe(0)
        expect(r4?.losses).toBe(0)
      }
    }, 120_000)
  }
})
