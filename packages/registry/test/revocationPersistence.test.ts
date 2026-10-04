// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The published revocation list survives a restart, and a stored list that
 * cannot be read back stops the registry instead of disappearing.
 *
 * Before this, only the agent table was persisted: every registry restart
 * dropped the RL, and a node started afterwards read the 404 as "never
 * published" (key-distribution.md §6.4) until the CA operator re-sent it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileRevocationListStore,
  InMemoryRegistry,
  ManualClock,
  RegistryErrorCode,
  createRegistryHandler,
  revocationListStatePathFor,
  type RegistryStore,
} from '../src/index.js'

const FIRST = { payload: 'Zmlyc3Q', signature: 'c2lnLTE' }
const SECOND = { payload: 'c2Vjb25k', signature: 'c2lnLTI' }

let directory: string
let path: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-registry-rl-'))
  path = join(directory, 'registry', 'revocation-list.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function boot(store: RegistryStore = new FileRevocationListStore(path)) {
  return new InMemoryRegistry({
    clock: new ManualClock(1_000_000),
    revocationListStore: store,
  })
}

describe('revocation list persistence', () => {
  test('a published list is served again after a restart', () => {
    expect(boot().publishRevocationList(FIRST)).toBe(true)
    const restarted = boot()
    expect(restarted.revocationList).toEqual(FIRST)

    expect(restarted.publishRevocationList(SECOND)).toBe(true)
    expect(boot().revocationList).toEqual(SECOND)
  })

  test('the file holds exactly the published document, owner-only', () => {
    boot().publishRevocationList(FIRST)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FIRST)
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  test('no file means nothing was ever published — not an error', () => {
    const registry = boot()
    expect(registry.revocationList).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('a malformed body is refused and nothing is written', () => {
    const registry = boot()
    expect(registry.publishRevocationList({ payload: 'a' })).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  test.each([
    ['truncated JSON', '{"payload":"Zmlyc3Q","signa'],
    ['not a signed list', '{"revoked":[]}'],
    ['an empty file', ''],
  ])('a stored file that is %s stops the registry from starting', (_label, content) => {
    mkdirSync(join(directory, 'registry'), { recursive: true })
    writeFileSync(path, content)
    expect(() => boot()).toThrow(/revocation list/)
    // Left in place for the operator: not renamed, not rewritten.
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  test('an unreadable file stops the registry from starting', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    boot().publishRevocationList(FIRST)
    chmodSync(path, 0o000)
    try {
      expect(() => boot()).toThrow(/cannot be read/)
    } finally {
      chmodSync(path, 0o600)
    }
  })

  test('a list that cannot be stored is not published, and the previous one stays', () => {
    const failure = new Error('disk full')
    const seen: unknown[] = []
    let failing = false
    const store: RegistryStore = {
      read: () => null,
      write: () => {
        if (failing) throw failure
      },
    }
    const registry = new InMemoryRegistry({
      clock: new ManualClock(1_000_000),
      revocationListStore: store,
      onPersistError: error => seen.push(error),
    })
    expect(registry.publishRevocationList(FIRST)).toBe(true)

    failing = true
    expect(() => registry.publishRevocationList(SECOND)).toThrow('disk full')
    expect(registry.revocationList).toEqual(FIRST)
    expect(seen).toEqual([failure])
  })

  test('over HTTP that failure is a 500 and GET keeps serving the previous list', async () => {
    let failing = false
    const registry = new InMemoryRegistry({
      clock: new ManualClock(1_000_000),
      revocationListStore: {
        read: () => null,
        write: () => {
          if (failing) throw new Error('read-only filesystem')
        },
      },
    })
    const handle = createRegistryHandler(registry)
    const put = (document: unknown) =>
      handle(
        new Request('http://registry.test/v0/revocation-list', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(document),
        }),
      )

    expect((await put(FIRST)).status).toBe(200)
    failing = true
    const refused = await put(SECOND)
    expect(refused.status).toBe(500)
    expect(await refused.json()).toMatchObject({
      error: { code: RegistryErrorCode.E_STORAGE },
    })
    const served = await handle(
      new Request('http://registry.test/v0/revocation-list'),
    )
    expect(await served.json()).toEqual(FIRST)
  })
})

describe('revocationListStatePathFor', () => {
  test('pairs each agent-table name with a sibling', () => {
    expect(revocationListStatePathFor('/srv/registry/agents.json')).toBe(
      '/srv/registry/revocation-list.json',
    )
    expect(revocationListStatePathFor('/srv/state/registry-agents.json')).toBe(
      '/srv/state/registry-revocation-list.json',
    )
    expect(revocationListStatePathFor('/srv/state/table.json')).toBe(
      '/srv/state/table.json.revocation-list.json',
    )
  })
})
