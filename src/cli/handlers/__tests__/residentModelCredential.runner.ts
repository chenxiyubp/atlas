// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The real credential probe, with no mocks anywhere in the process.
 *
 * Spawned by `residentModelCredential.isolated.test.ts` for the reason the two
 * neighbouring runners give: `mock.module` is process-global and
 * last-write-wins, so any other file in the `src` shard that stubs
 * `src/utils/auth/auth.ts` would replace the exact thing under test — and then
 * "a node with no credential warns" would pass for the wrong reason.
 *
 * Two things are being checked here that the pure-`warnMissingModelCredentials`
 * tests structurally cannot:
 *
 * ① `nodeHasModelCredential()` resolves its lazy `require` at all. That edge is
 *    deliberately invisible to the type checker and to the module graph, which
 *    is exactly why it needs a test that runs it.
 * ② The rule it delegates to is the credential axis, not the protocol axis: a
 *    `CLAUDE_CODE_USE_*` selection counts as a credential even though no
 *    Anthropic key exists, and a bare-mode process with nothing set counts as
 *    none even on a developer machine that is logged in.
 *
 * Hermetic on any machine, and that is not an accident: the wrapper sets
 * `CLAUDE_CODE_SIMPLE=1` (bare mode), under which the auth stack reads only
 * `ANTHROPIC_API_KEY` and the `--settings` apiKeyHelper — never the keychain,
 * the config file or the approval list. Without it this file would answer
 * "logged in" on the author's laptop and "not logged in" on a CI runner.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { nodeHasModelCredential } from '../resident.js'

/** Every key any term of the rule reads. Cleared before each case. */
const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
] as const

const saved = new Map<string, string | undefined>()

function clearCredentials(): void {
  for (const key of CREDENTIAL_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    delete process.env[key]
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

describe('nodeHasModelCredential (isolated)', () => {
  test('answers false when a bare process has nothing configured', () => {
    clearCredentials()
    expect(process.env.CLAUDE_CODE_SIMPLE).toBe('1')
    expect(nodeHasModelCredential()).toBe(false)
  })

  test('a provider selection alone counts, with no Anthropic key in sight', () => {
    // 协议轴与凭据轴在这里分叉：这台机器没有任何 ANTHROPIC_* 键，但会话要走的是
    // 别人家的端点，凭据在别人家的键里。把这一格判成「没凭据」就是对配好的节点
    // 刷告警——那正是让告警被忽略的噪音。
    for (const key of [
      'CLAUDE_CODE_USE_OPENAI',
      'CLAUDE_CODE_USE_GEMINI',
      'CLAUDE_CODE_USE_GROK',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]) {
      clearCredentials()
      process.env[key] = '1'
      expect({ key, credential: nodeHasModelCredential() }).toEqual({
        key,
        credential: true,
      })
    }
  })

  test('an Anthropic key counts', () => {
    clearCredentials()
    process.env.ANTHROPIC_API_KEY = 'fake-for-test-never-sent-anywhere'
    expect(nodeHasModelCredential()).toBe(true)
  })

  test('never throws, whatever the environment holds', () => {
    // The CI / NODE_ENV=test branch of getAnthropicApiKeyWithSource() throws
    // when nothing is configured. A daemon startup check that can throw is
    // worse than no check: it would take the node down over a warning.
    clearCredentials()
    process.env.CLAUDE_CODE_USE_OPENAI = ''
    expect(() => nodeHasModelCredential()).not.toThrow()
    expect(nodeHasModelCredential()).toBe(false)
  })
})
