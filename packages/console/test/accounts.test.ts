// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.5 — the minimal account (`tenancy-m1.md` §3.2–§3.5, §6 DoD): sessions,
 * the fail-closed ledgers, where a personal credential may and may not ride,
 * break-glass, the migration switches, and the contract P14 builds on.
 *
 * Chat ownership and the scoped event stream have their own file
 * (`chatScope.test.ts`). Like `invites.test.ts`, the assertions are on what was
 * done — ledger lines, port calls, cookies — as well as on what was answered.
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  ACCOUNT_SESSION_COOKIE,
  principalOf,
  resolveAccess,
  type ConsoleAccounts,
} from '../src/access.js'
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  mayApprove,
  tokenFingerprint,
  type AccountEnded,
  type ConsolePrincipal,
} from '../src/accounts.js'
import {
  CONSOLE_CHAT_JS,
  CONSOLE_CHAT_JS_ACCOUNTS,
} from '../src/assets/chatClient.js'
import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from '../src/assets/client.js'
import { SESSION_COOKIE } from '../src/auth.js'
import {
  encodeLedgerEntry,
  ledgerDigest,
  nextPrevious,
  readLedger,
  type LedgerEntry,
} from '../src/ledger.js'
import {
  ADMIN,
  BASE,
  CONSOLE_HEADER,
  HOUR,
  ManualClock,
  MemoryLedger,
  TOKENS,
  VIEW,
  accountsHarness,
  asAdmin,
  asBearer,
  asSession,
  cookieFrom,
  credentialOn,
  formPost,
  invite,
  person,
  setCookieLine,
  type AccountsHarness,
} from './accountsHarness.js'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const MINUTE = 60 * 1000

/** The subject behind a credential, read the way P14 will read it. */
function subjectOf(h: AccountsHarness, credential: string): `u:${string}` {
  const principal = principalOf(
    asBearer('GET', '/v0/limits', credential),
    TOKENS,
    { book: h.book },
  )
  if (principal?.kind !== 'user') throw new Error('not a person')
  return principal.subject
}

/** Status of a read that needs any valid credential. */
async function statusWith(h: AccountsHarness, request: Request) {
  return (await h.handle(request)).status
}

function limitsWithSession(sid: string): Request {
  return asSession('GET', '/v0/limits', sid)
}

function limitsWithBearer(bearer: string): Request {
  return asBearer('GET', '/v0/limits', bearer)
}

/** Re-chain a list of entries from the genesis, the way an honest writer would. */
function rechain(entries: readonly LedgerEntry[]): string {
  let prev = nextPrevious([])
  let text = ''
  for (const [index, entry] of entries.entries()) {
    const next: LedgerEntry = { ...entry, seq: index + 1, prev }
    prev = ledgerDigest(next)
    text += encodeLedgerEntry(next)
  }
  return text
}

function entriesOf(text: string): LedgerEntry[] {
  const read = readLedger(text)
  if (!read.ok)
    throw new Error(`fixture ledger unreadable: ${read.issue.reason}`)
  return [...read.entries]
}

// --- invariant 1: bad lines close the book -----------------------------------

/**
 * A console on which member A was revoked, with a live session and credential
 * captured before the revocation, and one more invitation after it so the
 * `account.revoked` line is not the last one.
 */
async function revokedFixture(
  options: { readonly revokedLast?: boolean } = {},
) {
  const h = accountsHarness()
  const a = await person(h.handle, 'member')
  const subject = subjectOf(h, a.credential)
  const revoked = await h.handle(
    asAdmin('POST', `/v0/accounts/${subject}/revoke`),
  )
  expect(revoked.status).toBe(204)
  if (options.revokedLast !== true) await invite(h.handle, 'viewer')
  return {
    a,
    subject,
    accounts: h.ledger.text ?? '',
    sessions: h.sessions.text ?? '',
  }
}

/** A fresh console over the given ledger texts, as a restart would build it. */
function restart(accounts: string, sessions: string): AccountsHarness {
  return accountsHarness({
    ledger: new MemoryLedger('memory://accounts.ndjson', accounts),
    sessions: new MemoryLedger('memory://sessions.ndjson', sessions),
  })
}

async function expectClosedBook(
  h: AccountsHarness,
  a: { readonly credential: string; readonly sid: string },
): Promise<void> {
  expect(h.book.problem).not.toBeNull()
  expect(h.alarms.length).toBeGreaterThanOrEqual(1)
  // The revoked person is refused as unavailable — never let back in.
  const bearer = await h.handle(limitsWithBearer(a.credential))
  expect(bearer.status).toBe(503)
  const body = await bearer.text()
  expect(body).toContain('"unavailable"')
  expect(body.includes(a.credential)).toBe(false)
  expect(await statusWith(h, limitsWithSession(a.sid))).toBe(503)
  // Browsers get the card with the reason, not a redirect loop.
  const page = await h.handle(
    asSession('GET', '/', a.sid, { header: false, accept: 'text/html' }),
  )
  expect(page.status).toBe(503)
  expect((await page.text()).includes('个人账号暂停服务')).toBe(true)
  // Nobody can open an account on a closed book either.
  expect(
    (await h.handle(asAdmin('POST', '/v0/accounts/invites', { role: 'ops' })))
      .status,
  ).toBe(503)
  // And the two legacy tokens still open the console, so somebody can look.
  expect(await statusWith(h, limitsWithBearer(ADMIN))).toBe(200)
  expect(await statusWith(h, limitsWithBearer(VIEW))).toBe(200)
}

describe('a ledger with a bad line closes the book (invariant 1)', () => {
  test('control: the untouched ledgers replay, and the revocation holds', async () => {
    const fixture = await revokedFixture()
    const h = restart(fixture.accounts, fixture.sessions)
    expect(h.book.problem).toBeNull()
    expect(h.alarms).toEqual([])
    expect(await statusWith(h, limitsWithBearer(fixture.a.credential))).toBe(
      401,
    )
    expect(await statusWith(h, limitsWithSession(fixture.a.sid))).toBe(401)
  })

  const tamperings: ReadonlyArray<
    readonly [string, (entries: LedgerEntry[], text: string) => string]
  > = [
    [
      'the revoked line is not JSON',
      (entries, text) => {
        const lines = text.split('\n')
        const at = entries.findIndex(e => e.kind === 'account.revoked')
        lines[at] = '{"seq":'
        return lines.join('\n')
      },
    ],
    [
      'the revoked line names a kind this build does not know (re-chained)',
      entries =>
        rechain(
          entries.map(e =>
            e.kind === 'account.revoked' ? { ...e, kind: 'account.revokd' } : e,
          ),
        ),
    ],
    [
      'the revoked line carries an extra field',
      (entries, text) => {
        const lines = text.split('\n')
        const at = entries.findIndex(e => e.kind === 'account.revoked')
        lines[at] = (lines[at] ?? '').replace('{"seq"', '{"note":"x","seq"')
        return lines.join('\n')
      },
    ],
    [
      'the revoked line was edited in place',
      (entries, text) => {
        const lines = text.split('\n')
        const at = entries.findIndex(e => e.kind === 'account.revoked')
        lines[at] = (lines[at] ?? '').replace(
          '"by":"legacy:admin"',
          '"by":"u:0000000000000000"',
        )
        return lines.join('\n')
      },
    ],
    [
      'the revoked line was deleted',
      (entries, text) => {
        const lines = text.split('\n')
        const at = entries.findIndex(e => e.kind === 'account.revoked')
        lines.splice(at, 1)
        return lines.join('\n')
      },
    ],
    [
      'the revocation names an account that does not exist (re-chained)',
      entries =>
        rechain(
          entries.map(e =>
            e.kind === 'account.revoked'
              ? { ...e, data: { ...e.data, subject: 'u:ffffffffffffffff' } }
              : e,
          ),
        ),
    ],
  ]

  for (const [name, tamper] of tamperings) {
    test(`${name}: personal access is 503, legacy tokens work, an alarm is raised`, async () => {
      const fixture = await revokedFixture()
      const tampered = tamper(entriesOf(fixture.accounts), fixture.accounts)
      expect(tampered).not.toBe(fixture.accounts)
      const h = restart(tampered, fixture.sessions)
      await expectClosedBook(h, fixture.a)
    })
  }

  test('a torn last line (a crash mid-write of the revocation) closes the book too', async () => {
    const fixture = await revokedFixture({ revokedLast: true })
    const torn = fixture.accounts.slice(0, fixture.accounts.length - 20)
    expect(torn.endsWith('\n')).toBe(false)
    const h = restart(torn, fixture.sessions)
    await expectClosedBook(h, fixture.a)
    expect(h.alarms.join('\n')).toContain('末行不完整')
  })

  test('a bad session line closes the book: a logged-out session is not revived', async () => {
    const h0 = accountsHarness()
    const a = await person(h0.handle, 'member')
    const out = await h0.handle(
      formPost('/logout', {}, { cookie: `${ACCOUNT_SESSION_COOKIE}=${a.sid}` }),
    )
    expect(out.status).toBe(303)
    const sessions = entriesOf(h0.sessions.text ?? '')
    expect(sessions.at(-1)?.kind).toBe('session.closed')

    // Every way the closing line can be spoiled, each on its own restart.
    const spoiled = [
      rechain(
        sessions.map(e =>
          e.kind === 'session.closed'
            ? { ...e, data: { ...e.data, reason: 'whatever' } }
            : e,
        ),
      ),
      rechain(
        sessions.map(e =>
          e.kind === 'session.closed' ? { ...e, kind: 'session.kept' } : e,
        ),
      ),
      `${(h0.sessions.text ?? '').trimEnd()}\nnot json\n`,
      (h0.sessions.text ?? '').slice(0, -5),
    ]
    for (const text of spoiled) {
      const h = restart(h0.ledger.text ?? '', text)
      expect(h.book.problem).not.toBeNull()
      expect(h.alarms.length).toBeGreaterThanOrEqual(1)
      expect(await statusWith(h, limitsWithSession(a.sid))).toBe(503)
      expect(await statusWith(h, limitsWithBearer(a.credential))).toBe(503)
      expect(await statusWith(h, limitsWithBearer(ADMIN))).toBe(200)
    }
  })

  test('the alarm repeats for refused requests, at most once a minute', async () => {
    const fixture = await revokedFixture()
    const h = restart('garbage\n', fixture.sessions)
    expect(h.alarms).toHaveLength(1)
    for (let i = 0; i < 5; i++) {
      expect(await statusWith(h, limitsWithBearer(fixture.a.credential))).toBe(
        503,
      )
    }
    expect(h.alarms).toHaveLength(1)
    h.clock.advance(MINUTE + 1)
    await h.handle(limitsWithBearer(fixture.a.credential))
    await h.handle(limitsWithBearer(fixture.a.credential))
    expect(h.alarms).toHaveLength(2)
  })

  test('a session-table write that fails closes the book on the spot', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    h.sessions.failAppends = true
    const login = await h.handle(
      formPost(
        '/login',
        { token: a.credential },
        { 'sec-fetch-site': 'same-origin' },
      ),
    )
    expect(login.status).toBe(503)
    expect(login.headers.getSetCookie()).toEqual([])
    expect(h.book.problem).not.toBeNull()
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(503)
    expect(await statusWith(h, limitsWithBearer(ADMIN))).toBe(200)
  })
})

// --- invariant 4: where a personal credential may ride -------------------------

describe('a personal credential never rides in a query string (invariant 4)', () => {
  test('?token=qmu_… is refused outright, valid or not, and never echoed', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    for (const token of [a.credential, 'qmu_not-a-real-one']) {
      for (const path of [
        '/v0/limits',
        '/v0/chat/sessions',
        '/fragments/roster',
      ]) {
        const response = await h.handle(
          new Request(`${BASE}${path}?token=${encodeURIComponent(token)}`, {
            headers: { [CONSOLE_HEADER]: '1' },
          }),
        )
        expect(response.status).toBe(400)
        const body = await response.text()
        expect(body).toContain('"invalid"')
        expect(body.includes(token)).toBe(false)
      }
      // Even beside a working session cookie: the link is the problem.
      const page = await h.handle(
        new Request(`${BASE}/?token=${encodeURIComponent(token)}`, {
          headers: {
            accept: 'text/html',
            cookie: `${ACCOUNT_SESSION_COOKIE}=${a.sid}`,
          },
        }),
      )
      expect(page.status).toBe(400)
      const html = await page.text()
      expect(html.includes('个人凭据不能放进链接')).toBe(true)
      expect(html.includes(token)).toBe(false)
    }
    // The same credential as a bearer is fine: that is the scripted position.
    expect(await statusWith(h, limitsWithBearer(a.credential))).toBe(200)
  })

  test('the session cookie carries the session id only, HttpOnly and SameSite=Strict, Secure behind TLS', async () => {
    const h = accountsHarness()
    const { token } = await invite(h.handle, 'member')
    const plain = await h.handle(formPost('/invite', { invite: token }))
    const credential = credentialOn(await plain.text())
    const line = setCookieLine(plain, ACCOUNT_SESSION_COOKIE) ?? ''
    expect(line).toMatch(
      /^qianmo_session=qms_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/,
    )
    const sid = cookieFrom(plain, ACCOUNT_SESSION_COOKIE) ?? ''
    expect(sid).not.toBe(credential)
    expect(line.includes(credential)).toBe(false)
    // The legacy cookie is cleared by the same response (module note, accountsHttp.ts).
    expect(setCookieLine(plain, SESSION_COOKIE)).toContain('Max-Age=0')

    // Behind a TLS-terminating proxy, `Secure` is added — for login as well.
    const login = await h.handle(
      formPost(
        '/login',
        { token: credential },
        { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' },
      ),
    )
    expect(login.status).toBe(303)
    expect(setCookieLine(login, ACCOUNT_SESSION_COOKIE)).toMatch(
      /; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/,
    )
    // A personal login drops any legacy cookie, which would otherwise win.
    expect(setCookieLine(login, SESSION_COOKIE)).toMatch(/Max-Age=0; Secure$/)

    // On disk, the session table knows the id by its hash only.
    const table = h.sessions.text ?? ''
    expect(table.includes(sid)).toBe(false)
    expect(table.includes(sha256(sid))).toBe(true)
    expect(table.includes(credential)).toBe(false)
  })

  test('the page scripts refuse to keep a personal credential in localStorage', () => {
    for (const [legacy, guarded] of [
      [CONSOLE_CLIENT_JS, CONSOLE_CLIENT_JS_ACCOUNTS],
      [CONSOLE_CHAT_JS, CONSOLE_CHAT_JS_ACCOUNTS],
    ] as const) {
      expect(legacy.includes('qmu_')).toBe(false)
      // One setItem in the whole script, and it is inside writeToken, after
      // the guard.
      expect(guarded.split('localStorage.setItem').length - 1).toBe(1)
      const start = guarded.indexOf('function readToken() {')
      const writer = guarded.indexOf('function writeToken(value) {')
      const end = guarded.indexOf('\n  }\n', writer) + 4
      expect(start).toBeGreaterThan(0)
      expect(guarded.indexOf('localStorage.setItem')).toBeGreaterThan(writer)
      expect(guarded.indexOf('localStorage.setItem')).toBeLessThan(end)

      // Run the two functions against a fake storage.
      const store = new Map<string, string>()
      const said: string[] = []
      const fakeWindow = {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => {
            store.set(key, value)
          },
          removeItem: (key: string) => {
            store.delete(key)
          },
        },
      }
      const make = new Function(
        'window',
        'say',
        `var TOKEN_KEY = 'k'; var memoryToken = '';
         function byId() { return null; }
         function paintToken() {}
         ${guarded.slice(start, end)}
         return { readToken: readToken, writeToken: writeToken };`,
      ) as (
        w: typeof fakeWindow,
        say: (el: unknown, text: string) => void,
      ) => { readToken(): string; writeToken(value: string): void }
      const fns = make(fakeWindow, (_el, text) => {
        said.push(text)
      })
      fns.writeToken('qmu_abcdef')
      expect(store.size).toBe(0)
      expect(said).toContain('个人凭据请在登录页填写')
      fns.writeToken(ADMIN)
      expect(store.get('k')).toBe(ADMIN)
      store.set('k', 'qmu_left-over')
      expect(fns.readToken()).toBe('')
      expect(store.has('k')).toBe(false)
    }
  })

  test('with accounts on, every page and the asset route serve the guarded scripts', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const index = await (
      await h.handle(asSession('GET', '/', a.sid, { header: false }))
    ).text()
    expect(index.includes(CONSOLE_CLIENT_JS_ACCOUNTS)).toBe(true)
    const chat = await (
      await h.handle(asSession('GET', '/chat', a.sid, { header: false }))
    ).text()
    expect(chat.includes(CONSOLE_CHAT_JS_ACCOUNTS)).toBe(true)
    const asset = await (
      await h.handle(new Request(`${BASE}/assets/app.js`))
    ).text()
    expect(asset).toBe(CONSOLE_CLIENT_JS_ACCOUNTS)
    // The login page and the credential page have no script at all.
    const login = await (await h.handle(new Request(`${BASE}/login`))).text()
    expect(login.includes('<script')).toBe(false)
  })
})

// --- invariant 7: sessions --------------------------------------------------

describe('sessions (invariant 7)', () => {
  test('login mints a new id and closes the one the browser came in with', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const login = await h.handle(
      formPost(
        '/login',
        { token: a.credential },
        {
          cookie: `${ACCOUNT_SESSION_COOKIE}=${a.sid}`,
          'sec-fetch-site': 'same-origin',
        },
      ),
    )
    expect(login.status).toBe(303)
    const fresh = cookieFrom(login, ACCOUNT_SESSION_COOKIE) ?? ''
    expect(fresh.startsWith('qms_')).toBe(true)
    expect(fresh).not.toBe(a.sid)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(401)
    expect(await statusWith(h, limitsWithSession(fresh))).toBe(200)
    const closed = entriesOf(h.sessions.text ?? '').filter(
      e => e.kind === 'session.closed',
    )
    expect(closed.map(e => e.data['reason'])).toEqual(['rotated'])
  })

  test('a session id planted before login is never adopted (fixation)', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const attacker = await person(h.handle, 'member')
    // The attacker plants their own, valid session in the victim's browser.
    const login = await h.handle(
      formPost(
        '/login',
        { token: a.credential },
        {
          cookie: `${ACCOUNT_SESSION_COOKIE}=${attacker.sid}`,
          'sec-fetch-site': 'same-origin',
        },
      ),
    )
    const fresh = cookieFrom(login, ACCOUNT_SESSION_COOKIE) ?? ''
    expect(fresh).not.toBe(attacker.sid)
    // The planted id is dead, so the attacker cannot ride the victim's login.
    expect(await statusWith(h, limitsWithSession(attacker.sid))).toBe(401)
    // An id the server never issued is equally worthless before and after.
    const planted = `qms_${'A'.repeat(43)}`
    const second = await h.handle(
      formPost(
        '/login',
        { token: a.credential },
        {
          cookie: `${ACCOUNT_SESSION_COOKIE}=${planted}`,
          'sec-fetch-site': 'same-origin',
        },
      ),
    )
    expect(cookieFrom(second, ACCOUNT_SESSION_COOKIE)).not.toBe(planted)
    expect(await statusWith(h, limitsWithSession(planted))).toBe(401)
  })

  test('logout closes the server session and clears both cookies', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const out = await h.handle(
      formPost('/logout', {}, { cookie: `${ACCOUNT_SESSION_COOKIE}=${a.sid}` }),
    )
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toBe('/login')
    expect(setCookieLine(out, ACCOUNT_SESSION_COOKIE)).toContain('Max-Age=0')
    expect(setCookieLine(out, SESSION_COOKIE)).toContain('Max-Age=0')
    // A copy of the id lifted before the logout is dead too.
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(401)
    const last = entriesOf(h.sessions.text ?? '').at(-1)
    expect(last?.kind).toBe('session.closed')
    expect(last?.data['reason']).toBe('logout')
  })

  test(`is over after ${SESSION_IDLE_MS / HOUR} h without a request`, async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    h.clock.advance(SESSION_IDLE_MS - 1)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(200)
    // That request was use: the idle clock starts again from here.
    h.clock.advance(SESSION_IDLE_MS - 1)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(200)
    h.clock.advance(SESSION_IDLE_MS)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(401)
    const last = entriesOf(h.sessions.text ?? '').at(-1)
    expect(last?.data['reason']).toBe('expired')
  })

  test(`is over ${SESSION_ABSOLUTE_MS / HOUR} h after it began, however busy`, async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    for (let hour = 1; hour < SESSION_ABSOLUTE_MS / HOUR; hour++) {
      h.clock.advance(HOUR)
      expect(await statusWith(h, limitsWithSession(a.sid))).toBe(200)
    }
    h.clock.advance(HOUR)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(401)
  })

  test('survives a restart, and idleness is written down at most every 15 minutes', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const before = entriesOf(h.sessions.text ?? '').length
    // Ten requests inside fifteen minutes: no write.
    for (let i = 0; i < 10; i++) {
      h.clock.advance(MINUTE)
      expect(await statusWith(h, limitsWithSession(a.sid))).toBe(200)
    }
    expect(entriesOf(h.sessions.text ?? '').length).toBe(before)
    h.clock.advance(6 * MINUTE)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(200)
    expect(entriesOf(h.sessions.text ?? '').at(-1)?.kind).toBe(
      'session.touched',
    )

    const clock = new ManualClock(h.clock.now())
    clock.advance(HOUR)
    const again = accountsHarness({
      clock,
      ledger: new MemoryLedger('memory://accounts.ndjson', h.ledger.text),
      sessions: new MemoryLedger('memory://sessions.ndjson', h.sessions.text),
    })
    expect(again.book.problem).toBeNull()
    expect(await statusWith(again, limitsWithSession(a.sid))).toBe(200)
  })

  test('cookie writes keep the console-header rule; documents and the stream do not need it', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    expect(
      await statusWith(
        h,
        asSession('GET', '/v0/limits', a.sid, { header: false }),
      ),
    ).toBe(403)
    const opened = h.chat.opened
    expect(
      await statusWith(
        h,
        asSession('POST', '/v0/chat/sessions', a.sid, {
          header: false,
          body: { target: 'qianmo://tokyo-1/planner' },
        }),
      ),
    ).toBe(403)
    expect(h.chat.opened).toBe(opened)
    expect(
      await statusWith(h, asSession('GET', '/', a.sid, { header: false })),
    ).toBe(200)
    // The stream is opened header-less, but not from another origin.
    expect(
      await statusWith(
        h,
        asSession('GET', '/v0/chat/stream', a.sid, {
          header: false,
          extra: { 'sec-fetch-site': 'cross-site' },
        }),
      ),
    ).toBe(403)
  })

  test('revocation ends every credential and session of the account on the next request', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const subject = subjectOf(h, a.credential)
    const ended: AccountEnded[] = []
    h.book.onAccountEnded(event => {
      ended.push(event)
    })
    expect(
      (await h.handle(asAdmin('POST', `/v0/accounts/${subject}/revoke`)))
        .status,
    ).toBe(204)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(401)
    expect(await statusWith(h, limitsWithBearer(a.credential))).toBe(401)
    const login = await h.handle(
      formPost(
        '/login',
        { token: a.credential },
        { 'sec-fetch-site': 'same-origin' },
      ),
    )
    expect(login.status).toBe(401)
    expect(ended).toEqual([{ subject, reason: 'revoked' }])
    // Revoked is final.
    expect(
      (await h.handle(asAdmin('POST', `/v0/accounts/${subject}/reset`))).status,
    ).toBe(404)
  })

  test('reset voids the credential and every session, and a new invitation restores the same account', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const subject = subjectOf(h, a.credential)
    const first = await h.handle(
      asAdmin('POST', `/v0/accounts/${subject}/reset`),
    )
    expect(first.status).toBe(200)
    const second = await h.handle(
      asAdmin('POST', `/v0/accounts/${subject}/reset`, { ttlHours: 1 }),
    )
    const { link } = (await second.json()) as { link: string }
    const { link: stale } = (await first.json()) as { link: string }
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(401)
    expect(await statusWith(h, limitsWithBearer(a.credential))).toBe(401)

    // Only the newest reset link works.
    const old = await h.handle(
      formPost('/invite', { invite: stale.slice(stale.indexOf('#') + 1) }),
    )
    expect(old.status).toBe(403)
    const redeemed = await h.handle(
      formPost('/invite', { invite: link.slice(link.indexOf('#') + 1) }),
    )
    expect(redeemed.status).toBe(200)
    const credential = credentialOn(await redeemed.text())
    expect(credential).not.toBe(a.credential)
    expect(subjectOf(h, credential)).toBe(subject)
  })
})

// --- invariant 5: break-glass ------------------------------------------------

describe('break-glass (invariant 5)', () => {
  const glass = () => accountsHarness({ accounts: { breakGlass: true } })

  test('the admin token works as a Bearer only, and every response says so', async () => {
    const h = glass()
    const bearer = await h.handle(limitsWithBearer(ADMIN))
    expect(bearer.status).toBe(200)
    expect(bearer.headers.get('x-qianmo-break-glass')).toBe('1')

    const query = await h.handle(
      new Request(`${BASE}/v0/limits?token=${ADMIN}`, {
        headers: { [CONSOLE_HEADER]: '1' },
      }),
    )
    expect(query.status).toBe(403)
    expect((await query.text()).includes(ADMIN)).toBe(false)

    const cookie = await h.handle(
      new Request(`${BASE}/v0/limits`, {
        headers: {
          cookie: `${SESSION_COOKIE}=${ADMIN}`,
          [CONSOLE_HEADER]: '1',
        },
      }),
    )
    expect(cookie.status).toBe(401)

    const login = await h.handle(
      formPost('/login', { token: ADMIN }, { 'sec-fetch-site': 'same-origin' }),
    )
    expect(login.status).toBe(403)
    expect(login.headers.getSetCookie()).toEqual([])
    expect((await login.text()).includes('admin 令牌只接受 Bearer 头')).toBe(
      true,
    )
  })

  test('every page it opens carries the lit notice', async () => {
    const h = glass()
    for (const path of ['/', '/chat']) {
      const page = await h.handle(asBearer('GET', path, ADMIN))
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html.includes('id="account-notice"')).toBe(true)
      expect(
        html.includes(
          'break-glass 会话 · 每次使用都有记录 · 用完请轮换 admin 令牌',
        ),
      ).toBe(true)
      expect(html.includes('>break-glass</span>')).toBe(true)
    }
  })

  test('every write is recorded, reads at most every ten minutes, by fingerprint only', async () => {
    const h = glass()
    const count = () =>
      entriesOf(h.ledger.text ?? '').filter(e => e.kind === 'breakglass.used')
        .length
    await h.handle(limitsWithBearer(ADMIN))
    await h.handle(limitsWithBearer(ADMIN))
    await h.handle(limitsWithBearer(ADMIN))
    expect(count()).toBe(1)
    await h.handle(asAdmin('POST', '/v0/accounts/invites', { role: 'viewer' }))
    await h.handle(asAdmin('POST', '/v0/accounts/invites', { role: 'viewer' }))
    expect(count()).toBe(3)
    h.clock.advance(10 * MINUTE)
    await h.handle(limitsWithBearer(ADMIN))
    expect(count()).toBe(4)
    const used = entriesOf(h.ledger.text ?? '').find(
      e => e.kind === 'breakglass.used',
    )
    expect(used?.data['fingerprint']).toBe(tokenFingerprint(ADMIN))
    expect((h.ledger.text ?? '').includes(ADMIN)).toBe(false)
  })

  test('is never an approver, and no legacy token is', () => {
    const h = glass()
    const accounts: ConsoleAccounts = { book: h.book, breakGlass: true }
    const principal = principalOf(limitsWithBearer(ADMIN), TOKENS, accounts)
    expect(principal).toEqual({
      kind: 'legacy',
      subject: 'legacy:admin',
      credential: 'bearer',
    })
    if (principal === null) throw new Error('unreachable')
    expect(mayApprove(principal, null)).toBe(false)
    expect(mayApprove(principal, 'u:0123456789abcdef')).toBe(false)
    expect(
      resolveAccess(limitsWithBearer(ADMIN), TOKENS, accounts).breakGlass,
    ).toBe(true)
  })

  test('a use not followed by rotation is flagged to ops; rotating is recorded', async () => {
    const h = glass()
    await h.handle(asAdmin('POST', '/v0/accounts/invites', { role: 'viewer' }))
    const ops = await person(h.handle, 'ops')
    const page = await (
      await h.handle(asSession('GET', '/', ops.sid, { header: false }))
    ).text()
    expect(page.includes('admin 令牌用作 break-glass 后还没有轮换')).toBe(true)
    expect(h.book.breakGlassStatus(tokenFingerprint(ADMIN)).rotationDue).toBe(
      true,
    )

    // Restart with a new admin token: the rotation is written down, once.
    const rotated = 'admin-token-rotated-000001'
    const ledger = new MemoryLedger('memory://accounts.ndjson', h.ledger.text)
    const sessions = new MemoryLedger(
      'memory://sessions.ndjson',
      h.sessions.text,
    )
    const restarted = accountsHarness({
      ledger,
      sessions,
      tokens: { view: VIEW, admin: rotated },
      accounts: { breakGlass: true },
    })
    const rotations = () =>
      entriesOf(ledger.text ?? '').filter(e => e.kind === 'breakglass.rotated')
    expect(rotations().map(e => e.data)).toEqual([
      { from: tokenFingerprint(ADMIN), to: tokenFingerprint(rotated) },
    ])
    expect(
      restarted.book.breakGlassStatus(tokenFingerprint(rotated)).rotationDue,
    ).toBe(false)
    const quiet = await (
      await restarted.handle(asSession('GET', '/', ops.sid, { header: false }))
    ).text()
    expect(quiet.includes('id="account-notice"')).toBe(false)
    accountsHarness({
      ledger,
      sessions,
      tokens: { view: VIEW, admin: rotated },
    })
    expect(rotations()).toHaveLength(1)
  })
})

// --- invariant 6: migration --------------------------------------------------

describe('migration: legacy tokens beside accounts (invariant 6)', () => {
  test('by default both legacy tokens keep every position they had', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    expect(await statusWith(h, limitsWithBearer(VIEW))).toBe(200)
    expect(await statusWith(h, limitsWithBearer(ADMIN))).toBe(200)
    expect(
      await statusWith(
        h,
        new Request(`${BASE}/v0/limits?token=${VIEW}`, {
          headers: { [CONSOLE_HEADER]: '1' },
        }),
      ),
    ).toBe(200)
    const login = await h.handle(
      formPost('/login', { token: VIEW }, { 'sec-fetch-site': 'same-origin' }),
    )
    expect(login.status).toBe(303)
    expect(cookieFrom(login, SESSION_COOKIE)).toBe(VIEW)
    // Signing in with a token clears any personal session cookie.
    expect(setCookieLine(login, ACCOUNT_SESSION_COOKIE)).toContain('Max-Age=0')
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(200)
  })

  test('--legacy-view-token off: the view token stops working in every position', async () => {
    const h = accountsHarness({ accounts: { legacyView: false } })
    const a = await person(h.handle, 'viewer')
    expect(await statusWith(h, limitsWithBearer(VIEW))).toBe(401)
    expect(
      await statusWith(
        h,
        new Request(`${BASE}/v0/limits?token=${VIEW}`, {
          headers: { [CONSOLE_HEADER]: '1' },
        }),
      ),
    ).toBe(401)
    expect(
      await statusWith(
        h,
        new Request(`${BASE}/v0/limits`, {
          headers: {
            cookie: `${SESSION_COOKIE}=${VIEW}`,
            [CONSOLE_HEADER]: '1',
          },
        }),
      ),
    ).toBe(401)
    const login = await h.handle(
      formPost('/login', { token: VIEW }, { 'sec-fetch-site': 'same-origin' }),
    )
    expect(login.status).toBe(401)
    expect(login.headers.getSetCookie()).toEqual([])
    // The admin token and the personal accounts are unaffected.
    expect(await statusWith(h, limitsWithBearer(ADMIN))).toBe(200)
    expect(await statusWith(h, limitsWithSession(a.sid))).toBe(200)
  })

  test('refuses legacy tokens shaped like account secrets', () => {
    for (const prefix of ['qmu_', 'qmi_', 'qms_']) {
      expect(() =>
        accountsHarness({
          tokens: { view: `${prefix}${'x'.repeat(20)}`, admin: ADMIN },
        }),
      ).toThrow(prefix)
    }
  })
})

// --- the P14 contract (§3.5) -----------------------------------------------------

describe('principalOf / mayApprove (tenancy-m1.md §3.5)', () => {
  test('are exported from the package entry, beside ownerOf', async () => {
    const entry = await import('../src/index.js')
    expect(entry.principalOf).toBe(principalOf)
    expect(entry.mayApprove).toBe(mayApprove)
    expect(typeof entry.ownerOf).toBe('function')
    expect(typeof entry.AccountBook).toBe('function')
  })

  test('names who is asking, by position', async () => {
    const h = accountsHarness()
    const accounts: ConsoleAccounts = { book: h.book }
    const a = await person(h.handle, 'member')
    const subject = subjectOf(h, a.credential)

    expect(principalOf(new Request(`${BASE}/`), TOKENS, accounts)).toBeNull()
    expect(principalOf(limitsWithBearer(VIEW), TOKENS, accounts)).toEqual({
      kind: 'legacy',
      subject: 'legacy:view',
      credential: 'bearer',
    })
    const bearer = principalOf(limitsWithBearer(a.credential), TOKENS, accounts)
    expect(bearer).toMatchObject({
      kind: 'user',
      subject,
      role: 'member',
      credential: 'bearer',
    })
    const session = principalOf(limitsWithSession(a.sid), TOKENS, accounts)
    expect(session).toMatchObject({
      kind: 'user',
      subject,
      role: 'member',
      credential: 'session',
    })
    // A refused request has nobody behind it.
    expect(
      principalOf(
        new Request(`${BASE}/v0/limits?token=${a.credential}`),
        TOKENS,
        accounts,
      ),
    ).toBeNull()
    // Without accounts the same call still answers, in legacy terms only.
    expect(principalOf(limitsWithBearer(ADMIN), TOKENS, undefined)).toEqual({
      kind: 'legacy',
      subject: 'legacy:admin',
      credential: 'bearer',
    })
  })

  test('approves by owner or ops, never on a plain browser session, never a legacy token', () => {
    const owner = 'u:0123456789abcdef' as const
    const other = 'u:fedcba9876543210' as const
    const user = (
      role: 'viewer' | 'member' | 'ops',
      credential: 'session' | 'approval-session' | 'bearer',
      subject: `u:${string}` = owner,
    ): ConsolePrincipal => ({
      kind: 'user',
      subject,
      role,
      authenticatedAt: 0,
      credential,
    })
    expect(mayApprove(user('member', 'approval-session'), owner)).toBe(true)
    expect(mayApprove(user('member', 'bearer'), owner)).toBe(true)
    expect(mayApprove(user('member', 'session'), owner)).toBe(false)
    expect(mayApprove(user('member', 'approval-session'), other)).toBe(false)
    expect(mayApprove(user('member', 'approval-session'), null)).toBe(false)
    expect(mayApprove(user('ops', 'approval-session', other), owner)).toBe(true)
    expect(mayApprove(user('ops', 'approval-session', other), null)).toBe(true)
    expect(mayApprove(user('ops', 'session', other), owner)).toBe(false)
    expect(mayApprove(user('viewer', 'approval-session'), owner)).toBe(false)
    for (const subject of ['legacy:view', 'legacy:admin'] as const) {
      expect(
        mayApprove({ kind: 'legacy', subject, credential: 'bearer' }, null),
      ).toBe(false)
    }
  })
})

// --- copy ------------------------------------------------------------------------

/** What a person reads on a page: no script, no style, no markup. */
function visibleText(html: string): string {
  return html
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
}

describe('every page the accounts add keeps to the console register', () => {
  test('one clause per line, no full stop, comma or exclamation mark', async () => {
    const pages: string[] = []
    const collect = async (response: Response | Promise<Response>) => {
      pages.push(await (await response).text())
    }

    const h = accountsHarness({ accounts: { breakGlass: true } })
    const ops = await person(h.handle, 'ops')
    const viewer = await person(h.handle, 'viewer')
    const { token } = await invite(h.handle, 'member')
    await collect(h.handle(new Request(`${BASE}/login`)))
    await collect(h.handle(new Request(`${BASE}/invite`)))
    await collect(h.handle(formPost('/invite', { invite: token })))
    await collect(h.handle(formPost('/invite', { invite: token })))
    await collect(h.handle(asSession('GET', '/', ops.sid, { header: false })))
    await collect(
      h.handle(asSession('GET', '/chat', ops.sid, { header: false })),
    )
    await collect(h.handle(asBearer('GET', '/', ADMIN)))
    await collect(
      h.handle(
        asSession('GET', '/chat', viewer.sid, {
          header: false,
          accept: 'text/html',
        }),
      ),
    )
    await collect(
      h.handle(
        formPost(
          '/login',
          { token: ADMIN },
          { 'sec-fetch-site': 'same-origin' },
        ),
      ),
    )
    await collect(
      h.handle(
        new Request(`${BASE}/?token=${ops.credential}`, {
          headers: { accept: 'text/html' },
        }),
      ),
    )

    // And the pages of a closed book.
    const closed = restart('garbage\n', '')
    await collect(
      closed.handle(
        asSession('GET', '/', ops.sid, { header: false, accept: 'text/html' }),
      ),
    )
    await collect(closed.handle(formPost('/invite', { invite: token })))
    await collect(
      closed.handle(
        formPost(
          '/login',
          { token: ops.credential },
          { 'sec-fetch-site': 'same-origin' },
        ),
      ),
    )
    await collect(closed.handle(asBearer('GET', '/', ADMIN)))

    expect(pages).toHaveLength(14)
    for (const page of pages) {
      expect(page.startsWith('<!DOCTYPE html>')).toBe(true)
      const text = visibleText(page)
      for (const mark of ['。', '，', '！']) {
        expect(text.includes(mark)).toBe(false)
      }
    }
  })
})
