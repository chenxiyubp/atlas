// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentTurnInput,
  ResidentTurnResult,
  ResidentTurnPort,
} from '../src/contracts.js'
import { FileAdmissionLedger } from '../src/ledger.js'
import { residentMailboxIdentity } from '../src/mailbox-identity.js'
import { ResidentNodeRuntime } from '../src/runtime.js'
import {
  ResidentTimingRecorder,
  type ResidentTimingEvent,
} from '../src/timings.js'
import { NodeTurnGate } from '../src/turn-gate.js'

const TEAM = 'atlas'
/**
 * One session behind three agents.
 *
 * The point is to make "two turns in the same session" reachable *without*
 * saying anything about how the gate is cut. If the gate is ever made
 * finer-grained — per session, per agent — this fixture keeps producing two
 * turns that share a session, and the assertion below keeps meaning the same
 * thing.
 */
const SHARED_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const AGENTS = ['reviewer', 'planner', 'archivist'] as const

let directory: string
let ledgers: FileAdmissionLedger[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-queue-'))
  ledgers = []
})

afterEach(() => {
  for (const ledger of ledgers) ledger.close()
  rmSync(directory, { recursive: true, force: true })
})

function ledgerFor(agent: string): FileAdmissionLedger {
  const ledger = new FileAdmissionLedger(
    join(directory, agent, 'admission.ndjson'),
  )
  ledgers.push(ledger)
  return ledger
}

class PerAgentMailbox implements ResidentMailboxPort {
  readonly boxes = new Map<string, ResidentMailboxMessage[]>()

  put(agent: string, message: ResidentMailboxMessage): void {
    const box = this.boxes.get(agent) ?? []
    box.push(message)
    this.boxes.set(agent, box)
  }

  async readAll(agent: string): Promise<readonly ResidentMailboxMessage[]> {
    return (this.boxes.get(agent) ?? []).map(item => ({ ...item }))
  }

  async markRead(
    agent: string,
    _team: string,
    snapshot: readonly ResidentMailboxMessage[],
  ): Promise<number> {
    const box = this.boxes.get(agent) ?? []
    let marked = 0
    for (const expected of snapshot) {
      const index = box.findIndex(
        item =>
          !item.read &&
          residentMailboxIdentity(item) === residentMailboxIdentity(expected),
      )
      const found = index < 0 ? undefined : box[index]
      if (found === undefined) continue
      box[index] = { ...found, read: true }
      marked++
    }
    return marked
  }
}

interface TurnSpan {
  readonly sessionId: string
  readonly enter: number
  readonly exit: number
}

/**
 * Records when each turn was inside the model, on a logical clock.
 *
 * A counter rather than `Date.now()` on purpose: two turns that begin in the
 * same millisecond would look disjoint on a wall clock, and this is exactly
 * the pair the assertion has to catch.
 */
class SpanRecordingTurn implements ResidentTurnPort {
  readonly spans: TurnSpan[] = []
  #tick = 0

  async isAccepted(): Promise<boolean> {
    return false
  }

  async execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult> {
    const enter = this.#tick++
    await onAccepted()
    // A real macrotask, so that anything running two turns concurrently would
    // interleave here rather than getting away with it.
    await new Promise(resolve => setTimeout(resolve, 5))
    this.spans.push({ sessionId: input.sessionId, enter, exit: this.#tick++ })
    return { outcome: 'completed', content: 'done' }
  }
}

function message(text: string): ResidentMailboxMessage {
  return {
    from: 'qianmo://node-a/planner',
    text,
    timestamp: '2026-08-12T00:00:00.000Z',
    read: false,
  }
}

function overlap(first: TurnSpan, second: TurnSpan): boolean {
  return first.enter < second.exit && second.enter < first.exit
}

/**
 * Wait out the turns a poll left running.
 *
 * Yields through the timer queue rather than spinning on `Promise.resolve()`:
 * the turns below wait on a real timer, and a microtask loop would starve it
 * for good.
 */
async function drain(gate: NodeTurnGate): Promise<void> {
  while (gate.active || gate.queued > 0) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

function buildRuntime(
  mailbox: PerAgentMailbox,
  turn: ResidentTurnPort,
  timings: ResidentTimingRecorder,
  gate: NodeTurnGate,
): ResidentNodeRuntime {
  return new ResidentNodeRuntime({
    node: 'node-b',
    team: TEAM,
    mailbox,
    turn,
    formatPrompt: messages => messages.map(item => item.text).join('\n'),
    timings,
    gate,
    agents: AGENTS.map(agent => ({
      agent,
      sessionId: SHARED_SESSION,
      ledger: ledgerFor(agent),
    })),
  })
}

describe('resident queue governance', () => {
  test('two turns of one session never overlap', async () => {
    const mailbox = new PerAgentMailbox()
    for (const agent of AGENTS) mailbox.put(agent, message(`work for ${agent}`))
    const turn = new SpanRecordingTurn()
    const gate = new NodeTurnGate()
    const runtime = buildRuntime(
      mailbox,
      turn,
      new ResidentTimingRecorder(),
      gate,
    )

    await runtime.pollAll()
    await drain(gate)

    expect(turn.spans).toHaveLength(AGENTS.length)
    // Stated as the invariant itself — no turn of a session was inside the
    // model while another turn of the same session was — and not as "the gate
    // is node-wide, therefore…". The day the gate gets finer, this is what has
    // to keep holding, and this is what will go red if it does not.
    const clashes = turn.spans.flatMap((first, index) =>
      turn.spans
        .slice(index + 1)
        .filter(
          second =>
            second.sessionId === first.sessionId && overlap(first, second),
        )
        .map(second => [first, second]),
    )
    expect(clashes).toEqual([])
  })

  test('every turn is stamped with the queue position it took', async () => {
    const mailbox = new PerAgentMailbox()
    for (const agent of AGENTS) mailbox.put(agent, message(`work for ${agent}`))
    const events: ResidentTimingEvent[] = []
    const gate = new NodeTurnGate()
    const runtime = buildRuntime(
      mailbox,
      new SpanRecordingTurn(),
      new ResidentTimingRecorder(event => events.push(event)),
      gate,
    )

    await runtime.pollAll()
    await drain(gate)

    const queued = events.filter(event => event.stage === 'queued')
    expect(queued).toHaveLength(AGENTS.length)
    // Three agents submitting into one gate: one goes straight to the front,
    // the next waits behind it, the third behind that.
    expect(queued.map(event => event.queueDepth).sort()).toEqual([1, 1, 2])
    // Every queued stage is followed by the admission it was waiting for.
    for (const event of queued) {
      expect(
        events.some(
          later =>
            later.stage === 'admitted' &&
            later.inputMessageId === event.inputMessageId,
        ),
      ).toBe(true)
    }
    // Observation does not become a decision anywhere else (hermes B8).
    expect(
      events.filter(event => event.stage !== 'queued' && 'queueDepth' in event),
    ).toEqual([])
  })
})
