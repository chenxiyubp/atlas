// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P7.2's two DoD sentences, taken literally.
 *
 * 1. *用 trace_id 能还原完整消息链（含被丢弃、被限流、被去重的消息）*
 * 2. *审计日志的修改尝试被拒*
 *
 * The second is the one worth reading the assertions of: this file tests the
 * three separate claims `trail.ts` makes — the writer cannot modify, an edit is
 * detectable, and an edit is **not** prevented — including the last one, so
 * nobody reads the suite and comes away thinking the file is immutable.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AuditSource,
  AuditTrail,
  GENESIS_PREVIOUS,
  digestOf,
  formatChain,
  queryTrail,
  readTrail,
  reconstructChain,
} from '../src/index.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function trailPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-audit-'))
  dirs.push(dir)
  return join(dir, 'trail', 'audit.ndjson')
}

const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const OTHER_TRACE = '00-11112222333344445555666677778888-00f067aa0ba902b7-01'

/** A trail with one whole cross-node task on it, refusals included. */
function writeStory(path: string): AuditTrail {
  const trail = new AuditTrail(path)
  const at = 1_800_000_000_000
  trail.append({
    at,
    source: AuditSource.Transport,
    kind: 'message.accepted',
    traceId: TRACE,
    taskId: 'task-1',
    msgId: 'msg-1',
    node: 'node-b',
    peer: 'qianmo://node-a/planner',
    outcome: 'ok',
  })
  trail.append({
    at: at + 5,
    source: AuditSource.Transport,
    kind: 'message.duplicate',
    traceId: TRACE,
    taskId: 'task-1',
    msgId: 'msg-1',
    node: 'node-b',
    // A retransmission the receiver absorbed. Invisible unless the trail keeps
    // it, and "why did the sender see two receipts" is unanswerable without it.
    outcome: 'dropped',
    detail: { level: 'duplicate-msgid' },
  })
  trail.append({
    at: at + 10,
    source: AuditSource.Router,
    kind: 'rate_limited',
    traceId: TRACE,
    taskId: 'task-1',
    msgId: 'msg-2',
    node: 'node-b',
    outcome: 'refused',
    code: 'E_RATE_LIMITED',
  })
  trail.append({
    at: at + 20,
    source: AuditSource.Adapter,
    kind: 'mailbox.written',
    traceId: TRACE,
    taskId: 'task-1',
    msgId: 'msg-1',
    node: 'node-b',
    outcome: 'ok',
  })
  trail.append({
    at: at + 40,
    source: AuditSource.Resident,
    kind: 'ack.sent',
    traceId: TRACE,
    taskId: 'task-1',
    msgId: 'msg-3',
    node: 'node-b',
    outcome: 'ok',
  })
  // A different task entirely, to prove the query does not sweep it in.
  trail.append({
    at: at + 41,
    source: AuditSource.Router,
    kind: 'loop_detected',
    traceId: OTHER_TRACE,
    taskId: 'task-9',
    node: 'node-b',
    outcome: 'refused',
    code: 'E_LOOP',
  })
  return trail
}

describe('the chain a trace_id rebuilds', () => {
  test('includes the dropped and the refused, not just what worked', () => {
    const path = trailPath()
    writeStory(path).close()

    const { records, intact } = readTrail(path)
    expect(intact).toBe(true)
    const chain = reconstructChain(records, TRACE)
    expect(chain).not.toBeNull()
    if (chain === null) return

    expect(chain.records).toHaveLength(5)
    expect(chain.dropped).toBe(1)
    expect(chain.refused).toBe(1)
    expect(chain.taskIds).toEqual(['task-1'])
    expect(chain.msgIds).toEqual(['msg-1', 'msg-2', 'msg-3'])
    expect(chain.sources).toEqual([
      AuditSource.Transport,
      AuditSource.Router,
      AuditSource.Adapter,
      AuditSource.Resident,
    ])
    // The other task stayed out.
    expect(chain.records.some(record => record.taskId === 'task-9')).toBe(false)
  })

  test('matches on the trace-id segment, not the whole traceparent', () => {
    // The parent-id changes at every hop by design (§7.1). Matching the full
    // header would return one hop and look like it worked.
    const path = trailPath()
    const trail = new AuditTrail(path)
    trail.append({
      at: 1,
      source: AuditSource.Transport,
      kind: 'message.accepted',
      traceId: TRACE,
      outcome: 'ok',
    })
    trail.append({
      at: 2,
      source: AuditSource.Router,
      kind: 'forwarded',
      // Same trace, next hop: only the parent-id moved.
      traceId: '00-4bf92f3577b34da6a3ce929d0e0e4736-aaaaaaaaaaaaaaaa-01',
      outcome: 'ok',
    })
    trail.close()

    const { records } = readTrail(path)
    const chain = reconstructChain(records, TRACE)
    expect(chain?.records).toHaveLength(2)
    // A bare segment finds the same chain.
    expect(
      reconstructChain(records, '4bf92f3577b34da6a3ce929d0e0e4736')?.records,
    ).toHaveLength(2)
  })

  test('ordered by seq, not by timestamp', () => {
    // Two nodes' clocks disagree; sorting by `at` can put an ack before the
    // message it answers.
    const path = trailPath()
    const trail = new AuditTrail(path)
    trail.append({
      at: 1_000,
      source: AuditSource.Transport,
      kind: 'message.accepted',
      traceId: TRACE,
      outcome: 'ok',
    })
    trail.append({
      at: 900,
      source: AuditSource.Resident,
      kind: 'ack.sent',
      traceId: TRACE,
      outcome: 'ok',
    })
    trail.close()
    const chain = reconstructChain(readTrail(path).records, TRACE)
    expect(chain?.records.map(record => record.kind)).toEqual([
      'message.accepted',
      'ack.sent',
    ])
  })

  test('an unknown trace is null rather than an empty chain', () => {
    const path = trailPath()
    writeStory(path).close()
    expect(
      reconstructChain(readTrail(path).records, OTHER_TRACE.replace('1', '2')),
    ).toBeNull()
  })

  test('the printed chain shows the refusals and no payload', () => {
    const path = trailPath()
    writeStory(path).close()
    const chain = reconstructChain(readTrail(path).records, TRACE)
    if (chain === null) throw new Error('expected a chain')
    const text = formatChain(chain)
    expect(text).toContain('1 refused')
    expect(text).toContain('E_RATE_LIMITED')
    expect(text).not.toContain('payload')
  })
})

describe('querying by agent and by time window', () => {
  test('an agent matches on node, peer, or an address in the detail', () => {
    const path = trailPath()
    writeStory(path).close()
    const records = readTrail(path).records
    expect(
      queryTrail(records, { agent: 'qianmo://node-a/planner' }),
    ).toHaveLength(1)
    expect(queryTrail(records, { agent: 'node-b' }).length).toBeGreaterThan(3)
  })

  test('a time window is inclusive on both ends', () => {
    const path = trailPath()
    writeStory(path).close()
    const records = readTrail(path).records
    const at = 1_800_000_000_000
    expect(queryTrail(records, { from: at, to: at + 10 })).toHaveLength(3)
    expect(queryTrail(records, { from: at + 41 })).toHaveLength(1)
  })

  test('outcome filters exist but the chain reconstruction never uses them', () => {
    const path = trailPath()
    writeStory(path).close()
    const records = readTrail(path).records
    expect(queryTrail(records, { outcome: 'refused' })).toHaveLength(2)
    // The chain keeps everything: a story with the refusals filtered out is a
    // different story.
    expect(reconstructChain(records, TRACE)?.records).toHaveLength(5)
  })
})

describe('what "cannot be changed" means here', () => {
  test('claim 1 — the writer has no method that modifies', () => {
    const names = [
      ...Object.getOwnPropertyNames(AuditTrail.prototype),
      ...Object.getOwnPropertyNames(new AuditTrail(trailPath())),
    ]
    expect(
      names.filter(name =>
        /update|delete|remove|truncate|rewrite|seek|clear/i.test(name),
      ),
    ).toEqual([])
  })

  test('claim 1 — records are only ever appended, never replaced', () => {
    const path = trailPath()
    const trail = new AuditTrail(path)
    const first = trail.append({
      at: 1,
      source: AuditSource.Router,
      kind: 'loop_detected',
      outcome: 'refused',
    })
    trail.append({
      at: 2,
      source: AuditSource.Router,
      kind: 'rate_limited',
      outcome: 'refused',
    })
    trail.close()
    const { records } = readTrail(path)
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual(first)
    expect(records[0]?.prev).toBe(GENESIS_PREVIOUS)
    expect(records[1]?.prev).toBe(digestOf(first))
  })

  test('claim 2 — editing a line breaks the chain, and the break is located', () => {
    const path = trailPath()
    writeStory(path).close()
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    const tampered = JSON.parse(lines[2] as string) as Record<string, unknown>
    // Somebody would rather the rate-limited message had been accepted.
    tampered['outcome'] = 'ok'
    lines[2] = JSON.stringify(tampered)
    writeFileSync(path, `${lines.join('\n')}\n`)

    const result = readTrail(path)
    expect(result.intact).toBe(false)
    // The edit itself parses; what gives it away is that everything after it no
    // longer hashes.
    expect(result.issues[0]?.kind).toBe('broken_chain')
    expect(result.issues[0]?.seq).toBe(4)
  })

  test('claim 2 — deleting a line is caught too', () => {
    const path = trailPath()
    writeStory(path).close()
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    lines.splice(2, 1)
    writeFileSync(path, `${lines.join('\n')}\n`)
    const result = readTrail(path)
    expect(result.intact).toBe(false)
    expect(result.issues.map(issue => issue.kind)).toContain('out_of_order')
    expect(result.issues.map(issue => issue.kind)).toContain('broken_chain')
  })

  test('claim 3 — a full rewrite that recomputes the chain is NOT detected', () => {
    // Stated as a test on purpose. This is the limit of what a hash chain in a
    // file the operator can write buys, and a suite that omitted it would leave
    // the reader believing the file is immutable. Preventing this needs an
    // append-only mount or a witness off the machine — M0 has neither.
    const path = trailPath()
    writeStory(path).close()
    const original = readTrail(path).records
    const rewritten = original
      .filter(record => record.outcome !== 'refused')
      .map((record, index) => ({ ...record, seq: index + 1 }))
    let previous = GENESIS_PREVIOUS
    const relinked = rewritten.map(record => {
      const next = { ...record, prev: previous }
      previous = digestOf(next)
      return next
    })
    writeFileSync(
      path,
      `${relinked.map(record => JSON.stringify(record)).join('\n')}\n`,
    )
    const result = readTrail(path)
    expect(result.intact).toBe(true)
    expect(result.records).toHaveLength(4)
  })

  test('a crash mid-write is a torn tail, not tampering', () => {
    const path = trailPath()
    writeStory(path).close()
    appendFileSync(path, '{"seq":7,"at":1,"sou')
    const result = readTrail(path)
    expect(result.issues).toEqual([{ line: 7, kind: 'torn_tail' }])
    // And the records before it are still readable.
    expect(result.records).toHaveLength(6)
  })

  test('a restart continues the chain instead of starting a new one', () => {
    // A fresh chain per process would leave a break that looks exactly like
    // tampering, and an integrity check that cries wolf on every restart is one
    // nobody reads.
    const path = trailPath()
    const first = new AuditTrail(path)
    first.append({
      at: 1,
      source: AuditSource.Router,
      kind: 'loop_detected',
      outcome: 'refused',
    })
    first.close()

    const second = new AuditTrail(path)
    second.append({
      at: 2,
      source: AuditSource.Router,
      kind: 'rate_limited',
      outcome: 'refused',
    })
    second.close()

    const result = readTrail(path)
    expect(result.intact).toBe(true)
    expect(result.records.map(record => record.seq)).toEqual([1, 2])
  })

  test('the file and its directory are not world-readable', () => {
    const path = trailPath()
    const trail = new AuditTrail(path)
    trail.append({
      at: 1,
      source: AuditSource.Router,
      kind: 'loop_detected',
      outcome: 'refused',
    })
    trail.close()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  test('reading a trail that does not exist is empty, not an error', () => {
    expect(readTrail(trailPath())).toEqual({
      records: [],
      issues: [],
      intact: true,
      // No file, and a reader must be able to tell that from an empty one:
      // "this node has written nothing yet" and "the trail never reached me"
      // are the same zero records and completely different situations.
      present: false,
    })
  })

  test('a trail that exists and holds nothing is present and empty', () => {
    const path = trailPath()
    new AuditTrail(path).ensure()
    expect(readTrail(path)).toEqual({
      records: [],
      issues: [],
      intact: true,
      present: true,
    })
  })

  test('ensure creates the file before any record is appended', () => {
    const path = trailPath()
    const trail = new AuditTrail(path)
    expect(existsSync(path)).toBe(false)
    trail.ensure()
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).size).toBe(0)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    trail.close()
  })
})
