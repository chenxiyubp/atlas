// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MessageType, QianmoMessage } from '@qianmo/protocol'
import type { SuccessfulReceiptStatus } from './outbox.js'

/** Send side of one authenticated logical transport channel. */
export interface TransportChannel {
  /**
   * Stable across physical WebSocket reconnects.
   *
   * With one implementation-side exception, and it is the one a consumer has
   * to know about before treating this as a durable key: a dialing
   * `TransportClient` whose id the listener holds under another identity
   * answers `CLOSE_CHANNEL_CONFLICT` by taking a fresh one, so its `id` can
   * differ before and after a reconnect. Server-side channels never move.
   * `activator/routes.ts` compares this field to decide that a re-registration
   * is the same route, which is correct today only because nothing hands it a
   * dialer — so check the implementation before doing likewise.
   */
  readonly id: string
  /** Authenticated audit label when known; not an authorization identity. */
  readonly peerNode: string | null
  /** Envelopes retained until their transport receipt arrives. */
  readonly pending: number
  /**
   * Exactly what the peer declared in the handshake, or `undefined` when it
   * declared nothing — the raw form, so a caller can tell "said nothing" from
   * "said the floor". `errorCodeForPeer` needs that distinction; most callers
   * want {@link TransportChannel.supports} instead.
   *
   * Replaced — not merged — at every handshake, because a peer that comes back
   * on an older build declares less and a union would keep sending it types it
   * no longer handles. Between handshakes it holds the last answer, which is
   * what a caller deciding whether to queue an envelope for a peer that is
   * momentarily down has to go on.
   */
  readonly peerSupportedTypes: readonly string[] | undefined
  /**
   * True when the peer said it implements `type`.
   *
   * An undeclared peer is assumed to speak the legacy floor and nothing else,
   * so this is `false` for anything added after it. That is the whole discipline
   * of capability discovery: **a new type is used only when it was asked for.**
   * The alternative — send it and see — costs a round trip and a rejected
   * receipt on every message to every older peer.
   */
  supports(type: MessageType): boolean
  isReady(): boolean
  isClosed(): boolean
  send(message: QianmoMessage): void
  sendAndWait(
    message: QianmoMessage,
    timeoutMs?: number,
  ): Promise<SuccessfulReceiptStatus>
  waitForDrain(timeoutMs?: number): Promise<void>
  /** Keep a disconnected server-side channel available for a later reply. */
  hold(): () => void
}

/** What a delivered envelope brings with it beyond the envelope itself. */
export interface InboundContext {
  readonly peerNode: string | null
  readonly receivedAt: number
  readonly channel: TransportChannel
}

/** Application handler on either endpoint of a bidirectional channel. */
export type InboundHandler = (
  message: QianmoMessage,
  context: InboundContext,
) => void | Promise<void>
