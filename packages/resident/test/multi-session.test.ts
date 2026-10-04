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
  ResidentTurnPort,
  ResidentTurnResult,
} from '../src/contracts.js'
import { FileAdmissionLedger } from '../src/ledger.js'
import { residentMailboxIdentity } from '../src/mailbox-identity.js'
import { ResidentNodeRuntime } from '../src/runtime.js'
import { NodeTurnGate } from '../src/turn-gate.js'
import { DEFAULT_CONTEXT, sessionKeyOf } from '../src/session-key.js'
import { MemoryResidentSessionStore } from '../src/session-store.js'
import {
  ResidentSessionManager,
  type ResidentAgentSession,
} from '../src/sessions.js'

const TEAM = 'atlas'
const AGENTS: readonly ResidentAgentSession[] = [
  { agent: 'reviewer', cwd: '/workspace/reviewer' },
  { agent: 'planner', cwd: '/workspace/planner' },
]

let directory: string
let ledgers: FileAdmissionLedger[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-multi-'))
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

/** The envelope shape `@qianmo/adapter` embeds in a base mailbox entry. */
function envelope(input: {
  readonly msgId: string
  readonly contextId?: string
}): string {
  return JSON.stringify({
    type: 'qianmo.envelope',
    envelope: {
      msgId: input.msgId,
      ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
    },
  })
}

function message(text: string, timestamp: string): ResidentMailboxMessage {
  return { from: 'qianmo://node-a/planner', text, timestamp, read: false }
}

/** The host's extractors, in the shape the runtime consumes them. */
function envelopeField(
  messages: readonly ResidentMailboxMessage[],
  field: 'msgId' | 'contextId',
): string | undefined {
  if (messages.length !== 1) return undefined
  try {
    const parsed: unknown = JSON.parse(messages[0]?.text ?? '')
    const wrapper = parsed as { envelope?: Record<string, unknown> }
    const value = wrapper.envelope?.[field]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function contextIdOf(
  messages: readonly ResidentMailboxMessage[],
): string | undefined {
  return envelopeField(messages, 'contextId')
}

function msgIdOf(
  messages: readonly ResidentMailboxMessage[],
): string | undefined {
  return envelopeField(messages, 'msgId')
}

class PerAgentMailbox implements ResidentMailboxPort {
  readonly boxes = new Map<string, ResidentMailboxMessage[]>()

  put(agent: string, ...messages: readonly ResidentMailboxMessage[]): void {
    const box = this.boxes.get(agent) ?? []
    box.push(...messages)
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
      if (index < 0) continue
      const found = box[index]
      if (found === undefined) continue
      box[index] = { ...found, read: true }
      marked++
    }
    return marked
  }
}

class RecordingTurn implements ResidentTurnPort {
  readonly calls: ResidentTurnInput[] = []

  async isAccepted(): Promise<boolean> {
    return false
  }

  async execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult> {
    this.calls.push(input)
    await onAccepted()
    return { outcome: 'completed', content: 'done' }
  }
}

class RecordingConnection {
  readonly opened: ResidentAgentSession[] = []
  #next = 0

  async initialize(): Promise<void> {}

  async newSession(input: ResidentAgentSession): Promise<string> {
    this.#next++
    this.opened.push(input)
    return `aaaaaaaa-bbbb-4ccc-8ddd-${this.#next.toString().padStart(12, '0')}`
  }

  async resumeSession(): Promise<void> {}
}

/** Only network entries are batched one at a time, exactly as the host does. */
function selectSnapshot(
  messages: readonly ResidentMailboxMessage[],
): readonly ResidentMailboxMessage[] {
  return messages.slice(0, 1)
}

/** Poll every agent and wait out the turns the polls left running. */
async function drain(
  runtime: ResidentNodeRuntime,
  gate: NodeTurnGate,
): Promise<void> {
  await runtime.pollAll()
  while (gate.active || gate.queued > 0) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('resident multi-session delivery', () => {
  test('pollAll routes every agent and every context into its own session', async () => {
    const mailbox = new PerAgentMailbox()
    const turn = new RecordingTurn()
    const connection = new RecordingConnection()
    const sessions = new ResidentSessionManager({
      connection,
      store: new MemoryResidentSessionStore(),
      agents: AGENTS,
    })
    await sessions.start()

    mailbox.put(
      'reviewer',
      message(
        envelope({ msgId: 'm1', contextId: 'alice' }),
        '2026-08-12T00:00:00.000Z',
      ),
      message(
        envelope({ msgId: 'm2', contextId: 'bob' }),
        '2026-08-12T00:00:01.000Z',
      ),
    )
    mailbox.put(
      'planner',
      message(
        envelope({ msgId: 'm3', contextId: 'alice' }),
        '2026-08-12T00:00:02.000Z',
      ),
      message(envelope({ msgId: 'm4' }), '2026-08-12T00:00:03.000Z'),
    )

    const gate = new NodeTurnGate()
    const runtime = new ResidentNodeRuntime({
      node: 'node-b',
      team: TEAM,
      mailbox,
      turn,
      formatPrompt: messages => messages.map(item => item.text).join('\n'),
      selectSnapshot,
      correlationId: msgIdOf,
      contextId: contextIdOf,
      sessions,
      gate,
      agents: AGENTS.map(agent => ({
        agent: agent.agent,
        ledger: ledgerFor(agent.agent),
      })),
    })

    // Four batches: two agents, two contexts each, drained one batch per poll.
    for (let round = 0; round < 2; round++) await drain(runtime, gate)

    const byMsgId = new Map(turn.calls.map(call => [call.networkMsgId, call]))
    expect(turn.calls).toHaveLength(4)
    expect(new Set(byMsgId.keys())).toEqual(new Set(['m1', 'm2', 'm3', 'm4']))

    const sessionOf = (msgId: string): string | undefined =>
      byMsgId.get(msgId)?.sessionId
    // Same agent, two requesters: two sessions. This is the cross-user history
    // bleed the whole package exists to prevent.
    expect(sessionOf('m1')).toBe(sessions.sessionOf('reviewer', 'alice'))
    expect(sessionOf('m2')).toBe(sessions.sessionOf('reviewer', 'bob'))
    expect(sessionOf('m1')).not.toBe(sessionOf('m2'))
    // Same contextId, different agent: still separate, because the key carries
    // both halves.
    expect(sessionOf('m3')).toBe(sessions.sessionOf('planner', 'alice'))
    expect(sessionOf('m1')).not.toBe(sessionOf('m3'))
    // No contextId at all: the default bucket opened at start(), not a new one.
    expect(sessionOf('m4')).toBe(sessions.sessionOf('planner', DEFAULT_CONTEXT))
    expect(new Set(turn.calls.map(call => call.sessionId)).size).toBe(4)

    // Each turn saw only its own message.
    for (const [msgId, call] of byMsgId) {
      expect(call.prompt).toContain(`"msgId":"${msgId}"`)
      expect(call.prompt.split('\n')).toHaveLength(1)
    }

    // Two agents opened at start plus three lazily created contexts.
    expect(connection.opened).toHaveLength(5)
    // Every one of them carries its OWN agent's workspace — including the
    // sessions opened for `planner`, which is not the first `--agent` on the
    // command line. A node that hands the wrong cwd down here gives one agent
    // read/write access to another's workspace (issue #44); the same claim is
    // made against the host's session state in
    // src/services/acp/agent/__tests__/workspaceIsolation.test.ts.
    const cwdOf = new Map(AGENTS.map(agent => [agent.agent, agent.cwd]))
    for (const opened of connection.opened) {
      expect(opened.cwd).toBe(cwdOf.get(opened.agent) as string)
    }
    expect(
      connection.opened.filter(opened => opened.agent === 'planner'),
    ).not.toHaveLength(0)
    expect(Object.keys(sessions.sessions()).sort()).toEqual(
      [
        sessionKeyOf('planner', DEFAULT_CONTEXT),
        sessionKeyOf('planner', 'alice'),
        sessionKeyOf('reviewer', DEFAULT_CONTEXT),
        sessionKeyOf('reviewer', 'alice'),
        sessionKeyOf('reviewer', 'bob'),
      ].sort(),
    )
  })

  test('a returning context lands back in the session it already had', async () => {
    const mailbox = new PerAgentMailbox()
    const turn = new RecordingTurn()
    const sessions = new ResidentSessionManager({
      connection: new RecordingConnection(),
      store: new MemoryResidentSessionStore(),
      agents: AGENTS,
    })
    await sessions.start()
    const gate = new NodeTurnGate()
    const runtime = new ResidentNodeRuntime({
      node: 'node-b',
      team: TEAM,
      mailbox,
      turn,
      formatPrompt: messages => messages.map(item => item.text).join('\n'),
      selectSnapshot,
      correlationId: msgIdOf,
      contextId: contextIdOf,
      sessions,
      gate,
      agents: AGENTS.map(agent => ({
        agent: agent.agent,
        ledger: ledgerFor(agent.agent),
      })),
    })

    mailbox.put(
      'reviewer',
      message(
        envelope({ msgId: 'm1', contextId: 'alice' }),
        '2026-08-12T00:00:00.000Z',
      ),
    )
    await drain(runtime, gate)
    mailbox.put(
      'reviewer',
      message(
        envelope({ msgId: 'm5', contextId: 'alice' }),
        '2026-08-12T00:01:00.000Z',
      ),
    )
    await drain(runtime, gate)

    expect(turn.calls).toHaveLength(2)
    const [first, second] = turn.calls
    expect(first?.sessionId).toBeDefined()
    expect(second?.sessionId).toBe(first?.sessionId ?? 'unset')
  })

  test('an agent needs exactly one session source, never both and never neither', () => {
    const base = {
      node: 'node-b',
      team: TEAM,
      mailbox: new PerAgentMailbox(),
      turn: new RecordingTurn(),
      formatPrompt: () => 'prompt',
      sessions: {
        sessionFor: async () => 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
        release: () => {},
      },
    }
    const binding = { agent: 'reviewer', ledger: ledgerFor('reviewer') }

    expect(
      () =>
        new ResidentNodeRuntime({
          node: base.node,
          team: base.team,
          mailbox: base.mailbox,
          turn: base.turn,
          formatPrompt: base.formatPrompt,
          agents: [binding],
        }),
    ).toThrow('needs exactly one session source')
    expect(
      () =>
        new ResidentNodeRuntime({
          ...base,
          agents: [
            { ...binding, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002' },
          ],
        }),
    ).toThrow('needs exactly one session source')
    expect(
      () => new ResidentNodeRuntime({ ...base, agents: [binding] }),
    ).not.toThrow()
  })
})
