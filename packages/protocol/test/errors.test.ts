// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  LEGACY_ERROR_CODES,
  ProtocolError,
  ProtocolErrorCode,
  downgradeErrorCode,
  isLegacyErrorCode,
  issue,
} from '../src/index.js'

/** protocol.md §11 — the v0.1 code table, which is also the legacy floor. */
const V0_1_CODES = [
  'E_BAD_ENVELOPE',
  'E_BAD_VERSION',
  'E_BAD_ADDRESS',
  'E_BAD_TYPE',
  'E_TOO_LARGE',
  'E_TTL_EXPIRED',
  'E_TOO_MANY_HOPS',
  'E_LOOP',
  'E_RATE_LIMITED',
  'E_UNKNOWN_AGENT',
  'E_TASK_TIMEOUT',
  'E_TASK_FAILED',
  'E_EVICTED',
  'E_UNDELIVERABLE',
  'E_PAYLOAD_UNAVAILABLE',
  'E_CAP_INVALID',
  'E_CAP_INSUFFICIENT',
  'E_BUDGET_EXHAUSTED',
  // §13, added by P5.2.
  'E_RESOURCE_REFUSED',
] as const

/** Added after the floor. Every entry here needs a rule N-1 downgrade. */
const POST_LEGACY_CODES = [
  // P13.2, protocol.md §11 / §14.
  'E_BUSY',
] as const

describe('ProtocolErrorCode', () => {
  test('matches the §11 table exactly — the floor plus what came after', () => {
    expect((Object.values(ProtocolErrorCode) as string[]).sort()).toEqual(
      [...V0_1_CODES, ...POST_LEGACY_CODES].sort(),
    )
    expect(Object.values(ProtocolErrorCode)).toHaveLength(20)
  })

  test('the legacy floor is exactly the v0.1 table, and it does not move', () => {
    // The whole point of the floor: adding a code must not widen what a peer
    // that predates it is assumed to understand.
    expect(([...LEGACY_ERROR_CODES] as string[]).sort()).toEqual(
      [...V0_1_CODES].sort(),
    )
    expect(LEGACY_ERROR_CODES).toHaveLength(19)
    for (const code of POST_LEGACY_CODES) {
      expect(isLegacyErrorCode(code as ProtocolErrorCode)).toBe(false)
    }
  })

  test('every post-legacy code downgrades to a legacy one', () => {
    // Rule N-1 has teeth only if the fallback exists for every new code; a
    // missing entry is what would put an unparseable code on the wire.
    for (const code of POST_LEGACY_CODES) {
      const fallback = downgradeErrorCode(code as ProtocolErrorCode)
      expect(fallback).not.toBe(code)
      expect(isLegacyErrorCode(fallback)).toBe(true)
    }
    expect(downgradeErrorCode(ProtocolErrorCode.E_BUSY)).toBe(
      ProtocolErrorCode.E_RATE_LIMITED,
    )
  })

  test('a legacy code is returned untouched by the downgrade', () => {
    for (const code of LEGACY_ERROR_CODES) {
      expect(downgradeErrorCode(code)).toBe(code)
    }
  })

  test('every code is its own wire string', () => {
    for (const [key, value] of Object.entries(ProtocolErrorCode)) {
      expect(String(value)).toBe(key)
    }
  })

  test('ProtocolError carries the first issue', () => {
    const error = new ProtocolError([
      issue(ProtocolErrorCode.E_TASK_TIMEOUT, 'taskTtlMs', 'task deadline'),
      issue(ProtocolErrorCode.E_EVICTED, '', 'evicted'),
    ])
    expect(error.code).toBe(ProtocolErrorCode.E_TASK_TIMEOUT)
    expect(error.field).toBe('taskTtlMs')
    expect(error.issues).toHaveLength(2)
  })
})
