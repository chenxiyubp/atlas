// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catchUpGraceMs } from '../src/reserve.js'
import {
  MAX_CLAIMS_PER_JOB,
  SchedulerStore,
  claimRetentionMs,
} from '../src/store.js'

const MINUTE = 60_000
const HOUR = 3_600_000

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-scheduler-store-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function open(
  options: {
    readonly now?: () => number
    readonly onError?: (error: unknown) => void
    readonly maxClaimsPerJob?: number
  } = {},
): SchedulerStore {
  return new SchedulerStore(directory, options)
}

describe('the claim, as a cross-process compare-and-set', () => {
  test('the first claim of a slot wins and every later one loses', () => {
    const store = open()
    expect(store.claim('watch-ci', 1_000)).toBe(true)
    expect(store.claim('watch-ci', 1_000)).toBe(false)
    expect(store.claim('watch-ci', 1_000)).toBe(false)
  })

  test('two stores over one directory agree on who owns a slot', () => {
    // The operator scenario F7 names: a second `qm console`. Two independent
    // stores, one filesystem, one winner — decided inside the `wx` syscall,
    // with no window between the test and the set.
    const first = open()
    const second = open()
    const results = [
      first.claim('watch-ci', 5_000),
      second.claim('watch-ci', 5_000),
    ]
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test('a different instant of the same job is a different slot', () => {
    const store = open()
    expect(store.claim('watch-ci', 1_000)).toBe(true)
    expect(store.claim('watch-ci', 2_000)).toBe(true)
    expect(store.claim('other-job', 1_000)).toBe(true)
  })

  test('a claim survives a reopen — it is a tombstone, not a lock', () => {
    // Never released, on purpose: releasing on failure would turn at-most-once
    // into at-least-once exactly when the target is already struggling.
    open().claim('watch-ci', 1_000)
    expect(open().claim('watch-ci', 1_000)).toBe(false)
    expect(open().claimed('watch-ci', 1_000)).toBe(true)
  })

  test('an unusable claim store loses rather than pretending to win', () => {
    // The one place the kit does not fail open: a store that cannot record a
    // claim cannot promise at-most-once, and a missed watch run is cheaper than
    // a duplicated one with side effects.
    writeFileSync(join(directory, 'blocker'), 'not a directory')
    const errors: unknown[] = []
    const store = new SchedulerStore(join(directory, 'blocker', 'store'), {
      onError: error => errors.push(error),
    })
    expect(store.claim('watch-ci', 1_000)).toBe(false)
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('claim files stay bounded', () => {
  test('prunes claims older than max(2 * everyMs, 1h)', () => {
    const clock = 100 * HOUR
    const store = open({ now: () => clock })
    const stale = clock - 5 * HOUR
    const fresh = clock - 30 * MINUTE
    store.claim('watch-ci', stale)
    store.claim('watch-ci', fresh)

    store.pruneClaims('watch-ci', MINUTE)
    expect(store.claimed('watch-ci', stale)).toBe(false)
    expect(store.claimed('watch-ci', fresh)).toBe(true)
  })

  test('the retention window always outlives the catch-up grace', () => {
    // If it did not, pruning would delete the tombstone of a slot `reserve.ts`
    // can still plan, and the second fire would find nothing in its way.
    for (const everyMs of [
      1_000,
      MINUTE,
      5 * MINUTE,
      HOUR,
      4 * HOUR,
      24 * HOUR,
      7 * 24 * HOUR,
    ]) {
      expect(claimRetentionMs(everyMs)).toBeGreaterThan(catchUpGraceMs(everyMs))
    }
  })

  test('caps the count per job even when every claim is inside the window', () => {
    // A minute-cadence job leaves 1,440 files a day. Unbounded, "at most once"
    // becomes "until the filesystem runs out of inodes".
    const clock = 1_000 * HOUR
    const store = open({ now: () => clock, maxClaimsPerJob: 4 })
    for (let index = 0; index < 10; index++) {
      store.claim('watch-ci', clock - index * 1_000)
    }
    store.pruneClaims('watch-ci', HOUR)
    const left = readdirSync(join(directory, 'claims', 'watch-ci'))
    expect(left).toHaveLength(4)
    // The survivors are the newest, which are the ones a plan can still reach.
    expect(left.sort()).toEqual(
      [0, 1, 2, 3].map(index => `${clock - index * 1_000}.claim`).sort(),
    )
  })

  test('the default per-job cap is a real number, not unbounded', () => {
    expect(Number.isSafeInteger(MAX_CLAIMS_PER_JOB)).toBe(true)
    expect(MAX_CLAIMS_PER_JOB).toBeGreaterThan(0)
  })

  test('pruning a job that never claimed anything is quiet', () => {
    const errors: unknown[] = []
    open({ onError: error => errors.push(error) }).pruneClaims('nobody', MINUTE)
    expect(errors).toEqual([])
  })
})

describe('job state survives a restart', () => {
  test('lastFiredAt, the failure count and the outcome all persist', () => {
    let clock = 10_000
    open({ now: () => clock }).recordFire('watch-ci', 9_000, 'failed')
    clock = 11_000
    open({ now: () => clock }).recordFire('watch-ci', 9_500, 'failed')

    const reopened = open({ now: () => clock })
    const state = reopened.stateOf('watch-ci')
    expect(state.lastFiredAt).toBe(9_500)
    expect(state.consecutiveFailures).toBe(2)
    expect(state.lastOutcome).toBe('failed')
    expect(state.lastOutcomeAt).toBe(11_000)
  })

  test('a success resets the failure count; a skip and a preemption leave it', () => {
    const store = open({ now: () => 1 })
    store.recordFire('watch-ci', 1, 'failed')
    store.recordFire('watch-ci', 2, 'failed')
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(2)
    store.recordFire('watch-ci', 3, 'skipped')
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(2)
    store.recordFire('watch-ci', 4, 'preempted')
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(2)
    store.recordFire('watch-ci', 5, 'completed')
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(0)
  })

  test('an unknown job reads as never having run', () => {
    expect(open().stateOf('never-seen')).toEqual({
      lastFiredAt: undefined,
      consecutiveFailures: 0,
      lastOutcome: undefined,
      lastOutcomeAt: undefined,
    })
  })

  test('writes atomically, leaving no temp file behind', () => {
    const store = open()
    store.recordFire('watch-ci', 1, 'completed')
    const stray = readdirSync(directory).filter(name => name.endsWith('.tmp'))
    expect(stray).toEqual([])
    expect(
      JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')),
    ).toHaveProperty('watch-ci')
  })
})

describe('a corrupt state file fails open, loudly', () => {
  test('unparseable JSON is reported and read as no prior state', () => {
    // Fail-open, unlike the admission ledger: refusing to start would turn
    // "one watch job is confused" into "no watch job runs".
    writeFileSync(join(directory, 'state.json'), '{ not json at all')
    const errors: unknown[] = []
    const store = open({ onError: error => errors.push(error) })
    expect(errors).toHaveLength(1)
    expect(store.entries()).toEqual({})
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(0)
  })

  test('one unreadable job does not cost the others their memory', () => {
    writeFileSync(
      join(directory, 'state.json'),
      JSON.stringify({
        good: { lastFiredAt: 7, consecutiveFailures: 0 },
        bad: { consecutiveFailures: 'lots' },
      }),
    )
    const errors: unknown[] = []
    const store = open({ onError: error => errors.push(error) })
    expect(errors).toHaveLength(1)
    expect(store.stateOf('good').lastFiredAt).toBe(7)
    expect(store.stateOf('bad').lastFiredAt).toBeUndefined()
  })

  test('a state file that is not an object at all is reported, not thrown', () => {
    writeFileSync(join(directory, 'state.json'), '[1,2,3]')
    const errors: unknown[] = []
    expect(() => open({ onError: error => errors.push(error) })).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  test('damage is never swallowed: fail-open is not fail-silent', () => {
    // §4.1 point 6 wants absence visible; a store that hid its own faults
    // would be the quietest way to be absent.
    writeFileSync(join(directory, 'state.json'), 'nope')
    let reported = false
    open({ onError: () => (reported = true) })
    expect(reported).toBe(true)
  })

  test('a failed state write is reported but keeps the value in memory', () => {
    // A directory where the state file goes: the rename cannot land.
    mkdirSync(join(directory, 'state.json'), { recursive: true })
    writeFileSync(join(directory, 'state.json', 'occupied'), 'x')

    const errors: unknown[] = []
    const blocked = new SchedulerStore(directory, {
      onError: error => errors.push(error),
    })
    blocked.recordFire('watch-ci', 2, 'failed')
    expect(errors.length).toBeGreaterThan(0)
    // Still correct for the rest of this process's life; only the
    // crash-recovery half was lost, and the claim file covers that.
    expect(blocked.stateOf('watch-ci').lastFiredAt).toBe(2)
    expect(
      readdirSync(directory).filter(name => name.endsWith('.tmp')),
    ).toEqual([])
  })

  test('forget drops a job without disturbing its neighbours', () => {
    const store = open()
    store.recordFire('a', 1, 'completed')
    store.recordFire('b', 2, 'completed')
    store.forget('a')
    expect(Object.keys(store.entries())).toEqual(['b'])
    expect(existsSync(join(directory, 'state.json'))).toBe(true)
  })
})
