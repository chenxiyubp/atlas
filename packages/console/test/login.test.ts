// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The login door: the cookie it hands out, the CSRF rules that cookie costs,
 * and the two older ways in that must keep working beside it.
 *
 * Hand-written fakes and real `Request` objects, no `mock.module` — every port
 * is an interface for exactly this reason and the repo treats module mocking as
 * a zero-tolerance ratchet (root CLAUDE.md, "Mock 卫生").
 *
 * The clock is a `let` rather than a constant because two of these tests are
 * about time passing: a throttle that never forgets is a lockout, and a test
 * that cannot advance the clock cannot tell the two apart.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
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
  LimitsSnapshot,
  RegistryPort,
} from '../src/deps.js'
import {
  CONSOLE_HEADER,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  safeRedirect,
  type ConsoleTokens,
} from '../src/auth.js'
import {
  createConsoleHandler,
  startConsoleServer,
  type ConsoleServerHandle,
} from '../src/http.js'
import { LoginThrottle } from '../src/throttle.js'
import { renderLoginPage } from '../src/view/login.js'

const VIEW = 'view-token-000000000001'
const ADMIN = 'admin-token-00000000001'
const WRONG = 'wrong-token-00000000001'
const TOKENS: ConsoleTokens = { view: VIEW, admin: ADMIN }

const START = 1_700_000_000_000
const BASE = 'http://console.test'
const ADDRESS = 'qianmo://tokyo-1/planner'

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

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

function bad(message: string): ConsoleResult<never> {
  return { ok: false, failure: { code: 'unsupported', message } }
}

class SilentRegistry implements RegistryPort {
  registered = 0

  list(): Promise<ConsoleResult<readonly never[]>> {
    return Promise.resolve(ok([]))
  }

  register(): Promise<ConsoleResult<never>> {
    this.registered += 1
    return Promise.resolve(bad('not used here'))
  }

  deregister(): Promise<ConsoleResult<void>> {
    return Promise.resolve(ok(undefined))
  }

  heartbeat(): Promise<ConsoleResult<never>> {
    return Promise.resolve(bad('not used here'))
  }
}

class SilentAudit implements AuditPort {
  read(): Promise<ConsoleResult<never>> {
    return Promise.resolve(bad('not used here'))
  }

  chain(): Promise<ConsoleResult<null>> {
    return Promise.resolve(ok(null))
  }
}

const SESSION: ChatSession = {
  id: 'session-1',
  target: ADDRESS,
  node: 'tokyo-1',
  agent: 'planner',
  createdAt: START,
  updatedAt: START,
  turnCount: 0,
  preview: '',
}

class SilentChat implements ChatPort {
  readonly listeners = new Set<(update: ChatUpdate) => void>()

  targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return Promise.resolve(ok([]))
  }

  sessions(): Promise<ConsoleResult<readonly ChatSession[]>> {
    return Promise.resolve(ok([SESSION]))
  }

  open(): Promise<ConsoleResult<ChatSession>> {
    return Promise.resolve(ok(SESSION))
  }

  transcript(): Promise<ConsoleResult<ChatTranscript>> {
    return Promise.resolve(ok({ session: SESSION, turns: [] }))
  }

  send(_input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    return Promise.resolve(bad('not used here'))
  }

  subscribe(listener: (update: ChatUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

interface Harness {
  readonly registry: SilentRegistry
  readonly chat: SilentChat
  readonly deps: ConsoleDeps
  readonly handle: (request: Request) => Promise<Response>
  /** Epoch ms the handler sees. Assign to move time forward. */
  now: number
}

function setup(): Harness {
  const registry = new SilentRegistry()
  const chat = new SilentChat()
  const state = { now: START }
  const deps: ConsoleDeps = {
    registry,
    audit: new SilentAudit(),
    limits: LIMITS,
    now: () => state.now,
    label: 'tokyo-1',
    chat,
  }
  const handle = createConsoleHandler(deps, TOKENS)
  return {
    registry,
    chat,
    deps,
    handle,
    get now(): number {
      return state.now
    },
    set now(value: number) {
      state.now = value
    },
  }
}

/** A login form submission, shaped the way the rendered form submits it. */
function loginPost(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  })
}

/** What a browser sends: an `Accept` that names HTML. */
const HTML_ACCEPT = { accept: 'text/html,application/xhtml+xml' }

function withCookie(
  path: string,
  token: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers)
  headers.set('cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}`)
  return new Request(`${BASE}${path}`, { ...init, headers })
}

/** The `Set-Cookie` of a response, as one string. */
function setCookie(response: Response): string {
  return response.headers.get('set-cookie') ?? ''
}

/** Everything after `<name>=`, up to the first attribute. */
function cookieValue(header: string): string {
  const first = header.split(';')[0] ?? ''
  return first.slice(first.indexOf('=') + 1)
}

async function errorMessage(response: Response): Promise<string> {
  const parsed = (await response.json()) as {
    error?: { message?: string; code?: string }
  }
  return parsed.error?.message ?? ''
}

// ---------------------------------------------------------------------------
// the door
// ---------------------------------------------------------------------------

describe('GET /login', () => {
  test('is public and renders the field', async () => {
    const { handle } = setup()
    const response = await handle(new Request(`${BASE}/login`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    const html = await response.text()
    expect(html).toContain('name="token"')
    expect(html).toContain('method="post"')
    expect(html).toContain('action="/login"')
  })

  test('sends an already-authenticated browser on to the console', async () => {
    const { handle } = setup()
    const response = await handle(withCookie('/login', ADMIN))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
  })

  test('honours a safe redirect it was handed, and only a safe one', async () => {
    const { handle } = setup()
    const safe = await handle(
      withCookie(
        `/login?redirect=${encodeURIComponent('/chat?session=a')}`,
        VIEW,
      ),
    )
    expect(safe.headers.get('location')).toBe('/chat?session=a')

    const hostile = await handle(
      withCookie(
        `/login?redirect=${encodeURIComponent('https://evil.example/x')}`,
        VIEW,
      ),
    )
    expect(hostile.headers.get('location')).toBe('/')
  })

  test('never carries a token into the rendered page', async () => {
    const { handle } = setup()
    const html = await (
      await handle(new Request(`${BASE}/login?token=${WRONG}`))
    ).text()
    expect(html).not.toContain(WRONG)
    expect(html).not.toContain(VIEW)
    expect(html).not.toContain(ADMIN)
  })
})

describe('POST /login', () => {
  test('accepts the view token and sets the session cookie', async () => {
    const { handle } = setup()
    const response = await handle(loginPost({ token: VIEW, redirect: '/' }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(cookieValue(setCookie(response))).toBe(encodeURIComponent(VIEW))
  })

  test('accepts the admin token too — two strings, one door', async () => {
    const { handle } = setup()
    const response = await handle(loginPost({ token: ADMIN, redirect: '/' }))
    expect(response.status).toBe(303)
    expect(cookieValue(setCookie(response))).toBe(encodeURIComponent(ADMIN))
  })

  test('trims what was pasted rather than refusing it', async () => {
    const { handle } = setup()
    const response = await handle(loginPost({ token: ` ${ADMIN} ` }))
    expect(response.status).toBe(303)
  })

  test('refuses a wrong token with no cookie and no echo', async () => {
    const { handle } = setup()
    const response = await handle(loginPost({ token: WRONG }))
    expect(response.status).toBe(401)
    expect(setCookie(response)).toBe('')
    const html = await response.text()
    expect(html).toContain('令牌无效')
    expect(html).not.toContain(WRONG)
  })

  test('says the same thing for an empty field as for a wrong one', async () => {
    const { handle } = setup()
    const empty = await handle(loginPost({ token: '' }))
    const wrong = await handle(loginPost({ token: WRONG }))
    expect(empty.status).toBe(wrong.status)
    expect(await empty.text()).toBe(await wrong.text())
  })

  test('refuses a cross-origin submission outright', async () => {
    const { handle } = setup()
    const response = await handle(
      loginPost({ token: ADMIN }, { 'sec-fetch-site': 'cross-site' }),
    )
    expect(response.status).toBe(403)
    expect(setCookie(response)).toBe('')
  })

  test('accepts the browser`s own same-origin submission', async () => {
    const { handle } = setup()
    const response = await handle(
      loginPost({ token: ADMIN }, { 'sec-fetch-site': 'same-origin' }),
    )
    expect(response.status).toBe(303)
  })

  test('refuses a body that is not the login form', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: ADMIN }),
      }),
    )
    expect(response.status).toBe(400)
    expect(setCookie(response)).toBe('')
  })

  test('refuses an oversized body by its declared length', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': '99999',
        },
        body: `token=${'x'.repeat(64)}`,
      }),
    )
    expect(response.status).toBe(400)
  })

  test('a login redirect can only be a path on this console', async () => {
    const { handle } = setup()
    for (const hostile of [
      'https://evil.example/x',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      '/login',
    ]) {
      const response = await handle(
        loginPost({ token: ADMIN, redirect: hostile }),
      )
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/')
    }
  })

  test('other verbs are refused with the allowed pair', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/login`, { method: 'DELETE' }),
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
  })
})

describe('safeRedirect', () => {
  test.each([
    ['/', '/'],
    ['/chat', '/chat'],
    ['/chat?session=a%20b', '/chat?session=a%20b'],
  ])('keeps %s', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected)
  })

  test.each([
    'https://evil.example/x',
    '//evil.example',
    '/\\evil.example',
    'chat',
    '',
    '/login',
    '/login?redirect=/',
  ])('refuses %s', input => {
    expect(safeRedirect(input)).toBe('/')
  })

  test('refuses a smuggled control character', () => {
    expect(safeRedirect('/x\r\nSet-Cookie: a=b')).toBe('/')
    expect(safeRedirect('/x\u0000')).toBe('/')
  })

  test('absent is the root, not a crash', () => {
    expect(safeRedirect(null)).toBe('/')
    expect(safeRedirect(undefined)).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// the cookie itself
// ---------------------------------------------------------------------------

describe('the session cookie', () => {
  test('is HttpOnly, SameSite=Strict, Path=/ and lives a bounded time', async () => {
    const { handle } = setup()
    const header = setCookie(await handle(loginPost({ token: ADMIN })))
    expect(header).toContain(`${SESSION_COOKIE}=`)
    expect(header).toContain('; HttpOnly')
    expect(header).toContain('; SameSite=Strict')
    expect(header).toContain('; Path=/')
    expect(header).toContain(`; Max-Age=${SESSION_MAX_AGE_SECONDS}`)
  })

  test('names no Domain, so a sibling host cannot claim it', async () => {
    const { handle } = setup()
    expect(setCookie(await handle(loginPost({ token: ADMIN })))).not.toContain(
      'Domain',
    )
  })

  test('is not Secure over plain http — the SSH-tunnel case', async () => {
    const { handle } = setup()
    expect(setCookie(await handle(loginPost({ token: ADMIN })))).not.toContain(
      '; Secure',
    )
  })

  test('is Secure when a proxy says the browser leg was https', async () => {
    const { handle } = setup()
    const header = setCookie(
      await handle(
        loginPost({ token: ADMIN }, { 'x-forwarded-proto': 'https' }),
      ),
    )
    expect(header).toContain('; Secure')
  })

  test('reads only the first hop of a chained X-Forwarded-Proto', async () => {
    const { handle } = setup()
    const secure = setCookie(
      await handle(
        loginPost({ token: ADMIN }, { 'x-forwarded-proto': 'https, http' }),
      ),
    )
    expect(secure).toContain('; Secure')
    const plain = setCookie(
      await handle(
        loginPost({ token: ADMIN }, { 'x-forwarded-proto': 'http, https' }),
      ),
    )
    expect(plain).not.toContain('; Secure')
  })

  test('opens the console on the next request', async () => {
    const { handle } = setup()
    const response = await handle(
      withCookie('/', ADMIN, { headers: HTML_ACCEPT }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
  })

  test('survives a token an operator chose rather than one we generated', async () => {
    // `--admin-token` takes any string of 16 characters or more, and a `;` or a
    // space in one would end the cookie early if it were written raw.
    const awkward = 'a b;c=d,e"f\\g hijklmnop'
    const tokens: ConsoleTokens = { view: VIEW, admin: awkward }
    const handle = createConsoleHandler(setup().deps, tokens)
    const header = setCookie(await handle(loginPost({ token: awkward })))
    // One cookie, not two: everything after the first `;` must be attributes.
    expect(header.split(';')[0]).toBe(
      `${SESSION_COOKIE}=${encodeURIComponent(awkward)}`,
    )
    const back = await handle(
      new Request(`${BASE}/v0/agents`, {
        headers: {
          cookie: header.split(';')[0] ?? '',
          [CONSOLE_HEADER]: '1',
        },
      }),
    )
    expect(back.status).toBe(200)
  })

  test('a cookie carrying a rotated token is simply not a credential', async () => {
    const { handle } = setup()
    const response = await handle(withCookie('/v0/agents', WRONG))
    expect(response.status).toBe(401)
  })
})

describe('POST /logout', () => {
  test('clears the cookie with the same attributes it was set with', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/logout`, { method: 'POST' }),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
    const header = setCookie(response)
    expect(cookieValue(header)).toBe('')
    expect(header).toContain('; Max-Age=0')
    // Without these three the browser writes a *second* cookie and the
    // original keeps working.
    expect(header).toContain('; Path=/')
    expect(header).toContain('; HttpOnly')
    expect(header).toContain('; SameSite=Strict')
  })

  test('the cleared cookie is no longer a credential', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/v0/agents`, {
        headers: {
          cookie: `${SESSION_COOKIE}=`,
          [CONSOLE_HEADER]: '1',
        },
      }),
    )
    expect(response.status).toBe(401)
  })

  test('refuses a cross-origin submission', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/logout`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-site' },
      }),
    )
    expect(response.status).toBe(403)
    expect(setCookie(response)).toBe('')
  })

  test('is a POST, not a link somebody can be made to follow', async () => {
    const { handle } = setup()
    const response = await handle(new Request(`${BASE}/logout`))
    expect(response.status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// what the cookie costs: the CSRF rules
// ---------------------------------------------------------------------------

describe('a cookie alone is not enough off the document routes', () => {
  test.each([
    ['GET', '/v0/agents'],
    ['GET', '/v0/limits'],
    ['GET', '/v0/audit'],
    ['GET', '/fragments/roster'],
    ['GET', '/v0/chat/sessions'],
  ])('%s %s is refused without the console header', async (method, path) => {
    const { handle } = setup()
    const response = await handle(withCookie(path, ADMIN, { method }))
    expect(response.status).toBe(403)
    expect(await errorMessage(response)).toContain(CONSOLE_HEADER)
  })

  test('a cookie-only write is refused, and the port is never reached', async () => {
    const { handle, registry } = setup()
    const response = await handle(
      withCookie('/v0/agents', ADMIN, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: ADDRESS, endpoint: 'ws://h:1' }),
      }),
    )
    expect(response.status).toBe(403)
    expect(registry.registered).toBe(0)
  })

  test('a cookie-only DELETE is refused', async () => {
    const { handle } = setup()
    const response = await handle(
      withCookie(`/v0/agents/${encodeURIComponent(ADDRESS)}`, ADMIN, {
        method: 'DELETE',
      }),
    )
    expect(response.status).toBe(403)
  })

  test('the same requests pass once the header rides along', async () => {
    const { handle } = setup()
    const listed = await handle(
      withCookie('/v0/agents', ADMIN, { headers: { [CONSOLE_HEADER]: '1' } }),
    )
    expect(listed.status).toBe(200)

    const fragment = await handle(
      withCookie('/fragments/roster', ADMIN, {
        headers: { [CONSOLE_HEADER]: '1' },
      }),
    )
    expect(fragment.status).toBe(200)
  })

  test('the header alone is not a credential', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/v0/agents`, { headers: { [CONSOLE_HEADER]: '1' } }),
    )
    expect(response.status).toBe(401)
  })

  test('an anonymous caller gets 401 whether or not it sent the header', async () => {
    const { handle } = setup()
    const bare = await handle(new Request(`${BASE}/v0/agents`))
    const dressed = await handle(withCookie('/v0/agents', WRONG))
    expect(bare.status).toBe(401)
    expect(dressed.status).toBe(401)
  })

  test('documents accept the cookie alone — a navigation cannot send a header', async () => {
    const { handle } = setup()
    const ledger = await handle(withCookie('/', ADMIN))
    expect(ledger.status).toBe(200)
    const chat = await handle(withCookie('/chat', ADMIN))
    expect(chat.status).toBe(200)
  })

  test('the stream accepts a cookie from this origin and refuses another', async () => {
    const { handle } = setup()
    const same = await handle(
      withCookie('/v0/chat/stream', ADMIN, {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    )
    expect(same.status).toBe(200)
    await same.body?.cancel()

    // `same-site` is the value that gives the port-blind SameSite rule away:
    // another local app on another port is same-site with this console.
    const sibling = await handle(
      withCookie('/v0/chat/stream', ADMIN, {
        headers: { 'sec-fetch-site': 'same-site' },
      }),
    )
    expect(sibling.status).toBe(403)
  })

  test('a Bearer opens the stream from anywhere — it is not ambient', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/v0/chat/stream`, {
        headers: {
          authorization: `Bearer ${ADMIN}`,
          'sec-fetch-site': 'cross-site',
        },
      }),
    )
    expect(response.status).toBe(200)
    await response.body?.cancel()
  })
})

// ---------------------------------------------------------------------------
// the two older ways in
// ---------------------------------------------------------------------------

describe('the older credentials are untouched', () => {
  test('Bearer still works on every shape of route, header or no header', async () => {
    const { handle } = setup()
    const bearer = { authorization: `Bearer ${ADMIN}` }
    expect(
      (await handle(new Request(`${BASE}/v0/agents`, { headers: bearer })))
        .status,
    ).toBe(200)
    expect(
      (
        await handle(
          new Request(`${BASE}/fragments/roster`, { headers: bearer }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await handle(
          new Request(`${BASE}/v0/agents/${encodeURIComponent(ADDRESS)}`, {
            method: 'DELETE',
            headers: bearer,
          }),
        )
      ).status,
    ).toBe(204)
  })

  test('the banner`s ?token= URL still opens the page', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/?token=${VIEW}`, { headers: HTML_ACCEPT }),
    )
    expect(response.status).toBe(200)
  })

  test('?token= still authenticates a JSON route with no header', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/v0/agents?token=${VIEW}`),
    )
    expect(response.status).toBe(200)
  })

  test('a stale ?token= beside a live cookie falls through to the cookie', async () => {
    const { handle } = setup()
    const response = await handle(
      withCookie(`/v0/agents?token=${WRONG}`, ADMIN, {
        headers: { [CONSOLE_HEADER]: '1' },
      }),
    )
    expect(response.status).toBe(200)
  })

  test('a view cookie still cannot reach an admin route', async () => {
    const { handle } = setup()
    const response = await handle(
      withCookie('/v0/chat/sessions', VIEW, {
        headers: { [CONSOLE_HEADER]: '1' },
      }),
    )
    expect(response.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// what an unauthenticated caller is told
// ---------------------------------------------------------------------------

describe('unauthenticated', () => {
  test('a browser navigation is sent to the door, with the way back', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/chat?session=abc`, { headers: HTML_ACCEPT }),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      `/login?redirect=${encodeURIComponent('/chat?session=abc')}`,
    )
  })

  test('the root needs no redirect parameter to come back to', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/`, { headers: HTML_ACCEPT }),
    )
    expect(response.headers.get('location')).toBe('/login')
  })

  test('a dead token in the URL is not carried into the redirect', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/?token=${WRONG}&source=router`, {
        headers: HTML_ACCEPT,
      }),
    )
    const location = response.headers.get('location') ?? ''
    expect(location).not.toContain(WRONG)
    expect(decodeURIComponent(location)).toContain('source=router')
  })

  test('an API caller keeps the 401 JSON it always got', async () => {
    const { handle } = setup()
    const response = await handle(new Request(`${BASE}/v0/agents`))
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
  })

  test('a fragment poll is not redirected into a login page', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/fragments/roster`, { headers: { accept: '*/*' } }),
    )
    expect(response.status).toBe(401)
  })

  test('a POST that accepts HTML is refused, not redirected', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/v0/agents`, {
        method: 'POST',
        headers: { ...HTML_ACCEPT, 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(response.status).toBe(401)
  })

  test('a 401 never repeats the token it was given', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/v0/agents?token=${WRONG}`),
    )
    expect(await response.text()).not.toContain(WRONG)
  })

  test('a view token navigating to an admin page is shown the card in place', async () => {
    const { handle } = setup()
    const response = await handle(
      withCookie('/chat', VIEW, { headers: HTML_ACCEPT }),
    )
    expect(response.status).toBe(403)
    const html = await response.text()
    expect(html).toContain('该页面需要 admin 令牌')
    expect(html).toContain(`value="${'/chat'}"`)
  })

  test('a view token calling an admin API still gets JSON', async () => {
    const { handle } = setup()
    const response = await handle(
      new Request(`${BASE}/v0/chat/sessions`, {
        headers: { authorization: `Bearer ${VIEW}` },
      }),
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
  })
})

// ---------------------------------------------------------------------------
// the throttle
// ---------------------------------------------------------------------------

describe('login throttle', () => {
  let throttle: LoginThrottle

  beforeEach(() => {
    throttle = new LoginThrottle()
  })

  test('the first five failures cost nothing', () => {
    for (let i = 0; i < 5; i += 1) throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('a', START)).toBe(0)
  })

  test('the sixth starts a delay that doubles', () => {
    for (let i = 0; i < 6; i += 1) throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('a', START)).toBe(1)
    throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('a', START)).toBe(2)
    throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('a', START)).toBe(4)
  })

  test('the delay is capped rather than unbounded', () => {
    for (let i = 0; i < 40; i += 1) throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('a', START)).toBe(300)
  })

  test('waiting it out is enough', () => {
    for (let i = 0; i < 6; i += 1) throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('a', START + 999)).toBe(1)
    expect(throttle.retryAfterSeconds('a', START + 1_000)).toBe(0)
  })

  test('a right answer erases the wrong ones', () => {
    for (let i = 0; i < 8; i += 1) throttle.recordFailure('a', START)
    throttle.clear('a')
    expect(throttle.retryAfterSeconds('a', START)).toBe(0)
  })

  test('keys do not shadow each other', () => {
    for (let i = 0; i < 8; i += 1) throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('b', START)).toBe(0)
  })

  test('an idle counter is forgotten after an hour', () => {
    for (let i = 0; i < 8; i += 1) throttle.recordFailure('a', START)
    expect(throttle.retryAfterSeconds('a', START + 3_600_001)).toBe(0)
  })

  test('writing a failure forgets an expired counter without a preceding read', () => {
    for (let i = 0; i < 8; i += 1) throttle.recordFailure('a', START)
    throttle.recordFailure('b', START + 1_000)
    throttle.recordFailure('a', START + 3_600_001)
    expect(throttle.retryAfterSeconds('a', START + 3_600_001)).toBe(0)
  })

  test('refreshing one counter does not retain a different expired counter', () => {
    for (let i = 0; i < 8; i += 1) {
      throttle.recordFailure('a', START)
      throttle.recordFailure('b', START)
    }
    throttle.recordFailure('a', START + 3_600_000)
    throttle.recordFailure('b', START + 3_600_001)
    expect(throttle.retryAfterSeconds('a', START + 3_600_001)).toBe(8)
    expect(throttle.retryAfterSeconds('b', START + 3_600_001)).toBe(0)
  })
})

describe('POST /login is throttled', () => {
  test('blocks after the free attempts and recovers when the clock moves', async () => {
    const harness = setup()
    for (let i = 0; i < 6; i += 1) {
      const attempt = await harness.handle(loginPost({ token: WRONG }))
      expect(attempt.status).toBe(401)
    }

    const blocked = await harness.handle(loginPost({ token: WRONG }))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('1')
    expect(await blocked.text()).toContain('尝试过多 · 请等 1 秒')

    // Blocked means blocked: the right token does not skip the queue, and the
    // throttle therefore cannot be used to test one guess per lockout.
    const rightButEarly = await harness.handle(loginPost({ token: ADMIN }))
    expect(rightButEarly.status).toBe(429)
    expect(setCookie(rightButEarly)).toBe('')

    harness.now = START + 1_000
    const allowed = await harness.handle(loginPost({ token: ADMIN }))
    expect(allowed.status).toBe(303)
    expect(cookieValue(setCookie(allowed))).toBe(encodeURIComponent(ADMIN))
  })

  test('a success clears the count for the next visitor on that key', async () => {
    const harness = setup()
    for (let i = 0; i < 5; i += 1)
      await harness.handle(loginPost({ token: WRONG }))
    expect((await harness.handle(loginPost({ token: ADMIN }))).status).toBe(303)
    // Five more would have crossed the line had the counter survived.
    for (let i = 0; i < 5; i += 1) {
      expect((await harness.handle(loginPost({ token: WRONG }))).status).toBe(
        401,
      )
    }
  })

  test('two consoles in one process do not throttle each other', async () => {
    const first = setup()
    const second = setup()
    for (let i = 0; i < 8; i += 1)
      await first.handle(loginPost({ token: WRONG }))
    expect((await second.handle(loginPost({ token: ADMIN }))).status).toBe(303)
  })

  test('the throttled page still never echoes the token', async () => {
    const harness = setup()
    for (let i = 0; i < 7; i += 1)
      await harness.handle(loginPost({ token: WRONG }))
    const blocked = await harness.handle(loginPost({ token: WRONG }))
    expect(blocked.status).toBe(429)
    expect(await blocked.text()).not.toContain(WRONG)
  })
})

// ---------------------------------------------------------------------------
// the page itself
// ---------------------------------------------------------------------------

describe('the login document', () => {
  const html = renderLoginPage({ label: 'node-a', redirect: '/chat' })

  function visibleText(markup: string): string {
    return markup
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]*>/g, ' ')
  }

  test('loads nothing from anywhere', () => {
    // The favicon link is lifted out first: it is a self-contained `data:`
    // URI, not a host, and the property this asserts is about hosts. Taking
    // the line out keeps the check as tight as it was for everything else.
    const stripped = html.replace(/<link rel="icon"[^>]*>\n?/, '')
    expect(stripped).not.toBe(html)
    expect(stripped).not.toContain('<link')
    expect(stripped).not.toContain('<iframe')
    expect(stripped).not.toContain('src=')
    expect(stripped).not.toContain('http://')
    expect(stripped).not.toContain('https://')
  })

  test('states what the two tokens can do, because one field takes both', () => {
    // There is no account system to tell them apart in advance (§8.1), so an
    // operator pasting the view token and then finding no wake button
    // concludes the console is broken. Two lines here beat that round trip.
    expect(html).toContain('>view</span>')
    expect(html).toContain('只读参观 · 看名册与消息链 · 不能唤醒与注销')
    expect(html).toContain('>admin</span>')
    expect(html).toContain('可操作 · 注册 唤醒 注销 全部开放')
  })

  test('carries the same strict policy as the other two documents', () => {
    expect(html).toContain('default-src &#39;none&#39;')
    expect(html).toContain('form-action &#39;self&#39;')
  })

  test('has no script at all — the door works with JS off', () => {
    expect(html).not.toContain('<script')
  })

  test('keeps the copy discipline the rest of the console keeps', () => {
    const text = visibleText(html)
    expect(text).not.toContain('。')
    expect(text).not.toContain('，')
    expect(text).not.toContain('、')
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('names the instance, so two consoles are told apart', () => {
    expect(visibleText(html)).toContain('node-a')
  })

  test('escapes a redirect on the way into the hidden field', () => {
    const nasty = renderLoginPage({
      label: 'node-a',
      redirect: '/x"><script>alert(1)</script>',
    })
    expect(nasty).not.toContain('<script>alert(1)')
    expect(nasty).toContain('&quot;')
  })

  test('escapes the label too — it comes from the command line', () => {
    const nasty = renderLoginPage({
      label: '<img onerror=alert(1)>',
      redirect: '/',
    })
    expect(nasty).not.toContain('<img onerror')
  })

  test('renders the error as one line, in the alert role', () => {
    const failed = renderLoginPage({
      label: 'node-a',
      redirect: '/',
      error: '令牌无效',
    })
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('令牌无效')
  })
})

describe('the sidebar says which credential this is', () => {
  test('admin and view are told apart, and both offer the way out', async () => {
    const { handle } = setup()
    const asAdmin = await (await handle(withCookie('/', ADMIN))).text()
    expect(asAdmin).toContain('>管理<')
    expect(asAdmin).toContain('action="/logout"')

    const asView = await (await handle(withCookie('/', VIEW))).text()
    expect(asView).toContain('>只读<')
    expect(asView).not.toContain('>管理<')
  })

  test('the chat page states it too', async () => {
    const { handle } = setup()
    const html = await (await handle(withCookie('/chat', ADMIN))).text()
    expect(html).toContain('>管理<')
    expect(html).toContain('action="/logout"')
  })
})

// ---------------------------------------------------------------------------
// over a real socket
// ---------------------------------------------------------------------------

describe('startConsoleServer', () => {
  let server: ConsoleServerHandle | null = null

  afterAll(async () => {
    await server?.stop()
  })

  test('serves the door and the cookie it hands out', async () => {
    const { deps } = setup()
    server = startConsoleServer(deps, undefined, { tokens: TOKENS })

    const door = await fetch(`${server.url}/login`, { redirect: 'manual' })
    expect(door.status).toBe(200)

    const denied = await fetch(`${server.url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: WRONG }).toString(),
      redirect: 'manual',
    })
    expect(denied.status).toBe(401)

    const accepted = await fetch(`${server.url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: ADMIN }).toString(),
      redirect: 'manual',
    })
    expect(accepted.status).toBe(303)
    const cookie = accepted.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')

    // The value a browser would send back, which is the point of the round
    // trip: this is the one place the real `Bun.serve` request path is
    // exercised, including the client address the throttle keys on.
    const jar = (cookie.split(';')[0] ?? '').trim()
    const page = await fetch(server.url, { headers: { cookie: jar } })
    expect(page.status).toBe(200)

    const guarded = await fetch(`${server.url}/v0/agents`, {
      headers: { cookie: jar },
    })
    expect(guarded.status).toBe(403)

    const withHeader = await fetch(`${server.url}/v0/agents`, {
      headers: { cookie: jar, [CONSOLE_HEADER]: '1' },
    })
    expect(withHeader.status).toBe(200)
  })
})
