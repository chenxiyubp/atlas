// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * roadmap P2.3 DoD ②: 软删除（废止）后条目不再被检索命中，但仍可审计查询.
 *
 * Both halves are asserted against the filesystem, not against a return value:
 * "still auditable" is worthless if the bytes are gone, and "no longer
 * recalled" is worthless if it only holds for the process that revoked it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStoreError } from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

const PROJECT = 'atlas'

let sandbox: Sandbox

beforeEach(() => {
  sandbox = createSandbox()
})

afterEach(() => {
  sandbox.dispose()
})

function seedDecision(): string {
  return sandbox.store.write({
    scope: { layer: 'project', projectKey: PROJECT },
    title: 'Sandbox choice',
    summary: 'M0 uses Dormice plus gVisor for the resident sandbox.',
    body: 'Superseded once the licensing review lands.',
    source: { kind: 'user', id: 'user:yuyongchang' },
    tags: ['decision'],
  }).id
}

describe('revocation is a mark, not a deletion', () => {
  test('a revoked entry stops being recalled — from a fresh store, at any asOf', () => {
    const id = seedDecision()
    expect(
      sandbox
        .reopen()
        .query({ text: 'dormice' })
        .map(e => e.id),
    ).toEqual([id])

    sandbox.clock.advance(86_400_000)
    sandbox.store.revoke(id, {
      reason: 'licensing review rejected the vendor',
      by: 'user:yuyongchang',
    })

    const reopened = sandbox.reopen()
    expect(reopened.query({ text: 'dormice' })).toEqual([])
    expect(reopened.query({})).toEqual([])
    expect(
      reopened.query({ layers: ['project'], projectKey: PROJECT }),
    ).toEqual([])
    // The ingest axis is not a point-in-time question: the store has withdrawn
    // the record, so asking about a moment before the revocation does not bring
    // it back into recall either.
    expect(
      reopened.query({
        text: 'dormice',
        asOf: new Date(Date.UTC(2026, 8, 20, 9, 0, 0)),
      }),
    ).toEqual([])
  })

  test('the revoked entry is still there for an audit, with who and why', () => {
    const id = seedDecision()
    const revokedAt = new Date(sandbox.clock.now().getTime() + 86_400_000)
    sandbox.clock.advance(86_400_000)
    sandbox.store.revoke(id, {
      reason: 'licensing review rejected the vendor',
      by: 'user:yuyongchang',
    })

    const reopened = sandbox.reopen()
    const audited = reopened.query({ includeRetired: true, text: 'dormice' })
    expect(audited).toHaveLength(1)
    const entry = audited[0]
    if (entry === undefined) {
      throw new Error('unreachable: length asserted above')
    }

    expect(entry.id).toBe(id)
    expect(entry.expiredAt).toBe(revokedAt.toISOString())
    expect(entry.retirement).toEqual({
      kind: 'revoked',
      reason: 'licensing review rejected the vendor',
      by: 'user:yuyongchang',
    })
    // Content intact — an audit that could not read the withdrawn claim would
    // not be an audit.
    expect(entry.summary).toBe(
      'M0 uses Dormice plus gVisor for the resident sandbox.',
    )
    expect(entry.body).toBe('Superseded once the licensing review lands.')
    // Direct lookup by the cited id keeps working, so an old citation can be
    // explained rather than silently resolving to nothing.
    expect(reopened.getEntry(id)?.expiredAt).toBe(entry.expiredAt)
    // And the bytes really are on disk.
    expect(existsSync(join(sandbox.root, 'project', PROJECT, `${id}.md`))).toBe(
      true,
    )
  })

  test('revoking twice is refused rather than rewriting the first reason', () => {
    const id = seedDecision()
    sandbox.store.revoke(id, { reason: 'first', by: 'a' })
    expect(() =>
      sandbox.store.revoke(id, { reason: 'second', by: 'b' }),
    ).toThrow(MemoryStoreError)
    expect(sandbox.reopen().getEntry(id)?.retirement?.reason).toBe('first')
  })

  test('revoking an unknown id fails loudly', () => {
    expect(() =>
      sandbox.store.revoke('qm-mem-9999', { reason: 'x', by: 'a' }),
    ).toThrow(MemoryStoreError)
  })
})

describe('the event axis is separate from the ingest axis', () => {
  test('an invalidated fact leaves recall for now but still answers about the past', () => {
    const id = sandbox.store.write({
      scope: { layer: 'project', projectKey: PROJECT },
      title: 'Registry TTL',
      summary: 'Agent registrations expire after 90 seconds.',
      body: 'Set during P2.1.',
      source: { kind: 'session', id: 'sess-1' },
      validAt: new Date(Date.UTC(2026, 8, 1)),
    }).id

    const invalidAt = new Date(Date.UTC(2026, 8, 15))
    sandbox.store.invalidate(id, invalidAt)

    const reopened = sandbox.reopen()
    // Asked about now: gone.
    expect(reopened.query({ text: '90 seconds' })).toEqual([])
    // Asked about a moment while it held: still there, and still live — no
    // retirement mark was written, because the record was never wrong.
    const historic = reopened.query({
      text: '90 seconds',
      asOf: new Date(Date.UTC(2026, 8, 10)),
    })
    expect(historic.map(e => e.id)).toEqual([id])
    expect(historic[0]?.expiredAt).toBeNull()
    expect(historic[0]?.retirement).toBeNull()
    expect(historic[0]?.invalidAt).toBe(invalidAt.toISOString())
  })

  test('a fact not yet valid is not recalled early', () => {
    sandbox.store.write({
      scope: { layer: 'baseline', period: '2026-10' },
      title: 'October contest window',
      summary: 'CUMCM finals week opens.',
      body: '',
      source: { kind: 'import', id: 'calendar' },
      validAt: new Date(Date.UTC(2026, 9, 1)),
    })
    expect(sandbox.reopen().query({ text: 'cumcm' })).toEqual([])
    expect(
      sandbox
        .reopen()
        .query({ text: 'cumcm', asOf: new Date(Date.UTC(2026, 9, 2)) }),
    ).toHaveLength(1)
  })
})
