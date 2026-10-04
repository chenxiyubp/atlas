// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DoD ③, part three: the assertion that goes into CI and stays there.
 *
 * Parts one and two prove the surface is safe *today*. This file is the part
 * that keeps it safe: a scan of `src/` that goes red the moment somebody adds a
 * destructive route, opens a second path to the network that bypasses the
 * allowlist, or — since the real API is `POST /{methodName}` with the
 * parameters in the body — finds a second way to decide what those parameters
 * are. Same mechanism as P0.7's `daemon-bind-invariant.test.ts`: a detector,
 * applied to the real artefacts, with its red direction pinned by fixtures so
 * it can never be quietly satisfied by scanning nothing.
 *
 * The detector runs over source with comments stripped. Prose has to be able to
 * *discuss* destructive verbs — this file and `capability.ts` both do, at
 * length — while code must not contain them.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC_DIR = join(import.meta.dir, '..', 'src')
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter(name => name.endsWith('.ts'))
    .sort()
}

/**
 * Remove line and block comments.
 *
 * Good enough for this package's own source, and its blind spot is safe: a
 * comment marker inside a string literal would make the scanner drop *more*
 * text than it should, which can only cause a missed finding in a file that is
 * also checked by the two tests above — never a false accusation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** HTTP methods that can remove or overwrite server-side state. */
const MUTATING_METHOD = /method\s*:\s*['"`](DELETE|PUT|PATCH)['"`]/gi

/** A quoted path-looking literal naming a destructive action. */
const DESTRUCTIVE_PATH =
  /['"`][^'"`\n]*\/[^'"`\n]*(destroy|delete|remove|purge|prune|terminate|kill|wipe|shutdown)[^'"`\n]*['"`]/gi

interface Finding {
  readonly file: string
  readonly kind: 'mutating-method' | 'destructive-path'
  readonly text: string
}

function scan(file: string, source: string): Finding[] {
  const code = stripComments(source)
  const findings: Finding[] = []
  for (const match of code.matchAll(MUTATING_METHOD)) {
    findings.push({ file, kind: 'mutating-method', text: match[0] })
  }
  for (const match of code.matchAll(DESTRUCTIVE_PATH)) {
    findings.push({ file, kind: 'destructive-path', text: match[0] })
  }
  return findings
}

describe('no destructive interface exists in packages/activator/src', () => {
  test('the scan has files to scan', () => {
    // Guards against the failure mode where a rename makes this whole file
    // pass by examining nothing.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(7)
  })

  test('no source file declares a mutating method or a destructive path', () => {
    const findings = sourceFiles().flatMap(name =>
      scan(name, readFileSync(join(SRC_DIR, name), 'utf8')),
    )
    expect(findings).toEqual([])
  })

  test('red direction: a DELETE route is caught', () => {
    const dirty = "const route = { method: 'DELETE', path: '/evictSandbox' }"
    expect(scan('fixture.ts', dirty).map(f => f.kind)).toContain(
      'mutating-method',
    )
  })

  test('red direction: a destructive path literal is caught', () => {
    // The path is now a plain method name behind a slash, which is what the
    // real API's `POST /{methodName}` shape produces.
    const dirty = 'const route = { method: "POST", path: "/destroySandbox" }'
    expect(scan('fixture.ts', dirty).map(f => f.kind)).toContain(
      'destructive-path',
    )
  })

  test('green direction: prose about destroy is not a finding', () => {
    const clean = [
      '// This component must never call POST /destroySandbox.',
      '/* Nor /removeTemplate, nor /revokeApiKey. */',
      "const route = { method: 'POST', path: '/acquireSandbox' }",
    ].join('\n')
    expect(scan('fixture.ts', clean)).toEqual([])
  })
})

describe('there is exactly one way out to the network', () => {
  /**
   * The allowlist is only worth anything if every request passes through it.
   * A second `fetch` call site somewhere in `src/` would be a second door, and
   * this is the assertion that notices one appearing.
   */
  test('only daemon.ts calls fetch', () => {
    const callers = sourceFiles().filter(name => {
      const code = stripComments(readFileSync(join(SRC_DIR, name), 'utf8'))
      return /\bfetch\s*\(/.test(code)
    })
    expect(callers).toEqual(['daemon.ts'])
  })

  test('daemon.ts routes every request through resolveRoute', () => {
    const code = stripComments(readFileSync(join(SRC_DIR, 'daemon.ts'), 'utf8'))
    const fetchCalls = [...code.matchAll(/\bfetch\s*\(/g)].length
    const guards = [...code.matchAll(/\bresolveRoute\s*\(/g)].length
    // One guard per outbound call, and the guard is not optional: `send` is the
    // only method that builds a URL, and it resolves before it builds.
    expect(guards).toBeGreaterThanOrEqual(1)
    expect(fetchCalls).toBeLessThanOrEqual(2)
    expect(code).toMatch(/resolveRoute\([\s\S]{0,200}?new URL\(/)
  })

  test('the request body on the wire is the allowlist’s, not a caller’s', () => {
    // Under `POST /{methodName}` the parameters carry as much authority as the
    // path: `acquireSandbox` also accepts a `policy`, which could switch off
    // the very freeze thresholds keepalive.ts refuses to let anyone disable.
    // So the body has to come from the resolved route and from nowhere else.
    const code = stripComments(readFileSync(join(SRC_DIR, 'daemon.ts'), 'utf8'))
    // Every serialised request body in the file, and what each one serialises.
    // Exactly one, and it is the resolved route's.
    const serialised = [
      ...code.matchAll(/body:\s*JSON\.stringify\(([^)]*)\)/g),
    ].map(match => match[1])
    expect(serialised).toEqual(['route.body'])
  })
})

describe('nothing key-shaped is committed', () => {
  const SECRET =
    /(bearer\s+[\w.~+/=-]{12,}|api[_-]?key\s*[=:]\s*['"]|password\s*[=:]\s*['"]|-----BEGIN)/i

  test('no source file contains a literal credential', () => {
    for (const name of sourceFiles()) {
      const source = readFileSync(join(SRC_DIR, name), 'utf8')
      expect({ name, hit: SECRET.test(source) }).toEqual({ name, hit: false })
    }
  })

  test('red direction: a pasted bearer is caught', () => {
    expect(SECRET.test('authorization: Bearer abcd1234efgh5678ijkl')).toBe(true)
  })

  /**
   * The AC-2 acceptance script and its helpers are held to the same rule.
   *
   * They are the artefacts most likely to acquire a pasted secret — somebody
   * gets tired of exporting five variables and "just for now" inlines the
   * bearer. That bearer is the one with no privilege tiers, so a commit like
   * that publishes the ability to destroy the sandbox to everyone with read
   * access. The rule is the same one three tests up; only the file list is new.
   */
  const demoArtifacts = [
    'demo/ac2-wake-forward.sh',
    'demo/lib/ac2-activator.ts',
    'demo/lib/ac2-env.ts',
    'demo/lib/ac2-report.ts',
    'demo/lib/ac2-send.ts',
    'demo/lib/ac2-state.ts',
    'demo/lib/ac2-target.ts',
    'demo/p31-resident-wake.sh',
    'demo/lib/p31-copy-resident-timings.ts',
    'demo/lib/p31-report-core.ts',
    'demo/lib/p31-report.ts',
    'demo/lib/p31-send.ts',
    'demo/ac6a-sandbox.sh',
    'demo/lib/ac6a-sandbox.ts',
    'scripts/qianmo-programming-tasks.ts',
  ]

  test('the sandbox daemon demo artefacts all exist to be scanned', () => {
    // Same guard as the one at the top of this file: a rename must not turn
    // this into a scan of nothing.
    const missing = demoArtifacts.filter(
      path => !existsSync(join(REPO_ROOT, path)),
    )
    expect(missing).toEqual([])
  })

  test.each(demoArtifacts)('%s contains no literal credential', path => {
    const source = readFileSync(join(REPO_ROOT, path), 'utf8')
    expect({ path, hit: SECRET.test(source) }).toEqual({ path, hit: false })
  })

  test('every source file carries the two-line copyright header', () => {
    for (const name of sourceFiles()) {
      const head = readFileSync(join(SRC_DIR, name), 'utf8')
        .split('\n')
        .slice(0, 2)
      expect(head[0]).toBe('// Copyright 2026 Qianmo AgentNest Team')
      expect(head[1]).toBe('// SPDX-License-Identifier: AGPL-3.0-or-later')
    }
  })
})
