// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type BackoffOptions, backoffMs } from './backoff.js'
import { type ScheduledJob, assertJob, dedupKeyOf } from './job.js'
import { planFire } from './reserve.js'
import type { FireOutcome, SchedulerStore } from './store.js'

/**
 * The runner: what turns a plan into a dispatch, and nothing else.
 *
 * ## This module never dials a node
 *
 * `dispatch` is an injected port and the whole of this package's contact with
 * the network is calling it. The runner hands over `{ job, fireAtMs, dedupKey,
 * attempt }`; the **host** builds the `task.request` envelope from that, and
 * only the host does, for two reasons that pull the same way:
 *
 * - Building an envelope means knowing about `@qianmo/protocol` message shapes,
 *   `@qianmo/transport` connections, node identity and PSKs. A scheduler that
 *   knew all of those could not be tested without a network, and the schedule
 *   arithmetic — the part that is actually hard — is what would stop being
 *   testable.
 * - The two protocol facts this deliverable turns on are *inputs* to that
 *   envelope, not outputs of it: `contextId = job.id` (§4.1 point 3, which is
 *   what keeps a watch job's seven days of context out of a human's
 *   conversation) and `taskTtlMs = job.taskTtlMs` (§4.1 point 4, not
 *   `LIMITS.defaultTaskTtlMs`). They travel in the dispatch input where the
 *   host cannot help but see them.
 *
 * ## There is no ticker here either
 *
 * `start()` arms **one** `setTimeout`, and the next one is armed only after a
 * run completes — the same discipline as `@qianmo/resident`'s poller, which
 * reschedules from completion and never replays missed ticks. `runDue(now)` is
 * public and is what the tests drive: no test in this package waits on a real
 * timer, because a scheduler whose tests take as long as its schedule is a
 * scheduler nobody will change.
 *
 * ## Absence is the failure mode this design chose
 *
 * Moving the timing to the hub (§4.1) means the hub is a single point for it —
 * design §3.A row A7 records that as a deliberate divergence, since the
 * alternative fallback, a ticker inside the node, would undo the freeze that
 * the whole arrangement exists to protect. The compensation is that absence has
 * to be *loud*: {@link SchedulerRunner.status} carries `lastTickAt` so the
 * console can say "last tick: N minutes ago" (§4.1 point 6). A scheduler that
 * is merely not running looks exactly like one with nothing to do, and only
 * that timestamp tells them apart.
 */

/** What the host is given to build one `task.request` from. */
export interface FireDispatch {
  readonly job: ScheduledJob
  /** The **scheduled** instant, not the wall clock. Half of the dedup key. */
  readonly fireAtMs: number
  /** `"<jobId>:<fireAtMs>"`. Built once, in `job.ts`. */
  readonly dedupKey: string
  /** 1 on a first try; `consecutiveFailures + 1` after failures. */
  readonly attempt: number
}

/**
 * The host's side of the wire.
 *
 * Resolving means the fire succeeded and the failure counter resets; throwing
 * means it did not and the backoff advances. Deliberately a throw rather than a
 * result object: a dispatch that fails in a way the port did not anticipate
 * throws anyway, and two ways to say "failed" is one way too many for the
 * branch that decides whether to keep retrying.
 */
export type SchedulerDispatch = (input: FireDispatch) => Promise<void>

export interface SchedulerJobStatus {
  readonly jobId: string
  /** Next instant this runner expects to act on, as of the last `runDue`. */
  readonly nextFireAt: number | undefined
  readonly consecutiveFailures: number
  readonly lastOutcome: FireOutcome | undefined
  readonly lastFiredAt: number | undefined
}

export interface SchedulerStatus {
  /** When `runDue` last ran. `undefined` means it never has. */
  readonly lastTickAt: number | undefined
  readonly jobs: readonly SchedulerJobStatus[]
}

export interface SchedulerRunnerOptions {
  readonly store: SchedulerStore
  readonly dispatch: SchedulerDispatch
  readonly jobs?: readonly unknown[]
  readonly now?: () => number
  /**
   * Asked before **every** fire (design §3.B6 names the scheduler's fire as one
   * of ESTOP's three checkpoints; the other two are on the node).
   *
   * A skip, not a stop: the timer keeps running and clearing the sentinel
   * resumes the schedule with nothing to restart. Nothing already dispatched is
   * touched — a turn in flight has a `task.result` owed to whoever is waiting
   * for it, and ESTOP is pause-new-work.
   *
   * A predicate that throws is read as "not paused" and reported, mirroring the
   * resident poller. The reliability kit fails open: a sentinel this runner
   * cannot evaluate must not be the thing that silently stops a week-long watch
   * job.
   */
  readonly paused?: () => boolean
  readonly onError?: (error: unknown) => void
  readonly backoff?: BackoffOptions
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
  /**
   * Ceiling on how far out `start()` will arm its single timer.
   *
   * Not a tick rate. It bounds how long a *newly registered job* or a stepped
   * clock waits to be noticed, which matters because the alternative — arming
   * for a daily job's full 24 hours — makes the hub deaf to its own operator
   * for a day. Every arm is still one-shot and still re-armed from completion;
   * the node is contacted only by a fire, never by this timer.
   */
  readonly maxDelayMs?: number
}

const DEFAULT_MAX_DELAY_MS = 60_000

function defaultSchedule(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class SchedulerRunner {
  readonly #options: SchedulerRunnerOptions
  readonly #store: SchedulerStore
  readonly #now: () => number
  readonly #maxDelayMs: number
  readonly #jobs = new Map<string, ScheduledJob>()
  readonly #nextFireAt = new Map<string, number>()
  #lastTickAt: number | undefined
  #running = false
  #inFlight = false
  #timer: { cancel(): void } | null = null

  constructor(options: SchedulerRunnerOptions) {
    this.#options = options
    this.#store = options.store
    this.#now = options.now ?? Date.now
    this.#maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    for (const job of options.jobs ?? []) this.register(job)
  }

  get lastTickAt(): number | undefined {
    return this.#lastTickAt
  }

  get jobs(): readonly ScheduledJob[] {
    return [...this.#jobs.values()]
  }

  /** Validate and take ownership of a job. Re-registering replaces it. */
  register(input: unknown): ScheduledJob {
    const job = assertJob(input)
    this.#jobs.set(job.id, job)
    // A newly registered job may already be due; re-arm rather than let it wait
    // out a timer that was computed without it.
    if (this.#running) this.#arm(0)
    return job
  }

  /**
   * Stop scheduling a job. Its durable state stays.
   *
   * Keeping it is what makes re-registering safe: a job removed and re-added
   * inside its own period must not get a second run of the slot it already
   * ran, and only the retained `lastFiredAt` (plus the claim) knows that.
   */
  unregister(jobId: string): void {
    this.#jobs.delete(jobId)
    this.#nextFireAt.delete(jobId)
  }

  status(): SchedulerStatus {
    return {
      lastTickAt: this.#lastTickAt,
      jobs: [...this.#jobs.values()].map(job => {
        const state = this.#store.stateOf(job.id)
        return {
          jobId: job.id,
          nextFireAt: this.#nextFireAt.get(job.id),
          consecutiveFailures: state.consecutiveFailures,
          lastOutcome: state.lastOutcome,
          lastFiredAt: state.lastFiredAt,
        }
      }),
    }
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#arm(0)
  }

  stop(): void {
    this.#running = false
    this.#timer?.cancel()
    this.#timer = null
  }

  get running(): boolean {
    return this.#running
  }

  /**
   * Act on everything due at `now`. The entire scheduling loop is this call.
   *
   * Single-flight: a second entry while one is in progress returns immediately
   * rather than queueing. Two overlapping passes would both plan from the same
   * pre-dispatch state, and while the claim store would still keep the fire
   * single, the loser would burn a claim and a state write for nothing.
   */
  async runDue(now: number): Promise<void> {
    if (this.#inFlight) return
    this.#inFlight = true
    // Stamped before the work, not after: a pass that throws is still evidence
    // the scheduler is alive, and `lastTickAt` is the console's liveness
    // signal (§4.1 point 6), not a success counter.
    this.#lastTickAt = now
    try {
      for (const job of [...this.#jobs.values()]) {
        await this.#runJob(job, now)
      }
    } finally {
      this.#inFlight = false
    }
  }

  async #runJob(job: ScheduledJob, now: number): Promise<void> {
    const state = this.#store.stateOf(job.id)
    const plan = planFire({ job, lastFiredAt: state.lastFiredAt, now })

    if (plan.kind === 'wait') {
      this.#nextFireAt.set(job.id, plan.fireAtMs)
      return
    }

    if (plan.kind === 'skip') {
      // Retiring the stale instant is what makes the loss final. Left
      // unrecorded it would be re-evaluated, re-judged stale and re-reported on
      // every pass for as long as the job exists.
      this.#store.recordFire(job.id, plan.staleFireAtMs, 'skipped')
      this.#nextFireAt.set(job.id, plan.fireAtMs)
      return
    }

    // Backoff is a hold, not a reschedule: the grid keeps its phase and the
    // failing job simply lets instants go by until its penalty is served. The
    // alternative — moving the next instant — would leave a job that failed
    // once permanently out of step with the schedule someone wrote down.
    const holdUntil =
      (state.lastOutcomeAt ?? 0) +
      backoffMs(state.consecutiveFailures, this.#options.backoff)
    if (state.consecutiveFailures > 0 && now < holdUntil) {
      this.#nextFireAt.set(job.id, holdUntil)
      return
    }

    if (this.#paused()) {
      // No claim is taken. A paused hub must leave the slot open for whoever
      // is running when the brake comes off, and a claim taken now would
      // suppress that run without anything ever having happened.
      this.#nextFireAt.set(job.id, plan.fireAtMs)
      return
    }

    if (!this.#store.claim(job.id, plan.fireAtMs)) {
      // Someone else owns this instant — a second console, or this one before
      // a restart that lost its state file. Retire it locally so this runner
      // moves on instead of losing the same race on every pass.
      this.#store.recordFire(job.id, plan.fireAtMs, 'preempted')
      this.#nextFireAt.set(job.id, plan.fireAtMs + job.schedule.everyMs)
      return
    }

    const attempt = state.consecutiveFailures + 1
    let outcome: FireOutcome = 'completed'
    try {
      await this.#options.dispatch({
        job,
        fireAtMs: plan.fireAtMs,
        dedupKey: dedupKeyOf(job.id, plan.fireAtMs),
        attempt,
      })
    } catch (error) {
      outcome = 'failed'
      this.#options.onError?.(error)
    }
    this.#store.recordFire(job.id, plan.fireAtMs, outcome)
    this.#store.pruneClaims(job.id, job.schedule.everyMs)
    this.#nextFireAt.set(job.id, plan.fireAtMs + job.schedule.everyMs)
  }

  /** Fail-open evaluation of {@link SchedulerRunnerOptions.paused}. */
  #paused(): boolean {
    try {
      return this.#options.paused?.() ?? false
    } catch (error) {
      this.#options.onError?.(error)
      return false
    }
  }

  #arm(delayMs: number): void {
    if (!this.#running) return
    this.#timer?.cancel()
    const schedule = this.#options.schedule ?? defaultSchedule
    this.#timer = schedule(delayMs, () => {
      this.#timer = null
      void this.#tick()
    })
  }

  async #tick(): Promise<void> {
    try {
      await this.runDue(this.#now())
    } catch (error) {
      this.#options.onError?.(error)
    } finally {
      // Re-armed from completion, once, with the delay the plans just produced.
      this.#arm(this.#nextDelayMs())
    }
  }

  #nextDelayMs(): number {
    const now = this.#now()
    let soonest = Number.POSITIVE_INFINITY
    for (const at of this.#nextFireAt.values()) {
      soonest = Math.min(soonest, Math.max(0, at - now))
    }
    if (!Number.isFinite(soonest)) return this.#maxDelayMs
    return Math.min(soonest, this.#maxDelayMs)
  }
}
