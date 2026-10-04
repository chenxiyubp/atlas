// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An empty model response, end to end through a resident node's own ACP stack.
 *
 * ## The incident
 *
 * beta-5, 2026-09-27: three watch turns failed as `-32603 Internal error`,
 * `undefined is not an object (evaluating 'e.type')`. The gateway had answered
 * HTTP 200 with a finish_reason and no content, the chat adapter treated that
 * as an ordinary stop, and the query loop handed the missing assistant message
 * to `reactiveCompact.isWithheldMediaSizeError`, which read `.type` off
 * `undefined`. The existing unit test for exactly this case was green, because
 * plain `bun test` compiles REACTIVE_COMPACT out and the shipped build does not.
 *
 * ## What this file holds the fix to
 *
 * - an empty response is retried a small, bounded number of times;
 * - one that clears on retry gives the real answer and a completed turn;
 * - one that never clears ends as an explicit, distinguishable failure at the
 *   resident — never as `completed` with an empty body, which is what fixing
 *   the crash alone produced;
 * - a 4xx from the gateway is a failure too (it used to be recorded as
 *   completed), and the 5xx retry ladder still works.
 *
 * ## What is real, and the one thing that is not
 *
 * **Real**: the ACP child (`src/entrypoints/cli.tsx --acp` from source with the
 * shipped defines and feature list, via `spawnResidentAcpChild`), the
 * resident's own `ResidentAcpConnection` and `AcpResidentTurnPort` on its
 * stdio, and the resident's timing recorder. No `mock.module`.
 *
 * **Not real**: the model. A loopback `Bun.serve` answers each scenario's
 * requests from a fixed list of shapes. The six empty shapes are the ones the
 * fleet reproduction used (`repro/fake_openai.py`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtocolErrorCode } from '@qianmo/protocol'
import {
  AcpResidentTurnPort,
  ResidentAcpConnection,
  ResidentTimingRecorder,
  type ResidentTimingEvent,
  type ResidentTurnResult,
  turnFailureKind,
} from '@qianmo/resident'
import { spawnResidentAcpChild } from './fixtures/resident-acp-harness.js'

const BOOT_TIMEOUT_MS = 90_000
const TURN_TIMEOUT_MS = 60_000
const FILE_TIMEOUT_MS = 300_000
const MODEL = 'gemini-3.8-flash-high'

type Frame = Record<string, unknown>

const USAGE = { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 }

function frame(
  delta: Record<string, unknown> | null,
  finish: string | null = null,
  usage?: Record<string, number>,
): Frame {
  return {
    id: 'chatcmpl-empty-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}
const usageOnly = frame(null, null, USAGE)

/** The six zero-output shapes from the fleet reproduction. */
const EMPTY_SHAPES = {
  empty_stop: [frame({ role: 'assistant' }), frame({}, 'stop'), usageOnly],
  empty_stop_nousage: [frame({ role: 'assistant' }), frame({}, 'stop')],
  content_null_stop: [
    frame({ role: 'assistant', content: null }, 'stop'),
    usageOnly,
  ],
  empty_string_stop: [
    frame({ role: 'assistant', content: '' }, 'stop'),
    usageOnly,
  ],
  malformed_fc: [
    frame({ role: 'assistant' }),
    frame({}, 'MALFORMED_FUNCTION_CALL'),
    usageOnly,
  ],
  content_filter: [frame({ role: 'assistant' }, 'content_filter'), usageOnly],
} as const

type EmptyShape = keyof typeof EMPTY_SHAPES
type Reply = EmptyShape | 'normal' | 'http400' | 'http500'

const NORMAL: Frame[] = [
  frame({ role: 'assistant', content: 'ok' }),
  frame({}, 'stop'),
  frame(null, null, { prompt_tokens: 1000, completion_tokens: 1 }),
]

function sse(frames: readonly Frame[]): Response {
  const body = `${frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as Record<string, unknown>).text === 'string'
        ? ((part as Record<string, unknown>).text as string)
        : '',
    )
    .join('\n')
}

const SCENARIO = /EMPTY-SCN:([\w-]+)/

/** The scripted gateway: each scenario's replies in order, the last repeating. */
class Gateway {
  readonly #scripts = new Map<string, readonly Reply[]>()
  readonly #requests = new Map<string, number>()
  readonly #server: ReturnType<typeof Bun.serve>

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async req => {
        let body: { messages?: unknown; tools?: unknown; stream?: unknown } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          // Not a model turn; answer the trivial shape below.
        }
        const messages = Array.isArray(body.messages) ? body.messages : []
        const all = messages
          .map(m => textOf((m as Record<string, unknown>).content))
          .join('\n')
        const id = SCENARIO.exec(all)?.[1]
        const script = id === undefined ? undefined : this.#scripts.get(id)
        // Side requests (no tools, not streamed, not a scenario) get a plain
        // answer so they cannot be mistaken for the turn under test.
        if (
          body.stream !== true ||
          !Array.isArray(body.tools) ||
          body.tools.length === 0 ||
          id === undefined ||
          script === undefined
        ) {
          return body.stream === true
            ? sse(NORMAL)
            : Response.json({
                id: 'd',
                object: 'chat.completion',
                created: 1,
                model: MODEL,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              })
        }
        const n = this.#requests.get(id) ?? 0
        this.#requests.set(id, n + 1)
        const reply = script[Math.min(n, script.length - 1)] as Reply
        if (reply === 'http400' || reply === 'http500') {
          const status = reply === 'http400' ? 400 : 500
          return Response.json(
            {
              error: {
                message: 'fake upstream failure',
                type: status === 400 ? 'invalid_request_error' : 'server_error',
                code: status,
              },
            },
            { status },
          )
        }
        return sse(reply === 'normal' ? NORMAL : EMPTY_SHAPES[reply])
      },
    })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}/v1`
  }

  script(id: string, replies: readonly Reply[]): void {
    this.#scripts.set(id, replies)
  }

  requests(id: string): number {
    return this.#requests.get(id) ?? 0
  }

  async stop(): Promise<void> {
    await this.#server.stop(true)
  }
}

let root = ''
let stderrPath = ''
let gateway: Gateway
let child: ChildProcess
let connection: ResidentAcpConnection
let port: AcpResidentTurnPort
const timings: ResidentTimingEvent[] = []

interface Turn {
  readonly result: ResidentTurnResult
  readonly requests: number
  readonly timings: readonly ResidentTimingEvent[]
}

/** One scenario = one fresh ACP session and one resident turn on it. */
async function runTurn(id: string, replies: readonly Reply[]): Promise<Turn> {
  gateway.script(id, replies)
  const sessionId = await connection.newSession({
    agent: 'ops',
    cwd: join(root, 'workspace'),
  })
  const before = timings.length
  const result = await Promise.race([
    port.execute(
      {
        sessionId,
        messageId: randomUUID(),
        prompt: `EMPTY-SCN:${id} Answer with the word ok.`,
        agent: 'ops',
      },
      async () => {},
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`scenario ${id} timed out`)),
        TURN_TIMEOUT_MS,
      ),
    ),
  ])
  return {
    result,
    requests: gateway.requests(id),
    timings: timings.slice(before),
  }
}

function stages(turn: Turn): Array<[string, string | undefined]> {
  return turn.timings
    .filter(e => e.stage === 'turn_completed' || e.stage === 'turn_failed')
    .map(e => [e.stage, e.error])
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-empty-response-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  stderrPath = join(root, 'acp-child.stderr')
  gateway = new Gateway()
  const spawned = spawnResidentAcpChild({
    configDir: join(root, 'config'),
    modelBaseUrl: gateway.baseUrl,
    stderrPath,
    model: MODEL,
  })
  child = spawned.child
  connection = new ResidentAcpConnection({
    stream: spawned.stream,
    onInputAccepted: params => port.handleInputAccepted(params),
    onSessionUpdate: params => port.handleSessionUpdate(params),
  })
  port = new AcpResidentTurnPort(connection, {
    timings: new ResidentTimingRecorder(event => timings.push(event)),
  })
  await Promise.race([
    connection.initialize(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('ACP child did not initialize')),
        BOOT_TIMEOUT_MS,
      ),
    ),
  ])
}, FILE_TIMEOUT_MS)

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const killer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    await exited
    clearTimeout(killer)
  }
  await gateway?.stop()
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('empty model responses through a resident node', () => {
  for (const shape of Object.keys(EMPTY_SHAPES) as EmptyShape[]) {
    test(
      `${shape} followed by a real answer recovers the real answer`,
      async () => {
        const turn = await runTurn(`recover-${shape}`, [shape, 'normal'])

        expect(turn.result).toEqual({ outcome: 'completed', content: 'ok' })
        expect(turn.requests).toBe(2)
        expect(stages(turn)).toEqual([['turn_completed', undefined]])
      },
      FILE_TIMEOUT_MS,
    )
  }

  test(
    'persistent empty responses end in an explicit failure after a bounded retry',
    async () => {
      const turn = await runTurn('persistent-empty', ['empty_stop'])

      // One request and two retries — not the 10-attempt 5xx ladder.
      expect(turn.requests).toBe(3)
      expect(turn.result.outcome).toBe('failed')
      if (turn.result.outcome !== 'failed') throw new Error('unreachable')
      expect(turn.result.code).toBe(ProtocolErrorCode.E_TASK_FAILED)
      expect(turn.result.reason).toMatch(/^Model returned only empty responses/)
      expect(turn.result.reason).toContain('finish_reason=stop')
      // The agent's `code` and the resident's constant are two spellings of
      // one value in two packages that cannot import each other; this is the
      // assertion that holds them together.
      expect(turnFailureKind(turn.result.reason)).toBe('model_empty_response')
      expect(stages(turn)).toEqual([['turn_failed', 'model_empty_response']])
    },
    FILE_TIMEOUT_MS,
  )

  test(
    'a gateway 400 is a failed turn, not a completed one',
    async () => {
      const turn = await runTurn('http-400', ['http400'])

      expect(turn.requests).toBe(1)
      expect(turn.result.outcome).toBe('failed')
      if (turn.result.outcome !== 'failed') throw new Error('unreachable')
      expect(turn.result.reason).toMatch(/^Model request failed/)
      expect(turn.result.reason).toContain('400')
      expect(turnFailureKind(turn.result.reason)).toBe('model_error')
      expect(stages(turn)).toEqual([['turn_failed', 'model_error']])
    },
    FILE_TIMEOUT_MS,
  )

  test(
    'a gateway 500 is still retried on its own ladder',
    async () => {
      const turn = await runTurn('http-500', ['http500', 'normal'])

      expect(turn.result).toEqual({ outcome: 'completed', content: 'ok' })
      expect(turn.requests).toBe(2)
    },
    FILE_TIMEOUT_MS,
  )

  test(
    'the node log names the empty responses without any content, and no crash',
    () => {
      const stderr = readFileSync(stderrPath, 'utf8')
      const lines = stderr
        .split('\n')
        .filter(line => line.includes('empty model response'))

      expect(stderr).not.toContain('Error handling request')
      expect(stderr).not.toContain("evaluating 'message.type'")
      // Six recovered shapes plus three in the persistent scenario.
      expect(lines.length).toBeGreaterThanOrEqual(9)
      expect(lines.some(line => line.includes('finish_reason=stop'))).toBe(true)
      expect(
        lines.some(line =>
          line.includes('finish_reason=MALFORMED_FUNCTION_CALL'),
        ),
      ).toBe(true)
      expect(lines.some(line => line.includes('input_tokens=1000'))).toBe(true)
      for (const line of lines) {
        expect(line).not.toContain('EMPTY-SCN')
        expect(line).not.toContain('Answer with the word')
      }
    },
    FILE_TIMEOUT_MS,
  )
})
