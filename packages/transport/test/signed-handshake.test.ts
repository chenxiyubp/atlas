// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed handshake over a real socket — P12.3's DoD 2, 3 and 4.
 *
 * A real `Bun.serve` and a real dial, over a unix socket for the reason the
 * rest of this suite uses one (two TCP servers can bind the same port without
 * either erroring). No mocks: what is being tested is which of two proofs a
 * listener takes and what a dialer does with the answer, and both of those are
 * decisions made about bytes that actually crossed a socket.
 *
 * The migration matrix in `interop` is the point of the whole package change:
 * every cell of it has to work, because a fleet is upgraded one node at a time.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import WebSocket from 'ws'
import {
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  signBytes,
  verifyBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import type { QianmoMessage } from '@qianmo/protocol'
import {
  FRAME_VERSION,
  FrameType,
  HandshakeRejection,
  ReadyRejection,
  TransportClient,
  TransportEventType,
  authSigningInput,
  computeMac,
  newNonce,
  parseFrame,
  readySigningInput,
  serializeFrame,
  startTransportServer,
  type HandshakeCredentialDirectory,
  type TransportServerHandle,
} from '../src/index.js'
import { TEST_PSK, makeMessage, makeSocketPath, waitUntil } from './helpers.js'

const FAST_BACKOFF = {
  baseDelayMs: 10,
  maxDelayMs: 20,
  giveUpAfterMs: 120,
  jitterRatio: 0,
} as const

const LISTENER = 'node-b'
const DIALER = 'node-a'

const listenerKeys = generateNodeKeyPair()
const dialerKeys = generateNodeKeyPair()
const impostorKeys = generateNodeKeyPair()

/** Every node's published key, as a directory that has finished converging. */
function fullDirectory(): StaticPublicKeyDirectory {
  return new StaticPublicKeyDirectory([
    [LISTENER, listenerKeys.publicKey],
    [DIALER, dialerKeys.publicKey],
  ])
}

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const cleanups: Array<() => void> = []
const legacyServers: Array<{ stop(closeActiveConnections?: boolean): void }> =
  []
const rawSockets: WebSocket[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const socket of rawSockets.splice(0)) socket.terminate()
  for (const server of legacyServers.splice(0)) server.stop(true)
  for (const cleanup of cleanups.splice(0)) cleanup()
})

interface Hop {
  readonly server: TransportServerHandle
  readonly client: TransportClient
  readonly handled: QianmoMessage[]
}

/** One hop, with each half independently signing or not. */
function hop(options: {
  listenerSigns: boolean
  dialerSigns: boolean
  listenerRequires?: boolean
  dialerRequires?: boolean
  dialerKeys?: NodeKeyPair
  listenerKeys?: NodeKeyPair
  listenerNode?: string
  directory?: StaticPublicKeyDirectory
}): Hop {
  const socket = makeSocketPath()
  cleanups.push(socket.cleanup)
  const handled: QianmoMessage[] = []
  const directory = options.directory ?? fullDirectory()

  const server = startTransportServer({
    unix: socket.path,
    psk: TEST_PSK,
    onMessage: message => {
      handled.push(message)
    },
    ...(options.listenerSigns
      ? {
          signing: {
            node: options.listenerNode ?? LISTENER,
            keys: options.listenerKeys ?? listenerKeys,
            directory,
            ...(options.listenerRequires === undefined
              ? {}
              : { required: options.listenerRequires }),
          },
        }
      : {}),
  })
  servers.push(server)

  const client = new TransportClient({
    endpoint: { unix: socket.path },
    node: DIALER,
    peerNode: LISTENER,
    psk: TEST_PSK,
    keepAliveIntervalMs: 0,
    backoff: FAST_BACKOFF,
    ...(options.dialerSigns
      ? {
          signing: {
            keys: options.dialerKeys ?? dialerKeys,
            directory,
            ...(options.dialerRequires === undefined
              ? {}
              : { required: options.dialerRequires }),
          },
        }
      : {}),
  })
  clients.push(client)
  return { server, client, handled }
}

describe('DoD 3 — the migration matrix, one cell at a time', () => {
  test('both halves signed: an envelope crosses and `node` came from the signature', async () => {
    const { server, client, handled } = hop({
      listenerSigns: true,
      dialerSigns: true,
    })
    await client.connect(5_000)
    client.send(makeMessage({ payload: { signed: true } }))
    await client.waitForDrain()
    expect(handled).toHaveLength(1)

    const accepted = server.events.byType(TransportEventType.AuthAccepted)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.detail['node']).toBe(DIALER)
    expect(accepted[0]?.detail['authentication']).toBe('signature')
    expect(client.authenticatedBy).toBe('signature')
  })

  test('signing dialer, pre-shared-key listener: the MAC carries it', async () => {
    // The listener has no keys at all — an un-upgraded node. The dialer's
    // `sig` rides along unread and the frame is still good.
    const { client, handled } = hop({ listenerSigns: false, dialerSigns: true })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
    expect(client.authenticatedBy).toBe('psk')
  })

  test('pre-shared-key dialer, signing listener: also carries', async () => {
    const { client, handled } = hop({ listenerSigns: true, dialerSigns: false })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })

  test('a signing listener still signs its ready for an unsigned dialer', async () => {
    // Two independent claims: a dialer must not have to prove itself by
    // signature before it is allowed to check who answered.
    const { client, handled } = hop({ listenerSigns: true, dialerSigns: false })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })
})

describe('v1 legacy signature interoperability over real sockets', () => {
  test('new client sig is accepted by a base verifier and old ready is accepted by the new client', async () => {
    const serverNonce = newNonce()
    let legacyVerifiedAuth = false
    let legacySawCredentialPair = false
    const legacyServer = Bun.serve<{ nonce: string }>({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, server) {
        if (server.upgrade(request, { data: { nonce: serverNonce } })) return
        return new Response('expected websocket', { status: 426 })
      },
      websocket: {
        open(ws) {
          ws.send(
            serializeFrame({
              t: FrameType.Challenge,
              v: FRAME_VERSION,
              nonce: ws.data.nonce,
            }),
          )
        },
        message(ws, raw) {
          const frame = parseFrame(String(raw))
          if (frame?.t !== FrameType.Auth || frame.sig === undefined) return
          legacySawCredentialPair =
            frame.credential === 'new-dialer-f1' &&
            frame.credentialProof !== undefined
          // This is intentionally the P12.3 verifier: it reads no credential
          // extension and checks the fixed v1 tuple from the real wire frame.
          legacyVerifiedAuth = verifyBytes(
            dialerKeys.publicKey,
            authSigningInput(
              frame.nonce,
              frame.clientNonce,
              frame.node,
              frame.channelId,
            ),
            frame.sig,
          )
          if (!legacyVerifiedAuth) return ws.close(4003, 'unauthorized')
          ws.send(
            serializeFrame({
              t: FrameType.Ready,
              v: FRAME_VERSION,
              node: LISTENER,
              sig: signBytes(
                listenerKeys,
                readySigningInput(
                  frame.nonce,
                  frame.clientNonce,
                  frame.node,
                  frame.channelId,
                  LISTENER,
                ),
              ),
            }),
          )
        },
      },
    })
    legacyServers.push(legacyServer)
    const client = new TransportClient({
      endpoint: { url: `ws://127.0.0.1:${String(legacyServer.port)}` },
      node: DIALER,
      peerNode: LISTENER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: FAST_BACKOFF,
      signing: {
        keys: dialerKeys,
        directory: fullDirectory(),
        credential: {
          selector: 'new-dialer-f1',
          source: 'certificate',
          id: 'new-dialer-f1',
        },
      },
    })
    clients.push(client)
    await client.connect(5_000)
    expect(legacyVerifiedAuth).toBe(true)
    expect(legacySawCredentialPair).toBe(true)
    expect(client.authenticatedBy).toBe('signature')
    expect(client.authenticatedCredential).toBeNull()
  })

  test('base client sig is accepted by the new server and verifies its new ready sig', async () => {
    const server = startTransportServer({
      port: 0,
      psk: TEST_PSK,
      onMessage: () => {},
      signing: {
        node: LISTENER,
        keys: listenerKeys,
        directory: fullDirectory(),
        credential: {
          selector: 'new-listener-f1',
          source: 'certificate',
          id: 'new-listener-f1',
        },
      },
    })
    servers.push(server)
    const socket = new WebSocket(server.url ?? '')
    rawSockets.push(socket)
    let seenServerNonce = ''
    let seenClientNonce = ''
    let legacySawCredentialPair = false
    const legacyVerifiedReady = await new Promise<boolean>(
      (resolve, reject) => {
        socket.once('error', reject)
        socket.on('message', raw => {
          const frame = parseFrame(raw.toString())
          if (frame?.t === FrameType.Challenge) {
            const clientNonce = newNonce()
            seenServerNonce = frame.nonce
            seenClientNonce = clientNonce
            socket.send(
              serializeFrame({
                t: FrameType.Auth,
                v: FRAME_VERSION,
                node: DIALER,
                nonce: frame.nonce,
                clientNonce,
                channelId: '9'.repeat(32),
                mac: computeMac(
                  TEST_PSK,
                  frame.nonce,
                  clientNonce,
                  DIALER,
                  '9'.repeat(32),
                ),
                // Exact bytes emitted by an old signer: no extension fields.
                sig: signBytes(
                  dialerKeys,
                  authSigningInput(
                    frame.nonce,
                    clientNonce,
                    DIALER,
                    '9'.repeat(32),
                  ),
                ),
              }),
            )
            return
          }
          if (frame?.t !== FrameType.Ready || frame.sig === undefined) return
          legacySawCredentialPair =
            frame.credential === 'new-listener-f1' &&
            frame.credentialProof !== undefined
          // The base verifier ignores the new ready extensions and checks only
          // its fixed tuple against the actual sig received on this socket.
          resolve(
            verifyBytes(
              listenerKeys.publicKey,
              readySigningInput(
                seenServerNonce,
                seenClientNonce,
                DIALER,
                '9'.repeat(32),
                LISTENER,
              ),
              frame.sig,
            ),
          )
        })
      },
    )
    expect(legacyVerifiedReady).toBe(true)
    expect(legacySawCredentialPair).toBe(true)
    expect(
      server.events.byType(TransportEventType.AuthAccepted)[0]?.detail[
        'authentication'
      ],
    ).toBe('signature')
  })
})

describe('DoD 2 — the listener takes whichever proof is offered', () => {
  test('a forged signature is refused, and the wire says only "unauthorized"', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      dialerKeys: impostorKeys,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/4003/)

    const rejected = server.events.byType(TransportEventType.AuthRejected)
    expect(rejected[0]?.detail['rejection']).toBe(
      HandshakeRejection.BadSignature,
    )
    // The distinction is in our record and nowhere else: the dialer got the
    // same close code and the same reason a bad MAC would have got.
    expect(rejected[0]?.detail['closeCode']).toBe(4003)
    const closed = client.events.byType(TransportEventType.AuthRejected)
    expect(closed[0]?.detail['code']).toBe(4003)
  })

  test('a dialer whose key is not published yet is refused', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      directory: new StaticPublicKeyDirectory([
        [LISTENER, listenerKeys.publicKey],
      ]),
    })
    await expect(client.connect(5_000)).rejects.toThrow(/4003/)
    expect(
      server.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(HandshakeRejection.UnknownSigner)
  })

  test('`required` retires the pre-shared key on that listener (§8.2 phase ③)', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: false,
      listenerRequires: true,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/4003/)
    expect(
      server.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(HandshakeRejection.SignatureRequired)
  })

  test('`required` still admits a signing dialer', async () => {
    const { client, handled } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerRequires: true,
    })
    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)
  })
})

describe('§7.1.1 — the dialer checks the listener back', () => {
  test('an endpoint answering as another node never becomes ready (T-B′)', async () => {
    // A node inside the network — its own key published, its own certificate
    // valid — answering a dial meant for `node-b`. Nothing about it is forged;
    // it simply is not who was dialled.
    const { client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerNode: 'node-c',
      listenerKeys: impostorKeys,
      directory: new StaticPublicKeyDirectory([
        [LISTENER, listenerKeys.publicKey],
        [DIALER, dialerKeys.publicKey],
        ['node-c', impostorKeys.publicKey],
      ]),
    })
    // Not fatal, by design: the endpoint record may be mid-update. It retries
    // and reports through the reconnect budget instead.
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(client.isReady()).toBe(false)
    const rejected = client.events.byType(TransportEventType.AuthRejected)
    expect(rejected[0]?.detail['rejection']).toBe(ReadyRejection.WrongNode)
    expect(rejected[0]?.detail['face']).toBe('ready')
  })

  test('a listener claiming the right name with the wrong key is refused', async () => {
    const { client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerKeys: impostorKeys,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(
      client.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(ReadyRejection.BadSignature)
  })

  test('a dialer with `required` refuses an unsigned listener', async () => {
    const { client } = hop({
      listenerSigns: false,
      dialerSigns: true,
      dialerRequires: true,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    expect(
      client.events.byType(TransportEventType.AuthRejected)[0]?.detail[
        'rejection'
      ],
    ).toBe(ReadyRejection.Unsigned)
  })

  test('a rejected ready leaves nothing behind that the retry could reuse', async () => {
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      listenerKeys: impostorKeys,
    })
    await expect(client.connect(5_000)).rejects.toThrow(/budget exhausted/)
    // Each retry issued a fresh challenge and each was refused on its own
    // merits — a remembered nonce pair would have been the replay the
    // challenge exists to prevent.
    await waitUntil(() => server.connections === 0 && client.isClosed())
    expect(
      client.events.byType(TransportEventType.AuthRejected).length,
    ).toBeGreaterThan(1)
  })

  test('signing without a peer node to check against is refused at construction', () => {
    expect(
      () =>
        new TransportClient({
          endpoint: { unix: '/nonexistent.sock' },
          node: DIALER,
          psk: TEST_PSK,
          signing: { keys: dialerKeys, directory: fullDirectory() },
        }),
    ).toThrow(/signing requires peerNode/)
  })
})

describe('directory invalidation closes existing signed links', () => {
  test('revocation removes physical and retained channels, then rejects reconnect', async () => {
    const directory = fullDirectory()
    const { server, client } = hop({
      listenerSigns: true,
      dialerSigns: true,
      directory,
    })
    await client.connect(5_000)
    expect(server.connections).toBe(1)
    expect(server.channels).toBe(1)

    // This is the state transition a CertificateDirectory reports after a
    // fresh RL invalidates this peer. The directory already rejects the next
    // signed auth; the server handle must also revoke state admitted earlier.
    directory.delete(DIALER)
    expect(directory.publicKeyOf(DIALER)).toBeNull()
    server.closePeers([DIALER])
    server.closePeers([DIALER]) // repeated RL entries and close races are safe

    await waitUntil(() => server.connections === 0 && client.isClosed())
    expect(server.channels).toBe(0)
    expect(client.isClosed()).toBe(true)
    expect(
      client.events.byType(TransportEventType.ConnectionClosed)[0]?.detail[
        'code'
      ],
    ).toBe(4003)

    const returning = new TransportClient({
      endpoint: { unix: server.unix ?? '' },
      node: DIALER,
      peerNode: LISTENER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: FAST_BACKOFF,
      signing: { keys: dialerKeys, directory },
    })
    clients.push(returning)
    await expect(returning.connect(5_000)).rejects.toThrow(/4003/)
  })
})

describe('credential-scoped invalidation', () => {
  test('closes F1 only while F2 and explicit trust for the same node stay live', async () => {
    const explicitKeys = generateNodeKeyPair()
    let releaseRetained: (() => void) | undefined
    const directory: HandshakeCredentialDirectory = {
      publicKeyOf(node) {
        if (node === LISTENER) return listenerKeys.publicKey
        if (node === DIALER) return explicitKeys.publicKey
        return null
      },
      handshakeCredentialOf(node, selector) {
        if (node === LISTENER && selector === 'listener-credential') {
          return {
            publicKey: listenerKeys.publicKey,
            source: 'certificate',
            id: selector,
          }
        }
        if (node !== DIALER) return null
        if (selector === 'fingerprint-f1' || selector === 'fingerprint-f2') {
          return {
            publicKey: dialerKeys.publicKey,
            source: 'certificate',
            id: selector,
          }
        }
        if (selector === 'explicit-node-a') {
          return {
            publicKey: explicitKeys.publicKey,
            source: 'explicit',
            id: DIALER,
          }
        }
        return null
      },
    }
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)
    const server = startTransportServer({
      unix: socket.path,
      psk: TEST_PSK,
      onMessage: (message, context) => {
        if (message.taskId === 'retain-f1') {
          releaseRetained ??= context.channel.hold()
        }
      },
      signing: {
        node: LISTENER,
        keys: listenerKeys,
        directory,
        required: true,
        credentialProofRequired: true,
        credential: {
          selector: 'listener-credential',
          source: 'certificate',
          id: 'listener-credential',
        },
      },
    })
    servers.push(server)
    const client = (
      keys: NodeKeyPair,
      channelId: string,
      credential?: {
        readonly selector: string
        readonly source: string
        readonly id: string
      },
    ) => {
      const value = new TransportClient({
        endpoint: { unix: socket.path },
        node: DIALER,
        peerNode: LISTENER,
        channelId,
        psk: TEST_PSK,
        keepAliveIntervalMs: 0,
        backoff: FAST_BACKOFF,
        signing: {
          keys,
          directory,
          required: true,
          credentialProofRequired: true,
          ...(credential === undefined ? {} : { credential }),
        },
      })
      clients.push(value)
      return value
    }
    const f1 = client(dialerKeys, '11111111111111111111111111111111', {
      selector: 'fingerprint-f1',
      source: 'certificate',
      id: 'fingerprint-f1',
    })
    const f2 = client(dialerKeys, '22222222222222222222222222222222', {
      selector: 'fingerprint-f2',
      source: 'certificate',
      id: 'fingerprint-f2',
    })
    const explicit = client(explicitKeys, '33333333333333333333333333333333', {
      selector: 'explicit-node-a',
      source: 'explicit',
      id: DIALER,
    })
    const retainedF1 = client(dialerKeys, '44444444444444444444444444444444', {
      selector: 'fingerprint-f1',
      source: 'certificate',
      id: 'fingerprint-f1',
    })
    await Promise.all([
      f1.connect(),
      f2.connect(),
      explicit.connect(),
      retainedF1.connect(),
    ])
    await retainedF1.sendAndWait(makeMessage({ taskId: 'retain-f1' }))
    await retainedF1.close()
    await waitUntil(() => server.connections === 3)
    expect(server.channels).toBe(4)

    const revokedF1 = [
      { node: DIALER, source: 'certificate', id: 'fingerprint-f1' },
    ] as const
    server.closePeerCredentials(revokedF1)
    server.closePeerCredentials(revokedF1)
    await waitUntil(() => f1.isClosed() && server.connections === 2)
    expect(f2.isReady()).toBe(true)
    expect(explicit.isReady()).toBe(true)
    expect(f2.authenticatedCredential).toEqual({
      source: 'certificate',
      id: 'listener-credential',
    })
    expect(server.channels).toBe(2)
    releaseRetained?.()
  })
})

describe('§8.2 phase ① — CA-loaded dialer against a `--trust`-only listener', () => {
  /** What `--trust-ca` gives the dialer: a directory that resolves selectors. */
  function caDirectory(): HandshakeCredentialDirectory {
    return {
      publicKeyOf(node) {
        if (node === LISTENER) return listenerKeys.publicKey
        if (node === DIALER) return dialerKeys.publicKey
        return null
      },
      handshakeCredentialOf(node, selector) {
        if (node !== DIALER || selector !== 'fingerprint-f1') return null
        return {
          publicKey: dialerKeys.publicKey,
          source: 'certificate',
          id: selector,
        }
      },
    }
  }

  test('the upgraded node keeps its link to every peer that has not upgraded', async () => {
    // The reported configuration, byte for byte: dialer on `--trust-ca` +
    // `--cert`, listener on `--trust` alone — and the listener holding the very
    // key that checks the dialer's `sig`. Before this, the first node in a
    // fleet to gain a certificate lost every peer that had not gained one, and
    // lost it permanently: 4003 is terminal by this package's contract.
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)
    const handled: QianmoMessage[] = []
    const server = startTransportServer({
      unix: socket.path,
      psk: TEST_PSK,
      onMessage: message => {
        handled.push(message)
      },
      // No `--trust-ca`: a plain `StaticPublicKeyDirectory`, which is what
      // `buildPublicKeyDirectory()` returns when only `--trust` was given.
      signing: {
        node: LISTENER,
        keys: listenerKeys,
        directory: fullDirectory(),
      },
    })
    servers.push(server)
    const client = new TransportClient({
      endpoint: { unix: socket.path },
      node: DIALER,
      peerNode: LISTENER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: FAST_BACKOFF,
      signing: {
        keys: dialerKeys,
        directory: caDirectory(),
        credential: {
          selector: 'fingerprint-f1',
          source: 'certificate',
          id: 'fingerprint-f1',
        },
      },
    })
    clients.push(client)

    await client.connect(5_000)
    client.send(makeMessage())
    await client.waitForDrain()
    expect(handled).toHaveLength(1)

    const accepted = server.events.byType(TransportEventType.AuthAccepted)
    expect(accepted).toHaveLength(1)
    // `signature`, not `credential_signature`: this listener checked a
    // signature and nothing else, and the audit record says only that.
    expect(accepted[0]?.detail['authentication']).toBe('signature')
    expect(accepted[0]?.detail['credential']).toBeUndefined()
    // The dialer's own half. An unsigned ready would have read `psk`, so this
    // also pins that the §7.1.1 direction crossed the same boundary.
    expect(client.authenticatedBy).toBe('signature')
  })
})
