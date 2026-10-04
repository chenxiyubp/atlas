// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The links **out** of this host, signed (key-distribution.md §7.1.1).
 *
 * P12.3 gave `TransportClient` a `signing` identity and wired the node's
 * *listener*; every dial this package makes still went out on the pre-shared
 * key alone. That is not a smaller version of the same guarantee — §11 T-B′'s
 * second defence is a *dialer* checking that whatever answered can sign as the
 * node it meant to reach, and a host that only verifies inbound handshakes has
 * none of it for its own forwards.
 *
 * The assertion is made against a listener with `required: true`, because that
 * is the only listener that can tell the two states apart on the wire: a
 * listener in §8.2 phase ① accepts a MAC-only dialer too, so "it connected"
 * would prove nothing about whether a signature travelled.
 *
 * A real `Bun.serve` over a unix socket, no mocks — same reasoning as
 * `packages/transport/test/signed-handshake.test.ts`: what is under test is
 * which proof crossed a socket.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
} from '@qianmo/capability'
import { MessageType, createMessage } from '@qianmo/protocol'
import {
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import { AuditLog } from '../src/audit.js'
import { StaticTargetDirectory, TransportLinks } from '../src/link.js'

const PSK = 'link-signing-psk-not-a-real-secret'
const HOST = 'node-host'
const TARGET = 'node-b'
const SANDBOX = 'sandbox-node-b'

const hostKeys = generateNodeKeyPair()
const targetKeys = generateNodeKeyPair()

function directory(): StaticPublicKeyDirectory {
  return new StaticPublicKeyDirectory([
    [HOST, hostKeys.publicKey],
    [TARGET, targetKeys.publicKey],
  ])
}

const servers: TransportServerHandle[] = []
const links: TransportLinks[] = []
const roots: string[] = []

afterEach(async () => {
  for (const pool of links.splice(0)) await pool.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/** A listener inside the "sandbox", in §8.2 phase ③ — signatures or nothing. */
function listener(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-link-signing-'))
  roots.push(root)
  const path = join(root, 's.sock')
  servers.push(
    startTransportServer({
      unix: path,
      psk: PSK,
      signing: {
        node: TARGET,
        keys: targetKeys,
        directory: directory(),
        required: true,
      },
      onMessage: () => {},
    }),
  )
  return path
}

function pool(options: { readonly sign: boolean; readonly path: string }) {
  const created = new TransportLinks({
    node: HOST,
    psk: PSK,
    directory: new StaticTargetDirectory([
      { node: TARGET, sandboxName: SANDBOX, endpoint: { unix: options.path } },
    ]),
    audit: new AuditLog(),
    connectTimeoutMs: 2_000,
    ...(options.sign
      ? { signing: { keys: hostKeys, directory: directory() } }
      : {}),
  })
  links.push(created)
  return created
}

describe('TransportLinks signing (§7.1.1)', () => {
  test('a signing pool reaches a listener that requires signatures', async () => {
    const path = listener()
    expect(await pool({ sign: true, path }).isReady(SANDBOX)).toBe(true)
  })

  test('without it the same dial is refused, so the signature is what got in', async () => {
    // The control the previous case needs: if a MAC-only dial also succeeded,
    // "it connected" would say nothing about which proof the listener took.
    const path = listener()
    expect(await pool({ sign: false, path }).isReady(SANDBOX)).toBe(false)
  })

  test('a forward over a signed link carries the envelope', async () => {
    const path = listener()
    const forwarding = pool({ sign: true, path })
    const envelope = createMessage({
      from: `qianmo://${HOST}/activator`,
      to: `qianmo://${TARGET}/reviewer`,
      type: MessageType.TaskRequest,
      payload: { round: 'signed-forward' },
    })
    // `forward` routes by the envelope's `to`, not by the sandbox name.
    await expect(forwarding.forward(envelope)).resolves.toBeUndefined()
  })
})
