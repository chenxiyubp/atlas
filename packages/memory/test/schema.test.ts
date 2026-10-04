// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The mandatory fields roadmap P2.3 names — 来源 ID、写入时间、标签、废止标记 —
 * plus the guards on the values that become path segments.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryValidationError, type MemoryWriteInput } from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

let sandbox: Sandbox

beforeEach(() => {
  sandbox = createSandbox()
})

afterEach(() => {
  sandbox.dispose()
})

const VALID: MemoryWriteInput = {
  scope: { layer: 'project', projectKey: 'atlas' },
  title: 'A title',
  summary: 'A one-line summary.',
  body: 'body',
  source: { kind: 'session', id: 'sess-1' },
}

describe('mandatory fields', () => {
  test('every write comes back with all four mandatory field groups filled', () => {
    const entry = sandbox.store.write({ ...VALID, tags: ['decision'] })
    expect(entry.source).toEqual({ kind: 'session', id: 'sess-1' })
    expect(entry.createdAt).toBe('2026-09-20T09:00:00.000Z')
    expect(entry.tags).toEqual(['decision'])
    // The retirement mark exists from birth, as an explicit "not retired".
    expect(entry.expiredAt).toBeNull()
    expect(entry.retirement).toBeNull()
    // Both axes are populated; validAt defaults to the ingest moment.
    expect(entry.validAt).toBe(entry.createdAt)
    expect(entry.invalidAt).toBeNull()
    expect(entry.derivedFrom).toEqual([])
  })

  test('a blank title, summary or source id is refused', () => {
    expect(() => sandbox.store.write({ ...VALID, title: '   ' })).toThrow(
      MemoryValidationError,
    )
    expect(() => sandbox.store.write({ ...VALID, summary: '' })).toThrow(
      MemoryValidationError,
    )
    expect(() =>
      sandbox.store.write({ ...VALID, source: { kind: 'session', id: ' ' } }),
    ).toThrow(MemoryValidationError)
  })

  test('tags are lower-cased, de-duplicated and sorted', () => {
    const entry = sandbox.store.write({
      ...VALID,
      tags: ['Toolchain', 'decision', 'TOOLCHAIN'],
    })
    expect(entry.tags).toEqual(['decision', 'toolchain'])
  })

  test('a tag with whitespace or a path separator is refused', () => {
    expect(() =>
      sandbox.store.write({ ...VALID, tags: ['two words'] }),
    ).toThrow(MemoryValidationError)
    expect(() => sandbox.store.write({ ...VALID, tags: ['a/b'] })).toThrow(
      MemoryValidationError,
    )
  })

  test('invalidAt may not precede validAt', () => {
    expect(() =>
      sandbox.store.write({
        ...VALID,
        validAt: new Date(Date.UTC(2026, 8, 10)),
        invalidAt: new Date(Date.UTC(2026, 8, 1)),
      }),
    ).toThrow(MemoryValidationError)
  })
})

describe('scope keys become path segments, so they are whitelisted', () => {
  const traversals = ['..', '.', '../../etc', 'a/b', '.hidden', '']

  for (const bad of traversals) {
    test(`rejects projectKey ${JSON.stringify(bad)}`, () => {
      expect(() =>
        sandbox.store.write({
          ...VALID,
          scope: { layer: 'project', projectKey: bad },
        }),
      ).toThrow(MemoryValidationError)
    })
  }

  test('rejects a traversal arriving through a query filter too', () => {
    expect(() => sandbox.store.query({ projectKey: '../..' })).toThrow(
      MemoryValidationError,
    )
    expect(() => sandbox.store.query({ taskId: 'a/b' })).toThrow(
      MemoryValidationError,
    )
    expect(() => sandbox.store.query({ period: '..' })).toThrow(
      MemoryValidationError,
    )
  })
})

describe('what counts as an entry', () => {
  test('only files under the three layer directories are read as entries', () => {
    const entry = sandbox.store.write(VALID)
    // Something a human might leave behind — a note beside the tables, or an
    // index projected for the base injection chain.
    mkdirSync(sandbox.root, { recursive: true })
    writeFileSync(join(sandbox.root, 'MEMORY.md'), '# not an entry\n')
    const store = sandbox.reopen()
    expect(store.query({}).map(e => e.id)).toEqual([entry.id])
    expect(store.getEntry(entry.id)?.id).toBe(entry.id)
  })

  // How a corrupt file under a layer directory behaves is its own subject —
  // see `resilience.test.ts`.
})

describe('deterministic retrieval', () => {
  test('ordering is newest ingest first, ties broken by id — not by directory order', () => {
    const first = sandbox.store.write({ ...VALID, title: 'first' })
    const alsoFirst = sandbox.store.write({ ...VALID, title: 'also first' })
    sandbox.clock.advance(1_000)
    const later = sandbox.store.write({ ...VALID, title: 'later' })

    const ids = sandbox
      .reopen()
      .query({})
      .map(e => e.id)
    expect(ids).toEqual([later.id, first.id, alsoFirst.id])
    expect(first.id < alsoFirst.id).toBe(true)
    // Same query, same order, every time.
    expect(
      sandbox
        .reopen()
        .query({})
        .map(e => e.id),
    ).toEqual(ids)
  })

  test('tag filters are AND, and limit is applied after ordering', () => {
    sandbox.store.write({ ...VALID, title: 'a', tags: ['decision'] })
    sandbox.clock.advance(1_000)
    const both = sandbox.store.write({
      ...VALID,
      title: 'b',
      tags: ['decision', 'toolchain'],
    })
    const store = sandbox.reopen()
    expect(
      store.query({ tags: ['decision', 'toolchain'] }).map(e => e.id),
    ).toEqual([both.id])
    expect(store.query({ tags: ['decision'] })).toHaveLength(2)
    expect(
      store.query({ tags: ['decision'], limit: 1 }).map(e => e.id),
    ).toEqual([both.id])
  })
})
