// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Proof of possession for the Ed25519 half of a node's identity (§4.3).
 *
 * A CSR proves the requester holds the **EC** key it was made with. It proves
 * nothing at all about the **Ed25519** key the certificate is about to vouch
 * for — and that key is the whole point of the certificate (§4.2's third SAN).
 * Without this step a node could request a certificate saying "node = me,
 * nodekey = somebody else's public key", and every peer that later reads its
 * `PublicKeyDirectory` out of that certificate would be poisoned.
 *
 * So issuance requires a second signature, made with the Ed25519 private key,
 * over a message that names both the node and this exact CSR. The CA verifies
 * it with the very key the request asks to have certified (§4.3: "CA 用 SAN 里
 * 声称的那把公钥 verifyBytes() 一次") — which is exactly right, because the
 * claim being tested is "whoever asked for this key is holding it".
 *
 * ## What "the CSR's SHA-256" is, decided here
 *
 * §4.3 writes `<CSR 的 SHA-256 十六进制>` without saying over which bytes. Two
 * readings exist and they disagree in practice, so this file picks one and
 * both sides read it from here:
 *
 *   **the DER**, i.e. the base64 body of the PEM decoded, lowercase hex.
 *
 * Not the PEM file's bytes. A CSR crosses a machine boundary between the node
 * that made it and the operator who signs it, and that trip can re-wrap lines
 * or flip newlines without changing the request at all. Digesting the file
 * would turn a mail client into a PoP failure with no diagnosable cause;
 * digesting the DER binds the thing that is actually certified. This is not a
 * weakening: the DER is precisely what the CA copies into the certificate.
 */

import { createHash } from 'node:crypto'
import { verifyBytes } from '@qianmo/capability'
import { isNodePublicKey, isValidSegment } from '@qianmo/protocol'

/**
 * Domain-separation prefix, mandatory (§4.4).
 *
 * The node's Ed25519 key already signs capability tokens and — after P12.3 —
 * handshake tuples. Three signing surfaces on one key are safe only while no
 * message from one can be read as a message from another, and a version-tagged
 * prefix is what makes that true by construction rather than by luck.
 */
export const POP_DOMAIN_PREFIX = 'qianmo-csr-pop-v1'

const PEM_CSR_BEGIN = '-----BEGIN CERTIFICATE REQUEST-----'
const PEM_CSR_END = '-----END CERTIFICATE REQUEST-----'

/**
 * The DER bytes of a PEM certificate request.
 *
 * Exactly one block, or an error: a file holding two requests is a file where
 * "which one did you sign" has no answer, and guessing at the first is how a
 * PoP ends up attesting to a request nobody looked at.
 */
function csrDer(csrPem: string): Buffer {
  const begin = csrPem.indexOf(PEM_CSR_BEGIN)
  const end = csrPem.indexOf(PEM_CSR_END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('not a PEM certificate request')
  }
  if (csrPem.indexOf(PEM_CSR_BEGIN, begin + 1) !== -1) {
    throw new Error('more than one certificate request in one file')
  }
  const body = csrPem.slice(begin + PEM_CSR_BEGIN.length, end)
  return Buffer.from(body.replace(/\s+/g, ''), 'base64')
}

/**
 * The exact bytes a requester signs and the CA verifies.
 *
 * One function, called by both sides. P12.2's `qm cert request` imports this
 * rather than re-deriving the string: a proof of possession where the two ends
 * build the message separately is a proof of possession that fails on the day
 * someone changes a newline.
 */
export function popMessage(node: string, csrPem: string): string {
  if (!isValidSegment(node)) {
    throw new Error(`invalid node segment: ${String(node)}`)
  }
  const digest = createHash('sha256').update(csrDer(csrPem)).digest('hex')
  return `${POP_DOMAIN_PREFIX}\n${node}\n${digest}`
}

/**
 * True when `signature` proves the holder of `publicKey` asked for this CSR.
 *
 * Returns a boolean rather than throwing on a bad signature — the caller turns
 * it into a refusal with a message that says which of the two failures it was.
 * A malformed CSR still throws: that is the operator's own input being wrong,
 * not a failed proof.
 */
export function verifyCsrPop(request: {
  readonly node: string
  readonly publicKey: string
  readonly csrPem: string
  readonly signature: string
}): boolean {
  if (!isNodePublicKey(request.publicKey)) return false
  return verifyBytes(
    request.publicKey,
    popMessage(request.node, request.csrPem),
    request.signature,
  )
}
