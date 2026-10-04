// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * L0, the mTLS admission fence (key-distribution.md §7.1) — P12.3's DoD 5.
 *
 * Real openssl, a real CA, a real `wss://` dial: F-7 and F-10 are statements
 * about Bun's TLS implementation, and a mocked one would assert our belief
 * about it rather than it. Certificates are generated per run into a temp
 * directory and thrown away with it, for the reason `tls.test.ts` gives — a
 * test certificate in a repository is a credential in a repository.
 *
 * Skipped where openssl is absent: the transport does not depend on it, only
 * this fixture does.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QianmoMessage } from '@qianmo/protocol'
import {
  TransportClient,
  mutualTlsClientOptions,
  mutualTlsServerOptions,
  startTransportServer,
  type MutualTlsMaterials,
  type TransportServerHandle,
} from '../src/index.js'
import { TEST_PSK, makeMessage } from './helpers.js'

function hasOpenssl(): boolean {
  try {
    return Bun.spawnSync(['openssl', 'version']).exitCode === 0
  } catch {
    return false
  }
}

function openssl(args: string[]): string {
  const run = Bun.spawnSync(['openssl', ...args])
  if (run.exitCode !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${run.stderr.toString()}`)
  }
  return run.stdout.toString()
}

interface Fixture {
  readonly ca: string
  /** Materials for one node: EC leaf under the Ed25519 root (F-5/F-6). */
  leaf(name: string): MutualTlsMaterials
  readonly cleanup: () => void
}

/** An offline Ed25519 root and leaves signed by it — `qm ca init/issue` in miniature. */
function miniCa(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-transport-mtls-'))
  const caKey = join(dir, 'ca.key')
  const caCert = join(dir, 'ca.crt')
  writeFileSync(caKey, openssl(['genpkey', '-algorithm', 'ed25519']), {
    mode: 0o600,
  })
  writeFileSync(
    caCert,
    openssl([
      'req',
      '-x509',
      '-new',
      '-key',
      caKey,
      '-days',
      '1',
      '-subj',
      '/CN=qianmo-test-ca',
    ]),
  )
  const ca = readFileSync(caCert, 'utf8')

  return {
    ca,
    leaf(name: string): MutualTlsMaterials {
      const keyPath = join(dir, `${name}.key`)
      const csrPath = join(dir, `${name}.csr`)
      const extPath = join(dir, `${name}.ext`)
      // EC, because F-5: Bun refuses an Ed25519 leaf outright, on either half
      // of the connection.
      writeFileSync(
        keyPath,
        openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
        { mode: 0o600 },
      )
      writeFileSync(
        csrPath,
        openssl(['req', '-new', '-key', keyPath, '-subj', `/CN=${name}`]),
      )
      writeFileSync(
        extPath,
        `subjectAltName=DNS:localhost,IP:127.0.0.1,URI:qianmo://${name}\n` +
          'basicConstraints=CA:FALSE\n' +
          'extendedKeyUsage=serverAuth,clientAuth\n',
      )
      const cert = openssl([
        'x509',
        '-req',
        '-in',
        csrPath,
        '-CA',
        caCert,
        '-CAkey',
        caKey,
        '-CAcreateserial',
        '-days',
        '1',
        '-extfile',
        extPath,
      ])
      return { cert, key: readFileSync(keyPath, 'utf8'), ca }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('mutualTlsServerOptions', () => {
  test('emits the three settings F-10 says cannot be separated', () => {
    const options = mutualTlsServerOptions({
      cert: 'CERT',
      key: 'KEY',
      ca: 'CA',
    })
    expect(options).toEqual({
      cert: 'CERT',
      key: 'KEY',
      ca: 'CA',
      requestCert: true,
      rejectUnauthorized: true,
    })
    // The point of the helper: there is no input shape that produces `ca`
    // without its two companions, which is the configuration that quietly
    // stops admitting anybody.
    expect(Object.keys(options)).toContain('requestCert')
    expect(Object.keys(options)).toContain('rejectUnauthorized')
  })
})

describe.skipIf(!hasOpenssl())('L0 admission over wss', () => {
  test('a dialer holding a CA-issued certificate gets in and delivers', async () => {
    const fixture = miniCa()
    cleanups.push(fixture.cleanup)

    const handled: QianmoMessage[] = []
    const server = startTransportServer({
      port: 0,
      hostname: '127.0.0.1',
      psk: TEST_PSK,
      tls: mutualTlsServerOptions(fixture.leaf('node-b')),
      onMessage: message => {
        handled.push(message)
      },
    })
    servers.push(server)
    expect(server.url).toStartWith('wss://')

    const client = new TransportClient({
      endpoint: { url: `wss://localhost:${server.port}/` },
      node: 'node-a',
      psk: TEST_PSK,
      tls: mutualTlsClientOptions(fixture.leaf('node-a')),
      keepAliveIntervalMs: 0,
    })
    clients.push(client)

    await client.connect(5_000)
    client.send(makeMessage({ payload: { over: 'mtls' } }))
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })

  test('a dialer with no certificate is stopped at the TLS layer (F-7)', async () => {
    const fixture = miniCa()
    cleanups.push(fixture.cleanup)

    const handled: QianmoMessage[] = []
    const server = startTransportServer({
      port: 0,
      hostname: '127.0.0.1',
      psk: TEST_PSK,
      tls: mutualTlsServerOptions(fixture.leaf('node-b')),
      onMessage: message => {
        handled.push(message)
      },
    })
    servers.push(server)

    // It trusts the root and holds the right pre-shared key. What it does not
    // have is a certificate — and the handshake it would have used the key for
    // never happens, because there is no channel to send it over.
    const client = new TransportClient({
      endpoint: { url: `wss://localhost:${server.port}/` },
      node: 'node-a',
      psk: TEST_PSK,
      tls: { ca: fixture.ca },
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 20, giveUpAfterMs: 60 },
    })
    clients.push(client)

    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(handled).toHaveLength(0)
    expect(server.connections).toBe(0)
  })

  test('a certificate from another CA gets in — Bun does not check the chain', async () => {
    // **This test asserts a limitation, deliberately.** Measured on Bun
    // 1.3.13 (key-distribution.md §2, 2026-08-19 addendum): a listener with
    // `ca` + `requestCert` + `rejectUnauthorized` enforces that a certificate
    // was *presented*, not that it chains to `ca`. A leaf from an unrelated
    // root gets in; so does a self-signed one.
    //
    // Written as an assertion rather than a comment so that the day Bun
    // tightens this, the change announces itself here instead of being
    // discovered by someone re-deriving the whole question. **When it goes
    // red, that is good news**: flip it to `rejects` and delete this note.
    //
    // It is safe to be wrong about this in the meantime only because nothing
    // downstream trusts L0 for identity — the dialer below still has to
    // produce a signature over its own node key one frame later, and does not
    // have one. That is §7.1.1's whole reason for existing.
    const ours = miniCa()
    const theirs = miniCa()
    cleanups.push(ours.cleanup, theirs.cleanup)

    const server = startTransportServer({
      port: 0,
      hostname: '127.0.0.1',
      psk: TEST_PSK,
      tls: mutualTlsServerOptions(ours.leaf('node-b')),
      onMessage: () => {},
    })
    servers.push(server)

    const outsider = theirs.leaf('node-a')
    const client = new TransportClient({
      endpoint: { url: `wss://localhost:${server.port}/` },
      node: 'node-a',
      psk: TEST_PSK,
      // Our CA for the server check, its own foreign certificate to present:
      // internally consistent, and signed by a root we never distributed.
      tls: { ca: ours.ca, cert: outsider.cert, key: outsider.key },
      keepAliveIntervalMs: 0,
    })
    clients.push(client)

    await client.connect(5_000)
    expect(client.isReady()).toBe(true)
  })
})
