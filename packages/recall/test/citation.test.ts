// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatCitation } from '@qianmo/memory'
import {
  handleMemoryAnswer,
  injectedIds,
  MEMORY_ANSWER_TOOL_NAME,
  normaliseCitationId,
  recall,
  RecallToolError,
  renderCitedAnswer,
  verifyCitations,
  type RecallResult,
} from '../src/index.js'
import { createSandbox, DAY_MS, PROJECT_KEY, type Sandbox } from './helpers.js'

let box: Sandbox

beforeEach(() => {
  box = createSandbox()
})

afterEach(() => {
  box.dispose()
})

function recallNow(budget?: { maxEntries: number }): RecallResult {
  return recall(box.store, {
    asOf: box.clock.now(),
    scope: { projectKey: PROJECT_KEY },
    ...(budget === undefined ? {} : { budget }),
  })
}

describe('verifyCitations', () => {
  test('an injected live entry verifies', () => {
    const entry = box.write({ title: '统一用 Bun' })
    const result = recallNow()

    const report = verifyCitations(box.store, [entry.id], injectedIds(result))
    expect(report.verdict).toBe('accepted')
    expect(report.grounded).toBe(true)
    expect(report.accepted.map(e => e.id)).toEqual([entry.id])
  })

  test('a fabricated id resolves to nothing and is rejected', () => {
    box.write({ title: '统一用 Bun' })
    const result = recallNow()

    const report = verifyCitations(
      box.store,
      ['qm-mem-deadbeef00000000'],
      injectedIds(result),
    )
    expect(report.verdict).toBe('rejected')
    expect(report.grounded).toBe(false)
    expect(report.checks[0]?.status).toBe('unknown')
    expect(report.accepted).toEqual([])
  })

  test('a string that is not even an id is rejected as malformed', () => {
    const result = recallNow()
    const report = verifyCitations(box.store, ['$$$'], injectedIds(result))
    expect(report.checks[0]?.status).toBe('malformed')
    expect(report.verdict).toBe('rejected')
  })

  test('a revoked entry may not be cited', () => {
    const entry = box.write({ title: '旧决策' })
    const result = recallNow()
    box.store.revoke(entry.id, { reason: '已推翻', by: 'tester' })

    const report = verifyCitations(box.store, [entry.id], injectedIds(result))
    expect(report.checks[0]?.status).toBe('retired')
    expect(report.verdict).toBe('rejected')
  })

  test('a real entry that was never shown is not a grounded citation', () => {
    // The older entry is the one that falls outside a one-entry budget:
    // with no question to rank on, order is newest first.
    const unseen = box.write({ title: '第一条' })
    box.clock.advance(DAY_MS)
    box.write({ title: '第二条' })

    const result = recallNow({ maxEntries: 1 })
    expect(injectedIds(result).has(unseen.id)).toBe(false)

    const report = verifyCitations(box.store, [unseen.id], injectedIds(result))
    expect(report.checks[0]?.status).toBe('not-injected')
    expect(report.checks[0]?.entry?.id).toBe(unseen.id)
    expect(report.verdict).toBe('rejected')
  })

  test('a damaged genuine entry is reported as unreadable, never as fabricated', () => {
    const entry = box.write({ title: '会被损坏的一条' })
    const result = recallNow()
    writeFileSync(
      join(box.root, 'project', PROJECT_KEY, `${entry.id}.md`),
      'truncated by something outside the contract',
    )

    const report = verifyCitations(box.store, [entry.id], injectedIds(result))
    // The distinction this test exists for: calling this one "fabricated"
    // would report a true memory as a hallucination.
    expect(report.checks[0]?.status).toBe('unreadable')
    expect(report.checks[0]?.status).not.toBe('unknown')
    expect(report.checks[0]?.detail).toBeString()
    expect(report.verdict).toBe('rejected')
  })

  test('repeating an id is one claim, not two', () => {
    const entry = box.write({ title: '一条' })
    const result = recallNow()
    const report = verifyCitations(
      box.store,
      [entry.id, entry.id],
      injectedIds(result),
    )
    expect(report.checks.length).toBe(1)
    expect(report.accepted.length).toBe(1)
  })

  test('citing nothing is acceptable — it is how "not recorded" is said', () => {
    const report = verifyCitations(box.store, [], new Set())
    expect(report.verdict).toBe('accepted')
    expect(report.grounded).toBe(false)
  })
})

describe('normaliseCitationId', () => {
  test('accepts the whole rendered citation, not just the bare id', () => {
    const entry = box.write({ title: '一条' })
    expect(normaliseCitationId(formatCitation(entry))).toBe(entry.id)
  })

  test('tolerates surrounding whitespace and trailing prose', () => {
    expect(normaliseCitationId('  qm-mem-0001 (written 2026-08-12)  ')).toBe(
      'qm-mem-0001',
    )
  })
})

describe('handleMemoryAnswer', () => {
  test('accepts a cited answer and appends the store’s own citation', () => {
    const entry = box.write({ title: '统一用 Bun 作为运行时' })
    const result = recallNow()

    const answered = handleMemoryAnswer(box.store, result, {
      answer: '本项目统一用 Bun。',
      citations: [entry.id],
    })

    expect(answered.ok).toBe(true)
    expect(answered.rejection).toBeNull()
    // AC-4 asks for the source id and the write time, and both come off disk.
    expect(answered.answer).toContain(entry.id)
    expect(answered.answer).toContain(entry.createdAt)
  })

  test('refuses an answer built on a fabricated id, and says why', () => {
    box.write({ title: '统一用 Bun' })
    const result = recallNow()

    const answered = handleMemoryAnswer(box.store, result, {
      answer: '我们决定改用 pnpm。',
      citations: ['qm-mem-0000000000000042'],
    })

    expect(answered.ok).toBe(false)
    expect(answered.report.accepted).toEqual([])
    expect(answered.rejection).toContain('qm-mem-0000000000000042')
    expect(answered.rejection).toContain('no memory entry has this id')
    // The rejected text is handed back unadorned — no citation block is
    // rendered for an answer that has no verified source.
    expect(answered.answer).not.toContain('来源')
  })

  test('an uncited answer passes by default and fails when grounding is required', () => {
    box.write({ title: '统一用 Bun' })
    const result = recallNow()
    const input = { answer: '记忆里没有这条决策。', citations: [] }

    expect(handleMemoryAnswer(box.store, result, input).ok).toBe(true)
    const strict = handleMemoryAnswer(box.store, result, input, {
      requireCitation: true,
    })
    expect(strict.ok).toBe(false)
    expect(strict.rejection).toContain('cites no memory entry')
  })

  test('a malformed tool call is a contract error, not a citation verdict', () => {
    const result = recallNow()
    expect(() =>
      handleMemoryAnswer(box.store, result, { answer: 'x' }),
    ).toThrow(RecallToolError)
    expect(() =>
      handleMemoryAnswer(box.store, result, { answer: 'x' }),
    ).toThrow(MEMORY_ANSWER_TOOL_NAME)
  })
})

describe('renderCitedAnswer', () => {
  test('leaves an uncited answer alone', () => {
    const report = verifyCitations(box.store, [], new Set())
    expect(renderCitedAnswer('  没有记录。  ', report)).toBe('没有记录。')
  })
})
