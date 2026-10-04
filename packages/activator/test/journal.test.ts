// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The write-ahead journal.
 *
 * The interesting cases here are all crash shapes, so they are produced by
 * writing the bytes a crash would leave behind rather than by describing them:
 * a truncated final line, a file that is only a truncated line, a settled
 * request, a request settled twice. The one thing the journal must never do is
 * lose an accepted request quietly, so every case checks what `pending()`
 * returns *and* what the audit trail says about what it could not read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import {
  FileRequestJournal,
  MemoryRequestJournal,
  type AcceptedRecord,
  defaultJournalPath,
} from '../src/journal.js'
import { SANDBOX, makeMessage } from './helpers.js'

let directory: string
let path: string
let audit: AuditLog
let journal: FileRequestJournal

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-activator-journal-'))
  path = join(directory, 'inflight.ndjson')
  audit = new AuditLog()
  journal = new FileRequestJournal(path, audit)
})

afterEach(() => {
  journal.close()
  rmSync(directory, { recursive: true, force: true })
})

function accepted(requestId: string, acceptedAt = 1_000): AcceptedRecord {
  return {
    kind: 'accepted',
    requestId,
    sandboxName: SANDBOX,
    acceptedAt,
    envelope: makeMessage({ msgId: `msg-${requestId}` }),
  }
}

describe('what is still owed', () => {
  test('a missing file is an empty journal, not an error', () => {
    expect(journal.pending()).toEqual([])
  })

  test('an accepted record is owed until a terminal record settles it', () => {
    journal.append(accepted('r1'))
    expect(journal.pending().map(record => record.requestId)).toEqual(['r1'])

    journal.append({
      kind: 'terminal',
      requestId: 'r1',
      at: 2_000,
      outcome: 'forwarded',
    })
    expect(journal.pending()).toEqual([])
  })

  test('an explicit failure settles a request just as forwarding does', () => {
    // Both are answers. Only silence is not.
    journal.append(accepted('r1'))
    journal.append({
      kind: 'terminal',
      requestId: 'r1',
      at: 2_000,
      outcome: 'failed',
      reason: 'target never became ready',
    })
    expect(journal.pending()).toEqual([])
  })

  test('outstanding records come back oldest first', () => {
    journal.append(accepted('late', 3_000))
    journal.append(accepted('early', 1_000))
    journal.append(accepted('middle', 2_000))
    expect(journal.pending().map(record => record.requestId)).toEqual([
      'early',
      'middle',
      'late',
    ])
  })

  test('the envelope survives the round trip intact', () => {
    const record = accepted('r1')
    journal.append(record)
    const [recovered] = journal.pending()
    expect(recovered?.envelope).toEqual(record.envelope)
  })

  test('a terminal record for an unknown request is harmless', () => {
    journal.append({
      kind: 'terminal',
      requestId: 'ghost',
      at: 1,
      outcome: 'forwarded',
    })
    expect(journal.pending()).toEqual([])
  })
})

describe('crash shapes', () => {
  test('a truncated final line is reported, not silently skipped', () => {
    journal.append(accepted('r1'))
    journal.close()
    // Exactly what a kill during an append leaves: a complete record, then a
    // partial one with no newline.
    appendFileSync(path, '{"kind":"accepted","requestId":"r2","sandbo')

    const pending = journal.pending()
    expect(pending.map(record => record.requestId)).toEqual(['r1'])
    const torn = audit.of(ActivatorEventType.JournalTorn)
    expect(torn).toHaveLength(1)
    expect(torn[0]?.detail.tornTailLines).toBe(1)
    expect(torn[0]?.detail.corruptLines).toBe(0)
  })

  test('a torn tail does not cost the records before it', () => {
    journal.append(accepted('r1'))
    journal.append(accepted('r2'))
    journal.close()
    appendFileSync(path, '{"kind":"acce')
    expect(journal.pending().map(record => record.requestId)).toEqual([
      'r1',
      'r2',
    ])
  })

  test('a file that is nothing but a torn line yields nothing and says so', () => {
    writeFileSync(path, '{"kind":"accepted"')
    expect(journal.pending()).toEqual([])
    expect(audit.count(ActivatorEventType.JournalTorn)).toBe(1)
  })

  test('a damaged line in the middle is counted separately from a torn tail', () => {
    // A crash can only truncate the end. Garbage in the middle means something
    // else went wrong, and an operator should be able to tell the two apart.
    journal.append(accepted('r1'))
    journal.close()
    const good = readFileSync(path, 'utf8')
    writeFileSync(path, `not json at all\n${good}`)

    expect(journal.pending().map(record => record.requestId)).toEqual(['r1'])
    const torn = audit.of(ActivatorEventType.JournalTorn)
    expect(torn[0]?.detail.corruptLines).toBe(1)
    expect(torn[0]?.detail.tornTailLines).toBe(0)
  })

  test('a well-formed line that is not a record is treated as damage', () => {
    writeFileSync(path, '{"kind":"something-else","requestId":"r1"}\n')
    expect(journal.pending()).toEqual([])
    expect(audit.count(ActivatorEventType.JournalTorn)).toBe(1)
  })

  test('an intact journal reports no damage', () => {
    journal.append(accepted('r1'))
    journal.pending()
    expect(audit.count(ActivatorEventType.JournalTorn)).toBe(0)
  })
})

describe('compaction', () => {
  test('settled records go, outstanding records stay', () => {
    journal.append(accepted('r1'))
    journal.append(accepted('r2'))
    journal.append({
      kind: 'terminal',
      requestId: 'r1',
      at: 2_000,
      outcome: 'forwarded',
    })
    journal.compact()

    expect(journal.pending().map(record => record.requestId)).toEqual(['r2'])
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(
      1,
    )
  })

  test('appending after compaction still works', () => {
    journal.append(accepted('r1'))
    journal.compact()
    journal.append(accepted('r2'))
    expect(journal.pending().map(record => record.requestId)).toEqual([
      'r1',
      'r2',
    ])
  })

  test('compaction leaves no temporary file behind', () => {
    journal.append(accepted('r1'))
    journal.compact()
    const leftovers = readFileSync(path, 'utf8')
    expect(leftovers).toContain('r1')
    expect(readdirSync(directory).sort()).toEqual(['inflight.ndjson'])
  })
})

describe('the in-memory variant behaves the same, minus durability', () => {
  test('it tracks the same outstanding set', () => {
    const memory = new MemoryRequestJournal()
    memory.append(accepted('r1'))
    memory.append(accepted('r2'))
    memory.append({
      kind: 'terminal',
      requestId: 'r1',
      at: 2,
      outcome: 'failed',
    })
    expect(memory.pending().map(record => record.requestId)).toEqual(['r2'])
    memory.compact()
    expect(memory.pending().map(record => record.requestId)).toEqual(['r2'])
  })
})

describe('where it lives', () => {
  test('the default path is derived, never assembled by hand', () => {
    const resolved = defaultJournalPath()
    expect(resolved).toContain('activator')
    expect(resolved.endsWith('inflight.ndjson')).toBe(true)
  })
})
