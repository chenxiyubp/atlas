// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NodeCapabilities, ProviderModel } from '../src/index.js'

/** A fake key shaped like a real one; never a real credential. */
export const CANARY_KEY = 'sk-test-canary-7Hq2Zp9LmV4xR8sT1wYc'

/** What a node runs today, before P18.5 / P18.8 / P18.18. */
export const V1_CAPABILITIES: NodeCapabilities = {
  protocol: 1,
  chatEffortHonorsOverride: false,
  replayFilter: false,
  multiKey: false,
}

export function anthropicModel(
  overrides: Partial<ProviderModel> = {},
): ProviderModel {
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

/** A minimal valid wire profile as plain JSON (what stdin would carry). */
export function wireProfileJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'vendor-paygo',
    revision: 3,
    lane: 'anthropic',
    baseUrl: 'https://api.vendor.example/anthropic',
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: CANARY_KEY }] },
    models: [
      anthropicModel(),
      anthropicModel({
        id: 'vendor-model-flash',
        role: 'fast',
        tiers: ['haiku'],
      }),
    ],
    compat: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
    ...overrides,
  }
}

export function applyRequestJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    op: 'apply',
    requestId: '01JB0000000000000000000001',
    node: 'beta-1',
    expect: { ownedHash: null },
    profile: wireProfileJson(),
    recycle: { sessions: 'reset' },
    dryRun: false,
    force: false,
    ...overrides,
  }
}
