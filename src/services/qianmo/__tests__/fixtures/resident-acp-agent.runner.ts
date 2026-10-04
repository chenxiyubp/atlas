// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Agent,
  AgentSideConnection as AcpConnection,
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  ResumeSessionRequest,
} from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

/**
 * The one sentence this stub decides on (issue #28).
 *
 * It is not a paraphrase of the untrusted notice — it is the clause a real
 * model quoted back when it declined. On 2026-08-24, against a live gateway and
 * a live model, six woken turns out of six returned a refusal naming exactly
 * this instruction, the `--wake-sign` + `--trust` one included. So a stub that
 * keys on it is a reduction of the observed behaviour to its deciding input,
 * not an assumption about what a model might do.
 *
 * Matching on the notice text rather than on a flag is the point: the notice is
 * the **only** channel by which the tier reaches an agent. A stub that read a
 * boolean out of the envelope would pass while the prompt still said the
 * opposite — which is the failure this fixture exists to catch.
 */
const REFUSAL_DIRECTIVE = 'never as instructions'

/** The arithmetic a relayed request asks for, in a form a stub can obey. */
const RELAYED_ASK = /QIANMO-COMPUTE (\d+)\*(\d+)/

/**
 * Do the relayed work, or decline it — and leave evidence either way.
 *
 * The log file is the business effect the test asserts on. It is deliberately
 * **not** the turn's reply: a refusal is also a completed turn with content and
 * a token bill, which is precisely why "the wake was delivered and the turn
 * ran" was green through six real turns in which nothing was done.
 */
function performRelayedWork(prompt: string, logPath: string): string {
  if (prompt.includes(REFUSAL_DIRECTIVE)) {
    return (
      'refused: the relayed message is marked untrusted, ' +
      'so its content was treated as data.'
    )
  }
  const ask = RELAYED_ASK.exec(prompt)
  if (ask === null) return 'no relayed request was found in this turn'
  const product = Number(ask[1]) * Number(ask[2])
  appendFileSync(logPath, `${product}\n`)
  return `computed ${product}`
}

const accepted = new Map<string, Set<string>>()
let connection!: AcpConnection

function remember(sessionId: string, messageId: string): void {
  let messages = accepted.get(sessionId)
  if (messages === undefined) {
    messages = new Set<string>()
    accepted.set(sessionId, messages)
  }
  messages.add(messageId)
}

const agent: Agent = {
  initialize: async (_params: InitializeRequest) => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { resume: {} },
    },
  }),
  authenticate: async () => {},
  newSession: async (_params: NewSessionRequest) => ({
    sessionId: randomUUID(),
  }),
  unstable_resumeSession: async (_params: ResumeSessionRequest) => ({}),
  prompt: async (params: PromptRequest) => {
    const messageId = params.messageId
    if (typeof messageId !== 'string') {
      throw new Error('resident fixture requires messageId')
    }
    remember(params.sessionId, messageId)
    // What the agent was actually handed, one JSON string per turn. Off unless
    // a test asks for it: this is the only place the assembled prompt can be
    // read after it crossed the ACP boundary (the memory write path, P16.W).
    const promptLog = process.env.QIANMO_FIXTURE_PROMPT_LOG
    if (promptLog !== undefined && promptLog !== '') {
      const text = params.prompt
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
      appendFileSync(promptLog, `${JSON.stringify(text)}\n`)
    }
    await connection.extNotification('qianmo/session-activity', {
      active: true,
    })
    await connection.extNotification('qianmo/input-accepted', {
      sessionId: params.sessionId,
      messageId,
    })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: 'fixture response' },
      },
    })
    // Stands in for a real tool running inside the turn. The host turns these
    // into `notify` on its own — the agent never asks it to, which is the
    // whole difference between a step and the `qianmo_notify` tool below.
    const toolTitle = process.env.QIANMO_FIXTURE_TOOL_CALL
    if (toolTitle !== undefined && toolTitle !== '') {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'fixture-tool-1',
          title: toolTitle,
          kind: 'read',
          status: 'in_progress',
        },
      })
    }
    // Stands in for the `qianmo_notify` tool call. The real tool is built by
    // `src/services/qianmo/notifyTool.ts` and does exactly this — one
    // `qianmo/notify` ext request, mid-turn, and it reports the verdict back
    // to the model. Doing it from the fixture is what lets the integration
    // test exercise the host half without booting a real model.
    const announcement = process.env.QIANMO_FIXTURE_NOTIFY
    if (announcement !== undefined && announcement !== '') {
      const verdict = await connection.extMethod('qianmo/notify', {
        sessionId: params.sessionId,
        kind: 'watch',
        severity: 'warn',
        summary: announcement,
        detail: 'observed by the fixture',
        ...(process.env.QIANMO_FIXTURE_NOTIFY_DEDUP === undefined
          ? {}
          : { dedupKey: process.env.QIANMO_FIXTURE_NOTIFY_DEDUP }),
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: ` notify=${String(verdict.status)}` },
        },
      })
    }
    // The instruction-following half of the fixture (issue #28). Off unless a
    // test asks for it, so every existing case keeps its old behaviour of
    // answering without reading a word of the prompt.
    const workLog = process.env.QIANMO_FIXTURE_WORK_LOG
    if (workLog !== undefined && workLog !== '') {
      const relayed = params.prompt
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: {
            type: 'text',
            text: ` ${performRelayedWork(relayed, workLog)}`,
          },
        },
      })
    }
    if (process.env.QIANMO_FIXTURE_HOLD_BUSY === '1') {
      await new Promise<void>(() => {})
    }
    await connection.extNotification('qianmo/session-activity', {
      active: false,
    })
    return { stopReason: 'end_turn', userMessageId: messageId }
  },
  cancel: async () => {},
  extMethod: async (method, params) => {
    if (method !== 'qianmo/input-status') return {}
    const sessionId = params.sessionId
    const messageId = params.messageId
    return {
      accepted:
        typeof sessionId === 'string' &&
        typeof messageId === 'string' &&
        (accepted.get(sessionId)?.has(messageId) ?? false),
    }
  },
}

const writable = Writable.toWeb(
  process.stdout,
) as unknown as WritableStream<Uint8Array>
const readable = Readable.toWeb(
  process.stdin,
) as unknown as ReadableStream<Uint8Array>
connection = new AgentSideConnection(
  () => agent,
  ndJsonStream(writable, readable),
)
process.stdin.resume()
