// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RESIDENT_LIFECYCLE_HEARTBEAT_MS,
  ResidentLifecycleSentinel,
} from '../src/lifecycle.js'

let directory: string
let path: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-lifecycle-'))
  path = join(directory, 'lifecycle.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function sentinel(
  options: {
    readonly now?: () => number
    readonly pid?: number
    readonly errors?: unknown[]
  } = {},
): ResidentLifecycleSentinel {
  return new ResidentLifecycleSentinel({
    path,
    node: 'node-b',
    pid: options.pid ?? 4242,
    ...(options.now === undefined ? {} : { now: options.now }),
    onError: error => options.errors?.push(error),
  })
}

describe('the termination-cause sentinel', () => {
  test('a life that never stamped `stopped` is read as killed', () => {
    // The deliverable in one test: a process that came up and was then taken
    // out from under itself — SIGKILL, the OOM killer, a host reboot — leaves
    // `running` behind, and the next start can say so without correlating four
    // logs by hand.
    const first = sentinel()
    expect(first.start().outcome).toBe('unknown')
    // Deliberately no `stop()`: that *is* the kill.

    const second = sentinel()
    const prior = second.start()
    expect(prior.outcome).toBe('killed')
    expect(prior.record?.phase).toBe('running')
    expect(prior.record?.pid).toBe(4242)
    expect(prior.record?.node).toBe('node-b')
  })

  test('a life that shut down through its own path is read as clean', () => {
    const first = sentinel()
    first.start()
    first.stop()

    expect(sentinel().start().outcome).toBe('clean')
  })

  test('a first start has no verdict rather than a wrong one', () => {
    expect(sentinel().start().outcome).toBe('unknown')
  })

  test('a torn file is unknown, never killed', () => {
    // A half-written record is not evidence of a kill, and reporting it as one
    // would poison the only signal this file carries.
    writeFileSync(path, '{"phase":"run')
    const prior = sentinel().start()
    expect(prior.outcome).toBe('unknown')
    expect(prior.record).toBeUndefined()
  })

  test('a well-formed file with an unknown phase is unknown too', () => {
    writeFileSync(path, JSON.stringify({ phase: 'draining', pid: 1 }))
    expect(sentinel().start().outcome).toBe('unknown')
  })

  test('the read happens before the stamp, or the evidence is erased', () => {
    sentinel().start()
    const second = sentinel({ pid: 99 })
    // If `start()` wrote first and read second, this would be `clean` — or
    // worse, this process's own record read back as the previous life's.
    expect(second.start().record?.pid).toBe(4242)
    expect(
      (JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid,
    ).toBe(99)
  })

  test('stop is idempotent and start clears it for the next life', () => {
    const one = sentinel()
    one.start()
    one.stop()
    one.stop()
    expect(
      (JSON.parse(readFileSync(path, 'utf8')) as { phase: string }).phase,
    ).toBe('stopped')
  })

  describe('the heartbeat', () => {
    test('re-stamps no more often than the code constant allows', () => {
      let clock = 1_000_000
      const beat = sentinel({ now: () => clock })
      beat.start()
      const afterStart = readFileSync(path, 'utf8')

      // Inside the window: nothing is written, however often it is called.
      clock += RESIDENT_LIFECYCLE_HEARTBEAT_MS - 1
      for (let index = 0; index < 100; index++) beat.heartbeat()
      expect(readFileSync(path, 'utf8')).toBe(afterStart)

      // On the window: exactly one write.
      clock += 1
      beat.heartbeat()
      const record = JSON.parse(readFileSync(path, 'utf8')) as {
        phase: string
        updatedAt: number
        startedAt: number
      }
      expect(record.phase).toBe('running')
      expect(record.updatedAt).toBe(clock)
      expect(record.startedAt).toBe(1_000_000)
    })

    test('the cadence is a code constant of at least 30 s (B8)', () => {
      // Observation must never become a load-bearing writer. There is no
      // option that lowers this, and this assertion is what keeps someone from
      // adding one.
      expect(RESIDENT_LIFECYCLE_HEARTBEAT_MS).toBeGreaterThanOrEqual(30_000)
    })

    test('it stops writing once the life has ended', () => {
      let clock = 0
      const beat = sentinel({ now: () => clock })
      beat.start()
      beat.stop()
      clock += RESIDENT_LIFECYCLE_HEARTBEAT_MS * 10
      beat.heartbeat()
      expect(
        (JSON.parse(readFileSync(path, 'utf8')) as { phase: string }).phase,
      ).toBe('stopped')
    })
  })

  test('a heartbeat or a stop before start stamps nothing, and says so once', () => {
    // B-1 (2026-09-08): the resident never called `start()`, and a record with
    // `startedAt: 0` still appeared — first from the poll's heartbeat, then
    // `stopped` on a clean exit — so the missing claim looked like a working
    // sentinel. With no claim there is no life to describe.
    const errors: unknown[] = []
    const unstarted = sentinel({ errors })
    for (let index = 0; index < 3; index++) unstarted.heartbeat()
    unstarted.stop()
    expect(existsSync(path)).toBe(false)
    expect(errors.map(String)).toEqual([
      'Error: resident lifecycle sentinel used before start(); nothing was stamped',
    ])

    // A late start still works, and the next life reads it as usual.
    unstarted.start()
    unstarted.stop()
    expect(sentinel().start().outcome).toBe('clean')
  })

  test('an unwritable path fails open: it reports and never throws', () => {
    // The whole reliability kit is on the fail-open side of the line. A
    // sentinel that cannot be written must not be able to stop a node.
    const errors: unknown[] = []
    const broken = new ResidentLifecycleSentinel({
      // A path whose parent is a *file*, so mkdir and open both fail.
      path: join(path, 'nested', 'lifecycle.json'),
      onError: error => errors.push(error),
    })
    writeFileSync(path, 'not a directory')

    expect(() => broken.start()).not.toThrow()
    expect(() => broken.heartbeat()).not.toThrow()
    expect(() => broken.stop()).not.toThrow()
    expect(errors.length).toBeGreaterThan(0)
  })

  test('an empty path is refused at construction', () => {
    expect(() => new ResidentLifecycleSentinel({ path: '' })).toThrow(
      'resident lifecycle path must not be empty',
    )
  })
})
