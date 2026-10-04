// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { unlinkSync } from 'node:fs'
import type { Server, ServerWebSocket, TLSOptions, WebSocketHandler } from 'bun'
import {
  LIMITS,
  peerSupportsType,
  type MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import type {
  InboundContext,
  InboundHandler,
  TransportChannel,
} from './channel.js'
import { DedupTable } from './dedup.js'
import {
  EventRecorder,
  TransportEventType,
  type EventDetail,
  type TransportEventSink,
} from './events.js'
import {
  FRAME_VERSION,
  FrameType,
  ReceiptStatus,
  parseFrame,
  serializeFrame,
  type ReceiptFrame,
  type TransportFrame,
} from './frames.js'
import {
  CLOSE_CHANNEL_CONFLICT,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_UNAUTHORIZED,
  HandshakeRejection,
  assertUsablePsk,
  newNonce,
  signReady,
  verifyAuthAttempt,
  type AuthenticatedCredential,
  type HandshakeAuthentication,
  type ListenerIdentity,
} from './handshake.js'
import {
  DEFAULT_MAX_QUEUED,
  EnvelopeOutbox,
  type SuccessfulReceiptStatus,
} from './outbox.js'
import { receiveEnvelope } from './receiver.js'

/**
 * The listening half of a Qianmo hop — the half the base does not have.
 *
 * `src/cli/transports/` is 3,326 lines of *client*: every one of them dials
 * out (`WebSocketTransport.ts:163` / `:180`) and none of them accepts. A node
 * that other nodes can send to needs the other side of that connection, and
 * this file is it.
 *
 * Responsibilities, in the order a byte meets them: accept, challenge, verify
 * the dialer's proof — an Ed25519 signature where one is offered and this node
 * has the material to check it, the pre-shared key otherwise (`handshake.ts`)
 * — validate the envelope, dedup it, hand it to the node, and answer with a
 * receipt. Anything before the handshake completes is answered with a close
 * code, never with an error body — an unauthenticated peer learns nothing from
 * us, including *which* of the ways to fail it found.
 *
 * A receipt is **not** the protocol's `ack` (see `frames.ts`): it means this
 * node has taken the envelope in, and the acknowledgement that the target
 * agent actually read it belongs to `@qianmo/adapter`, one layer up.
 */

/** Per-socket state. A logical channel may outlive several such sockets. */
interface ConnectionState {
  readonly nonce: string
  readonly openedAt: number
  node: string | null
  channel: ServerTransportChannel | null
  authed: boolean
  credential: AuthenticatedCredential | null
}

/** One exact authenticated credential to terminate. */
export interface PeerCredentialTarget extends AuthenticatedCredential {
  readonly node: string
}

export interface TransportServerOptions {
  /** Pre-shared key. Injected — never a literal (see `handshake.ts`). */
  readonly psk: string
  /**
   * This node's Ed25519 identity, its peer directory, and its own node
   * segment — everything needed to check a signed auth frame and to sign the
   * ready frame back (key-distribution.md §7.1 / §7.1.1).
   *
   * Omitted ⇒ this listener behaves exactly as it did before signatures
   * existed: it checks the MAC and reads no `sig`. That is the honest default
   * for §8.2 phase ①, and it is what lets a node that has been given keys and
   * one that has not still talk to each other.
   */
  readonly signing?: ListenerIdentity
  /**
   * `notAfter` of the certificate this listener presents, epoch ms (§6.3).
   *
   * A TLS session is fixed at handshake time, so an expired — or revoked —
   * certificate would otherwise keep serving every connection made before it
   * lapsed, for as long as that connection happens to live. Given this, the
   * listener closes those connections itself at the instant it lapses, with
   * {@link CLOSE_UNAUTHORIZED}, and refuses new ones. It does **not** exit:
   * §6.3's last rule is that "the operator forgot to re-issue" must not be
   * amplified into "the service is gone", and a process that is still up is
   * still answering `--help`, still holding its socket path, and still one
   * `systemctl restart` away from healthy.
   */
  readonly certificateNotAfter?: number
  readonly onMessage: InboundHandler
  /**
   * Message types this endpoint implements, declared to every dialer in the
   * ready frame. Omit to declare nothing, which a dialer reads as the legacy
   * floor.
   *
   * Supplied by the host for the same reason the client's is: this package
   * moves envelopes and never reads their `type`, so it has no way to know
   * which ones the node above it actually handles.
   */
  readonly supportedTypes?: readonly string[]
  readonly onPeerDisconnect?: (
    peerNode: string,
    remainingPeerConnections: number,
  ) => void
  /** Listen on a unix socket. Mutually exclusive with `port`. */
  readonly unix?: string
  /** Listen on TCP. `0` lets the OS choose. */
  readonly port?: number
  readonly hostname?: string
  /** TLS materials, passed straight to Bun. Meaningless with `unix`. */
  readonly tls?: TLSOptions
  /** Injected wall clock for events, dedup and receipt metadata. */
  readonly now?: () => number
  /** Rule T-2 clock used only for envelope deadline validation. */
  readonly deadlineNow?: (createdAt: number) => number
  /** Extra sink for records, on top of the retained ring. */
  readonly events?: TransportEventSink
  /** Share one table across servers, or inject a clock into it. */
  readonly dedup?: DedupTable
  /** Cap on unreceipted server-originated envelopes per logical channel. */
  readonly maxQueued?: number
  /** Cap on logical channels retained for reconnect and pending replies. */
  readonly maxChannels?: number
  /**
   * Seconds of silence before Bun reaps a connection. Bun's own default is
   * 10 s, which a long-lived node link would trip constantly; clients send a
   * keep-alive data frame well inside this window.
   */
  readonly idleTimeoutSec?: number
  /**
   * How long a disconnected logical channel is kept alive for its peer to come
   * back to, when it still holds unreceipted envelopes. `0` reclaims at once.
   */
  readonly channelRetentionMs?: number
  readonly eventCapacity?: number
}

export interface TransportServerHandle {
  /** Unix socket path, when listening on one. */
  readonly unix?: string
  /** Bound TCP port, when listening on one. */
  readonly port?: number
  /** Dial URL for a client, when listening on TCP. */
  readonly url?: string
  readonly events: EventRecorder
  readonly dedup: DedupTable
  /** Open physical connections, authenticated or not. */
  readonly connections: number
  /** Logical channels retained across reconnects. */
  readonly channels: number
  /**
   * Refuse every physical connection and retained logical channel belonging to
   * peers that no longer pass the caller's directory check.
   *
   * The method is deliberately keyed by the authenticated handshake identity,
   * never a caller-supplied endpoint or channel id. It is idempotent, so a
   * repeated RL entry and a racing socket close cannot leave a channel behind.
   */
  closePeers(peerNodes: Iterable<string>): void
  /** Close only links authenticated by these exact opaque credentials. */
  closePeerCredentials(credentials: Iterable<PeerCredentialTarget>): void
  stop(): Promise<void>
}

/** Seconds. Comfortably above the client's keep-alive period. */
export const DEFAULT_IDLE_TIMEOUT_SEC = 120

/** Hard cap on reconnectable logical channels retained by one server. */
export const DEFAULT_MAX_CHANNELS = 1_000

/**
 * How long a socket-less channel with unreceipted envelopes is retained.
 *
 * Without a ceiling, such a channel is retained *forever*: it survives
 * {@link ServerTransportChannel.unbind} because its outbox is not empty, and
 * the only thing that would empty it is a receipt from the peer that just went
 * away. A server that answers refused requests on the inbound channel (the
 * activator does) would then accumulate one dead channel per refusal until
 * {@link DEFAULT_MAX_CHANNELS} is reached, after which **every** new handshake
 * is closed with `CLOSE_CAPACITY` — a self-inflicted outage with no recovery
 * short of a restart.
 *
 * Five minutes matches the protocol's default task deadline: past it, nothing
 * that could still be waiting on those envelopes is alive to care.
 */
export const DEFAULT_CHANNEL_RETENTION_MS = 300_000

/** How long {@link TransportServerHandle.stop} waits on Bun before moving on. */
const STOP_GRACE_MS = 200
const CLOSE_REPLACED = 4000
const CLOSE_CAPACITY = 1013

/** Largest delay `setTimeout` honours; anything past it fires immediately. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Largest frame the socket will buffer: the protocol's own envelope ceiling
 * plus room for the frame wrapper.
 *
 * Refusing at the socket layer matters because `JSON.parse` happens before any
 * validation can: without this, a peer could make the receiver allocate for a
 * payload that `validateMessage` was always going to refuse. Bun's default is
 * 16 MB, which is 64× more generosity than this protocol has any use for.
 */
const MAX_FRAME_BYTES = LIMITS.maxMessageBytes + 4096

class ServerTransportChannel implements TransportChannel {
  readonly id: string
  readonly peerNode: string
  readonly #outbox: EnvelopeOutbox
  readonly #remove: (channel: ServerTransportChannel) => void
  readonly #record: (type: TransportEventType, detail: EventDetail) => void
  readonly #retentionMs: number
  #socket: ServerWebSocket<ConnectionState> | null = null
  #holds = 0
  #closed = false
  #reclaim: ReturnType<typeof setTimeout> | null = null
  #peerTypes: readonly string[] | undefined
  readonly #authentication: HandshakeAuthentication
  readonly #credential: AuthenticatedCredential | null
  readonly #signingPublicKey: string | null

  constructor(options: {
    readonly id: string
    readonly peerNode: string
    readonly maxQueued: number
    readonly retentionMs: number
    readonly remove: (channel: ServerTransportChannel) => void
    readonly record: (type: TransportEventType, detail: EventDetail) => void
    readonly authentication: HandshakeAuthentication
    readonly credential: AuthenticatedCredential | undefined
    readonly signingPublicKey: string | undefined
  }) {
    this.id = options.id
    this.peerNode = options.peerNode
    this.#retentionMs = options.retentionMs
    this.#remove = options.remove
    this.#record = options.record
    this.#authentication = options.authentication
    this.#credential = options.credential ?? null
    this.#signingPublicKey = options.signingPublicKey ?? null
    this.#outbox = new EnvelopeOutbox({
      maxQueued: options.maxQueued,
      canWrite: () => this.isReady(),
      isClosed: () => this.#closed,
      write: message => {
        const socket = this.#socket
        if (socket === null) return
        socket.send(
          serializeFrame({
            t: FrameType.Envelope,
            v: FRAME_VERSION,
            envelope: message,
          }),
        )
      },
      onReceipt: (frame, known) => this.#recordReceipt(frame, known),
    })
  }

  get pending(): number {
    return this.#outbox.pending
  }

  /** What the dialer declared on the auth frame of the current connection. */
  get peerSupportedTypes(): readonly string[] | undefined {
    return this.#peerTypes
  }

  get peerCredential(): AuthenticatedCredential | null {
    return this.#credential
  }

  matchesAuthentication(options: {
    readonly peerNode: string
    readonly authentication: HandshakeAuthentication
    readonly credential: AuthenticatedCredential | undefined
    readonly signingPublicKey: string | undefined
  }): boolean {
    const credential = options.credential ?? null
    return (
      this.peerNode === options.peerNode &&
      this.#authentication === options.authentication &&
      this.#signingPublicKey === (options.signingPublicKey ?? null) &&
      ((this.#credential === null && credential === null) ||
        (this.#credential !== null &&
          credential !== null &&
          this.#credential.source === credential.source &&
          this.#credential.id === credential.id))
    )
  }

  supports(type: MessageType): boolean {
    return peerSupportsType(this.#peerTypes, type)
  }

  isReady(): boolean {
    return this.#socket !== null && !this.#closed
  }

  isClosed(): boolean {
    return this.#closed
  }

  send(message: QianmoMessage): void {
    this.#outbox.send(message)
  }

  sendAndWait(
    message: QianmoMessage,
    timeoutMs = 5_000,
  ): Promise<SuccessfulReceiptStatus> {
    return this.#outbox.sendAndWait(message, timeoutMs)
  }

  waitForDrain(timeoutMs = 5_000): Promise<void> {
    return this.#outbox.waitForDrain(timeoutMs)
  }

  hold(): () => void {
    if (this.#closed) throw new Error('transport channel is closed')
    this.#holds += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#holds -= 1
      this.#removeIfIdle()
    }
  }

  bind(
    socket: ServerWebSocket<ConnectionState>,
    supportedTypes?: readonly string[],
  ): void {
    if (this.#closed) throw new Error('transport channel is closed')
    // Replaced, not merged: the declaration belongs to the handshake that just
    // happened. A peer that reconnected on an older build declares less, and
    // carrying the old union forward would keep sending it types it dropped.
    this.#peerTypes = supportedTypes
    const previous = this.#socket
    this.#socket = socket
    if (previous !== null && previous !== socket) {
      previous.close(CLOSE_REPLACED, 'logical channel reconnected')
    }
  }

  ready(): void {
    this.#outbox.replay()
  }

  unbind(socket: ServerWebSocket<ConnectionState>): void {
    if (this.#socket === socket) this.#socket = null
    this.#removeIfIdle()
  }

  receive(frame: ReceiptFrame): void {
    this.#outbox.receive(frame)
    this.#removeIfIdle()
  }

  close(closeCode = 1000, reason = 'transport server shutdown'): void {
    if (this.#closed) return
    this.#closed = true
    this.#cancelReclaim()
    const socket = this.#socket
    this.#socket = null
    socket?.close(closeCode, reason)
    this.#outbox.close(new Error('transport server closed before receipt'))
  }

  #recordReceipt(frame: ReceiptFrame, known: boolean): void {
    if (frame.status === ReceiptStatus.Rejected) {
      this.#record(TransportEventType.MessageRejected, {
        node: this.peerNode,
        msgId: frame.msgId,
        code: frame.code ?? '',
        reason: frame.reason ?? '',
      })
      return
    }
    if (!known) return
    this.#record(
      frame.status === ReceiptStatus.Duplicate
        ? TransportEventType.MessageDuplicate
        : TransportEventType.MessageAccepted,
      { node: this.peerNode, msgId: frame.msgId },
    )
  }

  #removeIfIdle(): void {
    if (this.#socket !== null || this.#holds > 0) {
      this.#cancelReclaim()
      return
    }
    if (this.#outbox.pending > 0) {
      this.#armReclaim()
      return
    }
    this.#cancelReclaim()
    this.#closed = true
    this.#remove(this)
  }

  /**
   * Put a socket-less channel on the clock.
   *
   * The envelopes it still holds are not dropped here — a peer that comes back
   * inside the window rebinds and gets them replayed. What the clock prevents
   * is the other case: a peer that never comes back, whose channel would
   * otherwise sit in the table forever with no event left that could retire it.
   */
  #armReclaim(): void {
    if (this.#reclaim !== null || this.#closed) return
    this.#reclaim = setTimeout(() => {
      this.#reclaim = null
      if (this.#socket !== null || this.#holds > 0 || this.#closed) return
      this.#record(TransportEventType.ChannelReclaimed, {
        node: this.peerNode,
        channelId: this.id,
        pending: this.#outbox.pending,
      })
      this.close()
      this.#remove(this)
    }, this.#retentionMs)
    this.#reclaim.unref?.()
  }

  #cancelReclaim(): void {
    if (this.#reclaim === null) return
    clearTimeout(this.#reclaim)
    this.#reclaim = null
  }
}

export function startTransportServer(
  options: TransportServerOptions,
): TransportServerHandle {
  assertUsablePsk(options.psk)
  if (options.unix !== undefined && options.port !== undefined) {
    throw new Error('transport server takes either `unix` or `port`, not both')
  }

  const now = options.now ?? (() => Date.now())
  const deadlineNow = options.deadlineNow ?? (() => now())
  const recorder = new EventRecorder(options.eventCapacity, options.events)
  const dedup = options.dedup ?? new DedupTable({ now })
  const sockets = new Set<ServerWebSocket<ConnectionState>>()
  const channels = new Map<string, ServerTransportChannel>()
  const peerConnections = new Map<string, number>()
  const maxChannels = options.maxChannels ?? DEFAULT_MAX_CHANNELS
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED
  const channelRetentionMs =
    options.channelRetentionMs ?? DEFAULT_CHANNEL_RETENTION_MS
  let certificateExpired = false
  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  function record(type: TransportEventType, detail: EventDetail): void {
    recorder.record({ type, at: now(), detail })
  }

  function send(ws: ServerWebSocket<ConnectionState>, frame: TransportFrame) {
    ws.send(serializeFrame(frame))
  }

  function removeChannel(channel: ServerTransportChannel): void {
    if (channels.get(channel.id) === channel) channels.delete(channel.id)
  }

  function createChannel(
    id: string,
    peerNode: string,
    authentication: HandshakeAuthentication,
    credential?: AuthenticatedCredential,
    signingPublicKey?: string,
  ): ServerTransportChannel | null {
    if (channels.size >= maxChannels) return null
    const channel = new ServerTransportChannel({
      id,
      peerNode,
      maxQueued,
      retentionMs: channelRetentionMs,
      remove: removeChannel,
      record,
      authentication,
      credential,
      signingPublicKey,
    })
    channels.set(id, channel)
    return channel
  }

  /**
   * Cut all state that was admitted as one of `peerNodes`.
   *
   * A channel can outlive its socket while it carries unreceipted replies, so
   * closing only the current socket would retain an authenticated route to a
   * revoked peer. Conversely, a reconnect race can leave an old socket in
   * Bun's close queue after its channel was rebound, so both collections are
   * independently swept. Every close uses 4003: clients already treat it as a
   * permanent authorization refusal and therefore do not spin on a revoked
   * credential.
   */
  function closePeers(peerNodes: Iterable<string>): void {
    const revoked = new Set(peerNodes)
    if (revoked.size === 0) return

    for (const channel of [...channels.values()]) {
      if (!revoked.has(channel.peerNode)) continue
      channel.close(CLOSE_UNAUTHORIZED, 'peer authorization revoked')
      removeChannel(channel)
    }
    for (const socket of [...sockets]) {
      const peerNode = socket.data.node
      if (!socket.data.authed || peerNode === null || !revoked.has(peerNode))
        continue
      socket.close(CLOSE_UNAUTHORIZED, 'peer authorization revoked')
    }
  }

  function closePeerCredentials(
    credentials: Iterable<PeerCredentialTarget>,
  ): void {
    const revoked = new Set(
      [...credentials].map(target =>
        JSON.stringify([target.node, target.source, target.id]),
      ),
    )
    if (revoked.size === 0) return
    const matches = (
      node: string,
      credential: AuthenticatedCredential | null,
    ): boolean =>
      credential !== null &&
      revoked.has(JSON.stringify([node, credential.source, credential.id]))

    for (const channel of [...channels.values()]) {
      if (!matches(channel.peerNode, channel.peerCredential)) continue
      channel.close(CLOSE_UNAUTHORIZED, 'peer credential revoked')
      removeChannel(channel)
    }
    for (const socket of [...sockets]) {
      const peerNode = socket.data.node
      if (
        !socket.data.authed ||
        peerNode === null ||
        !matches(peerNode, socket.data.credential)
      )
        continue
      socket.close(CLOSE_UNAUTHORIZED, 'peer credential revoked')
    }
  }

  /**
   * Drop a connection that broke the grammar.
   *
   * Before the handshake this is an auth rejection — the record an operator
   * greps for after a failed deployment. After it, the peer is authenticated
   * and merely wrong, which is a different fact and gets a different record.
   */
  function refuse(
    ws: ServerWebSocket<ConnectionState>,
    rejection: HandshakeRejection,
    closeCode: number,
  ): void {
    record(
      ws.data.authed
        ? TransportEventType.ConnectionClosed
        : TransportEventType.AuthRejected,
      { rejection, node: ws.data.node ?? '', closeCode },
    )
    ws.close(closeCode, ws.data.authed ? 'protocol error' : 'unauthorized')
  }

  /**
   * The certificate this listener presents has lapsed (§6.3, rule 2).
   *
   * Everything built on it goes at once — waiting for each peer to notice is
   * how a revoked certificate keeps serving for as long as a connection
   * happens to live. New dials still get a challenge and are refused at their
   * auth frame (see the `message` handler for why not sooner); the process
   * stays up (§6.3, rule 5), so re-issuing and restarting is the whole
   * recovery.
   */
  function expireCertificate(): void {
    if (certificateExpired) return
    certificateExpired = true
    record(TransportEventType.AuthRejected, {
      rejection: 'certificate_expired',
      closeCode: CLOSE_UNAUTHORIZED,
      connections: sockets.size,
    })
    for (const socket of [...sockets]) {
      socket.close(CLOSE_UNAUTHORIZED, 'certificate expired')
    }
  }

  /**
   * Arm the expiry clock, in hops no longer than a 32-bit timer.
   *
   * A node certificate lives 90 days (§6.2) = 7.8e9 ms, which is 3.6× past the
   * `setTimeout` ceiling — and the failure mode of overshooting it is not a
   * late timer but an **immediate** one, so a naive single `setTimeout` would
   * close every connection the instant the node started. Re-arming against the
   * wall clock also means a machine that slept through the expiry acts on
   * waking rather than sleeping through its own deadline.
   */
  function armCertificateExpiry(notAfter: number): void {
    const remaining = notAfter - now()
    if (remaining <= 0) {
      expireCertificate()
      return
    }
    expiryTimer = setTimeout(
      () => armCertificateExpiry(notAfter),
      Math.min(remaining, MAX_TIMER_MS),
    )
    expiryTimer.unref?.()
  }

  const websocket: WebSocketHandler<ConnectionState> = {
    idleTimeout: options.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC,
    maxPayloadLength: MAX_FRAME_BYTES,
    open(ws) {
      sockets.add(ws)
      record(TransportEventType.ConnectionOpened, {})
      send(ws, {
        t: FrameType.Challenge,
        v: FRAME_VERSION,
        nonce: ws.data.nonce,
      })
    },
    close(ws, code) {
      sockets.delete(ws)
      ws.data.channel?.unbind(ws)
      record(TransportEventType.ConnectionClosed, {
        node: ws.data.node ?? '',
        code,
        durationMs: now() - ws.data.openedAt,
      })
      if (ws.data.authed && ws.data.node !== null) {
        const peerNode = ws.data.node
        const remaining = Math.max(0, (peerConnections.get(peerNode) ?? 1) - 1)
        if (remaining === 0) peerConnections.delete(peerNode)
        else peerConnections.set(peerNode, remaining)
        options.onPeerDisconnect?.(peerNode, remaining)
      }
    },
    async message(ws, raw) {
      const frame = parseFrame(typeof raw === 'string' ? raw : raw.toString())
      if (frame === null) {
        refuse(ws, HandshakeRejection.MalformedFrame, CLOSE_PROTOCOL_ERROR)
        return
      }

      if (!ws.data.authed) {
        if (frame.t !== FrameType.Auth) {
          refuse(ws, HandshakeRejection.UnexpectedFrame, CLOSE_UNAUTHORIZED)
          return
        }
        if (certificateExpired) {
          // Refused here rather than in `open`, for one measured reason: a
          // socket closed inside the open handler delivers no close *code* to
          // the dialer (it sees an abnormal closure and retries until its
          // budget runs out), and 4003 is the entire point — it is what tells
          // a peer this door will not open and stops the reconnect storm.
          //
          // The dialer learns nothing else: same code, same reason string a
          // wrong key gets. The claimed name is recorded on our side only.
          record(TransportEventType.AuthRejected, {
            rejection: 'certificate_expired',
            node: frame.node,
            closeCode: CLOSE_UNAUTHORIZED,
          })
          ws.close(CLOSE_UNAUTHORIZED, 'unauthorized')
          return
        }
        const result = verifyAuthAttempt(
          options.psk,
          options.signing,
          ws.data.nonce,
          frame,
        )
        if (!result.ok) {
          // Record the claimed name so an operator can tell a misconfigured
          // peer from a scan. It is a claim, not an identity — the handshake
          // is precisely what failed.
          ws.data.node = frame.node
          refuse(ws, result.rejection, CLOSE_UNAUTHORIZED)
          return
        }
        const existing = channels.get(result.channelId)
        if (
          existing !== undefined &&
          !existing.matchesAuthentication({
            peerNode: result.node,
            authentication: result.authentication,
            credential: result.credential,
            signingPublicKey: result.signingPublicKey,
          })
        ) {
          // Not `refuse`, on both counts. The rejection is its own string
          // (`bad_channel` means a malformed field, which this is not), and it
          // carries two fields no other rejection does: the channel id — the
          // only thing an operator needs to find the conflicting channel — and
          // how many envelopes that channel is still holding, so "the old
          // outbox had N in it when its owner was locked out" is on the record
          // rather than inferred. The retained channel itself is left
          // untouched: handing it over is precisely what is being refused, and
          // *discarding* it would let any weaker identity that can pass L1 for
          // this node destroy a signed peer's undelivered replies on demand.
          ws.data.node = result.node
          record(TransportEventType.AuthRejected, {
            rejection: HandshakeRejection.ChannelIdentityMismatch,
            node: result.node,
            channelId: result.channelId,
            pending: existing.pending,
            closeCode: CLOSE_CHANNEL_CONFLICT,
          })
          ws.close(CLOSE_CHANNEL_CONFLICT, 'logical channel identity conflict')
          return
        }
        const channel =
          existing ??
          createChannel(
            result.channelId,
            result.node,
            result.authentication,
            result.credential,
            result.signingPublicKey,
          )
        if (channel === null) {
          record(TransportEventType.AuthRejected, {
            rejection: 'channel_capacity',
            node: result.node,
            closeCode: CLOSE_CAPACITY,
          })
          ws.close(CLOSE_CAPACITY, 'logical channel capacity reached')
          return
        }

        ws.data.authed = true
        ws.data.node = result.node
        ws.data.credential = result.credential ?? null
        ws.data.channel = channel
        channel.bind(ws, frame.supportedTypes)
        peerConnections.set(
          result.node,
          (peerConnections.get(result.node) ?? 0) + 1,
        )
        record(TransportEventType.AuthAccepted, {
          node: result.node,
          channelId: result.channelId,
          authentication: result.authentication,
          ...(result.credential === undefined
            ? {}
            : {
                credentialSource: result.credential.source,
                credentialId: result.credential.id,
              }),
        })
        send(ws, {
          t: FrameType.Ready,
          v: FRAME_VERSION,
          ...(options.supportedTypes === undefined
            ? {}
            : { supportedTypes: options.supportedTypes }),
          // Signed whenever this node *can* sign, not only when the dialer
          // did: the two directions are independent claims, and a dialer that
          // wants to check who it reached must not have to prove itself by
          // signature first to be allowed to.
          ...(options.signing === undefined
            ? {}
            : signReady(
                options.signing,
                ws.data.nonce,
                frame.clientNonce,
                result.node,
                result.channelId,
              )),
        })
        channel.ready()
        return
      }

      const channel = ws.data.channel
      if (channel === null) {
        refuse(ws, HandshakeRejection.UnexpectedFrame, CLOSE_PROTOCOL_ERROR)
        return
      }
      switch (frame.t) {
        case FrameType.KeepAlive:
          return
        case FrameType.Envelope: {
          const context: InboundContext = {
            peerNode: channel.peerNode,
            receivedAt: now(),
            channel,
          }
          const reply = await receiveEnvelope(frame.envelope, context, {
            onMessage: options.onMessage,
            dedup,
            recorder,
            now,
            deadlineNow,
          })
          send(ws, reply)
          return
        }
        case FrameType.Receipt:
          channel.receive(frame)
          return
        default:
          refuse(ws, HandshakeRejection.UnexpectedFrame, CLOSE_PROTOCOL_ERROR)
      }
    },
  }

  function upgrade(
    request: Request,
    server: Server<ConnectionState>,
  ): Response | undefined {
    const data: ConnectionState = {
      nonce: newNonce(),
      openedAt: now(),
      node: null,
      channel: null,
      authed: false,
      credential: null,
    }
    if (server.upgrade(request, { data })) return undefined
    return new Response('expected a websocket upgrade', { status: 426 })
  }

  const server: Server<ConnectionState> =
    options.unix === undefined
      ? Bun.serve<ConnectionState, never>({
          port: options.port ?? 0,
          hostname: options.hostname ?? '127.0.0.1',
          ...(options.tls === undefined ? {} : { tls: options.tls }),
          fetch: upgrade,
          websocket,
        })
      : Bun.serve<ConnectionState, never>({
          unix: options.unix,
          fetch: upgrade,
          websocket,
        })

  if (options.certificateNotAfter !== undefined) {
    armCertificateExpiry(options.certificateNotAfter)
  }

  const scheme = options.tls === undefined ? 'ws' : 'wss'
  return {
    ...(options.unix === undefined
      ? {
          port: server.port ?? 0,
          url: `${scheme}://${options.hostname ?? '127.0.0.1'}:${server.port ?? 0}`,
        }
      : { unix: options.unix }),
    events: recorder,
    dedup,
    get connections(): number {
      return sockets.size
    },
    get channels(): number {
      return channels.size
    },
    closePeers,
    closePeerCredentials,
    stop: async (): Promise<void> => {
      if (expiryTimer !== null) clearTimeout(expiryTimer)
      expiryTimer = null
      for (const channel of [...channels.values()]) channel.close()
      channels.clear()
      // Bounded, not a plain await, because of a measured Bun behaviour: once
      // this server has closed a WebSocket itself — which is exactly what
      // refusing a handshake does — `server.stop()` never resolves, on unix
      // sockets and TCP alike, with or without `force`. Measured on Bun
      // 1.3.13: closer=server hangs, closer=client resolves in 0 ms.
      //
      // The listener really is released regardless (a fresh server binds the
      // same path immediately afterwards and serves), so the only thing lost
      // is the promise. Waiting on it forever would mean a node that ever
      // rejected one dial could never shut down.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        server.stop(true),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, STOP_GRACE_MS)
          timer.unref?.()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      // Stopping does not remove the socket file; leaving it behind is how a
      // restarted node fails to take its own address back. The base unlinks
      // its own socket for the same reason
      // (`src/ssh/SSHAuthProxy.ts:128-135`).
      if (options.unix !== undefined) {
        try {
          unlinkSync(options.unix)
        } catch {
          // Already gone, or never ours to remove.
        }
      }
    },
  }
}
