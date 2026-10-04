// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * §11 item 3: which `modelSettings` slot governs the main loop. Answered by
 * running `computeEffectiveProviderState()` — the runtime's own slot and
 * effort functions — in a fresh process against a throwaway config root, with
 * every provider key stripped from the inherited env (as the ACP child's spawn
 * env will be, P18.7).
 *
 * Settings that give each slot a DIFFERENT effort make the answer observable:
 * whichever level comes back names the slot that was read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compiledEffortLevel,
  type EffectiveState,
  presetById,
  type WireProfile,
} from '@qianmo/providers'
import { resetSettingsCache } from '../../../../utils/settings/settingsCache.js'
import {
  commitPendingProviderConfig,
  inheritedProviderKeyNames,
  stageProviderApply,
} from '../node.js'
import { applyRequest, CANARY_KEY, presetProfile } from './helpers.js'

const RUNNER = join(import.meta.dir, 'fixtures', 'effective-state.runner.ts')

let root: string
let config: string
let home: string
let project: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-provider-effective-'))
  config = join(root, 'config')
  home = join(root, 'home')
  project = join(root, 'project')
  for (const dir of [config, home, project]) mkdirSync(dir, { mode: 0o700 })
  chmodSync(config, 0o700)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(
    join(config, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    {
      mode: 0o600,
    },
  )
}

/** The inherited env minus everything that could pick or shape a provider. */
function strippedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of inheritedProviderKeyNames(env)) delete env[key]
  delete env.OCC_CONFIG_DIR
  delete env.OCC_IDENTITY
  env.CLAUDE_CONFIG_DIR = config
  env.HOME = home
  env.USERPROFILE = home
  return env
}

function effective(model?: string): EffectiveState {
  const result = Bun.spawnSync(
    [process.execPath, 'run', RUNNER, ...(model === undefined ? [] : [model])],
    { cwd: project, env: strippedEnv(), stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = result.stdout.toString()
  const line = stdout
    .split('\n')
    .find(text => text.startsWith('QIANMO_EFFECTIVE '))
  if (result.exitCode !== 0 || line === undefined) {
    throw new Error(
      `runner exited ${result.exitCode}: ${result.stderr.toString()}`,
    )
  }
  expect(stdout).not.toContain(CANARY_KEY)
  return JSON.parse(line.slice('QIANMO_EFFECTIVE '.length)) as EffectiveState
}

const ALL_EFFORT_CAPS = 'effort,xhigh_effort,max_effort,thinking'

/** Five slots, five different levels: the answer names the slot it came from. */
const DISTINCT_SLOTS = {
  default: { effort: 'low' },
  opus: { effort: 'medium' },
  sonnet: { effort: 'high' },
  fable: { effort: 'xhigh' },
  haiku: { effort: 'max' },
}

function anthropicLane(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    modelType: 'anthropic',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.vendor.example/anthropic',
      ANTHROPIC_AUTH_TOKEN: CANARY_KEY,
      ANTHROPIC_MODEL: 'vendor-model-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'vendor-model-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'vendor-model-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'vendor-model-pro',
      ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor-model-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
    },
    modelSettings: DISTINCT_SLOTS,
    ...extra,
  }
}

function responsesLane(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    modelType: 'openai',
    env: {
      OPENAI_BASE_URL: 'https://api.vendor.example/v1',
      OPENAI_API_KEY: CANARY_KEY,
      OPENAI_WIRE_API: 'responses',
      OPENAI_MODEL: 'vendor-model-pro',
      OPENAI_DEFAULT_OPUS_MODEL: 'vendor-model-pro',
      OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
      OPENAI_DEFAULT_SONNET_MODEL: 'vendor-model-pro',
      OPENAI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
      OPENAI_DEFAULT_FABLE_MODEL: 'vendor-model-pro',
      OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
      OPENAI_DEFAULT_HAIKU_MODEL: 'vendor-model-flash',
      OPENAI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: ALL_EFFORT_CAPS,
    },
    modelSettings: DISTINCT_SLOTS,
    ...extra,
  }
}

describe('§11 item 3: the slot that governs the main loop', () => {
  test('anthropic lane, fresh session: `default`, even though the model also occupies opus/sonnet/fable', () => {
    writeSettings(anthropicLane())
    const state = effective()
    expect(state.model).toBe('vendor-model-pro')
    expect(state.modelSettingsSlot).toBe('default')
    expect(state.effortOnWire).toBe(true)
    expect(state.effortLevel).toBe('low')
  })

  test('openai-responses lane, fresh session: `default`', () => {
    writeSettings(responsesLane())
    const state = effective()
    expect(state.apiProvider).toBe('openai')
    expect(state.wire).toBe('responses')
    expect(state.modelSettingsSlot).toBe('default')
    expect(state.effortLevel).toBe('low')
  })

  test('the session switches to the fast model: its tier slot (haiku)', () => {
    writeSettings(anthropicLane())
    const state = effective('vendor-model-flash')
    expect(state.modelSettingsSlot).toBe('haiku')
    expect(state.effortLevel).toBe('max')
  })

  test('the session switches back to the main model by id: `default` again', () => {
    writeSettings(responsesLane())
    const state = effective('vendor-model-pro')
    expect(state.modelSettingsSlot).toBe('default')
    expect(state.effortLevel).toBe('low')
  })

  test('anthropic lane: a leftover `settings.model` alias is masked by ANTHROPIC_MODEL', () => {
    writeSettings(anthropicLane({ model: 'opus' }))
    const state = effective()
    expect(state.modelSettingsSlot).toBe('default')
    expect(state.effortLevel).toBe('low')
  })

  test('openai lane: a leftover `settings.model` alias is a selection and picks its own slot', () => {
    // Not managed by the compiler (nor by the base `/provider`): on lanes
    // whose primary key is not ANTHROPIC_MODEL it survives a switch and
    // outranks the profile's main model. Recorded here so it is not a surprise.
    writeSettings(responsesLane({ model: 'opus' }))
    const state = effective()
    expect(state.model).toBe('vendor-model-pro')
    expect(state.modelSettingsSlot).toBe('opus')
    expect(state.effortLevel).toBe('medium')
  })

  test('openai lane: a leftover concrete `settings.model` replaces the main model', () => {
    writeSettings(responsesLane({ model: 'old-provider-model' }))
    const state = effective()
    expect(state.model).toBe('old-provider-model')
  })

  test('an env-wide CLAUDE_CODE_EFFORT_LEVEL (effortLock) outranks every slot', () => {
    const settings = anthropicLane()
    ;(settings.env as Record<string, string>).CLAUDE_CODE_EFFORT_LEVEL = 'high'
    writeSettings(settings)
    expect(effective().effortLevel).toBe('high')
    expect(effective('vendor-model-flash').effortLevel).toBe('high')
  })
})

describe('effortOnWire is the runtime gate, not the profile', () => {
  test('anthropic lane without a capability list: the family default decides', () => {
    const settings = anthropicLane()
    const env = settings.env as Record<string, string>
    for (const key of Object.keys(env)) {
      if (key.endsWith('_SUPPORTED_CAPABILITIES')) delete env[key]
    }
    writeSettings(settings)
    const state = effective()
    expect(state.modelSettingsSlot).toBe('default')
    expect(typeof state.effortOnWire).toBe('boolean')
  })

  test('an explicit list without `effort` keeps it off the wire', () => {
    const settings = anthropicLane()
    const env = settings.env as Record<string, string>
    for (const key of Object.keys(env)) {
      if (key.endsWith('_SUPPORTED_CAPABILITIES')) env[key] = 'thinking'
    }
    writeSettings(settings)
    const state = effective()
    expect(state.effortOnWire).toBe(false)
    expect(state.effortLevel).toBeNull()
  })
})

/** Deliver a profile through the real stage + commit, into `config`. */
function deliver(profile: WireProfile): void {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()
  try {
    const staged = stageProviderApply(
      applyRequest({ profile: profile as unknown as Record<string, unknown> }),
      { node: 'beta-1' },
    )
    if (!staged.ok) throw new Error(`${staged.code}: ${staged.message}`)
    const committed = commitPendingProviderConfig()
    if (committed.status !== 'committed')
      throw new Error(JSON.stringify(committed))
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
  }
}

describe('compiled presets, end to end: what the node reports is what the profile asked for', () => {
  // Explicit-capability presets only: for `auto` the family decides, and the
  // page shows whatever this reports (§3.4 「显示 = 线上」).
  for (const id of [
    'deepseek',
    'kimi',
    'mimo',
    'minimax',
    'stepfun',
    'openai',
  ]) {
    test(id, () => {
      const preset = presetById(id)
      if (preset === undefined) throw new Error(`no preset ${id}`)
      const profile = presetProfile(preset)
      const main = profile.models.find(entry => entry.role === 'main')
      if (main === undefined) throw new Error('no main model')
      deliver(profile)
      const state = effective()
      expect(state.modelSettingsSlot).toBe('default')
      expect(state.wireModel).toBe(main.id)
      expect(state.effortOnWire).toBe(main.effort.send === 'always')
      // Including presets that name no level (stepfun, openai): the compiled
      // default, not the runtime's unclamped family default (`xhigh`).
      expect(state.effortLevel).toBe(
        main.effort.send === 'always'
          ? (compiledEffortLevel(main.effort) ?? null)
          : null,
      )
      if (id === 'deepseek') {
        // §3.3: OPENAI_* in settings, Anthropic wire at runtime.
        expect(state.apiProvider).toBe('firstParty')
        expect(state.wire).toBe('anthropic')
      }
      if (id === 'openai') expect(state.wire).toBe('responses')
    })
  }
})
