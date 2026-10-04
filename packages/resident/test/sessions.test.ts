// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAdmissionLedger } from '../src/ledger.js'
import type { ResidentSessionGcPolicy } from '../src/session-gc.js'
import { DEFAULT_CONTEXT, sessionKeyOf } from '../src/session-key.js'
import { MemoryResidentSessionStore } from '../src/session-store.js'
import {
  pendingSessionIds,
  ResidentSessionManager,
  type ResidentAgentSession,
  type ResidentSessionManagerOptions,
} from '../src/sessions.js'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const REVIEWER: ResidentAgentSession = { agent: 'reviewer', cwd: '/workspace' }

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-manager-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function uuid(index: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${index.toString().padStart(12, '0')}`
}

class RecordingConnection {
  readonly opened: string[] = []
  readonly resumed: (ResidentAgentSession & { sessionId: string })[] = []
  initializes = 0
  #next = 0

  async initialize(): Promise<void> {
    this.initializes++
  }

  async newSession(input: ResidentAgentSession): Promise<string> {
    this.#next++
    this.opened.push(input.agent)
    return uuid(this.#next)
  }

  async resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void> {
    this.resumed.push(input)
  }
}

function manager(
  connection: RecordingConnection,
  extra: Partial<ResidentSessionManagerOptions> = {},
): ResidentSessionManager {
  return new ResidentSessionManager({
    connection,
    store: new MemoryResidentSessionStore(),
    agents: [REVIEWER],
    ...extra,
  })
}

describe('resident session manager', () => {
  test('creates and durably maps a first default-context session', async () => {
    const store = new MemoryResidentSessionStore()
    const connection = new RecordingConnection()

    await manager(connection, { store }).start()

    expect(
      store.get(sessionKeyOf('reviewer', DEFAULT_CONTEXT))?.sessionId,
    ).toBe(uuid(1))
    expect(connection.resumed).toEqual([])
  })

  test('resumes a stored session after ACP process restart', async () => {
    const store = new MemoryResidentSessionStore()
    store.set(sessionKeyOf('reviewer'), {
      sessionId: SESSION_ID,
      createdAt: 1,
      lastUsedAt: 1,
    })
    const connection = new RecordingConnection()

    const sessions = manager(connection, { store })
    await sessions.start()

    expect(connection.resumed).toEqual([{ ...REVIEWER, sessionId: SESSION_ID }])
    expect(connection.opened).toEqual([])
    expect(sessions.sessionOf('reviewer')).toBe(SESSION_ID)
  })

  test('rejects duplicate agent mappings before opening ACP', () => {
    expect(() =>
      manager(new RecordingConnection(), {
        agents: [REVIEWER, { agent: 'reviewer', cwd: '/two' }],
      }),
    ).toThrow('duplicate resident agent')
  })

  test('two contexts of one agent get two sessions, created on first sight', async () => {
    const connection = new RecordingConnection()
    const sessions = manager(connection)
    await sessions.start()

    // start() opens exactly one session per agent; everything else is lazy.
    expect(connection.opened).toEqual(['reviewer'])

    const alice = await sessions.sessionFor('reviewer', 'alice')
    const bob = await sessions.sessionFor('reviewer', 'bob')

    expect(alice).not.toBe(bob)
    expect(alice).not.toBe(sessions.sessionOf('reviewer'))
    expect(connection.opened).toEqual(['reviewer', 'reviewer', 'reviewer'])
    // Same context, same session: the second visit resumes nothing and opens
    // nothing, it just lands back in the transcript it belongs to.
    expect(await sessions.sessionFor('reviewer', 'alice')).toBe(alice)
    expect(connection.opened).toHaveLength(3)
    expect(sessions.sessions()).toEqual({
      [sessionKeyOf('reviewer', DEFAULT_CONTEXT)]: uuid(1),
      [sessionKeyOf('reviewer', 'alice')]: alice,
      [sessionKeyOf('reviewer', 'bob')]: bob,
    })
  })

  test('no contextId lands in the default context, exactly as before', async () => {
    const store = new MemoryResidentSessionStore()
    const connection = new RecordingConnection()
    const sessions = manager(connection, { store })
    await sessions.start()

    const started = sessions.sessionOf('reviewer')
    expect(await sessions.sessionFor('reviewer')).toBe(started)
    expect(await sessions.sessionFor('reviewer', undefined)).toBe(started)
    expect(await sessions.sessionFor('reviewer', '')).toBe(started)

    // One agent, no context anywhere: one ACP session, one stored entry —
    // byte for byte the shape a single-context node had before this existed.
    expect(connection.opened).toEqual(['reviewer'])
    expect(store.entries()).toEqual({
      [sessionKeyOf('reviewer', DEFAULT_CONTEXT)]: {
        sessionId: started,
        createdAt: expect.any(Number),
        lastUsedAt: expect.any(Number),
      },
    })
  })

  test('stored non-default contexts resume once, and N contexts over M rounds stay N entries', async () => {
    const store = new MemoryResidentSessionStore()
    const contexts = ['c1', 'c2', 'c3', 'c4']
    for (const [index, context] of contexts.entries()) {
      store.set(sessionKeyOf('reviewer', context), {
        sessionId: uuid(100 + index),
        createdAt: 1,
        lastUsedAt: 1,
      })
    }
    const connection = new RecordingConnection()
    const sessions = manager(connection, {
      store,
      now: () => 2,
      policy: {
        maxSessionsPerAgent: 8,
        idleTtlMs: 1_000,
        keepRecentPerAgent: 4,
      },
    })
    await sessions.start()

    for (let round = 0; round < 5; round++) {
      for (const context of contexts) {
        expect(await sessions.sessionFor('reviewer', context)).toBe(
          store.get(sessionKeyOf('reviewer', context))?.sessionId ?? 'missing',
        )
      }
    }

    // G-9: repeated resume must not shed entries. One resume per context for
    // the life of the process, and the entry count is exactly N + default.
    expect(connection.resumed).toHaveLength(contexts.length)
    expect(Object.keys(store.entries())).toHaveLength(contexts.length + 1)
    expect(connection.opened).toEqual(['reviewer'])
  })

  test('never evicts a session with a turn in flight', async () => {
    const connection = new RecordingConnection()
    const policy: ResidentSessionGcPolicy = {
      maxSessionsPerAgent: 8,
      idleTtlMs: 100_000,
      keepRecentPerAgent: 1,
    }
    let clock = 1_000
    const sessions = manager(connection, { policy, now: () => clock })
    await sessions.start()

    const busy = await sessions.sessionFor('reviewer', 'busy')
    clock += 1_000
    sessions.release(await sessions.sessionFor('reviewer', 'other'))
    clock += 1_000_000

    // Everything is long past the idle ttl and `busy` fell out of the recent
    // window — the only thing holding it is its unreleased lease.
    expect(sessions.collect()).toEqual([
      sessionKeyOf('reviewer', DEFAULT_CONTEXT),
    ])
    expect(Object.values(sessions.sessions())).toContain(busy)

    sessions.release(busy)
    expect(sessions.collect()).toEqual([sessionKeyOf('reviewer', 'busy')])
  })

  test('never evicts the most recently used sessions of an agent', async () => {
    const connection = new RecordingConnection()
    let clock = 1_000
    const sessions = manager(connection, {
      policy: {
        maxSessionsPerAgent: 8,
        idleTtlMs: 100_000,
        keepRecentPerAgent: 2,
      },
      now: () => clock,
    })
    await sessions.start()
    for (const context of ['a', 'b', 'c']) {
      clock += 1_000
      sessions.release(await sessions.sessionFor('reviewer', context))
    }
    clock += 1_000_000

    // Every session is idle past the ttl, so only the recent window can save
    // any — and it saves the two whose prefix cache is worth the most.
    expect([...sessions.collect()].sort()).toEqual([
      sessionKeyOf('reviewer', 'a'),
      sessionKeyOf('reviewer', DEFAULT_CONTEXT),
    ])
    expect(Object.keys(sessions.sessions()).sort()).toEqual([
      sessionKeyOf('reviewer', 'b'),
      sessionKeyOf('reviewer', 'c'),
    ])
  })

  test('never evicts a session the admission ledger still has pending', async () => {
    const ledger = new FileAdmissionLedger(join(directory, 'admission.ndjson'))
    const connection = new RecordingConnection()
    let clock = 1_000
    const sessions = manager(connection, {
      policy: {
        maxSessionsPerAgent: 8,
        idleTtlMs: 100_000,
        keepRecentPerAgent: 0,
      },
      now: () => clock,
      pendingSessionIds: () => pendingSessionIds([ledger]),
    })
    try {
      await sessions.start()
      const stranded = await sessions.sessionFor('reviewer', 'stranded')
      sessions.release(stranded)
      ledger.append({
        kind: 'detected',
        messageId: '11111111-2222-4333-8444-555555555555',
        sessionId: stranded,
        detectedAt: 1,
        agent: 'reviewer',
        team: 'atlas',
        readBefore: {},
        snapshot: [
          {
            from: 'qianmo://node-a/planner',
            text: 'work',
            timestamp: '2026-08-12T00:00:00.000Z',
            read: false,
          },
        ],
        prompt: 'durable prompt',
      })
      clock += 1_000_000

      // Dropping this mapping would strand a message that has already been
      // promised durable handling — the Qianmo-specific exemption.
      expect(sessions.collect()).toEqual([
        sessionKeyOf('reviewer', DEFAULT_CONTEXT),
      ])

      ledger.append({
        kind: 'admitted',
        messageId: '11111111-2222-4333-8444-555555555555',
        at: 2,
      })
      ledger.append({
        kind: 'read',
        messageId: '11111111-2222-4333-8444-555555555555',
        at: 3,
      })
      expect(sessions.collect()).toEqual([sessionKeyOf('reviewer', 'stranded')])
    } finally {
      ledger.close()
    }
  })

  test('evicts to make room before writing a new context, never truncating', async () => {
    const store = new MemoryResidentSessionStore({ maxEntries: 2 })
    const connection = new RecordingConnection()
    let clock = 1_000
    const sessions = manager(connection, {
      store,
      policy: {
        maxSessionsPerAgent: 2,
        idleTtlMs: 100_000,
        keepRecentPerAgent: 1,
      },
      now: () => clock,
    })
    await sessions.start()
    sessions.release(await sessions.sessionFor('reviewer', 'first'))
    clock += 1_000_000

    // The store ceiling is a hard fail, not a silent drop — so this write only
    // succeeds because the GC ran first and made room.
    const second = await sessions.sessionFor('reviewer', 'second')

    expect(Object.keys(store.entries())).toHaveLength(2)
    expect(store.get(sessionKeyOf('reviewer', 'first'))).toBeUndefined()
    expect(store.get(sessionKeyOf('reviewer', 'second'))?.sessionId).toBe(
      second,
    )
  })

  test('evicts nothing when the pending source cannot answer', async () => {
    const connection = new RecordingConnection()
    let clock = 1_000
    const sessions = manager(connection, {
      policy: { maxSessionsPerAgent: 1, idleTtlMs: 1, keepRecentPerAgent: 0 },
      now: () => clock,
      pendingSessionIds: () => {
        throw new Error('resident admission ledger contains integrity issues')
      },
    })
    await sessions.start()
    clock += 10_000

    // Evicting on an unknown pending set is exactly the mistake exemption ③
    // exists to prevent, so an unreadable ledger evicts nothing at all.
    expect(sessions.collect()).toEqual([])
  })

  test('refuses to resolve a session for an agent this node does not run', async () => {
    const sessions = manager(new RecordingConnection())
    await sessions.start()

    await expect(sessions.sessionFor('ghost', 'anything')).rejects.toThrow(
      'resident agent ghost is not configured',
    )
  })
})
