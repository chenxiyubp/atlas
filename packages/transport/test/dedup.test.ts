// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, test } from 'bun:test'
import { LIMITS, createMessage, MessageType } from '@qianmo/protocol'
import { DedupTable, DedupVerdict } from '../src/index.js'
import { RECIPIENT, SENDER, makeMessage } from './helpers.js'

let clock = 1_000
const now = (): number => clock
let table: DedupTable

beforeEach(() => {
  clock = 1_000
  table = new DedupTable({ now })
})

describe('level 1 — the same envelope arriving again', () => {
  test('first sighting is fresh, the next two are duplicates', () => {
    const message = makeMessage({ createdAt: clock })
    expect(table.admit(message)).toBe(DedupVerdict.Fresh)
    expect(table.admit(message)).toBe(DedupVerdict.DuplicateMsgId)
    expect(table.admit(message)).toBe(DedupVerdict.DuplicateMsgId)
    expect(table.size).toBe(1)
  })

  test('two different messages are both fresh', () => {
    expect(
      table.admit(makeMessage({ createdAt: clock, payload: { a: 1 } })),
    ).toBe(DedupVerdict.Fresh)
    expect(
      table.admit(makeMessage({ createdAt: clock, payload: { a: 2 } })),
    ).toBe(DedupVerdict.Fresh)
    expect(table.size).toBe(2)
  })
})

describe('level 2 — the same work item, rebuilt', () => {
  test('a fresh msgId with the same fingerprint is still a duplicate', () => {
    const first = makeMessage({ createdAt: clock, taskId: 'task-7' })
    expect(table.admit(first)).toBe(DedupVerdict.Fresh)

    // What a sender that crashed and restarted produces: new msgId, new
    // createdAt, new traceId — same piece of work.
    clock += 5_000
    const rebuilt = createMessage({
      from: SENDER,
      to: RECIPIENT,
      type: MessageType.TaskRequest,
      payload: { do: 'review' },
      taskId: 'task-7',
      createdAt: clock,
    })
    expect(rebuilt.msgId).not.toBe(first.msgId)
    expect(rebuilt.fingerprint).toBe(first.fingerprint)
    expect(table.admit(rebuilt)).toBe(DedupVerdict.DuplicateFingerprint)
  })

  test('a different task with the same payload is not a duplicate', () => {
    expect(table.admit(makeMessage({ createdAt: clock, taskId: 't-1' }))).toBe(
      DedupVerdict.Fresh,
    )
    expect(table.admit(makeMessage({ createdAt: clock, taskId: 't-2' }))).toBe(
      DedupVerdict.Fresh,
    )
  })
})

describe('entries expire at the delivery deadline', () => {
  test('a retransmission after the deadline is no longer remembered', () => {
    const message = makeMessage({ createdAt: clock })
    expect(table.admit(message)).toBe(DedupVerdict.Fresh)

    clock += LIMITS.defaultTtlMs - 1
    expect(table.hasMsgId(message.msgId)).toBe(true)

    // Past `createdAt + deliverTtlMs` the envelope is `expired` anyway, so
    // the deadline check — not dedup — is what refuses it from here on.
    clock += 2
    expect(table.hasMsgId(message.msgId)).toBe(false)
    expect(table.admit(message)).toBe(DedupVerdict.Fresh)
  })

  test('pruning drops exactly the expired entries', () => {
    table.admit(makeMessage({ createdAt: clock, payload: { a: 1 } }))
    table.admit(makeMessage({ createdAt: clock + 10_000, payload: { a: 2 } }))
    expect(table.size).toBe(2)
    clock += LIMITS.defaultTtlMs + 1
    expect(table.pruneExpired()).toBe(1)
    expect(table.size).toBe(1)
  })
})

describe('failure handling and bounds', () => {
  test('forget puts a message back in play after a handler failure', () => {
    const message = makeMessage({ createdAt: clock })
    expect(table.admit(message)).toBe(DedupVerdict.Fresh)
    table.forget(message)
    expect(table.admit(message)).toBe(DedupVerdict.Fresh)
  })

  test('the table stays bounded under a flood', () => {
    const small = new DedupTable({ now, maxEntries: 8 })
    for (let index = 0; index < 50; index += 1) {
      small.admit(makeMessage({ createdAt: clock, payload: { index } }))
    }
    expect(small.size).toBe(8)
  })

  test('clear empties both levels', () => {
    const message = makeMessage({ createdAt: clock })
    table.admit(message)
    table.clear()
    expect(table.size).toBe(0)
    expect(table.admit(message)).toBe(DedupVerdict.Fresh)
  })
})
