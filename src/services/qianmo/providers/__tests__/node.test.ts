// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secretFingerprint } from '@qianmo/providers'
import {
  type FsOperations,
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../../../utils/filesystem/fsOperations.js'
import { updateSettingsForSource } from '../../../../utils/settings/settings.js'
import { resetSettingsCache } from '../../../../utils/settings/settingsCache.js'
import {
  commitPendingProviderConfig,
  currentManagedHash,
  hasPendingProviderConfig,
  readProviderState,
  recordProviderGeneration,
  stageProviderApply,
} from '../node.js'
import { providerPaths } from '../store.js'
import { applyRequest, CANARY_KEY, CANARY_KEY_2, model } from './helpers.js'

let root: string
let config: string
let previousConfigDir: string | undefined
let previousUmask: number

const mode = (path: string) => statSync(path).mode & 0o777
const settingsFile = () => join(config, 'settings.json')
const readSettings = () =>
  JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>
const envOf = (settings: Record<string, unknown>) =>
  settings.env as Record<string, string>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-provider-node-'))
  config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  // `CLAUDE_CONFIG_DIR`, not `OCC_CONFIG_DIR`: tests/preload.ts deletes the
  // latter, and occConfigDir() memoizes on both.
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  // A typical server umask, so "0600 because of umask 077" is really tested.
  previousUmask = process.umask(0o022)
  resetSettingsCache()
})

afterEach(() => {
  setOriginalFsImplementation()
  process.umask(previousUmask)
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  resetSettingsCache()
  rmSync(root, { recursive: true, force: true })
})

/** A node somebody already uses: a user env key and an unrelated setting. */
function seedUserSettings(extra: Record<string, unknown> = {}): string {
  const content = `${JSON.stringify(
    {
      permissions: { allow: ['Bash(ls:*)'] },
      env: { MY_TOOL_FLAG: 'on', OPENAI_BASE_URL: 'https://old.example/v1' },
      ...extra,
    },
    null,
    2,
  )}\n`
  writeFileSync(settingsFile(), content, { mode: 0o644 })
  return content
}

function stageOk(request = applyRequest()) {
  const result = stageProviderApply(request, {
    node: 'beta-1',
    now: new Date('2026-10-03T08:00:00Z'),
  })
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result
}

function committed() {
  const result = commitPendingProviderConfig({
    now: new Date('2026-10-03T08:00:05Z'),
  })
  if (result.status !== 'committed') throw new Error(JSON.stringify(result))
  return result
}

type Rename = { path: string; mode: number; umask: number }

/**
 * Record, for every file renamed into place, its mode and the process umask
 * at that instant.
 *
 * The base settings writer creates its tmp file with plain `fs.writeFileSync`
 * (no seam) and chmods it to the target's mode just before renaming, so the
 * mode seen here is the post-chmod one. What decides whether the key ever sat
 * in a wider file is the umask during that synchronous write — the same umask
 * that is in effect at the rename, which the seam does see.
 */
function watchRenames(): Rename[] {
  const seen: Rename[] = []
  const real = getFsImplementation()
  const watched: FsOperations = {
    ...real,
    renameSync(oldPath: string, newPath: string) {
      const umask = process.umask(0)
      process.umask(umask)
      seen.push({ path: newPath, mode: statSync(oldPath).mode & 0o777, umask })
      real.renameSync(oldPath, newPath)
    },
  }
  setFsImplementation(watched)
  return seen
}

describe('stage: validates and writes an intent, never settings.json', () => {
  test('pending.json is 0600 in a 0700 directory and settings.json is untouched', () => {
    const before = seedUserSettings()
    const result = stageOk()
    expect(result.pending).toBe(true)
    expect(mode(providerPaths.pending())).toBe(0o600)
    expect(mode(join(config, 'qianmo', 'provider'))).toBe(0o700)
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before)
    expect(hasPendingProviderConfig()).toBe(true)
  })

  test('dryRun reports changed key names and writes nothing', () => {
    seedUserSettings()
    const result = stageProviderApply(applyRequest({ dryRun: true }), {
      node: 'beta-1',
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.dryRun).toBe(true)
    expect(result.diffKeys).toContain('env.ANTHROPIC_AUTH_TOKEN')
    expect(result.diffKeys).toContain('env.OPENAI_BASE_URL')
    expect(existsSync(providerPaths.pending())).toBe(false)
    expect(JSON.stringify(result)).not.toContain(CANARY_KEY)
  })

  test('PATH, LD_PRELOAD and CLAUDE_CODE_USE_* in a request are refused before anything is written', () => {
    for (const key of ['PATH', 'LD_PRELOAD', 'CLAUDE_CODE_USE_OPENAI']) {
      const result = stageProviderApply(
        applyRequest({ profile: { compat: { [key]: '1' } } }),
        { node: 'beta-1' },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('unknown-key')
    }
    expect(existsSync(join(config, 'qianmo'))).toBe(false)
  })

  test('the forced-command node name must match', () => {
    const result = stageProviderApply(applyRequest(), { node: 'beta-2' })
    expect(result.ok ? 'ok' : result.code).toBe('node-mismatch')
  })

  test('more than one key on a v1 node: unsupported-multi-key', () => {
    const result = stageProviderApply(
      applyRequest({
        profile: {
          auth: {
            scheme: 'bearer',
            keys: [
              { id: 'k1', value: CANARY_KEY },
              { id: 'k2', value: CANARY_KEY_2 },
            ],
          },
        },
      }),
      { node: 'beta-1' },
    )
    expect(result.ok ? 'ok' : result.code).toBe('unsupported-multi-key')
  })

  test('a held lock is busy', () => {
    mkdirSync(join(config, 'qianmo', 'provider'), {
      recursive: true,
      mode: 0o700,
    })
    writeFileSync(
      providerPaths.lock(),
      JSON.stringify({ pid: process.pid, at: 'x', nonce: 'other' }),
    )
    const result = stageProviderApply(applyRequest(), { node: 'beta-1' })
    expect(result.ok ? 'ok' : result.code).toBe('busy')
  })

  test('the same requestId twice is answered from the first', () => {
    const request = applyRequest()
    stageOk(request)
    expect(stageOk(request).duplicate).toBe('pending')
    committed()
    expect(stageOk(request).duplicate).toBe('applied')
  })
})

describe('commit: the only writer of settings.json', () => {
  test('writes the managed keys, keeps everything else, files 0600', () => {
    seedUserSettings()
    stageOk()
    const result = committed()
    expect(result.sessions).toBe('reset')
    const settings = readSettings()
    expect(mode(settingsFile())).toBe(0o600)
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] })
    expect(envOf(settings).MY_TOOL_FLAG).toBe('on')
    expect(envOf(settings).OPENAI_BASE_URL).toBeUndefined()
    expect(envOf(settings).ANTHROPIC_AUTH_TOKEN).toBe(CANARY_KEY)
    expect(settings.modelType).toBe('anthropic')
    expect(existsSync(providerPaths.pending())).toBe(false)
    expect(mode(providerPaths.state())).toBe(0o600)
    const state = readProviderState()
    expect(state.managed).toBe(true)
    expect(state.applied?.profileId).toBe('vendor-paygo')
    expect(state.appliedHash).toBe(state.onDiskHash)
    expect(state.pending).toBeNull()
  })

  test('nothing pending → none; no settings.json at all → created 0600', () => {
    expect(commitPendingProviderConfig().status).toBe('none')
    stageOk()
    committed()
    expect(mode(settingsFile())).toBe(0o600)
  })

  test('every tmp file is 0600 when it is renamed into place, and settings.json was written under umask 077', () => {
    seedUserSettings()
    const renames = watchRenames()
    stageOk()
    committed()
    const settingsWrites = renames.filter(
      entry => entry.path === settingsFile(),
    )
    expect(settingsWrites.length).toBe(1)
    expect(settingsWrites[0]?.umask).toBe(0o077)
    expect(renames.some(entry => entry.path === providerPaths.pending())).toBe(
      true,
    )
    expect(renames.some(entry => entry.path === providerPaths.state())).toBe(
      true,
    )
    for (const entry of renames) {
      expect({ path: entry.path, mode: entry.mode }).toEqual({
        path: entry.path,
        mode: 0o600,
      })
    }
    // The narrowing is scoped to the write.
    expect(process.umask(0o022)).toBe(0o022)
  })

  test('positive control: the base writer alone writes its tmp under the outer umask', () => {
    // Without the commit's umask the tmp file would be created 0644 and only
    // chmodded to the target's 0600 right before the rename: the mode at the
    // rename looks fine, the umask shows the window.
    writeFileSync(settingsFile(), '{}\n', { mode: 0o600 })
    const renames = watchRenames()
    updateSettingsForSource('userSettings', { env: { MY_TOOL_FLAG: 'x' } })
    const write = renames.find(entry => entry.path === settingsFile())
    expect(write?.mode).toBe(0o600)
    expect(write?.umask).toBe(0o022)
  })

  test('positive control: a 0644 settings.json is narrowed before the base writer copies its mode', () => {
    writeFileSync(settingsFile(), '{}\n', { mode: 0o644 })
    const renames = watchRenames()
    updateSettingsForSource('userSettings', { env: { MY_TOOL_FLAG: 'x' } })
    expect(renames.find(entry => entry.path === settingsFile())?.mode).toBe(
      0o644,
    )
    seedUserSettings()
    stageOk()
    committed()
    expect(
      renames.filter(entry => entry.path === settingsFile()).at(-1)?.mode,
    ).toBe(0o600)
  })

  test('a config root that is not 0700 refuses the commit and keeps the intent', () => {
    const before = seedUserSettings()
    stageOk()
    chmodSync(config, 0o755)
    const result = commitPendingProviderConfig()
    expect(result.status).toBe('refused')
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before)
    expect(hasPendingProviderConfig()).toBe(true)
    chmodSync(config, 0o700)
    expect(commitPendingProviderConfig().status).toBe('committed')
  })

  test('the first-write backup is written once and never overwritten', () => {
    const original = seedUserSettings()
    stageOk()
    expect(readFileSync(providerPaths.firstWrite(), 'utf8')).toBe(original)
    expect(mode(providerPaths.firstWrite())).toBe(0o600)
    committed()
    const state = readProviderState()
    stageOk(
      applyRequest({
        expect: { ownedHash: state.appliedHash },
        profile: { revision: 4 },
      }),
    )
    committed()
    expect(readFileSync(providerPaths.firstWrite(), 'utf8')).toBe(original)
  })

  test('a staged-but-uncommitted first apply followed by a forced one keeps the first backup', () => {
    const original = seedUserSettings()
    stageOk()
    writeFileSync(settingsFile(), '{"env":{"MY_TOOL_FLAG":"changed"}}\n')
    stageOk(applyRequest({ force: true }))
    expect(readFileSync(providerPaths.firstWrite(), 'utf8')).toBe(original)
  })

  test('a managed key changed between stage and commit: abandon, record conflict by key name', () => {
    seedUserSettings()
    stageOk()
    committed()
    const appliedHash = readProviderState().appliedHash
    stageOk(
      applyRequest({
        expect: { ownedHash: appliedHash },
        profile: { revision: 4 },
      }),
    )
    const settings = readSettings()
    envOf(settings).ANTHROPIC_BASE_URL = 'https://hand-edited.example'
    writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`)
    const result = commitPendingProviderConfig()
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict')
      expect(result.diffKeys).toEqual(['env.ANTHROPIC_BASE_URL'])
    expect(envOf(readSettings()).ANTHROPIC_BASE_URL).toBe(
      'https://hand-edited.example',
    )
    expect(hasPendingProviderConfig()).toBe(false)
    const state = readProviderState()
    expect(state.lastResult?.code).toBe('conflict')
    expect(JSON.stringify(state)).not.toContain('hand-edited')
  })
})

describe('expect.ownedHash (§2.3 step 4, §2.4 local-edit)', () => {
  test('null on a managed node, a stale hash, or a local edit → conflict; force overrides', () => {
    stageOk()
    committed()
    const fresh = stageProviderApply(applyRequest(), { node: 'beta-1' })
    expect(fresh.ok ? 'ok' : fresh.code).toBe('conflict')
    const stale = stageProviderApply(
      applyRequest({ expect: { ownedHash: `sha256:${'0'.repeat(64)}` } }),
      { node: 'beta-1' },
    )
    expect(stale.ok ? 'ok' : stale.code).toBe('conflict')

    const appliedHash = readProviderState().appliedHash
    const settings = readSettings()
    envOf(settings).ANTHROPIC_MODEL = 'hand-picked'
    writeFileSync(settingsFile(), JSON.stringify(settings))
    const local = stageProviderApply(
      applyRequest({ expect: { ownedHash: appliedHash } }),
      { node: 'beta-1' },
    )
    expect(local.ok ? 'ok' : local.code).toBe('conflict')
    if (!local.ok) expect(local.diffKeys).toEqual(['env.ANTHROPIC_MODEL'])
    expect(
      stageProviderApply(applyRequest({ force: true }), { node: 'beta-1' }).ok,
    ).toBe(true)
  })

  test('a hash on a node that was never managed → conflict', () => {
    const result = stageProviderApply(
      applyRequest({ expect: { ownedHash: `sha256:${'a'.repeat(64)}` } }),
      { node: 'beta-1' },
    )
    expect(result.ok ? 'ok' : result.code).toBe('conflict')
  })
})

describe('keys and compat ownership', () => {
  test('keep reuses the key on the node by fingerprint; a wrong fingerprint is secret-mismatch', () => {
    stageOk()
    committed()
    const appliedHash = readProviderState().appliedHash
    const keep = applyRequest({
      expect: { ownedHash: appliedHash },
      profile: {
        revision: 5,
        auth: {
          scheme: 'bearer',
          keys: [{ id: 'k1', keep: secretFingerprint(CANARY_KEY) }],
        },
      },
    })
    stageOk(keep)
    committed()
    expect(envOf(readSettings()).ANTHROPIC_AUTH_TOKEN).toBe(CANARY_KEY)

    const wrong = stageProviderApply(
      applyRequest({
        expect: { ownedHash: readProviderState().appliedHash },
        profile: {
          auth: {
            scheme: 'bearer',
            keys: [{ id: 'k1', keep: secretFingerprint(CANARY_KEY_2) }],
          },
        },
      }),
      { node: 'beta-1' },
    )
    expect(wrong.ok ? 'ok' : wrong.code).toBe('secret-mismatch')
  })

  test('a compat key we wrote is removed when the next profile drops it, unless someone changed it', () => {
    stageOk(applyRequest({ profile: { compat: { API_TIMEOUT_MS: '600000' } } }))
    committed()
    stageOk(
      applyRequest({
        expect: { ownedHash: readProviderState().appliedHash },
        profile: { compat: {} },
      }),
    )
    committed()
    expect(envOf(readSettings()).API_TIMEOUT_MS).toBeUndefined()

    stageOk(
      applyRequest({
        expect: { ownedHash: readProviderState().appliedHash },
        profile: { compat: { API_TIMEOUT_MS: '600000' } },
      }),
    )
    committed()
    const settings = readSettings()
    envOf(settings).API_TIMEOUT_MS = '900000'
    writeFileSync(settingsFile(), JSON.stringify(settings))
    stageOk(applyRequest({ force: true, profile: { compat: {} } }))
    committed()
    expect(envOf(readSettings()).API_TIMEOUT_MS).toBe('900000')
  })
})

describe('crash recovery rolls forward (§2.6 step 5)', () => {
  test('window 1: intent written, settings untouched → a later commit applies it', () => {
    seedUserSettings()
    stageOk()
    // "crash" here = the process simply ended; a fresh call picks it up.
    expect(committed().recovered).toBe(false)
  })

  test('window 2: settings renamed into place, then death before state.json → finished on restart', () => {
    seedUserSettings()
    stageOk()
    const real = getFsImplementation()
    setFsImplementation({
      ...real,
      renameSync(oldPath: string, newPath: string) {
        if (newPath === providerPaths.state())
          throw new Error('simulated crash')
        real.renameSync(oldPath, newPath)
      },
    })
    expect(() => commitPendingProviderConfig()).toThrow('simulated crash')
    setOriginalFsImplementation()
    expect(envOf(readSettings()).ANTHROPIC_AUTH_TOKEN).toBe(CANARY_KEY)
    expect(hasPendingProviderConfig()).toBe(true)
    expect(readProviderState().managed).toBe(false)
    // Leftover tmp files from the crashed write must not linger as key copies.
    const leftovers = readdirSync(join(config, 'qianmo', 'provider')).filter(
      name => name.includes('.tmp-'),
    )
    expect(leftovers).toEqual([])

    const result = committed()
    expect(result.recovered).toBe(true)
    expect(readProviderState().managed).toBe(true)
    expect(readProviderState().appliedHash).toBe(currentManagedHash())
    expect(hasPendingProviderConfig()).toBe(false)
  })

  test('window 3: state.json written, death before pending.json removed → dropped on restart', () => {
    stageOk()
    const pendingCopy = readFileSync(providerPaths.pending(), 'utf8')
    committed()
    writeFileSync(providerPaths.pending(), pendingCopy, { mode: 0o600 })
    const before = readFileSync(settingsFile(), 'utf8')
    const result = committed()
    expect(result.recovered).toBe(true)
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before)
    expect(hasPendingProviderConfig()).toBe(false)
  })

  test('a lock left by a dead process is reclaimed', () => {
    stageOk()
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    expect(dead.status).toBe(0)
    writeFileSync(
      providerPaths.lock(),
      JSON.stringify({ pid: dead.pid, at: 'x', nonce: 'gone' }),
    )
    expect(commitPendingProviderConfig().status).toBe('committed')
  })

  test('an unreadable intent is set aside as pending.bad-*, never committed', () => {
    const before = seedUserSettings()
    stageOk()
    writeFileSync(providerPaths.pending(), '{"v":1,"requestId":', {
      mode: 0o600,
    })
    const result = commitPendingProviderConfig({
      now: new Date('2026-10-03T09:00:00Z'),
    })
    expect(result.status).toBe('bad-pending')
    expect(readFileSync(settingsFile(), 'utf8')).toBe(before)
    expect(hasPendingProviderConfig()).toBe(false)
    const bad = readdirSync(join(config, 'qianmo', 'provider')).filter(name =>
      name.startsWith('pending.bad-'),
    )
    expect(bad.length).toBe(1)
    expect(mode(join(config, 'qianmo', 'provider', bad[0] as string))).toBe(
      0o600,
    )
  })
})

describe('no key material outside settings.json and pending.json', () => {
  test('state, generation, responses and node state carry hashes and names only', () => {
    seedUserSettings()
    const staged = stageOk()
    const done = committed()
    recordProviderGeneration({
      generation: 2,
      env: { OPENAI_API_KEY: CANARY_KEY, PATH: '/usr/bin' },
    })
    const state = readProviderState()
    expect(state.loadedHash).toBe(state.appliedHash)
    expect(state.inheritedProviderKeys).toEqual(['OPENAI_API_KEY'])
    for (const text of [
      readFileSync(providerPaths.state(), 'utf8'),
      readFileSync(providerPaths.generation(), 'utf8'),
      JSON.stringify(staged),
      JSON.stringify(done),
      JSON.stringify(state),
    ]) {
      expect(text).not.toContain(CANARY_KEY)
      expect(text).not.toContain('sk-test-canary')
    }
    expect(mode(providerPaths.generation())).toBe(0o600)
  })
})

describe('single-key delivery is locked byte for byte', () => {
  // The multi-key schema (P18.18) must not change what a one-key profile
  // writes. This is the exact settings.json a fixed single-key profile
  // produces on an empty node; any drift is a behaviour change.
  const GOLDEN = `{
  "modelType": "anthropic",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.vendor.example/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "${CANARY_KEY}",
    "ANTHROPIC_MODEL": "vendor-model-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "vendor-model-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES": "effort,max_effort,thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "vendor-model-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES": "effort,max_effort,thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "vendor-model-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES": "effort,max_effort,thinking",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "vendor-model-pro",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES": "effort,max_effort,thinking",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT": "1"
  },
  "modelSettings": {
    "default": {
      "effort": "max"
    },
    "haiku": {
      "effort": "max"
    },
    "sonnet": {
      "effort": "max"
    },
    "opus": {
      "effort": "max"
    },
    "fable": {
      "effort": "max"
    }
  }
}
`

  test('settings.json bytes for a one-key profile', () => {
    stageOk()
    committed()
    expect(readFileSync(settingsFile(), 'utf8')).toBe(GOLDEN)
  })

  test('priority and keySelection on the one key change nothing', () => {
    stageOk(
      applyRequest({
        profile: {
          keySelection: 'round_robin',
          auth: {
            scheme: 'bearer',
            keys: [{ id: 'main-key', value: CANARY_KEY, priority: 7 }],
          },
        },
      }),
    )
    committed()
    expect(readFileSync(settingsFile(), 'utf8')).toBe(GOLDEN)
  })

  test('model() fixture is what the golden describes', () => {
    expect(model().effort).toEqual({
      send: 'always',
      levels: ['low', 'high', 'max'],
      level: 'max',
    })
  })
})
