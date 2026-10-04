// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  compareRanked,
  rankEntries,
  RANKING,
  recencyFactor,
  scoreEntry,
  tokenize,
} from '../src/index.js'
import { createSandbox, DAY_MS, type Sandbox } from './helpers.js'

let box: Sandbox

beforeEach(() => {
  box = createSandbox()
})

afterEach(() => {
  box.dispose()
})

describe('scoring', () => {
  test('a tag hit outweighs a keyword hit', () => {
    const tagged = box.write({
      title: 'unrelated wording entirely',
      tags: ['runtime'],
    })
    const worded = box.write({ title: 'runtime choices', tags: [] })
    const asOf = box.clock.now()

    const a = scoreEntry(tagged, { tags: ['runtime'], tokens: [], asOf })
    const b = scoreEntry(worded, { tokens: ['runtime'], asOf })

    expect(a.relevance).toBe(RANKING.tagWeight)
    expect(b.relevance).toBe(RANKING.headTokenWeight)
    expect(a.score).toBeGreaterThan(b.score)
  })

  test('a token in the title counts for more than one in the body', () => {
    const head = box.write({ title: 'bun is the runtime' })
    const body = box.write({ title: 'toolchain notes', body: 'we use bun' })
    const asOf = box.clock.now()

    expect(scoreEntry(head, { tokens: ['bun'], asOf }).relevance).toBe(
      RANKING.headTokenWeight,
    )
    expect(scoreEntry(body, { tokens: ['bun'], asOf }).relevance).toBe(
      RANKING.bodyTokenWeight,
    )
  })

  test('a token found in both places is counted once, at the higher weight', () => {
    const entry = box.write({ title: 'bun everywhere', body: 'bun bun bun' })
    const scored = scoreEntry(entry, {
      tokens: ['bun'],
      asOf: box.clock.now(),
    })
    expect(scored.matchedTokens).toEqual(['bun'])
    expect(scored.relevance).toBe(RANKING.headTokenWeight)
  })

  test('relevance dominates recency: a stale hit outranks a fresh miss', () => {
    const stale = box.write({ title: 'we standardised on bun' })
    box.clock.advance(365 * DAY_MS)
    const fresh = box.write({ title: 'unrelated note' })

    const [first, second] = rankEntries([fresh, stale], {
      tokens: ['bun'],
      asOf: box.clock.now(),
    })

    expect(first?.entry.id).toBe(stale.id)
    expect(second?.entry.id).toBe(fresh.id)
    expect(second?.score).toBe(0)
  })

  test('among equally relevant entries the newer one wins', () => {
    const older = box.write({ title: 'bun decision' })
    box.clock.advance(30 * DAY_MS)
    const newer = box.write({ title: 'bun decision' })

    const ranked = rankEntries([older, newer], {
      tokens: ['bun'],
      asOf: box.clock.now(),
    })
    expect(ranked.map(r => r.entry.id)).toEqual([newer.id, older.id])
    // One half-life of decay, exactly.
    expect(ranked[1]?.recency).toBe(0.5)
  })
})

describe('decay', () => {
  test('halves after one half-life', () => {
    const entry = box.write({ title: 'x' })
    const asOf = new Date(box.clock.now().getTime() + 30 * DAY_MS)
    expect(recencyFactor(entry, asOf)).toBeCloseTo(0.5, 12)
  })

  test('a future write time is not rewarded', () => {
    const entry = box.write({ title: 'x' })
    const asOf = new Date(box.clock.now().getTime() - 10 * DAY_MS)
    expect(recencyFactor(entry, asOf)).toBe(1)
  })
})

describe('ordering', () => {
  test('is total: equal scores fall through to write time, then id', () => {
    const first = box.write({ title: 'same' })
    const second = box.write({ title: 'same' })
    const asOf = box.clock.now()
    const a = scoreEntry(first, { tokens: [], asOf })
    const b = scoreEntry(second, { tokens: [], asOf })

    expect(a.score).toBe(b.score)
    expect(a.entry.createdAt).toBe(b.entry.createdAt)
    // Same score, same instant: the id breaks the tie, ascending.
    expect(compareRanked(a, b)).toBeLessThan(0)
    expect(compareRanked(b, a)).toBeGreaterThan(0)
  })

  test('the same inputs produce the same order every time', () => {
    const entries = [
      box.write({ title: '统一用 bun 作为运行时', tags: ['runtime'] }),
      box.write({ title: '测试器也用 bun test' }),
      box.write({ title: '发布流程不在本仓库' }),
    ]
    const input = {
      tokens: tokenize('本项目用什么运行时'),
      asOf: box.clock.now(),
    }
    const once = rankEntries(entries, input).map(r => r.entry.id)
    const twice = rankEntries([...entries].reverse(), input).map(
      r => r.entry.id,
    )
    expect(twice).toEqual(once)
  })
})
