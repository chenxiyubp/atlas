// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #11: which name the chat request gives its output cap.
 * Expectations follow hermes `utils.py:871-903` and `run_agent.py:1617-1639`
 * at `f9b29c49b6`, narrowed where a base test pins the old name (see the
 * module header); none is a measurement against a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import { buildOpenAIRequestBody } from 'src/services/api/openai/requestBody.js'
import {
  isOSeriesReasoningModel,
  usesMaxCompletionTokens,
} from '../outputTokenParam.js'

const OFFICIAL = 'https://api.openai.com/v1'
const REGIONAL = 'https://eu.api.openai.com/v1'
const AZURE = 'https://myres.openai.azure.com/openai/v1'
const GATEWAY = 'https://gateway.example/v1'
const OPENROUTER = 'https://openrouter.ai/api/v1'

describe('usesMaxCompletionTokens (table)', () => {
  const rows: [string, string | undefined, boolean, string][] = [
    // [model, baseURL, expected, why]
    ['o1', GATEWAY, true, 'hermes utils.py:900: o1 on any host'],
    ['o1-preview', GATEWAY, true, 'o1 family'],
    ['o3-mini', GATEWAY, true, 'hermes utils.py:901'],
    ['o3-pro', OFFICIAL, true, 'o3 family, official'],
    ['o4-mini', 'http://localhost:4000/v1', true, 'hermes utils.py:902'],
    ['openai/o4-mini', OPENROUTER, true, 'vendor prefix stripped (:893-894)'],
    ['O3-MINI', GATEWAY, true, 'case-insensitive (:890)'],
    ['gpt-5.4', OFFICIAL, true, 'baseline: Codex lineage on official'],
    ['gpt-5.3-codex', REGIONAL, true, 'regional official host'],
    ['gpt-5.4', undefined, true, 'unset base URL = SDK default host'],
    ['gpt-6-luna', OFFICIAL, true, 'official host, GPT generation 6'],
    ['gpt-7', OFFICIAL, true, 'official host, later generation'],
    ['gpt-5.4', AZURE, true, 'Azure host (run_agent.py:1633)'],
    ['gpt-6-luna', AZURE, true, 'Azure host, generation 6'],
    // Narrowed: pinned by thinking.test.ts / queryModelOpenAI.runner.ts.
    ['gpt-4o', OFFICIAL, false, 'pinned: thinking.test.ts'],
    ['gpt-4.1-mini', OFFICIAL, false, 'same lineage as the pinned gpt-4o'],
    ['test-model', undefined, false, 'pinned: queryModelOpenAI.runner.ts'],
    ['gpt-4o', AZURE, false, 'same lineage on Azure'],
    ['gpt-5.4', GATEWAY, false, 'pinned: thinking.test.ts'],
    ['gpt-6-luna', GATEWAY, false, 'not in hermes name list (stops at gpt-5)'],
    // Not reasoning, not OpenAI.
    ['deepseek-chat', 'https://api.deepseek.com/v1', false, 'other vendor'],
    ['glm-5.2', 'https://open.bigmodel.cn/api/paas/v4', false, 'other vendor'],
    // Spoofed hosts are not official (openaiShared.ts strict match).
    ['gpt-5.4', 'https://api.openai.com.attacker.test/v1', false, 'spoof'],
    ['gpt-5.4', 'https://myres.openai.azure.com.evil.test/v1', false, 'spoof'],
    // Ids that merely start with the letters are not o-series.
    ['o1x-local', GATEWAY, false, 'stricter than hermes startswith'],
    ['o30-sim', GATEWAY, false, 'stricter than hermes startswith'],
  ]
  for (const [model, baseURL, expected, why] of rows) {
    test(`${model} @ ${baseURL ?? '(unset)'} → ${expected ? 'max_completion_tokens' : 'max_tokens'} (${why})`, () => {
      expect(usesMaxCompletionTokens(model, baseURL)).toBe(expected)
    })
  }
})

describe('isOSeriesReasoningModel', () => {
  test('exact and dash-continued ids only', () => {
    expect(isOSeriesReasoningModel('o3')).toBe(true)
    expect(isOSeriesReasoningModel('azure/o1-mini')).toBe(true)
    expect(isOSeriesReasoningModel('o2-mini')).toBe(false)
    expect(isOSeriesReasoningModel('gpt-4o')).toBe(false)
  })
})

describe('buildOpenAIRequestBody uses the rule', () => {
  const base = {
    messages: [],
    tools: [],
    toolChoice: undefined,
    enableThinking: false,
    maxTokens: 4096,
  }
  test('o3-mini behind a gateway: max_completion_tokens only', () => {
    const body = buildOpenAIRequestBody({
      ...base,
      model: 'o3-mini',
      baseURL: GATEWAY,
    })
    expect(body.max_completion_tokens).toBe(4096)
    expect('max_tokens' in body).toBe(false)
  })
  test('glm behind a gateway: max_tokens only', () => {
    const body = buildOpenAIRequestBody({
      ...base,
      model: 'glm-5.2',
      baseURL: GATEWAY,
    })
    expect(body.max_tokens).toBe(4096)
    expect('max_completion_tokens' in body).toBe(false)
  })
})
