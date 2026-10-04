// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #22: hosts that mandate a wire, consulted after an explicit
 * `OPENAI_WIRE_API`. Expectations follow hermes `hermes_cli/providers.py:614-657`
 * and `hermes_cli/models.py:4436-4479` at `f9b29c49b6`; none is a measurement
 * against a real endpoint.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { resolveOpenAIWireProtocol } from 'src/services/api/openai/wireProtocol.js'
import { hostMandatedLane } from '../wireHosts.js'

const ENV_KEYS = ['OPENAI_BASE_URL', 'OPENAI_WIRE_API', 'OPENAI_AUTH_MODE']
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('hostMandatedLane (table)', () => {
  const rows: [string | undefined, string | undefined, string | undefined][] = [
    // [baseURL, model, expected]
    ['https://api.openai.com/v1', 'gpt-4o', 'responses'],
    ['https://api.openai.com/v1', undefined, 'responses'],
    ['https://us.api.openai.com/v1', 'o3', 'responses'],
    ['https://eu.api.openai.com/v1/', 'gpt-4.1', 'responses'],
    ['https://api.meta.ai/v1', 'muse-spark', 'responses'],
    ['https://myres.openai.azure.com/openai/v1', 'o3-mini', 'responses'],
    ['https://myres.openai.azure.com/openai/v1', 'gpt-5.3-codex', 'responses'],
    ['https://myres.openai.azure.com/openai/v1', 'codex-mini', 'responses'],
    ['https://myres.openai.azure.com/openai/v1', 'gpt-4o', undefined],
    ['https://myres.openai.azure.com/openai/v1', undefined, undefined],
    ['https://api.anthropic.com/v1/', 'claude-sonnet-5', 'anthropic-messages'],
    [
      'https://dashscope.aliyuncs.com/apps/anthropic',
      'qwen3-max',
      'anthropic-messages',
    ],
    ['https://api.kimi.com/coding/v1', 'kimi-k3', 'anthropic-messages'],
    ['https://api.kimi.com/v1', 'kimi-k3', undefined],
    // Spoofs never match (hermes #32243): suffix of a foreign host, path segment.
    ['https://api.openai.com.attacker.test/v1', 'gpt-4o', undefined],
    ['https://proxy.test/api.openai.com/v1', 'gpt-4o', undefined],
    ['https://notapi.openai.com/v1', 'gpt-4o', undefined],
    // No mandate for an empty base URL (providers.py:633-634) or other hosts.
    [undefined, 'gpt-4o', undefined],
    ['', 'gpt-4o', undefined],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.2', undefined],
    ['http://localhost:11434/v1', 'qwen3', undefined],
  ]
  for (const [baseURL, model, expected] of rows) {
    test(`${baseURL ?? '(unset)'} · ${model ?? '(no model)'} → ${expected ?? 'none'}`, () => {
      expect(hostMandatedLane(baseURL, model)).toBe(
        expected as ReturnType<typeof hostMandatedLane>,
      )
    })
  }
})

describe('resolveOpenAIWireProtocol with the host table', () => {
  test('api.openai.com with no explicit lane goes to Responses', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    expect(resolveOpenAIWireProtocol('gpt-4o')).toBe('responses')
    expect(resolveOpenAIWireProtocol('o3')).toBe('responses')
    expect(resolveOpenAIWireProtocol()).toBe('responses')
  })

  test('explicit OPENAI_WIRE_API=chat still wins on api.openai.com', () => {
    process.env.OPENAI_WIRE_API = 'chat'
    delete process.env.OPENAI_AUTH_MODE
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    expect(resolveOpenAIWireProtocol('gpt-4o')).toBe('chat')
    expect(resolveOpenAIWireProtocol('o3')).toBe('chat')
  })

  test('an Anthropic shim on the OpenAI lane is reported, not acted on', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    process.env.OPENAI_BASE_URL = 'https://api.anthropic.com/v1/'
    expect(resolveOpenAIWireProtocol('claude-sonnet-5')).toBe('chat')
  })

  test('unset base URL keeps the pre-P18.5 resolution', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    delete process.env.OPENAI_BASE_URL
    expect(resolveOpenAIWireProtocol('gpt-4o')).toBe('chat')
    expect(resolveOpenAIWireProtocol('gpt-5.4')).toBe('responses')
  })

  test('other hosts keep the pre-P18.5 resolution', () => {
    delete process.env.OPENAI_WIRE_API
    delete process.env.OPENAI_AUTH_MODE
    process.env.OPENAI_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
    expect(resolveOpenAIWireProtocol('glm-5.2')).toBe('chat')
    expect(resolveOpenAIWireProtocol('gpt-5.4')).toBe('responses')
  })
})
