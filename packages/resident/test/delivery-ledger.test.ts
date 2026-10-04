// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileDeliveryLedger,
  MAX_DELIVERY_ATTEMPTS,
} from '../src/delivery-ledger.js'

let directory: string
let path: string
let ledger: FileDeliveryLedger

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-delivery-'))
  path = join(directory, 'deliveries.ndjson')
  ledger = new FileDeliveryLedger(path)
})

afterEach(() => {
  ledger.close()
  rmSync(directory, { recursive: true, force: true })
})

const REPLY = {
  v: 0,
  msgId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  taskId: 'task-1',
  to: 'qianmo://node-a/planner',
  from: 'qianmo://node-b/reviewer',
  type: 'task.result',
  payload: { outcome: 'completed', content: 'done', completedAt: 5 },
}

function open(
  target: FileDeliveryLedger = ledger,
  taskId = 'task-1',
  peerNode = 'node-a',
): string {
  const id = target.open({
    taskId,
    peerNode,
    envelope: { ...REPLY, taskId },
  })
  expect(id).toBeDefined()
  return id as string
}

/** Re-open the same file, the way a restart does. */
function reopen(
  options: { readonly onError?: (error: unknown) => void } = {},
): FileDeliveryLedger {
  return new FileDeliveryLedger(path, options)
}

describe('the delivery obligation ledger', () => {
  test('a receipted reply retires; an unreceipted one is still owed after a restart', () => {
    // The traceless loss, in one test. Before this ledger, the second entry
    // below left no record anywhere that a peer was still waiting.
    const receipted = open(ledger, 'task-receipted')
    const lost = open(ledger, 'task-lost')
    ledger.attempt(receipted)
    ledger.attempt(lost)
    ledger.settle(receipted, 'delivered')

    const restarted = reopen()
    try {
      const owed = restarted.outstanding()
      expect(owed).toHaveLength(1)
      expect(owed[0]?.taskId).toBe('task-lost')
      expect(owed[0]?.deliveryId).toBe(lost)
      expect(owed[0]?.phase).toBe('attempting')
      expect(owed[0]?.attempts).toBe(1)
      // The envelope comes back byte for byte: this package stores what it was
      // handed and never re-mints it.
      expect(owed[0]?.envelope).toEqual({ ...REPLY, taskId: 'task-lost' })
    } finally {
      restarted.close()
    }
  })

  test('outstanding entries can be filtered to one peer', () => {
    open(ledger, 'task-a', 'node-a')
    open(ledger, 'task-c', 'node-c')
    expect(ledger.outstanding('node-a').map(entry => entry.taskId)).toEqual([
      'task-a',
    ])
    expect(ledger.outstanding()).toHaveLength(2)
  })

  test('attempts accumulate across restarts and stop at the ceiling', () => {
    const id = open()
    // Three lives, each claiming one attempt — the shape a peer that never
    // comes back produces.
    for (let life = 1; life <= MAX_DELIVERY_ATTEMPTS; life++) {
      const boot = reopen()
      try {
        expect(boot.attempt(id)).toBe(life)
      } finally {
        boot.close()
      }
    }

    const afterCeiling = reopen()
    try {
      // The next claim does not send: it abandons.
      expect(afterCeiling.attempt(id)).toBe(0)
      expect(afterCeiling.outstanding()).toEqual([])
    } finally {
      afterCeiling.close()
    }

    // And the retirement is durable, so a fourth life does not resurrect it.
    const later = reopen()
    try {
      expect(later.outstanding()).toEqual([])
    } finally {
      later.close()
    }
  })

  test('the abandoned record names why, so the file explains itself', () => {
    const id = open()
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      ledger.attempt(id)
    }
    ledger.attempt(id)

    const kinds = readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { kind: string; reason?: string })
    const abandoned = kinds.find(record => record.kind === 'abandoned')
    expect(abandoned).toBeDefined()
    expect(abandoned?.reason).toContain('without a receipt')
  })

  test('an explicit abandon retires the entry as well', () => {
    const id = open()
    ledger.abandon(id, 'the stored reply cannot be re-minted')
    expect(ledger.outstanding()).toEqual([])
    // Retired is retired: a later attempt claims nothing.
    expect(ledger.attempt(id)).toBe(0)
  })

  test('settling or abandoning an unknown id is a no-op, not a throw', () => {
    expect(() => ledger.settle('nope', 'delivered')).not.toThrow()
    expect(() => ledger.abandon('nope', 'gone')).not.toThrow()
    expect(ledger.attempt('nope')).toBe(0)
  })

  test('damage is stepped over and reported, unlike the admission ledger', () => {
    // The deliberate asymmetry, asserted so nobody "unifies" it: a torn
    // admission record means a promised message may be lost, so that ledger
    // throws. A torn delivery record means one reply may go out twice or not
    // at all — worse than nothing, better than a node that refuses to serve.
    const kept = open(ledger, 'task-kept')
    ledger.close()
    appendFileSync(path, 'this is not json\n')
    appendFileSync(path, '{"kind":"pending","deliveryId":"x"}\n')
    appendFileSync(path, '{"kind":"pending"')

    const errors: unknown[] = []
    const recovered = reopen({ onError: error => errors.push(error) })
    try {
      expect(() => recovered.outstanding()).not.toThrow()
      expect(recovered.outstanding().map(entry => entry.deliveryId)).toEqual([
        kept,
      ])
      const issues = recovered.integrityIssues()
      expect(issues.map(issue => issue.kind).sort()).toEqual([
        'corrupt_line',
        'corrupt_line',
        'torn_tail',
      ])
    } finally {
      recovered.close()
    }
  })

  test('an unreadable file fails open: no obligations, no throw, one report', () => {
    const errors: unknown[] = []
    // A path whose parent is a file: reading it fails with ENOTDIR, which is
    // the "the ledger itself is broken" shape rather than "no file yet".
    writeFileSync(path, 'not a directory')
    const broken = new FileDeliveryLedger(join(path, 'deliveries.ndjson'), {
      onError: error => errors.push(error),
    })
    try {
      expect(broken.outstanding()).toEqual([])
      expect(errors).toHaveLength(1)
      // And an open that cannot be written answers `undefined` rather than
      // handing back an id nothing is behind.
      expect(
        broken.open({ taskId: 't', peerNode: 'node-a', envelope: REPLY }),
      ).toBeUndefined()
    } finally {
      broken.close()
    }
  })

  test('an id from a failed open still behaves in memory for this life', () => {
    // Fail-open must not mean "retry forever": an entry whose attempts cannot
    // be written down still stops at the ceiling while this process is alive.
    writeFileSync(path, 'not a directory')
    const broken = new FileDeliveryLedger(join(path, 'deliveries.ndjson'), {
      onError: () => {},
    })
    try {
      broken.open({ taskId: 't', peerNode: 'node-a', envelope: REPLY })
      const owed = broken.outstanding()
      expect(owed).toHaveLength(1)
      const id = owed[0]?.deliveryId as string
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
        expect(broken.attempt(id)).toBe(attempt)
      }
      expect(broken.attempt(id)).toBe(0)
    } finally {
      broken.close()
    }
  })

  test('compaction keeps the attempt count and drops retired entries', () => {
    const kept = open(ledger, 'task-kept')
    ledger.attempt(kept)
    ledger.attempt(kept)
    // 128 retirements is the compaction trigger; drive it with throwaway
    // entries so the surviving one has to carry its history through the
    // rewrite.
    for (let index = 0; index < 128; index++) {
      const throwaway = open(ledger, `task-${index}`)
      ledger.settle(throwaway, 'delivered')
    }

    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line !== '')
    // Only the survivor and its attempt tally are left on disk.
    expect(lines).toHaveLength(2)

    const restarted = reopen()
    try {
      const owed = restarted.outstanding()
      expect(owed).toHaveLength(1)
      expect(owed[0]?.taskId).toBe('task-kept')
      // Had compaction dropped the count, the ceiling would reset on every
      // rewrite and a poison entry would be retried forever.
      expect(owed[0]?.attempts).toBe(2)
      expect(restarted.attempt(owed[0]?.deliveryId as string)).toBe(3)
    } finally {
      restarted.close()
    }
  })

  test('the file and its directory are private', () => {
    open()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
  })

  test('an empty path is refused at construction', () => {
    expect(() => new FileDeliveryLedger('  ')).toThrow(
      'delivery ledger path must not be empty',
    )
  })
})
