// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  errorResponse,
  isSecretFingerprint,
  parseProviderRequest,
  parseSecretSlotKey,
  PROTOCOL_LIMITS,
  PROVIDER_ERROR_CODES,
  PROVIDER_OPS,
  type ParsedRequest,
  type ProviderErrorCode,
  secretFingerprint,
  secretSlotKey,
  shortFingerprint,
} from '../src/index.js'
import {
  applyRequestJson,
  CANARY_KEY,
  V1_CAPABILITIES,
  wireProfileJson,
} from './fixtures.js'

const NODE = {
  node: 'beta-1',
  capabilities: V1_CAPABILITIES,
  now: new Date('2026-10-03T00:00:00Z'),
}

function codeOf(result: ParsedRequest): ProviderErrorCode | 'ok' {
  return result.ok ? 'ok' : result.error.code
}

describe('schema v1 closure (§2.5)', () => {
  test('operations are exactly status / probe / models / apply', () => {
    expect([...PROVIDER_OPS]).toEqual(['status', 'probe', 'models', 'apply'])
  })

  test('error codes are the §2.5 set plus unsupported-multi-key', () => {
    expect([...PROVIDER_ERROR_CODES].sort() as string[]).toEqual(
      [
        'bad-request',
        'version-skew',
        'unsupported-op',
        'node-mismatch',
        'unknown-key',
        'bad-value',
        'effort-unsendable',
        'retired-model',
        'secret-mismatch',
        'unsupported-multi-key',
        'conflict',
        'busy',
        'write-failed',
        'probe-failed',
      ].sort(),
    )
  })

  test('a well-formed apply parses with defaults filled', () => {
    const {
      recycle: _r,
      dryRun: _d,
      force: _f,
      ...minimal
    } = applyRequestJson()
    const parsed = parseProviderRequest(JSON.stringify(minimal), NODE)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
    expect(parsed.request.op).toBe('apply')
    if (parsed.request.op !== 'apply') return
    expect(parsed.request.recycle.sessions).toBe('reset')
    expect(parsed.request.dryRun).toBe(false)
    expect(parsed.request.force).toBe(false)
  })

  test('over 64 KiB is refused before parsing', () => {
    const big =
      JSON.stringify(applyRequestJson()) +
      ' '.repeat(PROTOCOL_LIMITS.maxRequestBytes)
    expect(codeOf(parseProviderRequest(big, NODE))).toBe('bad-request')
  })

  test('each refusal maps to its code', () => {
    expect(codeOf(parseProviderRequest('{nope', NODE))).toBe('bad-request')
    expect(codeOf(parseProviderRequest(applyRequestJson({ v: 2 }), NODE))).toBe(
      'version-skew',
    )
    expect(
      codeOf(parseProviderRequest(applyRequestJson({ op: 'exec' }), NODE)),
    ).toBe('unsupported-op')
    expect(
      codeOf(parseProviderRequest(applyRequestJson({ node: 'beta-2' }), NODE)),
    ).toBe('node-mismatch')
    expect(
      codeOf(parseProviderRequest(applyRequestJson({ command: 'id' }), NODE)),
    ).toBe('bad-request')
    expect(
      codeOf(
        parseProviderRequest(applyRequestJson({ expect: undefined }), NODE),
      ),
    ).toBe('bad-request')
    expect(
      codeOf(
        parseProviderRequest(
          applyRequestJson({ expect: { ownedHash: 'abc' } }),
          NODE,
        ),
      ),
    ).toBe('bad-value')
    expect(
      codeOf(
        parseProviderRequest(
          applyRequestJson({
            profile: wireProfileJson({ compat: { PATH: '/x' } }),
          }),
          NODE,
        ),
      ),
    ).toBe('unknown-key')
    expect(
      codeOf(
        parseProviderRequest(
          applyRequestJson({ recycle: { sessions: 'drop' } }),
          NODE,
        ),
      ),
    ).toBe('bad-value')
  })

  test('status takes nothing but the envelope', () => {
    const status = {
      v: 1,
      op: 'status',
      requestId: '01JB0000000000000000000002',
      node: 'beta-1',
    }
    expect(codeOf(parseProviderRequest(status, NODE))).toBe('ok')
    expect(
      codeOf(
        parseProviderRequest({ ...status, profile: wireProfileJson() }, NODE),
      ),
    ).toBe('bad-request')
  })

  test('probe needs a mode from the closed set', () => {
    const probe = {
      v: 1,
      op: 'probe',
      requestId: '01JB0000000000000000000003',
      node: 'beta-1',
      profile: wireProfileJson(),
    }
    expect(
      codeOf(parseProviderRequest({ ...probe, probe: { mode: 'call' } }, NODE)),
    ).toBe('ok')
    expect(
      codeOf(
        parseProviderRequest({ ...probe, probe: { mode: 'shell' } }, NODE),
      ),
    ).toBe('bad-value')
  })
})

describe('multi-key on a v1 node', () => {
  const twoKeys = wireProfileJson({
    auth: {
      scheme: 'bearer',
      keys: [
        { id: 'k1', value: CANARY_KEY },
        { id: 'k2', value: `${CANARY_KEY}2` },
      ],
    },
  })

  test('more than one key is refused by name, not silently truncated', () => {
    expect(
      codeOf(
        parseProviderRequest(applyRequestJson({ profile: twoKeys }), NODE),
      ),
    ).toBe('unsupported-multi-key')
  })

  test('a node that reports multiKey accepts the same request', () => {
    expect(
      codeOf(
        parseProviderRequest(applyRequestJson({ profile: twoKeys }), {
          ...NODE,
          capabilities: { ...V1_CAPABILITIES, multiKey: true },
        }),
      ),
    ).toBe('ok')
  })
})

describe('responses never echo values', () => {
  test('error responses built from any refusal contain no key material', () => {
    const cases = [
      applyRequestJson({ v: 2 }),
      applyRequestJson({ node: 'beta-9' }),
      applyRequestJson({
        profile: wireProfileJson({ compat: { LD_PRELOAD: CANARY_KEY } }),
      }),
      applyRequestJson({ profile: wireProfileJson({ lane: 'gemini' }) }),
      applyRequestJson({
        profile: wireProfileJson({
          auth: {
            scheme: 'bearer',
            keys: [
              { id: 'k1', value: CANARY_KEY },
              { id: 'k2', value: CANARY_KEY },
            ],
          },
        }),
      }),
    ]
    for (const request of cases) {
      const parsed = parseProviderRequest(JSON.stringify(request), NODE)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      const response = errorResponse(parsed.requestId, parsed.error)
      expect(JSON.stringify(response)).not.toContain(CANARY_KEY)
      expect(JSON.stringify(response)).not.toContain('sk-test-canary')
    }
  })
})

describe('fingerprints and secret references', () => {
  test('deterministic, distinct per key, and no run of the key appears in it', () => {
    const fp = secretFingerprint(CANARY_KEY)
    expect(fp).toBe(secretFingerprint(CANARY_KEY))
    expect(fp).not.toBe(secretFingerprint(`${CANARY_KEY}x`))
    expect(isSecretFingerprint(fp)).toBe(true)
    for (let i = 0; i + 4 <= CANARY_KEY.length; i += 1) {
      expect(fp).not.toContain(CANARY_KEY.slice(i, i + 4))
    }
    expect(shortFingerprint(fp)).toMatch(/^[0-9a-f]{8}$/)
  })

  test('profileId + keyId round-trips through the slot key', () => {
    const slot = secretSlotKey({ profileId: 'deepseek-paygo', keyId: 'k1' })
    expect(slot).toBe('deepseek-paygo:k1')
    expect(parseSecretSlotKey(slot)).toEqual({
      profileId: 'deepseek-paygo',
      keyId: 'k1',
    })
    expect(parseSecretSlotKey('a:b:c')).toBeNull()
    expect(() => secretSlotKey({ profileId: 'Bad Id', keyId: 'k1' })).toThrow()
  })
})
