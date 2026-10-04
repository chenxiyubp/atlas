// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdmissionRecord } from '../src/contracts.js'
import { FileAdmissionLedger } from '../src/ledger.js'

const MESSAGE_ID = '11111111-2222-4333-8444-555555555555'
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let directory: string
let path: string
let ledger: FileAdmissionLedger

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-ledger-'))
  path = join(directory, 'resident', 'admission.ndjson')
  ledger = new FileAdmissionLedger(path)
})

afterEach(() => {
  ledger.close()
  rmSync(directory, { recursive: true, force: true })
})

function detected(): Extract<AdmissionRecord, { kind: 'detected' }> {
  return {
    kind: 'detected',
    messageId: MESSAGE_ID,
    sessionId: SESSION_ID,
    detectedAt: 1,
    agent: 'reviewer',
    team: 'atlas',
    readBefore: {},
    snapshot: [
      {
        from: 'qianmo://node-a/planner',
        timestamp: '2026-08-12T00:00:00.000Z',
        text: '{"type":"qianmo.envelope"}',
        read: false,
      },
    ],
    prompt: '<teammate-message>payload</teammate-message>',
  }
}

describe('durable admission ledger', () => {
  test('advances detected to admitted to read without going backwards', () => {
    ledger.append(detected())
    expect(ledger.query().pending).toEqual([
      { ...detected(), attempts: 0, phase: 'detected' },
    ])

    ledger.append({ kind: 'admitted', messageId: MESSAGE_ID, at: 2 })
    expect(ledger.query().pending[0]?.phase).toBe('admitted')

    ledger.append({ kind: 'read', messageId: MESSAGE_ID, at: 3 })
    expect(ledger.query()).toEqual({ pending: [], integrityIssues: [] })
  })

  test('uses private directory and file modes', () => {
    ledger.append(detected())

    expect(statSync(join(directory, 'resident')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('rejects malformed records and unknown fields at runtime', () => {
    expect(() =>
      ledger.append({
        ...detected(),
        token: 'secret',
      } as unknown as AdmissionRecord),
    ).toThrow('invalid admission record')
    expect(ledger.query().pending).toEqual([])
  })

  test('records how the memory block was retrieved, through compaction and reload', () => {
    ledger.append({ ...detected(), retrieval: 'hybrid' })
    ledger.compact()
    ledger.close()

    const reopened = new FileAdmissionLedger(path)
    try {
      const result = reopened.query()
      expect(result.integrityIssues).toEqual([])
      expect(result.pending[0]?.retrieval).toBe('hybrid')
    } finally {
      reopened.close()
    }
  })

  test('rejects a retrieval mode it does not know', () => {
    expect(() =>
      ledger.append({
        ...detected(),
        retrieval: 'semantic-only',
      } as unknown as AdmissionRecord),
    ).toThrow('invalid admission record')
  })

  test('reports a torn tail and refuses to compact damage', () => {
    ledger.append(detected())
    ledger.close()
    appendFileSync(path, '{"kind":"admitted"')

    expect(ledger.query().integrityIssues).toEqual([
      { line: 2, kind: 'torn_tail' },
    ])
    expect(() => ledger.compact()).toThrow('damaged admission ledger')
  })

  test('compaction keeps only the latest pending phase', () => {
    ledger.append(detected())
    ledger.append({ kind: 'admitted', messageId: MESSAGE_ID, at: 2 })
    ledger.compact()

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}').kind).toBe('detected')
    expect(JSON.parse(lines[1] ?? '{}')).toEqual({
      kind: 'admitted',
      messageId: MESSAGE_ID,
      at: 2,
    })
    expect(ledger.query().pending[0]).toEqual({
      ...detected(),
      attempts: 0,
      phase: 'admitted',
      admittedAt: 2,
    })
  })

  test('automatically compacts terminal history after a bounded number of reads', () => {
    for (let index = 0; index < 128; index++) {
      const messageId = `11111111-2222-4333-8444-${index.toString().padStart(12, '0')}`
      ledger.append({ ...detected(), messageId })
      ledger.append({ kind: 'read', messageId, at: index + 1 })
    }

    expect(readFileSync(path, 'utf8')).not.toBe('')
    expect(ledger.query()).toEqual({ pending: [], integrityIssues: [] })
    expect(readFileSync(path, 'utf8')).toBe('')
  })
})
