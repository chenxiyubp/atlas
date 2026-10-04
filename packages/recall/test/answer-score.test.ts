// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Judging one call (§2.2): the verdict from the enforcement point, the
 * `mustMention` normalisation, and `unreadable` voiding the round (D-2).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEntry } from '@qianmo/memory'
import { recall, type RecallResult } from '../src/recall.js'
import {
  type AnswerLabels,
  InvalidRound,
  judgeRound,
  mentionsAll,
  normaliseForMention,
  scoreRound,
} from '../eval/answer/score.js'
import type { AnswerResponse } from '../eval/answer/types.js'
import { createSandbox, PROJECT_KEY, type Sandbox } from './helpers.js'

let box: Sandbox
let gold: MemoryEntry
let other: MemoryEntry
let result: RecallResult

beforeEach(() => {
  box = createSandbox()
  gold = box.write({ title: '唤醒间隔', body: '定为六十秒。' })
  other = box.write({ title: '别的决策', body: '与问题无关。' })
  result = recall(box.store, {
    scope: { layers: ['project'], projectKey: PROJECT_KEY },
  })
})

afterEach(() => box.dispose())

const keyOf = (id: string) =>
  id === gold.id ? 'gold' : id === other.id ? 'other' : `?${id}`

function answered(
  citations: unknown,
  answer = '唤醒间隔是６０ 秒',
): AnswerResponse {
  return {
    model: 'm',
    thinking: '',
    text: '',
    toolCalls: [
      {
        id: 'call-1',
        name: 'qianmo_memory_answer',
        input: { answer, citations },
      },
    ],
    stopReason: 'tool_use',
    usage: { input: 10, output: 5 },
  }
}

const judge = (response: AnswerResponse) =>
  judgeRound({ store: box.store, result, response, keyOf, callKey: 'k' })

const labels: AnswerLabels = {
  kind: 'positive-lexical',
  gold: ['gold'],
  acceptable: [],
  mentions: [['60', '六十']],
}

describe('mustMention', () => {
  test('NFKC, lower case, no whitespace; any alternative will do', () => {
    expect(normaliseForMention('Ｂｕｎ  Test\n')).toBe('buntest')
    expect(mentionsAll('间隔为 ６０ 秒', [['60', '六十']])).toBe(true)
    expect(mentionsAll('间隔为六十秒', [['60', '六十']])).toBe(true)
    expect(mentionsAll('间隔为一分钟', [['60', '六十']])).toBe(false)
    expect(mentionsAll('用 B u n 跑', [['bun']])).toBe(true)
    expect(mentionsAll('随便', [])).toBe(true)
  })
})

describe('verdicts and scores', () => {
  test('an accepted gold citation with the mention is a hit', () => {
    const outcome = judge(answered([gold.id]))
    expect(outcome.verdict).toBe('accepted')
    expect(outcome.acceptedKeys).toEqual(['gold'])
    expect(scoreRound(outcome, labels)).toEqual({
      hit: true,
      hitWithoutMention: true,
      misattributed: false,
      citations: 1,
      fabricated: 0,
      outOfBounds: 0,
      acceptedCitations: 1,
    })
  })

  test('without the mention it is a hit only on the lenient reading', () => {
    const score = scoreRound(judge(answered([gold.id], '见条目')), labels)
    expect([score.hit, score.hitWithoutMention]).toEqual([false, true])
  })

  test('an accepted citation outside S(q) is a misattribution', () => {
    const score = scoreRound(judge(answered([other.id])), labels)
    expect([score.hit, score.misattributed]).toEqual([false, true])
    const acceptable = scoreRound(judge(answered([other.id])), {
      ...labels,
      acceptable: ['other'],
    })
    expect(acceptable.misattributed).toBe(false)
  })

  test('a rejected answer is not shown, so nothing in it is misattributed', () => {
    const outcome = judge(
      answered([other.id, 'qm-mem-deadbeef00000000', '$$$']),
    )
    expect(outcome.verdict).toBe('rejected')
    expect(outcome.rejection).toContain('did not verify')
    expect(outcome.acceptedKeys).toEqual([])
    expect(outcome.checks.map(c => [c.status, c.key])).toEqual([
      ['ok', 'other'],
      ['unknown', null],
      ['malformed', null],
    ])
    expect(scoreRound(outcome, labels)).toEqual({
      hit: false,
      hitWithoutMention: false,
      misattributed: false,
      citations: 3,
      fabricated: 2,
      outOfBounds: 0,
      acceptedCitations: 0,
    })
  })

  test('no tool call, and arguments that do not parse', () => {
    const noTool = judge({ ...answered([]), toolCalls: [], text: '没有记录' })
    expect(noTool.verdict).toBe('no-tool')
    expect(noTool.answer).toBe('没有记录')
    const bad = judge(answered('not a list'))
    expect(bad.verdict).toBe('bad-arguments')
    expect(scoreRound(bad, labels).citations).toBe(0)
  })

  test('an unreadable entry voids the round (D-2)', () => {
    writeFileSync(
      join(box.root, 'project', PROJECT_KEY, `${gold.id}.md`),
      'damaged outside the contract',
    )
    expect(() => judge(answered([gold.id]))).toThrow(InvalidRound)
  })
})
