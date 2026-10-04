// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONTEXT, sessionKeyOf } from '../src/session-key.js'
import {
  FileResidentSessionStore,
  MemoryResidentSessionStore,
  type ResidentSessionRecord,
} from '../src/session-store.js'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let directory: string
let path: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-sessions-'))
  path = join(directory, 'resident', 'sessions.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function record(
  sessionId: string,
  overrides: Partial<ResidentSessionRecord> = {},
): ResidentSessionRecord {
  return { sessionId, createdAt: 1_000, lastUsedAt: 1_000, ...overrides }
}

function uuid(index: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${index.toString().padStart(12, '0')}`
}

describe('resident session store', () => {
  test('atomically persists context-scoped agent sessions', () => {
    const store = new FileResidentSessionStore(path)
    const key = sessionKeyOf('reviewer', 'ops-42')
    store.set(key, record(SESSION_ID))

    const reopened = new FileResidentSessionStore(path)
    expect(reopened.entries()).toEqual({ [key]: record(SESSION_ID) })
    expect(statSync(join(directory, 'resident')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('fails closed on corrupt or invalid content', () => {
    mkdirSync(join(directory, 'resident'), { recursive: true })
    writeFileSync(path, 'not-json')
    expect(() => new FileResidentSessionStore(path)).toThrow('corrupt')

    writeFileSync(path, JSON.stringify({ '../escape': SESSION_ID }))
    expect(() => new FileResidentSessionStore(path)).toThrow('invalid')

    writeFileSync(
      path,
      JSON.stringify({ [sessionKeyOf('reviewer')]: { sessionId: SESSION_ID } }),
    )
    expect(() => new FileResidentSessionStore(path)).toThrow('invalid')

    // One format or the other. A mixture is corruption, because writes are
    // atomic and a half-migrated file is not a state this store produces.
    writeFileSync(
      path,
      JSON.stringify({
        reviewer: SESSION_ID,
        [sessionKeyOf('planner')]: record(OTHER_SESSION_ID),
      }),
    )
    expect(() => new FileResidentSessionStore(path)).toThrow('invalid')
  })

  test('reads the legacy one-session-per-agent file and lifts it onto the default context', () => {
    mkdirSync(join(directory, 'resident'), { recursive: true })
    writeFileSync(
      path,
      `${JSON.stringify({ reviewer: SESSION_ID, planner: OTHER_SESSION_ID })}\n`,
    )

    const store = new FileResidentSessionStore(path, { now: () => 7_000 })

    // Upgrading must not lose a single session: both agents are still here,
    // and both land exactly where a request with no contextId resolves to.
    expect(store.get(sessionKeyOf('reviewer', DEFAULT_CONTEXT))).toEqual({
      sessionId: SESSION_ID,
      createdAt: 7_000,
      lastUsedAt: 7_000,
    })
    expect(store.get(sessionKeyOf('planner'))?.sessionId).toBe(OTHER_SESSION_ID)
    expect(store.get(sessionKeyOf('reviewer'))?.sessionId).toBe(SESSION_ID)
    expect(Object.keys(store.entries())).toHaveLength(2)
  })

  test('deleting a key rewrites the file without it', () => {
    const store = new FileResidentSessionStore(path)
    const kept = sessionKeyOf('reviewer', 'kept')
    const dropped = sessionKeyOf('reviewer', 'dropped')
    store.set(kept, record(SESSION_ID))
    store.set(dropped, record(OTHER_SESSION_ID))

    store.delete(dropped)

    expect(Object.keys(new FileResidentSessionStore(path).entries())).toEqual([
      kept,
    ])
  })

  test('refuses to grow past the ceiling instead of dropping an entry to fit', () => {
    const store = new FileResidentSessionStore(path, { maxEntries: 2 })
    const first = sessionKeyOf('reviewer', 'one')
    const second = sessionKeyOf('reviewer', 'two')
    store.set(first, record(uuid(1)))
    store.set(second, record(uuid(2)))

    // G-6: a silent truncation here would strand a live ACP session with
    // nothing pointing at it, and nothing would ever report it.
    expect(() =>
      store.set(sessionKeyOf('reviewer', 'three'), record(uuid(3))),
    ).toThrow('resident session store is full')
    expect(new FileResidentSessionStore(path).entries()).toEqual({
      [first]: record(uuid(1)),
      [second]: record(uuid(2)),
    })

    // Overwriting an existing key is not growth, so the ceiling does not block it.
    store.set(first, record(uuid(4)))
    expect(store.get(first)?.sessionId).toBe(uuid(4))

    // And once room is made, the write that was refused goes through.
    store.delete(second)
    store.set(sessionKeyOf('reviewer', 'three'), record(uuid(3)))
    expect(Object.keys(store.entries())).toHaveLength(2)
  })

  test('the memory store enforces the same key, record and ceiling rules', () => {
    const store = new MemoryResidentSessionStore({ maxEntries: 1 })
    expect(() => store.set('reviewer', record(SESSION_ID))).toThrow(
      'session key is invalid',
    )
    expect(() =>
      store.set(sessionKeyOf('reviewer'), {
        sessionId: 'not-a-uuid',
        createdAt: 0,
        lastUsedAt: 0,
      }),
    ).toThrow('session record is invalid')

    store.set(sessionKeyOf('reviewer'), record(SESSION_ID))
    expect(() =>
      store.set(sessionKeyOf('reviewer', 'other'), record(OTHER_SESSION_ID)),
    ).toThrow('resident session store is full')
  })
})
