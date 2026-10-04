// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trustAnchors.ts` — the one reader of a `--trust-ca` file.
 *
 * Real openssl and real certificates, for the reason every CA test here gives:
 * the question is what `node:crypto` and Bun make of actual X.509 bytes, and a
 * fixture would assert our belief about that instead.
 *
 * The refusals are the point of this file. Each shape below is one the TLS
 * layer would either skip silently or disagree with the directory about; the
 * parser's job is to turn every one of them into "the node does not start".
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateNodeKeyPair, signBytes } from '@qianmo/capability'
import { caKeyPairFromPem } from '../ca/caKeys.js'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
} from '../ca/operations.js'
import { opensslVersion, runOpenssl } from '../ca/openssl.js'
import { caCertPath, caKeyPath } from '../ca/paths.js'
import { popMessage } from '../ca/pop.js'
import {
  anchoredValidity,
  parseTrustAnchors,
  readTrustAnchors,
  verifyRevocationListByAnchors,
} from '../trustAnchors.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

let root: string
let oldDir: string
let newDir: string
let oldPem: string
let newPem: string

beforeAll(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-trust-anchors-'))
  oldDir = join(root, 'old')
  newDir = join(root, 'new')
  // Two generations, named apart — the rotation `ca init --help` describes.
  // The old one is named like the production root, which predates the dated
  // default CN.
  initCa({ directory: oldDir, commonName: 'qianmo-ca' })
  initCa({ directory: newDir, commonName: 'qianmo-ca-next' })
  oldPem = readFileSync(caCertPath(oldDir), 'utf8')
  newPem = readFileSync(caCertPath(newDir), 'utf8')
})

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

function leafUnder(directory: string, node: string): X509Certificate {
  const keys = generateNodeKeyPair()
  const keyPath = join(root, `${node}-${String(Date.now())}.key`)
  writeFileSync(
    keyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  const csrPem = runOpenssl(['req', '-new', '-key', keyPath, '-subj', '/CN=x'])
  const issued = issueCertificate({
    directory,
    node,
    publicKey: keys.publicKey,
    csrPem,
    popSignature: signBytes(keys, popMessage(node, csrPem)),
    hosts: ['localhost'],
    outPath: join(root, `${node}-${String(Date.now())}.crt`),
    replace: true,
  })
  return new X509Certificate(issued.certificatePem)
}

/** A self-signed certificate with whatever openssl flags the case needs. */
function selfSigned(tag: string, args: readonly string[]): string {
  const keyPath = join(root, `${tag}.key`)
  return runOpenssl([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-keyout',
    keyPath,
    '-days',
    '1',
    '-subj',
    `/CN=${tag}`,
    ...args,
  ])
}

describe('parseTrustAnchors: what a trust file may hold', () => {
  itNeedsOpenssl('two roots, in either order, give two anchors', () => {
    const both = parseTrustAnchors(oldPem + newPem, 'test')
    expect(both.anchors.map(anchor => anchor.certificate.subject)).toEqual([
      'CN=qianmo-ca',
      'CN=qianmo-ca-next',
    ])
    // What the TLS layer is handed is the parse, re-serialized — and it reads
    // back to the same two roots.
    const again = parseTrustAnchors(both.pem, 'test')
    expect(
      again.anchors.map(anchor => anchor.certificate.fingerprint256),
    ).toEqual(both.anchors.map(anchor => anchor.certificate.fingerprint256))
    expect(parseTrustAnchors(newPem + oldPem, 'test').anchors).toHaveLength(2)
    // Blank lines and CRLF between blocks are whitespace, not content.
    expect(
      parseTrustAnchors(
        `\r\n${oldPem.replace(/\n/g, '\r\n')}\n\n${newPem}\n`,
        'test',
      ).anchors,
    ).toHaveLength(2)
  })

  itNeedsOpenssl('a damaged block refuses the whole file', () => {
    // The exact shape Bun's TLS stack skips without a word (see
    // `residentRootOverlap.test.ts`): a good root, then a block that is not
    // a certificate. Accepting the first and dropping the second would shrink
    // the trust set silently.
    const damaged = `${oldPem}-----BEGIN CERTIFICATE-----\nAAAAbroken\n-----END CERTIFICATE-----\n${newPem}`
    expect(() => parseTrustAnchors(damaged, 'test')).toThrow(
      /test: certificate #2/,
    )
    const unterminated = `${oldPem}-----BEGIN CERTIFICATE-----\nMIIB\n`
    expect(() => parseTrustAnchors(unterminated, 'test')).toThrow(
      /never closed/,
    )
    const trailingBytes = new X509Certificate(oldPem).raw
    const padded = `-----BEGIN CERTIFICATE-----\n${Buffer.concat([
      Buffer.from(trailingBytes),
      Buffer.from([0, 0, 0]),
    ]).toString('base64')}\n-----END CERTIFICATE-----\n`
    expect(() => parseTrustAnchors(padded, 'test')).toThrow(/certificate #1/)
  })

  itNeedsOpenssl('anything outside a certificate block is refused', () => {
    expect(() => parseTrustAnchors(`# old root\n${oldPem}`, 'test')).toThrow(
      /line 1 is outside any certificate block/,
    )
    expect(() => parseTrustAnchors('', 'test')).toThrow(/no root certificate/)
    expect(() => parseTrustAnchors('\n  \n', 'test')).toThrow(
      /no root certificate/,
    )
  })

  itNeedsOpenssl(
    'a private key pasted in is refused without echoing it',
    () => {
      const keyPem = readFileSync(caKeyPath(oldDir), 'utf8')
      const body = keyPem.split('\n')[1] ?? ''
      let message = ''
      try {
        parseTrustAnchors(oldPem + keyPem, 'test')
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toMatch(/opens a PRIVATE KEY block/)
      expect(body.length).toBeGreaterThan(0)
      expect(message).not.toContain(body)
    },
  )

  itNeedsOpenssl('every certificate must be a self-signed Ed25519 CA', () => {
    const ecRoot = selfSigned('ec-root', [
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
    ])
    expect(() => parseTrustAnchors(ecRoot, 'test')).toThrow(
      /carries a key of type ec/,
    )

    const notCa = selfSigned('not-ca', [
      '-newkey',
      'ed25519',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
    ])
    expect(() => parseTrustAnchors(notCa, 'test')).toThrow(
      /not a CA certificate/,
    )

    // An intermediate on its own: the directory could verify leaves against
    // its key, but the TLS layer cannot build a chain to it.
    const intermediateKey = join(root, 'intermediate.key')
    writeFileSync(
      intermediateKey,
      runOpenssl(['genpkey', '-algorithm', 'ed25519']),
      { mode: 0o600 },
    )
    const extPath = join(root, 'intermediate.ext')
    writeFileSync(extPath, 'basicConstraints=critical,CA:TRUE\n')
    const intermediate = runOpenssl(
      [
        'x509',
        '-req',
        '-CA',
        caCertPath(oldDir),
        '-CAkey',
        caKeyPath(oldDir),
        '-CAcreateserial',
        '-CAserial',
        join(root, 'intermediate.srl'),
        '-days',
        '1',
        '-extfile',
        extPath,
      ],
      {
        input: runOpenssl([
          'req',
          '-new',
          '-key',
          intermediateKey,
          '-subj',
          '/CN=intermediate',
        ]),
      },
    )
    expect(() => parseTrustAnchors(intermediate, 'test')).toThrow(
      /not a self-signed root/,
    )
  })

  itNeedsOpenssl('a root listed twice is refused', () => {
    expect(() => parseTrustAnchors(oldPem + oldPem, 'test')).toThrow(
      /listed twice/,
    )
  })

  itNeedsOpenssl('two roots with one name are refused', () => {
    // The production root is CN=qianmo-ca, and `--cn` can hand a new root the
    // same name; the TLS layer picks an issuer by name — see
    // `residentRootOverlap.test.ts`.
    const sameName = join(root, 'same-name')
    initCa({ directory: sameName, commonName: 'qianmo-ca' })
    expect(() =>
      parseTrustAnchors(
        oldPem + readFileSync(caCertPath(sameName), 'utf8'),
        'test',
      ),
    ).toThrow(/two roots share the subject CN=qianmo-ca/)
  })

  itNeedsOpenssl('readTrustAnchors names the file in every refusal', () => {
    const path = join(root, 'bad-bundle.pem')
    writeFileSync(path, `junk\n${oldPem}`)
    expect(() => readTrustAnchors(path)).toThrow(
      new RegExp(`--trust-ca ${path}: line 1`),
    )
  })
})

describe('anchoredValidity: issued by which root, and valid until when', () => {
  itNeedsOpenssl('a leaf is anchored by the root that issued it', () => {
    const both = parseTrustAnchors(oldPem + newPem, 'test')
    const oldLeaf = leafUnder(oldDir, 'node-old')
    const newLeaf = leafUnder(newDir, 'node-new')
    expect(anchoredValidity(both, oldLeaf)).not.toBeNull()
    expect(anchoredValidity(both, newLeaf)).not.toBeNull()

    const newOnly = parseTrustAnchors(newPem, 'test')
    expect(anchoredValidity(newOnly, oldLeaf)).toBeNull()
    expect(anchoredValidity(newOnly, newLeaf)).not.toBeNull()
  })

  itNeedsOpenssl('a same-named root with another key anchors nothing', () => {
    // Issuer name matches, key does not: the directory must refuse what the
    // TLS layer refuses, so name and signature are both checked.
    const impostor = join(root, 'impostor')
    initCa({ directory: impostor, commonName: 'qianmo-ca' })
    const forged = leafUnder(impostor, 'node-a')
    const ours = parseTrustAnchors(oldPem, 'test')
    expect(forged.issuer).toBe('CN=qianmo-ca')
    expect(anchoredValidity(ours, forged)).toBeNull()
  })

  itNeedsOpenssl('the window ends when the issuing root does', () => {
    // A one-day root and a 90-day leaf under it: the TLS layer refuses the
    // leaf once the root expires, so the directory's window stops there too.
    const shortDir = join(root, 'short')
    initCa({ directory: shortDir, commonName: 'short-lived', days: 1 })
    const shortRoot = new X509Certificate(
      readFileSync(caCertPath(shortDir), 'utf8'),
    )
    const leaf = leafUnder(shortDir, 'node-s')
    const window = anchoredValidity(
      parseTrustAnchors(shortRoot.toString(), 'test'),
      leaf,
    )
    expect(Date.parse(leaf.validTo)).toBeGreaterThan(
      Date.parse(shortRoot.validTo),
    )
    expect(window?.notAfter).toBe(Date.parse(shortRoot.validTo))
    expect(window?.notBefore).toBe(Date.parse(leaf.validFrom))
  })
})

describe('verifyRevocationListByAnchors', () => {
  itNeedsOpenssl('either root of an overlap may sign the list', () => {
    const rl = refreshRevocationList({ directory: oldDir })
    const signed: unknown = JSON.parse(readFileSync(rl.path, 'utf8'))
    const now = Date.now()
    expect(
      verifyRevocationListByAnchors(
        parseTrustAnchors(oldPem + newPem, 'test'),
        signed,
        now,
      ),
    ).not.toBeNull()
    // Once the old root is gone from the file, its signature is nobody's.
    expect(
      verifyRevocationListByAnchors(
        parseTrustAnchors(newPem, 'test'),
        signed,
        now,
      ),
    ).toBeNull()
    // And a root past its own validity signs nothing either.
    const oldRoot = new X509Certificate(oldPem)
    expect(
      verifyRevocationListByAnchors(
        parseTrustAnchors(oldPem, 'test'),
        signed,
        Date.parse(oldRoot.validTo),
      ),
    ).toBeNull()
    // Sanity: the key that signed it is the old root's.
    expect(
      caKeyPairFromPem(readFileSync(caKeyPath(oldDir), 'utf8')).publicKey,
    ).toBe(rl.caPublicKey)
  })
})
