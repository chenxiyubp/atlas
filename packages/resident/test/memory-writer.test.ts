// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The partition writer (P16.W). Real store, real sidecar, real recall — the
 * claim under test is that what this module writes is what a turn of the same
 * `(agent, contextId)` reads, and nothing else is.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMemoryStore } from '@qianmo/memory'
import { recall } from '@qianmo/recall'
import {
  ResidentMemorySidecar,
  residentRecallScope,
} from '../src/memory-sidecar.js'
import {
  ResidentMemoryWriteError,
  invalidateResidentMemory,
  residentMemoryScope,
  revokeResidentMemory,
  writeResidentMemory,
  type ResidentMemorySource,
  type ResidentMemoryTarget,
} from '../src/memory-writer.js'

const OPERATOR: ResidentMemorySource = { kind: 'user', id: 'qm-cli:ops' }
const ALICE: ResidentMemoryTarget = { agent: 'reviewer', contextId: 'alice' }
const BOB: ResidentMemoryTarget = { agent: 'reviewer', contextId: 'bob' }

let directory: string
let store: FileMemoryStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-writer-'))
  store = new FileMemoryStore({ root: join(directory, 'memory') })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function remember(target: ResidentMemoryTarget, title: string): string {
  return writeResidentMemory(store, {
    ...target,
    title,
    summary: title,
    body: `${title} body`,
    source: OPERATOR,
  }).id
}

describe('the writer and the sidecar share one partition', () => {
  test('an entry written for (agent, context) is what that context recalls', () => {
    const id = remember(ALICE, 'runtime choice')
    const sidecar = new ResidentMemorySidecar({ store })

    expect(sidecar.render(ALICE)).toContain(id)
    expect(sidecar.render(BOB)).toBe('')
    expect(sidecar.render({ agent: 'planner', contextId: 'alice' })).toBe('')
  })

  test('the scope is the recall scope, for verbatim and digested contexts alike', () => {
    for (const contextId of [
      'alice',
      'default',
      'qianmo://node-a/x',
      '../..',
    ]) {
      const target = { agent: 'reviewer', contextId }
      const recallScope = residentRecallScope(target)
      expect(residentMemoryScope(target)).toEqual({
        layer: 'working',
        projectKey: recallScope.projectKey as string,
        taskId: recallScope.taskId as string,
      })
    }
  })

  test('the entry carries the provenance it was given, and nothing else', () => {
    const entry = writeResidentMemory(store, {
      ...ALICE,
      title: 'Runtime',
      summary: 'Bun is the runtime',
      body: 'decided 2026-08',
      tags: ['Decision'],
      source: OPERATOR,
    })
    expect(entry.source).toEqual(OPERATOR)
    expect(entry.tags).toEqual(['decision'])
    expect(store.getEntry(entry.id)).toEqual(entry)
  })
})

describe('a write has to name where it goes', () => {
  test('an empty context is refused instead of meaning "default"', () => {
    expect(() => remember({ agent: 'reviewer', contextId: '' }, 'x')).toThrow(
      ResidentMemoryWriteError,
    )
    expect(existsSync(join(directory, 'memory'))).toBe(false)
  })

  test('an invalid agent name is refused before anything reaches the disk', () => {
    expect(() =>
      remember({ agent: '../etc', contextId: 'alice' }, 'x'),
    ).toThrow()
    expect(existsSync(join(directory, 'memory'))).toBe(false)
  })

  test('only user and agent provenance is accepted, even from an untyped caller', () => {
    for (const kind of ['session', 'archive', 'import', 'root']) {
      expect(() =>
        writeResidentMemory(store, {
          ...ALICE,
          title: 't',
          summary: 's',
          body: '',
          source: { kind, id: 'x' } as unknown as ResidentMemorySource,
        }),
      ).toThrow('must come from a user or an agent')
    }
    expect(
      writeResidentMemory(store, {
        ...ALICE,
        title: 't',
        summary: 's',
        body: '',
        source: { kind: 'agent', id: 'authz-request-1' },
      }).source.kind,
    ).toBe('agent')
  })
})

describe('revoke and invalidate keep their two axes', () => {
  test('revoke withdraws the entry at every asOf and keeps it for audit', () => {
    const id = remember(ALICE, 'wrong record')
    const before = new Date(Date.now() - 60_000)

    const revoked = revokeResidentMemory(store, {
      ...ALICE,
      id,
      reason: 'recorded by mistake',
      by: 'qm-cli:ops',
    })

    expect(revoked.retirement).toEqual({
      kind: 'revoked',
      reason: 'recorded by mistake',
      by: 'qm-cli:ops',
    })
    const scope = residentRecallScope(ALICE)
    expect(recall(store, { scope }).entries).toEqual([])
    expect(recall(store, { scope, asOf: before }).entries).toEqual([])
    expect(store.getEntry(id)?.expiredAt).not.toBeNull()
  })

  test('invalidate ends the fact now and still answers about the past', () => {
    const id = remember(ALICE, 'port is 8080')
    const later = new Date(Date.now() + 60_000)
    const at = new Date(Date.now() + 30_000)

    const invalidated = invalidateResidentMemory(store, { ...ALICE, id, at })

    expect(invalidated.invalidAt).toBe(at.toISOString())
    expect(invalidated.expiredAt).toBeNull()
    const scope = residentRecallScope(ALICE)
    expect(
      recall(store, { scope, asOf: later }).entries.map(r => r.entry.id),
    ).toEqual([])
    expect(recall(store, { scope }).entries.map(r => r.entry.id)).toEqual([id])
  })

  test('an entry of another partition cannot be changed, and the refusal does not say it exists', () => {
    const bobs = remember(BOB, 'bob only')

    let foreign: unknown
    try {
      revokeResidentMemory(store, { ...ALICE, id: bobs, reason: 'r', by: 'b' })
    } catch (error) {
      foreign = error
    }
    let missing: unknown
    try {
      revokeResidentMemory(store, {
        ...ALICE,
        id: 'qm-mem-0000000000000000',
        reason: 'r',
        by: 'b',
      })
    } catch (error) {
      missing = error
    }

    expect(foreign).toBeInstanceOf(ResidentMemoryWriteError)
    expect(missing).toBeInstanceOf(ResidentMemoryWriteError)
    expect(String(foreign).replace(bobs, 'ID')).toBe(
      String(missing).replace('qm-mem-0000000000000000', 'ID'),
    )
    expect(() =>
      invalidateResidentMemory(store, { ...ALICE, id: bobs }),
    ).toThrow(ResidentMemoryWriteError)
    expect(store.getEntry(bobs)?.expiredAt).toBeNull()
    expect(store.getEntry(bobs)?.invalidAt).toBeNull()
  })
})
