// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Proof of possession, both sides (§4.3).
 *
 * No openssl and no mocks: the CSR is a real one, captured once, and the
 * Ed25519 keys are minted by the same `@qianmo/capability` a node uses. What
 * is under test is the binding between them, and that needs neither.
 */

import { describe, expect, test } from 'bun:test'
import { generateNodeKeyPair, signBytes } from '@qianmo/capability'
import { POP_DOMAIN_PREFIX, popMessage, verifyCsrPop } from '../pop.js'

/** A real `openssl req` output for an EC key. Its contents do not matter here. */
const CSR_PEM = `-----BEGIN CERTIFICATE REQUEST-----
MIHMMHMCAQAwETEPMA0GA1UEAwwGbm9kZS1hMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE2WBqrofNJxnmKJ1fKOCIllhsg7LnnVqf+9iMQ8FMsFbntYM0mmkBUGGa
IponjvGMzykIWsPgrExV+2eGUF3hQaAAMAoGCCqGSM49BAMCA0kAMEYCIQC9wYSa
eslWUzHNPKui1mDjrRIX0cgoM/JXfvoY0niYXQIhAJ/1Yq2M74LmgR12QemoRlx0
DYCPUFRE832t9oSiR6wB
-----END CERTIFICATE REQUEST-----
`

describe('CSR proof of possession (§4.3)', () => {
  test('the holder of the node key passes', () => {
    const keys = generateNodeKeyPair()
    const signature = signBytes(keys, popMessage('node-a', CSR_PEM))
    expect(
      verifyCsrPop({
        node: 'node-a',
        publicKey: keys.publicKey,
        csrPem: CSR_PEM,
        signature,
      }),
    ).toBe(true)
  })

  test('another key does not — this is the attack §4.3 exists for', () => {
    // A node asking for a certificate that binds its own name to somebody
    // else's public key. It holds the EC key the CSR was made with, so the CSR
    // itself proves nothing; only this check stops it.
    const victim = generateNodeKeyPair()
    const attacker = generateNodeKeyPair()
    const signature = signBytes(attacker, popMessage('node-a', CSR_PEM))
    expect(
      verifyCsrPop({
        node: 'node-a',
        publicKey: victim.publicKey,
        csrPem: CSR_PEM,
        signature,
      }),
    ).toBe(false)
  })

  test('a signature made for another node does not transfer', () => {
    const keys = generateNodeKeyPair()
    const signature = signBytes(keys, popMessage('node-b', CSR_PEM))
    expect(
      verifyCsrPop({
        node: 'node-a',
        publicKey: keys.publicKey,
        csrPem: CSR_PEM,
        signature,
      }),
    ).toBe(false)
  })

  test('a signature made for another CSR does not transfer', () => {
    const keys = generateNodeKeyPair()
    const other = CSR_PEM.replace(
      'MIHMMHMCAQAwETEPMA0GA1UEAwwGbm9kZS1h',
      'MIHMMHMCAQAwETEPMA0GA1UEAwwGbm9kZS1i',
    )
    const signature = signBytes(keys, popMessage('node-a', other))
    expect(
      verifyCsrPop({
        node: 'node-a',
        publicKey: keys.publicKey,
        csrPem: CSR_PEM,
        signature,
      }),
    ).toBe(false)
  })

  test('garbage in the signature slot is false, not an exception', () => {
    const keys = generateNodeKeyPair()
    for (const signature of ['', 'not-base64url!!', 'A'.repeat(86)]) {
      expect(
        verifyCsrPop({
          node: 'node-a',
          publicKey: keys.publicKey,
          csrPem: CSR_PEM,
          signature,
        }),
      ).toBe(false)
    }
    expect(
      verifyCsrPop({
        node: 'node-a',
        publicKey: 'not-a-key',
        csrPem: CSR_PEM,
        signature: 'A'.repeat(86),
      }),
    ).toBe(false)
  })

  test('the message is domain-separated and names both node and CSR', () => {
    const message = popMessage('node-a', CSR_PEM)
    const [prefix, node, digest, ...rest] = message.split('\n')
    expect(prefix).toBe(POP_DOMAIN_PREFIX)
    expect(node).toBe('node-a')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(rest).toEqual([])
    // Digested over the DER, so re-wrapping the PEM in transit is not a
    // proof-of-possession failure — see pop.ts on why that choice was made.
    const rewrapped = `-----BEGIN CERTIFICATE REQUEST-----\r\n${CSR_PEM.split(
      '\n',
    )
      .slice(1, -2)
      .join('')}\r\n-----END CERTIFICATE REQUEST-----\r\n`
    expect(popMessage('node-a', rewrapped)).toBe(message)
  })

  test('a file that is not one certificate request throws', () => {
    expect(() => popMessage('node-a', 'hello')).toThrow(/not a PEM/)
    expect(() => popMessage('node-a', CSR_PEM + CSR_PEM)).toThrow(
      /more than one/,
    )
    expect(() => popMessage('Node A', CSR_PEM)).toThrow(/invalid node segment/)
  })
})
