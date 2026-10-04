// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileMemoryStore,
  type MemoryEntry,
  type MemoryWriteInput,
} from '@qianmo/memory'

/**
 * A hand-driven clock. Time decay is one of the three ranking signals, and it
 * cannot be demonstrated against timestamps that differ by a millisecond of
 * wall clock.
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

export const DAY_MS = 24 * 60 * 60 * 1000

export type Sandbox = {
  readonly root: string
  readonly clock: ManualClock
  readonly store: FileMemoryStore
  /** Writes a project-layer entry under {@link PROJECT_KEY}. */
  write(input: Partial<MemoryWriteInput> & { title: string }): MemoryEntry
  dispose(): void
}

export const PROJECT_KEY = 'atlas'

/**
 * Every test gets its own temp directory. Nothing here may touch the real
 * memory root — that belongs to whatever node the developer is running.
 */
export function createSandbox(
  startMs = Date.UTC(2026, 7, 12, 9, 0, 0),
): Sandbox {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-recall-'))
  const root = join(directory, 'memory')
  const clock = new ManualClock(startMs)
  let counter = 0
  const store = new FileMemoryStore({
    root,
    now: clock.now,
    newId: () => {
      counter += 1
      return `qm-mem-${String(counter).padStart(4, '0')}`
    },
  })
  return {
    root,
    clock,
    store,
    write: input =>
      store.write({
        scope: { layer: 'project', projectKey: PROJECT_KEY },
        summary: input.summary ?? input.title,
        body: input.body ?? '',
        source: { kind: 'session', id: 'test-session' },
        ...input,
      }),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}
