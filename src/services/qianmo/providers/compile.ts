// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Profile → `settings.json` patch (§3.3, §3.4).
 *
 * The patch is built by the base's own activation builders,
 * `buildActivationEnvPatch` and `buildActivationModelSettingsPatch`, so a
 * delivered profile lands with exactly the semantics `/provider use` has:
 * every key in `ALL_PROFILE_ENV_KEYS` first set to delete, then the profile's
 * keys overlaid; all five `modelSettings` slots rewritten. This module only
 * decides WHICH keys and values a profile means — it never invents another
 * merge rule.
 *
 * Pure: no file access, no process.env reads. The node passes the resolved key
 * value (a `keep` is resolved against the node's current settings before
 * calling in) and its capabilities.
 */

import {
  checkModelEffort,
  clampSharedEffortDown,
  compiledEffortLevel,
  type CompatEnv,
  type EffortLevel,
  isCompatKey,
  type Lane,
  type ModelTier,
  type NodeCapabilities,
  type ProviderIssue,
  type ProviderModel,
  PROFILE_SETTABLE_COMPAT_KEYS,
  primaryKey,
  resolveBaseUrl,
  type WireProfile,
} from '@qianmo/providers'
import type { ProfileModelType } from '../../providerProfiles/envKeys.js'
import {
  buildActivationEnvPatch,
  buildActivationModelSettingsPatch,
  type ProfileModelSettings,
  type ProviderProfile as BaseProviderProfile,
} from '../../providerProfiles/profiles.js'
import { isDeepSeekBaseURL } from '../../../utils/model/deepseekHost.js'
import type { ModelSettingsSlot } from '../../../utils/model/modelTier.js'
import type { SettingsPatch } from './managedView.js'
import { checkEnvAgainstWhitelist } from './whitelist.js'

/**
 * How a profile reaches the wire. `deepseek-mirror` is §3.3's special case:
 * written as OPENAI_* keys with no `OPENAI_WIRE_API`, so the runtime's own
 * DeepSeek mirror (`deepseekWire.ts`) moves it onto the official Anthropic
 * endpoint and DeepSeek's tuning (function cap, coding temperature, effort
 * ladder) stays in force.
 */
export type CompileRoute = 'direct' | 'deepseek-mirror'

type LaneShape = {
  modelType: ProfileModelType
  prefix: 'ANTHROPIC' | 'OPENAI' | 'GEMINI' | 'GROK'
  baseUrlKey: string
  primaryModelKey: string
  wireApi?: 'chat' | 'responses'
}

const SHAPES: Record<Lane, LaneShape> = {
  anthropic: {
    modelType: 'anthropic',
    prefix: 'ANTHROPIC',
    baseUrlKey: 'ANTHROPIC_BASE_URL',
    primaryModelKey: 'ANTHROPIC_MODEL',
  },
  'openai-chat': {
    modelType: 'openai',
    prefix: 'OPENAI',
    baseUrlKey: 'OPENAI_BASE_URL',
    primaryModelKey: 'OPENAI_MODEL',
    wireApi: 'chat',
  },
  'openai-responses': {
    modelType: 'openai',
    prefix: 'OPENAI',
    baseUrlKey: 'OPENAI_BASE_URL',
    primaryModelKey: 'OPENAI_MODEL',
    wireApi: 'responses',
  },
  gemini: {
    modelType: 'gemini',
    prefix: 'GEMINI',
    baseUrlKey: 'GEMINI_BASE_URL',
    primaryModelKey: 'GEMINI_MODEL',
  },
  grok: {
    modelType: 'grok',
    prefix: 'GROK',
    baseUrlKey: 'GROK_BASE_URL',
    primaryModelKey: 'GROK_MODEL',
  },
}

const DEEPSEEK_MIRROR_SHAPE: LaneShape = {
  modelType: 'openai',
  prefix: 'OPENAI',
  baseUrlKey: 'OPENAI_BASE_URL',
  primaryModelKey: 'OPENAI_MODEL',
}

function secretKeyFor(route: CompileRoute, profile: WireProfile): string {
  if (route === 'deepseek-mirror') return 'OPENAI_API_KEY'
  switch (profile.lane) {
    case 'anthropic':
      return profile.auth.scheme === 'x-api-key'
        ? 'ANTHROPIC_API_KEY'
        : 'ANTHROPIC_AUTH_TOKEN'
    case 'openai-chat':
    case 'openai-responses':
      return 'OPENAI_API_KEY'
    case 'gemini':
      return 'GEMINI_API_KEY'
    case 'grok':
      return 'GROK_API_KEY'
  }
}

/** The six names in `_SUPPORTED_CAPABILITIES`, in a fixed order. */
const CAPABILITY_NAMES = [
  'effort',
  'xhigh_effort',
  'max_effort',
  'thinking',
  'adaptive_thinking',
  'interleaved_thinking',
] as const

/**
 * The explicit capability list for a model with `send: always | never`, or
 * `undefined` for `auto` (no override written). The effort trio comes from
 * `send` and `levels` (§3.4); the thinking trio from the profile.
 */
export function capabilityList(model: ProviderModel): string | undefined {
  if (model.effort.send === 'auto' || model.capabilities.mode !== 'explicit') {
    return undefined
  }
  const levels = model.effort.levels ?? []
  const on = model.effort.send === 'always'
  const bits: Record<(typeof CAPABILITY_NAMES)[number], boolean> = {
    effort: on,
    xhigh_effort: on && levels.includes('xhigh'),
    max_effort: on && levels.includes('max'),
    thinking: model.capabilities.thinking,
    adaptive_thinking: model.capabilities.adaptive_thinking,
    interleaved_thinking: model.capabilities.interleaved_thinking,
  }
  return CAPABILITY_NAMES.filter(name => bits[name]).join(',')
}

function tierEnvKey(prefix: string, tier: ModelTier, suffix = ''): string {
  return `${prefix}_DEFAULT_${tier.toUpperCase()}_MODEL${suffix}`
}

/**
 * The level written into `modelSettings`, clamped down into `levels`; an
 * `always` model without a level gets `UNSPECIFIED_EFFORT_LEVEL` so the
 * runtime's unclamped family default never reaches the wire.
 */
function slotEffort(model: ProviderModel): EffortLevel | undefined {
  return compiledEffortLevel(model.effort) ?? undefined
}

type CompileOptions = {
  /** The key value to write — already resolved from `value` or `keep`. */
  secret: string
  capabilities: NodeCapabilities
}

export type CompiledProfile = {
  patch: SettingsPatch
  route: CompileRoute
  /** The lane the runtime will actually speak (DeepSeek opt-out → chat). */
  effectiveLane: Lane
  /** The delivered key's id and the env key holding it. */
  keyId: string
  secretEnvKey: string
  /** Compat keys this profile writes, with their values. */
  compat: Record<string, string>
}

export type CompileResult =
  | { ok: true; compiled: CompiledProfile }
  | { ok: false; error: ProviderIssue }

function issue(
  code: ProviderIssue['code'],
  path: string,
  message: string,
): CompileResult {
  return { ok: false, error: { code, path, message } }
}

/**
 * Compile a validated {@link WireProfile}. The profile is re-checked against
 * the §3.4 rules on the EFFECTIVE lane, because that is the one gate the
 * schema alone cannot see (a DeepSeek profile with the mirror switched off is
 * declared `anthropic` but runs on chat).
 */
export function compileProfile(
  profile: WireProfile,
  options: CompileOptions,
): CompileResult {
  if (profile.auth.keys.length > 1 && !options.capabilities.multiKey) {
    return issue(
      'unsupported-multi-key',
      'profile.auth.keys',
      '本节点一次只接受一把密钥 · 多密钥轮换要等节点支持',
    )
  }
  const resolved = resolveBaseUrl(profile.baseUrl, profile.templateValues)
  if (!resolved.ok)
    return issue('bad-value', 'profile.baseUrl', resolved.message)

  const route: CompileRoute =
    profile.lane === 'anthropic' && isDeepSeekBaseURL(resolved.url)
      ? 'deepseek-mirror'
      : 'direct'
  const compatIn: CompatEnv = profile.compat ?? {}
  const effectiveLane: Lane =
    route === 'deepseek-mirror' &&
    compatIn.CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE === '0'
      ? 'openai-chat'
      : profile.lane
  for (const [index, model] of profile.models.entries()) {
    const problem = checkModelEffort(
      model,
      effectiveLane,
      `profile.models.${index}`,
      options.capabilities,
    )
    if (problem !== null) return { ok: false, error: problem }
  }

  const shape =
    route === 'deepseek-mirror' ? DEEPSEEK_MIRROR_SHAPE : SHAPES[profile.lane]
  const secretEnvKey = secretKeyFor(route, profile)
  const main = profile.models.find(model => model.role === 'main')
  if (main === undefined)
    return issue('bad-value', 'profile.models', '缺少主模型')

  const env: Record<string, string> = {
    [shape.baseUrlKey]: resolved.url,
    [secretEnvKey]: options.secret,
    [shape.primaryModelKey]: main.id,
  }
  if (shape.wireApi !== undefined) env.OPENAI_WIRE_API = shape.wireApi

  const modelSettings: ProfileModelSettings = {}
  const putSlot = (slot: ModelSettingsSlot, model: ProviderModel) => {
    const effort = slotEffort(model)
    if (effort === undefined && model.contextTokens === undefined) return
    modelSettings[slot] = {
      ...(effort !== undefined ? { effort } : {}),
      ...(model.contextTokens !== undefined
        ? { contextTokens: model.contextTokens }
        : {}),
    }
  }
  for (const model of profile.models) {
    const capabilities = capabilityList(model)
    for (const tier of model.tiers) {
      env[tierEnvKey(shape.prefix, tier)] = model.id
      if (capabilities !== undefined) {
        env[tierEnvKey(shape.prefix, tier, '_SUPPORTED_CAPABILITIES')] =
          capabilities
      }
      putSlot(tier, model)
    }
  }
  putSlot('default', main)

  const compat: Record<string, string> = {}
  for (const [key, value] of Object.entries(compatIn)) {
    if (value === undefined) continue
    if (!isCompatKey(key) || !PROFILE_SETTABLE_COMPAT_KEYS.includes(key)) {
      return issue(
        'unknown-key',
        `profile.compat.${key}`,
        `${key} 不在闭合兼容键集里`,
      )
    }
    compat[key] = value
  }
  if (profile.effortLock !== undefined && profile.effortLock !== null) {
    const sets = profile.models
      .filter(model => model.effort.send !== 'never')
      .map(model => model.effort.levels)
      .filter(
        (levels): levels is readonly EffortLevel[] => levels !== undefined,
      )
    const locked = clampSharedEffortDown(profile.effortLock, sets)
    if (locked === null) {
      return issue(
        'bad-value',
        'profile.effortLock',
        '锁定档位往低夹不到所有模型都接受的一档',
      )
    }
    compat.CLAUDE_CODE_EFFORT_LEVEL = locked
  }
  if (profile.models.every(model => model.effort.send === 'always')) {
    compat.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  }

  const keyId = primaryKey(profile.auth.keys).id
  const base: BaseProviderProfile = {
    name: profile.id,
    modelType: shape.modelType,
    env: { ...env, ...compat },
    modelSettings,
    createdAt: '',
    updatedAt: '',
  }
  const patch: SettingsPatch = {
    modelType: shape.modelType,
    env: buildActivationEnvPatch(base),
    modelSettings: buildActivationModelSettingsPatch(base),
  }
  const outside = checkEnvAgainstWhitelist(patch.env)
  if (outside !== null) return { ok: false, error: outside }

  return {
    ok: true,
    compiled: { patch, route, effectiveLane, keyId, secretEnvKey, compat },
  }
}
