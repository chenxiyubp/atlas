// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import {
  LEGACY_MESSAGE_TYPES,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  FRAME_VERSION,
  FrameType,
  TransportClient,
  parseFrame,
  serializeFrame,
  startTransportServer,
  type TransportChannel,
  type TransportServerHandle,
} from '../src/index.js'
import { TEST_PSK, makeMessage, makeSocketPath, waitUntil } from './helpers.js'

/**
 * Capability discovery over the handshake (protocol.md §14.6).
 *
 * The property under test is the one the whole scheme rests on: **a type past
 * the legacy floor is used only towards a peer that asked for it.** Both
 * directions matter and for different reasons — the dialer declares in the auth
 * frame because the listener is the side that raises `notify`, and the listener
 * declares in the ready frame because the dialer may want to send one back one
 * day. A test that only covered the ready frame would leave the direction
 * `notify` actually travels unexercised.
 */

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const cleanups: Array<() => void> = []

const NEW_BUILD: readonly string[] = [
  ...LEGACY_MESSAGE_TYPES,
  MessageType.Notify,
]

function track(server: TransportServerHandle): TransportServerHandle {
  servers.push(server)
  return server
}

function trackClient(client: TransportClient): TransportClient {
  clients.push(client)
  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Stand up one hop and hand back both ends of it. */
async function connect(options: {
  serverTypes?: readonly string[]
  clientTypes?: readonly string[]
}): Promise<{ client: TransportClient; channel: TransportChannel }> {
  const socket = makeSocketPath()
  cleanups.push(socket.cleanup)
  let channel: TransportChannel | undefined
  track(
    startTransportServer({
      unix: socket.path,
      psk: TEST_PSK,
      onMessage: (_message: QianmoMessage, context) => {
        channel = context.channel
      },
      ...(options.serverTypes === undefined
        ? {}
        : { supportedTypes: options.serverTypes }),
    }),
  )
  const client = trackClient(
    new TransportClient({
      endpoint: { unix: socket.path },
      node: 'node-a',
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      ...(options.clientTypes === undefined
        ? {}
        : { supportedTypes: options.clientTypes }),
    }),
  )
  await client.connect()
  // The server-side channel is only reachable through an inbound message; one
  // ordinary envelope is the cheapest way to get hold of it.
  client.send(makeMessage())
  await waitUntil(() => channel !== undefined)
  if (channel === undefined) throw new Error('server channel never arrived')
  return { client, channel }
}

describe('the frame grammar carries the declaration inside v1', () => {
  test('FRAME_VERSION is untouched — the extension is additive', () => {
    // `parseFrame` compares the version for strict equality, so raising it
    // would not stage a migration, it would end one. P13.2's whole
    // compatibility argument depends on this number staying 1.
    expect(FRAME_VERSION).toBe(1)
  })

  test('a ready frame round-trips its declaration', () => {
    const frame = {
      t: FrameType.Ready,
      v: FRAME_VERSION,
      supportedTypes: [...NEW_BUILD],
    } as const
    expect(parseFrame(serializeFrame(frame))).toEqual(frame)
  })

  test('an auth frame round-trips its declaration', () => {
    const frame = {
      t: FrameType.Auth,
      v: FRAME_VERSION,
      node: 'node-a',
      nonce: 'abcd',
      clientNonce: 'ef01',
      channelId: 'a'.repeat(32),
      mac: '00ff',
      supportedTypes: [MessageType.Notify],
    } as const
    expect(parseFrame(serializeFrame(frame))).toEqual(frame)
  })

  test('a frame from before the field still parses', () => {
    // The other half of "additive": an old peer sends no such key, and that
    // must not read as a malformed frame.
    const ready = parseFrame(
      JSON.stringify({ t: FrameType.Ready, v: FRAME_VERSION }),
    )
    expect(ready).toEqual({ t: FrameType.Ready, v: FRAME_VERSION })
    expect(ready).not.toHaveProperty('supportedTypes')
  })

  test('a malformed declaration is dropped, not fatal', () => {
    // Optional additive fields degrade; they do not take the connection with
    // them. A dropped list reads as the floor, i.e. fewer types offered.
    for (const bad of [42, 'notify', {}, ['ok', 7], ['']]) {
      const parsed = parseFrame(
        JSON.stringify({
          t: FrameType.Ready,
          v: FRAME_VERSION,
          supportedTypes: bad,
        }),
      )
      expect(parsed).toEqual({ t: FrameType.Ready, v: FRAME_VERSION })
    }
  })
})

describe('what each end learns about the other', () => {
  test('the listener learns what the dialer declared', async () => {
    // The direction notify travels: node listens, hub dials, node sends.
    const { channel } = await connect({ clientTypes: NEW_BUILD })
    expect(channel.peerSupportedTypes).toEqual(NEW_BUILD)
    expect(channel.supports(MessageType.Notify)).toBe(true)
  })

  test('the dialer learns what the listener declared', async () => {
    const { client } = await connect({ serverTypes: NEW_BUILD })
    expect(client.peerSupportedTypes).toEqual(NEW_BUILD)
    expect(client.supports(MessageType.Notify)).toBe(true)
  })

  test('an undeclared peer is assumed to speak the floor and nothing more', async () => {
    const { client, channel } = await connect({})
    expect(client.peerSupportedTypes).toBeUndefined()
    expect(channel.peerSupportedTypes).toBeUndefined()

    // The point of the whole mechanism: notify is withheld.
    expect(client.supports(MessageType.Notify)).toBe(false)
    expect(channel.supports(MessageType.Notify)).toBe(false)

    // And the floor is still fully available — discovery narrows nothing that
    // already worked.
    for (const type of LEGACY_MESSAGE_TYPES) {
      expect(client.supports(type)).toBe(true)
      expect(channel.supports(type)).toBe(true)
    }
  })

  test('declaring only the floor is the same as declaring nothing', async () => {
    const { channel } = await connect({ clientTypes: LEGACY_MESSAGE_TYPES })
    expect(channel.supports(MessageType.Notify)).toBe(false)
    expect(channel.supports(MessageType.Ping)).toBe(true)
  })

  test('before the handshake, a client claims nothing past the floor', () => {
    // A channel that has not completed a handshake has heard no declaration,
    // and "no declaration" must not read as "everything".
    const client = trackClient(
      new TransportClient({
        endpoint: { unix: '/nonexistent/never-dialled.sock' },
        node: 'node-a',
        psk: TEST_PSK,
        keepAliveIntervalMs: 0,
      }),
    )
    expect(client.peerSupportedTypes).toBeUndefined()
    expect(client.supports(MessageType.Notify)).toBe(false)
  })
})
