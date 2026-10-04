// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  AUTHZ_DECISION_DOMAIN,
  AUTHZ_REQUEST_DOMAIN,
  MAX_AUTHZ_WINDOW_MS,
  authzDigest,
  generateNodeKeyPair,
  isAuthzRequest,
  parseApprover,
  parseAuthzDecision,
  signAuthzDecision,
  signAuthzRequest,
  signBytes,
  verifyAuthzDecisionSignature,
  verifyAuthzRequest,
  type AuthzDecision,
  type AuthzRequest,
} from '../src/index.js'
import { NOW } from './helpers.js'

const consoleKeys = generateNodeKeyPair()
const nodeKeys = generateNodeKeyPair()
const SUBJECT = 'u:7f3a0c1d2e4b5a69'

function call(toolName: string, input: Record<string, unknown>) {
  return { node: 'beta-4', agent: 'main', contextId: 'ctx-1', toolName, input }
}

function request(overrides: Partial<AuthzRequest> = {}): AuthzRequest {
  const input = overrides.input ?? { command: 'touch /tmp/x', description: 'x' }
  const toolName = overrides.toolName ?? 'Bash'
  return {
    v: 1,
    requestId: '0123456789abcdef0123456789abcdef',
    iss: 'beta-4',
    sub: 'qianmo://beta-4/main',
    contextId: 'ctx-1',
    toolName,
    input,
    digest: authzDigest(call(toolName, input)),
    origin: { from: null, taskId: null, traceId: null, trust: 'untrusted' },
    iat: NOW,
    exp: NOW + 600_000,
    ...overrides,
  }
}

function decision(overrides: Partial<AuthzDecision> = {}): AuthzDecision {
  return {
    v: 1,
    requestId: '0123456789abcdef0123456789abcdef',
    aud: 'beta-4',
    sub: 'qianmo://beta-4/main',
    digest: 'a'.repeat(64),
    decision: 'allow-once',
    windowMs: 0,
    approver: `hub/${SUBJECT}`,
    nbf: NOW,
    exp: NOW + 60_000,
    nonce: 'n0nce-0123456789abcdef',
    ...overrides,
  }
}

/** A wire whose payload is `value` verbatim and whose signature is `signature`. */
function wire(value: unknown, signature = 'A'.repeat(86)): string {
  return `${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}.${signature}`
}

describe('closed fields', () => {
  test('a decision round-trips when it has exactly its eleven keys', () => {
    const parts = parseAuthzDecision(signAuthzDecision(consoleKeys, decision()))
    expect(parts?.value).toEqual(decision())
  })

  test('one extra key on a decision is refused, signed or not', () => {
    const extra = { ...decision(), tenant: 'acme' }
    expect(parseAuthzDecision(wire(extra))).toBeNull()
    expect(() =>
      signAuthzDecision(consoleKeys, extra as unknown as AuthzDecision),
    ).toThrow(/malformed/)
  })

  test('one missing key on a decision is refused', () => {
    const { nonce: _nonce, ...missing } = decision()
    expect(parseAuthzDecision(wire(missing))).toBeNull()
  })

  test('one extra key on a request, or on its origin, is refused', () => {
    expect(isAuthzRequest(request())).toBe(true)
    expect(isAuthzRequest({ ...request(), note: 'hi' })).toBe(false)
    expect(
      isAuthzRequest({
        ...request(),
        origin: { ...request().origin, caller: 'x' },
      }),
    ).toBe(false)
  })

  test('the window rules are part of the structure', () => {
    const window = (windowMs: number) =>
      parseAuthzDecision(wire(decision({ decision: 'allow-window', windowMs })))
    expect(window(MAX_AUTHZ_WINDOW_MS)).not.toBeNull()
    expect(window(MAX_AUTHZ_WINDOW_MS + 1)).toBeNull()
    expect(window(0)).toBeNull()
    expect(parseAuthzDecision(wire(decision({ windowMs: 1000 })))).toBeNull()
    expect(
      parseAuthzDecision(wire(decision({ decision: 'deny', windowMs: 1 }))),
    ).toBeNull()
  })

  test('a request whose subject is not on its issuer is refused', () => {
    expect(isAuthzRequest(request({ sub: 'qianmo://beta-1/main' }))).toBe(false)
  })
})

describe('the two signing domains do not accept each other', () => {
  test('a decision signed in its own domain verifies', () => {
    const parts = parseAuthzDecision(signAuthzDecision(consoleKeys, decision()))
    expect(parts).not.toBeNull()
    if (parts === null) return
    expect(verifyAuthzDecisionSignature(parts, consoleKeys.publicKey)).toBe(
      true,
    )
  })

  test('the same decision bytes signed in the request domain do not', () => {
    const signed =
      signAuthzDecision(consoleKeys, decision()).split('.')[0] ?? ''
    for (const prefix of [
      `${AUTHZ_REQUEST_DOMAIN}\n`,
      // A capability token signs its claims segment with no prefix at all.
      '',
      // The transport handshake domain (`HANDSHAKE_SIGNATURE_DOMAIN`).
      'qianmo-handshake-v1\n',
    ]) {
      const forged = `${signed}.${signBytes(consoleKeys, `${prefix}${signed}`)}`
      const parts = parseAuthzDecision(forged)
      expect(parts).not.toBeNull()
      if (parts === null) continue
      expect(verifyAuthzDecisionSignature(parts, consoleKeys.publicKey)).toBe(
        false,
      )
    }
  })

  test('a request signed in its own domain verifies, the decision domain does not', () => {
    const good = signAuthzRequest(nodeKeys, request())
    expect(verifyAuthzRequest(good, nodeKeys.publicKey)).toEqual(request())
    const signed = good.split('.')[0] ?? ''
    const crossed = `${signed}.${signBytes(nodeKeys, `${AUTHZ_DECISION_DOMAIN}\n${signed}`)}`
    expect(verifyAuthzRequest(crossed, nodeKeys.publicKey)).toBeNull()
  })

  test('a request is refused under a key that is not its issuer’s', () => {
    const good = signAuthzRequest(nodeKeys, request())
    expect(verifyAuthzRequest(good, consoleKeys.publicKey)).toBeNull()
  })

  test('a request whose input no longer matches its digest is refused', () => {
    // Signed by the right key, but what the approver would be shown is not
    // what the decision would bind to.
    const tampered = request({
      input: { command: 'rm -rf /', description: 'x' },
    })
    const forged = signAuthzRequest(nodeKeys, {
      ...tampered,
      digest: request().digest,
    })
    expect(verifyAuthzRequest(forged, nodeKeys.publicKey)).toBeNull()
  })
})

describe('approver identity (tenancy-m1.md §3.5)', () => {
  test('a console-vouched P15 subject parses', () => {
    expect(parseApprover(`hub/${SUBJECT}`)).toEqual({
      ok: true,
      console: 'hub',
      subject: SUBJECT,
    })
  })

  test('legacy principals never approve, break-glass admin included', () => {
    for (const value of [
      'hub/legacy:admin',
      'hub/legacy:view',
      'legacy:admin',
      'legacy:view',
    ]) {
      expect(parseApprover(value)).toEqual({ ok: false, reason: 'legacy' })
    }
  })

  test('anything off the P15 shape is malformed', () => {
    for (const value of [
      SUBJECT,
      'hub/u:7F3A0C1D2E4B5A69',
      'hub/u:7f3a0c1d2e4b5a6',
      'hub/u:7f3a0c1d2e4b5a69/x',
      '/u:7f3a0c1d2e4b5a69',
      'Hub/u:7f3a0c1d2e4b5a69',
      42,
    ]) {
      expect(parseApprover(value)).toEqual({ ok: false, reason: 'malformed' })
    }
  })
})

describe('the digest follows the §3.4 projection, one case per tool', () => {
  const digest = (toolName: string, input: Record<string, unknown>) =>
    authzDigest(call(toolName, input))

  test('Bash: description and key order do not matter, the command does', () => {
    const base = digest('Bash', {
      command: 'git push origin main',
      description: 'Push',
      run_in_background: false,
    })
    expect(
      digest('Bash', {
        description: 'Push the branch',
        command: 'git push origin main',
      }),
    ).toBe(base)
    expect(digest('Bash', { command: 'git push origin dev' })).not.toBe(base)
    expect(
      digest('Bash', {
        command: 'git push origin main',
        run_in_background: true,
      }),
    ).not.toBe(base)
  })

  test('Write: key order does not matter, a different body does', () => {
    const base = digest('Write', { file_path: '/w/a.txt', content: 'one' })
    expect(digest('Write', { content: 'one', file_path: '/w/a.txt' })).toBe(
      base,
    )
    expect(digest('Write', { file_path: '/w/a.txt', content: 'two' })).not.toBe(
      base,
    )
  })

  test('Edit: key order and an absent replace_all do not matter', () => {
    const base = digest('Edit', {
      file_path: '/w/a.txt',
      old_string: 'a',
      new_string: 'b',
      replace_all: false,
    })
    expect(
      digest('Edit', {
        new_string: 'b',
        old_string: 'a',
        file_path: '/w/a.txt',
      }),
    ).toBe(base)
    expect(
      digest('Edit', {
        file_path: '/w/a.txt',
        old_string: 'a',
        new_string: 'b',
        replace_all: true,
      }),
    ).not.toBe(base)
  })

  test('Read: key order does not matter, the range does', () => {
    const base = digest('Read', { file_path: '/w/a.txt', offset: 1, limit: 5 })
    expect(digest('Read', { limit: 5, offset: 1, file_path: '/w/a.txt' })).toBe(
      base,
    )
    expect(
      digest('Read', { file_path: '/w/a.txt', offset: 2, limit: 5 }),
    ).not.toBe(base)
  })

  test('WebFetch: the prompt and key order do not matter, the URL does', () => {
    const base = digest('WebFetch', {
      url: 'https://example.com/a',
      prompt: 'summarize',
    })
    expect(
      digest('WebFetch', {
        prompt: 'list the links',
        url: 'https://example.com/a',
      }),
    ).toBe(base)
    expect(
      digest('WebFetch', { url: 'https://example.com/b', prompt: 'summarize' }),
    ).not.toBe(base)
  })

  test('ExecuteExtraTool: the target is projected by its own rule', () => {
    const base = digest('ExecuteExtraTool', {
      tool_name: 'Bash',
      params: { command: 'ls /', description: 'List' },
    })
    expect(
      digest('ExecuteExtraTool', {
        params: { description: 'List the root', command: 'ls /' },
        tool_name: 'Bash',
      }),
    ).toBe(base)
    expect(
      digest('ExecuteExtraTool', {
        tool_name: 'Bash',
        params: { command: 'ls /etc', description: 'List' },
      }),
    ).not.toBe(base)
    expect(
      digest('ExecuteExtraTool', {
        tool_name: 'Monitor',
        params: { command: 'ls /', description: 'List' },
      }),
    ).not.toBe(base)
  })

  test('any other tool: canonical whole input, so only key order is free', () => {
    const base = digest('CronCreate', {
      cron: '* * * * *',
      prompt: 'check',
      recurring: true,
    })
    expect(
      digest('CronCreate', {
        recurring: true,
        prompt: 'check',
        cron: '* * * * *',
      }),
    ).toBe(base)
    expect(
      digest('CronCreate', {
        cron: '* * * * *',
        prompt: 'check again',
        recurring: true,
      }),
    ).not.toBe(base)
  })

  test('the node, agent, context and tool name are all bound', () => {
    const input = { command: 'ls' }
    const base = authzDigest(call('Bash', input))
    for (const changed of [
      { ...call('Bash', input), node: 'beta-1' },
      { ...call('Bash', input), agent: 'other' },
      { ...call('Bash', input), contextId: 'ctx-2' },
      { ...call('Bash', input), toolName: 'PowerShell' },
    ]) {
      expect(authzDigest(changed)).not.toBe(base)
    }
  })
})
