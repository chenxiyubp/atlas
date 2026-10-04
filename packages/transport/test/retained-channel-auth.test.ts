// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A retained logical channel owns authenticated state, not merely a node
 * label. These tests use raw sockets so a server-originated envelope can stay
 * deliberately unreceipted while another credential tries the same channel.
 *
 * Three properties, and the second is the one that is easy to lose while
 * getting the first right:
 *
 * 1. a channel's identity is frozen at admission, and no other identity —
 *    weaker *or* stronger — inherits its outbox;
 * 2. a dialer whose own identity legitimately moved is not killed for it. It
 *    is refused with a code of its own and recovers onto a fresh channel,
 *    bounded, leaving the old channel to expire untouched;
 * 3. the exact-credential proof is checked whenever a credential is claimed —
 *    never skipped because the directory said less than expected.
 */

import {
  createServer as createNetServer,
  connect as netConnect,
  type Socket,
} from 'node:net'
import { afterEach, describe, expect, test } from 'bun:test'
import WebSocket from 'ws'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  CLOSE_CHANNEL_CONFLICT,
  CLOSE_UNAUTHORIZED,
  FRAME_VERSION,
  FrameType,
  HandshakeRejection,
  MAX_CHANNEL_ROTATIONS,
  ReadyRejection,
  TransportClient,
  TransportEventType,
  authCredentialProofInput,
  authSigningInput,
  computeMac,
  newNonce,
  parseFrame,
  readyCredentialProofInput,
  readySigningInput,
  serializeFrame,
  startTransportServer,
  verifyAuthAttempt,
  verifyReady,
  type AuthAttempt,
  type AuthenticatedCredential,
  type HandshakeCredentialClaim,
  type HandshakeCredentialDirectory,
  type TransportChannel,
  type TransportEvent,
  type TransportFrame,
  type TransportServerHandle,
} from '../src/index.js'
import {
  TEST_PSK,
  WRONG_PSK,
  makeMessage,
  sleep,
  waitUntil,
} from './helpers.js'

const DIALER = 'node-a'
const LISTENER = 'node-b'
/** A second dialer segment, for "same key, other name" cases. */
const IMPOSTOR = 'node-c'
const F1 = 'fingerprint-f1'
const F2 = 'fingerprint-f2'
const K2 = 'fingerprint-key-2'
/**
 * A selector that resolves to the *same* key and the *same* id as {@link F1},
 * under a different `source`.
 *
 * Today's `CertificateDirectory` cannot produce this pair — its two sources
 * carry disjoint id namespaces (node segments vs. colon-separated
 * `fingerprint256`), so `id` equality already implies `source` equality there.
 * `HandshakeCredentialDirectory` is a published interface, though, and that
 * disjointness is a convention of one implementation rather than anything the
 * types enforce. The moment it stops holding — a third source on
 * `CertificateDirectory`, or somebody else's directory — `source` stops being
 * redundant and becomes the only separator left.
 */
const CROSS_SOURCE = 'explicit-selector-for-f1'

const listenerKeys = generateNodeKeyPair()
const firstKeys = generateNodeKeyPair()
const secondKeys = generateNodeKeyPair()

type RawAuthentication =
  | { readonly kind: 'psk' }
  | { readonly kind: 'signature'; readonly keys: NodeKeyPair }
  | {
      readonly kind: 'credential_signature'
      readonly keys: NodeKeyPair
      readonly credential: HandshakeCredentialClaim
    }

interface RawSession {
  readonly socket: WebSocket
  readonly outcome: 'ready' | 'closed'
  readonly closeCode: number | undefined
  readonly closed: Promise<number>
  readonly frames: TransportFrame[]
}

/** The taskId of the envelope a retained channel must never hand over. */
const RETAINED_SECRET = 'retained-only-for-the-old-identity'

const servers: TransportServerHandle[] = []
const sockets: WebSocket[] = []
const clients: TransportClient[] = []
const relays: Relay[] = []
const conflicting: ConflictingListener[] = []
const releases: Array<() => void> = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const client of clients.splice(0)) await client.close()
  for (const release of releases.splice(0)) release()
  for (const relay of relays.splice(0)) await relay.close()
  for (const listener of conflicting.splice(0)) await listener.close()
  for (const server of servers.splice(0)) await server.stop()
})

function exact(
  selector: string,
  keys: NodeKeyPair = firstKeys,
): RawAuthentication {
  return {
    kind: 'credential_signature',
    keys,
    credential: { selector, source: 'certificate', id: selector },
  }
}

/** {@link CROSS_SOURCE} on the wire: `explicit/F1`, proved by the same key. */
function crossSource(): RawAuthentication {
  return {
    kind: 'credential_signature',
    keys: firstKeys,
    credential: { selector: CROSS_SOURCE, source: 'explicit', id: F1 },
  }
}

/**
 * One handshake, driven frame by frame.
 *
 * `node` is a parameter because the frozen tuple has a leg for it: the PSK
 * tier proves nothing per node — anyone holding the secret computes the MAC
 * for any name — so a fixture that can only ever say `node-a` cannot pose the
 * question the identity freeze answers.
 */
async function rawHandshake(
  url: string,
  channelId: string,
  authentication: RawAuthentication,
  node: string = DIALER,
): Promise<RawSession> {
  const socket = new WebSocket(url)
  sockets.push(socket)
  const frames: TransportFrame[] = []
  let resolveClosed: (code: number) => void = () => {}
  const closed = new Promise<number>(resolve => {
    resolveClosed = resolve
  })
  const result = await new Promise<{
    readonly outcome: 'ready' | 'closed'
    readonly closeCode?: number
  }>((resolve, reject) => {
    let settled = false
    socket.once('error', reject)
    socket.once('close', code => {
      resolveClosed(code)
      if (!settled) {
        settled = true
        resolve({ outcome: 'closed', closeCode: code })
      }
    })
    socket.on('message', raw => {
      const frame = parseFrame(raw.toString())
      if (frame === null) return
      frames.push(frame)
      if (frame.t === FrameType.Challenge) {
        const clientNonce = newNonce()
        socket.send(
          serializeFrame({
            t: FrameType.Auth,
            v: FRAME_VERSION,
            node,
            nonce: frame.nonce,
            clientNonce,
            channelId,
            mac: computeMac(
              TEST_PSK,
              frame.nonce,
              clientNonce,
              node,
              channelId,
            ),
            ...(authentication.kind === 'psk'
              ? {}
              : {
                  sig: signBytes(
                    authentication.keys,
                    authSigningInput(frame.nonce, clientNonce, node, channelId),
                  ),
                }),
            ...(authentication.kind !== 'credential_signature'
              ? {}
              : {
                  credential: authentication.credential.selector,
                  credentialProof: signBytes(
                    authentication.keys,
                    authCredentialProofInput(
                      frame.nonce,
                      clientNonce,
                      node,
                      channelId,
                      authentication.credential.selector,
                      authentication.credential.source,
                      authentication.credential.id,
                    ),
                  ),
                }),
          }),
        )
        return
      }
      if (frame.t === FrameType.Ready && !settled) {
        settled = true
        resolve({ outcome: 'ready' })
      }
    })
  })
  return {
    socket,
    outcome: result.outcome,
    closeCode: result.closeCode,
    closed,
    frames,
  }
}

function envelopeCount(session: RawSession): number {
  return session.frames.filter(frame => frame.t === FrameType.Envelope).length
}

function hasEnvelope(session: RawSession): boolean {
  return envelopeCount(session) > 0
}

/**
 * {@link waitUntil}, reported rather than thrown.
 *
 * So that a failure points at the assertion that cares — "the owner never got
 * its reply" — instead of at a polling helper's timeout message, which names
 * neither the property nor the line that lost it.
 */
async function eventually(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    await waitUntil(predicate, timeoutMs)
    return true
  } catch {
    return false
  }
}

function sendRequest(session: RawSession, taskId: string): void {
  session.socket.send(
    serializeFrame({
      t: FrameType.Envelope,
      v: FRAME_VERSION,
      envelope: makeMessage({ taskId }),
    }),
  )
}

function credentialDirectory(
  legacyKey: () => string,
): HandshakeCredentialDirectory {
  return {
    publicKeyOf(node) {
      if (node === LISTENER) return listenerKeys.publicKey
      if (node === DIALER) return legacyKey()
      return null
    },
    handshakeCredentialOf(node, selector) {
      if (node !== DIALER) return null
      if (selector === F1 || selector === F2) {
        return {
          publicKey: firstKeys.publicKey,
          source: 'certificate',
          id: selector,
        }
      }
      if (selector === K2) {
        return {
          publicKey: secondKeys.publicKey,
          source: 'certificate',
          id: selector,
        }
      }
      // Same key, same id, other source — see {@link CROSS_SOURCE}.
      if (selector === CROSS_SOURCE) {
        return {
          publicKey: firstKeys.publicKey,
          source: 'explicit',
          id: F1,
        }
      }
      return null
    },
  }
}

function serverFor(
  directory: HandshakeCredentialDirectory,
): TransportServerHandle {
  const server = startTransportServer({
    port: 0,
    psk: TEST_PSK,
    signing: { node: LISTENER, keys: listenerKeys, directory },
    onMessage: (_message, context) => {
      context.channel.send(
        makeMessage({
          taskId: `retained-secret-${crypto.randomUUID()}`,
          payload: { retained: true },
        }),
      )
    },
  })
  servers.push(server)
  return server
}

describe('retained channel authentication binding', () => {
  test('same exact credential replays, while F2 and another key get 4004 with no payload', async () => {
    const directory = credentialDirectory(() => firstKeys.publicKey)
    const server = serverFor(directory)
    const url = server.url ?? ''
    const channelId = '1'.repeat(32)

    const first = await rawHandshake(url, channelId, exact(F1))
    expect(first.outcome).toBe('ready')
    sendRequest(first, 'seed-retained-outbox')
    await waitUntil(() => hasEnvelope(first))
    first.socket.close(1000)
    await first.closed
    await waitUntil(() => server.connections === 0 && server.channels === 1)

    // Both sockets authenticate concurrently. Only the credential that owns
    // the retained channel may bind and trigger the outbox replay.
    const [same, f2] = await Promise.all([
      rawHandshake(url, channelId, exact(F1)),
      rawHandshake(url, channelId, exact(F2)),
    ])
    expect(same.outcome).toBe('ready')
    await waitUntil(() => hasEnvelope(same))
    expect(f2.outcome).toBe('closed')
    // 4004, not 4003: the dialer's key is fine and its channel id is taken, and
    // those two call for opposite responses (`CLOSE_CHANNEL_CONFLICT`). What
    // the code must never do is let the refused socket see the payload.
    expect(f2.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(f2)).toBe(false)

    const anotherKey = await rawHandshake(url, channelId, exact(K2, secondKeys))
    expect(anotherKey.outcome).toBe('closed')
    expect(anotherKey.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(anotherKey)).toBe(false)
    expect(same.socket.readyState).toBe(WebSocket.OPEN)
  })

  test('a PSK-only listener refuses another node name on a retained channel', async () => {
    // The PSK tier is where the node name is the *only* separator in the frozen
    // tuple: `verifyAuth` returns neither a key nor a credential, so the other
    // three legs are byte-identical for any two dialers. The MAC does cover the
    // name — and proves nothing about it, because anyone holding the secret
    // computes it for whichever name they please. A shared key confers no
    // per-node identity, which is precisely why the channel has to keep one.
    const server = startTransportServer({
      port: 0,
      psk: TEST_PSK,
      onMessage: (_message, context) => {
        context.channel.send(
          makeMessage({ taskId: RETAINED_SECRET, payload: { retained: true } }),
        )
      },
    })
    servers.push(server)
    const url = server.url ?? ''
    const channelId = '7'.repeat(32)

    const owner = await rawHandshake(url, channelId, { kind: 'psk' })
    expect(owner.outcome).toBe('ready')
    sendRequest(owner, 'seed-psk-retained')
    await waitUntil(() => hasEnvelope(owner))
    owner.socket.close(1000)
    await owner.closed
    await waitUntil(() => server.connections === 0 && server.channels === 1)

    // Same secret, same channel id, another name — and the outbox it is
    // reaching for holds an envelope addressed to the identity that left it.
    const impostor = await rawHandshake(
      url,
      channelId,
      { kind: 'psk' },
      IMPOSTOR,
    )
    expect(impostor.outcome).toBe('closed')
    expect(impostor.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(impostor)).toBe(false)

    const mismatches = rejectionsOf(
      server,
      HandshakeRejection.ChannelIdentityMismatch,
    )
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.detail['node']).toBe(IMPOSTOR)
    expect(mismatches[0]?.detail['channelId']).toBe(channelId)
    expect(mismatches[0]?.detail['pending']).toBe(1)
  })

  test('two nodes behind one signing key are still two identities', async () => {
    // The isolating case. Above, a wrong name and a wrong key travel together,
    // so the key leg alone would refuse the dial and the name leg could be
    // missing without anything going red. Here the directory answers with the
    // *same* public key for both names — a fleet issued one certificate, a
    // half-finished rename — so every leg but the name matches, and the name is
    // the only thing left that can refuse it.
    const shared: HandshakeCredentialDirectory = {
      publicKeyOf(node) {
        if (node === LISTENER) return listenerKeys.publicKey
        if (node === DIALER || node === IMPOSTOR) return firstKeys.publicKey
        return null
      },
      handshakeCredentialOf: () => null,
    }
    const server = serverFor(shared)
    const url = server.url ?? ''
    const channelId = '8'.repeat(32)
    const signature: RawAuthentication = { kind: 'signature', keys: firstKeys }

    const owner = await rawHandshake(url, channelId, signature)
    expect(owner.outcome).toBe('ready')
    sendRequest(owner, 'seed-shared-key-retained')
    await waitUntil(() => hasEnvelope(owner))
    owner.socket.close(1000)
    await owner.closed
    await waitUntil(() => server.connections === 0 && server.channels === 1)

    const impostor = await rawHandshake(url, channelId, signature, IMPOSTOR)
    // 4004 rather than 4003 is itself the isolation: the signature verified
    // under the shared key, so the handshake got past authentication and was
    // stopped by the channel's identity — the name, and nothing else.
    expect(impostor.outcome).toBe('closed')
    expect(impostor.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(impostor)).toBe(false)

    const mismatches = rejectionsOf(
      server,
      HandshakeRejection.ChannelIdentityMismatch,
    )
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.detail['node']).toBe(IMPOSTOR)
    expect(mismatches[0]?.detail['channelId']).toBe(channelId)

    // The control: the same name and key on a channel of its own is welcome.
    // Without it, "node-c was refused" could be read as "node-c cannot dial",
    // and the test would pass for a reason that has nothing to do with the
    // retained channel.
    const ownChannel = await rawHandshake(
      url,
      '9'.repeat(32),
      signature,
      IMPOSTOR,
    )
    expect(ownChannel.outcome).toBe('ready')
  })

  test('an intruder is refused before it is bound, so the owner keeps its live link', async () => {
    // The ordering — refuse, *then* bind — is a security property that the
    // payload checks above cannot see: an intruder bound and refused a line
    // later never drains the outbox either, because it is closed before
    // `ready()`, so "no payload leaked" passes just as happily. What a late
    // refusal actually costs is the holder: `bind` replaces the channel's
    // socket and closes the one it displaces (`CLOSE_REPLACED`), hanging up on
    // a healthy owner mid-task. Read three independent ways below, because a
    // property this quiet must not rest on a single line.
    const directory = credentialDirectory(() => firstKeys.publicKey)
    const server = serverFor(directory)
    const url = server.url ?? ''
    const channelId = 'f'.repeat(32)

    const owner = await rawHandshake(url, channelId, exact(F1))
    expect(owner.outcome).toBe('ready')
    sendRequest(owner, 'seed-live-owner')
    await waitUntil(() => envelopeCount(owner) === 1)

    // Live rather than retained, deliberately: a channel whose owner is still
    // on it is the case where binding first takes a working link away.
    const intruder = await rawHandshake(url, channelId, exact(K2, secondKeys))
    expect(intruder.outcome).toBe('closed')
    expect(intruder.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)

    // ① The owner's socket, as the owner sees it.
    expect(owner.socket.readyState).toBe(WebSocket.OPEN)
    // ② The channel still routes to it — proven by traffic, not by state.
    sendRequest(owner, 'after-the-refusal')
    expect(await eventually(() => envelopeCount(owner) >= 2)).toBe(true)
    // ③ And the listener's own count of live connections, which never
    // consults the dialer's socket at all.
    expect(await eventually(() => server.connections === 1)).toBe(true)
  })

  test('PSK, legacy signature, and exact signature cannot inherit each other', async () => {
    let legacyKey = firstKeys.publicKey
    const server = serverFor(credentialDirectory(() => legacyKey))
    const url = server.url ?? ''
    const psk: RawAuthentication = { kind: 'psk' }
    const legacy: RawAuthentication = { kind: 'signature', keys: firstKeys }
    const credential = exact(F1)
    const transitions: readonly (readonly [
      RawAuthentication,
      RawAuthentication,
    ])[] = [
      [psk, legacy],
      [legacy, psk],
      [psk, credential],
      [credential, psk],
      [legacy, credential],
      [credential, legacy],
    ]

    for (const [index, [initial, replacement]] of transitions.entries()) {
      const channelId = String(index + 2).repeat(32)
      const first = await rawHandshake(url, channelId, initial)
      expect(first.outcome).toBe('ready')
      sendRequest(first, `seed-transition-${index}`)
      await waitUntil(() => hasEnvelope(first))
      first.socket.close(1000)
      await first.closed

      const refused = await rawHandshake(url, channelId, replacement)
      expect(refused.outcome).toBe('closed')
      expect(refused.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
      expect(hasEnvelope(refused)).toBe(false)
    }

    // Legacy signatures have no credential source/id, so the verified key is
    // retained as an additional internal binding. A directory key rotation
    // must not let a new key inherit the old key's payloads.
    const channelId = '8'.repeat(32)
    const original = await rawHandshake(url, channelId, legacy)
    expect(original.outcome).toBe('ready')
    sendRequest(original, 'seed-legacy-key-rotation')
    await waitUntil(() => hasEnvelope(original))
    original.socket.close(1000)
    await original.closed

    legacyKey = secondKeys.publicKey
    const changedKey = await rawHandshake(url, channelId, {
      kind: 'signature',
      keys: secondKeys,
    })
    expect(changedKey.outcome).toBe('closed')
    expect(changedKey.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(changedKey)).toBe(false)
  })

  test('the same key and the same id under another source are two identities', async () => {
    // The frozen tuple's credential leg compares `source` *and* `id`, and this
    // is the case that separates them. Every other credential in this suite is
    // `certificate`, so a mutation deleting the `source ===` conjunct used to
    // survive the whole file: not an equivalent mutation, a coverage hole.
    // See {@link CROSS_SOURCE} for why the shape is worth pinning even though
    // today's directory implementation cannot emit it.
    const server = serverFor(credentialDirectory(() => firstKeys.publicKey))
    const url = server.url ?? ''
    const retained = '9'.repeat(32)

    const owner = await rawHandshake(url, retained, exact(F1))
    expect(owner.outcome).toBe('ready')
    sendRequest(owner, 'seed-retained-outbox')
    await waitUntil(() => hasEnvelope(owner))
    owner.socket.close(1000)
    await owner.closed
    await waitUntil(() => server.connections === 0 && server.channels === 1)

    // First on a channel of its own, so the two admissions can be read side by
    // side: same node, same tier, same key, same id — one leg apart.
    const fresh = await rawHandshake(url, 'a'.repeat(32), crossSource())
    expect(fresh.outcome).toBe('ready')
    const accepted = server.events
      .byType(TransportEventType.AuthAccepted)
      .map(event => event.detail)
    expect(accepted).toHaveLength(2)
    expect(accepted[0]).toMatchObject({
      node: DIALER,
      authentication: 'credential_signature',
      credentialSource: 'certificate',
      credentialId: F1,
    })
    expect(accepted[1]).toMatchObject({
      node: DIALER,
      authentication: 'credential_signature',
      credentialSource: 'explicit',
      credentialId: F1,
    })

    // And therefore it may not inherit the retained channel. The handshake
    // itself succeeds — the refusal is the identity freeze, not the proof.
    const conflicting = await rawHandshake(url, retained, crossSource())
    expect(conflicting.outcome).toBe('closed')
    expect(conflicting.closeCode).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(hasEnvelope(conflicting)).toBe(false)
    expect(
      rejectionsOf(server, HandshakeRejection.ChannelIdentityMismatch),
    ).toHaveLength(1)
    expect(fresh.socket.readyState).toBe(WebSocket.OPEN)
  })
})

/**
 * A TCP relay the test can sever on demand.
 *
 * Severing a live link *without* telling either endpoint anything is the one
 * thing neither half of this package exposes, and it is exactly the shape of
 * the production event these tests are about: the dialer sees a dropped socket
 * and reconnects, while the listener sees its socket close and keeps the
 * logical channel — with whatever is still in its outbox — retained. Killing
 * the listener instead would take the retained channel with it and test
 * nothing.
 */
interface Relay {
  readonly url: string
  sever(): void
  close(): Promise<void>
}

function startRelay(targetPort: number): Promise<Relay> {
  const live = new Set<Socket>()
  const server = createNetServer(downstream => {
    const upstream = netConnect(targetPort, '127.0.0.1')
    live.add(downstream)
    live.add(upstream)
    // A severed socket emits ECONNRESET on both halves; unhandled 'error' on an
    // EventEmitter is rethrown and would take the test process with it.
    downstream.on('error', () => {})
    upstream.on('error', () => {})
    downstream.pipe(upstream)
    upstream.pipe(downstream)
    const drop = (): void => {
      live.delete(downstream)
      live.delete(upstream)
      downstream.destroy()
      upstream.destroy()
    }
    downstream.on('close', drop)
    upstream.on('close', drop)
  })
  return new Promise<Relay>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      const killLive = (): void => {
        for (const socket of [...live]) socket.destroy()
        live.clear()
      }
      resolve({
        url: `ws://127.0.0.1:${port}`,
        sever: killLive,
        close: () =>
          new Promise<void>(done => {
            killLive()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * A listener that answers auth frames with {@link CLOSE_CHANNEL_CONFLICT}.
 *
 * No real transport server can refuse every one of them: a fresh 128-bit
 * channel id cannot collide with a channel that does not exist, so the *first*
 * rotation always resolves a genuine conflict. Which is why the bound is only
 * observable against a listener refusing unconditionally — and that is also
 * the case the bound exists for. A listener saying no to everything is not a
 * collision, and rotating at it forever is a reconnect storm wearing
 * recovery's clothes.
 *
 * `answer` scripts that per auth frame, because the *other* shape matters
 * too: conflicts with an admission between them are separate events rather
 * than one unresolved one, and only a listener that can do both tells the two
 * apart.
 */
interface ConflictingListener {
  readonly url: string
  /** Channel ids offered, in order. */
  readonly seen: string[]
  close(): Promise<void>
}

function conflictingListener(
  answer: (attempt: number) => 'conflict' | 'admit' = () => 'conflict',
): ConflictingListener {
  const seen: string[] = []
  const listener = Bun.serve<undefined, never>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response('expected websocket', { status: 426 })
    },
    websocket: {
      open(socket) {
        socket.send(
          serializeFrame({
            t: FrameType.Challenge,
            v: FRAME_VERSION,
            nonce: newNonce(),
          }),
        )
      },
      message(socket, raw) {
        const frame = parseFrame(typeof raw === 'string' ? raw : raw.toString())
        if (frame === null || frame.t !== FrameType.Auth) return
        seen.push(frame.channelId)
        if (answer(seen.length) === 'conflict') {
          socket.close(
            CLOSE_CHANNEL_CONFLICT,
            'logical channel identity conflict',
          )
          return
        }
        // Admitted, then dropped the way an ordinary link loss looks — a code
        // the dialer reconnects from. The drop is the point: the next conflict
        // has to arrive on a *new* connection to be a second conflict at all.
        socket.send(serializeFrame({ t: FrameType.Ready, v: FRAME_VERSION }))
        const drop = setTimeout(() => socket.close(1000, 'link dropped'), 5)
        drop.unref?.()
      },
    },
  })
  return {
    url: `ws://127.0.0.1:${listener.port ?? 0}`,
    seen,
    close: async (): Promise<void> => {
      // Bounded for the reason `server.ts` records at its own `stop`: on Bun
      // 1.3.13 a server that has closed a WebSocket itself never resolves
      // `stop()`, and closing every socket is all this listener does. The port
      // is released either way; only the promise is lost.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        listener.stop(true),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 200)
          timer.unref?.()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** Rejections of one kind, as the listener recorded them. */
function rejectionsOf(
  server: TransportServerHandle,
  rejection: HandshakeRejection,
): readonly TransportEvent[] {
  return server.events
    .byType(TransportEventType.AuthRejected)
    .filter(event => event.detail['rejection'] === rejection)
}

describe('a conflicting channel id is survivable, not fatal', () => {
  test('a directory change under a retained channel moves the dialer to a fresh channel, leaving the old outbox behind', async () => {
    // The production trigger reproduced exactly: the dialer changes nothing —
    // same key, same certificate, same bytes — while the listener's directory
    // gains an explicit trust row for that key mid-task. The *effective*
    // credential therefore moves under a channel that is still retained, and
    // the dialer is locked out of a channel it never stopped owning.
    let effective: AuthenticatedCredential = { source: 'certificate', id: F1 }
    const directory: HandshakeCredentialDirectory = {
      publicKeyOf(node) {
        if (node === LISTENER) return listenerKeys.publicKey
        if (node === DIALER) return firstKeys.publicKey
        return null
      },
      handshakeCredentialOf(node, selector) {
        if (node !== DIALER || selector !== F1) return null
        return {
          publicKey: firstKeys.publicKey,
          source: effective.source,
          id: effective.id,
          // The dialer's proof always covers the certificate it claimed; only
          // the credential this listener adopts locally moves.
          proofCredential: { source: 'certificate', id: F1 },
        }
      },
    }

    // An array, not a `let`: TypeScript keeps the `null` narrowing across an
    // assignment it only sees inside a callback.
    const retained: TransportChannel[] = []
    const server = startTransportServer({
      port: 0,
      psk: TEST_PSK,
      signing: { node: LISTENER, keys: listenerKeys, directory },
      onMessage: (_message, context) => {
        if (retained.length > 0) return
        retained.push(context.channel)
        // A hold is what a node in the middle of a task takes, and it is the
        // ordinary reason a channel is still in the table when its peer comes
        // back (`resident.ts`, `activator/routes.ts`).
        releases.push(context.channel.hold())
      },
    })
    servers.push(server)
    const relay = await startRelay(server.port ?? 0)
    relays.push(relay)

    const delivered: string[] = []
    const client = new TransportClient({
      endpoint: { url: relay.url },
      node: DIALER,
      peerNode: LISTENER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      // Wide enough that the reconnect cannot land in the middle of the
      // listener-side setup below, which takes microseconds.
      backoff: {
        baseDelayMs: 400,
        maxDelayMs: 400,
        jitterRatio: 0,
        giveUpAfterMs: 20_000,
      },
      signing: {
        keys: firstKeys,
        directory,
        credential: { selector: F1, source: 'certificate', id: F1 },
      },
      onMessage: message => {
        delivered.push(message.taskId)
      },
    })
    clients.push(client)

    await client.connect(5_000)
    const original = client.id
    await client.sendAndWait(makeMessage({ taskId: 'seed-hold' }), 5_000)
    expect(retained).toHaveLength(1)

    // The listener's view of this dialer changes while the link is up. The live
    // channel keeps the identity it was admitted under; only the next handshake
    // resolves differently.
    effective = { source: 'explicit', id: 'operator-pinned' }

    relay.sever()
    await waitUntil(() => server.connections === 0)
    expect(server.channels).toBe(1)

    // The retained channel now holds an envelope only the old identity is
    // entitled to. This is the payload the identity freeze exists to protect.
    const channel = retained[0]
    channel?.send(makeMessage({ taskId: RETAINED_SECRET }))
    expect(channel?.pending).toBe(1)

    await waitUntil(() => client.isReady(), 10_000)
    expect(client.isClosed()).toBe(false)
    expect(client.id).not.toBe(original)

    // The security invariant, asserted head-on rather than inferred from "it
    // reconnected": the retained envelope is still on the old channel and was
    // never handed to the identity that replaced it.
    await sleep(150)
    expect(delivered).not.toContain(RETAINED_SECRET)
    expect(channel?.pending).toBe(1)
    expect(server.channels).toBe(2)

    // The listener's record names the channel, which is the one field an
    // operator needs to find the other side of the collision, and says how much
    // was stranded on it.
    const mismatches = rejectionsOf(
      server,
      HandshakeRejection.ChannelIdentityMismatch,
    )
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.detail['channelId']).toBe(original)
    expect(mismatches[0]?.detail['pending']).toBe(1)
    expect(mismatches[0]?.detail['closeCode']).toBe(CLOSE_CHANNEL_CONFLICT)
    expect(mismatches[0]?.detail['node']).toBe(DIALER)

    // And the dialer's record admits the loss rather than passing the rotation
    // off as an ordinary reconnect.
    const rotations = client.events.byType(TransportEventType.ChannelRotated)
    expect(rotations).toHaveLength(1)
    expect(rotations[0]?.detail['abandoned']).toBe(original)
    expect(rotations[0]?.detail['channelId']).toBe(client.id)
    expect(rotations[0]?.detail['rotation']).toBe(1)
  })

  test('a caller-supplied channel id is pinned, and the conflict stays fatal', async () => {
    const directory = credentialDirectory(() => firstKeys.publicKey)
    const server = serverFor(directory)
    const url = server.url ?? ''
    const channelId = 'a'.repeat(32)

    const owner = await rawHandshake(url, channelId, exact(F1))
    expect(owner.outcome).toBe('ready')
    sendRequest(owner, 'seed-pinned-channel')
    await waitUntil(() => hasEnvelope(owner))
    owner.socket.close(1000)
    await owner.closed
    await waitUntil(() => server.connections === 0 && server.channels === 1)

    // Naming the channel is the whole request; moving to a different one would
    // hand back a healthy-looking link that answers a question nobody asked.
    const pinned = new TransportClient({
      endpoint: { url },
      node: DIALER,
      peerNode: LISTENER,
      psk: TEST_PSK,
      channelId,
      keepAliveIntervalMs: 0,
      signing: {
        keys: secondKeys,
        directory,
        credential: { selector: K2, source: 'certificate', id: K2 },
      },
    })
    clients.push(pinned)

    await expect(pinned.connect(5_000)).rejects.toThrow(/4004/)
    expect(pinned.isClosed()).toBe(true)
    expect(pinned.id).toBe(channelId)
    expect(
      pinned.events.byType(TransportEventType.ChannelRotated),
    ).toHaveLength(0)
  })

  test('rotation is bounded, and the fatal end tells parked sends the real cause', async () => {
    const listener = conflictingListener()
    conflicting.push(listener)
    const client = new TransportClient({
      endpoint: { url: listener.url },
      node: DIALER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: {
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterRatio: 0,
        giveUpAfterMs: 20_000,
      },
    })
    clients.push(client)

    // Parked before the link ever comes up, with a receipt timeout far longer
    // than this test can run. Settling at all therefore means the fatal path
    // closed the outbox with the real reason, not that the timeout fired —
    // which is the difference between "handshake rejected (4004)" and "no
    // receipt within 30000ms", i.e. between the cause and the symptom.
    const startedAt = Date.now()
    const parked = client
      .sendAndWait(makeMessage({ taskId: 'parked-across-fatal' }), 30_000)
      .then(() => 'resolved')
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      )

    await expect(client.connect(10_000)).rejects.toThrow(/4004/)
    expect(await parked).toMatch(/4004/)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(client.isClosed()).toBe(true)

    expect(
      client.events.byType(TransportEventType.ChannelRotated),
    ).toHaveLength(MAX_CHANNEL_ROTATIONS)
    // One dial per channel id, and never the same id twice: a rotation that
    // reused an id would collide again by construction.
    expect(listener.seen).toHaveLength(MAX_CHANNEL_ROTATIONS + 1)
    expect(new Set(listener.seen).size).toBe(MAX_CHANNEL_ROTATIONS + 1)
  })

  test('the bound counts one run of conflicts, not a lifetime of them', async () => {
    // Every conflict here is resolved by an admission before the next one
    // arrives, which is the shape the trigger has: an operator edits the
    // listener's directory, the dialer moves, and the next edit is a separate
    // event later in the same process's life. A lifetime budget cannot tell
    // that from a listener refusing every id in a row, so it retires a node
    // that is doing exactly what it was told to do — and the fourth `--trust`
    // edit is not a rare number for a long-lived one.
    const listener = conflictingListener(attempt =>
      attempt % 2 === 0 ? 'conflict' : 'admit',
    )
    conflicting.push(listener)
    const client = new TransportClient({
      endpoint: { url: listener.url },
      node: DIALER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: {
        baseDelayMs: 5,
        maxDelayMs: 10,
        jitterRatio: 0,
        giveUpAfterMs: 20_000,
      },
    })
    clients.push(client)

    await client.connect(5_000)
    const past = MAX_CHANNEL_ROTATIONS + 1
    await waitUntil(
      () =>
        client.events.byType(TransportEventType.ChannelRotated).length >= past,
      10_000,
    )
    expect(client.isClosed()).toBe(false)

    // Each one is a *first* rotation, which is the reset asserted where it
    // shows rather than through the counter it comes from: under a lifetime
    // budget these would read 1, 2, 3 and the fourth would never be recorded.
    const rotations = client.events.byType(TransportEventType.ChannelRotated)
    expect(rotations.map(event => event.detail['rotation'])).toEqual(
      rotations.map(() => 1),
    )
    expect(rotations.length).toBeGreaterThanOrEqual(past)
  })

  test('a client that will not reconnect reports the conflict, not a phantom rotation', async () => {
    // `giveUpAfterMs: 0` is the live configuration of `@qianmo/tunnel`, not a
    // corner of the option space: a tunnel that comes back is a lease that
    // outlived its terms. Such a client never dials again, so a rotation would
    // put a fresh id in a loss record and on no wire.
    const listener = conflictingListener()
    conflicting.push(listener)
    const client = new TransportClient({
      endpoint: { url: listener.url },
      node: DIALER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: { giveUpAfterMs: 0 },
    })
    clients.push(client)
    const dialled = client.id

    const parked = client
      .sendAndWait(makeMessage({ taskId: 'parked-across-unrotatable' }), 30_000)
      .then(() => 'resolved')
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      )

    await expect(client.connect(5_000)).rejects.toThrow(/4004/)
    const reported = await parked
    expect(reported).toMatch(/4004/)
    // The cause, and specifically not the give-up path's symptom: this client
    // did not run out of reconnects mid-recovery, it was refused once.
    expect(reported).not.toMatch(/budget/)
    expect(
      client.events.byType(TransportEventType.ReconnectGaveUp),
    ).toHaveLength(0)

    // And nothing was abandoned, because nothing moved: one dial, one id.
    expect(
      client.events.byType(TransportEventType.ChannelRotated),
    ).toHaveLength(0)
    expect(client.id).toBe(dialled)
    expect(listener.seen).toEqual([dialled])
  })

  test('a budget that expires between the two questions still answers with the conflict', async () => {
    // A 4004 asks two things at once — may this client take a fresh id, and is
    // there budget left for the dial that would carry it — and they have to be
    // answered from one reading of the clock. Read twice and the give-up
    // boundary can fall in between: the rotation is recorded, the dial never
    // happens, and the client dies reporting the budget. That is the same pair
    // of symptoms as the `giveUpAfterMs: 0` case above, on a window too narrow
    // to race for, so the clock is injected and the jump is armed from the
    // event sink — `EventRecorder` calls it synchronously, inside the rotation,
    // which is exactly the gap in question.
    //
    // The jump has to clear `giveUpAfterMs` while staying under the E4 freeze
    // threshold (`maxDelayMs × timeJumpFactor`), or the schedule reads it as a
    // thaw and hands back a fresh budget instead of giving up.
    const listener = conflictingListener()
    conflicting.push(listener)
    const budgetMs = 1_000
    let clock = 0
    let armed = false
    const client = new TransportClient({
      endpoint: { url: listener.url },
      node: DIALER,
      psk: TEST_PSK,
      keepAliveIntervalMs: 0,
      backoff: {
        baseDelayMs: 1,
        maxDelayMs: 10_000,
        jitterRatio: 0,
        giveUpAfterMs: budgetMs,
      },
      now: () => {
        if (armed) {
          armed = false
          clock += 5 * budgetMs
        }
        return clock
      },
      events: event => {
        if (event.type === TransportEventType.ChannelRotated) armed = true
      },
    })
    clients.push(client)
    const abandoned = client.id

    const failure = await client
      .connect(5_000)
      .then(() => 'connected')
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      )
    // The conflict, not the budget it stepped over on the way out.
    expect(failure).toMatch(/4004/)
    expect(failure).not.toMatch(/budget/)
    expect(
      client.events.byType(TransportEventType.ReconnectGaveUp),
    ).toHaveLength(0)

    // And the rotation it did spend was spent on a dial: the abandoned id and
    // the one that replaced it are both on the wire, in that order. A rotation
    // recorded without the dial behind it is a loss record for a loss that
    // never happened, and the two sides cannot reconcile it.
    const rotations = client.events.byType(TransportEventType.ChannelRotated)
    expect(rotations).toHaveLength(1)
    expect(rotations[0]?.detail['abandoned']).toBe(abandoned)
    expect(rotations[0]?.detail['channelId']).toBe(client.id)
    expect(listener.seen).toEqual([abandoned, client.id])
    // Scaffolding, asserted last so it never speaks before the properties do:
    // the jump fired, so the boundary really was crossed mid-rotation.
    expect(clock).toBeGreaterThan(0)
  })

  test('a 4003 tells parked sends the real cause too', async () => {
    const server = serverFor(credentialDirectory(() => firstKeys.publicKey))
    const client = new TransportClient({
      endpoint: { url: server.url ?? '' },
      node: DIALER,
      psk: WRONG_PSK,
      keepAliveIntervalMs: 0,
    })
    clients.push(client)

    const startedAt = Date.now()
    const parked = client
      .sendAndWait(makeMessage({ taskId: 'parked-across-4003' }), 30_000)
      .then(() => 'resolved')
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      )

    await expect(client.connect(5_000)).rejects.toThrow(/4003/)
    expect(await parked).toMatch(/4003/)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  })

  test('a malformed channel id is still bad_channel, and carries no channel id', async () => {
    const server = serverFor(credentialDirectory(() => firstKeys.publicKey))
    const malformed = await rawHandshake(
      server.url ?? '',
      'not-a-channel-id',
      exact(F1),
    )
    expect(malformed.outcome).toBe('closed')
    // Still 4003 and still 'unauthorized': the dialer sent nonsense in the
    // field, which is a different problem with a different fix, and must not
    // be reported as the recoverable one.
    expect(malformed.closeCode).toBe(CLOSE_UNAUTHORIZED)

    expect(rejectionsOf(server, HandshakeRejection.BadChannel)).toHaveLength(1)
    expect(
      rejectionsOf(server, HandshakeRejection.ChannelIdentityMismatch),
    ).toHaveLength(0)
    // The mismatch rejection is the only one that names a channel; a
    // `bad_channel` record naming one would be echoing an unverified field.
    expect(
      rejectionsOf(server, HandshakeRejection.BadChannel)[0]?.detail[
        'channelId'
      ],
    ).toBeUndefined()
  })
})

describe('the credential proof is never skipped', () => {
  const NONCE = 'c'.repeat(32)
  const CLIENT_NONCE = 'd'.repeat(32)
  const CHANNEL = 'e'.repeat(32)
  const EFFECTIVE = { source: 'explicit', id: 'operator-pinned' } as const
  const PROVEN = { source: 'certificate', id: F1 } as const

  /**
   * A directory whose adopted credential differs from the one the peer proves.
   *
   * `proofCredential` exists for exactly this: an explicit trust row wins
   * locally while the peer can only ever prove the certificate it holds. The
   * check must therefore bind `proofCredential` — and must *run*, which is the
   * property these two cases pin. Written as a rejection of a proof over the
   * adopted credential, because that is the value the pre-fix code would have
   * had to fall back to had the check been skipped.
   */
  function splitDirectory(
    proofCredential: AuthenticatedCredential | undefined,
  ): HandshakeCredentialDirectory {
    return {
      publicKeyOf(node) {
        if (node === LISTENER) return listenerKeys.publicKey
        if (node === DIALER) return firstKeys.publicKey
        return null
      },
      handshakeCredentialOf(node, selector) {
        if (selector !== F1) return null
        return {
          publicKey:
            node === LISTENER ? listenerKeys.publicKey : firstKeys.publicKey,
          ...EFFECTIVE,
          // `undefined` is the shape a directory written before this field
          // existed produces; the resolver falls it back to the adopted
          // credential rather than treating "nothing said" as "nothing to
          // check". Asserted below in both shapes.
          ...(proofCredential === undefined ? {} : { proofCredential }),
        }
      },
    }
  }

  function authAttempt(
    keys: NodeKeyPair,
    proofOver: AuthenticatedCredential,
  ): AuthAttempt {
    return {
      node: DIALER,
      nonce: NONCE,
      clientNonce: CLIENT_NONCE,
      channelId: CHANNEL,
      mac: computeMac(TEST_PSK, NONCE, CLIENT_NONCE, DIALER, CHANNEL),
      sig: signBytes(
        keys,
        authSigningInput(NONCE, CLIENT_NONCE, DIALER, CHANNEL),
      ),
      credential: F1,
      credentialProof: signBytes(
        keys,
        authCredentialProofInput(
          NONCE,
          CLIENT_NONCE,
          DIALER,
          CHANNEL,
          F1,
          proofOver.source,
          proofOver.id,
        ),
      ),
    }
  }

  function readyFrame(
    keys: NodeKeyPair,
    proofOver: AuthenticatedCredential,
  ): {
    node: string
    sig: string
    credential: string
    credentialProof: string
  } {
    return {
      node: LISTENER,
      sig: signBytes(
        keys,
        readySigningInput(NONCE, CLIENT_NONCE, DIALER, CHANNEL, LISTENER),
      ),
      credential: F1,
      credentialProof: signBytes(
        keys,
        readyCredentialProofInput(
          NONCE,
          CLIENT_NONCE,
          DIALER,
          CHANNEL,
          LISTENER,
          F1,
          proofOver.source,
          proofOver.id,
        ),
      ),
    }
  }

  const tuple = {
    serverNonce: NONCE,
    clientNonce: CLIENT_NONCE,
    node: DIALER,
    channelId: CHANNEL,
  }

  test('auth: the proof must bind the proof credential, and a split directory refuses anything else', () => {
    const directory = splitDirectory(PROVEN)
    const signing = { keys: listenerKeys, directory }

    const good = verifyAuthAttempt(
      TEST_PSK,
      signing,
      NONCE,
      authAttempt(firstKeys, PROVEN),
    )
    expect(good.ok).toBe(true)
    // The connection is owned by the credential this listener adopts, not by
    // the one the peer proved.
    expect(good.ok && good.credential).toEqual(EFFECTIVE)
    expect(good.ok && good.authentication).toBe('credential_signature')

    const wrong = verifyAuthAttempt(
      TEST_PSK,
      signing,
      NONCE,
      authAttempt(firstKeys, EFFECTIVE),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(
      HandshakeRejection.BadCredentialProof,
    )
  })

  test('auth: a directory that names no proof credential still gets its proof checked', () => {
    const signing = { keys: listenerKeys, directory: splitDirectory(undefined) }
    // Falls back to the adopted credential — and *checks* it. A skipped check
    // would admit this second attempt as `credential_signature` on a proof over
    // bytes the directory never named.
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        signing,
        NONCE,
        authAttempt(firstKeys, EFFECTIVE),
      ).ok,
    ).toBe(true)
    const wrong = verifyAuthAttempt(
      TEST_PSK,
      signing,
      NONCE,
      authAttempt(firstKeys, PROVEN),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(
      HandshakeRejection.BadCredentialProof,
    )
  })

  test('ready: the proof must bind the proof credential, and a split directory refuses anything else', () => {
    const directory = splitDirectory(PROVEN)
    const signing = { keys: firstKeys, directory }

    const good = verifyReady(
      LISTENER,
      signing,
      tuple,
      readyFrame(listenerKeys, PROVEN),
    )
    expect(good.ok).toBe(true)
    expect(good.ok && good.credential).toEqual(EFFECTIVE)

    const wrong = verifyReady(
      LISTENER,
      signing,
      tuple,
      readyFrame(listenerKeys, EFFECTIVE),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(ReadyRejection.BadCredentialProof)
  })

  test('ready: a directory that names no proof credential still gets its proof checked', () => {
    const signing = { keys: firstKeys, directory: splitDirectory(undefined) }
    expect(
      verifyReady(LISTENER, signing, tuple, readyFrame(listenerKeys, EFFECTIVE))
        .ok,
    ).toBe(true)
    const wrong = verifyReady(
      LISTENER,
      signing,
      tuple,
      readyFrame(listenerKeys, PROVEN),
    )
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.rejection).toBe(ReadyRejection.BadCredentialProof)
  })
})
