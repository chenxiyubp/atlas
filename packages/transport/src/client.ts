// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

// `ws` is declared once, at the workspace root (`package.json:77`), and not
// re-declared here: knip's zero-tolerance "unused dependencies" gate reports a
// second declaration of a root dependency as dead weight. This package is
// private and never published, so the root declaration is the whole contract.
import WebSocket from 'ws'
import {
  TimeJumpGate,
  isValidSegment,
  peerSupportsType,
  type MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { signBytes } from '@qianmo/capability'
import {
  DEFAULT_BACKOFF,
  ReconnectSchedule,
  type BackoffOptions,
  type RandomSource,
} from './backoff.js'
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
  ReadyRejection,
  assertUsablePsk,
  authCredentialProofInput,
  authSigningInput,
  computeMac,
  isChannelId,
  newChannelId,
  newNonce,
  verifyReady,
  type HandshakeAuthentication,
  type AuthenticatedCredential,
  type HandshakeIdentity,
  type HandshakeTuple,
} from './handshake.js'
import {
  DEFAULT_MAX_QUEUED,
  EnvelopeOutbox,
  type SuccessfulReceiptStatus,
} from './outbox.js'
import { receiveEnvelope } from './receiver.js'

/**
 * The dialling half of a Qianmo hop.
 *
 * At-least-once lives here, and it is one rule: **an envelope leaves the
 * outbox only when a receipt for it comes back.** Everything else follows —
 * a message handed over while the link is down waits in the outbox; a
 * reconnect replays whatever is still in it, in order; the receiver's dedup
 * (`dedup.ts`) absorbs whatever that replay duplicates. There is deliberately
 * no "sent, probably fine" state in between.
 *
 * This is where it parts company with the base's client, which retires its
 * buffer against an `X-Last-Request-Id` header supplied by the upstream
 * service (`src/cli/transports/WebSocketTransport.ts:582-642`). That contract
 * belongs to that service; ours is the receipt frame, and ours has to survive
 * the peer restarting with no memory of the connection.
 *
 * **Not done here, on purpose**: the outbox does not expire its own entries at
 * the delivery deadline. protocol.md §8.2 row 7 (`queued → expired`) is a
 * state-machine transition that has to emit `error(E_TTL_EXPIRED)` back to
 * whoever asked for the send, and that state machine belongs to the router
 * (P4.2), not to a transport that would have to invent the reporting channel
 * to do it. A long outage therefore replays envelopes that are already past
 * their deadline; the receiving node refuses them by rule T-1's second check.
 */

/** Where to dial. A unix socket for one machine, a URL for two. */
export type TransportEndpoint =
  | { readonly url: string }
  | { readonly unix: string; readonly path?: string }

/** TLS materials for a `wss://` dial, passed through to the socket. */
export interface ClientTlsOptions {
  readonly ca?: string | readonly string[]
  readonly cert?: string
  readonly key?: string
  /** Leave unset (i.e. verifying) outside of a lab. */
  readonly rejectUnauthorized?: boolean
}

/**
 * TLS materials, or a way to go and get them again
 * (key-distribution.md §6.3 rule 4).
 *
 * A node certificate lasts 90 days and a reconnect loop can outlive one
 * rotation twice over. §6.3 spells out the failure: a live TLS session is
 * fixed at handshake time and replacing the file on disk does not touch it,
 * which is fine — but a *client object* holding the PEM string it was
 * constructed with will keep re-presenting the expired certificate on every
 * reconnect "to death", long after the operator swapped the file and
 * concluded the rotation was done.
 *
 * So the materials may be a function, and it is called **once per dial** —
 * including every reconnect. A fixed object is still accepted and still
 * correct for the case it fits (a CA root, a lab, a test); what a function
 * buys is that "the file changed" and "the next dial uses it" are the same
 * event, with no restart and no cache to invalidate.
 *
 * The function must not throw for a transient read failure — see
 * {@link TransportClientOptions.tls} for what happens if it does.
 */
export type ClientTlsSource = ClientTlsOptions | (() => ClientTlsOptions)

/** Resolve a {@link ClientTlsSource}. Called once per dial, never cached. */
function resolveTls(source: ClientTlsSource): ClientTlsOptions {
  return typeof source === 'function' ? source() : source
}

export interface TransportClientOptions {
  readonly endpoint: TransportEndpoint
  /** This node's segment, e.g. `node-a`. Sent in the handshake. */
  readonly node: string
  /**
   * Message types this endpoint implements, declared to the peer in the auth
   * frame. Omit to declare nothing, which the peer reads as the legacy floor.
   *
   * The transport cannot work this out for itself — it moves envelopes and
   * never inspects their `type` — so the host supplies it. Omitting it is the
   * safe default and the honest one: a host that has not wired up handling for
   * a post-floor type must not advertise it.
   */
  readonly supportedTypes?: readonly string[]
  /**
   * The node this client set out to reach.
   *
   * Two jobs, and the second one arrived with {@link TransportClientOptions.signing}:
   * it labels inbound audit context, and — when signing is on — it is *the*
   * name the listener's ready signature is checked under. That second use is
   * why it stops being "not an authority" the moment a key is involved: the
   * whole of §11 T-B′'s second defence is looking the key up under the node
   * the dialer *meant* to reach rather than the one the endpoint answered
   * with, so a tampered `AgentRecord.endpoint` fails instead of redirecting.
   *
   * Required alongside `signing`, for that reason.
   */
  readonly peerNode?: string
  /**
   * Stable across reconnects of this client. Generated when omitted.
   *
   * Supplying one also **pins** it: a generated id may be rotated when the
   * listener answers {@link CLOSE_CHANNEL_CONFLICT}, a supplied one may not,
   * because the only reason to name a channel from outside is to reattach to
   * that particular channel and a silent move elsewhere would answer a
   * different question than the one asked. Such a client goes terminal on the
   * conflict instead. Nothing in the tree supplies one today.
   */
  readonly channelId?: string
  /** Pre-shared key. Injected — never a literal (see `handshake.ts`). */
  readonly psk: string
  /**
   * This node's Ed25519 identity and its peer directory (§7.1 / §7.1.1).
   *
   * Given it, this client signs its auth frame *in addition to* the MAC — both
   * proofs travel, and the listener takes whichever it is equipped to check.
   * Sending both is what makes one end of a link upgradeable without the
   * other: `sig` costs a listener that never heard of it exactly nothing,
   * since `parseFrame` hands back a frame it can already answer.
   *
   * It also makes this client *check* the listener's half. Requires
   * {@link TransportClientOptions.peerNode} — there is nothing to check a
   * signature against without knowing which node was meant.
   */
  readonly signing?: HandshakeIdentity
  /**
   * TLS materials, or a factory re-read on every dial (§6.3 rule 4).
   *
   * A factory that throws is treated as "this dial cannot be made", not as a
   * fatal error: the throw is recorded as a connection failure and the
   * reconnect schedule takes over, so a certificate file that is momentarily
   * absent mid-rotation costs one backoff step rather than the link. It is
   * *not* silently downgraded to a plaintext dial — a client that quietly
   * stopped presenting a certificate would look connected while having lost
   * the whole of L0.
   */
  readonly tls?: ClientTlsSource
  readonly backoff?: Partial<BackoffOptions>
  /** Cap on unreceipted envelopes before {@link TransportClient.send} refuses. */
  readonly maxQueued?: number
  /** Handle envelopes sent back by the authenticated server channel. */
  readonly onMessage?: InboundHandler
  /**
   * Called every time the link becomes ready, reconnects included.
   *
   * The outbox replay covers envelopes that never got a receipt; it cannot
   * cover state the peer inferred from an envelope it already receipted. A
   * caller whose last message asserted something ("I am busy") needs this hook
   * to say it again after the peer forgot.
   */
  readonly onReady?: () => void
  readonly dedup?: DedupTable
  /** Keep-alive period, ms. `0` disables it. */
  readonly keepAliveIntervalMs?: number
  readonly now?: () => number
  readonly deadlineNow?: (createdAt: number) => number
  readonly random?: RandomSource
  readonly events?: TransportEventSink
  readonly eventCapacity?: number
}

/** Default keep-alive period: well inside the server's idle timeout. */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000

/** How long {@link TransportClient.connect} waits before reporting failure. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

/**
 * How many times a client will move to a fresh channel id after a
 * {@link CLOSE_CHANNEL_CONFLICT}, before treating the conflict as fatal.
 *
 * Three, because one is the case this exists for — a credential rotated, or
 * the listener's directory changed underneath a channel that was still
 * retained — and that case is resolved by the *first* rotation: the new id
 * cannot collide with a channel that does not exist yet. A second and third
 * cover a genuine race (two rotations in flight, a listener replaying an old
 * directory during a refresh); a fourth would mean the listener is rejecting
 * every id this client can produce, which is not a collision any more but a
 * listener saying no. Unbounded rotation there is a reconnect storm dressed up
 * as recovery, and it also silently abandons one retained channel per attempt.
 *
 * Counted per outage, not per lifetime: a successful handshake clears it, the
 * way a successful connection clears the reconnect budget. What this bounds is
 * a *run* of conflicts with nothing admitted between them — the listener
 * refusing every id this client can produce — and a run stays three long,
 * because two rotations can only be separated by a handshake that got through,
 * which is itself the evidence that the conflict it moved away from is over.
 * A lifetime budget would instead retire a healthy long-lived node on its
 * fourth `--trust` edit: the trigger this exists for is the listener's
 * directory changing under a retained channel (see `CLOSE_CHANNEL_CONFLICT`),
 * and that is an operational event that recurs for as long as the node runs.
 */
export const MAX_CHANNEL_ROTATIONS = 3

type ClientState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed'

/** Build the dial URL. `ws+unix://<socket>:<path>` is the `ws` package's form. */
export function dialUrl(endpoint: TransportEndpoint): string {
  if ('unix' in endpoint) {
    return `ws+unix://${endpoint.unix}:${endpoint.path ?? '/'}`
  }
  return endpoint.url
}

export class TransportClient implements TransportChannel {
  private socket: WebSocket | null = null
  private state: ClientState = 'idle'
  private readonly schedule: ReconnectSchedule
  private readonly recorder: EventRecorder
  private readonly now: () => number
  private readonly deadlineNow: (createdAt: number) => number
  private readonly keepAliveIntervalMs: number
  private readonly keepAliveGate: TimeJumpGate | null
  private readonly inboundDedup: DedupTable
  private readonly outbox: EnvelopeOutbox
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private lastInboundAt = 0
  private readyWaiters: Array<() => void> = []
  private declaredPeerTypes: readonly string[] | undefined
  /** Proof that admitted the current socket; `null` while disconnected. */
  private peerAuthentication: HandshakeAuthentication | null = null
  /** Credential metadata proven by the peer's signed ready frame. */
  private peerCredential: AuthenticatedCredential | null = null
  /**
   * The tuple this client signed on the current socket, kept until the ready
   * frame arrives so the listener's counter-signature can be checked against
   * the same nonces. Per socket, and dropped with it — a nonce pair reused
   * across sockets would be exactly the replay the challenge exists to stop.
   */
  private pendingHandshake: {
    readonly socket: WebSocket
    readonly tuple: HandshakeTuple
  } | null = null
  /**
   * Backing store for {@link id}, mutable for exactly one reason — see
   * {@link CLOSE_CHANNEL_CONFLICT} and `rotateChannelId`.
   */
  private channelId: string
  /**
   * The caller named this channel; this client may not rename it.
   *
   * No production caller does (checked across the tree: nothing outside this
   * package's own tests passes `channelId` to `TransportClient`), so this flag
   * is guarding an affordance rather than a live path. It is still the right
   * default for the affordance: `channelId` is documented as "stable across
   * reconnects of this client", and the only reason to name one from outside
   * is to *reattach to that specific logical channel* — a client that quietly
   * moved to a different id would return a healthy-looking link to a caller
   * whose whole request was the id. Silently generated ids carry no such
   * promise to anyone, so they may be rotated.
   */
  private readonly channelIdIsCallerSupplied: boolean
  /** Rotations spent on {@link CLOSE_CHANNEL_CONFLICT}; bounded. */
  private channelRotations = 0

  /** Stable across reconnects; see {@link channelIdIsCallerSupplied}. */
  get id(): string {
    return this.channelId
  }

  readonly peerNode: string | null

  constructor(private readonly options: TransportClientOptions) {
    assertUsablePsk(options.psk)
    if (!isValidSegment(options.node)) {
      throw new Error(`invalid node segment: ${options.node}`)
    }
    if (options.peerNode !== undefined && !isValidSegment(options.peerNode)) {
      throw new Error(`invalid peer node segment: ${options.peerNode}`)
    }
    if (options.signing !== undefined && options.peerNode === undefined) {
      // Refused at construction rather than skipped at handshake time: a
      // client that signed its own half and silently accepted anybody's
      // answer would look like it had the §7.1.1 guarantee while having only
      // half of it, and the missing half is the half that stops a redirect.
      throw new Error('signing requires peerNode: there is nothing to verify')
    }
    this.channelIdIsCallerSupplied = options.channelId !== undefined
    this.channelId = options.channelId ?? newChannelId()
    if (!isChannelId(this.id)) throw new Error(`invalid channel id: ${this.id}`)
    this.peerNode = options.peerNode ?? null
    this.now = options.now ?? (() => Date.now())
    this.deadlineNow = options.deadlineNow ?? (() => this.now())
    this.keepAliveIntervalMs =
      options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
    const backoff = { ...DEFAULT_BACKOFF, ...options.backoff }
    this.keepAliveGate =
      this.keepAliveIntervalMs > 0
        ? new TimeJumpGate({ periodMs: this.keepAliveIntervalMs })
        : null
    this.schedule = new ReconnectSchedule(backoff, options.random)
    this.recorder = new EventRecorder(options.eventCapacity, options.events)
    this.inboundDedup = options.dedup ?? new DedupTable({ now: this.now })
    this.outbox = new EnvelopeOutbox({
      maxQueued: options.maxQueued ?? DEFAULT_MAX_QUEUED,
      canWrite: () => this.state === 'ready' && this.socket !== null,
      isClosed: () => this.state === 'closed',
      write: message => this.writeEnvelope(message),
      onReceipt: (frame, known) => this.recordReceipt(frame, known),
    })
  }

  /** Records this client kept. */
  get events(): EventRecorder {
    return this.recorder
  }

  /** Envelopes handed over but not yet receipted. */
  get pending(): number {
    return this.outbox.pending
  }

  /** What the server declared on the current connection's ready frame. */
  get peerSupportedTypes(): readonly string[] | undefined {
    return this.declaredPeerTypes
  }

  /** The authentication actually adopted by the current connection. */
  get authenticatedBy(): HandshakeAuthentication | null {
    return this.peerAuthentication
  }

  /** Effective credential metadata adopted locally for the current peer. */
  get authenticatedCredential(): AuthenticatedCredential | null {
    return this.peerCredential
  }

  supports(type: MessageType): boolean {
    return peerSupportsType(this.declaredPeerTypes, type)
  }

  /** True once the handshake has completed on the current socket. */
  isReady(): boolean {
    return this.state === 'ready'
  }

  /**
   * True once this client will never carry another envelope.
   *
   * Four ways in: `close()`, a 4003 (the key is wrong), the reconnect budget
   * running out, and a 4004 this client cannot move out of the way of — its
   * {@link MAX_CHANNEL_ROTATIONS} spent on one unbroken run of conflicts, the
   * id pinned by the caller, or no reconnect left to carry a fresh one. All
   * four are terminal, and none of them is visible through {@link isReady},
   * which cannot tell "down for a moment" from "down for good". A holder of a
   * long-lived client needs that distinction — otherwise it keeps handing
   * envelopes to a corpse, and `send` throwing is the first it hears of it.
   * The activator's link pool reads this to decide when a link has to be
   * replaced rather than waited on.
   *
   * A **single** 4004 is not one of the four: that is the listener saying the
   * channel id is taken, which this client answers by taking a different one.
   */
  isClosed(): boolean {
    return this.state === 'closed'
  }

  hold(): () => void {
    return () => {}
  }

  /**
   * Dial, and resolve when the handshake completes.
   *
   * Rejection is reserved for "this will never work" — a refused key closes
   * the socket with 4003 and is reported here rather than retried, matching
   * how the base treats the same code
   * (`src/cli/transports/WebSocketTransport.ts:43-47`).
   */
  connect(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      // Bounded because retrying is unbounded by design: a peer that is merely
      // down keeps the backoff loop running for ten minutes, and a caller
      // awaiting `connect()` should not be held for ten minutes to learn that.
      // The loop keeps running after this rejects — a later `send` still
      // queues, and a peer that comes back is still picked up.
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter(w => w !== waiter)
        reject(
          new Error(`transport did not become ready within ${timeoutMs}ms`),
        )
      }, timeoutMs)
      const waiter = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.readyWaiters.push(waiter)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      // A dial already in flight (or a retry already scheduled) will settle
      // these waiters; opening a second socket would leave one orphaned.
      if (this.socket === null && this.reconnectTimer === null) {
        this.openSocket(fail)
      }
    })
  }

  /**
   * Hand an envelope to the transport.
   *
   * Returns as soon as it is in the outbox, whether or not the link is up:
   * "queued while disconnected" is the ordinary case this package exists to
   * survive, not an error. Delivery is reported by receipts, observable
   * through {@link waitForDrain}.
   */
  send(message: QianmoMessage): void {
    this.outbox.send(message)
  }

  sendAndWait(
    message: QianmoMessage,
    timeoutMs = 5_000,
  ): Promise<SuccessfulReceiptStatus> {
    return this.outbox.sendAndWait(message, timeoutMs)
  }

  /** Resolve once every queued envelope has been receipted. */
  waitForDrain(timeoutMs = 5_000): Promise<void> {
    return this.outbox.waitForDrain(timeoutMs)
  }

  /** Stop for good: no reconnect, no timers, socket closed. */
  async close(): Promise<void> {
    this.state = 'closed'
    this.clearTimers()
    this.peerAuthentication = null
    this.peerCredential = null
    const socket = this.socket
    this.socket = null
    this.pendingHandshake = null
    if (socket !== null) {
      socket.removeAllListeners()
      // Re-arm 'error' before touching the socket again. `removeAllListeners`
      // takes the error handler with it, and on an EventEmitter an 'error' with
      // no listener is rethrown — so tearing down a socket that is still
      // mid-handshake (exactly the case terminate() exists for) turns a routine
      // shutdown into an unhandled ErrorEvent that takes the process with it.
      socket.on('error', () => {})
      socket.close(1000, 'client shutdown')
      // A socket closed mid-handshake never fires 'close'; terminate() is the
      // only way to be sure the handle is gone when this promise resolves.
      socket.terminate()
    }
    this.readyWaiters = []
    this.outbox.close(new Error('transport client closed before receipt'))
    await Promise.resolve()
  }

  private record(type: TransportEventType, detail: EventDetail): void {
    this.recorder.record({ type, at: this.now(), detail })
  }

  private openSocket(onFatal?: (error: Error) => void): void {
    if (this.state === 'closed') return
    this.state = this.state === 'idle' ? 'connecting' : this.state
    const url = dialUrl(this.options.endpoint)
    // Resolved here rather than in the constructor: this line is what makes a
    // rotated certificate reach the wire on the next reconnect (§6.3 rule 4).
    let tls: Record<string, unknown> | undefined
    try {
      tls =
        this.options.tls === undefined
          ? undefined
          : toTlsOptions(resolveTls(this.options.tls))
    } catch (error) {
      // A file that is not there *right now* is a reason to try again in a
      // moment, not a reason to dial without it. `failDial` routes this
      // through the same backoff a refused connection takes.
      this.failDial(error, onFatal)
      return
    }
    const socket = new WebSocket(url, { ...(tls ?? {}) })
    this.socket = socket
    this.lastInboundAt = this.now()

    socket.on('message', (data: WebSocket.RawData) => {
      this.lastInboundAt = this.now()
      void this.onFrame(socket, data.toString())
    })
    socket.on('pong', () => {
      this.lastInboundAt = this.now()
    })
    socket.on('error', () => {
      // 'close' always follows; reconnect logic lives there so a failed dial
      // and a dropped link take exactly one path.
    })
    socket.on('close', (code: number) => {
      this.onClose(socket, code, onFatal)
    })
  }

  private async onFrame(socket: WebSocket, raw: string): Promise<void> {
    const frame = parseFrame(raw)
    if (frame === null) return
    switch (frame.t) {
      case FrameType.Challenge: {
        const clientNonce = newNonce()
        const tuple: HandshakeTuple = {
          serverNonce: frame.nonce,
          clientNonce,
          node: this.options.node,
          channelId: this.id,
        }
        this.pendingHandshake = { socket, tuple }
        const signing = this.options.signing
        this.write(socket, {
          t: FrameType.Auth,
          v: FRAME_VERSION,
          node: this.options.node,
          nonce: frame.nonce,
          clientNonce,
          channelId: this.id,
          mac: computeMac(
            this.options.psk,
            frame.nonce,
            clientNonce,
            this.options.node,
            this.id,
          ),
          // Outside the MAC by design — see `AuthFrame.supportedTypes`.
          ...(this.options.supportedTypes === undefined
            ? {}
            : { supportedTypes: this.options.supportedTypes }),
          // Both proofs travel together during §8.2's phases ① and ②. The
          // listener picks — and picking the legacy one is a real outcome
          // rather than a refusal: a `--trust`-only peer holds no view on
          // credentials and reads this frame as the plainly signed frame it
          // also is (`readsCredentialClaims` in `handshake.ts`). Which one it
          // took never comes back on the wire, so this side does not get to
          // assume; it sends both and lets the far end decide.
          ...(signing === undefined
            ? {}
            : {
                ...(signing.credential === undefined
                  ? {}
                  : {
                      credential: signing.credential.selector,
                      credentialProof: signBytes(
                        signing.keys,
                        authCredentialProofInput(
                          frame.nonce,
                          clientNonce,
                          this.options.node,
                          this.id,
                          signing.credential.selector,
                          signing.credential.source,
                          signing.credential.id,
                        ),
                      ),
                    }),
                sig: signBytes(
                  signing.keys,
                  authSigningInput(
                    frame.nonce,
                    clientNonce,
                    this.options.node,
                    this.id,
                  ),
                ),
              }),
        })
        return
      }
      case FrameType.Ready: {
        const accepted = this.acceptReady(socket, frame)
        if (accepted === null) return
        // Replaced, not merged: a peer that came back on an older build
        // declares less, and remembering what it used to offer would keep this
        // client sending types the peer no longer handles.
        this.declaredPeerTypes = frame.supportedTypes
        this.peerAuthentication = accepted.authentication
        this.peerCredential = accepted.credential ?? null
        this.record(TransportEventType.AuthAccepted, {
          node: this.peerNode ?? '',
          authentication: accepted.authentication,
          ...(accepted.credential === undefined
            ? {}
            : {
                credentialSource: accepted.credential.source,
                credentialId: accepted.credential.id,
              }),
        })
        this.onReady()
        return
      }
      case FrameType.Receipt:
        this.outbox.receive(frame)
        return
      case FrameType.Envelope: {
        const context: InboundContext = {
          peerNode: this.peerNode,
          receivedAt: this.now(),
          channel: this,
        }
        const reply = await receiveEnvelope(frame.envelope, context, {
          onMessage: this.options.onMessage,
          dedup: this.inboundDedup,
          recorder: this.recorder,
          now: this.now,
          deadlineNow: this.deadlineNow,
        })
        this.write(socket, reply)
        return
      }
      default:
        return
    }
  }

  /**
   * Check the listener's half of the handshake before believing the link
   * (§7.1.1). The returned value is the actual proof that admitted the peer.
   *
   * A refusal is **not** treated the way a 4003 is. 4003 means "your key is
   * wrong", which retrying cannot fix; this means "the thing that answered is
   * not who I dialled", which a retry very well might — the endpoint record
   * may be mid-update, or the peer may be a build that has yet to be given its
   * keys. So it closes with a protocol error and falls back into the existing
   * `ReconnectSchedule`, exactly as §7.1.1 asks, and the backoff budget is what
   * eventually reports a peer that never becomes the right one.
   */
  private acceptReady(
    socket: WebSocket,
    frame: {
      readonly node?: string
      readonly sig?: string
      readonly credential?: string
      readonly credentialProof?: string
    },
  ): {
    readonly authentication: HandshakeAuthentication
    readonly credential?: AuthenticatedCredential
  } | null {
    const signing = this.options.signing
    const peerNode = this.options.peerNode
    if (signing === undefined || peerNode === undefined) {
      return { authentication: 'psk' }
    }
    const pending = this.pendingHandshake
    // No remembered tuple means this ready did not answer a challenge this
    // socket issued — there is nothing to check it against, and accepting it
    // would be accepting an unsolicited frame as proof.
    const verdict =
      pending !== null && pending.socket === socket
        ? verifyReady(peerNode, signing, pending.tuple, frame)
        : ({ ok: false, rejection: ReadyRejection.BadSignature } as const)
    if (verdict.ok) return verdict
    this.record(TransportEventType.AuthRejected, {
      face: 'ready',
      rejection: verdict.rejection,
      peerNode,
    })
    this.pendingHandshake = null
    socket.close(CLOSE_PROTOCOL_ERROR, 'ready signature rejected')
    socket.terminate()
    return null
  }

  private onReady(): void {
    this.state = 'ready'
    this.schedule.succeeded()
    // Alongside it, and for the same reason: a handshake that got through is
    // the proof that whatever the last rotation moved away from is resolved.
    // Keeping the count would make the rotation budget a lifetime allowance
    // for an event that recurs — see {@link MAX_CHANNEL_ROTATIONS}.
    this.channelRotations = 0
    this.startKeepAlive()
    // Replay everything unreceipted, oldest first. Duplicates are the
    // receiver's problem by design — that is the whole at-least-once bargain.
    this.outbox.replay()
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const resolve of waiters) resolve()
    try {
      this.options.onReady?.()
    } catch (error) {
      // Contained for the same reason the event sink is: this runs inside the
      // socket's message handler, and a caller fault must not take the link
      // down with it.
      this.record(TransportEventType.SinkFailed, {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private recordReceipt(frame: ReceiptFrame, known: boolean): void {
    if (frame.status === ReceiptStatus.Rejected) {
      this.record(TransportEventType.MessageRejected, {
        msgId: frame.msgId,
        code: frame.code ?? '',
        reason: frame.reason ?? '',
      })
      return
    }
    if (!known) return
    this.record(
      frame.status === ReceiptStatus.Duplicate
        ? TransportEventType.MessageDuplicate
        : TransportEventType.MessageAccepted,
      { msgId: frame.msgId },
    )
  }

  /**
   * A dial that could not even be attempted, put on the reconnect schedule.
   *
   * Shares `onClose`'s tail deliberately: "the TLS materials were unreadable
   * for a moment" and "the peer was not answering for a moment" have the same
   * right answer — back off and try again — and giving them two code paths is
   * how one of them ends up with no give-up bound.
   */
  private failDial(error: unknown, onFatal?: (error: Error) => void): void {
    this.record(TransportEventType.ConnectionClosed, {
      reason: error instanceof Error ? error.message : String(error),
    })
    this.scheduleReconnect(onFatal)
  }

  private onClose(
    socket: WebSocket,
    code: number,
    onFatal?: (error: Error) => void,
  ): void {
    if (this.socket !== socket) return
    socket.removeAllListeners()
    // Same reason as in close(): a listener-less 'error' is rethrown, and this
    // socket may still emit one while it finishes tearing down.
    socket.on('error', () => {})
    this.socket = null
    this.peerAuthentication = null
    this.peerCredential = null
    // The nonce pair belonged to that socket. Carrying it to the next one
    // would let a ready frame be checked against a challenge it never answered.
    if (this.pendingHandshake?.socket === socket) this.pendingHandshake = null
    this.stopKeepAlive()
    if (this.state === 'closed') return

    this.record(TransportEventType.ConnectionClosed, { code })

    // 4003 is the peer saying the key is wrong. Retrying cannot fix a wrong
    // key, and hammering a door that answers 'unauthorized' is how one
    // misconfigured node becomes everyone's incident.
    if (code === CLOSE_UNAUTHORIZED) {
      this.record(TransportEventType.AuthRejected, { code })
      this.die(new Error('transport handshake rejected (4003)'), onFatal)
      return
    }

    // 4004 is a different sentence: the key is *fine* and the channel id is
    // taken (`CLOSE_CHANNEL_CONFLICT`). Nothing about this client is wrong, so
    // killing it would be the listener's directory change taking a healthy
    // node out of service — which is what the earlier "4003 for everything"
    // shape did, permanently and for a peer that had not changed a byte.
    if (code === CLOSE_CHANNEL_CONFLICT) {
      // One reading of the clock for both halves of the answer. Reading it
      // twice lets the give-up boundary fall *between* them: the rotation is
      // recorded and the id changed on the first reading, the dial that was to
      // carry it is refused on the second, and the client dies reporting an
      // exhausted budget — the two symptoms `rotationRefusal` exists to
      // prevent, reproduced on a window microseconds wide.
      const now = this.now()
      const refusal = this.rotationRefusal(now)
      if (refusal === null) {
        this.rotateChannelId()
        this.scheduleReconnect(onFatal, now)
        return
      }
      this.record(TransportEventType.AuthRejected, { code })
      this.die(new Error(refusal), onFatal)
      return
    }

    this.scheduleReconnect(onFatal)
  }

  /**
   * Why this client may not answer a {@link CLOSE_CHANNEL_CONFLICT} by taking
   * a fresh channel id — as the sentence its caller will be given — or `null`
   * when it may.
   *
   * The reconnect budget belongs in here, rather than being discovered by the
   * dial that follows, because a rotation is only half of the answer: the
   * other half is the dial carrying the new id. A client that will not dial
   * again — budget spent, or `giveUpAfterMs: 0`, which is how `@qianmo/tunnel`
   * configures a lease that must not outlive its link — would otherwise record
   * a {@link TransportEventType.ChannelRotated}, a *loss* record, for an id
   * that never reached the wire, and then die reporting an exhausted reconnect
   * budget: the symptom of the give-up path it fell into, in place of the 4004
   * that actually ended it.
   *
   * `now` comes from the caller rather than the clock so that this answer and
   * the retry it licenses are the same reading — see `onClose`.
   */
  private rotationRefusal(now: number): string | null {
    if (this.channelIdIsCallerSupplied) {
      return `transport channel ${this.channelId} is held by another identity (4004); a caller-supplied channel id is never rotated`
    }
    if (this.channelRotations >= MAX_CHANNEL_ROTATIONS) {
      return `transport channel id still conflicted after ${this.channelRotations} rotation(s) (4004)`
    }
    if (!this.schedule.willRetry(now)) {
      return `transport channel ${this.channelId} is held by another identity (4004), and this client has no reconnect left to carry a fresh one`
    }
    return null
  }

  /**
   * Move to a fresh channel id.
   *
   * Whether this client *may* is {@link rotationRefusal}'s question, asked
   * before the move; this only makes it.
   */
  private rotateChannelId(): void {
    this.channelRotations += 1
    const abandoned = this.channelId
    this.channelId = newChannelId()
    // Recorded because it is a loss, not a retry: anything the listener had
    // queued on `abandoned` for the identity that owned it stays there until
    // its retention clock expires and never reaches this client. This side's
    // own unreceipted envelopes are not lost — the outbox replays them onto
    // the new channel as it does after any reconnect.
    this.record(TransportEventType.ChannelRotated, {
      abandoned,
      channelId: this.channelId,
      rotation: this.channelRotations,
    })
  }

  /**
   * Terminal state, from any of the ways in (see {@link isClosed}).
   *
   * The `outbox.close` is the point of having one function: without it a
   * caller parked on `sendAndWait`/`waitForDrain` when the link died learns
   * nothing until its own timeout fires, and then learns the wrong thing —
   * "no receipt within 5000ms" describes the symptom of a channel that has
   * been dead since the first millisecond, and hides the cause. `close()` has
   * always done this; the fatal paths did not, and that asymmetry is the whole
   * difference between a diagnosable failure and a silent one.
   */
  private die(error: Error, onFatal?: (error: Error) => void): void {
    this.state = 'closed'
    this.clearTimers()
    this.readyWaiters = []
    this.outbox.close(error)
    onFatal?.(error)
  }

  private scheduleReconnect(
    onFatal?: (error: Error) => void,
    // Defaulted, so the two ordinary callers stay as they were; the 4004 path
    // passes the instant it already decided on, which is what keeps its
    // rotation and its retry on the same reading of the clock.
    now: number = this.now(),
  ): void {
    if (this.state === 'closed') return
    this.state = 'reconnecting'
    const decision = this.schedule.next(now)
    if (decision.action === 'give-up') {
      this.record(TransportEventType.ReconnectGaveUp, {
        elapsedMs: decision.elapsedMs,
      })
      // Routed through `die` with the other two terminal paths. It is the same
      // asymmetry and it is on the path this file's rotation logic creates:
      // a rotation that keeps colliding lands here, and a caller parked on
      // `sendAndWait` would otherwise wait out its own timeout to be told
      // "no receipt" rather than "the link gave up".
      this.die(new Error('transport reconnect budget exhausted'), onFatal)
      return
    }
    if (decision.timeJumpDetected) {
      this.record(TransportEventType.TimeJumpDetected, {
        attempt: decision.attempt,
      })
    }
    this.record(TransportEventType.ReconnectScheduled, {
      attempt: decision.attempt,
      delayMs: decision.delayMs,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(onFatal)
    }, decision.delayMs)
    this.reconnectTimer.unref?.()
  }

  private write(socket: WebSocket, frame: TransportFrame): void {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(serializeFrame(frame))
  }

  private writeEnvelope(message: QianmoMessage): void {
    const socket = this.socket
    if (socket === null) return
    this.write(socket, {
      t: FrameType.Envelope,
      v: FRAME_VERSION,
      envelope: message,
    })
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    if (this.keepAliveIntervalMs <= 0) return
    this.keepAliveGate?.observe(this.now())
    this.keepAliveTimer = setInterval(() => {
      const socket = this.socket
      if (socket === null || this.state !== 'ready') return
      const now = this.now()
      const observation = this.keepAliveGate?.observe(now)
      if (observation?.jumped === true) {
        this.lastInboundAt += observation.gapMs
        this.record(TransportEventType.TimeJumpDetected, {
          face: 'keepalive',
          gapMs: observation.gapMs,
        })
      }
      // Silence for three periods means the link is gone in a way TCP has not
      // noticed yet (NAT drop, frozen peer). Tearing it down is cheap: the
      // outbox replays and the receiver dedups.
      if (now - this.lastInboundAt > this.keepAliveIntervalMs * 3) {
        socket.terminate()
        return
      }
      this.write(socket, { t: FrameType.KeepAlive, v: FRAME_VERSION })
    }, this.keepAliveIntervalMs)
    this.keepAliveTimer.unref?.()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private clearTimers(): void {
    this.stopKeepAlive()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

/**
 * Emit the TLS materials in **both** accepted shapes.
 *
 * Measured on Bun 1.3.13: a `wss://` dial carrying node-style top-level `ca`
 * fails with "TLS handshake failed", while the same dial carrying Bun's nested
 * `{ tls: { ca } }` succeeds — Bun answers `import 'ws'` with its own
 * implementation, which reads only the nested form. The base hits the same
 * fork and branches on `typeof Bun`
 * (`src/cli/transports/WebSocketTransport.ts:160-184`).
 *
 * Emitting both is deliberate: each runtime ignores the shape it does not
 * know, so there is one code path instead of a runtime test that only one CI
 * job ever exercises.
 */
function toTlsOptions(tls: ClientTlsOptions): Record<string, unknown> {
  const nodeStyle: Record<string, unknown> = {
    ...(tls.ca === undefined ? {} : { ca: [tls.ca].flat() }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    ...(tls.rejectUnauthorized === undefined
      ? {}
      : { rejectUnauthorized: tls.rejectUnauthorized }),
  }
  return { ...nodeStyle, tls: nodeStyle }
}
