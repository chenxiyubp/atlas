// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/capacity` — deciding to scale up before the load arrives (P6.2).
 *
 * Two paths, and the difference between them matters more than either.
 *
 * **Path A reads a calendar.** The lead time it produces — the thirty-plus
 * minutes P6.2's DoD asks for — comes from `rampBeforeMs` on a calendar entry
 * a human typed in. There is no forecast, no extrapolation and no learned
 * arrival time: the mechanism is *read the calendar, subtract the ramp, act
 * early*, and arithmetic on a date is all it is. This is written down here
 * because "predictive scaling" is exactly the phrase that invites a reader — or
 * a slide — to hear "a model predicted the peak". It did not. Charter §5.8's
 * discipline about what we claim applies to our own capabilities, not only to
 * the base's provenance: the honest description of path A is the one above, and
 * it is the one to use externally.
 *
 * **Path B reads history.** Median and MAD per slot of the week, a deviation
 * test with a ratio floor, and a run-length requirement. Also not a model: no
 * training, no weights, no inference, and the same input gives the same output
 * on any machine. AC-5's model-neutrality and the auditability the whole trail
 * rests on both want it that way — a decision an operator cannot re-derive by
 * hand is a decision they cannot argue with.
 *
 * **Nothing here provisions anything.** Charter N-7 keeps real elastic capacity
 * out of M0; a decision's whole effect is a line in the audit trail. See
 * `executor.ts` for where the other half will attach.
 */

export {
  CapacityAuditLog,
  CapacityEventType,
  type CapacityAuditSink,
  type CapacityEvent,
} from './audit.js'

export {
  buildBaseline,
  mad,
  median,
  slotOfWeek,
  slotsPerWeek,
  type Baseline,
  type BaselineSlot,
} from './baseline.js'

export {
  CUMCM_2026,
  CompetitionCalendar,
  calendarFromEntries,
  rampOf,
  seedCalendar,
  windowSpan,
  type CalendarEntryLike,
  type CompetitionWindow,
} from './calendar.js'

export {
  MAX_SCALE_UP_STEPS,
  SCALE_UP_STEP,
  auditOnlyExecutor,
  needFromDecision,
  type CapacityNeed,
  type ScaleUpExecutor,
} from './executor.js'

export {
  CapacityPlanner,
  MAD_TO_SIGMA,
  detailOf,
  eventOf,
  type CapacityPlannerOptions,
  type ScaleUpDecision,
  type ScaleUpKind,
  type ScaleUpPath,
  type ScaleUpReason,
} from './planner.js'

export {
  CAPACITY_POLICY_VERSION,
  DEFAULT_CAPACITY_POLICY,
  type CapacityPolicy,
} from './policy.js'

export {
  contestFactor,
  makeSeries,
  type SyntheticShape,
  type SyntheticSpec,
} from './synthetic.js'

export {
  DEFAULT_BUCKET_MS,
  MESSAGE_ACCEPTED_KIND,
  foldTrailToBuckets,
  loadOf,
  type FoldOptions,
  type UsageRecordLike,
  type UsageSample,
} from './usage.js'
