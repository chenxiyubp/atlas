// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The trigger: two paths in, one stream of decisions out.
 *
 * ## A bucket pusher, not a scheduler
 *
 * `observe()` takes a bucket and returns what it decided about that bucket. It
 * arms no timer, subscribes to nothing, and never calls `Date.now()` — every
 * instant it reasons about arrives as an argument. `@qianmo/transport`'s
 * `ReconnectSchedule` made the same choice for the same reason, and stated it
 * best: *all time arrives as an argument, which is what makes a 30 s outage
 * testable in microseconds*. Here it is what makes seven days of replay finish
 * in a millisecond, and what makes "would this have fired 30 minutes early?" a
 * question with one answer rather than a question about when the test ran.
 *
 * ## Path A — the calendar
 *
 * A window is armed when `at + horizonMs >= startAt - rampBeforeMs`. Every
 * millisecond of the lead time comes from `rampBeforeMs`, which is a number a
 * human wrote on a calendar entry. **This is arithmetic on a date somebody
 * typed in, not a forecast** — see the package header.
 *
 * ## Path B — deviation from the slot baseline
 *
 * Three conditions, all of them, for `consecutiveBuckets` in a row:
 *
 * 1. `value > median + zScore × 1.4826 × MAD`, and
 * 2. `value > median × minRatio`, and
 * 3. the slot has at least `minBaselineSamples` weeks behind it.
 *
 * Condition 2 is not redundant, and it is the one that earns its keep. When a
 * slot's history is constant — a quiet weekend hour that reads exactly 4 every
 * week, or any freshly-restarted node — the MAD is **zero**, the whole
 * `z × 1.4826 × MAD` term collapses, and condition 1 degenerates into
 * `value > median`: a single extra task becomes an infinite z-score and the
 * planner scales up because Sunday had five tasks instead of four. The ratio
 * floor is a statement in units nobody can argue with — half again as much as
 * normal — and it is what keeps the flat-load false-positive budget intact.
 *
 * ## Suppression
 *
 * Two rules, and both write a record rather than staying silent. An audit that
 * shows no trigger cannot distinguish "nothing happened" from "the planner
 * wanted to and was stopped", and P6.2's second DoD criterion is a claim about
 * the first of those.
 */

import {
  CapacityAuditLog,
  CapacityEventType,
  type CapacityEvent,
} from './audit.js'
import { mad, median, slotOfWeek } from './baseline.js'
import {
  CompetitionCalendar,
  windowSpan,
  type CompetitionWindow,
} from './calendar.js'
import {
  CAPACITY_POLICY_VERSION,
  DEFAULT_CAPACITY_POLICY,
  type CapacityPolicy,
} from './policy.js'
import { loadOf, type UsageSample } from './usage.js'

/** Makes the MAD a consistent estimator of σ for normally distributed data. */
export const MAD_TO_SIGMA = 1.4826

/** What came out: two of them are actions, one is a record of inaction. */
export type ScaleUpKind =
  | 'scale-up-predicted'
  | 'scale-up-reactive'
  | 'scale-up-suppressed'

/** Which of the two paths produced the decision. */
export type ScaleUpPath = 'calendar' | 'baseline'

/** Why, in one word: the path that fired, or the rule that stopped it. */
export type ScaleUpReason =
  | 'calendar-window'
  | 'baseline-deviation'
  | 'cooldown'
  | 'covered-by-calendar'

export interface ScaleUpDecision {
  readonly id: string
  readonly kind: ScaleUpKind
  /** Start of the bucket that produced the decision, epoch ms. */
  readonly at: number
  /** For a suppressed decision, the path that was held back. */
  readonly path: ScaleUpPath
  readonly reason: ScaleUpReason
  /** The load the decision was made on. */
  readonly observed: number
  /**
   * `window.startAt - at` for the calendar path — the DoD's "how early".
   * Zero on the baseline path, and honestly so: a deviation is noticed while
   * it is happening, so the lead on a reactive trigger is nothing.
   */
  readonly leadMs: number
  readonly windowId?: string
  readonly baselineMedian?: number
  readonly baselineMad?: number
  /**
   * Robust z of the observation, present only when it is a finite number. A
   * slot whose MAD is zero has no scale to divide by; the record leaves the
   * field off rather than writing a sentinel that reads like a measurement.
   */
  readonly zScore?: number
  readonly consecutive?: number
}

const EVENT_TYPES: Readonly<Record<ScaleUpKind, CapacityEventType>> =
  Object.freeze({
    'scale-up-predicted': CapacityEventType.Predicted,
    'scale-up-reactive': CapacityEventType.Reactive,
    'scale-up-suppressed': CapacityEventType.Suppressed,
  })

/** The audit detail of one decision. Scalars only — the trail carries no more. */
export function detailOf(
  decision: ScaleUpDecision,
): Readonly<Record<string, string | number | boolean>> {
  return {
    decisionId: decision.id,
    path: decision.path,
    reason: decision.reason,
    observed: decision.observed,
    leadMs: decision.leadMs,
    bucketAt: decision.at,
    policyVersion: CAPACITY_POLICY_VERSION,
    ...(decision.windowId === undefined ? {} : { windowId: decision.windowId }),
    ...(decision.baselineMedian === undefined
      ? {}
      : { baselineMedian: decision.baselineMedian }),
    ...(decision.baselineMad === undefined
      ? {}
      : { baselineMad: decision.baselineMad }),
    ...(decision.zScore === undefined ? {} : { zScore: decision.zScore }),
    ...(decision.consecutive === undefined
      ? {}
      : { consecutive: decision.consecutive }),
  }
}

/** The event a decision becomes on the way to the trail. */
export function eventOf(decision: ScaleUpDecision): CapacityEvent {
  return {
    type: EVENT_TYPES[decision.kind],
    at: decision.at,
    detail: detailOf(decision),
  }
}

export interface CapacityPlannerOptions {
  readonly policy?: CapacityPolicy
  readonly calendar?: CompetitionCalendar
  /** Where decisions are written. One is made if none is supplied. */
  readonly audit?: CapacityAuditLog
  /**
   * Decision ids. Injectable so a replay produces the same ids twice —
   * `negotiation`'s tests inject a counter for the same reason.
   */
  readonly nextId?: () => string
}

export class CapacityPlanner {
  readonly #policy: CapacityPolicy
  readonly #calendar: CompetitionCalendar
  readonly #audit: CapacityAuditLog
  readonly #nextId: () => string

  /** value history per slot of week, oldest first. */
  readonly #history = new Map<number, number[]>()
  readonly #firedWindows = new Set<string>()
  readonly #notedWindows = new Set<string>()
  readonly #lastFired = new Map<ScaleUpKind, number>()
  #streak = 0
  #lastAt: number | null = null
  #counter = 0

  constructor(options: CapacityPlannerOptions = {}) {
    this.#policy = options.policy ?? DEFAULT_CAPACITY_POLICY
    this.#calendar = options.calendar ?? new CompetitionCalendar()
    this.#audit = options.audit ?? new CapacityAuditLog()
    this.#nextId = options.nextId ?? (() => `capacity-${++this.#counter}`)
  }

  get policy(): CapacityPolicy {
    return this.#policy
  }

  get audit(): CapacityAuditLog {
    return this.#audit
  }

  /**
   * Push one bucket through both paths.
   *
   * Buckets must arrive in order. A sample that predates the last one is
   * refused loudly rather than folded in: the baseline is built from history
   * that is strictly older than the sample being judged, and quietly accepting
   * an out-of-order bucket would let a future value into its own baseline —
   * a detector that has already seen the answer.
   */
  observe(sample: UsageSample): readonly ScaleUpDecision[] {
    if (!Number.isFinite(sample.at)) {
      throw new RangeError(`sample.at must be a finite epoch ms: ${sample.at}`)
    }
    if (this.#lastAt !== null && sample.at <= this.#lastAt) {
      throw new RangeError(
        `usage buckets must advance: got ${sample.at} after ${this.#lastAt}`,
      )
    }
    this.#lastAt = sample.at

    const value = loadOf(sample)
    const decisions: ScaleUpDecision[] = []
    this.#calendarPath(sample.at, value, decisions)
    this.#baselinePath(sample.at, value, decisions)

    // History last, and unconditionally. Contest weeks belong in the baseline —
    // that is exactly the contamination the median and MAD were chosen to
    // survive (see `baseline.ts`), and dropping them would be the planner
    // curating its own evidence.
    const slot = slotOfWeek(sample.at, this.#policy.bucketMs)
    const values = this.#history.get(slot)
    if (values === undefined) this.#history.set(slot, [value])
    else values.push(value)

    return decisions
  }

  #emit(decisions: ScaleUpDecision[], decision: ScaleUpDecision): void {
    decisions.push(decision)
    const event = eventOf(decision)
    this.#audit.record(event.type, event.at, event.detail)
  }

  #cooledDown(kind: ScaleUpKind, at: number): boolean {
    const last = this.#lastFired.get(kind)
    return last === undefined || at - last >= this.#policy.cooldownMs
  }

  #calendarPath(at: number, value: number, decisions: ScaleUpDecision[]): void {
    const armed = this.#calendar.armedAt(
      at,
      this.#policy.horizonMs,
      this.#policy.defaultRampBeforeMs,
    )
    for (const window of armed) {
      // One scale-up per window. A contest is one event however many buckets
      // it spans, and a trigger per bucket for 72 hours is not a decision, it
      // is a stuck bit.
      if (this.#firedWindows.has(window.id)) continue
      const leadMs = window.startAt - at
      if (!this.#cooledDown('scale-up-predicted', at)) {
        // Noted once per window: the second "still cooling down" line says
        // nothing the first did not, and the window stays un-fired so it gets
        // its capacity when the cooldown lapses.
        if (!this.#notedWindows.has(window.id)) {
          this.#notedWindows.add(window.id)
          this.#emit(decisions, {
            id: this.#nextId(),
            kind: 'scale-up-suppressed',
            at,
            path: 'calendar',
            reason: 'cooldown',
            observed: value,
            leadMs,
            windowId: window.id,
          })
        }
        continue
      }
      this.#firedWindows.add(window.id)
      this.#lastFired.set('scale-up-predicted', at)
      this.#emit(decisions, {
        id: this.#nextId(),
        kind: 'scale-up-predicted',
        at,
        path: 'calendar',
        reason: 'calendar-window',
        observed: value,
        leadMs,
        windowId: window.id,
      })
    }
  }

  #baselinePath(at: number, value: number, decisions: ScaleUpDecision[]): void {
    const slot = slotOfWeek(at, this.#policy.bucketMs)
    const history = this.#history.get(slot) ?? []
    if (history.length < this.#policy.minBaselineSamples) {
      // A cold slot abstains out loud in the code and silently in the trail:
      // "we do not know yet" is not a decision, and a record of it every 15
      // minutes for the first two weeks would bury the ones that are.
      this.#streak = 0
      return
    }

    const middle = median(history)
    const spread = mad(history, middle)
    const sigma = MAD_TO_SIGMA * spread
    const deviates =
      value > middle + this.#policy.zScore * sigma &&
      value > middle * this.#policy.minRatio
    this.#streak = deviates ? this.#streak + 1 : 0
    if (this.#streak < this.#policy.consecutiveBuckets) return

    const z = sigma > 0 ? (value - middle) / sigma : undefined
    const stats = {
      observed: value,
      leadMs: 0,
      baselineMedian: middle,
      baselineMad: spread,
      consecutive: this.#streak,
      ...(z === undefined || !Number.isFinite(z) ? {} : { zScore: z }),
    }

    const covering = this.#coveringWindow(at)
    if (covering !== undefined) {
      // Path A already bought capacity for this window; path B is looking at
      // the load path A predicted. Once per window is enough to show that the
      // reactive detector agreed.
      if (!this.#notedWindows.has(`baseline:${covering.id}`)) {
        this.#notedWindows.add(`baseline:${covering.id}`)
        this.#emit(decisions, {
          id: this.#nextId(),
          kind: 'scale-up-suppressed',
          at,
          path: 'baseline',
          reason: 'covered-by-calendar',
          windowId: covering.id,
          ...stats,
        })
      }
      this.#streak = 0
      return
    }

    if (!this.#cooledDown('scale-up-reactive', at)) {
      this.#emit(decisions, {
        id: this.#nextId(),
        kind: 'scale-up-suppressed',
        at,
        path: 'baseline',
        reason: 'cooldown',
        ...stats,
      })
      this.#streak = 0
      return
    }

    this.#lastFired.set('scale-up-reactive', at)
    this.#streak = 0
    this.#emit(decisions, {
      id: this.#nextId(),
      kind: 'scale-up-reactive',
      at,
      path: 'baseline',
      reason: 'baseline-deviation',
      ...stats,
    })
  }

  /** A window path A has already acted on, whose span covers `at`. */
  #coveringWindow(at: number): CompetitionWindow | undefined {
    return this.#calendar.all().find(window => {
      if (!this.#firedWindows.has(window.id)) return false
      const span = windowSpan(window, this.#policy.defaultRampBeforeMs)
      return at >= span.from && at <= span.to
    })
  }
}
