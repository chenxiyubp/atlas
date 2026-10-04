// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LIMITS, assertAddress, formatAddress } from '@qianmo/protocol'

/**
 * What one watch job is, and the one place its identity key is spelled.
 *
 * The job definition lives on the hub and nowhere else (design §4.1). That is
 * not a storage preference — it is the whole of hermes A6 as this project takes
 * it: a node that held its own schedule would need something to wake it on
 * time, and anything that wakes a node on a cadence is a node that is never
 * idle, therefore never frozen, therefore not the thing charter R-3 describes.
 * The timing is here so that it is *not* there.
 */

/**
 * Legal shape of a job id.
 *
 * Tighter than it looks like it needs to be, because the id is spent in two
 * places that have opinions:
 *
 * - It becomes the `contextId` of every task this job dispatches (§4.1 point
 *   3), and the resident side stores contexts verbatim only when they are
 *   printable and bounded — anything else gets digested into a hash, which
 *   would make the console's "which session is this job talking in" answer
 *   unreadable.
 * - It becomes a directory name under the claim store. An id containing a
 *   separator or a `..` would be a path traversal dressed up as a schedule
 *   entry, and the claim store is the one file the at-most-once property rests
 *   on.
 *
 * Rejecting at registration is cheap; discovering either problem at 3 a.m. on
 * the fire path is not.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * What the hub is allowed to do with a completed fire.
 *
 * **This package never reads this field.** It is validated here and carried to
 * the dispatch port, which owns the decision; the scheduler's business ends at
 * "the turn was dispatched". Stating that plainly because a policy enum that
 * the module holding it does not interpret looks like dead weight until someone
 * "tidies" it into the notify path and the two halves start disagreeing.
 *
 * - `silent` — the result reaches the audit trail and the console's job
 *   history and stops there. No `qianmo_notify` tool is injected, so the turn
 *   has no way to page anyone even if it decides it should.
 * - `agent-initiated` — the default posture of §4.1 point 5. The turn is given
 *   exactly one tool, `qianmo_notify`, and a human hears about the run only if
 *   the agent calls it. This is hermes' `[SILENT]` sentinel turned the right
 *   way round: default quiet with an explicit way to speak, rather than default
 *   loud with a magic string to suppress it.
 * - `always` — every completed fire notifies. Available because "tell me it
 *   ran" is a real request, deliberately not the default: a watch job that
 *   pages unconditionally is a cron job with extra latency, and seven days of
 *   it teaches its reader to ignore the channel.
 */
export const NOTIFY_POLICIES = ['silent', 'agent-initiated', 'always'] as const

export type NotifyPolicy = (typeof NOTIFY_POLICIES)[number]

export interface JobSchedule {
  /**
   * Period of the schedule grid, in ms.
   *
   * A safe integer, because every instant this job will ever fire at is
   * `anchorMs + k * everyMs` computed in one multiplication. A fractional
   * period does not fail — it drifts, by a little each lap, which over the
   * seven-day run the M1 exit criterion asks for is the kind of bug that is
   * only visible in the last day of the log.
   */
  readonly everyMs: number
  /**
   * Phase of the grid, in epoch ms. Optional.
   *
   * When present the grid is absolute, so "every 24h at 09:00" survives a hub
   * restart at 14:00 without sliding to 14:00. When absent the grid is anchored
   * at the job's first plan, which is also when it first fires — see
   * `reserve.ts` for why those two facts are the same fact.
   *
   * An anchor in the future is a start date: nothing fires before it.
   */
  readonly anchorMs?: number
}

export interface ScheduledJob {
  readonly id: string
  readonly title: string
  /** `qianmo://<node>/<agent>` — the node that will run the turn. */
  readonly target: string
  readonly prompt: string
  readonly schedule: JobSchedule
  /**
   * The task deadline this job's dispatches carry, in ms.
   *
   * Required, and deliberately **not** defaulted to `LIMITS.defaultTaskTtlMs`
   * (§4.1 point 4). A watch job that takes twenty minutes is a normal watch
   * job; the protocol's five-minute default is the number for an interactive
   * request. The fix for a long task is the sender naming a longer deadline,
   * never the node quietly extending one it was given (hermes B10), so the
   * number has to be stated by whoever defines the job.
   */
  readonly taskTtlMs: number
  readonly notifyPolicy: NotifyPolicy
}

/**
 * `dedupKey = "<jobId>:<fireAtMs>"` — hermes A6, verbatim (§4.1 point 1).
 *
 * Spelled here and only here. The key is what makes a reservation idempotent:
 * reserving the same `(jobId, fireAtMs)` twice, from two code paths or two
 * processes, is one fire. A second spelling of it would not fail — it would
 * simply not collide with the first, and "did not collide" is exactly what a
 * duplicate dispatch looks like from the inside.
 *
 * `fireAtMs` is the *scheduled* instant, never the wall clock of the attempt.
 * Keying on the attempt time would make every retry a distinct key, which is
 * the same as having no key at all.
 */
export function dedupKeyOf(jobId: string, fireAtMs: number): string {
  return `${jobId}:${fireAtMs}`
}

function assertPositiveDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `job ${field} must be a positive safe integer of ms, got ${String(value)}`,
    )
  }
  return value
}

function assertText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`job ${field} must be a non-empty string`)
  }
  if (Buffer.byteLength(value, 'utf8') > max) {
    throw new RangeError(`job ${field} is longer than ${max} bytes`)
  }
  return value
}

/**
 * Validate a job definition, or throw.
 *
 * Everything here is checked at registration rather than at fire time on
 * purpose. A job is written once and fires for a week; a defect in it that only
 * surfaces on the fire path surfaces on every fire, unattended, into a channel
 * that is silent by design. Registration is the last moment a human is looking.
 *
 * The prompt is bounded by `LIMITS.maxMessageBytes` for the same reason: a
 * prompt that cannot fit in one envelope is not a job that will work later, it
 * is a job that will fail identically forever. The number is imported rather
 * than restated — `@qianmo/protocol` is the only source for protocol numbers
 * (CLAUDE.md §2.2), and a copy of it here would be a second one.
 */
export function assertJob(input: unknown): ScheduledJob {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('job must be an object')
  }
  const raw = input as Record<string, unknown>

  const id = raw.id
  if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) {
    throw new TypeError(
      `job id must match ${JOB_ID_PATTERN.source}, got ${String(id)}`,
    )
  }

  const title = assertText(raw.title, 'title', 4096)
  const prompt = assertText(raw.prompt, 'prompt', LIMITS.maxMessageBytes)

  // Throws a `ProtocolError` with `E_BAD_ADDRESS`, which is the honest code:
  // an unroutable target is a protocol-level defect, not a scheduling one.
  // Re-rendered from the parse rather than kept as typed, so what is stored is
  // the canonical form the router will compare against.
  const target = formatAddress(assertAddress(raw.target, 'target'))

  const schedule = raw.schedule
  if (
    typeof schedule !== 'object' ||
    schedule === null ||
    Array.isArray(schedule)
  ) {
    throw new TypeError('job schedule must be an object')
  }
  const rawSchedule = schedule as Record<string, unknown>
  const everyMs = assertPositiveDuration(
    rawSchedule.everyMs,
    'schedule.everyMs',
  )
  const anchorMs = rawSchedule.anchorMs
  if (
    anchorMs !== undefined &&
    (typeof anchorMs !== 'number' ||
      !Number.isSafeInteger(anchorMs) ||
      anchorMs < 0)
  ) {
    throw new RangeError(
      `job schedule.anchorMs must be a non-negative safe integer, got ${String(anchorMs)}`,
    )
  }

  const taskTtlMs = assertPositiveDuration(raw.taskTtlMs, 'taskTtlMs')

  const notifyPolicy = raw.notifyPolicy
  if (
    typeof notifyPolicy !== 'string' ||
    !(NOTIFY_POLICIES as readonly string[]).includes(notifyPolicy)
  ) {
    throw new TypeError(
      `job notifyPolicy must be one of ${NOTIFY_POLICIES.join(' | ')}, got ${String(notifyPolicy)}`,
    )
  }

  return Object.freeze({
    id,
    title,
    target,
    prompt,
    schedule: Object.freeze(
      anchorMs === undefined ? { everyMs } : { everyMs, anchorMs },
    ),
    taskTtlMs,
    notifyPolicy: notifyPolicy as NotifyPolicy,
  })
}
