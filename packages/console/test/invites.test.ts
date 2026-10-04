// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.3 — invitation tokens (`tenancy-m1.md` §3.1, §6 DoD).
 *
 * Each `describe` below is one line of the DoD, and each asserts on what was
 * *done* (ledger writes, counts) as well as on what was *answered*: a GET that
 * renders the right page but quietly consumed the invitation would pass a
 * response-only test.
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_OPEN_INVITES } from '../src/accounts.js'
import { readLedger } from '../src/ledger.js'
import {
  BASE,
  HOUR,
  MemoryLedger,
  accountsHarness,
  asAdmin,
  credentialOn,
  formPost,
  invite,
} from './accountsHarness.js'

const SRC = join(import.meta.dir, '..', 'src')

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

describe('GET /invite mints nothing', () => {
  test('the card renders and the ledger port is not touched', async () => {
    const { handle, ledger } = accountsHarness()
    const { token } = await invite(handle)
    const reads = ledger.reads
    const appends = ledger.appends

    // What a link preview bot fetches: the URL without its fragment (a client
    // never sends the fragment), with and without a query string it made up.
    for (const path of ['/invite', `/invite?x=${token}`, '/invite?']) {
      const response = await handle(new Request(`${BASE}${path}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      )
      const page = await response.text()
      expect(page).toContain('action="/invite"')
      expect(page).not.toContain('id="credential"')
    }

    expect(ledger.appends).toBe(appends)
    expect(ledger.reads).toBe(reads)
    // And the invitation is still good afterwards.
    const accepted = await handle(formPost('/invite', { invite: token }))
    expect(accepted.status).toBe(200)
  })

  test('the card carries the token only as far as the field, never to storage', async () => {
    const { handle } = accountsHarness()
    const page = await (await handle(new Request(`${BASE}/invite`))).text()
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
    expect(script).toContain('location.hash')
    expect(script).toContain('replaceState')
    expect(script).not.toContain('localStorage')
    expect(script).not.toContain('sessionStorage')
    expect(script).not.toContain('fetch')
  })
})

describe('POST /invite', () => {
  test('from another origin is 403 and consumes nothing', async () => {
    const { handle, ledger } = accountsHarness()
    const { token } = await invite(handle)
    const appends = ledger.appends
    for (const site of ['cross-site', 'same-site']) {
      const refused = await handle(
        formPost('/invite', { invite: token }, { 'sec-fetch-site': site }),
      )
      expect(refused.status).toBe(403)
    }
    expect(ledger.appends).toBe(appends)
    const accepted = await handle(
      formPost(
        '/invite',
        { invite: token },
        { 'sec-fetch-site': 'same-origin' },
      ),
    )
    expect(accepted.status).toBe(200)
    expect(ledger.appends).toBe(appends + 1)
  })

  test('mints the credential once, shown on a page nobody caches', async () => {
    const { handle, ledger, book } = accountsHarness()
    const { token } = await invite(handle, 'member', { label: 'beta 3' })
    const response = await handle(formPost('/invite', { invite: token }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const credential = credentialOn(await response.text())
    expect(credential.startsWith('qmu_')).toBe(true)
    // 32 random bytes → 43 base64url characters after the prefix.
    expect(credential.length).toBe('qmu_'.length + 43)

    const created = ledger
      .lines()
      .filter(line => line.kind === 'account.created')
    expect(created).toHaveLength(1)
    expect(created[0]?.data['credentialHash']).toBe(sha256(credential))
    expect(created[0]?.data['label']).toBe('beta 3')

    const listed = book.list()
    if (!listed.ok) throw new Error('book unavailable')
    expect(listed.value.accounts).toHaveLength(1)
    expect(listed.value.accounts[0]?.role).toBe('member')
    expect(listed.value.invites[0]?.state).toBe('consumed')
  })

  test('a second use is 403 and changes nothing', async () => {
    const { handle, ledger } = accountsHarness()
    const { token } = await invite(handle)
    expect((await handle(formPost('/invite', { invite: token }))).status).toBe(
      200,
    )
    const appends = ledger.appends
    const again = await handle(formPost('/invite', { invite: token }))
    expect(again.status).toBe(403)
    expect(await again.text()).toContain('邀请无效或已失效')
    expect(ledger.appends).toBe(appends)
  })

  test('an expired invitation is 403 and is not consumed', async () => {
    const { handle, ledger, clock, book } = accountsHarness()
    const { token } = await invite(handle, 'viewer', { ttlHours: 1 })
    clock.advance(HOUR + 1)
    const appends = ledger.appends
    const late = await handle(formPost('/invite', { invite: token }))
    expect(late.status).toBe(403)
    expect(await late.text()).toContain('邀请无效或已失效')
    expect(ledger.appends).toBe(appends)
    const listed = book.list()
    if (!listed.ok) throw new Error('book unavailable')
    expect(listed.value.invites[0]?.state).toBe('expired')
    expect(listed.value.accounts).toHaveLength(0)
  })

  test('unknown, malformed and withdrawn invitations read the same', async () => {
    const { handle, ledger } = accountsHarness()
    const { token, inviteId } = await invite(handle)
    const withdrawn = await handle(
      asAdmin('DELETE', `/v0/accounts/invites/${inviteId}`),
    )
    expect(withdrawn.status).toBe(204)
    const appends = ledger.appends
    const bodies = new Set<string>()
    for (const presented of [token, 'qmi_nope', 'not-even-shaped', '']) {
      const response = await handle(formPost('/invite', { invite: presented }))
      expect(response.status).toBe(403)
      bodies.add(await response.text())
    }
    expect(bodies.size).toBe(1)
    expect(ledger.appends).toBe(appends)
  })

  test('two redemptions racing for one invitation: exactly one wins', async () => {
    const { handle } = accountsHarness()
    const { token } = await invite(handle)
    const [a, b] = await Promise.all([
      handle(formPost('/invite', { invite: token })),
      handle(formPost('/invite', { invite: token })),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 403])
  })

  test('failed redemptions feed the same throttle as the login form', async () => {
    const { handle } = accountsHarness()
    const { token } = await invite(handle)
    for (let i = 0; i < 6; i += 1) {
      await handle(formPost('/invite', { invite: `qmi_wrong${i}` }))
    }
    const blocked = await handle(formPost('/invite', { invite: token }))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).not.toBeNull()
  })

  test('a body that is not the form is 400 and consumes nothing', async () => {
    const { handle, ledger } = accountsHarness()
    const { token } = await invite(handle)
    const appends = ledger.appends
    const response = await handle(
      new Request(`${BASE}/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invite: token }),
      }),
    )
    expect(response.status).toBe(400)
    expect(ledger.appends).toBe(appends)
  })
})

describe('both invitation pages', () => {
  test('carry Referrer-Policy: no-referrer', async () => {
    const { handle } = accountsHarness()
    const { token } = await invite(handle)
    const card = await handle(new Request(`${BASE}/invite`))
    const refused = await handle(formPost('/invite', { invite: 'qmi_x' }))
    const shown = await handle(formPost('/invite', { invite: token }))
    for (const response of [card, refused, shown]) {
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    // And the document says so too, for the one browser that ignores headers
    // on a response it renders from a POST.
    expect(await shown.text()).toContain(
      '<meta name="referrer" content="no-referrer">',
    )
  })
})

describe('issuing', () => {
  test(`refuses a ${MAX_OPEN_INVITES + 1}th open invitation`, async () => {
    const { handle, ledger } = accountsHarness()
    const ids: string[] = []
    for (let i = 0; i < MAX_OPEN_INVITES; i += 1) {
      ids.push((await invite(handle)).inviteId)
    }
    const appends = ledger.appends
    const over = await handle(
      asAdmin('POST', '/v0/accounts/invites', { role: 'member' }),
    )
    expect(over.status).toBe(429)
    expect(ledger.appends).toBe(appends)

    // Withdrawing one frees its place.
    await handle(asAdmin('DELETE', `/v0/accounts/invites/${ids[0]}`))
    expect(
      (
        await handle(
          asAdmin('POST', '/v0/accounts/invites', { role: 'member' }),
        )
      ).status,
    ).toBe(200)
  })

  test('expired and consumed invitations do not count against the cap', async () => {
    const { handle, clock } = accountsHarness()
    for (let i = 0; i < MAX_OPEN_INVITES; i += 1) {
      await invite(handle, 'viewer', { ttlHours: 1 })
    }
    clock.advance(HOUR + 1)
    expect(
      (
        await handle(
          asAdmin('POST', '/v0/accounts/invites', { role: 'viewer' }),
        )
      ).status,
    ).toBe(200)
  })

  test('is admin-only, and the token never comes back from the list', async () => {
    const { handle } = accountsHarness()
    const { token } = await invite(handle)
    const asView = await handle(
      new Request(`${BASE}/v0/accounts/invites`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer view-token-000000000001',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'ops' }),
      }),
    )
    expect(asView.status).toBe(403)
    const anonymous = await handle(
      new Request(`${BASE}/v0/accounts`, { method: 'GET' }),
    )
    expect(anonymous.status).toBe(401)
    const listed = await (await handle(asAdmin('GET', '/v0/accounts'))).text()
    expect(listed).not.toContain(token)
    expect(listed).not.toContain(sha256(token))
    expect(listed).not.toContain('Hash')
  })

  test('rejects a role, a lifetime or a label outside the rules', async () => {
    const { handle } = accountsHarness()
    for (const body of [
      { role: 'admin' },
      { role: 'member', ttlHours: 73 },
      { role: 'member', ttlHours: 0 },
      { role: 'member', label: 'x'.repeat(41) },
      { role: 'member', label: 'a\nb' },
    ]) {
      const response = await handle(
        asAdmin('POST', '/v0/accounts/invites', body),
      )
      expect(response.status).toBe(400)
    }
  })

  test('the link carries the token after #, where no server sees it', async () => {
    const { handle } = accountsHarness()
    const response = await handle(
      asAdmin('POST', '/v0/accounts/invites', { role: 'member' }),
    )
    const body = (await response.json()) as { link: string }
    expect(body.link).toMatch(/^\/invite#qmi_[A-Za-z0-9_-]{43}$/)
  })
})

describe('what reaches disk', () => {
  test('hashes only: no invitation token and no credential in the ledger', async () => {
    const { handle, ledger } = accountsHarness()
    const secrets: string[] = []
    const first = await invite(handle, 'member', { label: 'a' })
    secrets.push(first.token)
    const page = await (
      await handle(formPost('/invite', { invite: first.token }))
    ).text()
    secrets.push(credentialOn(page))
    const second = await invite(handle, 'ops')
    secrets.push(second.token)
    await handle(asAdmin('DELETE', `/v0/accounts/invites/${second.inviteId}`))

    const text = ledger.text ?? ''
    for (const secret of secrets) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain(sha256(first.token))
    // Every record chains and every key on disk is one of the named fields.
    const read = readLedger(text)
    expect(read.ok).toBe(true)
    for (const line of ledger.lines()) {
      for (const [key, value] of Object.entries(line.data)) {
        expect(key).not.toMatch(/^(token|credential|secret|password|sid)$/i)
        if (typeof value === 'string') {
          expect(value.startsWith('qmi_')).toBe(false)
          expect(value.startsWith('qmu_')).toBe(false)
        }
      }
    }
  })

  test('the code cannot persist a field outside the named list, and none of those is a plaintext secret', () => {
    const source = readFileSync(join(SRC, 'accounts.ts'), 'utf8')
    const block = /const LEDGER_FIELDS[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(
      source,
    )?.[1]
    if (block === undefined) throw new Error('LEDGER_FIELDS not found')
    const fields = [...block.matchAll(/'([^']+)'/g)].map(match => match[1])
    expect(fields.length).toBeGreaterThan(5)
    for (const field of fields) {
      // A secret may only be persisted as its hash.
      expect(field).not.toMatch(/token$|credential$|secret|password|^sid$/i)
    }
    // `#append` enforces the list, and it is the only way to the port.
    expect(source).toContain('if (!LEDGER_FIELDS.has(key))')
    expect(source.match(/\.port\.append\(/g)?.length).toBe(1)
    for (const file of ['http.ts', 'accountsHttp.ts', 'ledger.ts']) {
      const other = readFileSync(join(SRC, file), 'utf8')
      expect(other).not.toMatch(/\.append\(encodeLedgerEntry/)
    }
  })
})

describe('resolveTokens', () => {
  test('is byte for byte what it was before accounts (tenancy-m1.md §3.4)', () => {
    const source = readFileSync(join(SRC, 'auth.ts'), 'utf8')
    const start = source.indexOf('export function resolveTokens(')
    const end = source.indexOf('\n}\n', start)
    const block = `${source.slice(start, end + 2)}\n`
    // Hash of the same block at 9770e8a7, computed with
    // `awk '/^export function resolveTokens/,/^}/' | shasum -a 256`.
    expect(sha256(block)).toBe(
      '5c3dbf1fd5d471e30d0194f113869adf588f1acc4e757332b5297e9410946796',
    )
  })

  test('and the account code never calls it', () => {
    for (const file of ['accounts.ts', 'accountsHttp.ts', 'ledger.ts']) {
      const source = readFileSync(join(SRC, file), 'utf8')
      // Mentioned in prose is fine; imported or called is not.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(code.includes('resolveTokens')).toBe(false)
    }
  })
})

describe('the ledger when a write fails', () => {
  test('closes the book rather than letting memory run ahead of disk', async () => {
    const ledger = new MemoryLedger()
    const { handle, book, alarms } = accountsHarness({ ledger })
    ledger.failAppends = true
    const response = await handle(
      asAdmin('POST', '/v0/accounts/invites', { role: 'member' }),
    )
    expect(response.status).toBe(503)
    expect(book.problem).not.toBeNull()
    expect(alarms.length).toBeGreaterThan(0)
    // It stays closed after the disk recovers: a restart re-reads the file.
    ledger.failAppends = false
    expect(
      (
        await handle(
          asAdmin('POST', '/v0/accounts/invites', { role: 'member' }),
        )
      ).status,
    ).toBe(503)
  })
})
