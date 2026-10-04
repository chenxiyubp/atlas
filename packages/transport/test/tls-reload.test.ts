// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A reconnect re-reads the TLS materials from disk (key-distribution.md §6.3
 * rule 4) — P12.3's fourth handover item.
 *
 * §6.3 rules 1–3 are about *live* connections, and they are already right: a
 * TLS session is fixed at handshake time, so swapping a file changes nothing
 * until the link drops. Rule 4 is the other half, and it is the one that bites
 * quietly — a client object holding the PEM string it was constructed with
 * keeps re-presenting it "拿着已换掉的旧证书重连到死", long after the operator
 * swapped the file and considered the rotation finished. Nothing goes red; the
 * node simply stops being able to connect once the old certificate expires.
 *
 * ## Where the observation point has to be, and why
 *
 * The obvious test — rotate the *client's* certificate and let the listener
 * notice — cannot be written on Bun 1.3.13. F-8: a listener can read no peer
 * certificate at all, and the 2026-08-19 addendum: it does not even check the
 * one it is handed against `ca`. There is no server-side observation of which
 * client certificate arrived.
 *
 * So the rotation is done on the half that *is* wire-observable. The dialer
 * does check the listener's chain (same addendum), so: rotate the CA root on
 * disk together with the listener's leaf, drop the link, and a client that
 * re-reads reconnects while a client holding the old root cannot. That is the
 * same mechanism under test, measured where Bun lets it be measured.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TransportClient,
  mutualTlsServerOptions,
  startTransportServer,
  type ClientTlsOptions,
  type ClientTlsSource,
  type MutualTlsMaterials,
  type TransportServerHandle,
} from '../src/index.js'
import { TEST_PSK, waitUntil } from './helpers.js'

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

/**
 * One CA generation: a root plus leaves under it. Two generations exist in
 * these tests because a rotation is precisely the moment two of them do.
 */
function generation(
  dir: string,
  tag: string,
): {
  readonly ca: string
  leaf(name: string): MutualTlsMaterials
} {
  const caKey = join(dir, `${tag}.ca.key`)
  const caCert = join(dir, `${tag}.ca.crt`)
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
      `/CN=qianmo-test-ca-${tag}`,
    ]),
  )
  const ca = readFileSync(caCert, 'utf8')
  return {
    ca,
    leaf(name: string): MutualTlsMaterials {
      const keyPath = join(dir, `${tag}.${name}.key`)
      const csrPath = join(dir, `${tag}.${name}.csr`)
      const extPath = join(dir, `${tag}.${name}.ext`)
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
      return {
        cert: openssl([
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
        ]),
        key: readFileSync(keyPath, 'utf8'),
        ca,
      }
    },
  }
}

const FAST_BACKOFF = {
  baseDelayMs: 20,
  maxDelayMs: 60,
  giveUpAfterMs: 8_000,
  jitterRatio: 0,
} as const

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const roots: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-tls-reload-'))
  roots.push(root)
  return root
}

function listen(
  materials: MutualTlsMaterials,
  port = 0,
): TransportServerHandle {
  const server = startTransportServer({
    port,
    hostname: '127.0.0.1',
    psk: TEST_PSK,
    tls: mutualTlsServerOptions(materials),
    onMessage: () => {},
  })
  servers.push(server)
  return server
}

describe('ClientTlsOptions accepts a factory', () => {
  test('the factory is not called at construction time', () => {
    // The half of rule 4 that needs no socket: resolution must happen at dial
    // time, so a client built before its certificate exists is legal and a
    // client built once can outlive several of them. The per-dial half is the
    // wire test below, which counts the calls across a real reconnect.
    let calls = 0
    const source: ClientTlsSource = (): ClientTlsOptions => {
      calls += 1
      return { ca: 'not-a-real-root' }
    }
    const client = new TransportClient({
      endpoint: { url: 'wss://127.0.0.1:1/' },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 5, maxDelayMs: 5, giveUpAfterMs: 1 },
      tls: source,
    })
    clients.push(client)
    expect(calls).toBe(0)
  })
})

describe.skipIf(!hasOpenssl())('a reconnect picks up a rotated root', () => {
  test('the client that re-reads gets back in; the one holding the old root does not', async () => {
    const root = tempRoot()
    const oldGen = generation(root, 'old')
    const newGen = generation(root, 'new')
    const caPath = join(root, 'ca.pem')
    writeFileSync(caPath, oldGen.ca)

    const first = listen(oldGen.leaf('node-b'))
    const port = first.port as number
    // Both dialers present a certificate throughout: F-7 keeps a dialer with
    // none out at the TLS layer, so without one neither of them would ever
    // reach the question this test is about. It stays the *same* certificate
    // across the rotation — the listener could not tell if it changed
    // (F-8), so rotating it here would prove nothing.
    const dialerLeaf = oldGen.leaf('node-a')

    // The dialer whose materials come off disk on every dial — the shape a
    // resident node uses, and the whole of rule 4.
    let reads = 0
    const reloading = new TransportClient({
      endpoint: { url: `wss://localhost:${String(port)}/` },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: FAST_BACKOFF,
      tls: (): ClientTlsOptions => {
        reads += 1
        return {
          ca: readFileSync(caPath, 'utf8'),
          cert: dialerLeaf.cert,
          key: dialerLeaf.key,
        }
      },
    })
    clients.push(reloading)

    // The control: same dial, materials frozen at construction. This is the
    // behaviour every client in this package had before rule 4 was wired.
    const frozen = new TransportClient({
      endpoint: { url: `wss://localhost:${String(port)}/` },
      node: 'node-c',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: FAST_BACKOFF,
      tls: { ca: oldGen.ca, cert: dialerLeaf.cert, key: dialerLeaf.key },
    })
    clients.push(frozen)

    await reloading.connect(8_000)
    await frozen.connect(8_000)
    expect(reads).toBe(1)

    // The rotation: a new root on disk, and a listener that presents a leaf
    // signed by it. Same port, so nothing about *where* to dial changed.
    await servers.splice(servers.indexOf(first), 1)[0]?.stop()
    writeFileSync(caPath, newGen.ca)
    listen(newGen.leaf('node-b'), port)

    await waitUntil(() => reloading.isReady(), 8_000)
    expect(reads).toBeGreaterThan(1)
    // Read off the file, not off the closure: the last resolution really was
    // the rotated root.
    expect(readFileSync(caPath, 'utf8')).toBe(newGen.ca)

    // And the control never comes back, because its root is the retired one.
    expect(frozen.isReady()).toBe(false)
  }, 20_000)
})
