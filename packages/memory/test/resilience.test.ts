// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One corrupt file must not take the memory subsystem down.
 *
 * This suite exists because the first cut of the store failed exactly that
 * way, and it was caught by measurement rather than review: three healthy
 * records, one file replaced by hand, and `query()` threw — losing the other
 * two as well. On P3.3's wake path that is a resident node returning with no
 * memory at all, i.e. one bad byte escalating into subsystem-wide failure.
 *
 * Two invariants, and they pull in opposite directions on purpose:
 *   1. healthy records are still recalled (partial results, no throw);
 *   2. the corruption is never silent — it lands on an explicit channel with
 *      the path and the failure.
 *
 * Plus the containment rule inherited from `@qianmo/transport`: a caller sink
 * that throws must not put recall back into the failure mode this whole
 * channel exists to remove.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  archiveWorkingMemory,
  MemoryEventType,
  MemoryParseError,
  type MemoryEntry,
  type MemoryEvent,
} from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

const PROJECT = 'atlas'
const CORRUPTION = 'this is not valid frontmatter at all'

let sandbox: Sandbox

beforeEach(() => {
  sandbox = createSandbox()
})

afterEach(() => {
  sandbox.dispose()
})

function seedThree(): MemoryEntry[] {
  return ['first', 'second', 'third'].map((title, index) => {
    sandbox.clock.advance(1_000 * index)
    return sandbox.store.write({
      scope: { layer: 'project', projectKey: PROJECT },
      title,
      summary: `summary of ${title}`,
      body: 'shared marker token',
      source: { kind: 'session', id: 'sess-1' },
    })
  })
}

function pathOf(entry: MemoryEntry): string {
  return join(sandbox.root, 'project', PROJECT, `${entry.id}.md`)
}

describe('a corrupt file costs one record, not the subsystem', () => {
  test('the healthy records are still recalled, and query does not throw', () => {
    const [first, second, third] = seedThree()
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('unreachable: seeded three')
    }
    expect(sandbox.reopen().query({ text: 'marker' })).toHaveLength(3)

    writeFileSync(pathOf(second), CORRUPTION)

    const store = sandbox.reopen()
    const survivors = store.query({ text: 'marker' })
    expect(survivors.map(e => e.id).sort()).toEqual([first.id, third.id].sort())
    // Unfiltered scans too — the failure must not depend on which query ran.
    expect(store.query({})).toHaveLength(2)
    expect(store.query({ includeRetired: true })).toHaveLength(2)
  })

  test('the corruption is reported: which path, which failure', () => {
    const [, second] = seedThree()
    if (second === undefined) {
      throw new Error('unreachable: seeded three')
    }
    writeFileSync(pathOf(second), CORRUPTION)

    const store = sandbox.reopen()
    store.query({})

    const reported = store.events.byType(MemoryEventType.EntryUnreadable)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.detail.path).toBe(pathOf(second))
    expect(reported[0]?.detail.reason).toBe('MemoryParseError')
    expect(String(reported[0]?.detail.message).length).toBeGreaterThan(0)
    expect(reported[0]?.at).toBe(sandbox.clock.now().getTime())
  })

  test('a caller sink receives the same report', () => {
    const [, second] = seedThree()
    if (second === undefined) {
      throw new Error('unreachable: seeded three')
    }
    writeFileSync(pathOf(second), CORRUPTION)

    const seen: MemoryEvent[] = []
    const store = sandbox.reopen({ onEvent: event => seen.push(event) })
    expect(store.query({})).toHaveLength(2)
    expect(seen.map(e => e.type)).toEqual([MemoryEventType.EntryUnreadable])
    expect(seen[0]?.detail.path).toBe(pathOf(second))
  })

  test('a sink that throws is contained, and its failure is itself recorded', () => {
    const [, second] = seedThree()
    if (second === undefined) {
      throw new Error('unreachable: seeded three')
    }
    writeFileSync(pathOf(second), CORRUPTION)

    const store = sandbox.reopen({
      onEvent: () => {
        throw new TypeError('sink is not a function')
      },
    })

    // The whole point: observability code cannot re-break recall.
    expect(store.query({})).toHaveLength(2)
    const contained = store.events.byType(MemoryEventType.SinkFailed)
    expect(contained).toHaveLength(1)
    expect(contained[0]?.detail).toEqual({
      reason: 'TypeError',
      of: MemoryEventType.EntryUnreadable,
    })
  })

  test('sedimentation still runs over a task holding one corrupt file', () => {
    const keep = sandbox.store.write({
      scope: { layer: 'working', projectKey: PROJECT, taskId: 't1' },
      title: 'worth keeping',
      summary: 'a real finding',
      body: 'body',
      source: { kind: 'session', id: 'sess-1' },
    })
    const broken = sandbox.store.write({
      scope: { layer: 'working', projectKey: PROJECT, taskId: 't1' },
      title: 'about to be mangled',
      summary: 'x',
      body: '',
      source: { kind: 'session', id: 'sess-1' },
    })
    writeFileSync(
      join(sandbox.root, 'working', PROJECT, 't1', `${broken.id}.md`),
      CORRUPTION,
    )

    const store = sandbox.reopen()
    const result = archiveWorkingMemory(store, {
      projectKey: PROJECT,
      taskId: 't1',
      by: 'user:dongzongyue',
    })

    expect(result.promoted).toHaveLength(1)
    expect(result.promoted[0]?.derivedFrom).toEqual([keep.id])
    expect(store.events.byType(MemoryEventType.EntryUnreadable)).toHaveLength(1)
  })
})

describe('lookup by id keeps throwing — a scan and a lookup are not the same', () => {
  test('the named record being corrupt is an error, not a null', () => {
    const [, second] = seedThree()
    if (second === undefined) {
      throw new Error('unreachable: seeded three')
    }
    writeFileSync(pathOf(second), CORRUPTION)

    // `null` would mean "no such memory", and AC-4's citation check reading
    // that would call a genuine entry fabricated.
    expect(() => sandbox.reopen().getEntry(second.id)).toThrow(MemoryParseError)
  })

  test('a corrupt neighbour does not break a lookup for a healthy record', () => {
    const [first, second] = seedThree()
    if (first === undefined || second === undefined) {
      throw new Error('unreachable: seeded three')
    }
    writeFileSync(pathOf(second), CORRUPTION)
    expect(sandbox.reopen().getEntry(first.id)?.title).toBe('first')
  })

  test('a genuinely absent id is still null, not an error', () => {
    seedThree()
    expect(sandbox.reopen().getEntry('qm-mem-9999')).toBeNull()
  })
})

describe('an unlistable layer directory is reported, not read as empty', () => {
  test('the other layers keep answering', () => {
    const [first] = seedThree()
    if (first === undefined) {
      throw new Error('unreachable: seeded three')
    }
    // A file where a layer directory belongs: readdir fails with ENOTDIR
    // rather than ENOENT, which is the difference between "no table yet" and
    // "a table that silently looks empty".
    writeFileSync(join(sandbox.root, 'baseline'), 'not a directory')

    const store = sandbox.reopen()
    expect(store.query({})).toHaveLength(3)
    const reported = store.events.byType(MemoryEventType.LayerUnreadable)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.detail.path).toBe(join(sandbox.root, 'baseline'))
  })

  test('a layer that was never written to is simply empty', () => {
    seedThree()
    const store = sandbox.reopen()
    expect(store.query({ layers: ['baseline'] })).toEqual([])
    expect(store.events.all()).toEqual([])
  })
})
