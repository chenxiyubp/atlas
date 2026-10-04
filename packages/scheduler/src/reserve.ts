// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ScheduledJob } from './job.js'

/**
 * One-shot reservation arithmetic (hermes A6, design §4.1 point 2).
 *
 * Pure, and pure on purpose: this is the only file that decides *when*, and a
 * decision that can be re-derived by hand from three numbers is a decision an
 * operator can argue with when a fire looks wrong. Nothing here reads a clock,
 * touches a file, or knows that a node exists.
 *
 * ## What "one-shot" means and why there is no ticker
 *
 * The scheduler computes exactly one next instant, waits for it, fires, and
 * then computes the next one from what actually happened. It never keeps a
 * cadence running. On the hub that is a modest simplification; on a node it
 * would be the difference between the sleeping node charter R-3 describes and a
 * process that is awake every minute forever. The timing is on the hub *so
 * that* no node needs a ticker — see `job.ts`.
 *
 * ## Catch-up collapses; it does not replay
 *
 * A hub down for five periods comes back owing five scheduled instants. It
 * runs **one**. Replaying five would deliver five turns to one node in one
 * second — the node runs turns serially, so the other four would queue behind
 * the first and each would carry a `taskTtlMs` that started counting while it
 * queued. Four timed-out tasks and one useful answer is a worse outcome than
 * one useful answer, and it is a worse outcome *for the same work*.
 */

/**
 * Grace floor and ceiling for a catch-up run, in ms.
 *
 * `clamp(everyMs / 2, 120_000, 7_200_000)` — hermes' three numbers, adopted
 * unchanged because the reason is unchanged. Half a period is the natural
 * scale: past it, the make-up run and the next scheduled run are closer to each
 * other than either is to its own slot. The floor keeps a fast job (say every
 * 60 s) from giving up on a hub restart that took ninety seconds, which is a
 * normal restart. The ceiling exists to stop a thundering herd: without it, a
 * daily job would carry a twelve-hour grace, so a hub that came back after a
 * long weekend would fire every job it owns inside the same second, at every
 * node it owns, all with real side effects.
 */
export const MIN_CATCH_UP_GRACE_MS = 120_000
export const MAX_CATCH_UP_GRACE_MS = 7_200_000

/** How late a missed instant may be and still be worth running. */
export function catchUpGraceMs(everyMs: number): number {
  return Math.min(
    Math.max(Math.floor(everyMs / 2), MIN_CATCH_UP_GRACE_MS),
    MAX_CATCH_UP_GRACE_MS,
  )
}

/**
 * Fire now, for the instant named by `fireAtMs`.
 *
 * `collapsed` is how many scheduled instants were passed over to get here — the
 * honest count of what the downtime cost. It is reported rather than hidden
 * because "one run happened" and "one run happened and four were dropped" are
 * different operational facts, and only one of them is worth waking someone up
 * about.
 */
export interface FireNowPlan {
  readonly kind: 'fire'
  readonly fireAtMs: number
  readonly collapsed: number
}

/**
 * The missed window is too old to be worth running; reserve the next one.
 *
 * **The cost, plainly**: a job whose hub was down for longer than its grace
 * loses that window entirely. Nothing runs for it, ever. That is deliberate —
 * a watch job's output is a statement about a moment, and a six-hour-late
 * report on a deploy that already finished is not a late answer, it is a wrong
 * one. A stale watch result is worse than none, because someone will read it as
 * current.
 */
export interface SkipPlan {
  readonly kind: 'skip'
  /** The instant given up on. Recorded so the window is retired, not retried. */
  readonly staleFireAtMs: number
  readonly collapsed: number
  /** Next future instant — the reservation that replaces the lost one. */
  readonly fireAtMs: number
  readonly delayMs: number
}

/** Nothing is due; the reservation stands. */
export interface WaitPlan {
  readonly kind: 'wait'
  readonly fireAtMs: number
  readonly delayMs: number
}

export type FirePlan = FireNowPlan | SkipPlan | WaitPlan

export interface PlanFireInput {
  readonly job: ScheduledJob
  /**
   * The last scheduled instant this job has **retired** — fired, skipped, or
   * claimed by another hub — not the wall clock at which the turn finished.
   *
   * The distinction is the whole reason the grid does not drift: a job that
   * takes four minutes of a five-minute period stays on the five-minute grid,
   * instead of walking forward by four minutes a lap until it collides with
   * itself. `undefined` means the job has never run.
   */
  readonly lastFiredAt: number | undefined
  readonly now: number
}

/**
 * Decide what to do with one job at `now`.
 *
 * ## The grid, and where its phase comes from
 *
 * Instants are `anchor + k * everyMs` for integer `k >= 0`. The anchor is the
 * job's `anchorMs` when it has one, otherwise `lastFiredAt`, otherwise `now`.
 *
 * That last fallback deserves its own sentence, because it decides the
 * first-run behaviour of every job written without an explicit anchor: such a
 * job **fires on its first plan**. Not a stylistic choice — with a floating
 * anchor and no first fire, every call to this function would re-anchor at the
 * current `now` and push the first instant one period further out, so the job
 * would never run at all. Firing once is what pins the grid; from the second
 * lap on the anchor is `lastFiredAt` and the schedule is exact.
 *
 * A job that wants a phase instead of an immediate run says so with `anchorMs`.
 * An anchor is a *phase*, never a due instant: an anchor in the past is
 * reachable through the missed-slot path like any other instant, and an anchor
 * in the future is a start date that nothing fires before.
 */
export function planFire(input: PlanFireInput): FirePlan {
  const { everyMs } = input.job.schedule
  const { lastFiredAt, now } = input
  const anchor = input.job.schedule.anchorMs ?? lastFiredAt ?? now

  const at = (index: number): number => anchor + index * everyMs

  // First index not yet retired. `floor(...) + 1` is the first instant strictly
  // after `lastFiredAt` whether or not it sits on the grid, which matters
  // because an operator editing state by hand will not land on it.
  const firstIndex =
    lastFiredAt === undefined
      ? 0
      : Math.max(0, Math.floor((lastFiredAt - anchor) / everyMs) + 1)
  // Index of the latest instant at or before `now`; negative when the anchor is
  // still in the future, which is the "start date" case.
  const lastIndex = Math.floor((now - anchor) / everyMs)

  const missed = Math.max(0, lastIndex - firstIndex + 1)

  if (missed === 0) {
    const nextIndex = Math.max(firstIndex, lastIndex + 1)
    const fireAtMs = at(nextIndex)
    return { kind: 'wait', fireAtMs, delayMs: Math.max(0, fireAtMs - now) }
  }

  // The collapse: of every instant in `(lastFiredAt, now]`, only the latest is
  // a candidate. The older ones are not queued, deferred or remembered — the
  // whole point is that they are gone.
  const missedLatest = at(lastIndex)
  if (now - missedLatest <= catchUpGraceMs(everyMs)) {
    return { kind: 'fire', fireAtMs: missedLatest, collapsed: missed - 1 }
  }

  const fireAtMs = at(lastIndex + 1)
  return {
    kind: 'skip',
    staleFireAtMs: missedLatest,
    collapsed: missed,
    fireAtMs,
    delayMs: Math.max(0, fireAtMs - now),
  }
}
