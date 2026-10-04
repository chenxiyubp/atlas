// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 个人账号的宿主面：真文件、真 `Bun.serve`、只用 HTTP 驱动。
 *
 * **零 `mock.module`**：包内用例用内存账本判规矩，这里判的是包内判不到的
 * 几件事——落盘的权限位与符号链接、明文（邀请、凭据、会话 id）到底有没有落到
 * 磁盘上、整条开户与会话路径在一个真起起来的控制台上（不起 CLI 子进程）走不走
 * 得通、重启以后会话还在，以及盘上一条写坏的吊销行不会把人放回来。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountBook,
  startConsoleServer,
  type ConsoleDeps,
  type ConsoleServerHandle,
} from '@qianmo/console'
import { FileLedger } from '../consoleAccountsStore.js'
import {
  consoleAccountsPath,
  consoleSessionsPath,
  parseConsoleArgs,
} from '../consoleArgs.js'
import { consoleLimits } from '../consolePorts.js'

const roots: string[] = []
const servers: ConsoleServerHandle[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-accounts-'))
  roots.push(dir)
  return dir
}

afterAll(async () => {
  for (const server of servers) await server.stop()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const TOKENS = {
  view: 'view-token-000000000001',
  admin: 'admin-token-00000000001',
}

function deps(): ConsoleDeps {
  return {
    registry: {
      list: () => Promise.resolve({ ok: true, value: [] }),
      register: () =>
        Promise.resolve({
          ok: false,
          failure: { code: 'unsupported', message: 'not here' },
        }),
      deregister: () => Promise.resolve({ ok: true, value: undefined }),
      heartbeat: () =>
        Promise.resolve({
          ok: false,
          failure: { code: 'unsupported', message: 'not here' },
        }),
    },
    audit: {
      read: () =>
        Promise.resolve({
          ok: true,
          value: {
            records: [],
            chain: 'empty',
            intact: true,
            issueCount: 0,
            total: 0,
          },
        }),
      chain: () => Promise.resolve({ ok: true, value: null }),
    },
    limits: consoleLimits(),
    label: 'accounts-host',
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Every byte under a directory, so a secret cannot hide in a sibling file. */
function everythingUnder(dir: string): string {
  let text = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    text += entry.isDirectory()
      ? everythingUnder(path)
      : readFileSync(path, 'utf8')
  }
  return text
}

describe('FileLedger', () => {
  test('creates the directory 0700 and the file 0600, and appends', () => {
    const path = join(tempDir(), 'qianmo', 'console', 'accounts.ndjson')
    const ledger = new FileLedger(path)
    expect(ledger.read()).toBeNull()
    ledger.append('one\n')
    ledger.append('two\n')
    ledger.close()
    expect(new FileLedger(path).read()).toBe('one\ntwo\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
  })

  test('tightens a file somebody else created too loosely', () => {
    const dir = join(tempDir(), 'console')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const path = join(dir, 'accounts.ndjson')
    writeFileSync(path, '', { mode: 0o644 })
    const ledger = new FileLedger(path)
    ledger.append('x\n')
    ledger.close()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('refuses to read or write through a symbolic link', () => {
    const dir = tempDir()
    const target = join(dir, 'elsewhere.ndjson')
    writeFileSync(target, 'not an account ledger\n')
    const link = join(dir, 'accounts.ndjson')
    symlinkSync(target, link)
    const ledger = new FileLedger(link)
    expect(() => ledger.read()).toThrow()
    expect(() => ledger.append('x\n')).toThrow()
    // And a book on it closes rather than trusting whatever is behind the link.
    const alarms: string[] = []
    const book = new AccountBook({
      accounts: new FileLedger(link),
      sessions: new FileLedger(join(dir, 'sessions.ndjson')),
      onAlarm: line => {
        alarms.push(line)
      },
    })
    expect(book.problem).not.toBeNull()
    expect(alarms).toHaveLength(1)
  })
})

describe('an account opened over HTTP only, against real files', () => {
  test('invite → confirm card → redeem, and nothing but hashes on disk', async () => {
    const root = tempDir()
    const path = join(root, 'qianmo', 'console', 'accounts.ndjson')
    const sessionsPath = join(root, 'qianmo', 'console', 'sessions.ndjson')
    const book = new AccountBook({
      accounts: new FileLedger(path),
      sessions: new FileLedger(sessionsPath),
    })
    const server = startConsoleServer(deps(), 0, {
      tokens: TOKENS,
      accounts: { book },
    })
    servers.push(server)

    // ① The admin token issues an invitation.
    const issued = await fetch(`${server.url}/v0/accounts/invites`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKENS.admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'member', label: 'beta 7' }),
    })
    expect(issued.status).toBe(200)
    const { link } = (await issued.json()) as { link: string }
    const token = link.slice(link.indexOf('#') + 1)

    // ② The invitee's browser opens the link; the fragment stays behind.
    const card = await fetch(`${server.url}${link}`)
    expect(card.status).toBe(200)
    expect(card.headers.get('referrer-policy')).toBe('no-referrer')
    const ledgerAfterCard = readFileSync(path, 'utf8')

    // ③ The button posts the form.
    const redeemed = await fetch(`${server.url}/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: new URLSearchParams({ invite: token }).toString(),
    })
    expect(redeemed.status).toBe(200)
    const page = await redeemed.text()
    const credential =
      /id="credential"[^>]*value="([^"]+)"/.exec(page)?.[1] ?? ''
    expect(credential.startsWith('qmu_')).toBe(true)

    // The card changed nothing on disk; the redemption appended one line.
    expect(readFileSync(path, 'utf8').startsWith(ledgerAfterCard)).toBe(true)
    expect(
      readFileSync(path, 'utf8').slice(ledgerAfterCard.length).split('\n'),
    ).toHaveLength(2)

    // ④ Neither secret is anywhere under the config root; their hashes are.
    const disk = everythingUnder(root)
    expect(disk.includes(token)).toBe(false)
    expect(disk.includes(credential)).toBe(false)
    expect(disk.includes(sha256(token))).toBe(true)
    expect(disk.includes(sha256(credential))).toBe(true)

    // ⑤ A restart reads the same ledger back and the invitation stays spent.
    const reopened = new AccountBook({
      accounts: new FileLedger(path),
      sessions: new FileLedger(sessionsPath),
    })
    expect(reopened.problem).toBeNull()
    const again = reopened.acceptInvite(token)
    expect(again.ok).toBe(false)
  })
})

describe('an account used over HTTP only, against real files (P15.5)', () => {
  test('redeem signs in, the session survives a restart, revocation ends it', async () => {
    const root = tempDir()
    const accountsPath = join(root, 'qianmo', 'console', 'accounts.ndjson')
    const sessionsPath = join(root, 'qianmo', 'console', 'sessions.ndjson')
    const open = () =>
      new AccountBook({
        accounts: new FileLedger(accountsPath),
        sessions: new FileLedger(sessionsPath),
      })
    const server = startConsoleServer(deps(), 0, {
      tokens: TOKENS,
      accounts: { book: open() },
    })
    servers.push(server)
    const sameOrigin = {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
    }
    const sessionCookie = (response: Response): string =>
      response.headers
        .getSetCookie()
        .find(line => line.startsWith('qianmo_session='))
        ?.slice('qianmo_session='.length)
        .split(';')[0] ?? ''

    // ① Invite as the admin token, redeem in a "browser": signed in at once.
    const issued = await fetch(`${server.url}/v0/accounts/invites`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKENS.admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'member' }),
    })
    const { link } = (await issued.json()) as { link: string }
    const redeemed = await fetch(`${server.url}/invite`, {
      method: 'POST',
      headers: sameOrigin,
      body: new URLSearchParams({
        invite: link.slice(link.indexOf('#') + 1),
      }).toString(),
    })
    expect(redeemed.status).toBe(200)
    const page = await redeemed.text()
    const credential =
      /id="credential"[^>]*value="([^"]+)"/.exec(page)?.[1] ?? ''
    const first = sessionCookie(redeemed)
    expect(first.startsWith('qms_')).toBe(true)

    // ② The cookie opens the console; a fresh login rotates the id.
    const index = await fetch(`${server.url}/`, {
      headers: { cookie: `qianmo_session=${first}` },
    })
    expect(index.status).toBe(200)
    expect((await index.text()).includes('成员账号')).toBe(true)
    const login = await fetch(`${server.url}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...sameOrigin, cookie: `qianmo_session=${first}` },
      body: new URLSearchParams({ token: credential }).toString(),
    })
    expect(login.status).toBe(303)
    const second = sessionCookie(login)
    expect(second).not.toBe(first)
    const limits = (sid: string) =>
      fetch(`${server.url}/v0/limits`, {
        headers: {
          cookie: `qianmo_session=${sid}`,
          'x-qianmo-console': '1',
        },
      })
    expect((await limits(first)).status).toBe(401)
    expect((await limits(second)).status).toBe(200)

    // ③ A second console over the same files: nobody has to log in again.
    const restarted = startConsoleServer(deps(), 0, {
      tokens: TOKENS,
      accounts: { book: open() },
    })
    servers.push(restarted)
    const again = await fetch(`${restarted.url}/v0/limits`, {
      headers: { cookie: `qianmo_session=${second}`, 'x-qianmo-console': '1' },
    })
    expect(again.status).toBe(200)

    // ④ Revoke on the first console; its next request is a 401.
    const list = (await (
      await fetch(`${server.url}/v0/accounts`, {
        headers: { authorization: `Bearer ${TOKENS.admin}` },
      })
    ).json()) as { accounts: { subject: string }[] }
    const subject = list.accounts[0]?.subject ?? ''
    const revoked = await fetch(`${server.url}/v0/accounts/${subject}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKENS.admin}` },
    })
    expect(revoked.status).toBe(204)
    expect((await limits(second)).status).toBe(401)

    // ⑤ No session id and no credential anywhere on disk; their hashes are.
    const disk = everythingUnder(root)
    for (const secret of [credential, first, second]) {
      expect(disk.includes(secret)).toBe(false)
      expect(disk.includes(sha256(secret))).toBe(true)
    }
    expect(statSync(sessionsPath).mode & 0o777).toBe(0o600)
  })

  test('a corrupted revocation on disk keeps the person out and says why', async () => {
    const root = tempDir()
    const accountsPath = join(root, 'accounts.ndjson')
    const sessionsPath = join(root, 'sessions.ndjson')
    const book = new AccountBook({
      accounts: new FileLedger(accountsPath),
      sessions: new FileLedger(sessionsPath),
    })
    const issued = book.issueInvite({
      role: 'member',
      issuedBy: 'legacy:admin',
    })
    if (!issued.ok) throw new Error('issue failed')
    const accepted = book.acceptInvite(issued.value.token)
    if (!accepted.ok) throw new Error('accept failed')
    expect(book.revoke(accepted.value.subject, 'legacy:admin').ok).toBe(true)
    // A crash mid-write of the revocation: the last line loses its tail.
    const text = readFileSync(accountsPath, 'utf8')
    writeFileSync(accountsPath, text.slice(0, -10))

    const alarms: string[] = []
    const reopened = new AccountBook({
      accounts: new FileLedger(accountsPath),
      sessions: new FileLedger(sessionsPath),
      onAlarm: line => {
        alarms.push(line)
      },
    })
    expect(reopened.problem).toContain(accountsPath)
    expect(alarms).toHaveLength(1)
    const server = startConsoleServer(deps(), 0, {
      tokens: TOKENS,
      accounts: { book: reopened },
    })
    servers.push(server)
    const personal = await fetch(`${server.url}/v0/limits`, {
      headers: { authorization: `Bearer ${accepted.value.credential}` },
    })
    expect(personal.status).toBe(503)
    const admin = await fetch(`${server.url}/v0/limits`, {
      headers: { authorization: `Bearer ${TOKENS.admin}` },
    })
    expect(admin.status).toBe(200)
  })
})

describe('--accounts', () => {
  test('is off by default and leaves the parsed config as it was', () => {
    const config = parseConsoleArgs([], 'qianmo')
    expect('accounts' in config).toBe(false)
    expect('accountsStorePath' in config).toBe(false)
  })

  test('turns on with the path derived from the config root', () => {
    const config = parseConsoleArgs(['--accounts'], 'qianmo')
    expect(config.accounts).toBe(true)
    expect(config.accountsStorePath).toBe(consoleAccountsPath())
    expect(
      consoleAccountsPath().endsWith(
        join('qianmo', 'console', 'accounts.ndjson'),
      ),
    ).toBe(true)
  })

  test('takes an absolute store path, and only with --accounts', () => {
    expect(
      parseConsoleArgs(
        ['--accounts', '--accounts-store', '/tmp/a.ndjson'],
        'qianmo',
      ).accountsStorePath,
    ).toBe('/tmp/a.ndjson')
    expect(() =>
      parseConsoleArgs(
        ['--accounts', '--accounts-store', 'rel.ndjson'],
        'qianmo',
      ),
    ).toThrow('absolute')
    expect(() =>
      parseConsoleArgs(['--accounts-store=/tmp/a.ndjson'], 'qianmo'),
    ).toThrow('--accounts')
  })

  test('the migration switches need --accounts, and parse strictly', () => {
    const on = parseConsoleArgs(['--accounts'], 'qianmo')
    expect(on.sessionsStorePath).toBe(consoleSessionsPath())
    expect(
      consoleSessionsPath().endsWith(
        join('qianmo', 'console', 'sessions.ndjson'),
      ),
    ).toBe(true)
    expect(on.legacyViewToken).toBe(true)
    expect(on.breakGlass).toBe(false)
    const off = parseConsoleArgs(
      [
        '--accounts',
        '--legacy-view-token',
        'off',
        '--break-glass',
        '--sessions-store=/tmp/s.ndjson',
      ],
      'qianmo',
    )
    expect(off.legacyViewToken).toBe(false)
    expect(off.breakGlass).toBe(true)
    expect(off.sessionsStorePath).toBe('/tmp/s.ndjson')
    for (const alone of [
      ['--break-glass'],
      ['--legacy-view-token', 'off'],
      ['--sessions-store', '/tmp/s.ndjson'],
    ]) {
      expect(() => parseConsoleArgs(alone, 'qianmo')).toThrow('--accounts')
    }
    expect(() =>
      parseConsoleArgs(['--accounts', '--legacy-view-token', 'no'], 'qianmo'),
    ).toThrow('on or off')
    expect(() =>
      parseConsoleArgs(['--accounts', '--sessions-store', 'rel'], 'qianmo'),
    ).toThrow('absolute')
    const plain = parseConsoleArgs([], 'qianmo')
    for (const key of ['sessionsStorePath', 'legacyViewToken', 'breakGlass']) {
      expect(key in plain).toBe(false)
    }
  })

  test('refuses legacy tokens that look like personal secrets', () => {
    const dir = tempDir()
    const book = new AccountBook({
      accounts: new FileLedger(join(dir, 'accounts.ndjson')),
      sessions: new FileLedger(join(dir, 'sessions.ndjson')),
    })
    expect(() =>
      startConsoleServer(deps(), 0, {
        tokens: { view: 'qmu_looks-like-a-credential', admin: TOKENS.admin },
        accounts: { book },
      }),
    ).toThrow('qmu_')
  })
})
