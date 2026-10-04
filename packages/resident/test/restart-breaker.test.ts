// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AdmissionLedger,
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from '../src/contracts.js'
import { FileAdmissionLedger, MAX_ADMISSION_RECOVERIES } from '../src/ledger.js'
import { residentMailboxIdentity } from '../src/mailbox-identity.js'
import { ResidentMailboxReader } from '../src/reader.js'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const AGENT = 'reviewer'
const TEAM = 'atlas'

let directory: string
let ledgerPath: string
const open: FileAdmissionLedger[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-breaker-'))
  ledgerPath = join(directory, 'admission.ndjson')
})

afterEach(() => {
  for (const ledger of open.splice(0)) ledger.close()
  rmSync(directory, { recursive: true, force: true })
})

function message(text: string): ResidentMailboxMessage {
  return {
    from: 'qianmo://node-a/planner',
    timestamp: '2026-08-19T00:00:00.000Z',
    text,
    read: false,
  }
}

/** Just enough mailbox to detect one batch and flip it. */
class Mailbox implements ResidentMailboxPort {
  constructor(readonly messages: ResidentMailboxMessage[]) {}

  async readAll(): Promise<readonly ResidentMailboxMessage[]> {
    return this.messages.map(item => ({ ...item }))
  }

  async markRead(
    _agent: string,
    _team: string,
    snapshot: readonly ResidentMailboxMessage[],
  ): Promise<number> {
    const wanted = new Set(snapshot.map(residentMailboxIdentity))
    let marked = 0
    for (let index = 0; index < this.messages.length; index++) {
      const item = this.messages[index]
      if (item === undefined || item.read) continue
      if (!wanted.has(residentMailboxIdentity(item))) continue
      this.messages[index] = { ...item, read: true }
      marked++
    }
    return marked
  }
}

/** A turn that takes the node down before it can ever be admitted. */
class PoisonTurn implements ResidentTurnPort {
  executeCalls = 0

  async isAccepted(): Promise<boolean> {
    return false
  }

  async execute(): Promise<ResidentTurnResult> {
    this.executeCalls++
    throw new Error('this prompt kills the ACP child')
  }
}

/** A turn that works, for proving the node still serves after the breaker. */
class HealthyTurn implements ResidentTurnPort {
  readonly prompts: string[] = []

  async isAccepted(): Promise<boolean> {
    return false
  }

  async execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult> {
    this.prompts.push(input.prompt)
    await onAccepted()
    return { outcome: 'completed', content: 'done' }
  }
}

interface Life {
  readonly reader: ResidentMailboxReader
  readonly abandoned: {
    input: ResidentTurnInput
    attempts: number
    reason: string
  }[]
}

/**
 * One life of the node: a fresh ledger handle over the same file, and a fresh
 * reader over that.
 *
 * This is what a restart *is* from the ledger's point of view — the file
 * survives, everything in memory does not — so a test that models it this way
 * is testing the same thing a `kill -9` would.
 */
function boot(mailbox: Mailbox, turn: ResidentTurnPort): Life {
  const ledger = new FileAdmissionLedger(ledgerPath)
  open.push(ledger)
  const abandoned: Life['abandoned'] = []
  const reader = new ResidentMailboxReader({
    agent: AGENT,
    team: TEAM,
    resolveSession: () => SESSION_ID,
    mailbox,
    turn,
    ledger,
    formatPrompt: messages => messages.map(item => item.text).join('\n'),
    onAbandoned: (input, attempts, reason) => {
      abandoned.push({ input, attempts, reason })
    },
  })
  return { reader, abandoned }
}

function ledgerKinds(): string[] {
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

describe('the restart-storm breaker', () => {
  test('a poison record is abandoned after three restarts, and the node keeps serving', async () => {
    // The most important test in this batch: today this is an unbounded crash
    // loop. `reader.#recover` replays every pending `detected` record on the
    // next poll, and if that record is what killed the node, nothing anywhere
    // counted the replays. The supervisor's own `maxRapidFailures` does not
    // help — it parks the *node*, which is the outcome this breaker exists to
    // avoid.
    const mailbox = new Mailbox([message('poison')])
    const poison = new PoisonTurn()

    // Life 0 detects it and dies on the prompt. The record is now pending,
    // which is exactly the state that used to be unrecoverable.
    await expect(boot(mailbox, poison).reader.poll()).rejects.toThrow(
      'this prompt kills the ACP child',
    )
    expect(ledgerKinds()).toEqual(['detected'])

    // Restarts 1 and 2: the record gets its chances, and burns them.
    for (let restart = 1; restart < MAX_ADMISSION_RECOVERIES; restart++) {
      const life = boot(mailbox, poison)
      await expect(life.reader.poll()).rejects.toThrow(
        'this prompt kills the ACP child',
      )
      expect(life.abandoned).toEqual([])
    }
    expect(poison.executeCalls).toBe(MAX_ADMISSION_RECOVERIES)

    // Restart 3: the record is retired instead of replayed. The poll returns
    // rather than throwing, and the turn port is never touched.
    const breaking = boot(mailbox, poison)
    const result = await breaking.reader.poll()
    expect(result).toEqual({
      detected: 0,
      recovered: 0,
      read: 0,
      abandoned: 1,
    })
    expect(poison.executeCalls).toBe(MAX_ADMISSION_RECOVERIES)
    expect(ledgerKinds().at(-1)).toBe('abandoned')

    // The host is told, so the task behind it can be answered rather than
    // left to time out.
    expect(breaking.abandoned).toHaveLength(1)
    expect(breaking.abandoned[0]?.attempts).toBe(MAX_ADMISSION_RECOVERIES)
    expect(breaking.abandoned[0]?.reason).toContain('abandoned after')

    // …and the node is not parked. What the breaker protects is the node's
    // ability to serve *new* messages, and that is the half worth asserting.
    mailbox.messages.push(message('a healthy request'))
    const healthy = new HealthyTurn()
    const after = boot(mailbox, healthy)
    const served = await after.reader.poll()
    expect(served.detected).toBeGreaterThan(0)
    expect(healthy.prompts.join('\n')).toContain('a healthy request')
  })

  test('the count is durable, so it survives compaction and a reopen', async () => {
    const mailbox = new Mailbox([message('poison')])
    const poison = new PoisonTurn()
    await expect(boot(mailbox, poison).reader.poll()).rejects.toThrow()
    await expect(boot(mailbox, poison).reader.poll()).rejects.toThrow()

    // Compaction rewrites the file down to what is still pending. Had it
    // dropped the attempt tally, the ceiling would reset on every rewrite and
    // the poison record would be replayed forever — the exact bug this
    // breaker exists to close, reintroduced by a tidy-up.
    const compacting = new FileAdmissionLedger(ledgerPath)
    open.push(compacting)
    compacting.compact()
    expect(compacting.query().pending[0]?.attempts).toBe(1)

    const reopened = new FileAdmissionLedger(ledgerPath)
    open.push(reopened)
    expect(reopened.query().pending[0]?.attempts).toBe(1)
  })

  test('an already-admitted record is not counted: it has no prompt left to replay', async () => {
    // The breaker is aimed at "replay a prompt that kills the node". A record
    // that reached `admitted` only needs its read flip, so counting it would
    // retire work that was never the problem.
    const mailbox = new Mailbox([message('half done')])
    const ledger = new FileAdmissionLedger(ledgerPath)
    open.push(ledger)
    const record = {
      kind: 'detected' as const,
      messageId: '11111111-2222-4333-8444-555555555555',
      sessionId: SESSION_ID,
      detectedAt: 1,
      agent: AGENT,
      team: TEAM,
      readBefore: {},
      snapshot: [message('half done')],
      prompt: 'half done',
    }
    ledger.append(record)
    ledger.append({ kind: 'admitted', messageId: record.messageId, at: 2 })

    const abandoned: unknown[] = []
    const reader = new ResidentMailboxReader({
      agent: AGENT,
      team: TEAM,
      resolveSession: () => SESSION_ID,
      mailbox,
      turn: new PoisonTurn(),
      ledger,
      formatPrompt: messages => messages.map(item => item.text).join('\n'),
      maxRecoveries: 1,
      onAbandoned: input => {
        abandoned.push(input)
      },
    })

    // With `maxRecoveries: 1`, a counted record would be retired on sight.
    // This one is flipped and read instead.
    const result = await reader.poll()
    expect(abandoned).toEqual([])
    expect(result.abandoned).toBe(0)
    expect(result.read).toBe(1)
    expect(ledgerKinds().at(-1)).toBe('read')
  })

  test('a ledger that cannot record the attempt fails open rather than stopping the node', async () => {
    // The reliability kit must never be the reason a node stops. A breaker
    // that cannot write its counter degrades to the unbounded retry that
    // predates it — worse than this batch, better than a halt.
    const mailbox = new Mailbox([message('poison')])
    const poison = new PoisonTurn()
    await expect(boot(mailbox, poison).reader.poll()).rejects.toThrow()

    const ledger = new FileAdmissionLedger(ledgerPath)
    open.push(ledger)
    const failure = new Error('disk is gone')
    // A hand-written delegate rather than a patched instance: private fields
    // make prototype tricks illegal, and this states exactly which one call
    // is broken.
    const broken: AdmissionLedger = {
      append: value => ledger.append(value),
      query: () => ledger.query(),
      recordRecovery: () => {
        throw failure
      },
      abandon: (messageId, at, reason) => ledger.abandon(messageId, at, reason),
      compact: () => ledger.compact(),
      close: () => ledger.close(),
    }

    const errors: unknown[] = []
    const reader = new ResidentMailboxReader({
      agent: AGENT,
      team: TEAM,
      resolveSession: () => SESSION_ID,
      mailbox,
      turn: poison,
      ledger: broken,
      formatPrompt: messages => messages.map(item => item.text).join('\n'),
      onBreakerError: error => errors.push(error),
    })

    // Still tries the record — that is what fail-open means — and says on the
    // error channel why the counter did not move.
    await expect(reader.poll()).rejects.toThrow(
      'this prompt kills the ACP child',
    )
    expect(errors).toEqual([failure])
  })

  test('three is the ceiling, and it is spelled once', () => {
    expect(MAX_ADMISSION_RECOVERIES).toBe(3)
  })
})
