// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DoD ③, part one: the capability surface itself.
 *
 * "The component's reachable capability surface contains no destructive
 * interface" is asserted here against the allowlist; part two
 * (`destroy-unreachable.test.ts`) asserts the same thing end to end against a
 * live server that *does* offer `destroySandbox`, at the same endpoint and
 * behind the same bearer as the two calls we are allowed to make.
 *
 * Every guard below also has its red direction pinned. A guard nobody has seen
 * fail is a guard nobody knows works — the same discipline P0.7's bind
 * invariant test uses on `check-daemon-bind.sh`.
 */

import { describe, expect, test } from 'bun:test'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import {
  ALLOWED_BODY_KEYS,
  ALLOWED_METHODS,
  CapabilityDeniedError,
  DAEMON_CAPABILITY_SURFACE,
  DESTRUCTIVE_WORDS,
  DaemonOp,
  assertSurfaceIsSafe,
  capabilitySurface,
  resolveRoute,
} from '../src/capability.js'

const SANDBOX = 'sandbox-1'

describe('the reachable surface is exactly two verbs, both non-destructive', () => {
  test('capabilitySurface() lists acquireSandbox, listSandboxes and nothing else', () => {
    expect([...capabilitySurface()].sort()).toEqual([
      'acquireSandbox',
      'listSandboxes',
    ])
  })

  test('every route is a POST, because the whole real API is', () => {
    for (const [, route] of DAEMON_CAPABILITY_SURFACE) {
      expect(ALLOWED_METHODS).toContain(route.method)
    }
    expect(ALLOWED_METHODS).toEqual(['POST'])
    expect(ALLOWED_METHODS).not.toContain('DELETE')
  })

  test('no op name or path contains a destructive word', () => {
    for (const [op, route] of DAEMON_CAPABILITY_SURFACE) {
      for (const word of DESTRUCTIVE_WORDS) {
        expect(op.toLowerCase()).not.toContain(word)
        expect(route.path.toLowerCase()).not.toContain(word)
      }
    }
  })

  test('a route can only reach the method it is named after', () => {
    // The daemon routes on the method name, so this identity is what makes the
    // word scan above complete instead of merely suggestive: there is no name
    // under which a route lands on destroySandbox.
    for (const [op, route] of DAEMON_CAPABILITY_SURFACE) {
      expect(route.path).toBe(`/${op}`)
    }
  })

  test('the sandbox name travels in the body, and nothing else does', () => {
    // acquireSandbox also accepts policy / template / metadata; policy is the
    // one that could switch off the freeze thresholds keepalive.ts exists to
    // respect. The body is built by the route, so a caller has no way in.
    const acquire = DAEMON_CAPABILITY_SURFACE.get(DaemonOp.AcquireSandbox)
    expect(acquire?.body(SANDBOX)).toEqual({ name: SANDBOX })
    const list = DAEMON_CAPABILITY_SURFACE.get(DaemonOp.ListSandboxes)
    expect(list?.body(SANDBOX)).toEqual({})
    for (const [, route] of DAEMON_CAPABILITY_SURFACE) {
      for (const key of Object.keys(route.body(SANDBOX))) {
        expect(ALLOWED_BODY_KEYS).toContain(key)
      }
    }
  })
})

describe('resolveRoute refuses everything outside the allowlist', () => {
  test.each([
    ['destroySandbox', 'destructive-op'],
    ['deleteSandbox', 'destructive-op'],
    ['removeTemplate', 'destructive-op'],
    ['revokeApiKey', 'destructive-op'],
    ['rebuildSandbox', 'destructive-op'],
    ['terminate', 'destructive-op'],
    ['kill', 'destructive-op'],
    ['purge', 'destructive-op'],
  ])('%s is denied, and the denial is audited', (op, reason) => {
    const audit = new AuditLog()
    expect(() => resolveRoute(op, SANDBOX, audit, 5_000)).toThrow(
      CapabilityDeniedError,
    )

    const events = audit.of(ActivatorEventType.CapabilityDenied)
    expect(events).toHaveLength(1)
    expect(events[0]?.detail).toEqual({ op, reason, sandboxName: SANDBOX })
    expect(events[0]?.at).toBe(5_000)
  })

  test.each([
    'execCommand',
    'writeFile',
    'writeFiles',
    'updatePolicy',
    'applyUpgrade',
    'createApiKey',
    'setIngress',
  ])('the real method %s is refused too, even though it reads harmlessly', op => {
    // These exist on the daemon and matter — execCommand runs anything,
    // writeFile edits the filesystem, updatePolicy can move the freeze
    // thresholds. None of them contains a scary word, which is exactly why
    // the denylist is not the mechanism: they are refused for being off the
    // allowlist, and the audit says so.
    const audit = new AuditLog()
    let thrown: unknown
    try {
      resolveRoute(op, SANDBOX, audit, 1)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CapabilityDeniedError)
    expect((thrown as CapabilityDeniedError).reason).toBe('unknown-op')
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(1)
  })

  test('an op nobody recognises is denied too, classified as unknown', () => {
    const audit = new AuditLog()
    let thrown: unknown
    try {
      resolveRoute('nonsense', SANDBOX, audit, 1)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CapabilityDeniedError)
    expect((thrown as CapabilityDeniedError).reason).toBe('unknown-op')
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(1)
  })

  test('the error names the allowed surface, so the denial is diagnosable', () => {
    const audit = new AuditLog()
    expect(() => resolveRoute('destroySandbox', SANDBOX, audit, 1)).toThrow(
      /acquireSandbox, listSandboxes/,
    )
  })

  test('the audit is written before the throw, so a catch cannot erase it', () => {
    const audit = new AuditLog()
    try {
      resolveRoute('destroySandbox', SANDBOX, audit, 1)
    } catch {
      // Swallowed exactly as a careless caller would swallow it.
    }
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(1)
  })

  test('denials stay counted after the ring has evicted them', () => {
    // A flood of attempts must not be able to push the evidence out of the log.
    const audit = new AuditLog(2)
    for (let i = 0; i < 50; i += 1) {
      try {
        resolveRoute('destroySandbox', SANDBOX, audit, i)
      } catch {
        // expected
      }
    }
    expect(audit.of(ActivatorEventType.CapabilityDenied)).toHaveLength(2)
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(50)
  })

  test.each([
    DaemonOp.AcquireSandbox,
    DaemonOp.ListSandboxes,
  ])('%s resolves and is not audited as a denial', op => {
    const audit = new AuditLog()
    const request = resolveRoute(op, SANDBOX, audit, 1)
    expect(ALLOWED_METHODS).toContain(request.method)
    expect(request.path).toBe(`/${op}`)
    expect(audit.count(ActivatorEventType.CapabilityDenied)).toBe(0)
  })
})

describe('assertSurfaceIsSafe refuses a widened surface at import time', () => {
  const body = (name: string) => ({ name })

  test('the shipped surface passes', () => {
    expect(() => assertSurfaceIsSafe(DAEMON_CAPABILITY_SURFACE)).not.toThrow()
  })

  // ↓↓↓ Red direction. Each of these is a plausible future commit.
  test('a DELETE route is refused', () => {
    const surface = new Map([
      ['evictSandbox', { method: 'DELETE', path: '/evictSandbox', body }],
    ])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(/uses method "DELETE"/)
  })

  test('a GET route is refused, because the real API has none', () => {
    const surface = new Map([
      ['getSandbox', { method: 'GET', path: '/getSandbox', body }],
    ])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(/uses method "GET"/)
  })

  test('an op named after a destructive action is refused', () => {
    const surface = new Map([
      ['destroySandbox', { method: 'POST', path: '/destroySandbox', body }],
    ])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(
      /contains destructive word "destroy"/,
    )
  })

  test('an innocently named op routed at a destructive path is refused', () => {
    // The nastier case: the name looks fine and the path does the damage.
    const surface = new Map([
      ['cleanup', { method: 'POST', path: '/destroySandbox', body }],
    ])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(/routes to .*destroy/)
  })

  test('an op routed anywhere but at its own name is refused', () => {
    // The version of the same trick that no word list could catch: a harmless
    // name pointed at a harmless-sounding method that is not the one it claims.
    const surface = new Map([
      ['listSandboxes', { method: 'POST', path: '/execCommand', body }],
    ])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(
      /must route to "\/listSandboxes"/,
    )
  })

  test('a route that smuggles an extra body key is refused', () => {
    const surface = new Map([
      [
        'acquireSandbox',
        {
          method: 'POST',
          path: '/acquireSandbox',
          body: (name: string) => ({
            name,
            policy: { freezeAfterSeconds: null },
          }),
        },
      ],
    ])
    expect(() => assertSurfaceIsSafe(surface)).toThrow(
      /sends body key "policy"/,
    )
  })

  test('importing capability.ts already ran the check on the real surface', () => {
    // If the module-level call were removed, this file would still pass its
    // other tests, so the fact of the call is asserted directly: a surface that
    // fails the check cannot be loaded, which is what makes the guard a
    // property of the build rather than of anyone's diligence.
    const source = Bun.file(
      new URL('../src/capability.ts', import.meta.url).pathname,
    )
    return source.text().then(text => {
      expect(text).toContain('assertSurfaceIsSafe(DAEMON_CAPABILITY_SURFACE)')
    })
  })
})
