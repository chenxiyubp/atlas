// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  BackupScheduler,
  FileSnapshotStore,
  type CancelTimer,
  type Scheduler,
} from '../src/index.js'
import { cleanupTemporaries, tempDir } from './helpers.js'

afterEach(cleanupTemporaries)

/**
 * A scheduler a test drives by hand: no sleeping, no wall clock.
 *
 * `fire()` used to give the snapshot a flat 5 ms to finish. That budget has to
 * cover three real filesystem syscalls (`mkdir` plus two `writeFile`), which
 * cost about a millisecond on an idle machine and rather more inside a full
 * unsharded `bun test` — so the file was green in isolation and occasionally
 * red in `precheck`, with `store.list()` reading 0 because the writes had not
 * landed yet (#33).
 *
 * The completion signal is now the scheduler's own `onSnapshot` / `onError`
 * hook, which the {@link BackupScheduler} calls once the write has returned:
 * every test that drives this class by hand wires {@link settleRound} into it.
 * `fire()` waits for that hook and then yields one macrotask turn, which drains
 * the microtask queue carrying the re-arm no matter how loaded the machine is.
 * Nothing here is a time budget any more, so there is nothing left to blow.
 *
 * A round that never settles hangs until bun's own test timeout rather than
 * failing fast — deliberately, because the alternative is another deadline.
 */
class ManualScheduler implements Scheduler {
  #pending: Array<{ delayMs: number; callback: () => void }> = []
  #roundSettled: (() => void) | null = null

  after(delayMs: number, callback: () => void): CancelTimer {
    const entry = { delayMs, callback }
    this.#pending.push(entry)
    return () => {
      this.#pending = this.#pending.filter(item => item !== entry)
    }
  }

  get pending(): number {
    return this.#pending.length
  }

  /** Wire into `onSnapshot` / `onError`: one scheduled round has finished. */
  readonly settleRound = (): void => {
    const resolve = this.#roundSettled
    this.#roundSettled = null
    resolve?.()
  }

  /** Fire everything armed right now, once, and wait for it to finish. */
  async fire(): Promise<void> {
    const due = this.#pending
    this.#pending = []
    // Nothing armed means nothing to wait for — a stopped scheduler must not
    // park the test on a hook that will never be called.
    if (due.length === 0) return
    const settled = new Promise<void>(resolve => {
      this.#roundSettled = resolve
    })
    for (const entry of due) entry.callback()
    await settled
    // The re-arm rides a `.finally` a few microtasks behind the hook, and a
    // macrotask turn runs only once the microtask queue is empty.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function newStore(): FileSnapshotStore {
  return new FileSnapshotStore({ root: join(tempDir(), 'backups') })
}

describe('the two triggers', () => {
  test('a pre-task snapshot is labelled with the task it precedes', async () => {
    const store = newStore()
    const scheduler = new BackupScheduler({
      workspace: '/workspace',
      writer: store.writer(),
      archive: async () => new Uint8Array([1, 2, 3]),
    })
    const meta = await scheduler.beforeTask('task-42')
    expect(meta?.reason).toBe('pre-task')
    expect(meta?.label).toBe('task-42')
  })

  test('the periodic one re-arms from the end of the previous snapshot', async () => {
    // `setInterval` does not replay missed ticks (E4), so a frozen node would
    // silently skip beats and keep its old phase. Re-arming after completion
    // bounds the gap instead, which is the property that matters.
    const store = newStore()
    const scheduler = new ManualScheduler()
    const backups = new BackupScheduler({
      workspace: '/workspace',
      writer: store.writer(),
      scheduler,
      intervalMs: 1_000,
      archive: async () => new Uint8Array([1]),
      onSnapshot: scheduler.settleRound,
    })
    backups.start()
    expect(scheduler.pending).toBe(1)
    await scheduler.fire()
    expect(await store.list('/workspace')).toHaveLength(1)
    expect(scheduler.pending).toBe(1)
    await scheduler.fire()
    expect(await store.list('/workspace')).toHaveLength(2)
    backups.stop()
    expect(scheduler.pending).toBe(0)
  })

  test('start is idempotent and stop actually stops', async () => {
    const store = newStore()
    const scheduler = new ManualScheduler()
    const backups = new BackupScheduler({
      workspace: '/w',
      writer: store.writer(),
      scheduler,
      archive: async () => new Uint8Array([1]),
      onSnapshot: scheduler.settleRound,
    })
    backups.start()
    backups.start()
    expect(scheduler.pending).toBe(1)
    backups.stop()
    await scheduler.fire()
    expect(await store.list('/w')).toHaveLength(0)
  })
})

describe('failures are loud, not fatal', () => {
  test('a failed snapshot reports and the schedule survives', async () => {
    const store = newStore()
    const scheduler = new ManualScheduler()
    const errors: unknown[] = []
    let attempt = 0
    const backups = new BackupScheduler({
      workspace: '/w',
      writer: store.writer(),
      scheduler,
      intervalMs: 10,
      archive: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('tar exploded')
        return new Uint8Array([1])
      },
      onSnapshot: scheduler.settleRound,
      onError: error => {
        errors.push(error)
        scheduler.settleRound()
      },
    })
    backups.start()
    await scheduler.fire()
    expect(errors.map(String)).toEqual(['Error: tar exploded'])
    // Refusing to work because a backup failed would turn a recoverable outage
    // into an outright one.
    expect(scheduler.pending).toBe(1)
    await scheduler.fire()
    expect(await store.list('/w')).toHaveLength(1)
    backups.stop()
  })

  test('two snapshots of one workspace do not overlap', async () => {
    // Archiving a workspace while a previous archive of it is still running is
    // a good way to store two half-states.
    const store = newStore()
    let running = 0
    let overlapped = false
    const backups = new BackupScheduler({
      workspace: '/w',
      writer: store.writer(),
      archive: async () => {
        running += 1
        if (running > 1) overlapped = true
        await new Promise(resolve => setTimeout(resolve, 10))
        running -= 1
        return new Uint8Array([1])
      },
    })
    const [first, second] = await Promise.all([
      backups.beforeTask('a'),
      backups.once('b'),
    ])
    expect(overlapped).toBe(false)
    // The second caller joins the in-flight snapshot rather than starting one.
    expect(second?.id).toBe(first?.id as string)
    expect(await store.list('/w')).toHaveLength(1)
  })
})
