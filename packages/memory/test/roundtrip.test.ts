// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * roadmap P2.3 DoD ①: 写入 → 归档 → 检索 round-trip.
 *
 * The round trip is taken literally — every read in this file comes from a
 * store instance built after the write, so nothing can pass on in-memory state
 * that never reached the filesystem.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  archiveWorkingMemory,
  formatCitation,
  type MemoryEntry,
} from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

const PROJECT = 'atlas'
const TASK = 'task-2026-09-20'

let sandbox: Sandbox

beforeEach(() => {
  sandbox = createSandbox()
})

afterEach(() => {
  sandbox.dispose()
})

function seedWorkingMemory(): { runtime: MemoryEntry; scratch: MemoryEntry } {
  const runtime = sandbox.store.write({
    scope: { layer: 'working', projectKey: PROJECT, taskId: TASK },
    title: 'Runtime and test runner',
    summary: 'This project standardises on Bun as runtime and test runner.',
    body: 'Decided while wiring CI: no npm, no pnpm. **Why:** one lockfile, one runner.',
    source: { kind: 'session', id: 'sess-4f21' },
    tags: ['Decision', 'toolchain'],
  })
  sandbox.clock.advance(60_000)
  const scratch = sandbox.store.write({
    scope: { layer: 'working', projectKey: PROJECT, taskId: TASK },
    title: 'Scratch note',
    summary: 'Half-finished thought about renaming a local variable.',
    body: 'not worth keeping',
    source: { kind: 'agent', id: 'agent-1' },
    tags: ['scratch'],
  })
  return { runtime, scratch }
}

describe('write → archive → retrieve', () => {
  test('a working-memory write is retrievable from a fresh store', () => {
    const { runtime } = seedWorkingMemory()

    const found = sandbox.reopen().query({
      layers: ['working'],
      projectKey: PROJECT,
      taskId: TASK,
      text: 'bun',
    })

    expect(found.map(e => e.id)).toEqual([runtime.id])
    expect(found[0]?.source).toEqual({ kind: 'session', id: 'sess-4f21' })
    expect(found[0]?.createdAt).toBe(runtime.createdAt)
    // Tags are normalised on write, so a filter never depends on casing.
    expect(found[0]?.tags).toEqual(['decision', 'toolchain'])
  })

  test('archiving promotes into project memory and seals the working entry', () => {
    const { runtime, scratch } = seedWorkingMemory()
    sandbox.clock.advance(3_600_000)
    const archivedAt = sandbox.clock.now().toISOString()

    const result = archiveWorkingMemory(sandbox.store, {
      projectKey: PROJECT,
      taskId: TASK,
      by: 'user:dongzongyue',
      decide: entry => (entry.tags.includes('scratch') ? 'discard' : 'promote'),
    })

    expect(result.promoted).toHaveLength(1)
    expect(result.sealed.map(e => e.id)).toEqual([runtime.id])
    expect(result.discarded.map(e => e.id)).toEqual([scratch.id])

    const reopened = sandbox.reopen()

    // The promotion landed in the project table, reachable by a query that
    // knows nothing about the task it came from — which is the point of the
    // layer boundary.
    const recalled = reopened.query({
      layers: ['project'],
      projectKey: PROJECT,
      text: 'bun',
    })
    expect(recalled).toHaveLength(1)
    const promoted = recalled[0]
    if (promoted === undefined) {
      throw new Error('unreachable: length asserted above')
    }

    expect(promoted.derivedFrom).toEqual([runtime.id])
    expect(promoted.body).toBe(runtime.body)
    expect(promoted.source).toEqual(runtime.source)

    // The two axes disagree on purpose: project memory learned this an hour
    // after the fact became true, and both numbers survive the promotion.
    expect(promoted.createdAt).toBe(archivedAt)
    expect(promoted.validAt).toBe(runtime.validAt)
    expect(promoted.createdAt).not.toBe(promoted.validAt)

    // Working memory is empty afterwards — but by marking, not by deletion.
    expect(
      reopened.query({
        layers: ['working'],
        projectKey: PROJECT,
        taskId: TASK,
      }),
    ).toEqual([])
    const sealedOnDisk = reopened.getEntry(runtime.id)
    expect(sealedOnDisk?.retirement).toEqual({
      kind: 'archived',
      reason: `sedimented into project memory as ${promoted.id}`,
      by: 'user:dongzongyue',
    })
    expect(reopened.getEntry(scratch.id)?.retirement?.kind).toBe('revoked')
  })

  test('a recalled entry carries the citation AC-4 asks for, and it resolves', () => {
    seedWorkingMemory()
    sandbox.clock.advance(3_600_000)
    archiveWorkingMemory(sandbox.store, {
      projectKey: PROJECT,
      taskId: TASK,
      by: 'user:dongzongyue',
      decide: entry => (entry.tags.includes('scratch') ? 'discard' : 'promote'),
    })

    const reopened = sandbox.reopen()
    const promoted = reopened.query({ layers: ['project'], text: 'bun' })[0]
    if (promoted === undefined) {
      throw new Error('expected the promoted entry to be recallable')
    }

    const citation = formatCitation(promoted)
    expect(citation).toBe(
      `[${promoted.id} · session:sess-4f21 · ${promoted.createdAt}]`,
    )
    // The negative half of AC-4: a citation is only worth anything if a
    // fabricated one fails to resolve.
    expect(reopened.getEntry(promoted.id)?.id).toBe(promoted.id)
    expect(reopened.getEntry('qm-mem-doesnotexist')).toBeNull()
  })

  test('the three layers are separate tables, not one table with a column', () => {
    seedWorkingMemory()
    sandbox.store.write({
      scope: { layer: 'baseline', period: '2026-09' },
      title: 'September token baseline',
      summary: 'Median 3.1M tokens/day across resident nodes.',
      body: 'sampled daily',
      source: { kind: 'import', id: 'usage-export' },
      tags: ['baseline'],
    })

    const reopened = sandbox.reopen()
    // A working-layer query with a project filter cannot see the baseline
    // entry: baseline has no project key at all.
    expect(
      reopened
        .query({ projectKey: PROJECT })
        .every(e => e.scope.layer !== 'baseline'),
    ).toBe(true)
    const baseline = reopened.query({ layers: ['baseline'], period: '2026-09' })
    expect(baseline).toHaveLength(1)
    expect(baseline[0]?.scope).toEqual({ layer: 'baseline', period: '2026-09' })
    // And all three are still one store.
    expect(
      reopened
        .query({})
        .map(e => e.scope.layer)
        .sort(),
    ).toEqual(['baseline', 'working', 'working'])
  })
})
