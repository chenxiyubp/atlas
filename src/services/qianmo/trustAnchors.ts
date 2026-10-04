// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `--trust-ca` file, read once, the same way for every layer that uses it.
 *
 * ## Why this module exists
 *
 * key-distribution.md §3.3 rotates the root every three years with a 90-day
 * overlap, which means that for a whole certificate lifetime a node has to
 * accept leaves from two roots at once. Before this module the two layers that
 * read `--trust-ca` disagreed about what "the root" was: `CertificateDirectory`
 * parsed the file with `new X509Certificate(...)`, which silently keeps only
 * the first certificate, while the TLS `ca` option was handed the whole file
 * and used every root in it. During an overlap that is two answers to one
 * question — a peer whose certificate the TLS layer accepts, and whose key the
 * directory refuses to resolve.
 *
 * So there is now one parser, and both layers consume its output: the
 * directory, the console and the startup self-check read {@link TrustAnchor}s,
 * and the TLS layer is handed {@link TrustAnchors.pem}, which is those same
 * anchors re-serialized — not the file. Whatever the parser refused never
 * reaches either layer.
 *
 * ## Strict on purpose, and each refusal is measured
 *
 * Bun's TLS stack is forgiving where a trust file must not be. On Bun 1.3.13
 * a malformed `BEGIN CERTIFICATE` block inside a `ca` bundle is skipped
 * silently and the remaining roots keep working, so a typo in the file shrinks
 * the trust set without a word. The rules below turn every such shape into a
 * refusal to start:
 *
 * - only `CERTIFICATE` blocks, nothing but whitespace between them, and each
 *   block exactly one DER certificate;
 * - every certificate is a root: Ed25519 (§4.1), `CA:TRUE`, self-issued and
 *   self-signed. An intermediate alone is refused because the TLS layer
 *   cannot build a chain to it (`unable to get issuer certificate`), while a
 *   signature check against its key would pass — the exact disagreement this
 *   module exists to remove;
 * - no two roots share a subject. TLS picks the issuer by name, so with two
 *   same-named roots and a leaf that carries no authority key identifier it
 *   tries the first one and fails the other root's leaves with `certificate
 *   signature failure`. `qm ca init` now dates its default name
 *   (`qianmo-ca-<yyyymmdd>`), but the first production root is plain
 *   `CN=qianmo-ca`, `--cn` can repeat a name, and two roots made on one UTC
 *   day share the default — so the file still has to refuse it.
 *
 * A root that is merely out of date is **not** refused here: it anchors
 * nothing (the TLS layer answers `certificate has expired`), and
 * {@link anchoredValidity} makes the directory agree by folding the root's
 * validity into every leaf it issued.
 */

import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isNodePublicKey } from '@qianmo/protocol'
import {
  verifyRevocationList,
  type RevocationList,
} from './ca/revocationList.js'

/** One root from the trust file, checked and ready to anchor a chain. */
interface TrustAnchor {
  readonly certificate: X509Certificate
  /** 43-character Ed25519 public key — the one an RL signature verifies against. */
  readonly publicKey: string
  /** Epoch milliseconds. */
  readonly notBefore: number
  /** Epoch milliseconds. */
  readonly notAfter: number
}

/** Every root in one trust file, in file order. */
interface TrustAnchors {
  readonly anchors: readonly TrustAnchor[]
  /**
   * The anchors as PEM, one after another — what the TLS `ca` option gets.
   *
   * Re-serialized from the parsed certificates rather than copied from the
   * file, so the TLS layer can only ever see what this module accepted.
   */
  readonly pem: string
}

const BEGIN = /^-----BEGIN ([A-Z0-9 ]+)-----$/
const END = /^-----END ([A-Z0-9 ]+)-----$/

function rootOf(
  pem: string,
  der: Buffer,
  ordinal: number,
  label: string,
): TrustAnchor {
  const where = `${label}: certificate #${String(ordinal)}`
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(pem)
  } catch (error) {
    throw new Error(
      `${where} does not parse: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Buffer.from(certificate.raw).equals(der)) {
    throw new Error(`${where} carries bytes beyond one certificate`)
  }
  if (certificate.publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `${where} (${certificate.subject}) carries a key of type ` +
        `${String(certificate.publicKey.asymmetricKeyType)}; a Qianmo root ` +
        'is Ed25519 (key-distribution.md §4.1)',
    )
  }
  if (!certificate.ca) {
    throw new Error(
      `${where} (${certificate.subject}) is not a CA certificate ` +
        '(basicConstraints CA:TRUE is missing)',
    )
  }
  if (
    !certificate.checkIssued(certificate) ||
    !certificate.verify(certificate.publicKey)
  ) {
    throw new Error(
      `${where} (${certificate.subject}) is not a self-signed root; the file ` +
        'holds roots only, never an intermediate or a node certificate',
    )
  }
  const publicKey = certificate.publicKey.export({ format: 'jwk' }).x
  if (!isNodePublicKey(publicKey)) {
    throw new Error(`${where} does not carry a usable Ed25519 public key`)
  }
  const notBefore = Date.parse(certificate.validFrom)
  const notAfter = Date.parse(certificate.validTo)
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    throw new Error(`${where} has an unreadable validity period`)
  }
  return { certificate, publicKey, notBefore, notAfter }
}

/**
 * Parse a trust file: one or more PEM root certificates, nothing else.
 *
 * Throws on anything it does not accept, naming the offending block or line
 * but never echoing file content — a private key pasted into a trust file by
 * mistake must not end up in a log.
 */
export function parseTrustAnchors(text: string, label: string): TrustAnchors {
  const anchors: TrustAnchor[] = []
  const lines = text.split('\n')
  let block: { readonly start: number; readonly body: string[] } | null = null

  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? '').replace(/\r$/, '').trim()
    const lineNumber = index + 1
    if (block === null) {
      if (line === '') continue
      const begin = BEGIN.exec(line)
      if (begin === null) {
        throw new Error(
          `${label}: line ${String(lineNumber)} is outside any certificate ` +
            'block; the file holds PEM root certificates and nothing else',
        )
      }
      if (begin[1] !== 'CERTIFICATE') {
        throw new Error(
          `${label}: line ${String(lineNumber)} opens a ${String(begin[1])} ` +
            'block; the file holds certificates only',
        )
      }
      block = { start: lineNumber, body: [] }
      continue
    }
    const end = END.exec(line)
    if (end !== null) {
      if (end[1] !== 'CERTIFICATE') {
        throw new Error(
          `${label}: the block opened on line ${String(block.start)} ends as ` +
            `${String(end[1])}`,
        )
      }
      const base64 = block.body.join('')
      if (base64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new Error(
          `${label}: certificate #${String(anchors.length + 1)} (line ` +
            `${String(block.start)}) is not base64`,
        )
      }
      anchors.push(
        rootOf(
          `-----BEGIN CERTIFICATE-----\n${block.body.join('\n')}\n-----END CERTIFICATE-----\n`,
          Buffer.from(base64, 'base64'),
          anchors.length + 1,
          label,
        ),
      )
      block = null
      continue
    }
    if (line.startsWith('-----')) {
      throw new Error(
        `${label}: line ${String(lineNumber)} is a PEM marker inside the ` +
          `block opened on line ${String(block.start)}`,
      )
    }
    block.body.push(line)
  }

  if (block !== null) {
    throw new Error(
      `${label}: the certificate block opened on line ${String(block.start)} ` +
        'is never closed',
    )
  }
  if (anchors.length === 0) {
    throw new Error(`${label}: no root certificate in the file`)
  }

  const fingerprints = new Set<string>()
  const subjects = new Set<string>()
  for (const anchor of anchors) {
    const { fingerprint256, subject } = anchor.certificate
    if (fingerprints.has(fingerprint256)) {
      throw new Error(
        `${label}: root ${fingerprint256} is listed twice; check the file ` +
          'was assembled from the roots it was meant to hold',
      )
    }
    if (subjects.has(subject)) {
      throw new Error(
        `${label}: two roots share the subject ${subject}. The TLS layer picks ` +
          'an issuer by name, so one of them would anchor nothing; give the ' +
          'newer root a distinct name (`ca init --cn`)',
      )
    }
    fingerprints.add(fingerprint256)
    subjects.add(subject)
  }

  return {
    anchors,
    pem: anchors.map(anchor => anchor.certificate.toString()).join(''),
  }
}

/** {@link parseTrustAnchors} on a file, with the path in every refusal. */
export function readTrustAnchors(path: string): TrustAnchors {
  return parseTrustAnchors(readFileSync(path, 'utf8'), `--trust-ca ${path}`)
}

/**
 * The window in which `certificate` is admissible through this trust set, or
 * `null` when no root in it issued the certificate.
 *
 * "Issued" is the same question the TLS layer asks: the issuer name (and the
 * authority key identifier, when the certificate carries one) must match the
 * root, **and** the root's key must verify the signature. A signature alone
 * would accept a certificate the TLS layer refuses.
 *
 * The window is the intersection of the certificate's own validity and its
 * root's: a leaf is only as good as the root it chains to, and the TLS layer
 * refuses a leaf under an expired root. Callers compare the window against
 * their own clock.
 */
export function anchoredValidity(
  anchors: TrustAnchors,
  certificate: X509Certificate,
): { readonly notBefore: number; readonly notAfter: number } | null {
  const notBefore = Date.parse(certificate.validFrom)
  const notAfter = Date.parse(certificate.validTo)
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return null
  for (const anchor of anchors.anchors) {
    if (
      certificate.checkIssued(anchor.certificate) &&
      certificate.verify(anchor.certificate.publicKey)
    ) {
      return {
        notBefore: Math.max(notBefore, anchor.notBefore),
        notAfter: Math.min(notAfter, anchor.notAfter),
      }
    }
  }
  return null
}

/**
 * Verify a published revocation list against every root currently in date.
 *
 * During an overlap either root may sign the list; which one did is not a
 * property anything downstream depends on. A root outside its own validity
 * signs nothing here, for the same reason it anchors nothing.
 */
export function verifyRevocationListByAnchors(
  anchors: TrustAnchors,
  body: unknown,
  now: number,
): RevocationList | null {
  for (const anchor of anchors.anchors) {
    if (now < anchor.notBefore || now >= anchor.notAfter) continue
    const verified = verifyRevocationList(anchor.publicKey, body)
    if (verified !== null) return verified
  }
  return null
}
