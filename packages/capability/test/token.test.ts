// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  CapabilityLevel,
  ProtocolErrorCode,
  encodeClaims,
  parseCapabilityToken,
} from '@qianmo/protocol'
import {
  NonceStore,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  issueCapability,
  signBytes,
  verifyBytes,
  verifyCapability,
} from '../src/index.js'
import { NODE_A, NODE_B, NODE_C, NOW, REVIEWER, party } from './helpers.js'

function verifyContext(options: {
  readonly node?: string
  readonly handler?: string
  readonly taskId?: string
  readonly now?: number
  readonly directory: StaticPublicKeyDirectory
  readonly nonces?: NonceStore
}) {
  return {
    node: options.node ?? NODE_B,
    handler: options.handler ?? REVIEWER,
    taskId: options.taskId ?? 'task-1',
    now: options.now ?? NOW,
    directory: options.directory,
    nonces: options.nonces ?? new NonceStore(),
  }
}

describe('keys', () => {
  test('a fresh pair signs and verifies its own bytes', () => {
    const keys = generateNodeKeyPair()
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const signature = signBytes(keys, 'payload')
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(verifyBytes(keys.publicKey, 'payload', signature)).toBe(true)
    expect(verifyBytes(keys.publicKey, 'payload!', signature)).toBe(false)
  })

  test('another node’s key does not verify', () => {
    const mine = generateNodeKeyPair()
    const theirs = generateNodeKeyPair()
    const signature = signBytes(mine, 'payload')
    expect(verifyBytes(theirs.publicKey, 'payload', signature)).toBe(false)
  })

  test('garbage inputs are false, not exceptions', () => {
    // This runs on untrusted bytes: a verifier that throws turns "someone sent
    // us nonsense" into an exception at whatever boundary is above it.
    const keys = generateNodeKeyPair()
    expect(
      verifyBytes('not-a-key', 'payload', signBytes(keys, 'payload')),
    ).toBe(false)
    expect(verifyBytes(keys.publicKey, 'payload', 'not-a-signature')).toBe(
      false,
    )
  })
})

describe('a well-formed token', () => {
  test('verifies and returns its claims', () => {
    const issuer = party(NODE_A)
    const directory = new StaticPublicKeyDirectory([
      [issuer.node, issuer.keys.publicKey],
    ])
    const token = issueCapability(issuer.node, issuer.keys, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.WriteLimited,
      taskId: 'task-1',
      nbf: NOW - 1_000,
      exp: NOW + 60_000,
    })
    const result = verifyCapability(token, verifyContext({ directory }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims.iss).toBe(NODE_A)
    expect(result.claims.act).toBe(CapabilityLevel.WriteLimited)
  })

  test('an exp that precedes nbf is refused at issue time', () => {
    const issuer = party(NODE_A)
    expect(() =>
      issueCapability(issuer.node, issuer.keys, {
        sub: REVIEWER,
        aud: NODE_B,
        act: CapabilityLevel.Read,
        taskId: 'task-1',
        nbf: NOW,
        exp: NOW - 1,
      }),
    ).toThrow(RangeError)
  })
})

describe('bindings — what stops a token being reused elsewhere', () => {
  const issuer = party(NODE_A)
  const directory = new StaticPublicKeyDirectory([
    [issuer.node, issuer.keys.publicKey],
  ])
  const token = issueCapability(issuer.node, issuer.keys, {
    sub: REVIEWER,
    aud: NODE_B,
    act: CapabilityLevel.WriteLimited,
    taskId: 'task-1',
    nbf: NOW - 1_000,
    exp: NOW + 60_000,
  })

  test('replaying it at a third node fails on aud', () => {
    const result = verifyCapability(
      token,
      verifyContext({ directory, node: NODE_C }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(ProtocolErrorCode.E_CAP_INVALID)
    expect(result.reason).toContain('audience')
  })

  test('presenting it for another handler fails on sub', () => {
    const result = verifyCapability(
      token,
      verifyContext({ directory, handler: `qianmo://${NODE_B}/other` }),
    )
    expect(result.ok).toBe(false)
  })

  test('presenting it for another task fails on taskId', () => {
    // There are no general-purpose tokens: one authorization, one task.
    const result = verifyCapability(
      token,
      verifyContext({ directory, taskId: 'task-2' }),
    )
    expect(result.ok).toBe(false)
  })

  test('before nbf and after exp both fail', () => {
    expect(
      verifyCapability(token, verifyContext({ directory, now: NOW - 5_000 }))
        .ok,
    ).toBe(false)
    expect(
      verifyCapability(token, verifyContext({ directory, now: NOW + 61_000 }))
        .ok,
    ).toBe(false)
  })

  test('expiry is not extended by anything — no time-jump grace here', () => {
    // Rule T-2 keeps a thawed node from declaring deliveries dead. Extending an
    // *authorization* the same way would be the wrong direction of failure, so
    // this check has no gate and this test says so.
    const result = verifyCapability(
      token,
      verifyContext({ directory, now: NOW + 3_600_000 }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('expired')
  })
})

describe('signature and issuer', () => {
  test('an unknown issuer is refused — there is no trust on first use', () => {
    const issuer = party(NODE_A)
    const token = issueCapability(issuer.node, issuer.keys, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.Read,
      taskId: 'task-1',
      nbf: NOW - 1_000,
      exp: NOW + 60_000,
    })
    const result = verifyCapability(
      token,
      verifyContext({ directory: new StaticPublicKeyDirectory() }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('no published public key')
  })

  test('claims edited after signing no longer verify', () => {
    const issuer = party(NODE_A)
    const directory = new StaticPublicKeyDirectory([
      [issuer.node, issuer.keys.publicKey],
    ])
    const token = issueCapability(issuer.node, issuer.keys, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.Read,
      taskId: 'task-1',
      nbf: NOW - 1_000,
      exp: NOW + 60_000,
    })
    const parts = parseCapabilityToken(token)
    expect(parts).not.toBeNull()
    if (parts === null) return
    // Promote it to write-limited and keep the original signature.
    const escalated = `${encodeClaims({
      ...parts.claims,
      act: CapabilityLevel.WriteLimited,
    })}.${parts.signature}`
    const result = verifyCapability(escalated, verifyContext({ directory }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('signature')
  })

  test('a malformed token is refused rather than parsed optimistically', () => {
    const directory = new StaticPublicKeyDirectory()
    for (const bad of ['', '.', 'abc', 'a.b.c', 'eyJ.short']) {
      expect(verifyCapability(bad, verifyContext({ directory })).ok).toBe(false)
    }
    expect(verifyCapability(undefined, verifyContext({ directory })).ok).toBe(
      false,
    )
  })
})

describe('replay', () => {
  test('the same token twice is refused the second time', () => {
    const issuer = party(NODE_A)
    const directory = new StaticPublicKeyDirectory([
      [issuer.node, issuer.keys.publicKey],
    ])
    const nonces = new NonceStore()
    const token = issueCapability(issuer.node, issuer.keys, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.WriteLimited,
      taskId: 'task-1',
      nbf: NOW - 1_000,
      exp: NOW + 60_000,
    })
    expect(verifyCapability(token, verifyContext({ directory, nonces })).ok) //
      .toBe(true)
    const second = verifyCapability(token, verifyContext({ directory, nonces }))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toContain('nonce')
  })

  test('an unverifiable token cannot burn the nonce of a real one', () => {
    // Consume the nonce before checking the signature and anyone who can guess
    // a nonce can make the legitimate token bounce.
    const issuer = party(NODE_A)
    const attacker = party(NODE_A)
    const directory = new StaticPublicKeyDirectory([
      [issuer.node, issuer.keys.publicKey],
    ])
    const nonces = new NonceStore()
    const real = issueCapability(issuer.node, issuer.keys, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.WriteLimited,
      taskId: 'task-1',
      nbf: NOW - 1_000,
      exp: NOW + 60_000,
      nonce: 'nonce-7',
    })
    // Same claims, signed with the wrong key.
    const forged = issueCapability(issuer.node, attacker.keys, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.WriteLimited,
      taskId: 'task-1',
      nbf: NOW - 1_000,
      exp: NOW + 60_000,
      nonce: 'nonce-7',
    })
    expect(verifyCapability(forged, verifyContext({ directory, nonces })).ok) //
      .toBe(false)
    expect(nonces.size).toBe(0)
    expect(verifyCapability(real, verifyContext({ directory, nonces })).ok) //
      .toBe(true)
  })

  test('nonces are dropped once the token they came with has expired', () => {
    const nonces = new NonceStore()
    expect(nonces.admit(NODE_A, 'n-1', NOW + 1_000, NOW)).toBe(true)
    expect(nonces.admit(NODE_A, 'n-1', NOW + 1_000, NOW + 500)).toBe(false)
    expect(nonces.admit(NODE_A, 'n-1', NOW + 5_000, NOW + 2_000)).toBe(true)
    expect(nonces.size).toBe(1)
  })

  test('two issuers may pick the same nonce', () => {
    const nonces = new NonceStore()
    expect(nonces.admit(NODE_A, 'same', NOW + 1_000, NOW)).toBe(true)
    expect(nonces.admit(NODE_C, 'same', NOW + 1_000, NOW)).toBe(true)
  })
})

describe('the static directory', () => {
  test('one node with two different keys is refused at construction', () => {
    // Silently keeping the last one is the worst outcome available: every
    // check before the signature (`aud` / `sub` / `taskId`, the clock, rule
    // S-1) still passes on the surviving key, so a correctly minted token
    // fails with `signature` and the diagnosis lands on the verifier rather
    // than on the duplicated entry (issue #53).
    const first = generateNodeKeyPair()
    const second = generateNodeKeyPair()
    let thrown: unknown
    try {
      new StaticPublicKeyDirectory([
        [NODE_A, first.publicKey],
        [NODE_A, second.publicKey],
      ])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = thrown instanceof Error ? thrown.message : ''
    expect(message).toContain(NODE_A)
    expect(message).toContain('2 entries')
  })

  test('the same key twice is idempotent, and other nodes are untouched', () => {
    const keys = generateNodeKeyPair()
    const other = generateNodeKeyPair()
    const directory = new StaticPublicKeyDirectory([
      [NODE_A, keys.publicKey],
      [NODE_A, keys.publicKey],
      [NODE_B, other.publicKey],
    ])
    expect(directory.publicKeyOf(NODE_A)).toBe(keys.publicKey)
    expect(directory.publicKeyOf(NODE_B)).toBe(other.publicKey)
    expect(directory.size).toBe(2)
  })

  test('put still replaces — that is the cache refresh path', () => {
    // The constructor is one operator writing one list; `put` is a directory
    // learning that a key changed. Only the first is a contradiction.
    const first = generateNodeKeyPair()
    const second = generateNodeKeyPair()
    const directory = new StaticPublicKeyDirectory([[NODE_A, first.publicKey]])
    directory.put(NODE_A, second.publicKey)
    expect(directory.publicKeyOf(NODE_A)).toBe(second.publicKey)
  })
})
