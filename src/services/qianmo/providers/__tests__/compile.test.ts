// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  COMPAT_KEYS,
  type NodeCapabilities,
  PRESETS,
  type WireProfile,
} from '@qianmo/providers'
import { ALL_PROFILE_ENV_KEYS } from '../../../providerProfiles/envKeys.js'
import {
  type CompileResult,
  capabilityList,
  compileProfile,
} from '../compile.js'
import {
  checkEnvAgainstWhitelist,
  MANAGED_ENV_KEYS,
  SECRET_ENV_KEYS,
} from '../whitelist.js'
import { CANARY_KEY, model, presetProfile, V1, wireProfile } from './helpers.js'

const UNIVERSE = new Set([...ALL_PROFILE_ENV_KEYS, ...COMPAT_KEYS])

function compiled(profile: WireProfile, capabilities: NodeCapabilities = V1) {
  const result = compileProfile(profile, { secret: CANARY_KEY, capabilities })
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.compiled
}

function refused(result: CompileResult): string {
  if (result.ok) throw new Error('expected a refusal')
  return result.error.code
}

const LANE_URL = {
  anthropic: 'https://api.vendor.example/anthropic',
  'openai-chat': 'https://api.vendor.example/v1',
  'openai-responses': 'https://api.vendor.example/v1',
  gemini: 'https://api.vendor.example/v1beta',
  grok: 'https://api.vendor.example/v1',
} as const

/** A spread of profiles that, between them, exercise every branch that names a key. */
function profileSpread(): WireProfile[] {
  const lanes = Object.keys(LANE_URL) as (keyof typeof LANE_URL)[]
  const spread: WireProfile[] = PRESETS.map(preset => presetProfile(preset))
  for (const lane of lanes) {
    spread.push(
      wireProfile({
        lane,
        baseUrl: LANE_URL[lane],
        compat: {},
        effortLock: 'high',
        models: [
          model({
            tiers: ['opus', 'sonnet', 'haiku', 'fable'],
            capabilities: { mode: 'family' },
            effort: { send: 'auto', level: 'high' },
            contextTokens: 400_000,
          }),
        ],
      }),
    )
  }
  spread.push(
    wireProfile({
      compat: {
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
        API_TIMEOUT_MS: '600000',
        ANTHROPIC_CUSTOM_HEADERS: 'anthropic-workspace-id: wrkspc_01',
      },
      effortLock: 'max',
    }),
    wireProfile({
      baseUrl: 'https://api.deepseek.com',
      compat: { CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE: '0' },
      models: [
        model({ capabilities: { mode: 'family' }, effort: { send: 'auto' } }),
      ],
    }),
    wireProfile({
      auth: { scheme: 'x-api-key', keys: [{ id: 'k1', value: CANARY_KEY }] },
    }),
  )
  return spread
}

describe('what the compiler can write', () => {
  test('every key the compiler names is in ALL_PROFILE_ENV_KEYS ∪ COMPAT_KEYS', () => {
    const named = new Set<string>()
    for (const profile of profileSpread()) {
      for (const key of Object.keys(
        compiled(profile, { ...V1, chatEffortHonorsOverride: true }).patch.env,
      )) {
        named.add(key)
      }
    }
    const outside = [...named].filter(key => !UNIVERSE.has(key))
    expect(outside).toEqual([])
    // Positive control: the spread really reaches the compat keys and all
    // four lane prefixes, so the subset check above is not vacuous.
    for (const key of COMPAT_KEYS) expect(named.has(key)).toBe(true)
    for (const prefix of ['ANTHROPIC_', 'OPENAI_', 'GEMINI_', 'GROK_']) {
      expect([...named].some(key => key.startsWith(prefix))).toBe(true)
    }
  })

  test('every preset compiles and its patch passes the node whitelist', () => {
    for (const preset of PRESETS) {
      const out = compiled(presetProfile(preset))
      expect(checkEnvAgainstWhitelist(out.patch.env)).toBeNull()
      expect(out.patch.env[out.secretEnvKey]).toBe(CANARY_KEY)
    }
  })

  test('activation semantics: every ALL_PROFILE_ENV_KEYS entry is named; unused ones delete', () => {
    const out = compiled(wireProfile())
    for (const key of ALL_PROFILE_ENV_KEYS)
      expect(key in out.patch.env).toBe(true)
    expect(out.patch.env.OPENAI_API_KEY).toBeUndefined()
    expect(out.patch.env.GEMINI_BASE_URL).toBeUndefined()
    expect(Object.keys(out.patch.modelSettings).sort()).toEqual([
      'default',
      'fable',
      'haiku',
      'opus',
      'sonnet',
    ])
  })

  test('credentials are only ever written to the known secret keys', () => {
    for (const profile of profileSpread()) {
      const env = compiled(profile, { ...V1, chatEffortHonorsOverride: true })
        .patch.env
      for (const [key, value] of Object.entries(env)) {
        if (value === CANARY_KEY) expect(SECRET_ENV_KEYS).toContain(key)
      }
    }
    for (const key of SECRET_ENV_KEYS)
      expect(ALL_PROFILE_ENV_KEYS).toContain(key)
  })
})

describe('the whitelist refuses process-level keys', () => {
  for (const key of [
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GEMINI',
    'PATH',
    'LD_PRELOAD',
    'NODE_OPTIONS',
  ]) {
    test(`${key} is refused even if a patch carried it`, () => {
      expect(checkEnvAgainstWhitelist({ [key]: '1' })?.code).toBe('unknown-key')
      expect(MANAGED_ENV_KEYS.has(key)).toBe(false)
    })

    test(`${key} smuggled into compat bypassing the schema is refused by the compiler`, () => {
      const profile = {
        ...wireProfile(),
        compat: { [key]: '1' },
      } as WireProfile
      expect(
        refused(
          compileProfile(profile, { secret: CANARY_KEY, capabilities: V1 }),
        ),
      ).toBe('unknown-key')
    })
  }
})

describe('§3.3 lane table', () => {
  test('anthropic: bearer → AUTH_TOKEN with API_KEY deleted; x-api-key → the reverse', () => {
    const bearer = compiled(wireProfile()).patch
    expect(bearer.modelType).toBe('anthropic')
    expect(bearer.env.ANTHROPIC_AUTH_TOKEN).toBe(CANARY_KEY)
    expect(
      'ANTHROPIC_API_KEY' in bearer.env &&
        bearer.env.ANTHROPIC_API_KEY === undefined,
    ).toBe(true)
    const xKey = compiled(
      wireProfile({
        auth: { scheme: 'x-api-key', keys: [{ id: 'k1', value: CANARY_KEY }] },
      }),
    ).patch
    expect(xKey.env.ANTHROPIC_API_KEY).toBe(CANARY_KEY)
    expect(xKey.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  test('openai lanes carry an explicit OPENAI_WIRE_API; gemini and grok their own prefixes', () => {
    const family = {
      capabilities: { mode: 'family' },
      effort: { send: 'auto' },
    }
    const chat = compiled(
      wireProfile({
        lane: 'openai-chat',
        baseUrl: LANE_URL['openai-chat'],
        models: [model(family as never)],
      }),
    ).patch
    expect([
      chat.modelType,
      chat.env.OPENAI_WIRE_API,
      chat.env.OPENAI_MODEL,
    ]).toEqual(['openai', 'chat', 'vendor-model-pro'])
    const responses = compiled(
      wireProfile({
        lane: 'openai-responses',
        baseUrl: LANE_URL['openai-responses'],
      }),
    ).patch
    expect([responses.modelType, responses.env.OPENAI_WIRE_API]).toEqual([
      'openai',
      'responses',
    ])
    const gemini = compiled(
      wireProfile({
        lane: 'gemini',
        baseUrl: LANE_URL.gemini,
        compat: {},
        models: [model(family as never)],
      }),
    ).patch
    expect([
      gemini.modelType,
      gemini.env.GEMINI_API_KEY,
      gemini.env.GEMINI_DEFAULT_OPUS_MODEL,
    ]).toEqual(['gemini', CANARY_KEY, 'vendor-model-pro'])
    const grok = compiled(
      wireProfile({
        lane: 'grok',
        baseUrl: LANE_URL.grok,
        compat: {},
        models: [model(family as never)],
      }),
    ).patch
    expect([
      grok.modelType,
      grok.env.GROK_API_KEY,
      grok.env.GROK_MODEL,
    ]).toEqual(['grok', CANARY_KEY, 'vendor-model-pro'])
  })

  test('DeepSeek: OPENAI_* without OPENAI_WIRE_API, so the runtime mirror takes the Anthropic endpoint', () => {
    const out = compiled(wireProfile({ baseUrl: 'https://api.deepseek.com' }))
    expect(out.route).toBe('deepseek-mirror')
    expect(out.patch.modelType).toBe('openai')
    expect(out.patch.env.OPENAI_BASE_URL).toBe('https://api.deepseek.com')
    expect(out.patch.env.OPENAI_API_KEY).toBe(CANARY_KEY)
    expect(out.patch.env.OPENAI_WIRE_API).toBeUndefined()
    expect(out.patch.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(
      out.patch.env.OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES,
    ).toContain('effort')
  })

  test('DeepSeek with the mirror switched off runs on chat, so `always` is unsendable there', () => {
    const profile = wireProfile({
      baseUrl: 'https://api.deepseek.com',
      compat: { CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE: '0' },
    })
    expect(
      refused(
        compileProfile(profile, { secret: CANARY_KEY, capabilities: V1 }),
      ),
    ).toBe('effort-unsendable')
  })

  test('templates resolve into the written base URL', () => {
    const out = compiled(
      wireProfile({
        baseUrl:
          'https://{WorkspaceId}.{region}.maas.aliyuncs.com/apps/anthropic',
        templateValues: { WorkspaceId: 'ws-1', region: 'cn-beijing' },
      }),
    )
    expect(out.patch.env.ANTHROPIC_BASE_URL).toBe(
      'https://ws-1.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    )
  })
})

describe('§3.4 effort table, cell by cell', () => {
  const always = {
    send: 'always',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    level: 'xhigh',
  }
  const explicit = {
    mode: 'explicit',
    thinking: true,
    adaptive_thinking: false,
    interleaved_thinking: false,
  }

  // Validated as a node that honours chat overrides would, so each test below
  // reaches the COMPILER's own gate rather than stopping at the schema.
  function on(
    lane: keyof typeof LANE_URL,
    effort: object,
    capabilities: object,
  ) {
    return wireProfile(
      {
        lane,
        baseUrl: LANE_URL[lane],
        compat: {},
        models: [
          model({
            tiers: ['opus', 'sonnet', 'haiku', 'fable'],
            effort,
            capabilities,
          } as never),
        ],
      },
      { ...V1, chatEffortHonorsOverride: true },
    )
  }

  const prefixOf = {
    anthropic: 'ANTHROPIC',
    'openai-chat': 'OPENAI',
    'openai-responses': 'OPENAI',
  } as const

  for (const lane of ['anthropic', 'openai-responses'] as const) {
    test(`${lane} · always: explicit list with effort on, xhigh/max from levels, pinned to every tier it owns`, () => {
      const env = compiled(on(lane, always, explicit)).patch.env
      for (const tier of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) {
        expect(env[`${prefixOf[lane]}_DEFAULT_${tier}_MODEL`]).toBe(
          'vendor-model-pro',
        )
        expect(
          env[`${prefixOf[lane]}_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`],
        ).toBe('effort,xhigh_effort,max_effort,thinking')
      }
      expect(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe('1')
    })

    test(`${lane} · never: explicit list with every effort bit off`, () => {
      const env = compiled(on(lane, { send: 'never' }, explicit)).patch.env
      expect(
        env[`${prefixOf[lane]}_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES`],
      ).toBe('thinking')
      expect(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBeUndefined()
    })

    test(`${lane} · auto: no capability override written at all`, () => {
      const env = compiled(on(lane, { send: 'auto' }, { mode: 'family' })).patch
        .env
      const overrides = Object.entries(env).filter(
        ([key, value]) =>
          key.endsWith('_SUPPORTED_CAPABILITIES') && value !== undefined,
      )
      expect(overrides).toEqual([])
    })
  }

  test('openai-chat · always: effort-unsendable while chatEffortHonorsOverride=false', () => {
    const result = compileProfile(on('openai-chat', always, explicit), {
      secret: CANARY_KEY,
      capabilities: V1,
    })
    expect(refused(result)).toBe('effort-unsendable')
  })

  test('openai-chat · always: compiles once the node reports chatEffortHonorsOverride', () => {
    const env = compiled(on('openai-chat', always, explicit), {
      ...V1,
      chatEffortHonorsOverride: true,
    }).patch.env
    expect(env.OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES).toContain(
      'effort',
    )
  })

  test('openai-chat · never and auto behave as on the other lanes', () => {
    expect(
      compiled(on('openai-chat', { send: 'never' }, explicit)).patch.env
        .OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES,
    ).toBe('thinking')
    expect(
      compiled(on('openai-chat', { send: 'auto' }, { mode: 'family' })).patch
        .env.OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES,
    ).toBeUndefined()
  })

  for (const lane of ['gemini', 'grok'] as const) {
    test(`${lane} · always and never are effort-unsendable in v1; auto compiles`, () => {
      // The schema would refuse these first; the compiler refuses them on its own too.
      const forced = (send: 'always' | 'never') =>
        ({
          ...on(lane, { send: 'auto' }, { mode: 'family' }),
          models: [
            model({
              tiers: ['opus'],
              effort: send === 'always' ? always : { send },
              capabilities: explicit,
            } as never),
          ],
        }) as WireProfile
      expect(
        refused(
          compileProfile(forced('always'), {
            secret: CANARY_KEY,
            capabilities: V1,
          }),
        ),
      ).toBe('effort-unsendable')
      expect(
        refused(
          compileProfile(forced('never'), {
            secret: CANARY_KEY,
            capabilities: V1,
          }),
        ),
      ).toBe('effort-unsendable')
      expect(
        compiled(on(lane, { send: 'auto' }, { mode: 'family' })).patch
          .modelType,
      ).toBe(lane)
    })
  }

  test('level clamps DOWN into levels and lands in every owned slot plus default for the main model', () => {
    const out = compiled(
      wireProfile({
        models: [
          model({
            effort: {
              send: 'always',
              levels: ['low', 'high', 'max'],
              level: 'xhigh',
            },
            contextTokens: 1_000_000,
          }),
          model({
            id: 'fast',
            role: 'fast',
            tiers: ['haiku'],
            effort: { send: 'always', levels: ['low', 'high'], level: 'max' },
          }),
        ],
      }),
    ).patch.modelSettings
    expect(out.default).toEqual({ effort: 'high', contextTokens: 1_000_000 })
    expect(out.opus).toEqual({ effort: 'high', contextTokens: 1_000_000 })
    expect(out.sonnet).toEqual({ effort: 'high', contextTokens: 1_000_000 })
    expect(out.fable).toEqual({ effort: 'high', contextTokens: 1_000_000 })
    expect(out.haiku).toEqual({ effort: 'high', contextTokens: undefined })
  })

  test('no lower level → refused, never raised', () => {
    const profile = {
      ...wireProfile(),
      models: [
        model({
          effort: { send: 'always', levels: ['high', 'max'], level: 'low' },
        }),
      ],
    } as WireProfile
    expect(
      refused(
        compileProfile(profile, { secret: CANARY_KEY, capabilities: V1 }),
      ),
    ).toBe('bad-value')
  })

  test('always without a level: `high` clamped down, written into every owned slot', () => {
    // Writing nothing would leave the runtime's family default (xhigh for a
    // third-party opus/sonnet slot), which is not clamped against levels.
    const out = compiled(
      wireProfile({
        models: [
          model({
            effort: { send: 'always', levels: ['low', 'medium', 'high'] },
          }),
          model({
            id: 'fast',
            role: 'fast',
            tiers: ['haiku'],
            effort: { send: 'always', levels: ['low', 'max'] },
          }),
        ],
      }),
    ).patch.modelSettings
    expect(out.default?.effort).toBe('high')
    expect(out.opus?.effort).toBe('high')
    expect(out.haiku?.effort).toBe('low')
  })

  test('always without a level and nothing at or below high → refused', () => {
    const profile = {
      ...wireProfile(),
      models: [model({ effort: { send: 'always', levels: ['xhigh', 'max'] } })],
    } as WireProfile
    expect(
      refused(
        compileProfile(profile, { secret: CANARY_KEY, capabilities: V1 }),
      ),
    ).toBe('bad-value')
  })

  test('never writes no level even if one is given; auto passes its level through', () => {
    const out = compiled(
      wireProfile({
        models: [
          model({ effort: { send: 'never', level: 'max' } }),
          model({
            id: 'fast',
            role: 'fast',
            tiers: ['haiku'],
            capabilities: { mode: 'family' },
            effort: { send: 'auto', level: 'medium' },
          }),
        ],
      }),
    ).patch.modelSettings
    expect(out.default).toBeUndefined()
    expect(out.haiku?.effort).toBe('medium')
  })

  test('effortLock → CLAUDE_CODE_EFFORT_LEVEL, clamped to a level every model accepts', () => {
    const env = compiled(
      wireProfile({
        effortLock: 'max',
        models: [
          model({
            effort: {
              send: 'always',
              levels: ['low', 'high', 'max'],
              level: 'max',
            },
          }),
          model({
            id: 'fast',
            role: 'fast',
            tiers: ['haiku'],
            effort: {
              send: 'always',
              levels: ['low', 'medium', 'high'],
              level: 'high',
            },
          }),
        ],
      }),
    ).patch.env
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high')
  })

  test('ALWAYS_ENABLE only when every model is always (fleet shorthand)', () => {
    const mixed = compiled(
      wireProfile({
        models: [
          model(),
          model({
            id: 'fast',
            role: 'fast',
            tiers: ['haiku'],
            effort: { send: 'never' },
          }),
        ],
      }),
    ).patch.env
    expect(mixed.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBeUndefined()
  })

  test('capabilityList: the six names in fixed order, only the true ones', () => {
    expect(
      capabilityList(
        model({ effort: { send: 'always', levels: ['low', 'max'] } }),
      ),
    ).toBe('effort,max_effort,thinking')
    expect(
      capabilityList(
        model({ effort: { send: 'auto' }, capabilities: { mode: 'family' } }),
      ),
    ).toBeUndefined()
  })
})

describe('keys', () => {
  test('a v1 node refuses more than one key', () => {
    const profile = wireProfile({
      auth: {
        scheme: 'bearer',
        keys: [
          { id: 'k1', value: CANARY_KEY },
          { id: 'k2', value: CANARY_KEY },
        ],
      },
    })
    expect(
      refused(
        compileProfile(profile, { secret: CANARY_KEY, capabilities: V1 }),
      ),
    ).toBe('unsupported-multi-key')
  })

  test('the delivered key id is the primary key', () => {
    expect(compiled(wireProfile()).keyId).toBe('k1')
  })
})

describe('single-key compile is locked (multi-key schema, P18.18)', () => {
  // Exactly what a one-key profile compiled to before the key list existed.
  // Deleted keys are absent from the JSON (undefined), and checked separately.
  const GOLDEN =
    '{"patch":{"modelType":"anthropic","env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example/anthropic","ANTHROPIC_AUTH_TOKEN":"sk-test-canary-7Hq2Zp9LmV4xR8sT1wYc","ANTHROPIC_MODEL":"vendor-model-pro","ANTHROPIC_DEFAULT_HAIKU_MODEL":"vendor-model-flash","ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES":"effort,max_effort,thinking","ANTHROPIC_DEFAULT_SONNET_MODEL":"vendor-model-pro","ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES":"effort,max_effort,thinking","ANTHROPIC_DEFAULT_OPUS_MODEL":"vendor-model-pro","ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES":"effort,max_effort,thinking","ANTHROPIC_DEFAULT_FABLE_MODEL":"vendor-model-pro","ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES":"effort,max_effort,thinking","CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS":"1","CLAUDE_CODE_ALWAYS_ENABLE_EFFORT":"1"},"modelSettings":{"default":{"effort":"max"},"haiku":{"effort":"max"},"sonnet":{"effort":"max"},"opus":{"effort":"max"},"fable":{"effort":"max"}}},"route":"direct","effectiveLane":"anthropic","keyId":"k1","secretEnvKey":"ANTHROPIC_AUTH_TOKEN","compat":{"CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS":"1","CLAUDE_CODE_ALWAYS_ENABLE_EFFORT":"1"}}'

  function deletedKeys(profile: WireProfile): string[] {
    return Object.entries(compiled(profile).patch.env)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key)
      .sort()
  }

  test('a one-key profile compiles to the locked bytes', () => {
    expect(JSON.stringify(compiled(wireProfile()))).toBe(GOLDEN)
  })

  test('every other managed key is deleted, the same set as before', () => {
    const written = new Set(Object.keys(JSON.parse(GOLDEN).patch.env))
    const expected = [...ALL_PROFILE_ENV_KEYS]
      .filter(key => !written.has(key))
      .sort()
    expect(deletedKeys(wireProfile())).toEqual(expected)
  })

  test('priority and keySelection on the one key change nothing', () => {
    const variant = wireProfile({
      keySelection: 'least_used',
      auth: {
        scheme: 'bearer',
        keys: [{ id: 'k1', value: CANARY_KEY, priority: 9 }],
      },
    })
    expect(JSON.stringify(compiled(variant))).toBe(GOLDEN)
    expect(deletedKeys(variant)).toEqual(deletedKeys(wireProfile()))
  })
})
