// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `invokedBinName()` — the display name, and only the display name.
 *
 * package.json installs four bin names (`occ` / `occ-bun` / `open-claude-code`
 * / `qm`), so the command a user typed and the identity the process runs as are
 * two different facts. Usage lines and "run `… --help`" hints want the first;
 * everything else — process title, socket prefix, config root — wants the
 * second, which stays `BIN_NAME`. This suite pins that split, and pins that
 * `BIN_NAME` itself did not start following argv.
 *
 * Observed out of process, because both inputs are read at module load:
 * `OCC_IDENTITY` via the child's env, and the invoked name via generated shim
 * FILES whose basenames are the names under test. Real files rather than
 * symlinks on purpose — Bun resolves a symlinked entry before it fills
 * `argv[1]`, so a symlink named `qm` would arrive as the probe's own path and
 * prove nothing. (That same fact is why identity is NOT derived from argv; see
 * scripts/entrypoints.ts.)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROBE = join(
  import.meta.dir,
  '..',
  '..',
  'config',
  '__tests__',
  'identityProbe.runner.ts',
)
const BRAND_SOURCE = join(import.meta.dir, '..', 'brand.ts')

type Report = {
  identity: string
  binName: string
  invokedBinName: string
  configDir: string
}

let workspace: string

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'qm-invoked-'))
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function baseEnv(identity?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // An inherited OCC_IDENTITY or config-dir override would decide every case
  // before the shim name is even read.
  delete env.OCC_CONFIG_DIR
  delete env.CLAUDE_CONFIG_DIR
  delete env.OCC_IDENTITY
  if (identity !== undefined) env.OCC_IDENTITY = identity
  // A throwaway HOME per case, so a probe that writes lands nowhere real.
  const home = mkdtempSync(join(workspace, 'home-'))
  env.HOME = home
  env.USERPROFILE = home
  return env
}

/**
 * Run the probe from a file named exactly `binName`, and parse its report.
 *
 * `bun run <file>` reports that file's path as `argv[1]`, so an extensionless
 * file called `qm` is indistinguishable — to brand.ts — from the `qm` npm
 * installs.
 */
function reportAs(binName: string, identity?: string): Report {
  const dir = mkdtempSync(join(workspace, 'bin-'))
  const shim = join(dir, binName)
  writeFileSync(shim, `await import(${JSON.stringify(PROBE)})\n`, 'utf8')
  const result = Bun.spawnSync([process.execPath, 'run', shim], {
    env: baseEnv(identity),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `${binName} exited ${result.exitCode}: ${result.stderr.toString()}`,
    )
  }
  return JSON.parse(result.stdout.toString()) as Report
}

describe('invokedBinName() echoes what was typed', () => {
  test('every installed bin name comes back verbatim', () => {
    for (const name of ['occ', 'occ-bun', 'open-claude-code', 'qm']) {
      expect(reportAs(name).invokedBinName).toBe(name)
    }
  })

  test('anything not installed falls back to BIN_NAME', () => {
    // The realistic ones: the generated entrypoints reached by path (which is
    // how `qm` itself arrives, since Bun realpaths its argv[1]), a dev
    // checkout, and a near-miss someone renamed.
    for (const name of [
      'cli-qianmo.js',
      'cli-node.js',
      'dev.ts',
      'qmm',
      'QM',
    ]) {
      const occ = reportAs(name)
      expect(occ.invokedBinName).toBe('occ')
      expect(occ.invokedBinName).toBe(occ.binName)

      const node = reportAs(name, 'qianmo')
      expect(node.invokedBinName).toBe('qm')
      expect(node.invokedBinName).toBe(node.binName)
    }
  })
})

describe('the invoked name is display only, never identity', () => {
  test('a shim called `qm` does not move the config root', () => {
    // The whole reason argv-based identity was withdrawn: this must resolve
    // occ, because nothing but OCC_IDENTITY (or the pinned entrypoint that
    // sets it) may select an identity.
    const report = reportAs('qm')

    expect(report.identity).toBe('occ')
    expect(report.configDir).toContain('.occ')
    expect(report.configDir).not.toContain('.qianmo')
    // …while still printing the name the user typed.
    expect(report.invokedBinName).toBe('qm')
  })

  test('OCC_IDENTITY alone decides, whichever name was typed', () => {
    for (const name of ['occ', 'occ-bun', 'open-claude-code', 'qm']) {
      expect(reportAs(name, 'qianmo').configDir).toContain('.qianmo')
      expect(reportAs(name, 'occ').configDir).toContain('.occ')
    }
  })
})

describe('BIN_NAME still answers "what am I"', () => {
  test('it follows the identity, never the invoked name', () => {
    // The pair that would break a socket prefix if BIN_NAME tracked argv:
    // typed as `qm` but running as occ, and the mirror image.
    const occByQm = reportAs('qm', 'occ')
    expect(occByQm.binName).toBe('occ')
    expect(occByQm.invokedBinName).toBe('qm')

    const nodeByOcc = reportAs('occ', 'qianmo')
    expect(nodeByOcc.binName).toBe('qm')
    expect(nodeByOcc.invokedBinName).toBe('occ')
  })

  test('its definition is unchanged', () => {
    // A source pin, because the failure this guards is a silent one-word edit
    // that no behavioural test in this file would notice.
    expect(readFileSync(BRAND_SOURCE, 'utf8')).toContain(
      "export const BIN_NAME = byIdentity({ occ: 'occ', qianmo: 'qm' })",
    )
  })
})
