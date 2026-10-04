// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading the CA's Ed25519 key in the encoding the rest of Qianmo speaks.
 *
 * openssl produces PEM; `@qianmo/capability` signs with a `NodeKeyPair`, i.e.
 * the JWK `x`/`d` pair that protocol.md §10.1 fixed as the one public-key
 * encoding. F-4 measured the round trip and found `x` comes back byte-identical
 * — so there is no second encoding here, only two spellings of the same 32
 * bytes, and this file is the single place that crosses between them.
 *
 * That crossing is what lets §6.4's revocation list be signed with the very
 * `signBytes`/`verifyBytes` the capability tokens use, with zero new
 * dependencies: the CA is not a new kind of signer, it is an Ed25519 key like
 * every node's, held somewhere no node can reach (§3.3).
 */

import { X509Certificate, createPrivateKey } from 'node:crypto'
import { isNodeKeyPair, type NodeKeyPair } from '@qianmo/capability'
import { isNodePublicKey } from '@qianmo/protocol'

/** SHA-256 fingerprint as `node:crypto` renders it: 32 upper-hex byte pairs. */
const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/

/** Load the CA's key pair from a PEM private key. */
export function caKeyPairFromPem(pem: string): NodeKeyPair {
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') {
    // §4.1 fixes the root as Ed25519 (F-6 showed an EC leaf under an Ed25519
    // root is accepted, so there is no reason to make the root the odd one).
    // A different algorithm here would still sign certificates and would then
    // silently fail to sign an RL, which is the worst possible time to notice.
    throw new Error(
      `the CA key must be Ed25519, this one is ${String(key.asymmetricKeyType)}`,
    )
  }
  const jwk = key.export({ format: 'jwk' })
  const pair = { publicKey: jwk.x, privateKey: jwk.d }
  if (!isNodeKeyPair(pair)) {
    throw new Error('node:crypto returned an Ed25519 key without x/d')
  }
  return pair
}

/**
 * The CA's public key, in the 43-character form, read out of its certificate.
 *
 * This is the value a node needs to check an RL signature, and taking it from
 * the certificate rather than from a separate file is the point: the root
 * certificate is already the one thing distributed out of band (§5.1), so the
 * RL verification key rides along with it and cannot drift from it.
 */
export function caPublicKeyFromCertificate(certificatePem: string): string {
  // `X509Certificate.publicKey` is already a KeyObject; exporting it directly
  // is the whole conversion.
  const jwk = new X509Certificate(certificatePem).publicKey.export({
    format: 'jwk',
  })
  const publicKey = jwk.x
  if (!isNodePublicKey(publicKey)) {
    throw new Error('the CA certificate does not carry an Ed25519 public key')
  }
  return publicKey
}

/**
 * Normalize a SHA-256 fingerprint typed by a human into the canonical form.
 *
 * Accepts it with or without the colons and in either case, because the two
 * places an operator copies one from — `openssl x509 -fingerprint` and this
 * tool's own output — do not agree on the punctuation, and a revocation that
 * silently fails to match is the one kind of typo this command must not have.
 */
export function normalizeFingerprint256(raw: string): string {
  const compact = raw.replace(/[\s:]/g, '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(compact)) {
    throw new Error(
      `not a SHA-256 fingerprint: ${raw} (expected 64 hex characters, ` +
        'colons optional)',
    )
  }
  const pairs = compact.match(/.{2}/g) ?? []
  return pairs.join(':')
}

/** True when `value` is a canonical SHA-256 fingerprint. */
export function isFingerprint256(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}
