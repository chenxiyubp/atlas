// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #12 (part a): which chat requests leave `temperature` out.
 * Kimi rules follow hermes `agent/auxiliary_client.py:604-616` and
 * `plugins/model-providers/kimi-coding/__init__.py:119-136` at `f9b29c49b6`;
 * the o-series / GPT-5+ rule is the design's (§5.6 row 12). None was checked
 * against a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import { buildOpenAIRequestBody } from 'src/services/api/openai/requestBody.js'
import { isKimiModel, omitsSamplingTemperature } from '../samplingParams.js'

describe('omitsSamplingTemperature (table)', () => {
  const rows: [string, string | undefined, boolean][] = [
    ['o1', 'https://gateway.example/v1', true],
    ['o3-mini', 'https://api.openai.com/v1', true],
    ['openai/o4-mini', 'https://openrouter.ai/api/v1', true],
    ['gpt-5', 'https://gateway.example/v1', true],
    ['gpt-5.4', 'https://gateway.example/v1', true],
    ['gpt-5-mini', undefined, true],
    ['gpt-6-luna', 'https://api.openai.com/v1', true],
    ['kimi-k3', 'https://gateway.example/v1', true],
    ['moonshotai/kimi-k2.5', 'https://openrouter.ai/api/v1', true],
    ['moonshot-v1-8k', 'https://api.moonshot.cn/v1', true],
    ['anything', 'https://api.kimi.com/v1', true],
    ['gpt-4o', 'https://api.openai.com/v1', false],
    ['gpt-4.1-mini', 'https://gateway.example/v1', false],
    ['glm-5.2', 'https://open.bigmodel.cn/api/paas/v4', false],
    ['qwen3-coder', 'http://localhost:8000/v1', false],
    ['kimiko-7b', 'http://localhost:8000/v1', false],
    ['anything', 'https://api.moonshot.cn.attacker.test/v1', false],
  ]
  for (const [model, baseURL, expected] of rows) {
    test(`${model} @ ${baseURL ?? '(unset)'} → ${expected ? 'omit' : 'send'}`, () => {
      expect(omitsSamplingTemperature(model, baseURL)).toBe(expected)
    })
  }

  test('isKimiModel follows hermes (bare id, kimi or kimi-*)', () => {
    expect(isKimiModel('kimi')).toBe(true)
    expect(isKimiModel('Kimi-K3')).toBe(true)
    expect(isKimiModel('kimiko')).toBe(false)
  })
})

describe('buildOpenAIRequestBody', () => {
  const base = {
    messages: [],
    tools: [],
    toolChoice: undefined,
    enableThinking: false,
    maxTokens: 4096,
    temperatureOverride: 0,
  }
  test('a side query to o3 carries no temperature', () => {
    const body = buildOpenAIRequestBody({
      ...base,
      model: 'o3',
      baseURL: 'https://api.openai.com/v1',
    })
    expect('temperature' in body).toBe(false)
  })
  test('a side query to glm keeps temperature 0', () => {
    const body = buildOpenAIRequestBody({
      ...base,
      model: 'glm-5.2',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    })
    expect(body.temperature).toBe(0)
  })
})
