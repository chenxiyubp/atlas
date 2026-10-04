// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm cert request` end to end: a node builds its own CSR + PoP, and the
 * offline CA (P12.1) accepts them and issues a real, connectable certificate.
 *
 * Zero mocks: real openssl, real files under a temporary config root, real
 * signature verification. This is also the integration seam between P12.1
 * and P12.2 — nothing here mocks the CA half.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyCsrPop } from '../ca/pop.js'
import { opensslVersion } from '../ca/openssl.js'
import { initCa, issueCertificate } from '../ca/operations.js'
import {
  CertRequestOpensslError,
  generateNodeCertificateRequest,
} from '../certRequest.js'
import { loadOrCreateNodeKeys, nodeIdentityPath } from '../nodeIdentity.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test
if (OPENSSL === null) {
  console.error(
    '[cert request] skipping: no usable openssl on PATH — `qm cert request` ' +
      'has no path that avoids it (see the module header).',
  )
}

let root: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-cert-request-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

describe('generateNodeCertificateRequest', () => {
  itNeedsOpenssl('never writes or moves the node’s Ed25519 identity', () => {
    const before = loadOrCreateNodeKeys('node-a')
    const request = generateNodeCertificateRequest({
      node: 'node-a',
      hosts: ['node-a.example.com'],
    })
    expect(request.publicKey).toBe(before.publicKey)
    expect(loadOrCreateNodeKeys('node-a')).toEqual(before)
    // The identity file itself is untouched — same content, same path.
    expect(readFileSync(nodeIdentityPath('node-a'), 'utf8')).toContain(
      before.publicKey,
    )
  })

  itNeedsOpenssl('writes the EC private key 0600, never world-readable', () => {
    const request = generateNodeCertificateRequest({
      node: 'node-a',
      hosts: ['node-a.example.com'],
    })
    expect(statSync(request.keyPath).mode & 0o777).toBe(0o600)
  })

  itNeedsOpenssl('the PoP verifies against the node’s own identity key', () => {
    const request = generateNodeCertificateRequest({
      node: 'node-a',
      hosts: ['node-a.example.com'],
    })
    expect(
      verifyCsrPop({
        node: 'node-a',
        publicKey: request.publicKey,
        csrPem: request.csrPem,
        signature: request.popSignature,
      }),
    ).toBe(true)
  })

  itNeedsOpenssl('a PoP for one node does not verify for another', () => {
    const requestA = generateNodeCertificateRequest({
      node: 'node-a',
      hosts: ['node-a.example.com'],
    })
    const keysB = loadOrCreateNodeKeys('node-b')
    expect(
      verifyCsrPop({
        node: 'node-b',
        publicKey: keysB.publicKey,
        csrPem: requestA.csrPem,
        signature: requestA.popSignature,
      }),
    ).toBe(false)
  })

  itNeedsOpenssl('refuses to build a CSR with no --host at all (F-9)', () => {
    expect(() =>
      generateNodeCertificateRequest({ node: 'node-a', hosts: [] }),
    ).toThrow(/--host is required/)
  })

  itNeedsOpenssl(
    're-running generates a fresh EC key — the old one is not reused',
    () => {
      const first = generateNodeCertificateRequest({
        node: 'node-a',
        hosts: ['node-a.example.com'],
      })
      // Read back before the second call — `second.keyPath` names the same
      // file, so reading it only after both calls would show the second
      // write twice and prove nothing.
      const firstKeyContent = readFileSync(first.keyPath, 'utf8')
      const second = generateNodeCertificateRequest({
        node: 'node-a',
        hosts: ['node-a.example.com'],
      })
      expect(second.keyPath).toBe(first.keyPath)
      expect(readFileSync(second.keyPath, 'utf8')).not.toBe(firstKeyContent)
      // The identity backing the PoP is unaffected by the rotation.
      expect(second.publicKey).toBe(first.publicKey)
    },
  )

  itNeedsOpenssl(
    'the CSR + PoP the CA actually needs round-trips through qm ca issue',
    () => {
      // The full P12.1 + P12.2 seam, real end to end: this node builds its
      // own request, and the offline CA (a separate machine in the model,
      // here just another temp directory) accepts it without any adaptation.
      const request = generateNodeCertificateRequest({
        node: 'node-a',
        hosts: ['node-a.example.com', '127.0.0.1'],
      })
      const caDir = join(root, 'ca')
      initCa({ directory: caDir })
      const issued = issueCertificate({
        directory: caDir,
        node: 'node-a',
        publicKey: request.publicKey,
        csrPem: request.csrPem,
        popSignature: request.popSignature,
        hosts: [...request.hosts],
      })
      const certificate = new X509Certificate(issued.certificatePem)
      expect(certificate.subjectAltName).toContain('DNS:node-a.example.com')
      expect(certificate.subjectAltName).toContain('IP Address:127.0.0.1')
      expect(certificate.subjectAltName).toContain('URI:qianmo://node-a')
    },
  )

  test('a missing openssl binary is reported, not a raw ENOENT', () => {
    const previous = process.env['QIANMO_CERT_OPENSSL_BIN']
    process.env['QIANMO_CERT_OPENSSL_BIN'] = join(root, 'does-not-exist')
    try {
      expect(() =>
        generateNodeCertificateRequest({
          node: 'node-a',
          hosts: ['node-a.example.com'],
        }),
      ).toThrow(CertRequestOpensslError)
    } finally {
      if (previous === undefined) delete process.env['QIANMO_CERT_OPENSSL_BIN']
      else process.env['QIANMO_CERT_OPENSSL_BIN'] = previous
    }
  })
})
