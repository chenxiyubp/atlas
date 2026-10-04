// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The generated `bin` entrypoints — and specifically the Qianmo node's, whose
 * identity is pinned in the file rather than inferred from how it was reached.
 *
 * `qm` cannot learn it is `qm` from argv: Bun resolves a symlinked entry before
 * filling `process.argv[1]`, a Windows `.cmd` shim passes the `.js` path, and a
 * bundled-mode child gets a CLI argument in that slot. So `dist/cli-qianmo.js`
 * sets `OCC_IDENTITY` itself, and two details of how it does that are
 * load-bearing in ways that read as style:
 *
 *   - the farm must be pulled in with `await import(...)`, because a static
 *     import is hoisted and would resolve the config root BEFORE the
 *     assignment;
 *   - the assignment must be `??=`, because `OCC_IDENTITY=occ qm …` has to keep
 *     meaning occ.
 *
 * The ordering one is checked by actually running the file against a stub farm,
 * not by reading the text: a future refactor could keep the `await import`
 * spelling and still break the order some other way.
 *
 * Drives `writeEntrypointFiles`, NOT `writeEntrypoints`. The difference is the
 * `Bun.build` of the farm bootstrap, and an in-process `Bun.build` is not
 * hermetic under `bun test`: run alone this file passed, run inside the full
 * suite the bundler read `src/constants/identity.ts`'s bytes while reporting
 * them at `lodash-es/memoize.js`'s path (paths.ts imports both) and every
 * assertion here failed. Bundling the bootstrap is not what this suite is
 * about, so it does not bundle it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  IDENTITY_ENV_VAR,
  NODE_IDENTITY_MODE,
} from '../../src/constants/identity.ts'
import { writeEntrypointFiles } from '../entrypoints.ts'

const VERSION = '9.9.9'

let outdir: string

beforeEach(() => {
  outdir = mkdtempSync(join(tmpdir(), 'qm-entrypoints-'))
})

afterEach(() => {
  rmSync(outdir, { recursive: true, force: true })
})

const read = (name: string): string => readFileSync(join(outdir, name), 'utf8')

/** The three entrypoints plus the bootstrap they hand control to. */
const EXECUTABLES = ['cli-bun.js', 'cli-node.js', 'cli-qianmo.js'] as const

describe('writeEntrypointFiles', () => {
  test('emits all three entrypoints, every one executable', async () => {
    await writeEntrypointFiles(outdir, VERSION)

    for (const name of EXECUTABLES) {
      // 0o755, not "some execute bit": an entrypoint the package manager links
      // into PATH and cannot run is indistinguishable from a failed install.
      expect(statSync(join(outdir, name)).mode & 0o777).toBe(0o755)
    }
  })

  test('both builders emit them from this one source', () => {
    // Not a stylistic preference: a builder with its own copy would ship a
    // bundle whose sessions break on `install -g`, and the two copies would
    // drift silently because only one of them is exercised locally.
    for (const builder of ['../../build.ts', '../post-build.ts']) {
      const source = readFileSync(join(import.meta.dir, builder), 'utf8')
      expect(source).toContain('writeEntrypoints')
    }
  })

  test('the runtimes are what each entrypoint needs', async () => {
    await writeEntrypointFiles(outdir, VERSION)

    // Node is the default runtime, so `occ` is node-shebanged. `qm` is not:
    // `console` and `resident` assert the Bun runtime, so a node-shebang node
    // entry would install cleanly and then refuse to start.
    expect(read('cli-node.js').split('\n')[0]).toBe('#!/usr/bin/env node')
    expect(read('cli-bun.js').split('\n')[0]).toBe('#!/usr/bin/env bun')
    expect(read('cli-qianmo.js').split('\n')[0]).toBe('#!/usr/bin/env bun')
  })
})

describe('cli-qianmo.js pins the identity', () => {
  test('it defaults the env var instead of overwriting it', async () => {
    await writeEntrypointFiles(outdir, VERSION)
    const source = read('cli-qianmo.js')

    expect(source).toContain(
      `process.env.${IDENTITY_ENV_VAR} ??= "${NODE_IDENTITY_MODE}"`,
    )
    // `=` here would make `OCC_IDENTITY=occ qm …` a lie.
    expect(source).not.toContain(`process.env.${IDENTITY_ENV_VAR} =`)
  })

  test('the assignment precedes the farm handoff, and the farm is imported dynamically', async () => {
    await writeEntrypointFiles(outdir, VERSION)
    const source = read('cli-qianmo.js')

    expect(source).toContain("await import('./runtime-farm.js')")
    expect(source).not.toContain('import { enterRuntimeFarm } from')
    expect(source.indexOf(IDENTITY_ENV_VAR)).toBeLessThan(
      source.indexOf('runtime-farm.js'),
    )
  })

  test('the farm really observes the identity when it initialises', async () => {
    await writeEntrypointFiles(outdir, VERSION)
    // Replace the real bootstrap with one that records what the env said at
    // ITS module-init time. Under a hoisted static import that is `undefined`;
    // only the dynamic import makes it the pinned value.
    writeFileSync(
      join(outdir, 'runtime-farm.js'),
      [
        `const atInit = process.env.${IDENTITY_ENV_VAR} ?? null`,
        'export function enterRuntimeFarm() {',
        '  process.stdout.write(JSON.stringify({ atInit }))',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    delete env[IDENTITY_ENV_VAR]

    const result = Bun.spawnSync(
      [process.execPath, 'run', join(outdir, 'cli-qianmo.js')],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )

    expect(result.stderr.toString()).toBe('')
    expect(JSON.parse(result.stdout.toString())).toEqual({
      atInit: NODE_IDENTITY_MODE,
    })
  })

  test('an explicit identity still wins', async () => {
    await writeEntrypointFiles(outdir, VERSION)
    writeFileSync(
      join(outdir, 'runtime-farm.js'),
      [
        `const atInit = process.env.${IDENTITY_ENV_VAR} ?? null`,
        'export function enterRuntimeFarm() {',
        '  process.stdout.write(JSON.stringify({ atInit }))',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    env[IDENTITY_ENV_VAR] = 'occ'

    const result = Bun.spawnSync(
      [process.execPath, 'run', join(outdir, 'cli-qianmo.js')],
      { env, stdout: 'pipe', stderr: 'pipe' },
    )

    expect(JSON.parse(result.stdout.toString())).toEqual({ atInit: 'occ' })
  })
})
