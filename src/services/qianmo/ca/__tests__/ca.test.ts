// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CA end to end: build a root, sign a node certificate, then make the
 * certificate do the two jobs §4.2 gives it.
 *
 * Zero mocks on purpose. Every claim this package rests on came from a probe
 * against the real thing (`key-distribution.md` §2), and a mocked openssl or a
 * mocked TLS stack would assert against our belief about them rather than
 * against them. So: real openssl, a real `Bun.serve`, real `node:crypto`.
 *
 * These are the reproductions §13's P12.1 row asks for by name:
 *   F-1/F-3  the three SAN classes survive issuance and read back
 *   F-6      an EC leaf under an Ed25519 root is accepted by `Bun.serve`
 *   F-9      the DNS:/IP: SANs are what make the connection possible at all
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  NODE_KEY_URI_SCHEME,
  parseNodeCertificateBinding,
} from '@qianmo/protocol'
import {
  CA_ROOT_DAYS,
  NODE_CERT_DAYS,
  initCa,
  issueCertificate,
  refreshRevocationList,
  type CaInitResult,
} from '../operations.js'
import { opensslVersion, runOpenssl } from '../openssl.js'
import { caCertPath, caKeyPath, revocationListPath } from '../paths.js'
import { popMessage } from '../pop.js'
import { verifyRevocationList } from '../revocationList.js'
import { parseTrustAnchors } from '../../trustAnchors.js'

const OPENSSL = opensslVersion()
if (OPENSSL === null) {
  // Printed, not swallowed: a silently skipped suite is a suite that stops
  // covering anything the day the binary goes missing on CI.
  console.error(
    '[qianmo ca] skipping the openssl-backed CA tests: no usable openssl on ' +
      'PATH. Install it, or point QIANMO_OPENSSL_BIN at one — the CA tool is ' +
      'an openssl wrapper and there is nothing to test without it.',
  )
}

/** Skips with the reason above rather than failing on a machine without openssl. */
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

let root: string
let caDir: string
let ca: CaInitResult
let nodeKeys: NodeKeyPair
let nodeTlsKeyPath: string
let csrPem: string

beforeAll(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-ca-test-'))
  caDir = join(root, 'ca')
  ca = initCa({ directory: caDir })

  // What a node does for itself in P12.2 (`qm cert request`): an EC key that
  // never leaves it (F-5 forces EC), plus a CSR made from it.
  nodeKeys = generateNodeKeyPair()
  nodeTlsKeyPath = join(root, 'node-a.tls.key')
  writeFileSync(
    nodeTlsKeyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    nodeTlsKeyPath,
    '-subj',
    '/CN=node-a',
  ])
})

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

function issueForTest(overrides: Record<string, unknown> = {}) {
  const pop = signBytes(nodeKeys, popMessage('node-a', csrPem))
  return issueCertificate({
    directory: caDir,
    node: 'node-a',
    publicKey: nodeKeys.publicKey,
    csrPem,
    popSignature: pop,
    hosts: ['localhost', '127.0.0.1'],
    // Every test here re-issues node-a into one CA directory; the refusal to
    // overwrite without it has its own tests in `ledger.test.ts`.
    replace: true,
    ...overrides,
  })
}

describe('qm ca init', () => {
  itNeedsOpenssl('makes an Ed25519 root with 0700/0600 permissions', () => {
    expect(statSync(caDir).mode & 0o777).toBe(0o700)
    expect(statSync(caKeyPath(caDir)).mode & 0o777).toBe(0o600)
    expect(ca.fingerprint256).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(ca.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const certificate = new X509Certificate(readFileSync(caCertPath(caDir)))
    // Self-signed, and the root lives for §6.2's ten years.
    expect(certificate.verify(certificate.publicKey)).toBe(true)
    const years =
      (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) /
      (24 * 60 * 60 * 1000)
    expect(Math.round(years)).toBe(CA_ROOT_DAYS)
  })

  itNeedsOpenssl('never overwrites an existing CA private key (§3.3)', () => {
    expect(() => initCa({ directory: caDir })).toThrow(/never\s+overwritten/)
  })

  itNeedsOpenssl(
    'the default CN carries the UTC date; an explicit --cn wins',
    () => {
      // 23:30 UTC is already the next day east of Greenwich: the date must be
      // the UTC one, or two operators in two zones name one day differently.
      const now = Date.UTC(2029, 0, 2, 23, 30)
      const dated = join(root, 'dated')
      initCa({ directory: dated, now })
      expect(new X509Certificate(readFileSync(caCertPath(dated))).subject).toBe(
        'CN=qianmo-ca-20290102',
      )

      const named = join(root, 'named')
      initCa({ directory: named, commonName: 'qianmo-ca', now })
      expect(new X509Certificate(readFileSync(caCertPath(named))).subject).toBe(
        'CN=qianmo-ca',
      )
      // The first production root is CN=qianmo-ca; a default-named root made
      // on any day is not.
      expect(
        new X509Certificate(readFileSync(caCertPath(caDir))).subject,
      ).toMatch(/^CN=qianmo-ca-\d{8}$/)
    },
  )

  itNeedsOpenssl(
    'a second init on the same day: one directory refuses, two directories collide',
    () => {
      const now = Date.UTC(2029, 8, 15, 8)
      const first = join(root, 'same-day')
      initCa({ directory: first, now })
      const before = readFileSync(caCertPath(first), 'utf8')
      // Same directory: init itself stops it, and the first root is untouched.
      expect(() => initCa({ directory: first, now })).toThrow(
        /a CA already exists/,
      )
      expect(readFileSync(caCertPath(first), 'utf8')).toBe(before)

      // Another directory on the same UTC day gets the same default name, and
      // init has no way to know. The collision surfaces where both roots meet:
      // a --trust-ca file holding them is refused at startup.
      const second = join(root, 'same-day-2')
      initCa({ directory: second, now })
      expect(() =>
        parseTrustAnchors(
          before + readFileSync(caCertPath(second), 'utf8'),
          'test',
        ),
      ).toThrow(/two roots share the subject CN=qianmo-ca-20290915/)
    },
  )
})

describe('qm ca issue', () => {
  itNeedsOpenssl(
    'writes all three SAN classes and reads them back (F-1/F-3)',
    () => {
      const issued = issueForTest()
      const certificate = new X509Certificate(issued.certificatePem)

      // F-1: openssl signed a leaf carrying both URI SANs under an Ed25519 root.
      expect(certificate.subjectAltName).toContain('URI:qianmo://node-a')
      expect(certificate.subjectAltName).toContain(
        `URI:${NODE_KEY_URI_SCHEME}${nodeKeys.publicKey}`,
      )
      // F-9: the host SANs are there, and the two classes landed on the right
      // types — an IP written as a DNS name is a certificate nobody can dial.
      expect(certificate.subjectAltName).toContain('DNS:localhost')
      expect(certificate.subjectAltName).toContain('IP Address:127.0.0.1')

      // F-3: the key in the SAN is exactly the 43-character string the node
      // publishes as `AgentRecord.publicKey` — no second encoding.
      const binding = parseNodeCertificateBinding(certificate.subjectAltName)
      expect(binding).toEqual({
        node: 'node-a',
        publicKey: nodeKeys.publicKey,
        dnsNames: ['localhost'],
        ipAddresses: ['127.0.0.1'],
      })

      // F-2: a node can tell this is ours with zero dependencies.
      const rootCertificate = new X509Certificate(
        readFileSync(caCertPath(caDir)),
      )
      expect(certificate.verify(rootCertificate.publicKey)).toBe(true)

      const days =
        (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) /
        (24 * 60 * 60 * 1000)
      expect(Math.round(days)).toBe(NODE_CERT_DAYS)
    },
  )

  itNeedsOpenssl('the EC leaf is accepted by Bun.serve (F-6)', async () => {
    const issued = issueForTest()
    const server = Bun.serve({
      port: 0,
      tls: {
        cert: issued.certificatePem,
        key: readFileSync(nodeTlsKeyPath, 'utf8'),
      },
      fetch: () => new Response('ok'),
    })
    try {
      const caPem = readFileSync(caCertPath(caDir), 'utf8')
      // Both spellings of the same node, because both are in the SANs and
      // Bun checks the dialed name against them (F-9).
      const byIp = await fetch(`https://127.0.0.1:${server.port}/`, {
        tls: { ca: caPem },
      })
      expect(byIp.status).toBe(200)
      expect(await byIp.text()).toBe('ok')
      const byName = await fetch(`https://localhost:${server.port}/`, {
        tls: { ca: caPem },
      })
      expect(byName.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  itNeedsOpenssl(
    'a certificate missing the dialed host is refused by the client (F-9)',
    async () => {
      // The mistake §4.2 says is easiest to make, reproduced: SANs that do not
      // cover the address peers dial. `--host` is required precisely because
      // this failure surfaces on somebody else's machine, months later.
      const issued = issueForTest({
        hosts: ['elsewhere.example'],
        outPath: join(root, 'wrong-host.crt'),
      })
      const server = Bun.serve({
        port: 0,
        tls: {
          cert: issued.certificatePem,
          key: readFileSync(nodeTlsKeyPath, 'utf8'),
        },
        fetch: () => new Response('ok'),
      })
      try {
        const attempt = fetch(`https://127.0.0.1:${server.port}/`, {
          tls: { ca: readFileSync(caCertPath(caDir), 'utf8') },
        })
        await expect(attempt).rejects.toThrow()
      } finally {
        server.stop(true)
      }
    },
  )

  itNeedsOpenssl('refuses a request whose proof of possession fails', () => {
    const impostor = generateNodeKeyPair()
    expect(() =>
      issueForTest({
        popSignature: signBytes(impostor, popMessage('node-a', csrPem)),
      }),
    ).toThrow(/proof of possession failed/)

    // And the shape that matters: claiming somebody else's public key while
    // holding a valid proof for your own.
    expect(() =>
      issueCertificate({
        directory: caDir,
        node: 'node-a',
        publicKey: impostor.publicKey,
        csrPem,
        popSignature: signBytes(nodeKeys, popMessage('node-a', csrPem)),
        hosts: ['localhost'],
      }),
    ).toThrow(/proof of possession failed/)
  })

  itNeedsOpenssl('refuses an Ed25519 leaf before signing it (F-5)', () => {
    const edKeyPath = join(root, 'ed.key')
    writeFileSync(edKeyPath, runOpenssl(['genpkey', '-algorithm', 'ed25519']), {
      mode: 0o600,
    })
    const edCsr = runOpenssl([
      'req',
      '-new',
      '-key',
      edKeyPath,
      '-subj',
      '/CN=node-a',
    ])
    expect(() =>
      issueCertificate({
        directory: caDir,
        node: 'node-a',
        publicKey: nodeKeys.publicKey,
        csrPem: edCsr,
        popSignature: signBytes(nodeKeys, popMessage('node-a', edCsr)),
        hosts: ['localhost'],
      }),
    ).toThrow(/must be\s+EC/)
  })

  itNeedsOpenssl('refuses a request with no host at all (F-9)', () => {
    expect(() => issueForTest({ hosts: [] })).toThrow(/--host is required/)
  })

  itNeedsOpenssl(
    'refuses a malformed CSR as a CSR, not as a failed proof',
    () => {
      expect(() =>
        issueCertificate({
          directory: caDir,
          node: 'node-a',
          publicKey: nodeKeys.publicKey,
          csrPem:
            '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n',
          popSignature: 'A'.repeat(86),
          hosts: ['localhost'],
        }),
      ).toThrow(/openssl/)
    },
  )
})

describe('qm ca refresh-rl', () => {
  itNeedsOpenssl('signs a list the CA certificate verifies', () => {
    const issued = issueForTest()
    const first = refreshRevocationList({
      directory: caDir,
      revoke: [
        {
          node: 'node-a',
          fingerprint256: issued.fingerprint256,
          reason: 'drill',
        },
      ],
    })
    expect(first.added).toBe(1)
    expect(first.path).toBe(revocationListPath(caDir))

    const published: unknown = JSON.parse(readFileSync(first.path, 'utf8'))
    const verified = verifyRevocationList(ca.publicKey, published)
    expect(verified?.revoked).toEqual([
      {
        node: 'node-a',
        fingerprint256: issued.fingerprint256,
        reason: 'drill',
        at: expect.any(Number),
      },
    ])
    expect((verified?.nextUpdate ?? 0) - (verified?.issuedAt ?? 0)).toBe(
      30 * 24 * 60 * 60 * 1000,
    )
  })

  itNeedsOpenssl('re-adding a known fingerprint is a no-op', () => {
    const current = verifyRevocationList(
      ca.publicKey,
      JSON.parse(readFileSync(revocationListPath(caDir), 'utf8')),
    )
    const known = current?.revoked[0]?.fingerprint256 ?? ''
    const again = refreshRevocationList({
      directory: caDir,
      // The same fingerprint, typed the way the other tool prints it: lower
      // case, no colons. A revocation that silently fails to match is the one
      // typo this command must not have.
      revoke: [
        {
          node: 'node-a',
          fingerprint256: known.replace(/:/g, '').toLowerCase(),
        },
      ],
    })
    expect(again.added).toBe(0)
    expect(again.list.revoked).toHaveLength(current?.revoked.length ?? 0)
  })

  itNeedsOpenssl('a plain re-sign moves the dates and nothing else', () => {
    const before = JSON.parse(
      readFileSync(revocationListPath(caDir), 'utf8'),
    ) as { payload: string }
    const previous = verifyRevocationList(ca.publicKey, before)
    // `now` is passed rather than read, because a re-sign inside the same
    // millisecond would produce identical bytes and prove nothing.
    const result = refreshRevocationList({
      directory: caDir,
      now: Date.now() + 60_000,
    })
    const after = JSON.parse(readFileSync(result.path, 'utf8')) as {
      payload: string
    }
    expect(result.added).toBe(0)
    expect(after.payload).not.toBe(before.payload)
    expect(result.list.revoked).toEqual(previous?.revoked ?? [])
  })

  itNeedsOpenssl('refuses to run without a CA', () => {
    expect(() =>
      refreshRevocationList({ directory: join(root, 'nothing-here') }),
    ).toThrow(/no CA at/)
  })
})

/**
 * Handing the RL to a new root (ca-runbook.md §6.2, root rotation step 5).
 * Nodes keep the list append-only (§6.4), so the new root's first list has to
 * carry every entry the old root published — `importFrom` is how.
 */
describe('qm ca refresh-rl --import-from', () => {
  const fingerprint = (byte: string): string =>
    Array.from({ length: 32 }, () => byte).join(':')

  function rotation(name: string) {
    const oldDir = join(root, `${name}-old`)
    const newDir = join(root, `${name}-new`)
    initCa({ directory: oldDir, commonName: `${name}-old` })
    const fresh = initCa({ directory: newDir, commonName: `${name}-new` })
    const t0 = Date.now()
    refreshRevocationList({
      directory: oldDir,
      revoke: [
        {
          node: 'node-a',
          fingerprint256: fingerprint('A1'),
          reason: 'key lost',
        },
      ],
      now: t0,
    })
    refreshRevocationList({
      directory: oldDir,
      revoke: [{ node: 'node-b', fingerprint256: fingerprint('B2') }],
      now: t0 + 1_000,
    })
    return { oldDir, newDir, newPublicKey: fresh.publicKey, t0 }
  }

  function stateOf(directory: string): unknown {
    return JSON.parse(readFileSync(join(directory, 'revoked.json'), 'utf8'))
  }

  itNeedsOpenssl(
    'every old entry is in the list the new root signs, as it was recorded',
    () => {
      const { oldDir, newDir, newPublicKey, t0 } = rotation('carry')
      // The new root already revoked something of its own during the
      // overlap: a merge keeps it, a copy of the old file would not.
      refreshRevocationList({
        directory: newDir,
        revoke: [
          {
            node: 'node-c',
            fingerprint256: fingerprint('C3'),
            reason: 'drill',
          },
        ],
        now: t0 + 2_000,
      })
      const result = refreshRevocationList({
        directory: newDir,
        importFrom: oldDir,
        now: t0 + 3_000,
      })
      expect(result.imported).toBe(2)
      expect(result.added).toBe(0)

      const published: unknown = JSON.parse(readFileSync(result.path, 'utf8'))
      const verified = verifyRevocationList(newPublicKey, published)
      expect(verified?.revoked).toEqual([
        {
          node: 'node-a',
          fingerprint256: fingerprint('A1'),
          reason: 'key lost',
          at: t0,
        },
        {
          node: 'node-b',
          fingerprint256: fingerprint('B2'),
          reason: 'unspecified',
          at: t0 + 1_000,
        },
        {
          node: 'node-c',
          fingerprint256: fingerprint('C3'),
          reason: 'drill',
          at: t0 + 2_000,
        },
      ])
      // Signed by the new root, and only by it.
      const oldPublicKey = parseTrustAnchors(
        readFileSync(caCertPath(oldDir), 'utf8'),
        'test',
      ).anchors[0]?.publicKey
      expect(verifyRevocationList(oldPublicKey ?? '', published)).toBeNull()
      // The old directory is read, never written.
      expect(stateOf(oldDir)).toHaveLength(2)
    },
  )

  itNeedsOpenssl('importing again changes nothing but the dates', () => {
    const { oldDir, newDir, t0 } = rotation('again')
    const first = refreshRevocationList({
      directory: newDir,
      importFrom: oldDir,
      now: t0 + 2_000,
    })
    const stateBytes = readFileSync(join(newDir, 'revoked.json'), 'utf8')
    const second = refreshRevocationList({
      directory: newDir,
      importFrom: oldDir,
      now: t0 + 3_000,
    })
    expect(first.imported).toBe(2)
    expect(second.imported).toBe(0)
    expect(second.list.revoked).toEqual(first.list.revoked)
    expect(readFileSync(join(newDir, 'revoked.json'), 'utf8')).toBe(stateBytes)
    expect(second.list.issuedAt).toBeGreaterThan(first.list.issuedAt)
  })

  itNeedsOpenssl('refuses before writing anything', () => {
    const { oldDir, newDir, t0 } = rotation('refuse')
    const listPath = revocationListPath(newDir)
    const untouched = () => {
      expect(() => readFileSync(listPath)).toThrow()
      expect(() => readFileSync(join(newDir, 'revoked.json'))).toThrow()
    }

    // Its own directory: almost certainly a --ca-dir mix-up.
    expect(() =>
      refreshRevocationList({ directory: newDir, importFrom: newDir, now: t0 }),
    ).toThrow(/this CA's own directory/)
    untouched()

    // A directory with no revocation state: a wrong path, not "nothing to do".
    expect(() =>
      refreshRevocationList({
        directory: newDir,
        importFrom: join(root, 'refuse-nowhere'),
        now: t0,
      }),
    ).toThrow(/--import-from: no .*revoked\.json/)
    untouched()

    // A damaged file: refused whole, never partly imported.
    writeFileSync(join(oldDir, 'revoked.json'), '[{"node":"node-a"}')
    expect(() =>
      refreshRevocationList({ directory: newDir, importFrom: oldDir, now: t0 }),
    ).toThrow(/revoked\.json is not JSON/)
    writeFileSync(join(oldDir, 'revoked.json'), '[{"node":"node-a"}]\n')
    expect(() =>
      refreshRevocationList({ directory: newDir, importFrom: oldDir, now: t0 }),
    ).toThrow(/malformed revocation entry/)
    untouched()
  })
})
