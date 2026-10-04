// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Failure backoff — a deliberate divergence from hermes cron (§3.G, row 3).
 *
 * hermes' cron has no failure backoff at all, and for its object that is the
 * right call: a scheduled read that fails costs one wasted request and the next
 * period retries it. This project's scheduled unit is not a read. **A watch job
 * has real side effects** — it opens (or resumes) an ACP session on a node,
 * burns a whole serialized turn on a node that runs one turn at a time, spends
 * the peer's inbound budget, and may write to a repository. Retrying that at
 * full cadence against a target that is down does not "keep trying"; it keeps a
 * node busy failing, once a minute, until someone notices — and the channel
 * that would tell them is silent by design (§4.1 point 5).
 *
 * So: strictly increasing, doubling, capped.
 *
 * ## The cost of the divergence, stated
 *
 * A job whose target comes back two minutes after its eighth consecutive
 * failure still waits out the remaining fifty-eight of its capped hour. That is
 * the price of not hammering, and it is paid on purpose: the alternative — a
 * liveness probe that shortens the wait — is a second schedule with its own
 * failure modes, dialling the same node this file exists to leave alone. An
 * operator who cannot wait has the job's own controls.
 *
 * ## Why the default is no jitter
 *
 * Jitter is genuinely useful when many jobs fail together (a hub restart, a
 * network partition) and would otherwise retry in lockstep. It is also a
 * seeded-RNG dependency in every test that touches this function, which is how
 * a pure function stops being one. It is therefore injectable and **off by
 * default**: the caller that has a fleet large enough to stampede can pass a
 * deterministic spread; the tests, and the single-hub M1 deployment, do not.
 */

export interface BackoffOptions {
  /** First delay, and the base of the doubling. */
  readonly baseMs?: number
  /** Ceiling. Reached delays stay flat at this value forever. */
  readonly capMs?: number
  /**
   * Optional deterministic spread, applied after the cap.
   *
   * Given the failure count and the computed delay, returns the delay to use.
   * A jitter that returns something non-finite or negative is ignored rather
   * than obeyed — a backoff knob must not be able to turn into "retry now".
   */
  readonly jitter?: (consecutiveFailures: number, delayMs: number) => number
}

/**
 * 30 s first, one hour ceiling.
 *
 * The floor is above a node's restart time, so the commonest failure — the
 * target was rebooting — is recovered from on the first retry rather than
 * doubled past. The ceiling is an hour because that is the coarsest watch
 * cadence anyone is likely to write down, i.e. the point past which backing off
 * further is indistinguishable from having disabled the job.
 */
export const DEFAULT_BACKOFF = {
  baseMs: 30_000,
  capMs: 3_600_000,
} as const

/**
 * How long to hold a job off after `consecutiveFailures` failures in a row.
 *
 * `0` for zero failures — a success resets the counter, and this function has
 * to answer "nothing to wait for" for that case, otherwise the caller needs a
 * second branch and the reset stops being observable in one place.
 */
export function backoffMs(
  consecutiveFailures: number,
  options: BackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs
  const capMs = options.capMs ?? DEFAULT_BACKOFF.capMs
  if (!(baseMs > 0)) {
    throw new RangeError(`backoff baseMs must be positive, got ${baseMs}`)
  }
  if (!(capMs >= baseMs)) {
    throw new RangeError(`backoff capMs must be at least baseMs, got ${capMs}`)
  }
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) {
    return 0
  }

  const n = Math.floor(consecutiveFailures)
  // `2 ** n` overflows to Infinity somewhere past a thousand failures, and
  // `Math.min` handles that correctly — the cap is the answer either way. The
  // exponent is clamped anyway so the multiplication never has to be trusted.
  const steps = Math.min(n - 1, 64)
  const raw = Math.min(baseMs * 2 ** steps, capMs)

  if (options.jitter === undefined) return raw
  const jittered = options.jitter(n, raw)
  if (!Number.isFinite(jittered) || jittered < 0) return raw
  return jittered
}
