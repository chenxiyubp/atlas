// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  clampEffortDown,
  clampSharedEffortDown,
  COMPAT_KEYS,
  compiledEffortLevel,
  keyMatchesHint,
  parseProviderProfile,
  parseWireProfile,
  primaryKey,
  type ProviderErrorCode,
  secretFingerprint,
  type ValidateOptions,
} from '../src/index.js'
import {
  anthropicModel,
  CANARY_KEY,
  V1_CAPABILITIES,
  wireProfileJson,
} from './fixtures.js'

const OPTIONS: ValidateOptions = {
  capabilities: V1_CAPABILITIES,
  now: new Date('2026-10-03T00:00:00Z'),
}

function refusal(
  input: Record<string, unknown>,
  options: ValidateOptions = OPTIONS,
): { code: ProviderErrorCode; path: string } {
  const result = parseWireProfile(input, options)
  if (result.ok) throw new Error('expected a refusal')
  return { code: result.error.code, path: result.error.path }
}

function accepted(input: Record<string, unknown>, options = OPTIONS) {
  const result = parseWireProfile(input, options)
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result
}

describe('closed key set (§3.6) and process-level keys', () => {
  test('the compat set is exactly the §3.6 table', () => {
    expect([...COMPAT_KEYS]).toEqual([
      'CLAUDE_CODE_EFFORT_LEVEL',
      'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'API_TIMEOUT_MS',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
    ])
  })

  for (const key of [
    'PATH',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'OPENAI_BASE_URL',
  ]) {
    test(`compat refuses ${key} as unknown-key`, () => {
      expect(refusal(wireProfileJson({ compat: { [key]: '1' } }))).toEqual({
        code: 'unknown-key',
        path: `profile.compat.${key}`,
      })
    })
  }

  test('the two effort keys are derived, never set by hand', () => {
    for (const key of [
      'CLAUDE_CODE_EFFORT_LEVEL',
      'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
    ]) {
      expect(refusal(wireProfileJson({ compat: { [key]: '1' } })).code).toBe(
        'bad-value',
      )
    }
  })

  test('compat values are range-checked', () => {
    const bad: Record<string, string> = {
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true',
      API_TIMEOUT_MS: '1000',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '-5',
      ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: stolen',
      CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE: '1',
    }
    for (const [key, value] of Object.entries(bad)) {
      expect(refusal(wireProfileJson({ compat: { [key]: value } })).code).toBe(
        'bad-value',
      )
    }
    accepted(
      wireProfileJson({
        compat: {
          API_TIMEOUT_MS: '600000',
          ANTHROPIC_CUSTOM_HEADERS: 'anthropic-workspace-id: wrkspc_01',
        },
      }),
    )
  })

  test('unknown fields anywhere in the profile are refused, not ignored', () => {
    expect(refusal(wireProfileJson({ env: { PATH: '/tmp' } }))).toEqual({
      code: 'unknown-key',
      path: 'profile.env',
    })
    const models = [{ ...anthropicModel(), shell: 'rm -rf /' }]
    expect(refusal(wireProfileJson({ models })).code).toBe('unknown-key')
  })
})

describe('base URL (§3.1)', () => {
  test('https anywhere; http only to loopback or private addresses', () => {
    accepted(wireProfileJson({ baseUrl: 'http://localhost:11434' }))
    accepted(wireProfileJson({ baseUrl: 'http://127.0.0.1:8000' }))
    accepted(wireProfileJson({ baseUrl: 'http://192.168.5.6:1234' }))
    expect(
      refusal(wireProfileJson({ baseUrl: 'http://api.vendor.example' })).code,
    ).toBe('bad-value')
    expect(refusal(wireProfileJson({ baseUrl: 'ftp://x.example' })).code).toBe(
      'bad-value',
    )
  })

  test('no credentials, query string or fragment in the URL', () => {
    for (const baseUrl of [
      'https://user:pass@api.vendor.example',
      'https://api.vendor.example/?key=abc',
      'https://api.vendor.example/#frag',
    ]) {
      expect(refusal(wireProfileJson({ baseUrl })).code).toBe('bad-value')
    }
  })

  test('template values fill placeholders and cannot change the host', () => {
    const template =
      'https://{WorkspaceId}.{region}.maas.aliyuncs.com/apps/anthropic'
    accepted(
      wireProfileJson({
        baseUrl: template,
        templateValues: { WorkspaceId: 'ws-1', region: 'cn-beijing' },
      }),
    )
    expect(
      refusal(
        wireProfileJson({
          baseUrl: template,
          templateValues: { WorkspaceId: 'ws-1' },
        }),
      ).code,
    ).toBe('bad-value')
    expect(
      refusal(
        wireProfileJson({
          baseUrl: template,
          templateValues: {
            WorkspaceId: 'evil.example/x',
            region: 'cn-beijing',
          },
        }),
      ).code,
    ).toBe('bad-value')
  })
})

describe('models (§3.2)', () => {
  test('exactly one main model, which occupies at least one tier', () => {
    const two = [
      anthropicModel(),
      anthropicModel({ id: 'm2', tiers: ['haiku'] }),
    ]
    expect(refusal(wireProfileJson({ models: two })).code).toBe('bad-value')
    const tierless = [
      anthropicModel({
        tiers: [],
        effort: { send: 'auto' },
        capabilities: { mode: 'family' },
      }),
    ]
    expect(refusal(wireProfileJson({ models: tierless })).code).toBe(
      'bad-value',
    )
  })

  test('a tier belongs to at most one model; ids are unique', () => {
    const clash = [
      anthropicModel(),
      anthropicModel({ id: 'other', role: 'fast', tiers: ['opus'] }),
    ]
    expect(refusal(wireProfileJson({ models: clash })).code).toBe('bad-value')
    const dup = [
      anthropicModel(),
      anthropicModel({ role: 'fast', tiers: ['haiku'] }),
    ]
    expect(refusal(wireProfileJson({ models: dup })).code).toBe('bad-value')
  })

  test('third-party ids never carry [1m]', () => {
    const models = [anthropicModel({ id: 'k3[1m]' })]
    expect(refusal(wireProfileJson({ models })).code).toBe('bad-value')
  })

  test('a retired model is refused; one inside the 14-day window only warns', () => {
    const retired = [anthropicModel({ id: 'mimo-v2.5-pro' })]
    expect(
      refusal(wireProfileJson({ models: retired }), {
        ...OPTIONS,
        now: new Date('2026-10-21T02:00:00Z'),
      }).code,
    ).toBe('retired-model')
    const warned = accepted(wireProfileJson({ models: retired }), {
      ...OPTIONS,
      now: new Date('2026-10-10T00:00:00Z'),
    })
    expect(warned.warnings.map(warning => warning.code)).toContain(
      'retiring-model',
    )
  })
})

describe('§3.4 effort rules, cell by cell', () => {
  const lanes = [
    'anthropic',
    'openai-responses',
    'openai-chat',
    'gemini',
    'grok',
  ] as const
  const explicitBits = {
    mode: 'explicit',
    thinking: false,
    adaptive_thinking: false,
    interleaved_thinking: false,
  } as const
  const urlFor = (lane: (typeof lanes)[number]) =>
    lane === 'anthropic'
      ? 'https://api.vendor.example/anthropic'
      : 'https://api.vendor.example/v1'

  function profileWith(
    lane: (typeof lanes)[number],
    send: 'always' | 'never' | 'auto',
  ) {
    const effort =
      send === 'auto'
        ? { send }
        : send === 'never'
          ? { send }
          : { send, levels: ['low', 'high'], level: 'high' }
    const capabilities = send === 'auto' ? { mode: 'family' } : explicitBits
    return wireProfileJson({
      lane,
      baseUrl: urlFor(lane),
      compat: {},
      models: [
        anthropicModel({
          tiers: ['opus', 'sonnet', 'haiku', 'fable'],
          capabilities,
          effort,
        } as never),
      ],
    })
  }

  test('always: accepted on anthropic and responses', () => {
    accepted(profileWith('anthropic', 'always'))
    accepted(profileWith('openai-responses', 'always'))
  })

  test('always on chat: effort-unsendable until the node reports chatEffortHonorsOverride', () => {
    expect(refusal(profileWith('openai-chat', 'always')).code).toBe(
      'effort-unsendable',
    )
    accepted(profileWith('openai-chat', 'always'), {
      ...OPTIONS,
      capabilities: { ...V1_CAPABILITIES, chatEffortHonorsOverride: true },
    })
  })

  test('always / never on gemini and grok: effort-unsendable in v1', () => {
    for (const lane of ['gemini', 'grok'] as const) {
      expect(refusal(profileWith(lane, 'always')).code).toBe(
        'effort-unsendable',
      )
      expect(refusal(profileWith(lane, 'never')).code).toBe('effort-unsendable')
    }
  })

  test('never: accepted on anthropic, responses and chat', () => {
    for (const lane of [
      'anthropic',
      'openai-responses',
      'openai-chat',
    ] as const) {
      accepted(profileWith(lane, 'never'))
    }
  })

  test('auto: accepted on every lane', () => {
    for (const lane of lanes) accepted(profileWith(lane, 'auto'))
  })

  test('auto pairs with family, always/never with explicit (all-or-nothing list)', () => {
    const autoExplicit = [anthropicModel({ effort: { send: 'auto' } })]
    expect(refusal(wireProfileJson({ models: autoExplicit })).code).toBe(
      'bad-value',
    )
    const alwaysFamily = [anthropicModel({ capabilities: { mode: 'family' } })]
    expect(refusal(wireProfileJson({ models: alwaysFamily })).code).toBe(
      'bad-value',
    )
  })

  test('always needs a level set', () => {
    const models = [anthropicModel({ effort: { send: 'always' } })]
    expect(refusal(wireProfileJson({ models })).code).toBe('bad-value')
  })

  test('explicit capabilities on a fable-only model are refused (FABLE is unread before P18.5)', () => {
    const models = [anthropicModel({ tiers: ['fable'] })]
    expect(refusal(wireProfileJson({ models })).code).toBe('bad-value')
  })

  test('a level with nothing at or below it in the set is refused, never raised', () => {
    const models = [
      anthropicModel({
        effort: { send: 'always', levels: ['high', 'max'], level: 'low' },
      }),
    ]
    expect(refusal(wireProfileJson({ models }))).toEqual({
      code: 'bad-value',
      path: 'profile.models.0.effort.level',
    })
  })

  test('always without a level compiles as high, clamped down; refused when nothing is at or below high', () => {
    expect(
      compiledEffortLevel({
        send: 'always',
        levels: ['low', 'medium', 'high'],
      }),
    ).toBe('high')
    expect(
      compiledEffortLevel({ send: 'always', levels: ['low', 'max'] }),
    ).toBe('low')
    expect(
      compiledEffortLevel({ send: 'always', levels: ['xhigh', 'max'] }),
    ).toBeNull()
    expect(compiledEffortLevel({ send: 'never', level: 'max' })).toBeUndefined()
    expect(compiledEffortLevel({ send: 'auto' })).toBeUndefined()
    const models = [
      anthropicModel({ effort: { send: 'always', levels: ['xhigh', 'max'] } }),
    ]
    expect(refusal(wireProfileJson({ models }))).toEqual({
      code: 'bad-value',
      path: 'profile.models.0.effort.level',
    })
  })

  test('clamp table: down only', () => {
    expect(clampEffortDown('max', ['low', 'high', 'max'])).toBe('max')
    expect(clampEffortDown('xhigh', ['low', 'high', 'max'])).toBe('high')
    expect(clampEffortDown('medium', ['low', 'high', 'max'])).toBe('low')
    expect(clampEffortDown('low', ['high', 'max'])).toBeNull()
    expect(clampEffortDown('high', [])).toBeNull()
  })

  test('effortLock: one value valid for every constrained model', () => {
    expect(
      clampSharedEffortDown('max', [
        ['low', 'high', 'max'],
        ['low', 'medium', 'high'],
      ]),
    ).toBe('high')
    expect(
      clampSharedEffortDown('max', [
        ['low', 'max'],
        ['low', 'high'],
      ]),
    ).toBe('low')
    expect(clampSharedEffortDown('max', [['max'], ['high']])).toBeNull()
    expect(clampSharedEffortDown('xhigh', [])).toBe('xhigh')
    expect(
      refusal(
        wireProfileJson({
          effortLock: 'low',
          models: [
            anthropicModel({
              effort: { send: 'always', levels: ['high', 'max'], level: 'max' },
            }),
          ],
        }),
      ).code,
    ).toBe('bad-value')
  })
})

describe('keys (multi-key schema, single-key delivery)', () => {
  test('1..8 keys; zero is refused (third-party Anthropic host without a key leaks local login)', () => {
    expect(
      refusal(wireProfileJson({ auth: { scheme: 'bearer', keys: [] } })).code,
    ).toBe('bad-value')
    const nine = Array.from({ length: 9 }, (_, i) => ({
      id: `k${i}`,
      value: CANARY_KEY,
    }))
    expect(
      refusal(wireProfileJson({ auth: { scheme: 'bearer', keys: nine } })).code,
    ).toBe('bad-value')
  })

  test('value XOR keep; keep must be a fingerprint; ids unique', () => {
    expect(
      refusal(
        wireProfileJson({
          auth: {
            scheme: 'bearer',
            keys: [
              {
                id: 'k1',
                value: CANARY_KEY,
                keep: secretFingerprint(CANARY_KEY),
              },
            ],
          },
        }),
      ).code,
    ).toBe('bad-request')
    expect(
      refusal(
        wireProfileJson({
          auth: { scheme: 'bearer', keys: [{ id: 'k1', keep: 'last4' }] },
        }),
      ).code,
    ).toBe('bad-value')
    accepted(
      wireProfileJson({
        auth: {
          scheme: 'bearer',
          keys: [{ id: 'k1', keep: secretFingerprint(CANARY_KEY) }],
        },
      }),
    )
    expect(
      refusal(
        wireProfileJson({
          auth: {
            scheme: 'bearer',
            keys: [
              { id: 'k1', value: 'a' },
              { id: 'k1', value: 'b' },
            ],
          },
        }),
      ).code,
    ).toBe('bad-value')
  })

  test('a refusal about the key never echoes it', () => {
    const result = parseWireProfile(
      wireProfileJson({
        auth: {
          scheme: 'bearer',
          keys: [{ id: 'k1', value: `${CANARY_KEY} with space` }],
        },
      }),
      OPTIONS,
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(CANARY_KEY)
  })

  test('keySelection is a closed enum defaulting to fill_first', () => {
    expect(accepted(wireProfileJson()).value.keySelection).toBe('fill_first')
    expect(
      accepted(wireProfileJson({ keySelection: 'round_robin' })).value
        .keySelection,
    ).toBe('round_robin')
    expect(refusal(wireProfileJson({ keySelection: 'random' })).code).toBe(
      'bad-value',
    )
  })

  test('primaryKey: highest priority, ties keep list order', () => {
    expect(primaryKey([{ id: 'a' }, { id: 'b' }]).id).toBe('a')
    expect(
      primaryKey([
        { id: 'a', priority: 1 },
        { id: 'b', priority: 5 },
      ]).id,
    ).toBe('b')
    expect(
      primaryKey([
        { id: 'a', priority: 5 },
        { id: 'b', priority: 5 },
      ]).id,
    ).toBe('a')
    expect(primaryKey([{ id: 'a', priority: -1 }, { id: 'b' }]).id).toBe('b')
  })

  test('key hints are soft and only match what they say', () => {
    expect(keyMatchesHint('sk-sp-abc', { prefixes: ['sk-sp-'] })).toBe(true)
    expect(keyMatchesHint('sk-abc', { prefixes: ['sk-sp-'] })).toBe(false)
    expect(
      keyMatchesHint('id.secret', {
        prefixes: [],
        pattern: '^[^.\\s]+\\.[^.\\s]+$',
      }),
    ).toBe(true)
    expect(keyMatchesHint('anything', null)).toBe(true)
  })
})

describe('auth scheme', () => {
  test('x-api-key is an Anthropic-wire header; other lanes are bearer only', () => {
    accepted(
      wireProfileJson({
        auth: { scheme: 'x-api-key', keys: [{ id: 'k1', value: CANARY_KEY }] },
      }),
    )
    const responses = wireProfileJson({
      lane: 'openai-responses',
      baseUrl: 'https://api.vendor.example/v1',
      compat: {},
      auth: { scheme: 'x-api-key', keys: [{ id: 'k1', value: CANARY_KEY }] },
    })
    expect(refusal(responses)).toEqual({
      code: 'bad-value',
      path: 'profile.auth.scheme',
    })
    expect(
      refusal(
        wireProfileJson({
          auth: { scheme: 'basic', keys: [{ id: 'k1', value: CANARY_KEY }] },
        }),
      ).code,
    ).toBe('bad-value')
  })
})

describe('hub profile (§3.1)', () => {
  function hubProfile(overrides: Record<string, unknown> = {}) {
    const { auth: _auth, ...core } = wireProfileJson()
    return {
      ...core,
      name: 'Vendor 按量',
      presetId: 'deepseek',
      plan: 'paygo',
      site: null,
      auth: { scheme: 'bearer' },
      keys: [
        {
          id: 'k1',
          label: '主',
          fingerprint: secretFingerprint(CANARY_KEY),
          setAt: '2026-10-03T06:20:00Z',
        },
      ],
      evaluated: false,
      ...overrides,
    }
  }

  test('parses, carrying key references but no key values', () => {
    const result = parseProviderProfile(hubProfile(), OPTIONS)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.keys).toHaveLength(1)
    expect(JSON.stringify(result.value)).not.toContain(CANARY_KEY)
  })

  test('a key value inside the hub profile is an unknown field', () => {
    const result = parseProviderProfile(
      hubProfile({ keys: [{ id: 'k1', value: CANARY_KEY }] }),
      OPTIONS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown-key')
  })

  test('evaluated is false or carries evidence', () => {
    expect(
      parseProviderProfile(hubProfile({ evaluated: true }), OPTIONS).ok,
    ).toBe(false)
    expect(
      parseProviderProfile(
        hubProfile({
          evaluated: {
            at: '2026-10-12T00:00:00Z',
            by: 'ops',
            evidence: 'smoke run 1',
          },
        }),
        OPTIONS,
      ).ok,
    ).toBe(true)
  })
})
