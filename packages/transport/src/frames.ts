// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolErrorCode } from '@qianmo/protocol'

/**
 * Wire frames of the transport hop.
 *
 * These are **not** protocol messages. `@qianmo/protocol` owns what travels
 * end to end (the envelope); this module owns the five frames two adjacent
 * nodes exchange to move one envelope across one hop: a handshake pair, a
 * ready marker, the envelope carrier and a receipt.
 *
 * The distinction matters most for {@link ReceiptFrame}. A receipt says "this
 * hop has taken responsibility for the envelope" — it is emphatically **not**
 * the protocol's `ack`, which may only be emitted once the target agent has
 * actually read the message out of its mailbox (protocol.md §4.5: emitting an
 * ack at write time hides mailbox eviction and breaks AC-2). Nothing in this
 * package ever constructs a `MessageType.Ack`.
 */

/**
 * Version of the frame grammar. v1 authenticates a stable logical channel id.
 *
 * **This number cannot be used to stage a migration.** {@link parseFrame}
 * compares it for strict equality and drops anything else, so raising it does
 * not produce two generations that can talk — it produces two that cannot. Every
 * extension therefore has to land *inside* v1 as an optional field that an older
 * parser ignores, which is how `supportedTypes` arrives below.
 */
export const FRAME_VERSION = 1

/** Discriminant of {@link TransportFrame}. */
export enum FrameType {
  /** Server → client, first frame on an open socket: a single-use nonce. */
  Challenge = 'challenge',
  /** Client → server: the keyed answer to a challenge. */
  Auth = 'auth',
  /** Server → client: the handshake passed, envelopes may flow. */
  Ready = 'ready',
  /** One protocol envelope, valid in either direction after authentication. */
  Envelope = 'envelope',
  /** What became of one envelope on this hop, returned in either direction. */
  Receipt = 'receipt',
  /**
   * Client → server: a data frame carrying nothing, sent to keep the socket
   * from being reaped as idle.
   *
   * A WebSocket ping would be the obvious choice and is the wrong one: proxies
   * do not count control frames toward their idle timers, which is exactly why
   * the base grew a `keep_alive` **data** frame of its own
   * (`src/cli/transports/WebSocketTransport.ts:21, :775-800`). Bun's own server
   * default is a 10 s idle timeout, so without this a quiet link dies in ten
   * seconds.
   */
  KeepAlive = 'keep_alive',
}

/** Outcome recorded by a {@link ReceiptFrame}. */
export enum ReceiptStatus {
  /** First sighting; the receiving node has taken it in. */
  Accepted = 'accepted',
  /** Dedup hit — already handled. The sender may retire it all the same. */
  Duplicate = 'duplicate',
  /** Refused. `code` says why; resending the same bytes will not help. */
  Rejected = 'rejected',
}

export interface ChallengeFrame {
  readonly t: FrameType.Challenge
  readonly v: typeof FRAME_VERSION
  /** Single-use server nonce, hex. */
  readonly nonce: string
}

export interface AuthFrame {
  readonly t: FrameType.Auth
  readonly v: typeof FRAME_VERSION
  /**
   * Node segment the dialer claims to be.
   *
   * **Whether this is authority or a label depends on {@link AuthFrame.sig}.**
   * With `sig` present and verified, it is *the* authority: the signature is
   * over this very name under the dialer's own Ed25519 key, so no other node
   * can produce it (key-distribution.md §7.1). With only {@link AuthFrame.mac},
   * it is an audit label and nothing more — one symmetric secret is shared by
   * every node, so any holder can write any name here (`handshake.ts:16-18`).
   *
   * Both forms exist at once during the migration, and they are told apart by
   * the presence of `sig`, never by anything the claimant says about itself.
   */
  readonly node: string
  /** Echo of {@link ChallengeFrame.nonce}. */
  readonly nonce: string
  /** Dialer-chosen nonce, hex; keeps the MAC input fresh on both sides. */
  readonly clientNonce: string
  /** Stable logical connection id, retained across physical reconnects. */
  readonly channelId: string
  /** `HMAC-SHA256` over both nonces, node and channel id, hex. */
  readonly mac: string
  /**
   * Message types the *dialer* implements. Absent or empty ⇒ the legacy floor.
   *
   * Carried here as well as on {@link ReadyFrame} because capability discovery
   * has to answer for whoever is about to send, and the two directions have
   * different senders: the listener is the one that raises `notify`, so the
   * listener is the one that needs the dialer's list. A ready frame alone would
   * only ever tell the dialer about the listener.
   *
   * **Outside the MAC, deliberately.** Two reasons, both hard: the MAC input is
   * fixed at five fields on every deployed peer and {@link FRAME_VERSION}
   * cannot stage a change to it, so covering this field would turn an additive
   * extension into a fleet-wide handshake failure; and the field cannot grant
   * anything — tampering with it makes a sender send *fewer* types, or send one
   * that comes straight back as a rejected receipt. Neither is a capability an
   * on-path attacker did not already have by dropping frames.
   */
  readonly supportedTypes?: readonly string[]
  /**
   * Opaque selector for the credential that backs {@link AuthFrame.sig}.
   *
   * The transport never interprets this value. A credential-aware directory
   * may use it to distinguish two valid credentials for the same node. When
   * It is deliberately outside the legacy `sig`; {@link AuthFrame.credentialProof}
   * binds it without changing the v1 signature bytes old verifiers expect.
   */
  readonly credential?: string
  /** Independent proof binding `credential` to the legacy signed tuple. */
  readonly credentialProof?: string
  /**
   * Ed25519 signature by the dialer over the *same* tuple {@link AuthFrame.mac}
   * covers, base64url, domain-separated by `qianmo-handshake-v1`
   * (key-distribution.md §7.1). Present ⇒ {@link AuthFrame.node} is authority.
   *
   * **Optional because a migration cannot use {@link FRAME_VERSION}.** A
   * listener that has not been given signing material ignores this field and
   * checks the MAC, which is exactly what lets a signing node and a
   * pre-shared-key node interoperate (§8.2 phase ①). It is additive in the
   * strict sense: a build that never heard of it behaves as it always did.
   *
   * **It is opportunistic authentication, not downgrade resistance.** An
   * on-path actor can remove this field without changing the valid MAC, which
   * makes an optional listener fall back to PSK. Runtime records which proof
   * actually admitted the link; deployments pin upgraded peers (or enable
   * `required`) before treating signed identity as a guarantee. Either strict
   * policy refuses the stripped unsigned form outright.
   */
  readonly sig?: string
}

export interface ReadyFrame {
  readonly t: FrameType.Ready
  readonly v: typeof FRAME_VERSION
  /**
   * The listener's own node segment, alongside {@link ReadyFrame.sig}.
   *
   * The handshake became two-sided here (§7.1.1): under a pre-shared key,
   * "the peer could verify me" also proved the peer held the secret, and that
   * free guarantee disappears the moment the proof is asymmetric. So the
   * listener answers with a signature of its own, and this is the name that
   * signature is checked against — the dialer looks the key up under the node
   * it *meant* to reach, so a redirected endpoint fails here rather than
   * succeeding quietly.
   *
   * Meaningless without `sig`, and never authority on its own.
   */
  readonly node?: string
  /**
   * The listener's Ed25519 signature over the handshake tuple plus its own
   * node segment, base64url (§7.1.1). Optional for the same migration reason
   * as {@link AuthFrame.sig}; until the dialer pins this peer, its absence is
   * a PSK-authenticated fallback rather than proof of listener identity.
   */
  readonly sig?: string
  /** Opaque selector paired with {@link ReadyFrame.credentialProof}. */
  readonly credential?: string
  /** Independent proof binding `credential` to the listener and legacy tuple. */
  readonly credentialProof?: string
  /**
   * Message types the *listener* implements. Absent or empty ⇒ the legacy
   * floor, never "none" — see `resolvePeerTypes` in `@qianmo/protocol`.
   *
   * Capability discovery lives on the handshake rather than in the registry
   * because the registry holds a registration that expires and that a listening
   * node does not even refresh (it never dials out). A handshake is decided
   * once per connection, on the spot, over the very link the message will take.
   */
  readonly supportedTypes?: readonly string[]
}

export interface EnvelopeFrame {
  readonly t: FrameType.Envelope
  readonly v: typeof FRAME_VERSION
  /**
   * A `QianmoMessage`, still `unknown` here on purpose: everything arriving
   * over the wire is untrusted until `validateMessage` has narrowed it, and
   * the receiving node is the only place that check belongs.
   */
  readonly envelope: unknown
}

export interface ReceiptFrame {
  readonly t: FrameType.Receipt
  readonly v: typeof FRAME_VERSION
  /** `msgId` of the envelope this receipt is about. */
  readonly msgId: string
  readonly status: ReceiptStatus
  /** Present when `status` is {@link ReceiptStatus.Rejected}. */
  readonly code?: ProtocolErrorCode
  /** Short human-readable reason. Never carries payload content. */
  readonly reason?: string
}

export interface KeepAliveFrame {
  readonly t: FrameType.KeepAlive
  readonly v: typeof FRAME_VERSION
}

export type TransportFrame =
  | ChallengeFrame
  | AuthFrame
  | ReadyFrame
  | EnvelopeFrame
  | ReceiptFrame
  | KeepAliveFrame

/** JSON encoding of a frame; one frame per WebSocket message. */
export function serializeFrame(frame: TransportFrame): string {
  return JSON.stringify(frame)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

const ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(ProtocolErrorCode),
)

function isErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value)
}

/**
 * A capability declaration: a list of non-empty type names, or nothing.
 *
 * Members stay `string` rather than `MessageType`: the list is what the *peer*
 * implements, and a peer newer than this build will name types this build has
 * never heard of. Narrowing here would quietly drop exactly those.
 */
function isTypeList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

/**
 * Read an optional capability declaration, dropping a malformed one.
 *
 * Dropping rather than rejecting the frame, for the same reason a malformed
 * `code` on a receipt is dropped: this is an additive optional field, and the
 * contract for one is that a reader which cannot make sense of it behaves like
 * a reader that never knew about it. A dropped list reads as the legacy floor —
 * fewer types offered, never more.
 */
function readSupportedTypes(
  value: unknown,
): { supportedTypes: readonly string[] } | Record<string, never> {
  return isTypeList(value) ? { supportedTypes: Object.freeze([...value]) } : {}
}

/**
 * Read an optional string field, dropping a malformed one.
 *
 * Same additive-field contract as {@link readSupportedTypes}: a reader that
 * cannot make sense of the value behaves like a reader that never knew about
 * it. Verification still enforces extension pairs: if only `credential` or
 * only `credentialProof` survives parsing, the handshake is rejected rather
 * than silently treated as legacy. If both are absent, optional policy may
 * accept the unchanged legacy signature; that migration boundary is recorded
 * explicitly in `key-distribution.md` §7.1.
 */
function readOptionalString<K extends string>(
  key: K,
  value: unknown,
): { [P in K]: string } | Record<string, never> {
  return isNonEmptyString(value)
    ? ({ [key]: value } as { [P in K]: string })
    : {}
}

function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return (
    value === ReceiptStatus.Accepted ||
    value === ReceiptStatus.Duplicate ||
    value === ReceiptStatus.Rejected
  )
}

/**
 * Parse one wire frame, or `null` when the bytes are not a frame of this
 * version.
 *
 * Returning `null` rather than throwing is deliberate: a malformed frame is a
 * routine event on a public socket, and the caller's answer to it is always
 * the same (drop the connection), never a stack trace.
 */
export function parseFrame(raw: string): TransportFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed['v'] !== FRAME_VERSION) return null

  switch (parsed['t']) {
    case FrameType.Challenge:
      return isNonEmptyString(parsed['nonce'])
        ? { t: FrameType.Challenge, v: FRAME_VERSION, nonce: parsed['nonce'] }
        : null
    case FrameType.Auth:
      return isNonEmptyString(parsed['node']) &&
        isNonEmptyString(parsed['nonce']) &&
        isNonEmptyString(parsed['clientNonce']) &&
        isNonEmptyString(parsed['channelId']) &&
        isNonEmptyString(parsed['mac'])
        ? {
            t: FrameType.Auth,
            v: FRAME_VERSION,
            node: parsed['node'],
            nonce: parsed['nonce'],
            clientNonce: parsed['clientNonce'],
            channelId: parsed['channelId'],
            mac: parsed['mac'],
            ...readSupportedTypes(parsed['supportedTypes']),
            ...readOptionalString('credential', parsed['credential']),
            ...readOptionalString('credentialProof', parsed['credentialProof']),
            ...readOptionalString('sig', parsed['sig']),
          }
        : null
    case FrameType.Ready:
      return {
        t: FrameType.Ready,
        v: FRAME_VERSION,
        ...readSupportedTypes(parsed['supportedTypes']),
        ...readOptionalString('node', parsed['node']),
        ...readOptionalString('credential', parsed['credential']),
        ...readOptionalString('credentialProof', parsed['credentialProof']),
        ...readOptionalString('sig', parsed['sig']),
      }
    case FrameType.KeepAlive:
      return { t: FrameType.KeepAlive, v: FRAME_VERSION }
    case FrameType.Envelope:
      return 'envelope' in parsed
        ? {
            t: FrameType.Envelope,
            v: FRAME_VERSION,
            envelope: parsed['envelope'],
          }
        : null
    case FrameType.Receipt: {
      if (!isNonEmptyString(parsed['msgId'])) return null
      if (!isReceiptStatus(parsed['status'])) return null
      const code = parsed['code']
      const reason = parsed['reason']
      return {
        t: FrameType.Receipt,
        v: FRAME_VERSION,
        msgId: parsed['msgId'],
        status: parsed['status'],
        ...(isErrorCode(code) ? { code } : {}),
        ...(isNonEmptyString(reason) ? { reason } : {}),
      }
    }
    default:
      return null
  }
}
