// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from '../src/contracts.js'
import { FileAdmissionLedger } from '../src/ledger.js'
import { residentMailboxIdentity } from '../src/mailbox-identity.js'
import {
  ResidentMailboxReader,
  type ResidentMailboxReaderOptions,
} from '../src/reader.js'
import { NodeTurnGate, type NodeTurnRequest } from '../src/turn-gate.js'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MESSAGE_ID = '11111111-2222-4333-8444-555555555555'
const AGENT = 'reviewer'
const TEAM = 'atlas'

let directory: string
let ledger: FileAdmissionLedger

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-reader-'))
  ledger = new FileAdmissionLedger(join(directory, 'admission.ndjson'))
})

afterEach(() => {
  ledger.close()
  rmSync(directory, { recursive: true, force: true })
})

function message(
  overrides: Partial<ResidentMailboxMessage> = {},
): ResidentMailboxMessage {
  return {
    from: 'qianmo://node-a/planner',
    timestamp: '2026-08-12T00:00:00.000Z',
    text: '{"type":"qianmo.envelope","envelope":{"taskId":"task-1"}}',
    read: false,
    ...overrides,
  }
}

class MemoryMailbox implements ResidentMailboxPort {
  readonly messages: ResidentMailboxMessage[]
  markCalls: ResidentMailboxMessage[][] = []

  constructor(messages: ResidentMailboxMessage[]) {
    this.messages = messages
  }

  async readAll(): Promise<readonly ResidentMailboxMessage[]> {
    return this.messages.map(item => ({ ...item }))
  }

  async markRead(
    _agent: string,
    _team: string,
    snapshot: readonly ResidentMailboxMessage[],
    readBefore: Readonly<Record<string, number>>,
  ): Promise<number> {
    const remaining = new Map<string, number>()
    for (const expected of snapshot) {
      const identity = residentMailboxIdentity(expected)
      remaining.set(identity, (remaining.get(identity) ?? 0) + 1)
    }
    const readNow = new Map<string, number>()
    for (const item of this.messages) {
      if (!item.read) continue
      const identity = residentMailboxIdentity(item)
      readNow.set(identity, (readNow.get(identity) ?? 0) + 1)
    }
    for (const [identity, snapshotCount] of remaining) {
      const missing = Math.max(
        0,
        (readBefore[identity] ?? 0) +
          snapshotCount -
          (readNow.get(identity) ?? 0),
      )
      if (missing === 0) remaining.delete(identity)
      else remaining.set(identity, missing)
    }

    let marked = 0
    for (let index = 0; index < this.messages.length; index++) {
      const item = this.messages[index]
      if (!item || item.read) continue
      const identity = residentMailboxIdentity(item)
      const count = remaining.get(identity) ?? 0
      if (count === 0) continue
      this.messages[index] = { ...item, read: true }
      marked++
      if (count === 1) remaining.delete(identity)
      else remaining.set(identity, count - 1)
    }
    if (marked > 0) {
      this.markCalls.push(snapshot.map(item => ({ ...item })))
    }
    const unresolved = [...remaining.values()].reduce(
      (total, count) => total + count,
      0,
    )
    return snapshot.length - unresolved
  }
}

class MemoryTurn implements ResidentTurnPort {
  accepted = false
  executeCalls: ResidentTurnInput[] = []
  statusCalls: ResidentTurnInput[] = []
  onExecute?: () => void | Promise<void>

  async isAccepted(input: ResidentTurnInput): Promise<boolean> {
    this.statusCalls.push(input)
    return this.accepted
  }

  async execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult> {
    this.executeCalls.push(input)
    await this.onExecute?.()
    this.accepted = true
    await onAccepted()
    return { outcome: 'completed', content: 'done' }
  }
}

/**
 * The real gate, with a note of what it was asked for.
 *
 * A subclass rather than a stand-in: the wiring under test is what the reader
 * *says* to the gate, and everything the gate then does has to keep happening
 * for the rest of the assertions in the test to mean anything.
 */
class RecordingGate extends NodeTurnGate {
  readonly requests: NodeTurnRequest[] = []

  override run<T>(
    work: () => Promise<T>,
    request: NodeTurnRequest = {},
  ): Promise<T> {
    this.requests.push(request)
    return super.run(work, request)
  }
}

/** Wait out the turn the poll left running, and the callbacks behind it. */
async function turnSettled(
  mailboxReader: ResidentMailboxReader,
): Promise<void> {
  while (mailboxReader.gate.active) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

function reader(
  mailbox: MemoryMailbox,
  turn: ResidentTurnPort,
  extra: Partial<ResidentMailboxReaderOptions> = {},
): ResidentMailboxReader {
  return new ResidentMailboxReader({
    agent: AGENT,
    team: TEAM,
    resolveSession: () => SESSION_ID,
    mailbox,
    turn,
    ledger,
    formatPrompt: messages =>
      messages
        .map(item => `<teammate-message>${item.text}</teammate-message>`)
        .join('\n'),
    now: () => 1_000,
    newMessageId: () => MESSAGE_ID,
    ...extra,
  })
}

describe('resident mailbox admission', () => {
  test('fsyncs detection before prompt and flips read from the admission callback', async () => {
    const mailbox = new MemoryMailbox([message()])
    const turn = new MemoryTurn()
    let pendingBeforeExecute = false
    turn.onExecute = () => {
      pendingBeforeExecute = ledger.query().pending[0]?.phase === 'detected'
    }

    const result = await reader(mailbox, turn).poll()

    expect(pendingBeforeExecute).toBe(true)
    expect(result).toEqual({ detected: 1, recovered: 0, read: 1, abandoned: 0 })
    expect(mailbox.messages[0]?.read).toBe(true)
    expect(ledger.query().pending).toEqual([])
  })

  test('leaves rejected mailbox message classes unread', async () => {
    const structured = message({ text: '{"type":"permission_request"}' })
    const mailbox = new MemoryMailbox([structured])
    const turn = new MemoryTurn()

    const result = await reader(mailbox, turn, {
      accepts: item => item.text !== structured.text,
    }).poll()

    expect(result).toEqual({ detected: 0, recovered: 0, read: 0, abandoned: 0 })
    expect(turn.executeCalls).toHaveLength(0)
    expect(mailbox.messages[0]?.read).toBe(false)
    expect(ledger.query().pending).toEqual([])
  })

  test('fails promptly when a turn completes before admission', async () => {
    const mailbox = new MemoryMailbox([message()])
    const turn: ResidentTurnPort = {
      isAccepted: async () => false,
      execute: async () => ({ outcome: 'completed', content: 'done' }),
    }

    await expect(reader(mailbox, turn).poll()).rejects.toThrow(
      `resident ACP turn ${MESSAGE_ID} completed before input admission`,
    )
    expect(mailbox.messages[0]?.read).toBe(false)
    expect(ledger.query().pending[0]?.phase).toBe('detected')
  })

  test('returns after admission while retaining the gate until turn completion', async () => {
    const mailbox = new MemoryMailbox([message()])
    let finishTurn!: () => void
    const turnFinished = new Promise<void>(resolve => {
      finishTurn = resolve
    })
    const turn: ResidentTurnPort = {
      isAccepted: async () => false,
      execute: async (_input, onAccepted) => {
        await onAccepted()
        await turnFinished
        return { outcome: 'completed', content: 'done' }
      },
    }
    const mailboxReader = reader(mailbox, turn)

    const result = await mailboxReader.poll()

    expect(result).toEqual({ detected: 1, recovered: 0, read: 1, abandoned: 0 })
    expect(mailboxReader.gate.active).toBe(true)
    finishTurn()
    while (mailboxReader.gate.active) await Promise.resolve()
    expect(mailboxReader.gate.active).toBe(false)
  })

  test('leaves the message unread when ACP fails before admission', async () => {
    const mailbox = new MemoryMailbox([message()])
    const turn = new MemoryTurn()
    turn.onExecute = () => {
      throw new Error('ACP exited')
    }

    await expect(reader(mailbox, turn).poll()).rejects.toThrow('ACP exited')
    expect(mailbox.messages[0]?.read).toBe(false)
    expect(ledger.query().pending[0]?.phase).toBe('detected')
  })

  test('recovers a lost admission notification by querying the transcript UUID', async () => {
    const mailbox = new MemoryMailbox([message()])
    ledger.append({
      kind: 'detected',
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      detectedAt: 1,
      agent: AGENT,
      team: TEAM,
      readBefore: {},
      snapshot: [message()],
      prompt: 'durable prompt',
    })
    const turn = new MemoryTurn()
    turn.accepted = true

    const result = await reader(mailbox, turn).poll()

    expect(result.recovered).toBe(1)
    expect(turn.executeCalls).toHaveLength(0)
    expect(mailbox.messages[0]?.read).toBe(true)
    expect(ledger.query().pending).toEqual([])
  })

  test('an admitted record resumes at read flip without resubmitting', async () => {
    const mailbox = new MemoryMailbox([message()])
    ledger.append({
      kind: 'detected',
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      detectedAt: 1,
      agent: AGENT,
      team: TEAM,
      readBefore: {},
      snapshot: [message()],
      prompt: 'durable prompt',
    })
    ledger.append({ kind: 'admitted', messageId: MESSAGE_ID, at: 2 })
    const turn = new MemoryTurn()

    await reader(mailbox, turn).poll()

    expect(turn.statusCalls).toHaveLength(0)
    expect(turn.executeCalls).toHaveLength(0)
    expect(mailbox.messages[0]?.read).toBe(true)
  })

  test('read-before bookkeeping does not mark a later identical duplicate', async () => {
    const original = message({ read: true })
    const duplicate = message({ read: false })
    const mailbox = new MemoryMailbox([original, duplicate])
    ledger.append({
      kind: 'detected',
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      detectedAt: 1,
      agent: AGENT,
      team: TEAM,
      readBefore: { [residentMailboxIdentity(original)]: 0 },
      snapshot: [message()],
      prompt: 'durable prompt',
    })
    ledger.append({ kind: 'admitted', messageId: MESSAGE_ID, at: 2 })

    await reader(mailbox, new MemoryTurn()).poll()

    expect(mailbox.markCalls).toHaveLength(0)
    expect(mailbox.messages[1]?.read).toBe(false)
    expect(ledger.query().pending).toEqual([])
  })

  test('a selected snapshot narrows the batch and carries its correlation id', async () => {
    const first = message({ text: 'network task' })
    const second = message({
      text: 'later mail',
      timestamp: '2026-08-12T00:01:00.000Z',
    })
    const mailbox = new MemoryMailbox([first, second])
    const turn = new MemoryTurn()

    const result = await reader(mailbox, turn, {
      selectSnapshot: messages => messages.slice(0, 1),
      correlationId: messages =>
        messages.length === 1 ? 'net-msg-1' : undefined,
    }).poll()

    expect(result).toEqual({ detected: 1, recovered: 0, read: 1, abandoned: 0 })
    expect(turn.executeCalls).toHaveLength(1)
    expect(turn.executeCalls[0]?.networkMsgId).toBe('net-msg-1')
    expect(turn.executeCalls[0]?.prompt).toBe(
      '<teammate-message>network task</teammate-message>',
    )
    // The message left out of the snapshot is still unread, still waiting.
    expect(mailbox.messages[0]?.read).toBe(true)
    expect(mailbox.messages[1]?.read).toBe(false)
  })

  test('an entry past its task deadline is never detected, nor blocks the next', async () => {
    const dead = message({ text: 'task the sender already gave up on' })
    const live = message({
      text: 'task still worth a turn',
      timestamp: '2026-08-12T00:01:00.000Z',
    })
    const mailbox = new MemoryMailbox([dead, live])
    const turn = new MemoryTurn()

    const result = await reader(mailbox, turn, {
      deadlineOf: item =>
        item.text === dead.text ? Date.now() - 1 : Date.now() + 60_000,
    }).poll()

    expect(result).toEqual({ detected: 1, recovered: 0, read: 1, abandoned: 0 })
    expect(turn.executeCalls).toHaveLength(1)
    expect(turn.executeCalls[0]?.prompt).toContain('still worth a turn')
    // Dropped from eligibility rather than skipped as a batch: skipping would
    // leave it at the head of the queue forever, blocking everything behind it.
    expect(mailbox.messages[0]?.read).toBe(false)
    expect(mailbox.messages[1]?.read).toBe(true)
  })

  test('hands the gate the earliest deadline in the batch, and the session', async () => {
    const first = message({ text: 'due later' })
    const second = message({
      text: 'due sooner',
      timestamp: '2026-08-12T00:01:00.000Z',
    })
    const mailbox = new MemoryMailbox([first, second])
    const gate = new RecordingGate()
    const later = Date.now() + 90_000
    const sooner = Date.now() + 30_000

    await reader(mailbox, new MemoryTurn(), {
      gate,
      deadlineOf: item => (item.text === 'due later' ? later : sooner),
    }).poll()

    // The earliest deadline in the batch is the one the batch has to meet.
    expect(gate.requests).toEqual([
      { sessionId: SESSION_ID, deadlineAt: sooner },
    ])
  })

  test('the recovery path submits without a deadline', async () => {
    const mailbox = new MemoryMailbox([message()])
    ledger.append({
      kind: 'detected',
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      detectedAt: 1,
      agent: AGENT,
      team: TEAM,
      readBefore: {},
      snapshot: [message()],
      prompt: 'durable prompt',
    })
    const gate = new RecordingGate()

    await reader(mailbox, new MemoryTurn(), {
      gate,
      deadlineOf: () => Date.now() - 1,
    }).poll()

    // Both the status probe and the resubmit go in bare. A `detected` record
    // is a promise this node already wrote down, and the ledger has no way to
    // retire one except by reaching `read` — dropping the turn would strand it
    // and every later poll would rediscover, redrop and re-report it.
    expect(gate.requests).toEqual([
      { sessionId: SESSION_ID },
      { sessionId: SESSION_ID },
    ])
  })

  test('the read callback fires after the flip, the terminal one after the turn', async () => {
    const mailbox = new MemoryMailbox([message()])
    let releaseTurn!: () => void
    const turnFinished = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    const turn: ResidentTurnPort = {
      isAccepted: async () => false,
      execute: async (_input, onAccepted) => {
        await onAccepted()
        await turnFinished
        return { outcome: 'completed', content: 'the answer' }
      },
    }
    const order: string[] = []
    let readFlippedAtCallback = false
    const results: ResidentTurnResult[] = []
    const mailboxReader = reader(mailbox, turn, {
      correlationId: () => 'net-msg-1',
      onRead: input => {
        order.push('read')
        readFlippedAtCallback = mailbox.messages[0]?.read === true
        expect(input.networkMsgId).toBe('net-msg-1')
      },
      onTurnResult: (_input, result) => {
        order.push('result')
        results.push(result)
      },
    })

    await mailboxReader.poll()

    expect(order).toEqual(['read'])
    expect(readFlippedAtCallback).toBe(true)
    releaseTurn()
    await turnSettled(mailboxReader)
    expect(order).toEqual(['read', 'result'])
    expect(results).toEqual([{ outcome: 'completed', content: 'the answer' }])
  })

  test('a turn that fails after admission reports through the error callback', async () => {
    const mailbox = new MemoryMailbox([message()])
    const failure = new Error('ACP turn exploded')
    const turn: ResidentTurnPort = {
      isAccepted: async () => false,
      execute: async (_input, onAccepted) => {
        await onAccepted()
        throw failure
      },
    }
    const errors: unknown[] = []
    const results: ResidentTurnResult[] = []
    const mailboxReader = reader(mailbox, turn, {
      onTurnResult: (_input, result) => {
        results.push(result)
      },
      onTurnError: error => {
        errors.push(error)
      },
    })

    // The input was admitted and read, so the poll itself succeeds — the
    // failure belongs to the task, and only the error callback carries it.
    expect(await mailboxReader.poll()).toEqual({
      detected: 1,
      recovered: 0,
      read: 1,
      abandoned: 0,
    })
    await turnSettled(mailboxReader)
    expect(errors).toEqual([failure])
    expect(results).toEqual([])
    expect(mailbox.messages[0]?.read).toBe(true)
  })

  test('the resolved session is what the ledger records, so recovery resumes into it', async () => {
    const other = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    const mailbox = new MemoryMailbox([message()])
    const turn = new MemoryTurn()
    const seen: (readonly ResidentMailboxMessage[])[] = []

    await reader(mailbox, turn, {
      resolveSession: snapshot => {
        seen.push(snapshot)
        return other
      },
    }).poll()

    expect(seen).toEqual([[message()]])
    expect(turn.executeCalls[0]?.sessionId).toBe(other)
    // Crash recovery reads this field verbatim off the ledger, so the resolved
    // value has to be what was durably written — not something a restart would
    // have to resolve a second time (and possibly differently).
    const detected = readFileSync(join(directory, 'admission.ndjson'), 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(entry => entry.kind === 'detected')
    expect(detected?.sessionId).toBe(other)
  })

  test('the session release fires once, after the turn settles rather than at admission', async () => {
    const mailbox = new MemoryMailbox([message()])
    let releaseTurn!: () => void
    const turnFinished = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    const turn: ResidentTurnPort = {
      isAccepted: async () => false,
      execute: async (_input, onAccepted) => {
        await onAccepted()
        await turnFinished
        return { outcome: 'completed', content: 'done' }
      },
    }
    const released: string[] = []
    const mailboxReader = reader(mailbox, turn, {
      onSessionRelease: sessionId => {
        released.push(sessionId)
      },
    })

    await mailboxReader.poll()

    expect(released).toEqual([])
    releaseTurn()
    await turnSettled(mailboxReader)
    expect(released).toEqual([SESSION_ID])
  })

  test('a turn that dies before admission still releases its session', async () => {
    const mailbox = new MemoryMailbox([message()])
    const turn = new MemoryTurn()
    turn.onExecute = () => {
      throw new Error('ACP exited')
    }
    const released: string[] = []

    await expect(
      reader(mailbox, turn, {
        onSessionRelease: sessionId => {
          released.push(sessionId)
        },
      }).poll(),
    ).rejects.toThrow('ACP exited')

    expect(released).toEqual([SESSION_ID])
  })

  test('does not write a terminal read record when the snapshot vanished', async () => {
    const mailbox = new MemoryMailbox([])
    ledger.append({
      kind: 'detected',
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      detectedAt: 1,
      agent: AGENT,
      team: TEAM,
      readBefore: {},
      snapshot: [message()],
      prompt: 'durable prompt',
    })
    ledger.append({ kind: 'admitted', messageId: MESSAGE_ID, at: 2 })

    await expect(reader(mailbox, new MemoryTurn()).poll()).rejects.toThrow(
      'marked 0 of 1',
    )
    expect(ledger.query().pending[0]?.phase).toBe('admitted')
  })
})
