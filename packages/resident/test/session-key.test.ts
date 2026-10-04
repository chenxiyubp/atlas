// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  agentOfSessionKey,
  contextOfSessionKey,
  DEFAULT_CONTEXT,
  isSessionKey,
  SESSION_KEY_SEPARATOR,
  sessionKeyOf,
} from '../src/session-key.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SELF = resolve(import.meta.dir, 'session-key.test.ts')

/**
 * Shapes that would be a second place a `(agent, contextId)` key is spelled.
 * Deliberately written against identifier NAMES rather than the separator
 * alone: `${host}:${port}` is everywhere in this repo and is not this bug.
 */
const HAND_ROLLED_KEY_PATTERNS: readonly RegExp[] = [
  /\$\{\s*\w*[aA]gent\w*\s*\}[^\w\s{}]{0,3}\$\{\s*\w*[cC]ontext\w*\s*\}/,
  /\b\w*[aA]gent\w*\s*\+\s*['"][^'"]{0,3}['"]\s*\+\s*\w*[cC]ontext\w*/,
  /\[\s*\w*[aA]gent\w*\s*,\s*\w*[cC]ontext\w*\s*\]\s*\.join\s*\(/,
]

async function repositorySources(): Promise<readonly string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const files: string[] = []
  for (const root of ['src', 'packages']) {
    for await (const file of glob.scan({
      cwd: join(REPO_ROOT, root),
      absolute: true,
    })) {
      // Vendored trees and the decompiled Ink fork are not ours to police.
      if (file.includes('/node_modules/')) continue
      if (file.includes('/packages/@ant/')) continue
      if (file === SELF) continue
      files.push(file)
    }
  }
  return files
}

describe('resident session key', () => {
  test('falls back to the default context and keeps agents apart', () => {
    expect(sessionKeyOf('reviewer')).toBe(
      `reviewer${SESSION_KEY_SEPARATOR}${DEFAULT_CONTEXT}`,
    )
    expect(sessionKeyOf('reviewer', undefined)).toBe(sessionKeyOf('reviewer'))
    expect(sessionKeyOf('reviewer', '')).toBe(sessionKeyOf('reviewer'))
    expect(sessionKeyOf('reviewer', DEFAULT_CONTEXT)).toBe(
      sessionKeyOf('reviewer'),
    )
    expect(sessionKeyOf('reviewer', 'alice')).not.toBe(
      sessionKeyOf('planner', 'alice'),
    )
    expect(sessionKeyOf('reviewer', 'alice')).not.toBe(
      sessionKeyOf('reviewer', 'bob'),
    )
    expect(() => sessionKeyOf('../escape', 'alice')).toThrow('agent is invalid')
  })

  test('a context carrying the separator still splits at the agent boundary', () => {
    // An agent segment cannot contain the separator, so the FIRST one is
    // always the boundary — even when the remote picked a hostile contextId.
    const key = sessionKeyOf('reviewer', 'tenant:7:thread')
    expect(agentOfSessionKey(key)).toBe('reviewer')
    expect(contextOfSessionKey(key)).toBe('tenant:7:thread')
    expect(isSessionKey(key)).toBe(true)
  })

  test('an unbounded or unprintable context is digested, not collapsed', () => {
    const long = 'a'.repeat(5_000)
    const digested = sessionKeyOf('reviewer', long)
    const digest = createHash('sha256')
      .update(long, 'utf8')
      .digest('hex')
      .slice(0, 32)

    expect(digested).toBe(`reviewer${SESSION_KEY_SEPARATOR}#${digest}`)
    expect(isSessionKey(digested)).toBe(true)
    // Digesting must stay injective: collapsing two contexts into one key is
    // the very bleed this module exists to prevent.
    expect(digested).not.toBe(sessionKeyOf('reviewer', `${long}x`))
    expect(sessionKeyOf('reviewer', 'a\nb')).not.toBe(
      sessionKeyOf('reviewer', 'a\tb'),
    )
    expect(agentOfSessionKey(digested)).toBe('reviewer')
  })

  test('rejects things that are not session keys', () => {
    expect(isSessionKey('reviewer')).toBe(false)
    expect(isSessionKey('../escape:alice')).toBe(false)
    expect(isSessionKey('reviewer:')).toBe(false)
    expect(isSessionKey('reviewer:a\nb')).toBe(false)
    expect(isSessionKey(7)).toBe(false)
    expect(agentOfSessionKey('reviewer')).toBeUndefined()
    expect(contextOfSessionKey('reviewer')).toBeUndefined()
  })

  test('sessionKeyOf is the only place in the repository that builds the key', async () => {
    // Positive control first: a scan that cannot see the shape it is looking
    // for would pass forever and prove nothing.
    const bait = [
      'const key = `${agent}:${contextId}`',
      "const key = agent + ':' + contextId",
      "const key = [agent, contextId].join(':')",
    ]
    for (const [index, sample] of bait.entries()) {
      expect(HAND_ROLLED_KEY_PATTERNS[index]?.test(sample)).toBe(true)
    }

    const files = await repositorySources()
    expect(files.length).toBeGreaterThan(1_000)

    const offenders: string[] = []
    let definitions = 0
    let separators = 0
    for (const file of files) {
      const source = await Bun.file(file).text()
      if (source.includes('export function sessionKeyOf')) definitions++
      if (source.includes('export const SESSION_KEY_SEPARATOR')) separators++
      if (HAND_ROLLED_KEY_PATTERNS.some(pattern => pattern.test(source))) {
        offenders.push(file.slice(REPO_ROOT.length + 1))
      }
    }

    expect(offenders).toEqual([])
    expect(definitions).toBe(1)
    expect(separators).toBe(1)
  })
})
