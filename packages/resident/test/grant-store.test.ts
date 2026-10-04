// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signAuthzDecision,
  type AuthzDecision,
  type AuthzOrigin,
  type AuthzRequest,
  type NodeKeyPair,
} from '@qianmo/capability'
import { ResidentEstop } from '../src/estop.js'
import {
  AUTHZ_LEDGER_FILE,
  FileGrantStore,
  type AuthzCall,
  type FileGrantStoreOptions,
} from '../src/grant-store.js'
import { ResidentHardline } from '../src/guard.js'

const NODE = 'beta-4'
const T0 = 1_800_000_000_000
const MINUTE = 60_000
const SUBJECT = 'u:7f3a0c1d2e4b5a69'
const APPROVER = `hub/${SUBJECT}`
const ORIGIN: AuthzOrigin = {
  from: 'qianmo://hub/console',
  taskId: 'task-1',
  traceId: null,
  trust: 'untrusted',
}

const hubKeys = generateNodeKeyPair()
const strangerKeys = generateNodeKeyPair()
const trustKeys = generateNodeKeyPair()

let root: string
let config: string
let ledger: string
let now: number
let commanders: string[]
let stores: FileGrantStore[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-grant-store-'))
  config = join(root, 'config')
  ledger = join(config, 'resident', AUTHZ_LEDGER_FILE)
  now = T0
  commanders = [trustKeys.publicKey]
  stores = []
})

afterEach(() => {
  for (const store of stores) store.close()
  rmSync(root, { recursive: true, force: true })
})

function hardline(protectedRoots: readonly string[] = []): ResidentHardline {
  return new ResidentHardline({ stateRoots: [config], protectedRoots })
}

function open(overrides: Partial<FileGrantStoreOptions> = {}): FileGrantStore {
  const store = new FileGrantStore({
    path: ledger,
    node: NODE,
    approvers: new Map([['hub', hubKeys.publicKey]]),
    commanderKeys: () => commanders,
    hardline: hardline(),
    estop: new ResidentEstop({ path: join(config, 'resident', 'ESTOP') }),
    now: () => now,
    ...overrides,
  })
  stores.push(store)
  return store
}

function bash(command: string, contextId = 'ctx-1'): AuthzCall {
  return {
    agent: 'main',
    contextId,
    toolName: 'Bash',
    input: { command, description: 'Run it' },
  }
}

function ask(store: FileGrantStore, call: AuthzCall): AuthzRequest {
  const outcome = store.ask({ ...call, origin: ORIGIN })
  if (outcome.kind !== 'pending') {
    throw new Error(`expected a pending request, got ${outcome.reason}`)
  }
  return outcome.request
}

function decide(
  request: AuthzRequest,
  overrides: Partial<AuthzDecision> = {},
  keys: NodeKeyPair = hubKeys,
): string {
  return signAuthzDecision(keys, {
    v: 1,
    requestId: request.requestId,
    aud: NODE,
    sub: request.sub,
    digest: request.digest,
    decision: 'allow-once',
    windowMs: 0,
    approver: APPROVER,
    nbf: now,
    exp: now + MINUTE,
    nonce: randomBytes(16).toString('base64url'),
    ...overrides,
  })
}

/** Same payload bytes, any signature: what a forger can always produce. */
function resigned(wire: string, signature: string): string {
  return `${wire.split('.')[0]}.${signature}`
}

function ledgerLines(): unknown[] {
  return readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line))
}

describe('pending and binding rows live under <config>/resident/ (I-12)', () => {
  test('file surface: the hardline refuses the ledger to Read and Write', () => {
    const store = open()
    ask(store, bash('touch /tmp/outside'))
    expect(store.path).toBe(join(config, 'resident', 'authz.ndjson'))
    for (const [tool, input] of [
      ['Read', { file_path: store.path }],
      ['Write', { file_path: store.path, content: '{}' }],
    ] as const) {
      const denial = hardline().verdict(tool, input)
      expect(denial?.target.id).toBe('node-state')
      expect(denial?.surface).toBe('file')
    }
  })

  test('shell surface: the hardline refuses the ledger to cat and to a redirect', () => {
    const store = open()
    for (const command of [
      `cat ${store.path}`,
      `echo '{"kind":"decided"}' >> ${store.path}`,
    ]) {
      const denial = hardline().verdict('Bash', { command })
      expect(denial?.target.id).toBe('node-state')
      expect(denial?.surface).toBe('shell')
    }
  })

  test('a call that touches the ledger never becomes a request', () => {
    const store = open()
    const outcome = store.ask({ ...bash(`cat ${ledger}`), origin: ORIGIN })
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'hardline' })
    expect(store.pending()).toEqual([])
  })

  test('the store will not open where the hardline does not refuse', () => {
    expect(() =>
      open({ path: join(root, 'workspace', AUTHZ_LEDGER_FILE) }),
    ).toThrow(/hardline/)
  })

  test('the ledger is private to the node user', () => {
    const store = open()
    ask(store, bash('touch /tmp/outside'))
    if (process.platform === 'win32') return
    expect(statSync(ledger).mode & 0o777).toBe(0o600)
    expect(statSync(join(config, 'resident')).mode & 0o777).toBe(0o700)
  })
})

describe('applying a decision: order and refusals', () => {
  test('an approved call runs once and only once', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    const outcome = store.applyDecision(decide(request))
    expect(outcome).toMatchObject({ ok: true, decision: 'allow-once' })
    expect(store.use(bash('touch /tmp/outside'))).toMatchObject({ kind: 'hit' })
    expect(store.use(bash('touch /tmp/outside'))).toEqual({ kind: 'miss' })
  })

  test('unsigned garbage cannot burn a real approval’s nonce', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    const real = decide(request)
    // The real approval's exact bytes under a signature nobody made, and
    // under a stranger's real signature.
    expect(store.applyDecision(resigned(real, 'A'.repeat(86)))).toEqual({
      ok: false,
      reason: 'signature',
    })
    const stranger = decide(request, {}, strangerKeys)
    expect(
      store.applyDecision(resigned(real, stranger.split('.')[1] ?? '')),
    ).toEqual({ ok: false, reason: 'signature' })
    expect(store.pending().map(r => r.requestId)).toEqual([request.requestId])
    expect(store.applyDecision(real)).toMatchObject({ ok: true })
  })

  test('replay in the same life is refused', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    const real = decide(request)
    expect(store.applyDecision(real)).toMatchObject({ ok: true })
    expect(store.applyDecision(real)).toEqual({ ok: false, reason: 'replay' })
  })

  test('replay after a restart is refused, and a consumed grant stays consumed', () => {
    const first = open()
    const request = ask(first, bash('touch /tmp/outside'))
    const real = decide(request)
    expect(first.applyDecision(real)).toMatchObject({ ok: true })
    expect(first.use(bash('touch /tmp/outside'))).toMatchObject({ kind: 'hit' })
    first.close()

    const second = open()
    expect(second.applyDecision(real)).toEqual({ ok: false, reason: 'replay' })
    expect(second.use(bash('touch /tmp/outside'))).toEqual({ kind: 'miss' })
  })

  test('a fresh signature over a decided request is refused (first line)', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    expect(store.applyDecision(decide(request))).toMatchObject({ ok: true })
    // New nonce, valid signature: only the request state stands in the way.
    expect(store.applyDecision(decide(request))).toEqual({
      ok: false,
      reason: 'replay',
    })
  })

  test('a reused nonce is refused even on a fresh request (second line)', () => {
    const store = open()
    const one = ask(store, bash('touch /tmp/one'))
    const two = ask(store, bash('touch /tmp/two'))
    const nonce = 'shared-nonce-0123456789'
    expect(store.applyDecision(decide(one, { nonce }))).toMatchObject({
      ok: true,
    })
    expect(store.applyDecision(decide(two, { nonce }))).toEqual({
      ok: false,
      reason: 'replay',
    })
  })

  test('a decision for another node is refused', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    expect(store.applyDecision(decide(request, { aud: 'beta-1' }))).toEqual({
      ok: false,
      reason: 'aud',
    })
  })

  test('a decision whose digest or subject does not match is refused', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    const other = ask(store, bash('rm -rf /tmp/outside'))
    expect(
      store.applyDecision(decide(request, { digest: other.digest })),
    ).toEqual({ ok: false, reason: 'digest' })
    expect(
      store.applyDecision(decide(request, { sub: 'qianmo://beta-4/other' })),
    ).toEqual({ ok: false, reason: 'sub' })
  })

  test('expired decisions and expired requests are refused', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    const late = decide(request)
    now += 2 * MINUTE
    expect(store.applyDecision(late)).toEqual({ ok: false, reason: 'expired' })

    now += 9 * MINUTE
    expect(store.applyDecision(decide(request))).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  test('a decision from the future, or outliving the request, is refused', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    expect(
      store.applyDecision(
        decide(request, { nbf: now + MINUTE, exp: now + 2 * MINUTE }),
      ),
    ).toEqual({ ok: false, reason: 'clock', detail: 'not-yet-valid' })
    expect(
      store.applyDecision(decide(request, { exp: now + 11 * MINUTE })),
    ).toEqual({ ok: false, reason: 'clock', detail: 'lifetime' })
  })

  test('a console this node does not take approvals from is refused', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    expect(
      store.applyDecision(
        decide(request, { approver: `rogue/${SUBJECT}` }, strangerKeys),
      ),
    ).toEqual({ ok: false, reason: 'approver', detail: 'unknown-console' })
    // Right console name, wrong key.
    expect(store.applyDecision(decide(request, {}, strangerKeys))).toEqual({
      ok: false,
      reason: 'signature',
    })
  })

  test('legacy:* approvers are refused, break-glass admin included', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    for (const approver of ['hub/legacy:admin', 'hub/legacy:view']) {
      expect(store.applyDecision(decide(request, { approver }))).toEqual({
        ok: false,
        reason: 'approver',
        detail: 'legacy',
      })
    }
    expect(store.applyDecision(decide(request))).toMatchObject({ ok: true })
  })

  test('an approval key that can also command the node is refused (I-6)', () => {
    commanders = [trustKeys.publicKey, hubKeys.publicKey]
    expect(() => open()).toThrow(/I-6/)

    commanders = [trustKeys.publicKey]
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    // The certificate directory grew while the node ran.
    commanders = [trustKeys.publicKey, hubKeys.publicKey]
    expect(store.applyDecision(decide(request))).toEqual({
      ok: false,
      reason: 'approver',
      detail: 'commander',
    })

    // A key source that cannot be read refuses rather than waves through.
    const broken = open({
      path: join(config, 'resident', 'other-authz.ndjson'),
      commanderKeys: () => {
        if (now > T0) throw new Error('certificate directory unreadable')
        return []
      },
    })
    const pending = ask(broken, bash('touch /tmp/outside'))
    now += 1
    expect(broken.applyDecision(decide(pending))).toEqual({
      ok: false,
      reason: 'approver',
      detail: 'commander',
    })
  })

  test('unknown requests and malformed wires are refused', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    expect(
      store.applyDecision(decide({ ...request, requestId: 'f'.repeat(32) })),
    ).toEqual({ ok: false, reason: 'request' })
    const extra = Buffer.from(
      JSON.stringify({
        ...JSON.parse(
          Buffer.from(
            decide(request).split('.')[0] ?? '',
            'base64url',
          ).toString('utf8'),
        ),
        tenant: 'x',
      }),
    ).toString('base64url')
    expect(store.applyDecision(`${extra}.${'A'.repeat(86)}`)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(store.applyDecision('not a decision')).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  test('ESTOP refuses decisions without using them up', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    const real = decide(request)
    writeFileSync(join(config, 'resident', 'ESTOP'), '')
    expect(store.applyDecision(real)).toEqual({ ok: false, reason: 'estop' })
    rmSync(join(config, 'resident', 'ESTOP'))
    expect(store.applyDecision(real)).toMatchObject({ ok: true })
  })
})

describe('grants', () => {
  test('an identical call waits on the same request, however it is worded', () => {
    const store = open()
    const first = ask(store, bash('touch /tmp/outside'))
    const again = store.ask({
      agent: 'main',
      contextId: 'ctx-1',
      toolName: 'Bash',
      input: { description: 'Create the file', command: 'touch /tmp/outside' },
      origin: ORIGIN,
    })
    expect(again).toEqual({ kind: 'pending', request: first, created: false })
  })

  test('allow-window covers the same digest, in the same context, until it ends', () => {
    const store = open()
    const request = ask(store, bash('git push'))
    const outcome = store.applyDecision(
      decide(request, { decision: 'allow-window', windowMs: 30 * MINUTE }),
    )
    expect(outcome).toMatchObject({ ok: true, grant: { scope: 'window' } })
    expect(store.use(bash('git push'))).toMatchObject({ kind: 'hit' })
    expect(store.use(bash('git push'))).toMatchObject({ kind: 'hit' })
    expect(store.use(bash('git push --force'))).toEqual({ kind: 'miss' })
    expect(store.use(bash('git push', 'ctx-2'))).toEqual({ kind: 'miss' })
    now += 30 * MINUTE
    expect(store.use(bash('git push'))).toEqual({ kind: 'miss' })
  })

  test('allow-once dies unused after ten minutes', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    store.applyDecision(decide(request))
    now += 10 * MINUTE
    expect(store.use(bash('touch /tmp/outside'))).toEqual({ kind: 'miss' })
  })

  test('deny decides the request and grants nothing', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    expect(
      store.applyDecision(decide(request, { decision: 'deny' })),
    ).toMatchObject({ ok: true, decision: 'deny', grant: null })
    expect(store.use(bash('touch /tmp/outside'))).toEqual({ kind: 'miss' })
    expect(store.pending()).toEqual([])
  })

  test('the hardline wins over a live grant', () => {
    const memory = join(root, 'memory')
    const read: AuthzCall = {
      agent: 'main',
      contextId: 'ctx-1',
      toolName: 'Read',
      input: { file_path: join(memory, 'working', 'a.md') },
    }
    const before = open()
    const request = ask(before, read)
    expect(before.applyDecision(decide(request))).toMatchObject({ ok: true })
    before.close()

    // The host restarts with the memory root protected; the grant is live.
    const after = open({ hardline: hardline([memory]) })
    expect(after.use(read)).toMatchObject({
      kind: 'refused',
      reason: 'hardline',
      denial: { target: { id: 'memory-root' } },
    })
    expect(after.ask({ ...read, origin: ORIGIN })).toMatchObject({
      kind: 'refused',
      reason: 'hardline',
    })
  })

  test('ESTOP: nothing hits while engaged, and releasing it brings nothing back', () => {
    const store = open()
    const request = ask(store, bash('git push'))
    store.applyDecision(
      decide(request, { decision: 'allow-window', windowMs: 30 * MINUTE }),
    )
    writeFileSync(join(config, 'resident', 'ESTOP'), '')
    expect(store.use(bash('git push'))).toEqual({
      kind: 'refused',
      reason: 'estop',
    })
    rmSync(join(config, 'resident', 'ESTOP'))
    expect(store.use(bash('git push'))).toEqual({ kind: 'miss' })
  })

  test('ending a context ends its grants and its waiting requests only', () => {
    const store = open()
    const mine = ask(store, bash('git push', 'ctx-1'))
    const theirs = ask(store, bash('git push', 'ctx-2'))
    const waiting = ask(store, bash('git pull', 'ctx-1'))
    store.applyDecision(
      decide(mine, { decision: 'allow-window', windowMs: 30 * MINUTE }),
    )
    store.applyDecision(
      decide(theirs, { decision: 'allow-window', windowMs: 30 * MINUTE }),
    )
    expect(store.endContext('ctx-1')).toBe(1)
    expect(store.use(bash('git push', 'ctx-1'))).toEqual({ kind: 'miss' })
    expect(store.use(bash('git push', 'ctx-2'))).toMatchObject({ kind: 'hit' })
    expect(store.applyDecision(decide(waiting))).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  test('revoking a grant, and revoking an approver for good', () => {
    const store = open()
    const one = ask(store, bash('git push'))
    const two = ask(store, bash('git fetch'))
    const three = ask(store, bash('git pull'))
    const a = store.applyDecision(
      decide(one, { decision: 'allow-window', windowMs: 30 * MINUTE }),
    )
    store.applyDecision(
      decide(two, { decision: 'allow-window', windowMs: 30 * MINUTE }),
    )
    if (!a.ok || a.grant === null) throw new Error('expected a grant')
    expect(store.revoke(a.grant.grantId)).toBe(true)
    expect(store.revoke(a.grant.grantId)).toBe(false)
    expect(store.use(bash('git push'))).toEqual({ kind: 'miss' })

    expect(store.revokeApprover(APPROVER)).toBe(1)
    expect(store.use(bash('git fetch'))).toEqual({ kind: 'miss' })
    store.close()

    const restarted = open()
    expect(restarted.applyDecision(decide(three))).toEqual({
      ok: false,
      reason: 'approver',
      detail: 'revoked',
    })
  })

  test('sweep closes out requests nobody answered', () => {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    now += 10 * MINUTE
    expect(store.sweep().map(r => r.requestId)).toEqual([request.requestId])
    expect(store.pending()).toEqual([])
    expect(store.sweep()).toEqual([])
  })
})

describe('a damaged ledger fails closed', () => {
  function seeded(): { request: AuthzRequest; wire: string } {
    const store = open()
    const request = ask(store, bash('touch /tmp/outside'))
    const wire = decide(request)
    store.close()
    return { request, wire }
  }

  test('a corrupt line stops every call', () => {
    const { wire } = seeded()
    appendFileSync(ledger, 'not json\n')
    const store = open()
    expect(store.integrityIssues()).toEqual([{ line: 2, kind: 'corrupt_line' }])
    expect(store.applyDecision(wire)).toEqual({
      ok: false,
      reason: 'integrity',
    })
    expect(store.use(bash('touch /tmp/outside'))).toEqual({
      kind: 'refused',
      reason: 'integrity',
    })
    expect(store.ask({ ...bash('ls'), origin: ORIGIN })).toEqual({
      kind: 'refused',
      reason: 'integrity',
    })
  })

  test('a record with one extra key is corrupt', () => {
    seeded()
    appendFileSync(
      ledger,
      `${JSON.stringify({ kind: 'estop', at: T0, by: 'x' })}\n`,
    )
    expect(open().integrityIssues()).toEqual([
      { line: 2, kind: 'corrupt_line' },
    ])
  })

  test('a transition that could not have happened is refused', () => {
    seeded()
    appendFileSync(
      ledger,
      `${JSON.stringify({ kind: 'consumed', at: T0, grantId: 'e'.repeat(32) })}\n`,
    )
    expect(open().integrityIssues()).toEqual([
      { line: 2, kind: 'inconsistent' },
    ])
  })

  test('a torn tail is ignored, then cut before the next record', () => {
    const { request, wire } = seeded()
    appendFileSync(ledger, '{"kind":"decided","at":')
    const store = open()
    expect(store.integrityIssues()).toEqual([])
    expect(store.pending().map(r => r.requestId)).toEqual([request.requestId])
    expect(store.applyDecision(wire)).toMatchObject({ ok: true })
    expect(ledgerLines().map(line => (line as { kind: string }).kind)).toEqual([
      'requested',
      'decided',
    ])
  })

  test('a symlink in place of the ledger is not followed', () => {
    if (process.platform === 'win32') return
    const elsewhere = join(root, 'elsewhere.ndjson')
    writeFileSync(elsewhere, '')
    mkdirSync(join(config, 'resident'), { recursive: true })
    symlinkSync(elsewhere, ledger)
    const store = open()
    expect(store.integrityIssues()).toEqual([{ line: 0, kind: 'unreadable' }])
    expect(store.ask({ ...bash('ls'), origin: ORIGIN })).toEqual({
      kind: 'refused',
      reason: 'integrity',
    })
  })
})
