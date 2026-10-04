// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  assertGcPolicy,
  DEFAULT_RESIDENT_SESSION_GC_POLICY,
  selectEvictableSessions,
  type ResidentSessionGcPolicy,
} from '../src/session-gc.js'
import { sessionKeyOf } from '../src/session-key.js'
import type { ResidentSessionRecord } from '../src/session-store.js'

const POLICY: ResidentSessionGcPolicy = {
  maxSessionsPerAgent: 3,
  idleTtlMs: 1_000,
  keepRecentPerAgent: 1,
}

function uuid(index: number): string {
  return `aaaaaaaa-bbbb-4ccc-8ddd-${index.toString().padStart(12, '0')}`
}

function entries(
  ...items: readonly (readonly [string, string, number])[]
): Record<string, ResidentSessionRecord> {
  const built: Record<string, ResidentSessionRecord> = {}
  for (const [agent, context, lastUsedAt] of items) {
    built[sessionKeyOf(agent, context)] = {
      sessionId: uuid(Object.keys(built).length + 1),
      createdAt: 0,
      lastUsedAt,
    }
  }
  return built
}

function evict(
  input: Partial<Parameters<typeof selectEvictableSessions>[0]> & {
    entries: Record<string, ResidentSessionRecord>
  },
): readonly string[] {
  return selectEvictableSessions({
    now: 10_000,
    policy: POLICY,
    inFlightSessionIds: new Set(),
    pendingSessionIds: new Set(),
    ...input,
  })
}

describe('resident session gc', () => {
  test('evicts sessions idle past the ttl', () => {
    const map = entries(
      ['reviewer', 'warm', 9_999],
      ['reviewer', 'cold', 8_000],
      ['reviewer', 'colder', 1],
    )

    expect(evict({ entries: map })).toEqual([
      sessionKeyOf('reviewer', 'colder'),
      sessionKeyOf('reviewer', 'cold'),
    ])
  })

  test('evicts least-recently-used first when an agent is over its ceiling', () => {
    const map = entries(
      ['reviewer', 'a', 9_996],
      ['reviewer', 'b', 9_997],
      ['reviewer', 'c', 9_998],
      ['reviewer', 'd', 9_999],
    )

    // Nothing is idle; the only reason to evict is the per-agent ceiling of 3,
    // and the cheapest thing to lose goes first.
    expect(evict({ entries: map })).toEqual([sessionKeyOf('reviewer', 'a')])
  })

  test('counts ceilings per agent, not per node', () => {
    const map = entries(
      ['reviewer', 'a', 9_996],
      ['reviewer', 'b', 9_997],
      ['reviewer', 'c', 9_998],
      ['planner', 'a', 9_996],
      ['planner', 'b', 9_997],
    )

    expect(evict({ entries: map })).toEqual([])
  })

  test('a policy whose protected window swallows its own ceiling is rejected', () => {
    // Otherwise the node wedges at capacity: everything over the ceiling is
    // also inside the never-evict window, so no eviction is ever possible.
    expect(() =>
      assertGcPolicy({
        ...POLICY,
        keepRecentPerAgent: POLICY.maxSessionsPerAgent,
      }),
    ).toThrow('keepRecentPerAgent must be below maxSessionsPerAgent')
    expect(() => assertGcPolicy({ ...POLICY, idleTtlMs: 0 })).toThrow(
      'idleTtlMs',
    )
    expect(() => assertGcPolicy({ ...POLICY, maxSessionsPerAgent: 0 })).toThrow(
      'maxSessionsPerAgent',
    )
    expect(() =>
      assertGcPolicy(DEFAULT_RESIDENT_SESSION_GC_POLICY),
    ).not.toThrow()
  })
})
