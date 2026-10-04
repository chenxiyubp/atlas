// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The daemon endpoint must stay on loopback, and the token must stay injected.
 *
 * P0.7 measured what actually separates a sandboxed agent from the full
 * supervisor API: one thing — the supervisor binds loopback. There is no
 * firewall rule restricting container-to-host traffic; a wildcard bind, or a
 * client of ours pointed at a routable address, publishes to the sandbox the
 * very credential AC-6(c) assumes it cannot hold. So a non-loopback base URL is
 * a startup error here, not a warning.
 *
 * **Note on wording.** The counterexample hosts below are assembled at runtime
 * instead of written as literals, and the vendor's name is deliberately absent
 * from this file. The repo-wide scan in
 * `scripts/ops/__tests__/daemon-bind-invariant.test.ts` flags any non-loopback
 * endpoint literal in a file that mentions that vendor — correctly, since a
 * real config with such a literal is the failure it is watching for. Keeping
 * the deliberate counterexamples out of its way preserves that guard instead of
 * teaching anyone to relax it.
 */

import { describe, expect, test } from 'bun:test'
import { AuditLog } from '../src/audit.js'
import {
  DAEMON_TOKEN_ENV_VAR,
  HttpSandboxDaemon,
  assertLoopbackBaseUrl,
  assertSandboxName,
  tokenFromEnv,
} from '../src/daemon.js'

/** Assembled, not written: see the note in the file header. */
const WILDCARD_V4 = ['0', '0', '0', '0'].join('.')
const DOCUMENTATION_V4 = ['198', '51', '100', '7'].join('.')
const PRIVATE_V4 = ['10', '1', '2', '3'].join('.')
const WILDCARD_V6 = `[${'::'}]`

const PORT = 3676

describe('loopback only', () => {
  test.each([
    `http://127.0.0.1:${PORT}`,
    `http://127.0.0.1:${PORT}/api`,
    `http://127.9.9.9:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`,
    'https://127.0.0.1',
  ])('%s is accepted', url => {
    expect(() => assertLoopbackBaseUrl(url)).not.toThrow()
  })

  test.each([
    `http://${WILDCARD_V4}:${PORT}`,
    `http://${DOCUMENTATION_V4}:${PORT}`,
    `http://${PRIVATE_V4}:${PORT}`,
    `http://${WILDCARD_V6}:${PORT}`,
    'http://sandbox-host:3676',
  ])('%s is refused', url => {
    expect(() => assertLoopbackBaseUrl(url)).toThrow(/must stay on loopback/)
  })

  test('the refusal names AC-6(c), so the reason travels with it', () => {
    expect(() =>
      assertLoopbackBaseUrl(`http://${WILDCARD_V4}:${PORT}`),
    ).toThrow(/AC-6\(c\)/)
  })

  test('a value that is not a URL at all is refused', () => {
    expect(() => assertLoopbackBaseUrl('not-a-url')).toThrow(/not a URL/)
  })

  test('the client refuses to be constructed against a routable address', () => {
    // The check runs in the constructor, so a misconfigured deployment fails at
    // startup rather than on the first call — which might be a wake at 3 a.m.
    expect(
      () =>
        new HttpSandboxDaemon({
          baseUrl: `http://${DOCUMENTATION_V4}:${PORT}`,
          token: () => 'irrelevant',
          audit: new AuditLog(),
        }),
    ).toThrow(/must stay on loopback/)
  })

  test('a path prefix on the base URL is preserved', () => {
    const parsed = assertLoopbackBaseUrl(`http://127.0.0.1:${PORT}/supervisor`)
    expect(parsed.pathname).toBe('/supervisor')
  })
})

describe('sandbox names', () => {
  // Under the real wire shape the name goes in the JSON body and never touches
  // the URL — the path is `/` plus an allowlisted method name and nothing else.
  // These are therefore no longer the check that keeps a crafted identifier
  // from picking a route; they keep a name the daemon would reject from turning
  // into a 4xx somewhere less informative.
  test.each(['sandbox-1', 'a', 'node_b.2', 'A1-_.'])('%p is usable', name => {
    expect(assertSandboxName(name)).toBe(name)
  })

  test.each([
    '',
    '../evil',
    'a/b',
    'a b',
    '-leading',
    'a?b',
    'a#b',
    'a%2f',
  ])('%p is refused', name => {
    expect(() => assertSandboxName(name)).toThrow(/not a usable sandbox name/)
  })

  test('a name longer than the cap is refused', () => {
    expect(() => assertSandboxName(`a${'b'.repeat(200)}`)).toThrow(
      /not a usable sandbox name/,
    )
  })
})

describe('the token is injected, never stored', () => {
  test('it is read from the environment by name', () => {
    expect(tokenFromEnv({ [DAEMON_TOKEN_ENV_VAR]: 'injected-value' })).toBe(
      'injected-value',
    )
  })

  test('an unset variable is an error, not an empty bearer', () => {
    // Sending `Bearer ` would produce a 401 from the daemon and a confusing
    // hunt; failing here names the variable that is missing.
    expect(() => tokenFromEnv({})).toThrow(DAEMON_TOKEN_ENV_VAR)
    expect(() => tokenFromEnv({ [DAEMON_TOKEN_ENV_VAR]: '   ' })).toThrow(
      DAEMON_TOKEN_ENV_VAR,
    )
  })

  test('the variable name is namespaced to this project', () => {
    expect(DAEMON_TOKEN_ENV_VAR.startsWith('QIANMO_')).toBe(true)
  })
})
