// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What happens to a decision — which in M0 is: it gets written down.
 *
 * ## The blank here is on purpose, and this is where it is
 *
 * Charter N-7 puts real elastic provisioning out of M0's scope: no cloud API,
 * no instance claim, no billing linkage. So `ScaleUpExecutor` is a one-method
 * seam with exactly one implementation — {@link auditOnlyExecutor} — and
 * nothing in the product wires a second one. P7.2's trail sinks left the same
 * kind of gap in the same way: the translation exists and is tested, the
 * production call site is a later task's.
 *
 * Stating it plainly so a reader does not go looking for the missing half:
 * **this is a blank, not an omission.** M2+ replaces `auditOnlyExecutor` with
 * something that talks to `@qianmo/negotiation` (borrow a machine that already
 * exists) or to a provisioning API (M2's job). Nothing above this file changes
 * when that happens.
 *
 * ## Why `needFromDecision` is a free function
 *
 * "How much" is a pure function of the decision and nothing else — no clock, no
 * inventory, no I/O — so it is testable on its own and reusable by an executor
 * that does not exist yet. It is also the only place a policy number is turned
 * into a resource number, which is where a reviewer would look for it.
 */

import { CapacityAuditLog } from './audit.js'
import { eventOf, type ScaleUpDecision } from './planner.js'

/** Whatever acts on a decision. Synchronous: a decision is not an operation. */
export type ScaleUpExecutor = (decision: ScaleUpDecision) => void

/**
 * How much room one decision asks for.
 *
 * Field-for-field the same axes as `@qianmo/protocol`'s `ResourceNeed`, and
 * **no cost axis** — charter N-1 puts metering, billing and settlement out of
 * scope and pins the protocol's `cost_limit` at zero, so a capacity request
 * that carried a price would be inventing a number no part of M0 can honour.
 * The type is declared here rather than imported so this package keeps its
 * empty `dependencies`; when an executor that actually provisions arrives it
 * will be the one to speak protocol.
 */
export interface CapacityNeed {
  readonly durationMs: number
  readonly cpuCores: number
  readonly memoryMb: number
}

/**
 * One unit of head-room.
 *
 * These three numbers are the blank, not the answer: nothing has measured what
 * a CUMCM weekend actually costs, and M0 has no way to find out (N-7). They are
 * sized to be obviously provisional — one modest sandbox — so that a future
 * executor has to replace them rather than inherit them by accident.
 */
export const SCALE_UP_STEP: CapacityNeed = Object.freeze({
  durationMs: 3_600_000,
  cpuCores: 2,
  memoryMb: 4_096,
})

/** Nobody asks for more than four steps on one decision. */
export const MAX_SCALE_UP_STEPS = 4

/** A calendar window is a multi-day event; a deviation is an hour of weather. */
const PREDICTED_DURATION_MULTIPLIER = 4

function stepsOf(decision: ScaleUpDecision): number {
  const middle = decision.baselineMedian
  if (middle === undefined || middle <= 0) return 1
  // How many times over normal the load is, minus the one that was already
  // provisioned. `ceil` so a 1.6× rise still asks for something.
  const excess = Math.ceil(decision.observed / middle) - 1
  return Math.min(MAX_SCALE_UP_STEPS, Math.max(1, excess))
}

/**
 * Turn a decision into a resource ask.
 *
 * Refuses a suppressed decision rather than sizing it: a suppressed decision is
 * a record that nothing was done, and a caller that hands one to a provisioner
 * has a bug that should surface here and not as a machine nobody ordered.
 */
export function needFromDecision(decision: ScaleUpDecision): CapacityNeed {
  if (decision.kind === 'scale-up-suppressed') {
    throw new RangeError(
      `a suppressed decision (${decision.id}) asks for no capacity`,
    )
  }
  const steps = stepsOf(decision)
  return {
    durationMs:
      SCALE_UP_STEP.durationMs *
      (decision.kind === 'scale-up-predicted'
        ? PREDICTED_DURATION_MULTIPLIER
        : 1),
    cpuCores: SCALE_UP_STEP.cpuCores * steps,
    memoryMb: SCALE_UP_STEP.memoryMb * steps,
  }
}

/**
 * The M0 executor: write the decision to the capacity log and stop.
 *
 * `CapacityPlanner` already records every decision to its own log, so this is
 * for a caller that drives the planner and wants a *second* destination — a
 * per-run log it can assert against, or the trail sink. It records suppressed
 * decisions too, for the reason given in `audit.ts`.
 */
export function auditOnlyExecutor(log: CapacityAuditLog): ScaleUpExecutor {
  return (decision: ScaleUpDecision): void => {
    const event = eventOf(decision)
    log.record(event.type, event.at, event.detail)
  }
}
