// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #3: which chat requests carry an output cap. Expectations follow
 * hermes `agent/transports/chat_completions.py:733-763`, its provider profiles
 * and `agent/model_metadata.py:686-737` at `f9b29c49b6` (see the module
 * header); none is a measurement against a real endpoint.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { getModelMaxOutputTokens } from 'src/utils/session/context.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  GENERIC_OUTPUT_TOKENS_FALLBACK,
  hostDefaultMaxTokens,
  isNamedHostWithoutDefault,
  resolveOpenAIRequestMaxTokens,
} from '../outputTokenDefault.js'

const settingsMock = setupSettingsMock()
const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_MAX_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'USER_TYPE',
]
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => ({}) })
})
afterAll(() => settingsMock.reset())

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function freshEnv(extra: Record<string, string> = {}): void {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  Object.assign(process.env, extra)
}

afterEach(restoreEnv)

/** What index.ts passes: getModelMaxOutputTokens(model).upperLimit. */
function resolve(
  model: string,
  baseURL: string | undefined,
  wireProtocol: 'chat' | 'responses' = 'chat',
  override?: number,
): number | undefined {
  return resolveOpenAIRequestMaxTokens(
    getModelMaxOutputTokens(model).upperLimit,
    override,
    { wireProtocol, model, baseURL },
  )
}

describe('sentinel: the generic fallback this module compares against', () => {
  test('an unknown id still gets exactly context.ts:37-38', () => {
    freshEnv()
    expect(getModelMaxOutputTokens('qianmo-p185-sentinel-unknown')).toEqual({
      ...GENERIC_OUTPUT_TOKENS_FALLBACK,
    })
  })
})

describe('resolveOpenAIRequestMaxTokens — chat lane (table)', () => {
  const OMIT = undefined
  const rows: [string, string | undefined, number | undefined, string][] = [
    // [model, baseURL, expected, why]
    // Step 5: unknown model on a named provider host → no cap.
    [
      'glm-5.2',
      'https://open.bigmodel.cn/api/paas/v4',
      OMIT,
      'zai, no default',
    ],
    ['glm-5.2', 'https://api.z.ai/api/paas/v4', OMIT, 'zai, no default'],
    ['o3', 'https://api.openai.com/v1', OMIT, 'openai, no default'],
    ['gpt-4.1', undefined, OMIT, 'unset base URL = api.openai.com'],
    [
      'deepseek-v4-pro',
      'https://api.deepseek.com',
      OMIT,
      'deepseek, no default',
    ],
    ['meta-llama/llama-4', 'https://openrouter.ai/api/v1', OMIT, 'openrouter'],
    [
      'qwen-plus',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      OMIT,
      'alibaba',
    ],
    [
      'mimo-v2.6-pro',
      'https://token-plan-cn.xiaomimimo.com/v1',
      OMIT,
      'xiaomi subdomain',
    ],
    ['grok-4.6', 'https://api.x.ai/v1', OMIT, 'xai'],
    // Step 2: host defaults from hermes profiles.
    ['kimi-k3', 'https://api.moonshot.cn/v1', 32_000, 'kimi-coding-cn profile'],
    ['kimi-k3', 'https://api.moonshot.ai/v1', 32_000, 'kimi-coding profile'],
    [
      'nemotron-x',
      'https://integrate.api.nvidia.com/v1',
      16_384,
      'nvidia profile',
    ],
    ['muse-spark', 'https://api.meta.ai/v1', 16_384, 'meta-ai profile'],
    [
      'qwen3-coder-plus',
      'https://portal.qwen.ai/v1',
      65_536,
      'qwen-oauth profile',
    ],
    // Step 3: known to Qianmo's own table → as before.
    ['gpt-5.6', 'https://api.openai.com/v1', 128_000, 'context.ts GPT-5.6 row'],
    // Step 4: Claude / MiniMax / Qwen3 names → as before, even on step-5 hosts.
    [
      'anthropic/claude-opus-5',
      'https://openrouter.ai/api/v1',
      64_000,
      'claude name',
    ],
    [
      'minimax/minimax-m3',
      'https://openrouter.ai/api/v1',
      64_000,
      'minimax name',
    ],
    [
      'qwen3-coder',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      64_000,
      'qwen3 name',
    ],
    // Step 6: any other host → as before (hermes `custom` profile sends too).
    [
      'qwen2.5-coder:32b',
      'http://localhost:11434/v1',
      64_000,
      'Ollama (num_predict=128 otherwise)',
    ],
    ['llama-3.3-70b', 'http://192.168.5.20:8000/v1', 64_000, 'LAN vLLM'],
    [
      'vendor-model-x',
      'https://gateway.example/v1',
      64_000,
      'unrecognised gateway',
    ],
    [
      'ep-20261003-abcde',
      'https://ark.cn-beijing.volces.com/api/v3',
      64_000,
      '方舟: 4k default when omitted (vendors-research)',
    ],
    // Spoof is not the named host.
    [
      'glm-5.2',
      'https://open.bigmodel.cn.attacker.test/v1',
      64_000,
      'suffix spoof',
    ],
  ]
  for (const [model, baseURL, expected, why] of rows) {
    test(`${model} @ ${baseURL ?? '(unset)'} → ${expected ?? 'none'} (${why})`, () => {
      freshEnv()
      expect(resolve(model, baseURL)).toBe(expected)
    })
  }
})

describe('explicit values always win', () => {
  test('options.maxOutputTokensOverride', () => {
    freshEnv()
    expect(
      resolve('glm-5.2', 'https://open.bigmodel.cn/api/paas/v4', 'chat', 4096),
    ).toBe(4096)
  })
  test('OPENAI_MAX_TOKENS (where the catalog maxOutputTokens compiles)', () => {
    freshEnv({ OPENAI_MAX_TOKENS: '8192' })
    expect(resolve('glm-5.2', 'https://open.bigmodel.cn/api/paas/v4')).toBe(
      8192,
    )
    expect(resolve('kimi-k3', 'https://api.moonshot.cn/v1')).toBe(8192)
  })
  test('CLAUDE_CODE_MAX_OUTPUT_TOKENS', () => {
    freshEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '12000' })
    expect(resolve('o3', 'https://api.openai.com/v1')).toBe(12000)
  })
  test('an unparsable value is not explicit (same parsing as resolveOpenAIMaxTokens)', () => {
    freshEnv({ OPENAI_MAX_TOKENS: 'lots' })
    expect(resolve('glm-5.2', 'https://open.bigmodel.cn/api/paas/v4')).toBe(
      undefined,
    )
  })
})

describe('the Responses lane is untouched', () => {
  test.each([
    ['glm-5.2', 'https://open.bigmodel.cn/api/paas/v4'],
    ['gpt-6-luna', 'https://api.openai.com/v1'],
    ['gpt-6-luna', undefined],
  ])('%s @ %s', (model, baseURL) => {
    freshEnv()
    expect(resolve(model, baseURL, 'responses')).toBe(
      getModelMaxOutputTokens(model).upperLimit,
    )
  })
})

describe('host tables', () => {
  test('default lookup and named-host lookup use exact or dot-suffix hosts', () => {
    expect(hostDefaultMaxTokens('https://api.moonshot.cn/v1')).toBe(32_000)
    expect(hostDefaultMaxTokens('https://evil-api.moonshot.cn.test/v1')).toBe(
      undefined,
    )
    expect(isNamedHostWithoutDefault('https://us.api.openai.com/v1')).toBe(true)
    expect(
      isNamedHostWithoutDefault('https://proxy.test/api.openai.com/v1'),
    ).toBe(false)
    expect(isNamedHostWithoutDefault(undefined)).toBe(true)
  })
})
