// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 Q-2: the capability-override ladder reads the FABLE tier, and the
 * Gemini / Grok lanes read their own prefix.
 *
 * Before this the tier lists in `modelSupportOverrides.ts` held only
 * OPUS / SONNET / HAIKU, and both non-OpenAI third-party lanes fell through
 * to the ANTHROPIC_ list — so `*_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES`
 * and every `GEMINI_` / `GROK_` capability key that `PROFILE_ENV_KEYS`
 * manages was written by `/provider` and read by nothing.
 *
 * The settings module is pinned to `{}` so the lane comes from the env vars
 * this file sets, not from whatever `modelType` the developer's own
 * settings.json happens to carry.
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
import { get3PModelCapabilityOverride } from 'src/utils/model/modelSupportOverrides.js'
import { modelSupportsEffort } from 'src/utils/model/effort.js'
import { getAPIProvider } from 'src/utils/model/providers.js'

const settingsMock = setupSettingsMock()

const MODEL = 'vendor-model-x'
const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'GEMINI_DEFAULT_OPUS_MODEL',
  'GEMINI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'GEMINI_DEFAULT_FABLE_MODEL',
  'GEMINI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'GROK_DEFAULT_HAIKU_MODEL',
  'GROK_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'GROK_DEFAULT_FABLE_MODEL',
  'GROK_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'OPENCODE_MODEL',
  'OPENCODE_API_KEY',
  'OPENCODE_AUTH_MODE',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => ({}) })
  clearEnv()
})

afterEach(clearEnv)

afterAll(() => {
  settingsMock.reset()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Q-2 · FABLE tier', () => {
  test('OpenAI lane: a FABLE-pinned model reads its own capability list', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_DEFAULT_FABLE_MODEL = MODEL
    process.env.OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES =
      'effort,xhigh_effort'
    expect(getAPIProvider()).toBe('openai')

    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBe(true)
    expect(get3PModelCapabilityOverride(MODEL, 'xhigh_effort')).toBe(true)
    // List present, item absent ⇒ false (the documented all-or-nothing read).
    expect(get3PModelCapabilityOverride(MODEL, 'max_effort')).toBe(false)
    // …and the display/wire gate follows it: an unknown third-party id is
    // `false` by default, the FABLE override turns it on.
    expect(modelSupportsEffort(MODEL)).toBe(true)
  })

  test('OpenAI lane: FABLE override can also switch effort off', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_DEFAULT_FABLE_MODEL = 'gpt-5.6-sol'
    process.env.OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
    // gpt-5.6-sol is a known reasoning model (true by family) — the explicit
    // list wins over the family default.
    expect(modelSupportsEffort('gpt-5.6-sol')).toBe(false)
  })

  test('Anthropic-compatible third-party endpoint: FABLE tier is read', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://third-party.example/anthropic'
    process.env.ANTHROPIC_MODEL = MODEL
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = MODEL
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES =
      'thinking'
    expect(get3PModelCapabilityOverride(MODEL, 'thinking')).toBe(true)
    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBe(false)
  })

  test('an unpinned model still answers undefined (no override)', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_DEFAULT_FABLE_MODEL = MODEL
    process.env.OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    expect(
      get3PModelCapabilityOverride('other-model', 'effort'),
    ).toBeUndefined()
  })
})

describe('Q-2 · Gemini / Grok lanes read their own prefix', () => {
  test('Gemini lane reads GEMINI_DEFAULT_<TIER>_MODEL_SUPPORTED_CAPABILITIES', () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.GEMINI_DEFAULT_OPUS_MODEL = MODEL
    process.env.GEMINI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
    expect(getAPIProvider()).toBe('gemini')
    expect(get3PModelCapabilityOverride(MODEL, 'thinking')).toBe(true)
    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBe(false)
  })

  test('Gemini lane reads its FABLE tier too', () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.GEMINI_DEFAULT_FABLE_MODEL = MODEL
    process.env.GEMINI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBe(true)
  })

  test('Gemini lane keeps the ANTHROPIC_ list as its fallback', () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBe(true)
  })

  test('own prefix wins over the ANTHROPIC_ fallback for the same model', () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.GEMINI_DEFAULT_OPUS_MODEL = MODEL
    process.env.GEMINI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBe(false)
  })

  test('Grok lane reads GROK_DEFAULT_<TIER>_MODEL_SUPPORTED_CAPABILITIES', () => {
    process.env.CLAUDE_CODE_USE_GROK = '1'
    process.env.GROK_DEFAULT_HAIKU_MODEL = MODEL
    process.env.GROK_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    expect(getAPIProvider()).toBe('grok')
    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBe(true)
    expect(modelSupportsEffort(MODEL)).toBe(true)
  })

  test('Grok lane FABLE tier can switch a family default off', () => {
    process.env.CLAUDE_CODE_USE_GROK = '1'
    process.env.GROK_DEFAULT_FABLE_MODEL = 'grok-3-mini'
    process.env.GROK_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
    // grok-3-mini is effort-capable by family; the explicit list wins.
    expect(modelSupportsEffort('grok-3-mini')).toBe(false)
  })

  test('OpenAI lane does not read the GEMINI_ prefix', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.GEMINI_DEFAULT_OPUS_MODEL = MODEL
    process.env.GEMINI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = 'effort'
    expect(get3PModelCapabilityOverride(MODEL, 'effort')).toBeUndefined()
  })
})
