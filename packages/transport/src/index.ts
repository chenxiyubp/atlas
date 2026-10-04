// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/transport` — one hop of the Qianmo network.
 *
 * A long-lived WebSocket between two nodes, with the four properties P2.2
 * asks for and nothing else:
 *
 * 1. **a listening half** (`server.ts`) — the piece the base does not have at
 *    all: its 3,326 lines of transport are entirely client-side;
 * 2. **an authenticated handshake** (`handshake.ts`) — originally a
 *    pre-shared key, explicitly not production grade (charter N-3), now
 *    joined inside frame version 1 by the two-way Ed25519 signature that
 *    replaces it (key-distribution.md §7.1); both live at once because a
 *    version bump cannot stage a migration, and the limits of each are
 *    written down where the code is rather than only in a document;
 * 3. **reconnect with backoff and a time-jump gate** (`backoff.ts`), because a
 *    frozen node's clock keeps running and would otherwise wake to find its
 *    whole retry budget spent (E4);
 * 4. **at-least-once delivery** (`client.ts`) paired with **two-level
 *    receiver-side dedup** (`dedup.ts`) — retransmission is the price of not
 *    losing messages, and dedup is what makes that price payable.
 *
 * What is deliberately *not* here: routing, loop detection, rate limiting,
 * TTL enforcement and the mailbox hand-off. Those are the router's and
 * `@qianmo/adapter`'s, and this package stays a leaf that imports nothing from
 * the base runtime.
 */

export {
  DEFAULT_BACKOFF,
  ReconnectSchedule,
  backoffDelay,
  type BackoffOptions,
  type RandomSource,
  type ReconnectDecision,
} from './backoff.js'

export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  MAX_CHANNEL_ROTATIONS,
  TransportClient,
  dialUrl,
  type ClientTlsOptions,
  type ClientTlsSource,
  type TransportClientOptions,
  type TransportEndpoint,
} from './client.js'

export type {
  InboundContext,
  InboundHandler,
  TransportChannel,
} from './channel.js'

export {
  DEFAULT_MAX_ENTRIES,
  DedupTable,
  DedupVerdict,
  type DedupOptions,
} from './dedup.js'

export {
  DEFAULT_EVENT_CAPACITY,
  EventRecorder,
  TransportEventType,
  type EventDetail,
  type TransportEvent,
  type TransportEventSink,
} from './events.js'

export {
  FRAME_VERSION,
  FrameType,
  ReceiptStatus,
  parseFrame,
  serializeFrame,
  type AuthFrame,
  type ChallengeFrame,
  type EnvelopeFrame,
  type KeepAliveFrame,
  type ReadyFrame,
  type ReceiptFrame,
  type TransportFrame,
} from './frames.js'

export {
  DEFAULT_MAX_QUEUED,
  OutboxFullError,
  TransportReceiptError,
  type SuccessfulReceiptStatus,
} from './outbox.js'

export {
  CLOSE_CHANNEL_CONFLICT,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_UNAUTHORIZED,
  HANDSHAKE_CREDENTIAL_PROOF_DOMAIN,
  HANDSHAKE_SIGNATURE_DOMAIN,
  HandshakeRejection,
  PSK_ENV_VAR,
  PSK_MIN_LENGTH,
  ReadyRejection,
  WeakSecretError,
  assertUsablePsk,
  authCredentialProofInput,
  authSigningInput,
  computeMac,
  isChannelId,
  newChannelId,
  newNonce,
  pskFromEnv,
  readySigningInput,
  readyCredentialProofInput,
  signReady,
  verifyAuth,
  verifyAuthAttempt,
  verifyReady,
  signatureRequiredFor,
  credentialProofRequiredFor,
  type AuthAttempt,
  type AuthenticatedCredential,
  type HandshakeAuthentication,
  type HandshakeCredentialDirectory,
  type HandshakeCredentialClaim,
  type HandshakeIdentity,
  type HandshakeResult,
  type HandshakeTuple,
  type ListenerIdentity,
  type ResolvedHandshakeCredential,
  type ReadyResult,
} from './handshake.js'

export {
  mutualTlsClientOptions,
  mutualTlsServerOptions,
  type MutualTlsMaterials,
} from './mutualTls.js'

export {
  DEFAULT_CHANNEL_RETENTION_MS,
  DEFAULT_IDLE_TIMEOUT_SEC,
  DEFAULT_MAX_CHANNELS,
  startTransportServer,
  type TransportServerHandle,
  type TransportServerOptions,
  type PeerCredentialTarget,
} from './server.js'
