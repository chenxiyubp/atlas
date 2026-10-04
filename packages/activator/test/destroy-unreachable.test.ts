// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DoD ③, part two: end to end against a server that really does offer destroy.
 *
 * The shape of the argument matters more than any single assertion:
 *
 *   1. **Control** — a plain `fetch`, holding the same bearer this component
 *      holds and aimed at the same endpoint this component is aimed at,
 *      destroys a sandbox through the stub. The route is live, the credential
 *      is sufficient, and nothing about the environment is stopping anybody.
 *      (This is the real daemon's situation, and more literally than it used to
 *      be: `destroySandbox` is one path segment away from `listSandboxes` on
 *      the very endpoint we call, and the credential has no privilege tiers, so
 *      *read* and *destroy* are the same key.)
 *   2. **The attempt** — the same destructive call, made through this
 *      component, fails and is audited.
 *   3. **The counter** — the stub's destroy hit count proves the request never
 *      reached the wire, rather than merely that an exception was raised
 *      somewhere.
 *
 * Without step 1 the whole file would be vacuous; a route nobody implements is
 * unreachable for uninteresting reasons.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import { CapabilityDeniedError } from '../src/capability.js'
import {
  HttpSandboxDaemon,
  SandboxNotFoundError,
  type SandboxDaemon,
} from '../src/daemon.js'
import { STUB_TOKEN, type StubDaemon, startStubDaemon } from './stub-daemon.js'

let stub: StubDaemon
let audit: AuditLog
let daemon: HttpSandboxDaemon

beforeAll(() => {
  stub = startStubDaemon({
    initialState: 'frozen',
    sandboxes: ['live-sandbox', 'control-victim'],
  })
  audit = new AuditLog()
  daemon = new HttpSandboxDaemon({
    baseUrl: stub.url,
    token: () => STUB_TOKEN,
    audit,
  })
})

afterAll(async () => {
  await stub.stop()
})

describe('control: the destroy route is live and the credential suffices', () => {
  test('a plain client destroys a sandbox through the same bearer', async () => {
    const before = stub.hits.destroySandbox
    const response = await fetch(`${stub.url}/destroySandbox`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${STUB_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'control-victim' }),
    })
    expect(response.status).toBe(200)
    expect(stub.hits.destroySandbox).toBe(before + 1)
    expect(stub.stateOf('control-victim')).toBe('stopped')
  })

  test('and it lives at the very endpoint our client is pointed at', () => {
    // Not a rhetorical flourish: under the real "method name is the path
    // segment" RPC, `destroySandbox` differs from `listSandboxes` by one
    // string. Nothing but the allowlist separates the two.
    expect(new URL(daemon.baseUrl).origin).toBe(new URL(stub.url).origin)
  })
})

describe('the component cannot reach a destructive verb', () => {
  test('the port type has no destructive member at all', () => {
    const port: SandboxDaemon = daemon
    expect(Object.keys(port)).not.toContain('destroy')
    expect('destroy' in port).toBe(false)
    expect('destroySandbox' in port).toBe(false)
    // Reaching for it the only way TypeScript leaves open — casting the type
    // away — finds nothing to call.
    const smuggled = port as unknown as {
      destroySandbox?: (name: string) => Promise<void>
    }
    expect(smuggled.destroySandbox).toBeUndefined()
  })

  test.each([
    'destroySandbox',
    'deleteSandbox',
    'removeTemplate',
    'revokeApiKey',
    'terminate',
    'kill',
  ])('send(%p) is refused before any request is built, and audited', async op => {
    const destroysBefore = stub.hits.destroySandbox
    const deniedBefore = audit.count(ActivatorEventType.CapabilityDenied)

    // The low-level door is public on purpose: the guard is on the door, not
    // on knowing where the door is.
    const attempt = daemon.send(op, 'target-sandbox')
    await expect(attempt).rejects.toBeInstanceOf(CapabilityDeniedError)

    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(
      deniedBefore + 1,
    )
    const last = audit.of(ActivatorEventType.CapabilityDenied).at(-1)
    expect(last?.detail.op).toBe(op)
    expect(last?.detail.reason).toBe('destructive-op')
    expect(last?.detail.sandboxName).toBe('target-sandbox')

    // The load-bearing assertion: nothing went out.
    expect(stub.hits.destroySandbox).toBe(destroysBefore)
  })

  test.each([
    'execCommand',
    'writeFile',
    'updatePolicy',
  ])('send(%p) is refused too — a real method, off the allowlist', async op => {
    const unknownBefore = stub.hits.unknown
    await expect(daemon.send(op, 'target-sandbox')).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    )
    // Refused before the request was built, so the stub never even saw a
    // request it did not route.
    expect(stub.hits.unknown).toBe(unknownBefore)
  })

  test('a crafted sandbox name cannot smuggle a route past the allowlist', async () => {
    // Under the real wire shape the name never touches the URL at all — the
    // path comes from the allowlist and the name goes in the JSON body — so
    // this is now belt and braces rather than the mechanism. It still refuses.
    const destroysBefore = stub.hits.destroySandbox
    const unknownBefore = stub.hits.unknown
    await expect(daemon.send('acquireSandbox', '../victim')).rejects.toThrow(
      /not a usable sandbox name/,
    )
    await expect(
      daemon.send('acquireSandbox', 'ok/../../victim'),
    ).rejects.toThrow(/not a usable sandbox name/)
    expect(stub.hits.destroySandbox).toBe(destroysBefore)
    expect(stub.hits.unknown).toBe(unknownBefore)
  })

  test('an HTTP method is not something a caller gets to choose', async () => {
    // `send` takes an op, never a method: there is no parameter to pass DELETE
    // through. Asking for one by name is just another unknown op.
    const destroysBefore = stub.hits.destroySandbox
    await expect(
      daemon.send('DELETE', 'target-sandbox'),
    ).rejects.toBeInstanceOf(CapabilityDeniedError)
    expect(stub.hits.destroySandbox).toBe(destroysBefore)
  })
})

describe('the allowed surface still works, over the real socket', () => {
  test('status and acquire both reach the stub, in the real wire shape', async () => {
    const name = 'live-sandbox'
    expect((await daemon.status(name)).state).toBe('frozen')
    expect((await daemon.acquire(name)).state).toBe('active')
    expect((await daemon.status(name)).state).toBe('active')

    expect(stub.hits.listSandboxes).toBeGreaterThan(0)
    expect(stub.hits.acquireSandbox).toBeGreaterThan(0)
    expect(stub.hits.unauthorized).toBe(0)
    expect(stub.hits.unknown).toBe(0)
  })

  test('a name the daemon does not list is an error, not a state', async () => {
    // The API has no by-name read, so "absent" and "state we cannot parse" are
    // different answers to different questions. Rounding the first into the
    // second would let the activator acquire a name that does not exist — which
    // on the real daemon creates a sandbox.
    await expect(daemon.status('no-such-sandbox')).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    )
  })

  test('the only destroy the stub ever served was the control one', () => {
    expect(stub.hits.destroySandbox).toBe(1)
  })
})
