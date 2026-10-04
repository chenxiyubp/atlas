// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResidentEstop } from '../src/estop.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-estop-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function estop(
  path = join(directory, 'ESTOP'),
  errors: unknown[] = [],
): ResidentEstop {
  return new ResidentEstop({
    path,
    onError: error => errors.push(error),
  })
}

describe('the emergency stop sentinel', () => {
  test('an absent file is not engaged', () => {
    expect(estop().engaged()).toBe(false)
  })

  test('an empty file is still engaged', () => {
    // The one that gets designed away by accident: an operator running
    // `touch ESTOP` — the most obvious way to pull the brake — creates a file
    // with nothing in it, and any implementation that parses contents before
    // deciding reads that as "no reason given, carry on".
    const path = join(directory, 'ESTOP')
    writeFileSync(path, '')
    expect(estop(path).engaged()).toBe(true)
  })

  test('a file holding unparseable bytes is engaged too', () => {
    const path = join(directory, 'ESTOP')
    writeFileSync(path, '{"engagedAt": 17')
    expect(estop(path).engaged()).toBe(true)
  })

  test('the decision never reads the file, so contents cannot un-engage it', () => {
    const path = join(directory, 'ESTOP')
    // Bytes that would say "off" to anything that interpreted them.
    writeFileSync(path, JSON.stringify({ engaged: false, active: false }))
    expect(estop(path).engaged()).toBe(true)
  })

  test('engagedAt comes from the file rather than from its contents', () => {
    const path = join(directory, 'ESTOP')
    writeFileSync(path, '')
    const status = estop(path).status()
    expect(status.engaged).toBe(true)
    expect(status.engagedAt).toBeGreaterThan(0)
    expect(status.engagedAt).toBeLessThanOrEqual(Date.now() + 1_000)
  })

  test('a stat that fails for any other reason fails open, and reports', () => {
    // A directory with no execute bit: `stat` on a path inside it fails with
    // EACCES rather than ENOENT, which is the shape of "the sentinel itself is
    // broken". The reliability kit must never be able to stop a healthy node,
    // so this reads as not engaged — and says so on the error channel rather
    // than silently.
    const locked = join(directory, 'locked')
    mkdirSync(locked)
    const path = join(locked, 'ESTOP')
    writeFileSync(path, '')
    chmodSync(locked, 0o000)
    try {
      const errors: unknown[] = []
      expect(estop(path, errors).engaged()).toBe(false)
      expect(errors).toHaveLength(1)
      expect((errors[0] as NodeJS.ErrnoException).code).not.toBe('ENOENT')
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  test('it re-reads on every call, so clearing the file resumes the node', () => {
    const path = join(directory, 'ESTOP')
    const sentinel = estop(path)
    expect(sentinel.engaged()).toBe(false)
    writeFileSync(path, '')
    expect(sentinel.engaged()).toBe(true)
    rmSync(path)
    // No restart, no reset call: deleting the file is the entire resume
    // procedure, which is most of why the mechanism is a file.
    expect(sentinel.engaged()).toBe(false)
  })

  test('an empty path is refused at construction, not answered as "not engaged"', () => {
    expect(() => new ResidentEstop({ path: '   ' })).toThrow(
      'resident ESTOP path must not be empty',
    )
  })
})
