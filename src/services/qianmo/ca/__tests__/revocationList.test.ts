// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed revocation list (§6.4).
 *
 * The property under test is the one §6.4 leans on when it hands the list to
 * a registry with no authentication at all: the courier can drop it, but
 * cannot change it.
 */

import { describe, expect, test } from 'bun:test'
import { generateNodeKeyPair, signBytes } from '@qianmo/capability'
import {
  REVOCATION_LIST_VALID_MS,
  REVOCATION_LIST_VERSION,
  isRevocationList,
  signRevocationList,
  verifyRevocationList,
  type RevocationList,
} from '../revocationList.js'

const FINGERPRINT =
  '4B:3D:1D:92:68:FB:BF:5C:CB:86:22:CB:9D:89:90:F7:' +
  'D9:70:4C:7D:DD:43:B4:42:90:2A:A9:13:A1:8B:B8:87'

const NOW = 1_760_000_000_000

function list(overrides: Partial<RevocationList> = {}): RevocationList {
  return {
    version: REVOCATION_LIST_VERSION,
    issuedAt: NOW,
    nextUpdate: NOW + REVOCATION_LIST_VALID_MS,
    revoked: [
      {
        node: 'node-a',
        fingerprint256: FINGERPRINT,
        reason: 'private key exposed in a paste',
        at: NOW - 1000,
      },
    ],
    ...overrides,
  }
}

describe('revocation list (§6.4)', () => {
  test('round-trips through sign and verify with the CA key', () => {
    const ca = generateNodeKeyPair()
    const signed = signRevocationList(ca, list())
    expect(verifyRevocationList(ca.publicKey, signed)).toEqual(list())
  })

  test('another CA’s signature does not verify', () => {
    const ca = generateNodeKeyPair()
    const impostor = generateNodeKeyPair()
    const signed = signRevocationList(impostor, list())
    expect(verifyRevocationList(ca.publicKey, signed)).toBeNull()
  })

  test('a tampered payload does not verify — the registry cannot lie', () => {
    const ca = generateNodeKeyPair()
    const signed = signRevocationList(ca, list())

    // Drop the entry: the shape a compromised registry would want, unrevoking
    // a node by rewriting the document it forwards.
    const emptied = Buffer.from(
      JSON.stringify({
        version: REVOCATION_LIST_VERSION,
        issuedAt: NOW,
        nextUpdate: NOW + REVOCATION_LIST_VALID_MS,
        revoked: [],
      }),
      'utf8',
    ).toString('base64url')
    expect(
      verifyRevocationList(ca.publicKey, {
        payload: emptied,
        signature: signed.signature,
      }),
    ).toBeNull()

    // And the other direction: adding an entry to strand a healthy node.
    const flipped = `${signed.payload.slice(0, -1)}${
      signed.payload.endsWith('A') ? 'B' : 'A'
    }`
    expect(
      verifyRevocationList(ca.publicKey, {
        payload: flipped,
        signature: signed.signature,
      }),
    ).toBeNull()
  })

  test('garbage is null rather than an exception', () => {
    const ca = generateNodeKeyPair()
    for (const artefact of [
      null,
      'a string',
      {},
      { payload: 1, signature: 2 },
      { payload: 'not base64url', signature: 'A'.repeat(86) },
    ]) {
      expect(verifyRevocationList(ca.publicKey, artefact)).toBeNull()
    }
  })

  test('a correctly signed but structurally wrong document is refused', () => {
    // Authentic bytes are not the same as a list this version understands.
    const ca = generateNodeKeyPair()
    const payload = Buffer.from(
      JSON.stringify({
        version: 99,
        issuedAt: NOW,
        nextUpdate: NOW + 1,
        revoked: [],
      }),
      'utf8',
    ).toString('base64url')
    expect(
      verifyRevocationList(ca.publicKey, {
        payload,
        signature: signBytes(ca, payload),
      }),
    ).toBeNull()
  })

  test('structural validation is field-closed and bounds the reason', () => {
    expect(isRevocationList(list())).toBe(true)
    expect(isRevocationList({ ...list(), extra: 1 })).toBe(false)
    expect(isRevocationList({ ...list(), nextUpdate: NOW - 1 })).toBe(false)
    expect(
      isRevocationList({
        ...list(),
        revoked: [
          { node: 'node-a', fingerprint256: 'nope', reason: 'x', at: NOW },
        ],
      }),
    ).toBe(false)
    expect(
      isRevocationList({
        ...list(),
        revoked: [
          {
            node: 'node-a',
            fingerprint256: FINGERPRINT,
            reason: 'x'.repeat(201),
            at: NOW,
          },
        ],
      }),
    ).toBe(false)
    expect(
      isRevocationList({
        ...list(),
        revoked: [
          {
            node: 'node-a',
            fingerprint256: FINGERPRINT,
            reason: 'two\nlines',
            at: NOW,
          },
        ],
      }),
    ).toBe(false)
  })

  test('refuses to sign something it would not accept back', () => {
    const ca = generateNodeKeyPair()
    expect(() => signRevocationList(ca, { ...list(), version: 2 })).toThrow(
      /malformed revocation list/,
    )
  })
})
