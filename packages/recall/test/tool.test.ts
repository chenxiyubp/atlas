// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  buildRecallSystemPrompt,
  citationInstructions,
  INJECTION_BUDGET,
  MEMORY_ANSWER_TOOL,
  MEMORY_ANSWER_TOOL_NAME,
  parseMemoryAnswerArgs,
  RecallToolError,
} from '../src/index.js'

describe('the memory answer tool', () => {
  test('declares both fields as required', () => {
    expect(MEMORY_ANSWER_TOOL.name).toBe(MEMORY_ANSWER_TOOL_NAME)
    expect(MEMORY_ANSWER_TOOL.inputSchema.type).toBe('object')
    expect([...MEMORY_ANSWER_TOOL.inputSchema.required].sort()).toEqual([
      'answer',
      'citations',
    ])
  })

  test('is plain data: no vendor, no SDK, no native citation feature', () => {
    // D-6: the citation mechanism may not be one vendor's. If a provider name
    // or a native citation block ever appears in this definition, AC-4 has
    // been re-coupled to a single line and AC-5 is back in conflict with it.
    const text = JSON.stringify(MEMORY_ANSWER_TOOL).toLowerCase()
    for (const banned of [
      'anthropic',
      'openai',
      'deepseek',
      'qwen',
      'search_result',
      'citations_enabled',
    ]) {
      expect(text).not.toContain(banned)
    }
  })
})

describe('parseMemoryAnswerArgs', () => {
  test('accepts the declared shape', () => {
    expect(
      parseMemoryAnswerArgs({ answer: 'a', citations: ['qm-mem-0001'] }),
    ).toEqual({ answer: 'a', citations: ['qm-mem-0001'] })
  })

  test('a missing citations list is a violation, not an empty list', () => {
    expect(() => parseMemoryAnswerArgs({ answer: 'a' })).toThrow(
      RecallToolError,
    )
  })

  test('rejects non-string citations and non-object arguments', () => {
    expect(() =>
      parseMemoryAnswerArgs({ answer: 'a', citations: [1] }),
    ).toThrow(RecallToolError)
    expect(() => parseMemoryAnswerArgs('answer')).toThrow(RecallToolError)
    expect(() => parseMemoryAnswerArgs(null)).toThrow(RecallToolError)
  })
})

describe('prompt assembly', () => {
  test('the instructions name the tool and forbid inventing ids', () => {
    const text = citationInstructions()
    expect(text).toContain(MEMORY_ANSWER_TOOL_NAME)
    expect(text).toContain('Never invent')
    expect(text).toContain('empty `citations` list')
  })

  test('the system prompt is rules first, then memory', () => {
    const sections = buildRecallSystemPrompt({
      asOf: '2026-08-12T09:00:00.000Z',
      mode: 'full',
      entries: [],
      omittedCount: 0,
      degraded: false,
    })
    expect(sections.length).toBe(2)
    expect(sections[0]).toContain(MEMORY_ANSWER_TOOL_NAME)
    expect(sections[1]).toContain('<qianmo-memory')
    expect(sections[1]).toContain('(no live memory entries in scope)')
  })
})

describe('the injection budget', () => {
  test('is the small-scale line D-6 drew', () => {
    expect(INJECTION_BUDGET.maxEntries).toBe(50)
    expect(INJECTION_BUDGET.maxChars).toBe(20_000)
  })
})
