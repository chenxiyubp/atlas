// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 Q-1: the chat lane's `reasoning_effort` gate is `modelSupportsEffort()`.
 *
 * `getModelCompatCapabilities().chatEffortHonorsOverride` is what a node
 * reports to the console (design §2.4). This file pins the claim to the
 * behaviour behind it, so the flag cannot stay `true` after the gate stops
 * honouring overrides.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { modelSupportsEffort } from 'src/utils/model/effort.js'
import { getModelCompatCapabilities } from '../capabilities.js'
import {
  chatLaneSendsReasoningEffort,
  resolveChatReasoningEffort,
} from '../chatEffort.js'

const settingsMock = setupSettingsMock()

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'OPENCODE_MODEL',
  'OPENCODE_API_KEY',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function resetEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
}

beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => ({}) })
  resetEnv()
})
afterEach(resetEnv)
afterAll(() => {
  settingsMock.reset()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const UNKNOWN = 'vendor-model-x'
const GATEWAY = 'https://gateway.example/v1'

describe('Q-1 · chat gate = modelSupportsEffort', () => {
  // Table-driven: (case, env, model) → (modelSupportsEffort, chat sends?).
  // The two columns must agree on every row except DeepSeek, whose ladder
  // lives in requestBody.ts.
  const rows: {
    name: string
    model: string
    baseURL?: string
    env?: Record<string, string>
    supports: boolean
    sends: boolean
  }[] = [
    {
      name: 'unknown third-party model, no override',
      model: UNKNOWN,
      supports: false,
      sends: false,
    },
    {
      name: 'unknown model + CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1',
      model: UNKNOWN,
      env: { CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1' },
      supports: true,
      sends: true,
    },
    {
      name: 'unknown model + tier capability list naming effort',
      model: UNKNOWN,
      env: {
        OPENAI_DEFAULT_OPUS_MODEL: UNKNOWN,
        OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: 'effort',
      },
      supports: true,
      sends: true,
    },
    {
      name: 'Codex reasoning model, no override (unchanged)',
      model: 'gpt-5.4',
      supports: true,
      sends: true,
    },
    {
      name: 'Codex reasoning model + capability list without effort',
      model: 'gpt-5.4',
      env: {
        OPENAI_DEFAULT_OPUS_MODEL: 'gpt-5.4',
        OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: 'thinking',
      },
      supports: false,
      sends: false,
    },
    {
      name: 'DeepSeek keeps its own ladder (requestBody.ts)',
      model: 'deepseek-v4-pro',
      baseURL: 'https://api.deepseek.com',
      env: { CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE: '0' },
      supports: true,
      sends: false,
    },
  ]

  for (const row of rows) {
    test(row.name, () => {
      for (const [key, value] of Object.entries(row.env ?? {})) {
        process.env[key] = value
      }
      const baseURL = row.baseURL ?? GATEWAY
      process.env.OPENAI_BASE_URL = baseURL
      expect(modelSupportsEffort(row.model)).toBe(row.supports)
      expect(chatLaneSendsReasoningEffort(row.model, baseURL)).toBe(row.sends)
      const value = resolveChatReasoningEffort(row.model, 'max', baseURL)
      if (row.sends) {
        // Chat Completions has no rung above high.
        expect(value).toBe('high')
      } else {
        expect(value).toBeUndefined()
      }
    })
  }

  test('CLAUDE_CODE_EFFORT_LEVEL=auto still omits the key on a supported model', () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(resolveChatReasoningEffort(UNKNOWN, 'high', GATEWAY)).toBeUndefined()
  })
})

describe('Q-1 · node capability report', () => {
  test('chatEffortHonorsOverride is true and backed by the gate', () => {
    expect(getModelCompatCapabilities()).toEqual({
      chatEffortHonorsOverride: true,
    })
    // The behaviour the flag promises: an override alone turns the key on.
    expect(resolveChatReasoningEffort(UNKNOWN, 'low', GATEWAY)).toBeUndefined()
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    expect(resolveChatReasoningEffort(UNKNOWN, 'low', GATEWAY)).toBe('low')
  })
})
