// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/adapter` — the last hop of a cross-node delivery.
 *
 * Three parts, all of protocol.md §4.5 and §9:
 *
 * 1. the **inbound adapter**, which calls `teammateMailbox.writeToMailbox`
 *    directly and never routes through `SendMessageTool`;
 * 2. the **`read`-flip observer**, which turns "the agent actually took the
 *    message in" into one of three terminal states, so an ack is never emitted
 *    merely because a file write returned;
 * 3. the **blob staging area**, which keeps an oversized payload out of the
 *    base mailbox's 64 KiB read/write invariant.
 *
 * This package only ever calls *into* the base (rule M-6): nothing in the base
 * calls back, which is what keeps the dependency acyclic.
 */

export {
  BLOB_DIR_SEGMENTS,
  BlobStore,
  blobStoreDir,
  isBlobRef,
  type BlobRef,
  type BlobStoreOptions,
} from './blob.js'

export {
  deliverAndAck,
  type DeliveryObserveOptions,
  type DeliveryReply,
  type ErrorReplyPayload,
} from './delivery.js'

export {
  InboundAdapter,
  type InboundAdapterOptions,
  type InboundDelivered,
  type InboundRejection,
  type InboundResult,
  type InboundVerification,
} from './inbound.js'

export {
  InvalidTeamNameError,
  MAX_TEAM_NAME_LENGTH,
  RESERVED_DEVICE_NAMES,
  TEAM_NAME_PATTERN,
  assertTeamName,
  isNormalizedTeamName,
  isReservedDeviceName,
  normalizeTeamName,
  type TeamNameRejection,
} from './names.js'

export {
  BASE_INPROCESS_POLL_INTERVAL_MS,
  BASE_PANE_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  classifyMailboxEntry,
  observeReadFlip,
  type DeliveryOutcome,
  type MailboxEntryIdentity,
  type MailboxEntryState,
  type ObserveOptions,
} from './observer.js'

export {
  BASE_RESERVED_MESSAGE_TYPES,
  QIANMO_WRAPPER_TYPE,
  assertWrapperTypeIsNotReserved,
  buildNotice,
  buildWrapper,
  isReservedBaseMessageType,
  serializeWrapper,
  textBytes,
  type QianmoNotice,
  type QianmoWrapper,
} from './wrapper.js'
