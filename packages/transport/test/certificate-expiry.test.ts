// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A listener whose certificate lapses (key-distribution.md §6.3) — DoD 7.
 *
 * The rule exists because a TLS session is settled at handshake time: an
 * expired — or revoked — certificate keeps serving every connection made
 * before it lapsed, for as long as that connection happens to live, and on a
 * long-lived node link that is indefinitely. So the node closes them itself,
 * with 4003, rather than waiting for the peer to notice.
 *
 * Over a unix socket, deliberately. What is being tested is the *rule*, which
 * is a decision about a `notAfter` timestamp; wrapping it in real TLS would
 * add a second thing that could fail without adding a thing being checked.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  CLOSE_UNAUTHORIZED,
  TransportClient,
  TransportEventType,
  startTransportServer,
  type TransportServerHandle,
} from '../src/index.js'
import { TEST_PSK, makeSocketPath, waitUntil } from './helpers.js'

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('§6.3 — the certificate lapses under a live connection', () => {
  test('every connection is closed with 4003 the moment it expires', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const server = startTransportServer({
      unix: socket.path,
      psk: TEST_PSK,
      // 120 ms of validity: long enough to establish a link, short enough to
      // watch it be taken away.
      certificateNotAfter: Date.now() + 120,
      onMessage: () => {},
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket.path },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 20, giveUpAfterMs: 100 },
    })
    clients.push(client)

    await client.connect(5_000)
    expect(client.isReady()).toBe(true)

    // Both sides, and the dialer's side is the one with the deadline: the
    // server drops the socket first and the close travels, so waiting only on
    // `server.connections` would sample the client mid-teardown.
    await waitUntil(() => server.connections === 0, 3_000)
    // 4003, so the dialer treats it as permanent and does not mount a
    // reconnect storm against a node that cannot let anyone in until an
    // operator re-issues.
    await waitUntil(() => client.isClosed(), 3_000)
    const rejected = server.events.byType(TransportEventType.AuthRejected)
    expect(rejected.map(event => event.detail['rejection'])).toContain(
      'certificate_expired',
    )
    expect(
      client.events
        .byType(TransportEventType.ConnectionClosed)
        .map(event => event.detail['code']),
    ).toContain(CLOSE_UNAUTHORIZED)
  })

  test('a dial after expiry is refused with the same 4003 a wrong key gets', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    // Already lapsed when the listener starts — the "operator restarted a node
    // whose certificate ran out last week" case, which must not come up
    // looking healthy.
    const server = startTransportServer({
      unix: socket.path,
      psk: TEST_PSK,
      certificateNotAfter: Date.now() - 1,
      onMessage: () => {},
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket.path },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 20, giveUpAfterMs: 100 },
    })
    clients.push(client)

    await expect(client.connect(5_000)).rejects.toThrow(/4003/)
    // Refused, but the process is still up and still listening: §6.3's last
    // rule is that a forgotten renewal must not be amplified into a node that
    // is simply gone.
    expect(server.connections).toBe(0)
    expect(
      server.events
        .byType(TransportEventType.AuthRejected)
        .map(event => event.detail['rejection']),
    ).toContain('certificate_expired')
  })

  test('a certificate valid for its full 90 days does not fire at startup', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    // The bug this guards: 90 days is 7.8e9 ms, 3.6× past what `setTimeout`
    // can hold, and overshooting that ceiling makes a timer fire *immediately*
    // rather than late. A naive single timer would close every connection the
    // instant the node came up — and would do it only in production, where
    // certificates are not minted 120 ms before the test needs them.
    const server = startTransportServer({
      unix: socket.path,
      psk: TEST_PSK,
      certificateNotAfter: Date.now() + 90 * 24 * 60 * 60 * 1000,
      onMessage: () => {},
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket.path },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
    })
    clients.push(client)

    await client.connect(5_000)
    await waitUntil(() => server.connections === 1)
    expect(client.isReady()).toBe(true)
    expect(server.events.byType(TransportEventType.AuthRejected)).toHaveLength(
      0,
    )
  })

  test('no `certificateNotAfter` means no clock at all', async () => {
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)

    const server = startTransportServer({
      unix: socket.path,
      psk: TEST_PSK,
      onMessage: () => {},
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket.path },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
    })
    clients.push(client)
    await client.connect(5_000)
    expect(client.isReady()).toBe(true)
  })
})
