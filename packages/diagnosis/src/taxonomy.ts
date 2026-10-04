// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The five causes P5.1 has to tell apart, and the one honest way out.
 *
 * Roadmap P5.1 names them: OOM, timeout, missing dependency, disk full, quota
 * exhausted. They were not picked for elegance — they are the five ways a task
 * in this system dies without the code being wrong, which is exactly the set an
 * operator can act on. Anything else is {@link FailureCause.Unknown}, and that
 * is a real answer rather than a bucket: "we do not know" told plainly is worth
 * more than a confident wrong label, and AC-7's judgement is that the output
 * names a cause instead of saying "execution failed".
 *
 * ## Each cause carries the action, because a diagnosis without one is trivia
 *
 * The suggested action is part of the taxonomy rather than something a caller
 * looks up: the whole point of naming the cause is that the next step differs.
 * Keeping the two together means adding a cause forces someone to say what to
 * do about it.
 */

/** What killed the task. */
export enum FailureCause {
  /** The kernel or the runtime reclaimed the process for using too much memory. */
  OutOfMemory = 'oom',
  /** A deadline we set expired and we killed it. */
  Timeout = 'timeout',
  /** Something the task needed to run was not installed or not importable. */
  MissingDependency = 'missing-dependency',
  /** A write failed because the filesystem had no room. */
  DiskFull = 'disk-full',
  /** An upstream service refused because an allowance ran out. */
  QuotaExhausted = 'quota-exhausted',
  /** None of the above matched. Reported as such, never guessed. */
  Unknown = 'unknown',
}

/** Every cause, in the order the classifier considers them. */
export const FAILURE_CAUSES: readonly FailureCause[] = Object.freeze([
  FailureCause.Timeout,
  FailureCause.OutOfMemory,
  FailureCause.DiskFull,
  FailureCause.QuotaExhausted,
  FailureCause.MissingDependency,
  FailureCause.Unknown,
])

/** What an operator (or a scheduler) should do about each cause. */
export const SUGGESTED_ACTIONS: Readonly<Record<FailureCause, string>> =
  Object.freeze({
    [FailureCause.OutOfMemory]:
      'raise the memory ceiling for this workspace or split the task; re-running unchanged will fail the same way',
    [FailureCause.Timeout]:
      'raise the deadline or split the task; check whether the task was waiting on something that never arrived',
    [FailureCause.MissingDependency]:
      'install the missing tool or package in the sandbox image; this is an environment gap, not a task failure',
    [FailureCause.DiskFull]:
      'reclaim space in the workspace or grow it; a snapshot may be safe to drop, the workspace is not',
    [FailureCause.QuotaExhausted]:
      'wait for the allowance to reset or move the task to another provider; retrying immediately will be refused again',
    [FailureCause.Unknown]:
      'read the captured output: this failure does not match any known cause, and guessing one would be worse than saying so',
  })

/** True when a cause is one the classifier positively identified. */
export function isNamedCause(cause: FailureCause): boolean {
  return cause !== FailureCause.Unknown
}
