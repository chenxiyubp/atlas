// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.5 — roles on the chat face, session ownership, and the event stream
 * kept to its owner (`tenancy-m1.md` §3.2, §3.3; invariant 3).
 *
 * "A member cannot see B's session" is judged by the port: a refused read or
 * send must have called `ChatPort` zero times, and the refusal must be the
 * same bytes whether the session belongs to somebody else or does not exist.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { ownerOf, resolveAccess } from '../src/access.js'
import { streamScopeOf } from '../src/accountsHttp.js'
import {
  ADDRESS,
  ADMIN,
  BASE,
  HOUR,
  TOKENS,
  VIEW,
  accountsHarness,
  asAdmin,
  asBearer,
  asSession,
  type AccountsHarness,
  type Person,
  person,
} from './accountsHarness.js'

const readers: ReadableStreamDefaultReader<Uint8Array>[] = []

afterEach(async () => {
  for (const reader of readers.splice(0)) {
    await reader.cancel().catch(() => {})
  }
})

async function open(
  h: AccountsHarness,
  who: Person | 'admin',
): Promise<string> {
  const response = await h.handle(
    who === 'admin'
      ? asAdmin('POST', '/v0/chat/sessions', { target: ADDRESS })
      : asSession('POST', '/v0/chat/sessions', who.sid, {
          body: { target: ADDRESS },
        }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

async function listed(h: AccountsHarness, request: Request) {
  const response = await h.handle(request)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { sessions: { id: string }[] }
  return body.sessions.map(session => session.id).sort()
}

function subjectOf(h: AccountsHarness, who: Person): `u:${string}` {
  const access = resolveAccess(
    asSession('GET', '/v0/limits', who.sid),
    TOKENS,
    { book: h.book },
    false,
  )
  if (access.principal?.kind !== 'user') throw new Error('not a person')
  return access.principal.subject
}

/** Three people and three sessions: A's, B's, and one the admin token opened. */
async function crowd() {
  const h = accountsHarness()
  const a = await person(h.handle, 'member')
  const b = await person(h.handle, 'member')
  const ops = await person(h.handle, 'ops')
  const sa = await open(h, a)
  const sb = await open(h, b)
  const sl = await open(h, 'admin')
  const so = await open(h, ops)
  return { h, a, b, ops, sa, sb, sl, so }
}

describe('who gets the chat face', () => {
  test('viewer: refused with the reason; the nav link is not drawn', async () => {
    const h = accountsHarness()
    const v = await person(h.handle, 'viewer')
    const api = await h.handle(asSession('GET', '/v0/chat/sessions', v.sid))
    expect(api.status).toBe(403)
    expect((await api.text()).includes('对话需要成员或运维账号')).toBe(true)
    const page = await h.handle(
      asSession('GET', '/chat', v.sid, { header: false, accept: 'text/html' }),
    )
    expect(page.status).toBe(403)
    expect((await page.text()).includes('该页面需要成员或运维账号')).toBe(true)
    const index = await (
      await h.handle(asSession('GET', '/', v.sid, { header: false }))
    ).text()
    expect(index.includes('id="to-chat"')).toBe(false)
    expect(index.includes('只读账号')).toBe(true)
    expect(h.chat.opened + h.chat.transcripts + h.chat.sends).toBe(0)
  })

  test('member: gets chat and nothing an admin has', async () => {
    const h = accountsHarness()
    const m = await person(h.handle, 'member')
    const index = await (
      await h.handle(asSession('GET', '/', m.sid, { header: false }))
    ).text()
    expect(index.includes('id="to-chat"')).toBe(true)
    expect(index.includes('成员账号')).toBe(true)
    for (const [method, path, body] of [
      ['POST', '/v0/agents', { address: ADDRESS, endpoint: 'ws://x' }],
      ['POST', '/v0/wake', { target: ADDRESS, text: 'x' }],
      ['GET', '/v0/accounts', undefined],
      ['POST', '/v0/accounts/invites', { role: 'ops' }],
    ] as const) {
      const response = await h.handle(
        asSession(method, path, m.sid, body === undefined ? {} : { body }),
      )
      expect(response.status).toBe(403)
    }
    expect(h.registry.calls).toBe(0)
    expect(h.wake.sent).toBe(0)
  })

  test('ops: administers accounts, and the ledger names the person', async () => {
    const h = accountsHarness()
    const ops = await person(h.handle, 'ops')
    const m = await person(h.handle, 'member')
    const issued = await h.handle(
      asSession('POST', '/v0/accounts/invites', ops.sid, {
        body: { role: 'viewer' },
      }),
    )
    expect(issued.status).toBe(200)
    const opsSubject = subjectOf(h, ops)
    const lines = h.ledger.lines()
    expect(lines.at(-1)?.data['issuedBy']).toBe(opsSubject)
    const revoked = await h.handle(
      asSession('POST', `/v0/accounts/${subjectOf(h, m)}/revoke`, ops.sid),
    )
    expect(revoked.status).toBe(204)
    expect(h.ledger.lines().at(-1)?.data['by']).toBe(opsSubject)
    // A cookie still needs the console header on these, like every write.
    const bare = await h.handle(
      asSession('POST', '/v0/accounts/invites', ops.sid, {
        header: false,
        body: { role: 'viewer' },
      }),
    )
    expect(bare.status).toBe(403)
  })

  test('legacy:view sees no session, on any chat route, in any position', async () => {
    const { h, sa } = await crowd()
    const reads = () => h.chat.transcripts + h.chat.sends + h.chat.opened
    const before = reads()
    const listeners = h.chat.listeners.size
    const paths = [
      '/chat',
      `/chat?session=${sa}`,
      '/v0/chat/targets',
      '/v0/chat/sessions',
      `/v0/chat/sessions/${sa}`,
      '/v0/chat/stream',
      '/fragments/chat/sessions',
      `/fragments/chat/thread/${sa}`,
    ]
    for (const path of paths) {
      const positions = [
        asBearer('GET', path, VIEW),
        new Request(
          `${BASE}${path}${path.includes('?') ? '&' : '?'}token=${VIEW}`,
        ),
        new Request(`${BASE}${path}`, {
          headers: {
            cookie: `qianmo_console=${VIEW}`,
            'x-qianmo-console': '1',
          },
        }),
      ]
      for (const request of positions) {
        const response = await h.handle(request)
        expect(response.status).toBe(403)
        expect((await response.text()).includes(sa)).toBe(false)
      }
    }
    for (const [method, path] of [
      ['POST', '/v0/chat/sessions'],
      ['POST', `/v0/chat/sessions/${sa}/messages`],
    ] as const) {
      expect(
        (
          await h.handle(
            asBearer(method, path, VIEW, { target: ADDRESS, text: 'x' }),
          )
        ).status,
      ).toBe(403)
    }
    expect(reads()).toBe(before)
    expect(h.chat.listeners.size).toBe(listeners)
    const index = await (await h.handle(asBearer('GET', '/', VIEW))).text()
    expect(index.includes('id="to-chat"')).toBe(false)
    expect(index.includes('只读令牌')).toBe(true)
  })
})

describe('ownership', () => {
  test('is recorded for every session a person opens, and for none the token opens', async () => {
    const { h, a, ops, sa, sl, so } = await crowd()
    const accounts = { book: h.book }
    expect(ownerOf(accounts, sa)).toBe(subjectOf(h, a))
    expect(ownerOf(accounts, so)).toBe(subjectOf(h, ops))
    expect(ownerOf(accounts, sl)).toBeNull()
    expect(ownerOf(accounts, 'no-such-session')).toBeNull()
  })

  test('a member lists only its own sessions; ops and the admin token list all', async () => {
    const { h, a, b, ops, sa, sb, sl, so } = await crowd()
    expect(
      await listed(h, asSession('GET', '/v0/chat/sessions', a.sid)),
    ).toEqual([sa])
    expect(
      await listed(h, asBearer('GET', '/v0/chat/sessions', b.credential)),
    ).toEqual([sb])
    const all = [sa, sb, sl, so].sort()
    expect(
      await listed(h, asSession('GET', '/v0/chat/sessions', ops.sid)),
    ).toEqual(all)
    expect(await listed(h, asAdmin('GET', '/v0/chat/sessions'))).toEqual(all)
    const fragment = await (
      await h.handle(
        asSession('GET', `/fragments/chat/sessions?active=${sb}`, a.sid),
      )
    ).text()
    expect(fragment.includes(sa)).toBe(true)
    expect(fragment.includes(sb)).toBe(false)
  })

  test("another's session reads exactly like one that does not exist, with no port call", async () => {
    const { h, a, sa, sb, sl, so } = await crowd()
    const transcripts = h.chat.transcripts
    const sends = h.chat.sends
    const bodies = new Set<string>()
    const threads = new Set<string>()
    for (const id of [sb, sl, so, 'no-such-session']) {
      const read = await h.handle(
        asSession('GET', `/v0/chat/sessions/${encodeURIComponent(id)}`, a.sid),
      )
      expect(read.status).toBe(404)
      bodies.add(await read.text())
      const send = await h.handle(
        asSession(
          'POST',
          `/v0/chat/sessions/${encodeURIComponent(id)}/messages`,
          a.sid,
          { body: { text: 'hello' } },
        ),
      )
      expect(send.status).toBe(404)
      bodies.add(await send.text())
      const thread = await h.handle(
        asSession(
          'GET',
          `/fragments/chat/thread/${encodeURIComponent(id)}`,
          a.sid,
        ),
      )
      expect(thread.status).toBe(200)
      threads.add(await thread.text())
      const page = await (
        await h.handle(
          asSession('GET', `/chat?session=${encodeURIComponent(id)}`, a.sid, {
            header: false,
          }),
        )
      ).text()
      expect(page.includes(`data-session="${id}"`)).toBe(false)
      // …while the member's own session is right there on the same page.
      expect(page.includes(`data-session="${sa}"`)).toBe(true)
    }
    expect(bodies.size).toBe(1)
    expect([...bodies][0]).toContain('这条会话不在本控制台的记录里')
    expect(threads.size).toBe(1)
    expect(h.chat.transcripts).toBe(transcripts)
    expect(h.chat.sends).toBe(sends)
  })

  test('its own session works end to end for the member', async () => {
    const { h, a, sa } = await crowd()
    const read = await h.handle(
      asSession('GET', `/v0/chat/sessions/${sa}`, a.sid),
    )
    expect(read.status).toBe(200)
    const send = await h.handle(
      asSession('POST', `/v0/chat/sessions/${sa}/messages`, a.sid, {
        body: { text: 'hello' },
      }),
    )
    expect(send.status).toBe(200)
    expect(h.chat.sends).toBe(1)
  })

  test('survives a reset: the person comes back to the same sessions', async () => {
    const { h, a, sa } = await crowd()
    const subject = subjectOf(h, a)
    const reset = await h.handle(
      asAdmin('POST', `/v0/accounts/${subject}/reset`),
    )
    const { link } = (await reset.json()) as { link: string }
    const back = await h.handle(
      new Request(`${BASE}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          invite: link.slice(link.indexOf('#') + 1),
        }).toString(),
      }),
    )
    const sid =
      back.headers
        .getSetCookie()
        .find(line => line.startsWith('qianmo_session='))
        ?.slice('qianmo_session='.length)
        .split(';')[0] ?? ''
    expect(await listed(h, asSession('GET', '/v0/chat/sessions', sid))).toEqual(
      [sa],
    )
  })
})

// --- invariant 3: the stream ---------------------------------------------------

const decoder = new TextDecoder()

async function stream(
  h: AccountsHarness,
  request: Request,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await h.handle(request)
  expect(response.status).toBe(200)
  if (response.body === null) throw new Error('no body')
  const reader = response.body.getReader()
  readers.push(reader)
  const first = await reader.read()
  expect(decoder.decode(first.value)).toContain(': open')
  return reader
}

async function next(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | null> {
  const chunk = await reader.read()
  return chunk.done ? null : decoder.decode(chunk.value)
}

describe('the event stream is kept to its owner (invariant 3)', () => {
  test('a member hears about its own sessions only; the admin token hears all', async () => {
    const { h, a, sa, sb } = await crowd()
    const mine = await stream(
      h,
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
    )
    const all = await stream(h, asAdmin('GET', '/v0/chat/stream'))
    h.chat.emit(sb)
    h.chat.emit(sa)
    const heard = await next(mine)
    expect(heard).toContain(sa)
    expect(heard?.includes(sb)).toBe(false)
    expect(await next(all)).toContain(sb)
    expect(await next(all)).toContain(sa)
  })

  test('revoking an account ends every stream it holds, on every credential', async () => {
    const { h, a, b, sa, sb } = await crowd()
    const subject = subjectOf(h, a)
    const listeners = h.chat.listeners.size
    const viaCookie = await stream(
      h,
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
    )
    const viaBearer = await stream(
      h,
      asBearer('GET', '/v0/chat/stream', a.credential),
    )
    const other = await stream(
      h,
      asSession('GET', '/v0/chat/stream', b.sid, { header: false }),
    )
    expect(h.book.openStreams(subject)).toBe(2)
    expect(h.chat.listeners.size).toBe(listeners + 3)

    const revoked = await h.handle(
      asAdmin('POST', `/v0/accounts/${subject}/revoke`),
    )
    expect(revoked.status).toBe(204)

    expect(await next(viaCookie)).toBeNull()
    expect(await next(viaBearer)).toBeNull()
    expect(h.book.openStreams(subject)).toBe(0)
    expect(h.chat.listeners.size).toBe(listeners + 1)
    // Nobody else's stream noticed.
    h.chat.emit(sa)
    h.chat.emit(sb)
    expect(await next(other)).toContain(sb)
  })

  test('logging out ends the stream on that session, not the person’s others', async () => {
    const { h, a, sa } = await crowd()
    const subject = subjectOf(h, a)
    const onSession = await stream(
      h,
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
    )
    const onBearer = await stream(
      h,
      asBearer('GET', '/v0/chat/stream', a.credential),
    )
    const out = await h.handle(
      new Request(`${BASE}/logout`, {
        method: 'POST',
        headers: { cookie: `qianmo_session=${a.sid}` },
      }),
    )
    expect(out.status).toBe(303)
    expect(await next(onSession)).toBeNull()
    expect(h.book.openStreams(subject)).toBe(1)
    h.chat.emit(sa)
    expect(await next(onBearer)).toContain(sa)
  })

  test('a closed book ends every personal stream and leaves the legacy ones', async () => {
    const { h, a } = await crowd()
    const personal = await stream(
      h,
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
    )
    const legacy = await stream(h, asBearer('GET', '/v0/chat/stream', ADMIN))
    // A write that fails closes the book.
    h.ledger.failAppends = true
    const refused = await h.handle(
      asAdmin('POST', '/v0/accounts/invites', { role: 'viewer' }),
    )
    expect(refused.status).toBe(503)
    expect(await next(personal)).toBeNull()
    h.chat.emit('anything')
    expect(await next(legacy)).toContain('anything')
  })

  test('the heartbeat re-check ends a stream whose session ran out, without counting as use', async () => {
    const h = accountsHarness()
    const a = await person(h.handle, 'member')
    const access = resolveAccess(
      asSession('GET', '/v0/chat/stream', a.sid, { header: false }),
      TOKENS,
      { book: h.book },
    )
    const scope = streamScopeOf(access, { book: h.book })
    if (scope === undefined) throw new Error('a person has a scope')
    h.clock.advance(HOUR)
    expect(scope.alive()).toBe(true)
    // The check at one hour did not reset the idle clock: one more hour and
    // the session is over.
    h.clock.advance(HOUR)
    expect(scope.alive()).toBe(false)
    // A legacy token has no scope at all: its stream is today's.
    expect(
      streamScopeOf(
        resolveAccess(asBearer('GET', '/', ADMIN), TOKENS, { book: h.book }),
        { book: h.book },
      ),
    ).toBeUndefined()
  })
})
