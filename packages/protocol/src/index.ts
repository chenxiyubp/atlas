// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/protocol` — the wire contract of the Qianmo agent network.
 *
 * Types plus pure functions only: no I/O, no runtime dependencies, so both
 * nodes and tooling can share one definition of "a valid message".
 */

export {
  ADDRESS_SCHEME,
  MAX_SEGMENT_LENGTH,
  addressEquals,
  assertAddress,
  formatAddress,
  isValidAddress,
  isValidSegment,
  nodeOf,
  parseAddress,
  type QianmoAddress,
} from './address.js'

export {
  CAPABILITY_LEVELS,
  CapabilityLevel,
  PUBLIC_KEY_PATTERN,
  SIGNATURE_PATTERN,
  decodeClaims,
  encodeClaims,
  isCapabilityClaims,
  isCapabilityLevel,
  isNodePublicKey,
  levelAtLeast,
  parseCapabilityToken,
  type CapabilityClaims,
  type CapabilityParts,
} from './capability.js'

export {
  NODE_KEY_URI_SCHEME,
  formatNodeSanEntries,
  parseNodeCertificateBinding,
  type NodeCertificateBinding,
} from './node-certificate.js'

export {
  LEGACY_ERROR_CODES,
  ProtocolError,
  ProtocolErrorCode,
  downgradeErrorCode,
  isLegacyErrorCode,
  issue,
  type ProtocolIssue,
} from './errors.js'

export {
  computeFingerprint,
  isFingerprint,
  payloadDigest,
  type FingerprintInput,
} from './fingerprint.js'

export { LIMITS, type Limits } from './limits.js'

export {
  RELEASE_REASONS,
  clampNeed,
  isResourceGrantPayload,
  isResourceNeed,
  isResourceOfferPayload,
  isResourceReleasePayload,
  isResourceRequestPayload,
  needWithin,
  type ReleaseReason,
  type ResourceGrantPayload,
  type ResourceNeed,
  type ResourceOfferPayload,
  type ResourceReleasePayload,
  type ResourceRequestPayload,
} from './negotiation.js'

export {
  ENVELOPE_VERSION,
  LEGACY_MESSAGE_TYPES,
  MESSAGE_TYPES,
  MessageType,
  NOTIFY_KINDS,
  NOTIFY_SEVERITIES,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  TRUST_UNTRUSTED,
  advanceTraceparent,
  createAck,
  createMessage,
  createNotify,
  createTaskResult,
  deliveryExpiresAt,
  destinationNode,
  errorCodeForPeer,
  errorReply,
  isAckPayload,
  isDeliveryExpired,
  isNotifyPayload,
  isTaskResultPayload,
  isMessageType,
  isReplyType,
  isTaskExpired,
  messageBytes,
  newId,
  newTraceparent,
  peerIsPostLegacy,
  peerSupportsType,
  resolvePeerTypes,
  serializeMessage,
  taskExpiresAt,
  withHop,
  type AckPayload,
  type CreateMessageInput,
  type CreateNotifyInput,
  type ErrorPayload,
  type MessageOrigin,
  type NoticeTrust,
  type NotifyPayload,
  type QianmoMessage,
  type TaskResultInput,
  type TaskResultPayload,
} from './message.js'

export {
  DEFAULT_GRACE_MS,
  DEFAULT_MIN_JUMP_GAP_MS,
  DEFAULT_TIME_JUMP_FACTOR,
  TimeJumpGate,
  type TimeJumpGateOptions,
  type TimeJumpObservation,
} from './time-jump.js'

export {
  assertValidMessage,
  firstErrorCode,
  validateMessage,
  type ValidateOptions,
  type ValidationResult,
} from './validate.js'
