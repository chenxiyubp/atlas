// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `@qianmo/witness` — off-host, append-only audit-chain prefix proofs. */

export {
  WITNESS_ANCHOR_VERSION,
  canonicalizeWitnessAnchor,
  isWitnessAnchor,
  isWitnessAnchorReceipt,
  isWitnessEvidence,
  signWitnessAnchor,
  verifyWitnessAnchor,
  witnessAnchorOf,
  witnessReceivedAtOf,
  type UnsignedWitnessAnchor,
  type WitnessAnchor,
  type WitnessAnchorReceipt,
  type WitnessEvidence,
} from './anchor.js'

export {
  DEFAULT_WITNESS_ANCHOR_INTERVAL_MS,
  AuditWitnessScheduler,
  type AuditWitnessSchedulerOptions,
  type WitnessAnchorWriter,
} from './sender.js'

export {
  FileWitnessAnchorStore,
  WitnessAnchorExistsError,
  type FileWitnessAnchorStoreOptions,
} from './store.js'

export {
  ALLOWED_METHODS,
  DEFAULT_WITNESS_REMOTE_TIMEOUT_MS,
  DESTRUCTIVE_WORDS,
  WITNESS_SURFACE,
  WitnessOp,
  WitnessRemoteTimeoutError,
  assertWitnessSurfaceIsSafe,
  remoteWitnessAnchorReader,
  remoteWitnessAnchorWriter,
  startWitnessService,
  type RemoteWitnessAnchorReaderOptions,
  type RemoteWitnessAnchorWriterOptions,
  type WitnessAudience,
  type WitnessRoute,
  type WitnessServiceHandle,
  type WitnessServiceOptions,
} from './service.js'

export {
  DEFAULT_WITNESS_STALE_AFTER_MS,
  checkWitnessStaleness,
  formatWitnessVerification,
  verifyAuditWitness,
  type CheckWitnessStalenessOptions,
  type VerifyWitnessOptions,
  type WitnessStaleness,
  type WitnessVerification,
  type WitnessVerificationIssue,
} from './verify.js'
