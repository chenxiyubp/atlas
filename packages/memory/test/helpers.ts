// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMemoryStore, type MemoryStoreOptions } from '../src/index.js'

/**
 * A clock the test drives by hand.
 *
 * Real time would make the two axes untestable: the whole claim is that ingest
 * time and event time move independently, and you cannot demonstrate that with
 * timestamps that differ by a millisecond of wall clock.
 */
export class ManualClock {
  #ms: number

  constructor(startMs: number) {
    this.#ms = startMs
  }

  readonly now = (): Date => new Date(this.#ms)

  advance(ms: number): void {
    this.#ms += ms
  }
}

/** Predictable ids, so assertions can name an entry instead of chasing a UUID. */
export function sequentialIds(): () => string {
  let n = 0
  return () => {
    n += 1
    return `qm-mem-${String(n).padStart(4, '0')}`
  }
}

/** Store options a test may vary; root, clock and id factory stay fixed. */
export type StoreOverrides = Pick<
  MemoryStoreOptions,
  'onEvent' | 'eventCapacity'
>

export type Sandbox = {
  readonly root: string
  readonly clock: ManualClock
  /** A second store over the same directory: proves reads come off disk. */
  reopen(overrides?: StoreOverrides): FileMemoryStore
  store: FileMemoryStore
  dispose(): void
}

/**
 * Every test gets its own directory under the OS temp dir and removes it
 * afterwards. Nothing here may touch the real config root — `~/.qianmo/memory`
 * belongs to whatever node the developer is actually running, and this package
 * is specifically the one that must never be caught writing there by accident.
 */
export function createSandbox(
  startMs = Date.UTC(2026, 8, 20, 9, 0, 0),
): Sandbox {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-memory-'))
  const root = join(directory, 'memory')
  const clock = new ManualClock(startMs)
  const newId = sequentialIds()
  const make = (overrides: StoreOverrides = {}): FileMemoryStore =>
    new FileMemoryStore({ root, now: clock.now, newId, ...overrides })
  return {
    root,
    clock,
    store: make(),
    reopen: make,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}
