// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QianmoMessage } from '@qianmo/protocol'
import {
  TransportClient,
  startTransportServer,
  type TransportServerHandle,
} from '../src/index.js'
import { TEST_PSK, makeMessage } from './helpers.js'

/**
 * TLS, over TCP because there is no such thing as TLS on a unix socket.
 *
 * The certificate is generated per run into a temp directory and thrown away
 * with it: a test certificate committed to a repository is a credential in the
 * repository, however fake, and this suite has none.
 *
 * Skipped where `openssl` is absent rather than failing — the transport does
 * not depend on it, only this test's fixture does.
 */

function hasOpenssl(): boolean {
  try {
    return Bun.spawnSync(['openssl', 'version']).exitCode === 0
  } catch {
    return false
  }
}

interface Materials {
  readonly cert: string
  readonly key: string
  readonly cleanup: () => void
}

function selfSigned(): Materials {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-transport-tls-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  const generated = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ])
  if (generated.exitCode !== 0) {
    throw new Error('openssl could not generate a test certificate')
  }
  return {
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
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

describe.skipIf(!hasOpenssl())('TLS', () => {
  test('a wss:// peer that trusts the certificate delivers', async () => {
    const materials = selfSigned()
    cleanups.push(materials.cleanup)

    const handled: QianmoMessage[] = []
    const server = startTransportServer({
      port: 0,
      hostname: '127.0.0.1',
      psk: TEST_PSK,
      tls: { cert: materials.cert, key: materials.key },
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
      tls: { ca: materials.cert },
      keepAliveIntervalMs: 0,
    })
    clients.push(client)

    await client.connect(5_000)
    client.send(makeMessage({ payload: { over: 'tls' } }))
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })

  test('a peer that does not trust the certificate never gets in', async () => {
    const materials = selfSigned()
    cleanups.push(materials.cleanup)

    const handled: QianmoMessage[] = []
    const server = startTransportServer({
      port: 0,
      hostname: '127.0.0.1',
      psk: TEST_PSK,
      tls: { cert: materials.cert, key: materials.key },
      onMessage: message => {
        handled.push(message)
      },
    })
    servers.push(server)

    // Same key, same address — only the certificate is not trusted. The
    // pre-shared key is never even offered, because there is no channel.
    const client = new TransportClient({
      endpoint: { url: `wss://localhost:${server.port}/` },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 20, giveUpAfterMs: 60 },
    })
    clients.push(client)

    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(handled).toHaveLength(0)
  })
})
