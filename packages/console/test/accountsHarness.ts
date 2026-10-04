// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared fixtures for the account suites: an in-memory ledger that counts
 * what is done to it, hand-written ports, and a console with accounts on.
 *
 * Hand-written rather than `mock.module`, like every other console suite: the
 * ports are interfaces for exactly this reason (root CLAUDE.md, "Mock 卫生").
 * The counters are the point — "the invitation page minted nothing" is an
 * assertion about the ledger port being called zero times, not about a
 * response looking right.
 */

import type { ConsoleAccounts } from '../src/access.js'
import { AccountBook, type AccountBookOptions } from '../src/accounts.js'
import { CONSOLE_HEADER, type ConsoleTokens } from '../src/auth.js'
import type {
  AuditPort,
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleDeps,
  ConsoleResult,
  LedgerPort,
  LimitsSnapshot,
  RegistryPort,
  WakeInput,
  WakeOutcome,
  WakePort,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'

export const VIEW = 'view-token-000000000001'
export const ADMIN = 'admin-token-00000000001'
export const TOKENS: ConsoleTokens = { view: VIEW, admin: ADMIN }
export const START = 1_700_000_000_000
export const BASE = 'http://console.test'
export const ADDRESS = 'qianmo://tokyo-1/planner'
export const HOUR = 60 * 60 * 1000

/** A manual clock: time moves only when a test says so. */
export class ManualClock {
  #now: number
  constructor(start: number = START) {
    this.#now = start
  }
  now = (): number => this.#now
  advance(ms: number): void {
    this.#now += ms
  }
}

/** A ledger in memory that remembers how often it was read and written. */
export class MemoryLedger implements LedgerPort {
  readonly path: string
  text: string | null
  reads = 0
  appends = 0
  /** Set to make the next append throw, the way a full disk would. */
  failAppends = false

  constructor(path = 'memory://accounts.ndjson', text: string | null = null) {
    this.path = path
    this.text = text
  }

  read(): string | null {
    this.reads += 1
    return this.text
  }

  append(line: string): void {
    if (this.failAppends) throw new Error('no space left on device')
    this.appends += 1
    this.text = (this.text ?? '') + line
  }

  /** The persisted lines, parsed. */
  lines(): readonly { kind: string; data: Record<string, unknown> }[] {
    return (this.text ?? '')
      .split('\n')
      .filter(line => line !== '')
      .map(
        line =>
          JSON.parse(line) as { kind: string; data: Record<string, unknown> },
      )
  }
}

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

export const LIMITS: LimitsSnapshot = {
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

class QuietRegistry implements RegistryPort {
  calls = 0
  list(): Promise<ConsoleResult<readonly never[]>> {
    return Promise.resolve(ok([]))
  }
  register(): Promise<ConsoleResult<never>> {
    this.calls += 1
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'not here' },
    })
  }
  deregister(): Promise<ConsoleResult<void>> {
    this.calls += 1
    return Promise.resolve(ok(undefined))
  }
  heartbeat(): Promise<ConsoleResult<never>> {
    this.calls += 1
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'not here' },
    })
  }
}

class QuietAudit implements AuditPort {
  read(): Promise<ConsoleResult<never>> {
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'not here' },
    })
  }
  chain(): Promise<ConsoleResult<null>> {
    return Promise.resolve(ok(null))
  }
}

/** Counts every send, so a refused route can be shown to have sent nothing. */
export class CountingWake implements WakePort {
  sent = 0
  send(_input: WakeInput): Promise<ConsoleResult<WakeOutcome>> {
    this.sent += 1
    return Promise.resolve(
      ok({ msgId: 'm-1', taskId: 't-1', receipt: 'accepted' }),
    )
  }
}

/**
 * A chat port with real sessions in memory, and a count of every call that
 * reads or changes one — the zero the ownership rules are judged by.
 */
export class CountingChat implements ChatPort {
  readonly sessionsById = new Map<string, ChatSession>()
  readonly listeners = new Set<(update: ChatUpdate) => void>()
  opened = 0
  transcripts = 0
  sends = 0
  #next = 0
  #revision = 0

  targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return Promise.resolve(
      ok([
        {
          address: ADDRESS,
          node: 'tokyo-1',
          agent: 'planner',
          endpoint: 'ws://127.0.0.1:38611/',
          status: 'online',
          dialable: true,
        },
      ]),
    )
  }

  sessions(): Promise<ConsoleResult<readonly ChatSession[]>> {
    return Promise.resolve(ok([...this.sessionsById.values()]))
  }

  open(target: string): Promise<ConsoleResult<ChatSession>> {
    this.opened += 1
    this.#next += 1
    const session: ChatSession = {
      id: `session-${this.#next}`,
      target,
      node: 'tokyo-1',
      agent: 'planner',
      createdAt: START,
      updatedAt: START,
      turnCount: 0,
      preview: '',
    }
    this.sessionsById.set(session.id, session)
    this.emit(session.id)
    return Promise.resolve(ok(session))
  }

  transcript(sessionId: string): Promise<ConsoleResult<ChatTranscript>> {
    this.transcripts += 1
    const session = this.sessionsById.get(sessionId)
    return Promise.resolve(
      session === undefined
        ? {
            ok: false,
            failure: {
              code: 'not_found',
              message: '这条会话不在本控制台的记录里',
            },
          }
        : ok({ session, turns: [] }),
    )
  }

  send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    this.sends += 1
    return Promise.resolve(
      ok({
        id: `turn-${this.sends}`,
        sessionId: input.sessionId,
        author: 'operator',
        at: START,
        text: input.text,
        state: 'pending',
      }),
    )
  }

  subscribe(listener: (update: ChatUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Tell every subscriber a session changed. */
  emit(sessionId: string): void {
    this.#revision += 1
    for (const listener of this.listeners) {
      listener({ sessionId, revision: this.#revision })
    }
  }
}

export interface AccountsHarness {
  readonly clock: ManualClock
  readonly ledger: MemoryLedger
  readonly sessions: MemoryLedger
  readonly book: AccountBook
  readonly chat: CountingChat
  readonly wake: CountingWake
  readonly registry: QuietRegistry
  readonly alarms: string[]
  readonly handle: (request: Request) => Promise<Response>
}

export function accountsHarness(
  options: {
    readonly ledger?: MemoryLedger
    readonly sessions?: MemoryLedger
    readonly book?: Partial<AccountBookOptions>
    readonly accounts?: Omit<ConsoleAccounts, 'book'>
    readonly clock?: ManualClock
    readonly tokens?: ConsoleTokens
  } = {},
): AccountsHarness {
  const clock = options.clock ?? new ManualClock()
  const ledger = options.ledger ?? new MemoryLedger()
  const sessions =
    options.sessions ?? new MemoryLedger('memory://sessions.ndjson')
  const alarms: string[] = []
  const book = new AccountBook({
    accounts: ledger,
    sessions,
    now: clock.now,
    onAlarm: line => {
      alarms.push(line)
    },
    ...options.book,
  })
  const chat = new CountingChat()
  const wake = new CountingWake()
  const registry = new QuietRegistry()
  const deps: ConsoleDeps = {
    registry,
    audit: new QuietAudit(),
    limits: LIMITS,
    now: clock.now,
    label: 'accounts-test',
    chat,
    wake,
  }
  const handle = createConsoleHandler(deps, options.tokens ?? TOKENS, {
    ...options.accounts,
    book,
  })
  return {
    clock,
    ledger,
    sessions,
    book,
    chat,
    wake,
    registry,
    alarms,
    handle,
  }
}

/** A JSON request with an admin bearer. */
export function asAdmin(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A form post, shaped the way a rendered form submits it. */
export function formPost(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  })
}

/** Issue an invitation over HTTP as the admin token and return its token. */
export async function invite(
  handle: (request: Request) => Promise<Response>,
  role: 'viewer' | 'member' | 'ops' = 'member',
  extra: Record<string, unknown> = {},
): Promise<{ readonly token: string; readonly inviteId: string }> {
  const response = await handle(
    asAdmin('POST', '/v0/accounts/invites', { role, ...extra }),
  )
  if (response.status !== 200) {
    throw new Error(
      `invite failed: ${response.status} ${await response.text()}`,
    )
  }
  const body = (await response.json()) as { link: string; inviteId: string }
  const token = body.link.slice(body.link.indexOf('#') + 1)
  return { token, inviteId: body.inviteId }
}

/** Pull the credential out of the credential page. */
export function credentialOn(page: string): string {
  const match = /id="credential"[^>]*value="([^"]+)"/.exec(page)
  if (match === null || match[1] === undefined) {
    throw new Error('no credential on the page')
  }
  return match[1]
}

/** The value a `Set-Cookie` list gives the named cookie, or `null`. */
export function cookieFrom(response: Response, name: string): string | null {
  for (const line of response.headers.getSetCookie()) {
    if (line.startsWith(`${name}=`)) {
      return line.slice(name.length + 1).split(';')[0] ?? ''
    }
  }
  return null
}

/** The whole `Set-Cookie` line for the named cookie, or `null`. */
export function setCookieLine(response: Response, name: string): string | null {
  return (
    response.headers.getSetCookie().find(line => line.startsWith(`${name}=`)) ??
    null
  )
}

/** A person, as the tests hold them: the credential and a live session id. */
export interface Person {
  readonly credential: string
  readonly sid: string
}

/** Invite over HTTP as the admin token, redeem in a browser, return both secrets. */
export async function person(
  handle: (request: Request) => Promise<Response>,
  role: 'viewer' | 'member' | 'ops' = 'member',
): Promise<Person> {
  const { token } = await invite(handle, role)
  const response = await handle(formPost('/invite', { invite: token }))
  if (response.status !== 200) {
    throw new Error(`redeem failed: ${response.status}`)
  }
  const credential = credentialOn(await response.text())
  const sid = cookieFrom(response, 'qianmo_session')
  if (sid === null || sid === '') throw new Error('redeem did not sign in')
  return { credential, sid }
}

/**
 * A request riding a session cookie, the way the page script sends one: with
 * the console header unless a test says otherwise.
 */
export function asSession(
  method: string,
  path: string,
  sid: string,
  options: {
    readonly body?: unknown
    readonly header?: boolean
    readonly accept?: string
    readonly extra?: Record<string, string>
  } = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      cookie: `qianmo_session=${sid}`,
      ...(options.header === false ? {} : { [CONSOLE_HEADER]: '1' }),
      ...(options.accept === undefined ? {} : { accept: options.accept }),
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...(options.extra ?? {}),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  })
}

/** A request with a bearer — a personal credential or a legacy token. */
export function asBearer(
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export { CONSOLE_HEADER }
