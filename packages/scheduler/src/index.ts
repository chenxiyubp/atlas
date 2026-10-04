// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/scheduler` — the hub holds the timing so the node holds none.
 *
 * This package runs inside `qm console` (design `resident-botization.md` §4.1).
 * It decides *when* a watch job fires and hands the fire to an injected port; it
 * does not build protocol envelopes, open connections, or know that a transport
 * exists. Its only dependency is `@qianmo/protocol`, for `LIMITS` and address
 * validation, and that is the shape of the boundary: schedule arithmetic on one
 * side, the network on the other.
 *
 * Three properties are the reason it exists, and each of them is a `test/` file:
 *
 * - **No ticker anywhere.** One-shot reservations, re-armed after each completed
 *   fire. A periodic wake-up on the node would keep the node from ever being
 *   idle, therefore from ever freezing, which is the sleep charter R-3 asks for
 *   (hermes A6, and A7's deliberate divergence: there is no node-side fallback
 *   ticker, on purpose).
 * - **At most once, across processes.** `dedupKey = "<jobId>:<fireAtMs>"` plus
 *   an `O_EXCL` claim file, so a second `qm console` started by an operator at
 *   3 a.m. loses every race rather than doubling every side effect (F7).
 * - **Catch-up collapses.** Five periods of downtime produce one make-up run,
 *   and the four discarded slots are counted rather than forgotten.
 */

export {
  NOTIFY_POLICIES,
  assertJob,
  dedupKeyOf,
  type JobSchedule,
  type NotifyPolicy,
  type ScheduledJob,
} from './job.js'

export {
  DEFAULT_BACKOFF,
  backoffMs,
  type BackoffOptions,
} from './backoff.js'

export {
  MAX_CATCH_UP_GRACE_MS,
  MIN_CATCH_UP_GRACE_MS,
  catchUpGraceMs,
  planFire,
  type FireNowPlan,
  type FirePlan,
  type PlanFireInput,
  type SkipPlan,
  type WaitPlan,
} from './reserve.js'

export {
  MAX_CLAIMS_PER_JOB,
  MIN_CLAIM_RETENTION_MS,
  SchedulerStore,
  claimRetentionMs,
  type FireOutcome,
  type JobState,
  type SchedulerStoreOptions,
} from './store.js'

export {
  SchedulerRunner,
  type FireDispatch,
  type SchedulerDispatch,
  type SchedulerJobStatus,
  type SchedulerRunnerOptions,
  type SchedulerStatus,
} from './fire.js'
