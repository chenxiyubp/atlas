// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/handoff` — the pure-logic core of the local-to-cloud handoff
 * (P17.4, handoff-p17-plan.md §2).
 *
 * No occ runtime, no network, no home-directory paths: every path is handed
 * in by the caller, and the only process this package starts is `git`. The
 * CLI (`qm handoff`), the hub API and the node bridge are built on top of it
 * elsewhere.
 */

export {
  CLOUD_DEVICE,
  FIELD_MAX_BYTES,
  HANDOFF_TOOLS,
  HandoffValidationError,
  MANIFEST_KIND,
  MANIFEST_MAX_BYTES,
  RESULT_MAX_BYTES,
  RESULT_STATUSES,
  decodeResultContent,
  encodeResultContent,
  isIsoInstant,
  isSha,
  isTaskId,
  isValidBranchName,
  isValidRefName,
  parseManifest,
  parseQianmoRef,
  sessionRef,
  taskBranch,
  taskRef,
  validateManifest,
  validateResult,
  wipRef,
  type HandoffBrief,
  type HandoffManifest,
  type HandoffResult,
  type HandoffResultStatus,
  type HandoffTool,
  type QianmoRef,
  type ValidationResult,
} from './manifest.js'

export { HandoffGitError } from './git.js'

export {
  HANDOFF_GIT_IDENTITY,
  MAX_CHANGED_FILE_BYTES,
  OversizedFileError,
  SECRET_PATH_PATTERNS,
  SecretFoundError,
  shadowCommit,
  shadowTree,
  type SecretFinding,
  type ShadowCommit,
  type ShadowCommitOptions,
  type ShadowOptions,
  type ShadowTree,
} from './shadow.js'

export {
  sessionCommit,
  type SessionCommit,
  type SessionCommitOptions,
} from './session.js'

export {
  FAILURE_REASON_MAX_BYTES,
  HANDOFF_STATES,
  HANDOFF_TRANSITIONS,
  HandoffLedger,
  HandoffLedgerError,
  replayLedger,
  type HandoffLedgerErrorCode,
  type HandoffLedgerOptions,
  type HandoffState,
  type HandoffTask,
  type LedgerReplay,
  type TornTail,
} from './ledger.js'
