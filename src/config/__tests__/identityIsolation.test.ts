// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P0.3 identity isolation — proves the occ default, the Qianmo node, and (by
 * construction) the official Claude Code can share one machine without touching
 * each other's config, credentials, cache or CLI name.
 *
 * Identity is fixed at module load (src/constants/identity.ts), so this suite
 * observes each identity in a FRESH subprocess (identityProbe.runner.ts) launched with
 * a different `OCC_IDENTITY` and a throwaway HOME. That is the only faithful
 * way to exercise the switch — importing paths.ts in-process would pin whatever
 * identity the test runner booted with.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROBE = join(import.meta.dir, 'identityProbe.runner.ts')

type Report = {
  identity: string
  binName: string
  configDir: string
  globalFile: string
  cacheNamespace: string
  xdgSubdir: string
  projectDirName: string
  resolvedCacheDir: string
  resolvedXdgDataDir: string
  resolvedXdgCacheDir: string
  resolvedXdgStateDir: string
}

type Protection = {
  identity: string
  protectedDirs: string[]
  dangerousDirs: string[]
  dangerousFiles: string[]
}

/** Project-config basename of every product that may share the machine. */
const EVERY_IDENTITY_DIR = ['.occ', '.qianmo', '.claude'] as const

const PROJECT_ROOT = '/proj'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qm-identity-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Run the probe in a fresh process under the given identity and throwaway HOME. */
function runProbe(
  identity: 'occ-default' | 'occ' | 'qianmo',
  args: string[],
): string {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  // Neutralize any explicit config-dir override so the identity's own basename
  // under HOME is what resolves, and start from a known-clean identity signal.
  delete env.OCC_CONFIG_DIR
  delete env.CLAUDE_CONFIG_DIR
  delete env.OCC_IDENTITY
  env.HOME = home
  env.USERPROFILE = home
  if (identity !== 'occ-default') env.OCC_IDENTITY = identity

  const result = Bun.spawnSync([process.execPath, 'run', PROBE, ...args], {
    env,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `probe(${identity} ${args.join(' ')}) exited ${result.exitCode}: ${result.stderr.toString()}`,
    )
  }
  return result.stdout.toString()
}

function report(identity: 'occ-default' | 'occ' | 'qianmo'): Report {
  return JSON.parse(runProbe(identity, ['report'])) as Report
}

function protection(identity: 'occ-default' | 'qianmo'): Protection {
  return JSON.parse(
    runProbe(identity, ['protection', PROJECT_ROOT]),
  ) as Protection
}

describe('three-way identity coexistence', () => {
  test('occ default resolves the occ namespace', () => {
    const r = report('occ-default')
    expect(r.identity).toBe('occ')
    expect(r.binName).toBe('occ')
    expect(r.configDir).toBe(join(home, '.occ'))
    expect(r.globalFile).toBe(join(home, '.occ.json'))
    expect(r.cacheNamespace).toBe('occ')
    expect(r.xdgSubdir).toBe('occ')
    expect(r.projectDirName).toBe('.occ')
  })

  test('OCC_IDENTITY=qianmo resolves the Qianmo node namespace', () => {
    const r = report('qianmo')
    expect(r.identity).toBe('qianmo')
    expect(r.binName).toBe('qm')
    expect(r.configDir).toBe(join(home, '.qianmo'))
    expect(r.globalFile).toBe(join(home, '.qianmo.json'))
    expect(r.cacheNamespace).toBe('qianmo')
    expect(r.xdgSubdir).toBe('qianmo')
    expect(r.projectDirName).toBe('.qianmo')
  })

  test('OCC_IDENTITY=occ is identical to the unset default', () => {
    expect(report('occ')).toEqual(report('occ-default'))
  })

  test('every isolation-bearing value differs between the two identities', () => {
    const occ = report('occ-default')
    const qm = report('qianmo')
    expect(qm.binName).not.toBe(occ.binName)
    expect(qm.configDir).not.toBe(occ.configDir)
    expect(qm.globalFile).not.toBe(occ.globalFile)
    expect(qm.cacheNamespace).not.toBe(occ.cacheNamespace)
    expect(qm.xdgSubdir).not.toBe(occ.xdgSubdir)
    expect(qm.projectDirName).not.toBe(occ.projectDirName)
  })

  /**
   * Namespace strings differing is necessary but not sufficient: what lands on
   * disk is the RESOLVED tree (env-paths cache root, XDG data/cache/state
   * roots). Assert those are prefix-disjoint between identities — neither may
   * contain the other, or a recursive delete/copy of one product's cache would
   * eat the other's — and that each stays inside the throwaway HOME (per-user
   * isolation; env-paths and the XDG helpers both honour $HOME here).
   */
  test('resolved cache and XDG trees are prefix-disjoint and HOME-scoped', () => {
    const occ = report('occ-default')
    const qm = report('qianmo')
    const trees: readonly (keyof Report)[] = [
      'resolvedCacheDir',
      'resolvedXdgDataDir',
      'resolvedXdgCacheDir',
      'resolvedXdgStateDir',
    ]
    for (const key of trees) {
      const a = occ[key]
      const b = qm[key]
      expect(a.startsWith(home)).toBe(true)
      expect(b.startsWith(home)).toBe(true)
      expect(a).not.toBe(b)
      expect(b.startsWith(`${a}/`)).toBe(false)
      expect(a.startsWith(`${b}/`)).toBe(false)
    }
  })
})

/**
 * Coexistence is not symmetric with namespacing: a namespace answers "where do
 * I write", a protection list answers "what must I never touch". The second one
 * has to be the UNION of all three products, in BOTH identities. The regression
 * this guards is real and was shipped: the lists were built from
 * `PROJECT_DIR_NAME` (the active identity) plus the official `.claude`, so a
 * Qianmo node protected `.qianmo` and `.claude` but happily let a sandboxed
 * command rewrite `~/.occ/.credentials.json`, `<proj>/.occ/settings.json` and
 * `~/.occ.json` — and the occ default did the same to a node's `.qianmo`.
 */
describe('write protection covers every identity, in every identity', () => {
  for (const identity of ['occ-default', 'qianmo'] as const) {
    test(`running as ${identity}, all three products stay protected`, () => {
      const { protectedDirs, dangerousDirs, dangerousFiles } =
        protection(identity)

      for (const dirName of EVERY_IDENTITY_DIR) {
        // User-level config root (holds .credentials.json and settings.json).
        expect(protectedDirs).toContain(join(home, dirName))
        // Project-level config root (holds settings.json, hooks, agents).
        expect(protectedDirs).toContain(join(PROJECT_ROOT, dirName))
        // Same two roots, as seen by the auto-edit path segment check.
        expect(dangerousDirs).toContain(dirName)
        // Global state file: mcpServers, project state, OAuth account record.
        expect(dangerousFiles).toContain(`${dirName}.json`)
      }
    })
  }

  test('the protected set does not depend on which identity is running', () => {
    const occ = protection('occ-default')
    const qm = protection('qianmo')
    // Order differs (each identity lists its own config root first), so
    // compare the sets. Membership is what the permission checks consult.
    expect(new Set(qm.protectedDirs)).toEqual(new Set(occ.protectedDirs))
    expect(qm.dangerousDirs).toEqual(occ.dangerousDirs)
    expect(qm.dangerousFiles).toEqual(occ.dangerousFiles)
  })
})

describe('credentials do not cross identities', () => {
  test('a qianmo login is invisible to occ and neither overwrites the other', () => {
    // Qianmo logs in first.
    const qmCredPath = runProbe('qianmo', ['write-cred', 'QIANMO-TOKEN'])
    expect(qmCredPath).toBe(join(home, '.qianmo', '.credentials.json'))

    // occ cannot see qianmo's credential file.
    expect(runProbe('occ-default', ['read-cred'])).toBe('__MISSING__')

    // occ logs in; its write lands in .occ, not .qianmo.
    const occCredPath = runProbe('occ-default', ['write-cred', 'OCC-TOKEN'])
    expect(occCredPath).toBe(join(home, '.occ', '.credentials.json'))

    // Each identity still reads back exactly its own token.
    expect(runProbe('qianmo', ['read-cred'])).toBe('QIANMO-TOKEN')
    expect(runProbe('occ-default', ['read-cred'])).toBe('OCC-TOKEN')
  })
})
