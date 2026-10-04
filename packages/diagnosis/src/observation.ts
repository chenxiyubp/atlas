// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the classifier is allowed to look at.
 *
 * The type is the argument: a classifier that took "the log" would be a text
 * matcher, and a text matcher cannot tell a timeout from an OOM — both end as
 * `exit 137`, both print nothing, and picking between them by keyword is how
 * you get a confident wrong answer at three in the morning. So the observation
 * carries the *structured* facts the runtime already knows and the text as one
 * more signal rather than the only one.
 *
 * ## The 137 problem, stated once
 *
 * A process killed by SIGKILL exits 137 whoever sent the signal. Our own
 * deadline enforcement sends it; so does the kernel's OOM killer. `@qianmo/sandbox`
 * already records the difference at the moment it happens —
 * `execution.timeout_enforced` carries the deadline, `resource.memory_oom_killed`
 * carries the `oom_kill` counter delta — and those two fields are why this
 * package can answer at all. Everything else here is corroboration.
 *
 * Fields are optional because a real observation is usually partial: a task
 * that died on a node we can no longer reach leaves an exit code and nothing
 * else. A classifier that required a full observation would answer `unknown`
 * exactly when the answer matters most.
 */

/** One captured failure, as much of it as the runtime managed to record. */
export interface FailureObservation {
  /** Process exit code, when the process exited on its own terms. */
  readonly exitCode?: number | null
  /** Terminating signal name, e.g. `SIGKILL`. */
  readonly signal?: string | null
  /** Captured stderr, truncated by the caller if need be. */
  readonly stderr?: string
  /** Captured stdout. Some runtimes put the interesting error here. */
  readonly stdout?: string
  /** How long the task ran, in ms. */
  readonly durationMs?: number
  /** The deadline that applied, in ms, when there was one. */
  readonly timeoutMs?: number
  /**
   * True when *we* enforced the deadline — i.e. our own supervisor sent the
   * kill. This is the field that separates a timeout from an OOM, and it is a
   * fact the enforcer knows rather than a guess from the exit code.
   */
  readonly timeoutEnforced?: boolean
  /**
   * Increase in the cgroup's `oom_kill` counter across the task, when the host
   * could read it. Non-zero means the kernel killed something for memory.
   */
  readonly oomKillDelta?: number
  /** HTTP status of the upstream call that failed, when there was one. */
  readonly httpStatus?: number
  /** Provider or service the failing call went to, for the audit line. */
  readonly service?: string
  /** Free-form extras a caller wants on the diagnosis record. */
  readonly context?: Readonly<Record<string, string | number | boolean>>
}

/** Everything textual in one lowercased haystack, for the pattern rules. */
export function textOf(observation: FailureObservation): string {
  return `${observation.stderr ?? ''}\n${observation.stdout ?? ''}`.toLowerCase()
}

/** True when the process died by SIGKILL, however that is reported. */
export function killedBySignal(
  observation: FailureObservation,
  signal: string,
): boolean {
  if (observation.signal === signal) return true
  // 128 + signal number, the shell convention every runner reproduces.
  const codes: Readonly<Record<string, number>> = {
    SIGKILL: 137,
    SIGTERM: 143,
    SIGABRT: 134,
    SIGXFSZ: 153,
  }
  const expected = codes[signal]
  return expected !== undefined && observation.exitCode === expected
}
