// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The node's key pair, and the two operations that need it.
 *
 * Ed25519 through `node:crypto`, with keys carried as the JWK OKP parameters
 * (`x` public, `d` private) because that is already the encoding protocol.md
 * §10.1 fixed for public keys — so persisting a key, publishing it to the
 * registry and verifying a signature all handle the same 43-character string,
 * with no conversion step that could disagree with another.
 *
 * ## What this file deliberately does not do
 *
 * No file system. A key that knows where it lives would make every consumer of
 * this package inherit a path convention, and the one place that must own paths
 * is `src/config/paths.ts` in the base (CLAUDE.md §1.1②). Persistence lives in
 * the wiring layer, which passes the strings in and out.
 *
 * No key rotation, no certificate chain, no trust hierarchy: charter N-3 keeps
 * those out of M0 and says why the node-level self-signed pair is nevertheless
 * not a violation of it — the ban is on a PKI, not on a node having a key.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
import { isNodePublicKey, SIGNATURE_PATTERN } from '@qianmo/protocol'

/** A node's key pair, in the encoding it is stored and published in. */
export interface NodeKeyPair {
  /** base64url, 43 chars — the value published as `AgentRecord.publicKey`. */
  readonly publicKey: string
  /**
   * base64url, 43 chars. Never leaves the node, never enters an envelope, and
   * never appears in an audit record — the only reason it is a string at all is
   * that something has to write it to disk.
   */
  readonly privateKey: string
}

/** Mint a fresh node identity. */
export function generateNodeKeyPair(): NodeKeyPair {
  const pair = generateKeyPairSync('ed25519')
  const publicJwk = pair.publicKey.export({ format: 'jwk' })
  const privateJwk = pair.privateKey.export({ format: 'jwk' })
  const publicKey = publicJwk.x
  const privateKey = privateJwk.d
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') {
    throw new Error('node:crypto returned an Ed25519 key without x/d')
  }
  return { publicKey, privateKey }
}

/** True when both halves are well-formed and belong together. */
export function isNodeKeyPair(value: unknown): value is NodeKeyPair {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return (
    isNodePublicKey(pair['publicKey']) && isNodePublicKey(pair['privateKey'])
  )
}

function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
    format: 'jwk',
  })
}

function privateKeyObject(pair: NodeKeyPair): KeyObject {
  // The private JWK carries `x` as well: `node:crypto` refuses a `d`-only OKP
  // key, and inventing one from `d` here would mean re-deriving the public key
  // — which is exactly the sort of second implementation §10.1 asks us not to
  // grow. So the pair travels together, always.
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pair.publicKey, d: pair.privateKey },
    format: 'jwk',
  })
}

/** Sign `data` (UTF-8) with the node's private key; returns base64url. */
export function signBytes(pair: NodeKeyPair, data: string): string {
  return cryptoSign(
    null,
    Buffer.from(data, 'utf8'),
    privateKeyObject(pair),
  ).toString('base64url')
}

/**
 * Verify a base64url signature over `data` against a published public key.
 *
 * Returns `false` rather than throwing for every malformed input: this runs on
 * untrusted bytes, and a verifier that throws on a bad key turns "someone sent
 * us garbage" into an exception at whatever boundary happens to be above it.
 */
export function verifyBytes(
  publicKey: string,
  data: string,
  signature: string,
): boolean {
  if (!isNodePublicKey(publicKey)) return false
  if (!SIGNATURE_PATTERN.test(signature)) return false
  try {
    return cryptoVerify(
      null,
      Buffer.from(data, 'utf8'),
      publicKeyObject(publicKey),
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return false
  }
}
