// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ApplyRequest,
  type NodeCapabilities,
  type Preset,
  type ProviderModel,
  parseWireProfile,
  type WireProfile,
} from '@qianmo/providers'

/** Shaped like a real key, never a real credential. */
export const CANARY_KEY = 'sk-test-canary-7Hq2Zp9LmV4xR8sT1wYc'
export const CANARY_KEY_2 = 'sk-test-canary-second-Kd83nQ0vXp2'

export const V1: NodeCapabilities = {
  protocol: 1,
  chatEffortHonorsOverride: false,
  replayFilter: false,
  multiKey: false,
}

const CATALOG_DAY = new Date('2026-10-03T00:00:00Z')

export function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: 'vendor-model-pro',
    role: 'main',
    tiers: ['opus', 'sonnet', 'fable'],
    capabilities: {
      mode: 'explicit',
      thinking: true,
      adaptive_thinking: false,
      interleaved_thinking: false,
    },
    effort: { send: 'always', levels: ['low', 'high', 'max'], level: 'max' },
    ...overrides,
  }
}

function profileJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'vendor-paygo',
    revision: 3,
    lane: 'anthropic',
    baseUrl: 'https://api.vendor.example/anthropic',
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: CANARY_KEY }] },
    models: [
      model(),
      model({ id: 'vendor-model-flash', role: 'fast', tiers: ['haiku'] }),
    ],
    compat: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
    ...overrides,
  }
}

/** Validated exactly as a node would before compiling. */
export function wireProfile(
  overrides: Record<string, unknown> = {},
  capabilities: NodeCapabilities = V1,
): WireProfile {
  const parsed = parseWireProfile(profileJson(overrides), {
    capabilities: { ...capabilities, multiKey: true },
    now: CATALOG_DAY,
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
  return parsed.value
}

/** A preset turned into a deliverable profile (placeholders filled in). */
export function presetProfile(preset: Preset, key = CANARY_KEY): WireProfile {
  const templateValues = Object.fromEntries(
    preset.templateVars.map(variable => [variable.name, 'example-1']),
  )
  const models =
    preset.models.length > 0
      ? preset.models
      : [
          {
            id: 'user-model',
            role: 'main',
            tiers: ['opus', 'sonnet', 'haiku', 'fable'],
            capabilities: { mode: 'family' },
            effort: { send: 'auto' },
          },
        ]
  return wireProfile({
    id: preset.id,
    revision: 1,
    lane: preset.lane,
    baseUrl:
      preset.baseUrl === '' ? 'https://gateway.example.test' : preset.baseUrl,
    ...(preset.templateVars.length > 0 ? { templateValues } : {}),
    auth: {
      scheme: preset.authScheme,
      keys: [{ id: 'k1', value: preset.placeholderKey ?? key }],
    },
    models,
    compat: preset.compat,
  })
}

let sequence = 0

export function applyRequest(
  overrides: Partial<Omit<ApplyRequest, 'profile'>> & {
    profile?: Record<string, unknown>
  } = {},
): ApplyRequest {
  sequence += 1
  const { profile, ...rest } = overrides
  return {
    v: 1,
    op: 'apply',
    requestId: `01JBTEST${String(sequence).padStart(18, '0')}`,
    node: 'beta-1',
    expect: { ownedHash: null },
    recycle: { sessions: 'reset' },
    dryRun: false,
    force: false,
    ...rest,
    profile: profileJson(profile) as unknown as ApplyRequest['profile'],
  }
}
