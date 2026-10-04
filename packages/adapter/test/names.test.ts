// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'

import { sanitizeName } from 'src/utils/swarm/teamHelpers.js'
import { sanitizePathComponent } from 'src/utils/task/tasks.js'

import {
  InvalidTeamNameError,
  MAX_TEAM_NAME_LENGTH,
  RESERVED_DEVICE_NAMES,
  TEAM_NAME_PATTERN,
  assertTeamName,
  isNormalizedTeamName,
  isReservedDeviceName,
  normalizeTeamName,
} from '../src/names.js'

describe('reserved device names (rule A-1)', () => {
  test('covers exactly the 22 names the base reserves', () => {
    expect(RESERVED_DEVICE_NAMES.size).toBe(22)
    for (const name of ['con', 'prn', 'aux', 'nul']) {
      expect(RESERVED_DEVICE_NAMES.has(name)).toBe(true)
    }
    for (let i = 1; i <= 9; i++) {
      expect(RESERVED_DEVICE_NAMES.has(`com${i}`)).toBe(true)
      expect(RESERVED_DEVICE_NAMES.has(`lpt${i}`)).toBe(true)
    }
  })

  test('matches on the stem, because `nul.txt` is the device too', () => {
    expect(isReservedDeviceName('nul')).toBe(true)
    expect(isReservedDeviceName('nul.txt')).toBe(true)
    expect(isReservedDeviceName('NUL')).toBe(true)
    expect(isReservedDeviceName('nullable')).toBe(false)
    expect(isReservedDeviceName('con-review')).toBe(false)
  })

  test('every reserved name is refused, not repaired', () => {
    for (const name of RESERVED_DEVICE_NAMES) {
      expect(() => normalizeTeamName(name)).toThrow(InvalidTeamNameError)
      try {
        normalizeTeamName(name)
      } catch (error) {
        expect((error as InvalidTeamNameError).reason).toBe(
          'reserved-device-name',
        )
      }
    }
  })

  // The concrete fork protocol.md §2.2 names: a team called `con` would get
  // roster directory `_con` (sanitizeName applies avoidReservedName) but inbox
  // directory `con` (sanitizePathComponent does not). Refusing the name at the
  // source is what makes the fork unreachable.
  test('`con` is refused — the exact directory-fork case', () => {
    expect(sanitizeName('con')).toBe('_con')
    expect(sanitizePathComponent('con')).toBe('con')
    expect(sanitizeName('con')).not.toBe(sanitizePathComponent('con'))
    expect(() => normalizeTeamName('con')).toThrow(InvalidTeamNameError)
  })
})

describe('normalizeTeamName (rule A-2)', () => {
  test('lowercases and folds everything outside [a-z0-9-] to a dash', () => {
    expect(normalizeTeamName('My Team')).toBe('my-team')
    expect(normalizeTeamName('Nest_Alpha')).toBe('nest-alpha')
    expect(normalizeTeamName('a.b.c')).toBe('a-b-c')
    expect(normalizeTeamName('--edge--')).toBe('edge')
    expect(normalizeTeamName('a@@@b')).toBe('a-b')
  })

  // `_` is the one character class the two base sanitizers actually disagree
  // on: sanitizeName turns it into `-`, sanitizePathComponent keeps it.
  test('`_` is folded away, because it is the divergent character', () => {
    expect(sanitizeName('a_b')).toBe('a-b')
    expect(sanitizePathComponent('a_b')).toBe('a_b')
    expect(normalizeTeamName('a_b')).toBe('a-b')
  })

  test('the result satisfies the A-2 pattern', () => {
    for (const raw of ['My Team', 'x', 'Nest_Alpha', '9lives', 'a--b']) {
      const normalized = normalizeTeamName(raw)
      expect(TEAM_NAME_PATTERN.test(normalized)).toBe(true)
      expect(isNormalizedTeamName(normalized)).toBe(true)
    }
  })

  test('is idempotent', () => {
    for (const raw of ['My Team', 'Nest_Alpha', '--edge--', 'a.b.c']) {
      const once = normalizeTeamName(raw)
      expect(normalizeTeamName(once)).toBe(once)
    }
  })

  test('truncates to the length bound without leaving a trailing dash', () => {
    const long = `${'a'.repeat(MAX_TEAM_NAME_LENGTH)}-tail`
    const normalized = normalizeTeamName(long)
    expect(normalized.length).toBe(MAX_TEAM_NAME_LENGTH)
    expect(normalized.endsWith('-')).toBe(false)

    const dashAtBoundary = `${'a'.repeat(MAX_TEAM_NAME_LENGTH - 1)}-bbb`
    const trimmed = normalizeTeamName(dashAtBoundary)
    expect(trimmed.endsWith('-')).toBe(false)
    expect(TEAM_NAME_PATTERN.test(trimmed)).toBe(true)
  })

  test('refuses names that normalize to nothing', () => {
    for (const raw of ['', '---', '   ', '你好']) {
      expect(() => normalizeTeamName(raw)).toThrow(InvalidTeamNameError)
    }
  })
})

// The whole point of A-2: on a normalized name the base's two sanitizers are
// the same function, so the roster directory and the inbox directory can never
// diverge.
describe('both base sanitizers are the identity on a normalized name', () => {
  const raws = [
    'My Team',
    'Nest_Alpha',
    'reviewers',
    'a.b.c',
    'TEAM-42',
    '--edge--',
    'x',
    '9lives',
  ]

  test.each(raws)('%s', raw => {
    const normalized = normalizeTeamName(raw)
    expect(sanitizeName(normalized)).toBe(normalized)
    expect(sanitizePathComponent(normalized)).toBe(normalized)
  })
})

describe('assertTeamName', () => {
  test('passes an already-normalized name through', () => {
    expect(assertTeamName('nest')).toBe('nest')
  })

  test('rejects a reserved device name', () => {
    expect(() => assertTeamName('lpt1')).toThrow(InvalidTeamNameError)
  })

  test('rejects anything off the A-2 alphabet', () => {
    for (const bad of ['Nest', 'nest_alpha', '-nest', 'nest-', '']) {
      expect(() => assertTeamName(bad)).toThrow(InvalidTeamNameError)
    }
  })
})
