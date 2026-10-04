// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `resident`'s `--trust-ca` / `--cert` / `--key` (key-distribution.md §8.1,
 * P12.2 DoD #1). Parsing needs no openssl; the directory-wiring and
 * self-check tests below issue real certificates with a real offline CA
 * (P12.1) — zero mocks, same discipline as `certificateDirectory.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import { CertificateDirectory } from '../../../services/qianmo/certificateDirectory.js'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
} from '../../../services/qianmo/ca/operations.js'
import { caCertPath } from '../../../services/qianmo/ca/paths.js'
import {
  opensslVersion,
  runOpenssl,
} from '../../../services/qianmo/ca/openssl.js'
import { popMessage } from '../../../services/qianmo/ca/pop.js'
import { StaticPublicKeyDirectory } from '@qianmo/capability'
import {
  assertOwnCertificateAndKey,
  buildHandshakeSigning,
  buildListenerTls,
  buildPublicKeyDirectory,
  parseResidentArgs,
} from '../resident.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

const BASE = [
  '--node',
  'node-a',
  '--team',
  'atlas',
  '--agent',
  'reviewer=/workspace',
  '--port',
  '7321',
  '--hostname',
  '127.0.0.1',
] as const

describe('resident argument parsing: --trust-ca / --cert / --key', () => {
  test('parses absolute paths for all three', () => {
    const parsed = parseResidentArgs(
      [
        ...BASE,
        '--trust-ca',
        '/tmp/ca.crt',
        '--cert',
        '/tmp/node-a.tls.crt',
        '--key',
        '/tmp/node-a.tls.key',
      ],
      'qianmo',
    )
    expect(parsed.trustCa).toBe('/tmp/ca.crt')
    expect(parsed.cert).toBe('/tmp/node-a.tls.crt')
    expect(parsed.key).toBe('/tmp/node-a.tls.key')
  })

  test('rejects relative paths for all three', () => {
    expect(() =>
      parseResidentArgs([...BASE, '--trust-ca', 'ca.crt'], 'qianmo'),
    ).toThrow('--trust-ca must be an absolute path')
    expect(() =>
      parseResidentArgs(
        [...BASE, '--cert', 'a.crt', '--key', '/tmp/a.key'],
        'qianmo',
      ),
    ).toThrow('--cert must be an absolute path')
    expect(() =>
      parseResidentArgs(
        [...BASE, '--cert', '/tmp/a.crt', '--key', 'a.key'],
        'qianmo',
      ),
    ).toThrow('--key must be an absolute path')
  })

  test('--cert and --key are required together', () => {
    expect(() =>
      parseResidentArgs([...BASE, '--cert', '/tmp/a.crt'], 'qianmo'),
    ).toThrow('--cert requires --key')
    expect(() =>
      parseResidentArgs([...BASE, '--key', '/tmp/a.key'], 'qianmo'),
    ).toThrow('--key requires --cert')
    // Together, or neither, is fine.
    expect(() =>
      parseResidentArgs(
        [...BASE, '--cert', '/tmp/a.crt', '--key', '/tmp/a.key'],
        'qianmo',
      ),
    ).not.toThrow()
  })

  test('--trust-ca does not require --cert/--key, and vice versa', () => {
    expect(() =>
      parseResidentArgs([...BASE, '--trust-ca', '/tmp/ca.crt'], 'qianmo'),
    ).not.toThrow()
  })
})

describe('buildPublicKeyDirectory', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-directory-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('with no --trust-ca: a StaticPublicKeyDirectory, carrying --trust', () => {
    const peer = generateNodeKeyPair().publicKey
    const directory = buildPublicKeyDirectory({
      node: 'node-a',
      team: 'atlas',
      agents: [],
      trusted: [['node-b', peer]],
      requireSignedTasks: false,
      auditSignedTasks: false,
    })
    expect(directory).toBeInstanceOf(StaticPublicKeyDirectory)
    expect(directory.publicKeyOf('node-b')).toBe(peer)
  })

  itNeedsOpenssl(
    'with --trust-ca: a CertificateDirectory, carrying --trust too',
    () => {
      const caDir = join(root, 'ca')
      initCa({ directory: caDir })
      const caCertPath = join(caDir, 'ca.crt')
      const peer = generateNodeKeyPair().publicKey
      const directory = buildPublicKeyDirectory({
        node: 'node-a',
        team: 'atlas',
        agents: [],
        trusted: [['node-b', peer]],
        requireSignedTasks: false,
        auditSignedTasks: false,
        trustCa: caCertPath,
      })
      expect(directory).toBeInstanceOf(CertificateDirectory)
      expect(directory.publicKeyOf('node-b')).toBe(peer)
    },
  )
})

describe('assertOwnCertificateAndKey (K-2, one of the four negative cases)', () => {
  let root: string
  let caDir: string
  let nodeKeys: NodeKeyPair
  let certificatePath: string
  let ecKeyPath: string

  beforeEach(() => {
    if (OPENSSL === null) return
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-cert-check-'))
    caDir = join(root, 'ca')
    initCa({ directory: caDir })
    nodeKeys = generateNodeKeyPair()
    ecKeyPath = join(root, 'node-a.tls.key')
    writeFileSync(
      ecKeyPath,
      runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
      { mode: 0o600 },
    )
    const csrPem = runOpenssl([
      'req',
      '-new',
      '-key',
      ecKeyPath,
      '-subj',
      '/CN=node-a',
    ])
    const issued = issueCertificate({
      directory: caDir,
      node: 'node-a',
      publicKey: nodeKeys.publicKey,
      csrPem,
      popSignature: signBytes(nodeKeys, popMessage('node-a', csrPem)),
      hosts: ['node-a.example.com'],
    })
    certificatePath = join(root, 'node-a.tls.crt')
    writeFileSync(certificatePath, issued.certificatePem)
  })

  afterEach(() => {
    if (OPENSSL !== null) rmSync(root, { recursive: true, force: true })
  })

  itNeedsOpenssl('a matching --cert/--key pair passes', () => {
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          auditSignedTasks: false,
          cert: certificatePath,
          key: ecKeyPath,
        },
        nodeKeys.publicKey,
      ),
    ).not.toThrow()
  })

  itNeedsOpenssl(
    'a valid EC key from another pair is refused before listen',
    () => {
      const otherEcKeyPath = join(root, 'node-a.other.tls.key')
      writeFileSync(
        otherEcKeyPath,
        runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
        { mode: 0o600 },
      )
      expect(() =>
        assertOwnCertificateAndKey(
          {
            node: 'node-a',
            team: 'atlas',
            agents: [],
            trusted: [],
            requireSignedTasks: false,
            auditSignedTasks: false,
            cert: certificatePath,
            key: otherEcKeyPath,
          },
          nodeKeys.publicKey,
        ),
      ).toThrow(/do not form a matching public\/private key pair/)
    },
  )

  itNeedsOpenssl("--cert naming a different node's identity is refused", () => {
    const impostorKey = generateNodeKeyPair().publicKey
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          auditSignedTasks: false,
          cert: certificatePath,
          key: ecKeyPath,
        },
        impostorKey,
      ),
    ).toThrow(/nodekey does not match identity/)
  })

  itNeedsOpenssl('a non-EC --key (Ed25519) is refused (F-5)', () => {
    const ed25519KeyPath = join(root, 'wrong-type.key')
    writeFileSync(
      ed25519KeyPath,
      runOpenssl(['genpkey', '-algorithm', 'ed25519']),
    )
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          auditSignedTasks: false,
          cert: certificatePath,
          key: ed25519KeyPath,
        },
        nodeKeys.publicKey,
      ),
    ).toThrow(/--key must be an EC private key/)
  })

  itNeedsOpenssl('an unparseable --key is refused with a clear message', () => {
    const junkKeyPath = join(root, 'junk.key')
    writeFileSync(junkKeyPath, 'not a key at all')
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          auditSignedTasks: false,
          cert: certificatePath,
          key: junkKeyPath,
        },
        nodeKeys.publicKey,
      ),
    ).toThrow(/--key does not parse as a private key/)
  })

  test('with neither flag, nothing is checked and nothing throws', () => {
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          auditSignedTasks: false,
        },
        generateNodeKeyPair().publicKey,
      ),
    ).not.toThrow()
  })
})

/**
 * P12.3's node-side wiring: the registry poll, the mTLS triple, the signing
 * switch, and the one startup check P12.2's audit handed over.
 *
 * Still zero mocks — the registry below is a real `Bun.serve` answering with a
 * real CA-issued certificate and a real CA-signed revocation list, because
 * what is being tested is precisely whether those two documents make it all
 * the way from a URL into `publicKeyOf`.
 */
describe('resident argument parsing: P12.3 switches', () => {
  test('--registry-url takes an http(s) URL and requires --trust-ca', () => {
    const parsed = parseResidentArgs(
      [
        ...BASE,
        '--trust-ca',
        '/tmp/ca.crt',
        '--registry-url',
        'http://127.0.0.1:8787',
      ],
      'qianmo',
    )
    expect(parsed.registryUrl).toBe('http://127.0.0.1:8787/')
    // Without a root there is nothing to check a published certificate
    // against, so polling would be a network call pretending to be a feature.
    expect(() =>
      parseResidentArgs(
        [...BASE, '--registry-url', 'http://127.0.0.1:1'],
        'qianmo',
      ),
    ).toThrow('--registry-url requires --trust-ca')
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--trust-ca',
          '/tmp/ca.crt',
          '--registry-url',
          'ws://127.0.0.1:1',
        ],
        'qianmo',
      ),
    ).toThrow('--registry-url must use http or https')
  })

  test('handshake signing is off unless asked for, and require implies sign', () => {
    // The default is the whole of "this package only makes it possible to
    // turn on" — an unflagged node behaves exactly as it did before P12.3.
    const base = parseResidentArgs(BASE, 'qianmo')
    expect(base.signHandshake).toBeUndefined()
    expect(base.requireSignedHandshake).toBeUndefined()

    expect(
      parseResidentArgs([...BASE, '--sign-handshake'], 'qianmo'),
    ).toMatchObject({
      signHandshake: true,
    })
    const strict = parseResidentArgs(
      [...BASE, '--require-signed-handshake'],
      'qianmo',
    )
    // Refusing unsigned peers while sending an unsigned frame yourself is a
    // configuration nobody means to write, and it would fail only against the
    // peers that had already upgraded.
    expect(strict.signHandshake).toBe(true)
    expect(strict.requireSignedHandshake).toBe(true)
  })
})

describe('buildHandshakeSigning', () => {
  const config = {
    node: 'node-a',
    team: 'atlas',
    agents: [],
    trusted: [],
    requireSignedTasks: false,
    auditSignedTasks: false,
  } as const

  test('absent without the flag', () => {
    const keys = generateNodeKeyPair()
    expect(
      buildHandshakeSigning(config, keys, new StaticPublicKeyDirectory()),
    ).toBeUndefined()
  })

  test('carries this node, its keys, and the directory the gate reads', () => {
    const keys = generateNodeKeyPair()
    const directory = new StaticPublicKeyDirectory()
    const signing = buildHandshakeSigning(
      { ...config, signHandshake: true },
      keys,
      directory,
    )
    expect(signing?.node).toBe('node-a')
    expect(signing?.keys).toBe(keys)
    // The same object, deliberately: a node that accepts a peer's token but
    // not its handshake has two answers to one question.
    expect(signing?.directory).toBe(directory)
    expect(signing?.required).toBeUndefined()

    const strictSigned = buildHandshakeSigning(
      { ...config, signHandshake: true, requireSignedHandshake: true },
      keys,
      directory,
    )
    expect(strictSigned?.required).toBe(true)
    // Signature-required and credential-required are distinct rollout axes.
    // A non-CA deployment must not be forced to invent a certificate selector.
    expect(strictSigned?.credentialProofRequired).toBeUndefined()
  })
})

describe('P12.3 node-side wiring', () => {
  let root: string
  let caDir: string
  let nodeKeys: NodeKeyPair
  let certificatePath: string
  let ecKeyPath: string
  let certificatePem: string

  beforeEach(() => {
    if (OPENSSL === null) return
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-p123-'))
    caDir = join(root, 'ca')
    initCa({ directory: caDir })
    nodeKeys = generateNodeKeyPair()
    ecKeyPath = join(root, 'node-a.tls.key')
    writeFileSync(
      ecKeyPath,
      runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
      { mode: 0o600 },
    )
    const csrPem = runOpenssl([
      'req',
      '-new',
      '-key',
      ecKeyPath,
      '-subj',
      '/CN=node-a',
    ])
    const issued = issueCertificate({
      directory: caDir,
      node: 'node-a',
      publicKey: nodeKeys.publicKey,
      csrPem,
      popSignature: signBytes(nodeKeys, popMessage('node-a', csrPem)),
      hosts: ['localhost', '127.0.0.1'],
    })
    certificatePem = issued.certificatePem
    certificatePath = join(root, 'node-a.tls.crt')
    writeFileSync(certificatePath, certificatePem)
  })

  afterEach(() => {
    if (OPENSSL !== null) rmSync(root, { recursive: true, force: true })
  })

  itNeedsOpenssl(
    'handover B: a certificate signed by another CA is refused at startup',
    () => {
      // The failure this catches would otherwise survive until the first
      // handshake: the node presents its certificate happily and every peer
      // refuses it, with nothing on this machine saying why.
      const otherCa = join(root, 'other-ca')
      initCa({ directory: otherCa })
      const config = {
        node: 'node-a',
        team: 'atlas',
        agents: [],
        trusted: [],
        requireSignedTasks: false,
        auditSignedTasks: false,
        cert: certificatePath,
        key: ecKeyPath,
        trustCa: caCertPath(otherCa),
      } as const
      expect(() =>
        assertOwnCertificateAndKey(config, nodeKeys.publicKey),
      ).toThrow(/was not signed by the CA in --trust-ca/)
      // Same certificate, the CA that actually signed it: no complaint.
      expect(() =>
        assertOwnCertificateAndKey(
          { ...config, trustCa: caCertPath(caDir) },
          nodeKeys.publicKey,
        ),
      ).not.toThrow()
    },
  )

  itNeedsOpenssl('buildListenerTls emits the whole triple, or nothing', () => {
    const warnings: string[] = []
    const config = {
      node: 'node-a',
      team: 'atlas',
      agents: [],
      trusted: [],
      requireSignedTasks: false,
      auditSignedTasks: false,
      port: 7321,
      hostname: '127.0.0.1',
      cert: certificatePath,
      key: ecKeyPath,
      trustCa: caCertPath(caDir),
    } as const

    const materials = buildListenerTls(config, message =>
      warnings.push(message),
    )
    expect(materials?.tls).toMatchObject({
      requestCert: true,
      rejectUnauthorized: true,
    })
    expect(materials?.tls.ca).toContain('BEGIN CERTIFICATE')
    // Read off the certificate, not configured twice: two places to say when a
    // certificate expires is two places that can disagree.
    expect(materials?.certificateNotAfter).toBe(
      Date.parse(new X509Certificate(certificatePem).validTo),
    )
    expect(warnings).toEqual([])

    // Missing the root: no TLS at all, and it says so. Serving plaintext while
    // looking configured is the outcome this refuses to produce silently.
    const { trustCa: _omitted, ...withoutRoot } = config
    expect(
      buildListenerTls(withoutRoot, message => warnings.push(message)),
    ).toBeNull()
    expect(warnings.join('\n')).toContain('mTLS is NOT enabled')

    // A unix socket has no TLS to speak of; the certificate is still checked
    // against this node's identity, so this is a note rather than a fault.
    warnings.length = 0
    const { port: _port, hostname: _hostname, ...onUnix } = config
    expect(
      buildListenerTls({ ...onUnix, unix: '/tmp/qianmo-test.sock' }, message =>
        warnings.push(message),
      ),
    ).toBeNull()
    expect(warnings.join('\n')).toContain('unix socket')

    // No certificate at all is the ordinary case and says nothing.
    warnings.length = 0
    expect(
      buildListenerTls(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          auditSignedTasks: false,
        },
        message => warnings.push(message),
      ),
    ).toBeNull()
    expect(warnings).toEqual([])
  })

  itNeedsOpenssl(
    'strict CA handshake carries this node certificate fingerprint',
    () => {
      const config = {
        node: 'node-a',
        team: 'atlas',
        agents: [],
        trusted: [],
        requireSignedTasks: false,
        auditSignedTasks: false,
        signHandshake: true,
        requireSignedHandshake: true,
        cert: certificatePath,
        key: ecKeyPath,
        trustCa: caCertPath(caDir),
      } as const
      const directory = buildPublicKeyDirectory(config)
      const signing = buildHandshakeSigning(config, nodeKeys, directory)
      const fingerprint = new X509Certificate(certificatePem).fingerprint256
      expect(signing?.credential).toEqual({
        selector: fingerprint,
        source: 'certificate',
        id: fingerprint,
      })
      expect(signing?.required).toBe(true)
      expect(signing?.credentialProofRequired).toBe(true)
    },
  )

  itNeedsOpenssl(
    'handover A: --registry-url reaches publicKeyOf, through a real registry',
    async () => {
      // A peer, its certificate published where the registry would publish it.
      const peerKeys = generateNodeKeyPair()
      const peerKeyPath = join(root, 'node-b.tls.key')
      writeFileSync(
        peerKeyPath,
        runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
        { mode: 0o600 },
      )
      const peerCsr = runOpenssl([
        'req',
        '-new',
        '-key',
        peerKeyPath,
        '-subj',
        '/CN=node-b',
      ])
      const peerCert = issueCertificate({
        directory: caDir,
        node: 'node-b',
        publicKey: peerKeys.publicKey,
        csrPem: peerCsr,
        popSignature: signBytes(peerKeys, popMessage('node-b', peerCsr)),
        hosts: ['localhost'],
        outPath: join(root, 'node-b.tls.crt'),
      })
      // A fresh, CA-signed revocation list: without one the directory
      // fail-closes to the --trust entries (§6.4) and would answer `null`
      // however good the certificate is.
      const rl = refreshRevocationList({ directory: caDir })
      const revocationList: unknown = JSON.parse(readFileSync(rl.path, 'utf8'))

      const registry = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          const path = new URL(request.url).pathname
          if (path === '/v0/revocation-list')
            return Response.json(revocationList)
          if (path === '/v0/agents') {
            return Response.json({
              agents: [
                {
                  address: 'qianmo://node-b/reviewer',
                  publicKey: peerKeys.publicKey,
                  certificate: peerCert.certificatePem,
                },
              ],
            })
          }
          return new Response('not found', { status: 404 })
        },
      })

      try {
        const directory = buildPublicKeyDirectory({
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          auditSignedTasks: false,
          trustCa: caCertPath(caDir),
          registryUrl: `http://127.0.0.1:${registry.port}`,
        })
        expect(directory).toBeInstanceOf(CertificateDirectory)
        // Nothing before the first refresh — `publicKeyOf` is synchronous and
        // only ever reads what the last refresh built.
        expect(directory.publicKeyOf('node-b')).toBeNull()
        await (directory as CertificateDirectory).refresh()
        expect(directory.publicKeyOf('node-b')).toBe(peerKeys.publicKey)
      } finally {
        registry.stop(true)
      }
    },
  )

  itNeedsOpenssl(
    'with no --registry-url the directory has no network source',
    async () => {
      const directory = buildPublicKeyDirectory({
        node: 'node-a',
        team: 'atlas',
        agents: [],
        trusted: [['node-b', generateNodeKeyPair().publicKey]],
        requireSignedTasks: false,
        auditSignedTasks: false,
        trustCa: caCertPath(caDir),
      }) as CertificateDirectory
      // Refreshing is a no-op that re-applies the explicit entries: the same
      // state a stale revocation list degrades to, and the honest default.
      await directory.refresh()
      expect(directory.snapshot().size).toBe(1)
      expect(directory.revocationListFresh).toBe(false)
    },
  )
})
