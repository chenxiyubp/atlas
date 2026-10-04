// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A console started without accounts answers byte for byte what it answered
 * before accounts existed (`tenancy-m1.md` §1.5 M-0, P15 invariant 6).
 *
 * The golden file was produced by this same harness on the commit before the
 * account code landed (`9770e8a7`), and is compared here as status, sorted
 * headers, body length and body SHA-256 for every request below. A request
 * list rather than a random crawl: each entry is one route × credential
 * position that a deployment without `--accounts` can reach today, including
 * the paths the account code later claims (`/invite`, `/v0/accounts`), which
 * must stay plain 404s when the feature is off.
 *
 * Regenerate only on a commit whose legacy behaviour is meant to change:
 * `CONSOLE_PARITY_UPDATE=1 bun test packages/console/test/legacyParity.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuditSource, type AuditRecord, type MessageChain } from '@qianmo/audit'
import {
  CONSOLE_HEADER,
  SESSION_COOKIE,
  type ConsoleTokens,
} from '../src/auth.js'
import type {
  AuditPage,
  AuditPort,
  ChatPort,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleAgent,
  ConsoleDeps,
  ConsoleResult,
  LimitsSnapshot,
  RegistryPort,
  ServerNote,
  ServerNotesPort,
  WakeOutcome,
  WakePort,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'

const GOLDEN = join(import.meta.dir, 'legacyParity.golden.json')

const VIEW = 'view-token-000000000001'
const ADMIN = 'admin-token-00000000001'
const WRONG = 'wrong-token-00000000001'
const TOKENS: ConsoleTokens = { view: VIEW, admin: ADMIN }
const NOW = 1_700_000_000_000
const BASE = 'http://console.test'
const ADDRESS = 'qianmo://tokyo-1/planner'
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

const AGENT: ConsoleAgent = {
  address: ADDRESS,
  endpoint: 'ws://127.0.0.1:38611/',
  capabilities: ['plan'],
  status: 'online',
  registeredAt: NOW - 60_000,
  lastHeartbeatAt: NOW - 1_000,
  expiresAt: NOW + 89_000,
}

const RECORD: AuditRecord = {
  seq: 1,
  at: NOW - 5_000,
  source: AuditSource.Router,
  kind: 'forwarded',
  traceId: TRACE,
  outcome: 'ok',
  prev: '0'.repeat(64),
}

const PAGE: AuditPage = {
  records: [RECORD],
  chain: 'intact',
  intact: true,
  issueCount: 0,
  total: 1,
}

const CHAIN: MessageChain = {
  traceId: TRACE,
  records: [RECORD],
  taskIds: [],
  msgIds: [],
  sources: [AuditSource.Router],
  refused: 0,
  dropped: 0,
  firstAt: RECORD.at,
  lastAt: RECORD.at,
}

const LIMITS: LimitsSnapshot = {
  protocol: {
    maxMessageBytes: 262_144,
    maxHops: 8,
    defaultTtlMs: 30_000,
    defaultTaskTtlMs: 600_000,
    ratePerMinute: 60,
  },
  runtime: { capacity: 20, windowMs: 1_000 },
  registryTtlMs: 90_000,
}

const SESSION: ChatSession = {
  id: 'session-1',
  target: ADDRESS,
  node: 'tokyo-1',
  agent: 'planner',
  createdAt: NOW - 30_000,
  updatedAt: NOW - 10_000,
  turnCount: 1,
  preview: 'hello',
}

const TURN: ChatTurn = {
  id: 'turn-1',
  sessionId: SESSION.id,
  author: 'operator',
  at: NOW - 10_000,
  text: 'hello',
  state: 'done',
}

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

class Registry implements RegistryPort {
  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
    return Promise.resolve(ok([AGENT]))
  }
  register(): Promise<ConsoleResult<ConsoleAgent>> {
    return Promise.resolve(ok(AGENT))
  }
  deregister(): Promise<ConsoleResult<void>> {
    return Promise.resolve(ok(undefined))
  }
  heartbeat(): Promise<ConsoleResult<ConsoleAgent>> {
    return Promise.resolve(ok(AGENT))
  }
}

class Audit implements AuditPort {
  read(): Promise<ConsoleResult<AuditPage>> {
    return Promise.resolve(ok(PAGE))
  }
  chain(): Promise<ConsoleResult<MessageChain | null>> {
    return Promise.resolve(ok(CHAIN))
  }
}

class Wake implements WakePort {
  send(): Promise<ConsoleResult<WakeOutcome>> {
    return Promise.resolve(
      ok({ msgId: 'msg-1', taskId: 'task-1', receipt: 'accepted' }),
    )
  }
}

class Notes implements ServerNotesPort {
  list(): Promise<ConsoleResult<readonly ServerNote[]>> {
    return Promise.resolve(ok([{ server: 'p11', note: 'hub', updatedAt: NOW }]))
  }
  set(server: string, note: string): Promise<ConsoleResult<ServerNote>> {
    return Promise.resolve(ok({ server, note, updatedAt: NOW }))
  }
}

class Chat implements ChatPort {
  targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return Promise.resolve(
      ok([
        {
          address: ADDRESS,
          node: 'tokyo-1',
          agent: 'planner',
          endpoint: AGENT.endpoint,
          status: 'online',
          dialable: true,
        },
      ]),
    )
  }
  sessions(): Promise<ConsoleResult<readonly ChatSession[]>> {
    return Promise.resolve(ok([SESSION]))
  }
  open(): Promise<ConsoleResult<ChatSession>> {
    return Promise.resolve(ok(SESSION))
  }
  transcript(): Promise<ConsoleResult<ChatTranscript>> {
    return Promise.resolve(ok({ session: SESSION, turns: [TURN] }))
  }
  send(): Promise<ConsoleResult<ChatTurn>> {
    return Promise.resolve(ok(TURN))
  }
  subscribe(_listener: (update: ChatUpdate) => void): () => void {
    return () => {}
  }
}

function deps(): ConsoleDeps {
  return {
    registry: new Registry(),
    audit: new Audit(),
    limits: LIMITS,
    now: () => NOW,
    label: 'parity',
    wake: new Wake(),
    wakeUrl: 'ws://127.0.0.1:38611/',
    identity: 'qianmo://console/operator',
    chat: new Chat(),
    nodeServers: [{ node: 'tokyo-1', server: 'p11' }],
    serverNotes: new Notes(),
  }
}

type Credential =
  | 'none'
  | 'view-bearer'
  | 'admin-bearer'
  | 'view-query'
  | 'admin-query'
  | 'view-cookie'
  | 'admin-cookie'
  | 'admin-cookie+header'
  | 'wrong-bearer'

interface Probe {
  readonly method: string
  readonly path: string
  readonly as: Credential
  readonly html?: boolean
  readonly body?: string
  readonly form?: Record<string, string>
  readonly headers?: Record<string, string>
}

function requestOf(probe: Probe): Request {
  const headers = new Headers(probe.headers)
  let path = probe.path
  switch (probe.as) {
    case 'view-bearer':
      headers.set('authorization', `Bearer ${VIEW}`)
      break
    case 'admin-bearer':
      headers.set('authorization', `Bearer ${ADMIN}`)
      break
    case 'wrong-bearer':
      headers.set('authorization', `Bearer ${WRONG}`)
      break
    case 'view-query':
      path += `${path.includes('?') ? '&' : '?'}token=${VIEW}`
      break
    case 'admin-query':
      path += `${path.includes('?') ? '&' : '?'}token=${ADMIN}`
      break
    case 'view-cookie':
      headers.set('cookie', `${SESSION_COOKIE}=${VIEW}`)
      break
    case 'admin-cookie':
      headers.set('cookie', `${SESSION_COOKIE}=${ADMIN}`)
      break
    case 'admin-cookie+header':
      headers.set('cookie', `${SESSION_COOKIE}=${ADMIN}`)
      headers.set(CONSOLE_HEADER, '1')
      break
    case 'none':
      break
  }
  if (probe.html === true) headers.set('accept', 'text/html')
  let body: string | undefined = probe.body
  if (probe.form !== undefined) {
    headers.set('content-type', 'application/x-www-form-urlencoded')
    body = new URLSearchParams(probe.form).toString()
  } else if (body !== undefined) {
    headers.set('content-type', 'application/json')
  }
  return new Request(`${BASE}${path}`, {
    method: probe.method,
    headers,
    ...(body === undefined ? {} : { body }),
  })
}

const ENC = encodeURIComponent(ADDRESS)

const PROBES: readonly Probe[] = [
  { method: 'GET', path: '/', as: 'none' },
  { method: 'GET', path: '/', as: 'none', html: true },
  { method: 'GET', path: '/?window=24h', as: 'none', html: true },
  { method: 'GET', path: '/', as: 'view-bearer' },
  { method: 'GET', path: '/', as: 'admin-bearer' },
  { method: 'GET', path: '/', as: 'view-query' },
  { method: 'GET', path: '/', as: 'admin-query' },
  { method: 'GET', path: '/', as: 'view-cookie' },
  { method: 'GET', path: '/', as: 'admin-cookie' },
  { method: 'GET', path: '/', as: 'wrong-bearer' },
  { method: 'POST', path: '/', as: 'admin-bearer' },
  { method: 'GET', path: '/login', as: 'none' },
  { method: 'GET', path: '/login?redirect=%2Fchat', as: 'none' },
  { method: 'GET', path: '/login', as: 'admin-cookie' },
  { method: 'PUT', path: '/login', as: 'none' },
  { method: 'POST', path: '/login', as: 'none', form: { token: WRONG } },
  { method: 'POST', path: '/login', as: 'none', form: { token: VIEW } },
  {
    method: 'POST',
    path: '/login',
    as: 'none',
    form: { token: ADMIN, redirect: '/chat' },
  },
  {
    method: 'POST',
    path: '/login',
    as: 'none',
    form: { token: ADMIN },
    headers: { 'sec-fetch-site': 'cross-site' },
  },
  {
    method: 'POST',
    path: '/login',
    as: 'none',
    form: { token: ADMIN },
    headers: { 'x-forwarded-proto': 'https' },
  },
  { method: 'POST', path: '/login', as: 'none', body: '{}' },
  { method: 'POST', path: '/logout', as: 'none' },
  { method: 'POST', path: '/logout', as: 'admin-cookie' },
  { method: 'GET', path: '/logout', as: 'none' },
  { method: 'GET', path: '/assets/app.css', as: 'none' },
  { method: 'GET', path: '/assets/app.js', as: 'none' },
  { method: 'GET', path: '/assets/nope.js', as: 'none' },
  { method: 'GET', path: '/v0/health', as: 'none' },
  { method: 'GET', path: '/v0/limits', as: 'none' },
  { method: 'GET', path: '/v0/limits', as: 'view-bearer' },
  { method: 'GET', path: '/v0/limits', as: 'view-cookie' },
  { method: 'GET', path: '/v0/agents', as: 'view-bearer' },
  { method: 'GET', path: '/v0/agents', as: 'admin-cookie' },
  { method: 'GET', path: '/v0/agents', as: 'admin-cookie+header' },
  {
    method: 'POST',
    path: '/v0/agents',
    as: 'view-bearer',
    body: JSON.stringify({ address: ADDRESS, endpoint: AGENT.endpoint }),
  },
  {
    method: 'POST',
    path: '/v0/agents',
    as: 'admin-bearer',
    body: JSON.stringify({ address: ADDRESS, endpoint: AGENT.endpoint }),
  },
  { method: 'DELETE', path: `/v0/agents/${ENC}`, as: 'admin-bearer' },
  { method: 'DELETE', path: `/v0/agents/${ENC}`, as: 'view-bearer' },
  {
    method: 'POST',
    path: `/v0/agents/${ENC}/heartbeat`,
    as: 'admin-bearer',
  },
  { method: 'GET', path: '/v0/audit', as: 'view-bearer' },
  { method: 'GET', path: '/v0/audit?limit=5', as: 'view-query' },
  { method: 'GET', path: `/v0/audit/chain/${TRACE}`, as: 'view-bearer' },
  { method: 'GET', path: '/v0/servers', as: 'view-bearer' },
  {
    method: 'PUT',
    path: '/v0/servers/p11/note',
    as: 'admin-bearer',
    body: JSON.stringify({ note: 'x' }),
  },
  {
    method: 'PUT',
    path: '/v0/servers/p99/note',
    as: 'admin-bearer',
    body: JSON.stringify({ note: 'x' }),
  },
  {
    method: 'POST',
    path: '/v0/wake',
    as: 'admin-bearer',
    body: JSON.stringify({
      from: 'qianmo://console/operator',
      to: ADDRESS,
      prompt: 'wake',
    }),
  },
  { method: 'POST', path: '/v0/wake', as: 'view-bearer', body: '{}' },
  { method: 'GET', path: '/fragments/roster', as: 'view-bearer' },
  { method: 'GET', path: '/fragments/audit', as: 'view-bearer' },
  { method: 'GET', path: '/fragments/limits', as: 'view-bearer' },
  { method: 'GET', path: `/fragments/chain/${TRACE}`, as: 'view-bearer' },
  { method: 'GET', path: '/fragments/nope', as: 'view-bearer' },
  { method: 'GET', path: '/chat', as: 'none', html: true },
  { method: 'GET', path: '/chat', as: 'view-bearer' },
  { method: 'GET', path: '/chat', as: 'view-cookie', html: true },
  { method: 'GET', path: '/chat', as: 'admin-bearer' },
  { method: 'GET', path: '/chat?session=session-1', as: 'admin-cookie' },
  { method: 'GET', path: '/v0/chat/targets', as: 'admin-bearer' },
  { method: 'GET', path: '/v0/chat/targets', as: 'view-bearer' },
  { method: 'GET', path: '/v0/chat/sessions', as: 'admin-bearer' },
  { method: 'GET', path: '/v0/chat/sessions', as: 'none' },
  {
    method: 'POST',
    path: '/v0/chat/sessions',
    as: 'admin-bearer',
    body: JSON.stringify({ target: ADDRESS }),
  },
  { method: 'GET', path: '/v0/chat/sessions/session-1', as: 'admin-bearer' },
  {
    method: 'POST',
    path: '/v0/chat/sessions/session-1/messages',
    as: 'admin-bearer',
    body: JSON.stringify({ text: 'hi' }),
  },
  {
    method: 'POST',
    path: '/v0/chat/sessions/session-1/messages',
    as: 'admin-cookie',
    body: JSON.stringify({ text: 'hi' }),
  },
  { method: 'GET', path: '/fragments/chat/sessions', as: 'admin-bearer' },
  {
    method: 'GET',
    path: '/fragments/chat/thread/session-1',
    as: 'admin-bearer',
  },
  { method: 'GET', path: '/fragments/chat/sessions', as: 'view-bearer' },
  { method: 'GET', path: '/v0/chat/stream', as: 'admin-bearer' },
  { method: 'GET', path: '/v0/chat/stream', as: 'admin-query' },
  { method: 'GET', path: '/v0/chat/stream', as: 'admin-cookie' },
  {
    method: 'GET',
    path: '/v0/chat/stream',
    as: 'admin-cookie',
    headers: { 'sec-fetch-site': 'same-site' },
  },
  { method: 'GET', path: '/v0/chat/stream', as: 'view-bearer' },
  { method: 'GET', path: '/invite', as: 'none' },
  { method: 'POST', path: '/invite', as: 'none', form: { invite: 'x' } },
  { method: 'GET', path: '/v0/accounts', as: 'admin-bearer' },
  { method: 'POST', path: '/v0/accounts/invites', as: 'admin-bearer' },
  { method: 'GET', path: '/v0/me', as: 'admin-bearer' },
  { method: 'GET', path: '/nope', as: 'admin-bearer' },
]

interface Shot {
  readonly probe: string
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly length: number
  readonly sha256: string
}

async function bodyOf(response: Response): Promise<string> {
  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('text/event-stream')) return await response.text()
  // A stream never ends on its own: its first chunk is the deterministic part
  // (the retry hint and the opening comment), and cancelling releases the
  // subscription and the heartbeat interval.
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const first = await reader.read()
  await reader.cancel()
  return first.value === undefined ? '' : new TextDecoder().decode(first.value)
}

async function shoot(): Promise<Shot[]> {
  const handle = createConsoleHandler(deps(), TOKENS)
  const shots: Shot[] = []
  for (const probe of PROBES) {
    const response = await handle(requestOf(probe))
    const body = await bodyOf(response)
    const headers = [...response.headers.entries()]
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort((a, b) =>
        a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
      )
    shots.push({
      probe: `${probe.method} ${probe.path} as ${probe.as}${
        probe.html === true ? ' (html)' : ''
      }${probe.headers === undefined ? '' : ` ${JSON.stringify(probe.headers)}`}${
        probe.form === undefined ? '' : ` form=${JSON.stringify(probe.form)}`
      }`,
      status: response.status,
      headers,
      length: body.length,
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    })
  }
  return shots
}

// Every clock rendered on these pages is local time (`view/format.ts`), so the
// golden is pinned to one zone rather than to whichever machine produced it.
let previousTz: string | undefined
beforeAll(() => {
  previousTz = process.env['TZ']
  process.env['TZ'] = 'UTC'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = previousTz
})

describe('a console without accounts', () => {
  test('answers every probe byte for byte as it did before accounts existed', async () => {
    const shots = await shoot()
    if (process.env['CONSOLE_PARITY_UPDATE'] === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(shots, null, 1)}\n`)
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Shot[]
    expect(shots.length).toBe(PROBES.length)
    expect(golden.length).toBe(PROBES.length)
    for (const [index, shot] of shots.entries()) {
      expect({ index, ...shot }).toEqual({ index, ...golden[index] } as {
        index: number
      } & Shot)
    }
  })

  test('is deterministic, so a mismatch above is a behaviour change', async () => {
    const [a, b] = [await shoot(), await shoot()]
    expect(a).toEqual(b)
  })
})
