// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isNodePublicKey } from '@qianmo/protocol'
import {
  loadOrCreateNodeKeys,
  nodeIdentityPath,
  parseTrustedKey,
} from '../nodeIdentity.js'

let root: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-identity-'))
  // `CLAUDE_CONFIG_DIR`, not `OCC_CONFIG_DIR`: tests/preload.ts deletes the
  // latter, and occConfigDir() memoizes on both.
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

describe('node identity on disk', () => {
  test('first run creates a key pair, later runs read the same one', () => {
    const first = loadOrCreateNodeKeys('node-b')
    expect(isNodePublicKey(first.publicKey)).toBe(true)
    expect(loadOrCreateNodeKeys('node-b')).toEqual(first)
  })

  test('two nodes on one machine get different identities', () => {
    const b = loadOrCreateNodeKeys('node-b')
    const c = loadOrCreateNodeKeys('node-c')
    expect(b.publicKey).not.toBe(c.publicKey)
  })

  test('the private half is not world-readable', () => {
    loadOrCreateNodeKeys('node-b')
    const path = nodeIdentityPath('node-b')
    // The mode is passed at creation rather than chmod-ed after: a window in
    // which a private key is readable is still a window.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  test('the path is derived from the config root, not from $HOME', () => {
    // CLAUDE.md §1.1②: every path comes from `src/config/paths.ts`, and this
    // one in particular must land inside the Qianmo identity's own root rather
    // than in whatever the official CLI uses.
    expect(nodeIdentityPath('node-b').startsWith(join(root, 'config'))).toBe(
      true,
    )
  })

  test('a corrupted file is an error, never a silent new identity', () => {
    const original = loadOrCreateNodeKeys('node-b')
    writeFileSync(nodeIdentityPath('node-b'), '{ not json', { mode: 0o600 })
    expect(() => loadOrCreateNodeKeys('node-b')).toThrow(/refusing to replace/)
    // And nothing was overwritten on the way out.
    expect(readFileSync(nodeIdentityPath('node-b'), 'utf8')).toBe('{ not json')
    expect(original.publicKey).toBeDefined()
  })

  test('a file belonging to another node is not adopted', () => {
    loadOrCreateNodeKeys('node-b')
    const stolen = readFileSync(nodeIdentityPath('node-b'), 'utf8')
    writeFileSync(nodeIdentityPath('node-c'), stolen, { mode: 0o600 })
    expect(() => loadOrCreateNodeKeys('node-c')).toThrow(/another node/)
  })
})

describe('--trust parsing', () => {
  test('accepts <node>=<publicKey>', () => {
    const key = 'A'.repeat(43)
    expect(parseTrustedKey(`node-a=${key}`)).toEqual(['node-a', key])
  })

  test('refuses a missing separator or a key of the wrong shape', () => {
    expect(() => parseTrustedKey('node-a')).toThrow('<node>=<publicKey>')
    expect(() => parseTrustedKey('=key')).toThrow('<node>=<publicKey>')
    expect(() => parseTrustedKey('node-a=nope')).toThrow('valid Ed25519 key')
  })
})
