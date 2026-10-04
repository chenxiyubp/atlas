// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The MiMo preset must not hand out retired model ids.
 *
 * The `/provider` wizard copies `defaultModel`, `tiers` and `models[].id`
 * verbatim into OPENAI_MODEL / OPENAI_DEFAULT_*_MODEL, so a retired id here is
 * a failed first request for every user who picks MiMo. Xiaomi retired
 * `mimo-v2-flash` on 2026-06-30 and retires `mimo-v2.5-pro` and `mimo-v2.5` at
 * 2026-10-21 10:00 Beijing time, with no system replacement
 * (https://mimo.mi.com/static/docs/updates/deprecate.md, fetched 2026-10-03).
 * The current models are `mimo-v2.6-pro` and `mimo-v2.6-flash`, both 1M
 * context (https://mimo.mi.com/static/docs/quick-start/summary/model.md).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  CHINA_LLM_PROVIDERS,
  findChinaProviderByBaseURL,
  getChinaProviderContextWindow,
  resolveChinaProviderBaseURL,
} from '../chinaLlmProviders.js'

const RETIRED_MIMO_IDS = ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash']

/**
 * Whether `text` names exactly `id`, not a longer id that starts with it.
 *
 * `mimo-v2.5` is a prefix of `mimo-v2.5-pro` and of the still-current
 * `mimo-v2.5-asr` / `mimo-v2.5-tts`, so a plain substring check cannot tell
 * the three retired ids apart: a leftover `mimo-v2.5-pro` would make the
 * `mimo-v2.5` check fail too, and a removed `mimo-v2.5` would go unproven while
 * `-pro` is still there. The id must therefore end at a character that cannot
 * continue it; a trailing `.` counts as an end unless an id character follows.
 * The dot inside the id is escaped, so `mimo-v2x5` is not a match either.
 */
function namesModelId(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
  ).test(text)
}

describe('namesModelId', () => {
  test('matches the exact id, including gateway spellings and sentence ends', () => {
    expect(namesModelId(`id: 'mimo-v2.5',`, 'mimo-v2.5')).toBe(true)
    expect(namesModelId(`id: 'mimo-v2.5-pro',`, 'mimo-v2.5-pro')).toBe(true)
    expect(namesModelId('xiaomi/mimo-v2-flash:free', 'mimo-v2-flash')).toBe(
      true,
    )
    expect(namesModelId('replaced mimo-v2.5.', 'mimo-v2.5')).toBe(true)
  })

  test('does not mistake a longer id for its prefix', () => {
    expect(namesModelId(`id: 'mimo-v2.5-pro',`, 'mimo-v2.5')).toBe(false)
    expect(namesModelId('mimo-v2.5-asr', 'mimo-v2.5')).toBe(false)
    expect(namesModelId('mimo-v2.5.1', 'mimo-v2.5')).toBe(false)
    expect(namesModelId('mimo-v2x5', 'mimo-v2.5')).toBe(false)
    expect(namesModelId('mimo-v2.6-flash', 'mimo-v2-flash')).toBe(false)
    expect(namesModelId('mimo-v2.6-pro', 'mimo-v2.5-pro')).toBe(false)
  })
})

describe('MiMo preset after the 2026-10-21 retirement', () => {
  test('chinaLlmProviders.ts no longer names any retired MiMo id', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'chinaLlmProviders.ts'),
      'utf8',
    )
    for (const id of RETIRED_MIMO_IDS) {
      expect({ id, named: namesModelId(source, id) }).toEqual({
        id,
        named: false,
      })
    }
  })

  test('default model is mimo-v2.6-pro and the haiku tier is mimo-v2.6-flash', () => {
    const mimo = CHINA_LLM_PROVIDERS.find(p => p.id === 'mimo')
    expect(mimo?.defaultModel).toBe('mimo-v2.6-pro')
    expect(mimo?.tiers).toEqual({
      haiku: 'mimo-v2.6-flash',
      sonnet: 'mimo-v2.6-pro',
      opus: 'mimo-v2.6-pro',
      fable: 'mimo-v2.6-pro',
    })
  })

  test('the model table offers exactly the current MiMo models', () => {
    const mimo = CHINA_LLM_PROVIDERS.find(p => p.id === 'mimo')
    expect(mimo?.models.map(model => model.id)).toEqual([
      'mimo-v2.6-pro',
      'mimo-v2.6-flash',
    ])
    for (const model of mimo?.models ?? []) {
      expect(RETIRED_MIMO_IDS).not.toContain(model.id)
    }
  })

  test('both current models resolve to a 1M context window', () => {
    expect(getChinaProviderContextWindow('mimo-v2.6-pro')).toBe(1_000_000)
    expect(getChinaProviderContextWindow('mimo-v2.6-flash')).toBe(1_000_000)
  })

  test('the wizard reaches the same preset by id and by either endpoint', () => {
    // Picking MiMo goes by id; reopening the model step later goes by the
    // base URL the wizard saved, pay-as-you-go or Token Plan.
    const payAsYouGo = resolveChinaProviderBaseURL('mimo', 'api')
    const tokenPlan = resolveChinaProviderBaseURL('mimo', 'coding-plan')
    expect(payAsYouGo).toBe('https://api.xiaomimimo.com/v1')
    expect(tokenPlan).toBe('https://token-plan-cn.xiaomimimo.com/v1')
    for (const baseURL of [payAsYouGo, tokenPlan]) {
      const preset = findChinaProviderByBaseURL(baseURL)
      expect(preset?.id).toBe('mimo')
      expect(preset?.defaultModel).toBe('mimo-v2.6-pro')
      expect(preset?.tiers.haiku).toBe('mimo-v2.6-flash')
    }
  })
})
