// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  listedPresets,
  modelRetirementStatus,
  PRESET_GROUPS,
  PRESETS,
  type Preset,
  parseWireProfile,
  presetById,
  RETIREMENTS,
  resolveBaseUrl,
} from '../src/index.js'
import { CANARY_KEY, V1_CAPABILITIES } from './fixtures.js'

const CATALOG_DAY = new Date('2026-10-03T00:00:00Z')

/** §4.2, §4.3, §4.4 — the catalog is exactly these, no more, no fewer. */
const DESIGN_IDS = [
  // §4.2
  'deepseek',
  'kimi',
  'zhipu',
  'qwen',
  'minimax',
  'ark',
  'siliconflow',
  'qianfan',
  'tokenhub',
  'stepfun',
  'mimo',
  'openai',
  'anthropic',
  'xai',
  'gemini',
  'mistral',
  'openrouter',
  'azure',
  // §4.3
  'zhipu-coding',
  'qwen-coding',
  'qwen-token',
  'kimi-code',
  'minimax-plan',
  'ark-coding',
  'qianfan-token',
  'tencent-plan',
  'stepfun-plan',
  'mimo-token',
  // §4.4
  'ollama',
  'vllm',
  'lmstudio',
  'custom-anthropic',
  'custom-openai',
]

/** Placeholder values for presets whose URL or models the user supplies. */
function fillIns(preset: Preset): {
  baseUrl: string
  templateValues: Record<string, string>
  models: unknown[]
} {
  const templateValues = Object.fromEntries(
    preset.templateVars.map(variable => [variable.name, 'example-1']),
  )
  const baseUrl =
    preset.baseUrl === '' ? 'https://gateway.example.test' : preset.baseUrl
  const models =
    preset.models.length > 0
      ? [...preset.models]
      : [
          {
            id: 'user-model',
            role: 'main',
            tiers: ['opus', 'sonnet', 'haiku', 'fable'],
            capabilities: { mode: 'family' },
            effort: { send: 'auto' },
          },
        ]
  return { baseUrl, templateValues, models }
}

describe('catalog structure (§4)', () => {
  test('the preset ids are exactly the design tables', () => {
    expect([...PRESETS.map(entry => entry.id)].sort()).toEqual(
      [...DESIGN_IDS].sort(),
    )
  })

  test('every preset carries an official https URL and a verification date', () => {
    for (const entry of PRESETS) {
      expect(entry.source.url.startsWith('https://')).toBe(true)
      expect(() => new URL(entry.source.url)).not.toThrow()
      expect(entry.source.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(entry.source.verifiedAt))).toBe(false)
    }
  })

  test('nothing is evaluated before a real-key smoke test (§8.4)', () => {
    for (const entry of PRESETS) expect(entry.evaluated).toBe(false)
  })

  test('display order: group order, then id order inside each group', () => {
    const groupRank = (entry: Preset) => PRESET_GROUPS.indexOf(entry.group)
    for (let i = 1; i < PRESETS.length; i += 1) {
      const previous = PRESETS[i - 1] as Preset
      const current = PRESETS[i] as Preset
      const byGroup = groupRank(previous) - groupRank(current)
      expect(byGroup).toBeLessThanOrEqual(0)
      if (byGroup === 0) expect(previous.id < current.id).toBe(true)
    }
  })

  test('plan presets carry the terms notice; nothing else does', () => {
    for (const entry of PRESETS) {
      if (entry.plan === 'plan') {
        expect(entry.terms?.restricted).toBe(true)
        expect(entry.terms?.url.startsWith('https://')).toBe(true)
      } else {
        expect(entry.terms).toBeNull()
      }
    }
  })

  test('a site list, when present, starts with the default base URL', () => {
    for (const entry of PRESETS) {
      if (entry.sites.length === 0) continue
      expect(entry.sites[0]?.baseUrl).toBe(entry.baseUrl)
    }
  })

  test('every listed preset with models parses as a delivered profile on a v1 node', () => {
    for (const entry of PRESETS) {
      const { baseUrl, templateValues, models } = fillIns(entry)
      const parsed = parseWireProfile(
        {
          id: entry.id,
          revision: 1,
          lane: entry.lane,
          baseUrl,
          ...(entry.templateVars.length > 0 ? { templateValues } : {}),
          auth: {
            scheme: entry.authScheme,
            keys: [{ id: 'k1', value: entry.placeholderKey ?? CANARY_KEY }],
          },
          models,
          compat: entry.compat,
        },
        { capabilities: V1_CAPABILITIES, now: CATALOG_DAY },
      )
      if (!parsed.ok)
        throw new Error(`${entry.id}: ${JSON.stringify(parsed.error)}`)
      expect(parsed.ok).toBe(true)
    }
  })

  test('no preset model is retired or inside the 14-day window on the catalog date', () => {
    for (const entry of PRESETS) {
      for (const model of entry.models) {
        expect(modelRetirementStatus(model.id, CATALOG_DAY)).toBe('active')
      }
    }
  })

  test('MiMo presets use the v2.6 ids; the retired ids appear only in the retirement table', () => {
    const retired = new Set(RETIREMENTS.map(entry => entry.modelId))
    expect(retired).toEqual(
      new Set(['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash']),
    )
    const mimoIds = ['mimo', 'mimo-token'].flatMap(
      id => presetById(id)?.models.map(model => model.id) ?? [],
    )
    expect(mimoIds.every(id => id.startsWith('mimo-v2.6-'))).toBe(true)
    for (const entry of PRESETS) {
      for (const model of entry.models)
        expect(retired.has(model.id)).toBe(false)
    }
  })

  test('local presets resolve on the node: plain http to localhost only', () => {
    for (const entry of PRESETS.filter(preset => preset.group === 'local')) {
      const url = new URL(entry.baseUrl)
      expect(url.protocol).toBe('http:')
      expect(url.hostname).toBe('localhost')
      expect(entry.placeholderKey).toBeDefined()
    }
  })

  test('remote presets are https after template resolution', () => {
    for (const entry of PRESETS) {
      if (entry.group === 'local' || entry.baseUrl === '') continue
      const values = Object.fromEntries(
        entry.templateVars.map(variable => [variable.name, 'x1']),
      )
      const resolved = resolveBaseUrl(entry.baseUrl, values)
      expect(resolved.ok).toBe(true)
      if (resolved.ok) expect(resolved.url.startsWith('https://')).toBe(true)
    }
  })
})

describe('what the research could not confirm stays marked (§11 item 7)', () => {
  test('Azure: auth style unverified, kept out of the preset grid', () => {
    const azure = presetById('azure')
    expect(azure?.listed).toBe(false)
    expect(azure?.unverified.join(' ')).toContain('鉴权')
    expect(listedPresets().some(entry => entry.id === 'azure')).toBe(false)
  })

  test('MiMo Token Plan: the Anthropic path is flagged unverified', () => {
    expect(presetById('mimo-token')?.unverified.join(' ')).toContain(
      '路径未核实',
    )
  })

  test('Ark and Qianfan plan keys: no invented prefix', () => {
    for (const id of ['ark-coding', 'qianfan-token']) {
      const entry = presetById(id)
      expect(entry?.keyHint).toBeNull()
      expect(entry?.unverified.join(' ')).toContain('前缀未核实')
    }
  })
})

describe('§4.2 lane choices', () => {
  test('OpenAI and xAI on Responses, Gemini native, Mistral on chat, Anthropic official on x-api-key', () => {
    expect(presetById('openai')?.lane).toBe('openai-responses')
    expect(presetById('xai')?.lane).toBe('openai-responses')
    expect(presetById('gemini')?.lane).toBe('gemini')
    expect(presetById('mistral')?.lane).toBe('openai-chat')
    expect(presetById('anthropic')?.authScheme).toBe('x-api-key')
    for (const entry of PRESETS) {
      if (entry.lane === 'anthropic' && entry.id !== 'anthropic') {
        expect(entry.authScheme).toBe('bearer')
      }
    }
  })

  test('effort defaults follow the table: DeepSeek always/low,high,max/max; MiniMax, MiMo, xAI, Mistral never', () => {
    const deepseekMain = presetById('deepseek')?.models[0]
    expect(deepseekMain?.effort).toEqual({
      send: 'always',
      levels: ['low', 'high', 'max'],
      level: 'max',
    })
    for (const id of ['minimax', 'mimo', 'xai', 'mistral']) {
      for (const model of presetById(id)?.models ?? []) {
        expect(model.effort.send).toBe('never')
      }
    }
  })

  test('no wire model id carries the client-only [1m] marker', () => {
    for (const entry of PRESETS) {
      for (const model of entry.models) expect(model.id).not.toMatch(/\[1m\]/i)
    }
  })
})
