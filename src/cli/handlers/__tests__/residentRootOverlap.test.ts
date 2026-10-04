// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Root rotation overlap (key-distribution.md §3.3): one `--trust-ca` file
 * holding the old and the new root, and the two layers that read it agreeing.
 *
 * The two layers are the ones a node actually builds from its flags:
 *
 * - **directory** — `buildPublicKeyDirectory`, i.e. `CertificateDirectory`
 *   fed from a registry, answering `publicKeyOf`;
 * - **TLS** — `buildListenerTls`, whose `ca` is the only trust material the
 *   node hands Bun. It is exercised on the dialing side of a real `wss://`
 *   connection, because that is the side Bun 1.3.13 checks a chain on: a
 *   listener enforces that a client certificate was presented, not what it
 *   chains to (`packages/transport/test/mtls.test.ts` pins that limit).
 *
 * The same four facts are asserted in both layers: with both roots, a leaf
 * under either is accepted; with the old root removed, the old leaf is refused
 * and the new one still accepted. Plus the startup refusal for a damaged file,
 * in every reader, next to the measurement of why it has to exist.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  TransportClient,
  startTransportServer,
  type ClientTlsOptions,
  type TransportServerHandle,
} from '@qianmo/transport'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
} from '../../../services/qianmo/ca/operations.js'
import {
  opensslVersion,
  runOpenssl,
} from '../../../services/qianmo/ca/openssl.js'
import { caCertPath } from '../../../services/qianmo/ca/paths.js'
import { popMessage } from '../../../services/qianmo/ca/pop.js'
import type { CertificateDirectory } from '../../../services/qianmo/certificateDirectory.js'
import { createCertificatePort } from '../consolePorts.js'
import {
  assertOwnCertificateAndKey,
  buildListenerTls,
  buildPublicKeyDirectory,
  type ResidentCliConfig,
} from '../resident.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

/** Not a secret: the pre-shared key both ends of a test link agree on. */
const PSK = 'test-psk-not-a-real-secret-0000'

interface Leaf {
  readonly node: string
  readonly keys: NodeKeyPair
  readonly certPath: string
  readonly keyPath: string
  readonly pem: string
}

let root: string
let oldDir: string
let newDir: string
let bothRoots: string
let newRootOnly: string
let oldLeaf: Leaf
let newLeaf: Leaf

function issueLeaf(directory: string, node: string): Leaf {
  const keys = generateNodeKeyPair()
  const keyPath = join(root, `${node}.tls.key`)
  writeFileSync(
    keyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  const csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    keyPath,
    '-subj',
    `/CN=${node}`,
  ])
  const certPath = join(root, `${node}.tls.crt`)
  const issued = issueCertificate({
    directory,
    node,
    publicKey: keys.publicKey,
    csrPem,
    popSignature: signBytes(keys, popMessage(node, csrPem)),
    hosts: ['localhost', '127.0.0.1'],
    outPath: certPath,
  })
  return { node, keys, certPath, keyPath, pem: issued.certificatePem }
}

function nodeConfig(
  leaf: Leaf,
  trustCa: string,
  extra: Partial<ResidentCliConfig> = {},
): ResidentCliConfig {
  return {
    node: leaf.node,
    team: 'atlas',
    agents: [],
    trusted: [],
    requireSignedTasks: false,
    auditSignedTasks: false,
    port: 0,
    hostname: '127.0.0.1',
    cert: leaf.certPath,
    key: leaf.keyPath,
    trustCa,
    ...extra,
  }
}

beforeAll(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-root-overlap-'))
  oldDir = join(root, 'ca-old')
  newDir = join(root, 'ca-new')
  // Named like the production root, which predates the dated default CN.
  initCa({ directory: oldDir, commonName: 'qianmo-ca' })
  // A new root gets a new name: the file refuses two roots called the same.
  initCa({ directory: newDir, commonName: 'qianmo-ca-next' })
  oldLeaf = issueLeaf(oldDir, 'node-old')
  newLeaf = issueLeaf(newDir, 'node-new')

  const oldPem = readFileSync(caCertPath(oldDir), 'utf8')
  const newPem = readFileSync(caCertPath(newDir), 'utf8')
  // What the runbook tells an operator to do: concatenate, old then new.
  bothRoots = join(root, 'trust-both.pem')
  writeFileSync(bothRoots, oldPem + newPem)
  newRootOnly = join(root, 'trust-new.pem')
  writeFileSync(newRootOnly, newPem)
})

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Directory layer
// ---------------------------------------------------------------------------

/** A registry face publishing both nodes and one signed RL. */
function registryPublishing(revocationList: unknown) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/v0/revocation-list') return Response.json(revocationList)
      if (path === '/v0/agents') {
        return Response.json({
          agents: [oldLeaf, newLeaf].map(leaf => ({
            address: `qianmo://${leaf.node}/reviewer`,
            publicKey: leaf.keys.publicKey,
            certificate: leaf.pem,
          })),
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

async function resolvedThrough(
  trustCa: string,
  rlDirectory: string,
): Promise<{ old: string | null; new: string | null }> {
  const rl = refreshRevocationList({ directory: rlDirectory })
  const registry = registryPublishing(JSON.parse(readFileSync(rl.path, 'utf8')))
  try {
    const directory = buildPublicKeyDirectory({
      ...nodeConfig(newLeaf, trustCa),
      node: 'node-observer',
      registryUrl: `http://127.0.0.1:${registry.port}`,
    }) as CertificateDirectory
    await directory.refresh()
    return {
      old: directory.publicKeyOf('node-old'),
      new: directory.publicKeyOf('node-new'),
    }
  } finally {
    registry.stop(true)
  }
}

describe('directory layer: every root in --trust-ca counts', () => {
  itNeedsOpenssl(
    'both roots: a peer under each root resolves (RL signed by the new root)',
    async () => {
      const resolved = await resolvedThrough(bothRoots, newDir)
      expect(resolved.old).toBe(oldLeaf.keys.publicKey)
      expect(resolved.new).toBe(newLeaf.keys.publicKey)
    },
  )

  itNeedsOpenssl(
    'both roots: an RL signed by the old root is just as good during overlap',
    async () => {
      const resolved = await resolvedThrough(bothRoots, oldDir)
      expect(resolved.old).toBe(oldLeaf.keys.publicKey)
      expect(resolved.new).toBe(newLeaf.keys.publicKey)
    },
  )

  itNeedsOpenssl(
    'old root removed: the old peer stops resolving, the new one does not',
    async () => {
      const resolved = await resolvedThrough(newRootOnly, newDir)
      expect(resolved.old).toBeNull()
      expect(resolved.new).toBe(newLeaf.keys.publicKey)
    },
  )

  itNeedsOpenssl(
    'old root removed: its RL no longer verifies, so the directory fails closed',
    async () => {
      // §6.4: an RL nobody in the file signed is no RL, and without a fresh
      // one only --trust answers. This is the operational trap the runbook
      // warns about — switch the RL signer before dropping the old root.
      const resolved = await resolvedThrough(newRootOnly, oldDir)
      expect(resolved.old).toBeNull()
      expect(resolved.new).toBeNull()
    },
  )

  itNeedsOpenssl(
    'a node’s own certificate under either root passes the startup check',
    () => {
      for (const leaf of [oldLeaf, newLeaf]) {
        expect(() =>
          assertOwnCertificateAndKey(
            nodeConfig(leaf, bothRoots),
            leaf.keys.publicKey,
          ),
        ).not.toThrow()
      }
      expect(() =>
        assertOwnCertificateAndKey(
          nodeConfig(oldLeaf, newRootOnly),
          oldLeaf.keys.publicKey,
        ),
      ).toThrow(/was not signed by the CA in --trust-ca/)
    },
  )
})

describe('handing the RL to the new root (ca-runbook.md §6.2 step 5)', () => {
  itNeedsOpenssl(
    'a new-root list without the old entries is refused; with --import-from it lands',
    async () => {
      // Directories of its own: the RL state of the two above belongs to the
      // tests above.
      const fromDir = join(root, 'rl-from')
      const toDir = join(root, 'rl-to')
      initCa({ directory: fromDir, commonName: 'qianmo-rl-from' })
      initCa({ directory: toDir, commonName: 'qianmo-rl-to' })
      const peer = issueLeaf(toDir, 'node-peer')
      const peerFingerprint = new X509Certificate(peer.pem).fingerprint256
      const trust = join(root, 'trust-rl.pem')
      writeFileSync(
        trust,
        readFileSync(caCertPath(fromDir), 'utf8') +
          readFileSync(caCertPath(toDir), 'utf8'),
      )

      let published: unknown = null
      const registry = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          const path = new URL(request.url).pathname
          if (path === '/v0/revocation-list' && published !== null) {
            return Response.json(published)
          }
          if (path === '/v0/agents') {
            return Response.json({
              agents: [
                {
                  address: `qianmo://${peer.node}/reviewer`,
                  publicKey: peer.keys.publicKey,
                  certificate: peer.pem,
                },
              ],
            })
          }
          return new Response('not found', { status: 404 })
        },
      })
      const publish = (signed: { readonly path: string }): void => {
        published = JSON.parse(readFileSync(signed.path, 'utf8'))
      }
      const refused: string[] = []
      try {
        const directory = buildPublicKeyDirectory(
          {
            ...nodeConfig(peer, trust),
            node: 'node-observer',
            registryUrl: `http://127.0.0.1:${registry.port}`,
          },
          undefined,
          event => refused.push(`${event.phase}: ${event.reason}`),
        ) as CertificateDirectory
        const t0 = Date.now()

        // The old root's list, naming a certificate long gone.
        publish(
          refreshRevocationList({
            directory: fromDir,
            revoke: [
              {
                node: 'node-gone',
                fingerprint256: Array.from({ length: 32 }, () => 'EE').join(
                  ':',
                ),
              },
            ],
            now: t0,
          }),
        )
        await directory.refresh()
        expect(refused).toEqual([])
        expect(directory.publicKeyOf('node-peer')).toBe(peer.keys.publicKey)

        // The new root revokes node-peer but carries nothing over. The node
        // refuses the whole list, so the new revocation does not land either.
        publish(
          refreshRevocationList({
            directory: toDir,
            revoke: [{ node: 'node-peer', fingerprint256: peerFingerprint }],
            now: t0 + 60_000,
          }),
        )
        await directory.refresh()
        expect(refused).toEqual([
          'revocation_list: refusing a revocation list that removes prior entries',
        ])
        expect(directory.publicKeyOf('node-peer')).toBe(peer.keys.publicKey)

        // Same new directory, the old entries imported: accepted, node-peer out.
        publish(
          refreshRevocationList({
            directory: toDir,
            importFrom: fromDir,
            now: t0 + 120_000,
          }),
        )
        await directory.refresh()
        expect(refused).toHaveLength(1)
        expect(directory.publicKeyOf('node-peer')).toBeNull()
      } finally {
        registry.stop(true)
      }
    },
  )
})

// ---------------------------------------------------------------------------
// TLS layer
// ---------------------------------------------------------------------------

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
})

/**
 * Dial `listener` over `wss://` with exactly the TLS material `dialer`'s
 * node config produces — `buildListenerTls` is the one place a node turns its
 * `--trust-ca` into a Bun `ca`.
 */
async function dial(
  listener: { readonly leaf: Leaf; readonly trustCa: string },
  dialer: { readonly leaf: Leaf; readonly trustCa: string },
): Promise<'connected' | 'refused'> {
  const listenerTls = buildListenerTls(
    nodeConfig(listener.leaf, listener.trustCa),
  )
  const dialerTls = buildListenerTls(nodeConfig(dialer.leaf, dialer.trustCa))
  if (listenerTls === null || dialerTls === null) {
    throw new Error('setup: both ends must have the full TLS triple')
  }
  const server = startTransportServer({
    port: 0,
    hostname: '127.0.0.1',
    psk: PSK,
    tls: listenerTls.tls,
    onMessage: () => {},
  })
  servers.push(server)
  const { cert, key, ca } = dialerTls.tls
  const tls: ClientTlsOptions = {
    cert: String(cert),
    key: String(key),
    ca: String(ca),
  }
  const client = new TransportClient({
    endpoint: { url: `wss://localhost:${server.port}/` },
    node: dialer.leaf.node,
    psk: PSK,
    tls,
    keepAliveIntervalMs: 0,
    backoff: { baseDelayMs: 10, maxDelayMs: 20, giveUpAfterMs: 200 },
  })
  clients.push(client)
  try {
    await client.connect(5_000)
    return client.isReady() ? 'connected' : 'refused'
  } catch {
    return 'refused'
  }
}

describe('TLS layer: the same roots, in the ca Bun is handed', () => {
  itNeedsOpenssl(
    'both roots: a listener under either root is accepted',
    async () => {
      expect(
        await dial(
          { leaf: oldLeaf, trustCa: bothRoots },
          { leaf: newLeaf, trustCa: bothRoots },
        ),
      ).toBe('connected')
      expect(
        await dial(
          { leaf: newLeaf, trustCa: bothRoots },
          { leaf: oldLeaf, trustCa: bothRoots },
        ),
      ).toBe('connected')
    },
  )

  itNeedsOpenssl(
    'old root removed: the old listener is refused, the new one accepted',
    async () => {
      expect(
        await dial(
          { leaf: oldLeaf, trustCa: bothRoots },
          { leaf: newLeaf, trustCa: newRootOnly },
        ),
      ).toBe('refused')
      expect(
        await dial(
          { leaf: newLeaf, trustCa: bothRoots },
          { leaf: newLeaf, trustCa: newRootOnly },
        ),
      ).toBe('connected')
    },
  )
})

// ---------------------------------------------------------------------------
// A damaged file refuses startup — and why it has to be us that refuses
// ---------------------------------------------------------------------------

describe('a damaged --trust-ca refuses startup in every reader', () => {
  let damaged: string

  beforeAll(() => {
    if (OPENSSL === null) return
    damaged = join(root, 'trust-damaged.pem')
    writeFileSync(
      damaged,
      readFileSync(caCertPath(oldDir), 'utf8') +
        '-----BEGIN CERTIFICATE-----\nAAAAbroken\n-----END CERTIFICATE-----\n' +
        readFileSync(caCertPath(newDir), 'utf8'),
    )
  })

  itNeedsOpenssl(
    'measured: Bun’s TLS stack skips the broken block silently',
    async () => {
      // This is the reason the refusal is ours. Handed the raw file, Bun
      // keeps the good roots and says nothing about the bad block, so a typo
      // in the file would shrink the trust set without a word.
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        tls: {
          cert: readFileSync(oldLeaf.certPath, 'utf8'),
          key: readFileSync(oldLeaf.keyPath, 'utf8'),
        },
        fetch: () => new Response('ok'),
      })
      try {
        const response = await fetch(`https://127.0.0.1:${server.port}/`, {
          tls: { ca: readFileSync(damaged, 'utf8') },
        })
        expect(response.status).toBe(200)
      } finally {
        server.stop(true)
      }
    },
  )

  itNeedsOpenssl(
    'measured: two same-named roots, a leaf without AKI — TLS picks by name',
    async () => {
      // Why the file refuses two roots with one subject. Two roots end up
      // with one name when `--cn` repeats the old one, or when both were made
      // with the dated default on the same UTC day. A leaf that carries no
      // authority key identifier then chains to whichever same-named root
      // Bun tries first, and the other root's leaves fail the signature
      // check — while a signature-only directory would accept both. Pinned
      // the way `mtls.test.ts` pins its limit: if a Bun upgrade turns this
      // red, re-measure before relaxing the same-subject refusal.
      const twinDir = join(root, 'ca-twin')
      initCa({ directory: twinDir, commonName: 'qianmo-ca' })
      const noAki = (directory: string, node: string) => {
        const keyPath = join(root, `${node}.noaki.key`)
        writeFileSync(
          keyPath,
          runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
          { mode: 0o600 },
        )
        const extPath = join(root, `${node}.noaki.ext`)
        writeFileSync(
          extPath,
          'subjectAltName=DNS:localhost,IP:127.0.0.1\n' +
            'basicConstraints=CA:FALSE\n' +
            'authorityKeyIdentifier=none\nsubjectKeyIdentifier=none\n',
        )
        const cert = runOpenssl(
          [
            'x509',
            '-req',
            '-CA',
            caCertPath(directory),
            '-CAkey',
            join(directory, 'ca.key'),
            '-CAcreateserial',
            '-CAserial',
            join(root, `${node}.noaki.srl`),
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
              keyPath,
              '-subj',
              `/CN=${node}`,
            ]),
          },
        )
        return { cert, key: readFileSync(keyPath, 'utf8') }
      }
      const underFirst = noAki(oldDir, 'twin-a')
      const underSecond = noAki(twinDir, 'twin-b')
      const ca =
        readFileSync(caCertPath(oldDir), 'utf8') +
        readFileSync(caCertPath(twinDir), 'utf8')
      const outcome = async (leaf: { cert: string; key: string }) => {
        const server = Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          tls: { cert: leaf.cert, key: leaf.key },
          fetch: () => new Response('ok'),
        })
        try {
          const response = await fetch(`https://127.0.0.1:${server.port}/`, {
            tls: { ca },
          })
          return response.status === 200 ? 'accepted' : 'refused'
        } catch {
          return 'refused'
        } finally {
          server.stop(true)
        }
      }
      expect([await outcome(underFirst), await outcome(underSecond)]).toEqual([
        'accepted',
        'refused',
      ])
    },
  )

  itNeedsOpenssl(
    'directory, own-certificate check, TLS and console all throw',
    () => {
      const config = nodeConfig(newLeaf, damaged)
      const refusal = new RegExp(
        `--trust-ca ${damaged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: certificate #2`,
      )
      expect(() => buildPublicKeyDirectory(config)).toThrow(refusal)
      expect(() =>
        assertOwnCertificateAndKey(config, newLeaf.keys.publicKey),
      ).toThrow(refusal)
      expect(() => buildListenerTls(config)).toThrow(refusal)
      expect(() =>
        createCertificatePort({
          baseUrl: 'http://127.0.0.1:1',
          caCertificatePem: readFileSync(damaged, 'utf8'),
        }),
      ).toThrow(/--trust-ca: certificate #2/)
    },
  )
})
