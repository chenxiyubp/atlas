// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `CLAUDE.md` §1.1② in test form. These assertions only pass if the root is
 * derived from the base helper; a hand-assembled `join(homedir(), '.occ')`
 * would ignore every override below and keep pointing at the developer's real
 * home directory.
 *
 * Nothing here writes a file — the tests compute paths and compare strings.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultMemoryRoot,
  QIANMO_MEMORY_DIRNAME,
  scopeDir,
} from '../src/index.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-memory-paths-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function withEnv(name: string, value: string, run: () => void): void {
  const previous = process.env[name]
  process.env[name] = value
  try {
    run()
  } finally {
    if (previous === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = previous
    }
  }
}

describe('default root derivation', () => {
  test('follows the identity-scoped config root', () => {
    withEnv('OCC_CONFIG_DIR', directory, () => {
      expect(defaultMemoryRoot()).toBe(join(directory, QIANMO_MEMORY_DIRNAME))
    })
  })

  test('follows the remote memory mount when one is configured', () => {
    // A resident node's sandbox can be reset; `getMemoryBaseDir()` is what
    // redirects memory onto the persistent mount, and inheriting that is the
    // reason this package calls it rather than `occConfigPath` directly.
    withEnv('CLAUDE_CODE_REMOTE_MEMORY_DIR', directory, () => {
      expect(defaultMemoryRoot()).toBe(join(directory, QIANMO_MEMORY_DIRNAME))
    })
  })

  test('the three layers land in three directories under that root', () => {
    expect(
      scopeDir('/r', { layer: 'working', projectKey: 'atlas', taskId: 't1' }),
    ).toBe(join('/r', 'working', 'atlas', 't1'))
    expect(scopeDir('/r', { layer: 'project', projectKey: 'atlas' })).toBe(
      join('/r', 'project', 'atlas'),
    )
    expect(scopeDir('/r', { layer: 'baseline', period: '2026-09' })).toBe(
      join('/r', 'baseline', '2026-09'),
    )
  })
})
