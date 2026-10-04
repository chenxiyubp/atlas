// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `diagnosis` event, and the bridge from P3.2's task result to it.
 *
 * P3.2 shipped a structured failure envelope (`qianmo.p32.task-result.v1`) and
 * said in as many words that the cause-level part was P5.1's. This file is the
 * join: it takes that envelope's shape — exit codes, the failure phase, and
 * whatever logs the caller has managed to read back — and produces the
 * observation the classifier consumes.
 *
 * The bridge is typed against a *structural* subset rather than importing the
 * runner's own interface. The runner is a script, not a package, and a
 * dependency from a package into `scripts/` would be the wrong direction; more
 * to the point, the same three fields arrive from the sandbox audit trail and
 * from an ACP turn failure, and none of those should have to pretend to be a
 * P3.2 result to be diagnosed.
 */

import { classifyFailure, type Diagnosis } from './classify.js'
import type { FailureObservation } from './observation.js'

/** Schema tag of the emitted event. */
export const DIAGNOSIS_SCHEMA = 'qianmo.diagnosis.v1'

/** The structured event P5.1 delivers to whoever is listening. */
export interface DiagnosisEvent extends Diagnosis {
  readonly schema: typeof DIAGNOSIS_SCHEMA
  /** Epoch ms at which the diagnosis was made — not when the task failed. */
  readonly at: number
  readonly taskId?: string
  /** Free-form extras carried through from the observation. */
  readonly context?: Readonly<Record<string, string | number | boolean>>
}

/** Diagnose one failure and wrap it as an event. */
export function diagnose(
  observation: FailureObservation,
  options: { readonly at: number; readonly taskId?: string },
): DiagnosisEvent {
  const diagnosis = classifyFailure(observation)
  return {
    schema: DIAGNOSIS_SCHEMA,
    at: options.at,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...diagnosis,
    ...(observation.context === undefined
      ? {}
      : { context: observation.context }),
  }
}

/** The part of a P3.2 task result this bridge reads. */
export interface TaskResultLike {
  readonly taskId?: string
  readonly agentExitCode?: number | null
  readonly testExitCode?: number | null
  readonly failure?: {
    readonly phase?: string
    readonly code?: string
    readonly message?: string
  } | null
}

/** Logs the caller read back from the artefacts, when it could. */
export interface CapturedLogs {
  readonly agentOutput?: string
  readonly testLog?: string
  readonly durationMs?: number
  readonly timeoutMs?: number
  readonly timeoutEnforced?: boolean
  readonly oomKillDelta?: number
  readonly httpStatus?: number
  readonly service?: string
}

/**
 * Turn a P3.2-shaped result into an observation.
 *
 * The exit code taken is the **first non-zero one in execution order** — the
 * agent ran before the tests, so if the agent died the test exit code describes
 * a run that never happened. Taking the last non-zero one instead is the
 * classic way to diagnose the symptom rather than the cause.
 */
export function observationFromTaskResult(
  result: TaskResultLike,
  logs: CapturedLogs = {},
): FailureObservation {
  const exitCode =
    result.agentExitCode !== null &&
    result.agentExitCode !== undefined &&
    result.agentExitCode !== 0
      ? result.agentExitCode
      : (result.testExitCode ?? null)
  const failureText = [result.failure?.code, result.failure?.message]
    .filter(part => typeof part === 'string' && part.length > 0)
    .join(': ')
  return {
    exitCode,
    stderr: [failureText, logs.agentOutput ?? '', logs.testLog ?? '']
      .filter(part => part.length > 0)
      .join('\n'),
    ...(logs.durationMs === undefined ? {} : { durationMs: logs.durationMs }),
    ...(logs.timeoutMs === undefined ? {} : { timeoutMs: logs.timeoutMs }),
    ...(logs.timeoutEnforced === undefined
      ? {}
      : { timeoutEnforced: logs.timeoutEnforced }),
    ...(logs.oomKillDelta === undefined
      ? {}
      : { oomKillDelta: logs.oomKillDelta }),
    ...(logs.httpStatus === undefined ? {} : { httpStatus: logs.httpStatus }),
    ...(logs.service === undefined ? {} : { service: logs.service }),
    ...(result.failure?.phase === undefined
      ? {}
      : { context: { phase: result.failure.phase } }),
  }
}
