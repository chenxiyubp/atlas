// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  MIN_TOKEN_LENGTH,
  bearerOf,
  isLoopbackHostname,
  presentedTokenOf,
  resolveTokens,
  roleOf,
  type ConsoleTokens,
} from '../src/auth.js'

const VIEW = 'view-token-000000000001'
const ADMIN = 'admin-token-00000000001'
const TOKENS: ConsoleTokens = { view: VIEW, admin: ADMIN }

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

function withBearer(token: string): Request {
  return request('http://127.0.0.1/v0/agents', {
    authorization: `Bearer ${token}`,
  })
}

/** A generator whose output is predictable, so the rules stay testable. */
function counter(prefix = 'generated-token-'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

describe('bearerOf', () => {
  test('reads the Bearer value', () => {
    expect(bearerOf(withBearer(VIEW))).toBe(VIEW)
  })

  test('is empty without a header', () => {
    expect(bearerOf(request('http://127.0.0.1/'))).toBe('')
  })

  test('ignores a non-Bearer scheme', () => {
    const req = request('http://127.0.0.1/', { authorization: `Basic ${VIEW}` })
    expect(bearerOf(req)).toBe('')
  })
})

describe('presentedTokenOf', () => {
  test('falls back to the query string, which is how a browser arrives', () => {
    const req = request(`http://127.0.0.1/?token=${VIEW}`)
    expect(bearerOf(req)).toBe('')
    expect(presentedTokenOf(req)).toBe(VIEW)
  })

  test('prefers the header when both are present', () => {
    const req = request(`http://127.0.0.1/?token=${VIEW}`, {
      authorization: `Bearer ${ADMIN}`,
    })
    expect(presentedTokenOf(req)).toBe(ADMIN)
  })

  test('is empty when neither is present', () => {
    expect(presentedTokenOf(request('http://127.0.0.1/'))).toBe('')
  })
})

describe('roleOf', () => {
  test('the admin token is admin', () => {
    expect(roleOf(withBearer(ADMIN), TOKENS)).toBe('admin')
  })

  test('the view token is view', () => {
    expect(roleOf(withBearer(VIEW), TOKENS)).toBe('view')
  })

  test('an unknown token is none', () => {
    expect(roleOf(withBearer('nope-nope-nope-nope'), TOKENS)).toBe('none')
  })

  test('no credential is none', () => {
    expect(roleOf(request('http://127.0.0.1/'), TOKENS)).toBe('none')
  })

  test('an empty token never matches an empty expectation', () => {
    const empty: ConsoleTokens = { view: '', admin: '' }
    expect(roleOf(request('http://127.0.0.1/?token='), empty)).toBe('none')
    expect(roleOf(withBearer(''), empty)).toBe('none')
  })

  test('a prefix of the real token does not match', () => {
    expect(roleOf(withBearer(VIEW.slice(0, -1)), TOKENS)).toBe('none')
  })

  test('the query string carries the role too', () => {
    const req = request(`http://127.0.0.1/?token=${ADMIN}`)
    expect(roleOf(req, TOKENS)).toBe('admin')
  })
})

describe('isLoopbackHostname', () => {
  test.each([
    '127.0.0.1',
    '127.1.2.3',
    'localhost',
    'LOCALHOST',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
  ])('%s is loopback', hostname => {
    expect(isLoopbackHostname(hostname)).toBe(true)
  })

  test.each([
    '0.0.0.0',
    '192.168.1.5',
    '10.0.0.5',
    'console.example.com',
    '',
  ])('%s is not loopback', hostname => {
    expect(isLoopbackHostname(hostname)).toBe(false)
  })
})

describe('resolveTokens', () => {
  test('rule 1: loopback with nothing supplied generates both', () => {
    const tokens = resolveTokens({
      hostname: '127.0.0.1',
      generate: counter(),
    })
    expect(tokens.view).toBe('generated-token-1')
    expect(tokens.admin).toBe('generated-token-2')
  })

  test('rule 1: only the missing half is generated', () => {
    const tokens = resolveTokens({
      view: VIEW,
      hostname: 'localhost',
      generate: counter(),
    })
    expect(tokens.view).toBe(VIEW)
    expect(tokens.admin).toBe('generated-token-1')
  })

  test('rule 2: a non-loopback bind without tokens refuses to start', () => {
    expect(() =>
      resolveTokens({ hostname: '0.0.0.0', generate: counter() }),
    ).toThrow(/非环回地址/)
  })

  test('rule 2: supplying only one of the two is still a refusal', () => {
    expect(() =>
      resolveTokens({ view: VIEW, hostname: '0.0.0.0', generate: counter() }),
    ).toThrow(/admin token/)
    expect(() =>
      resolveTokens({
        admin: ADMIN,
        hostname: '10.0.0.5',
        generate: counter(),
      }),
    ).toThrow(/view token/)
  })

  test('rule 2: an explicit pair binds anywhere', () => {
    const tokens = resolveTokens({
      view: VIEW,
      admin: ADMIN,
      hostname: '10.0.0.5',
      generate: () => {
        throw new Error('generate must not be called off loopback')
      },
    })
    expect(tokens).toEqual({ view: VIEW, admin: ADMIN })
  })

  test('rule 3: a short token is refused', () => {
    const short = 'x'.repeat(MIN_TOKEN_LENGTH - 1)
    expect(() =>
      resolveTokens({
        view: short,
        admin: ADMIN,
        hostname: '127.0.0.1',
        generate: counter(),
      }),
    ).toThrow(new RegExp(`${MIN_TOKEN_LENGTH}`))
  })

  test('rule 3: identical tokens are refused', () => {
    expect(() =>
      resolveTokens({
        view: VIEW,
        admin: VIEW,
        hostname: '127.0.0.1',
        generate: counter(),
      }),
    ).toThrow(/必须不同/)
  })

  test('rule 3 also applies to what generate returns', () => {
    expect(() =>
      resolveTokens({
        hostname: '127.0.0.1',
        generate: () => 'same-token-00001',
      }),
    ).toThrow(/必须不同/)
    expect(() =>
      resolveTokens({ hostname: '127.0.0.1', generate: () => 'short' }),
    ).toThrow(new RegExp(`${MIN_TOKEN_LENGTH}`))
  })

  test('an empty string counts as not supplied off loopback', () => {
    expect(() =>
      resolveTokens({
        view: '',
        admin: ADMIN,
        hostname: '10.0.0.5',
        generate: counter(),
      }),
    ).toThrow(/view token/)
  })
})
