// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/diagnosis` — cause-level failure diagnosis (P5.1).
 *
 * Turns "the task failed" into one of five named causes with the evidence that
 * named it and the action it implies, or into an honest `unknown`. AC-7's
 * second beat is an operator reading the cause, so the output is a structured
 * event rather than a log line, and the rules are rules rather than a model —
 * see `classify.ts` for why that is a requirement here and not a preference.
 *
 * The classifier is the easy half. The hard half is the evidence: `exit 137`
 * cannot tell a timeout from an OOM, and no amount of pattern matching fixes
 * that. What fixes it is the runtime recording *which* of them it did at the
 * moment it did it, which `@qianmo/sandbox` already does — so this package
 * reads structured facts first and captured text second, always.
 */

export {
  classifyFailure,
  type Diagnosis,
  type DiagnosisConfidence,
} from './classify.js'

export {
  DIAGNOSIS_SCHEMA,
  diagnose,
  observationFromTaskResult,
  type CapturedLogs,
  type DiagnosisEvent,
  type TaskResultLike,
} from './event.js'

export {
  killedBySignal,
  textOf,
  type FailureObservation,
} from './observation.js'

export {
  FAILURE_CAUSES,
  FailureCause,
  SUGGESTED_ACTIONS,
  isNamedCause,
} from './taxonomy.js'
