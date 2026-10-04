// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The contest calendar — dates somebody wrote down, not dates anybody inferred.
 *
 * This is the whole of path A's "prediction": a window with a start time and a
 * ramp, and arithmetic on the two. The lead time it produces comes from the
 * calendar entry itself. Nothing here estimates when a contest will happen, and
 * the honest description of the mechanism is *read the calendar and start
 * early* — see the package header for why that distinction is written down
 * rather than left to the reader.
 *
 * ## The seed data is a modelling assumption
 *
 * `CUMCM_2026` below carries plausible dates and a plausible ramp. They are
 * **not** an authoritative schedule: the official one is published each year by
 * the organising committee and the numbers here have not been checked against
 * it. Anything that needs the real dates loads them through
 * {@link calendarFromEntries}; the seed exists so the replay tests have a window
 * to aim at.
 */

/** One period the operator expects to be busy. */
export interface CompetitionWindow {
  /** Stable id — the once-per-window rule keys on it. */
  readonly id: string
  readonly name: string
  /** Epoch ms at which the load is expected to start. */
  readonly startAt: number
  /** Epoch ms after which it is expected to be over. */
  readonly endAt: number
  /**
   * How far ahead of `startAt` capacity should already be in place. Optional:
   * a calendar that says nothing about ramp falls back to the policy default.
   */
  readonly rampBeforeMs?: number
}

/** What a calendar file, a registry row or a hand-written literal looks like. */
export interface CalendarEntryLike {
  readonly id?: string | undefined
  readonly name?: string | undefined
  /** Epoch ms or an ISO 8601 timestamp. */
  readonly startAt: number | string
  readonly endAt: number | string
  readonly rampBeforeMs?: number | undefined
}

function instantOf(value: number | string, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`calendar ${field} must be a finite epoch ms`)
    }
    return value
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new RangeError(`calendar ${field} is not an ISO timestamp: ${value}`)
  }
  return parsed
}

/**
 * A read-only view over the windows, sorted by start.
 *
 * Deliberately not a store: nothing here loads, watches or writes a file. The
 * calendar is data somebody hands in, and where it comes from is the caller's
 * problem — which keeps this package at zero dependencies.
 */
export class CompetitionCalendar {
  readonly #windows: readonly CompetitionWindow[]

  constructor(windows: readonly CompetitionWindow[] = []) {
    for (const window of windows) {
      if (!(window.endAt > window.startAt)) {
        throw new RangeError(
          `window ${window.id} ends at or before it starts (${window.startAt} → ${window.endAt})`,
        )
      }
      if (window.rampBeforeMs !== undefined && window.rampBeforeMs < 0) {
        throw new RangeError(`window ${window.id} has a negative ramp`)
      }
    }
    const ids = new Set(windows.map(window => window.id))
    if (ids.size !== windows.length) {
      throw new RangeError('calendar window ids must be unique')
    }
    this.#windows = [...windows].sort((a, b) => a.startAt - b.startAt)
  }

  /** Every window, earliest first. */
  all(): readonly CompetitionWindow[] {
    return this.#windows
  }

  /** The window covering `at`, if any. */
  activeAt(at: number): CompetitionWindow | undefined {
    return this.#windows.find(
      window => at >= window.startAt && at <= window.endAt,
    )
  }

  /**
   * Windows whose ramp is reachable from `at` within `horizonMs`, and which
   * have not already finished.
   *
   * The test is `at + horizonMs >= startAt - ramp`: the planner is asking
   * "looking `horizonMs` ahead from this bucket, am I already inside the ramp
   * of something?". The `at <= endAt` half is what stops a calendar full of
   * last year's contests from arming everything at once.
   */
  armedAt(
    at: number,
    horizonMs: number,
    defaultRampBeforeMs: number,
  ): readonly CompetitionWindow[] {
    return this.#windows.filter(window => {
      const ramp = rampOf(window, defaultRampBeforeMs)
      return at + horizonMs >= window.startAt - ramp && at <= window.endAt
    })
  }
}

/** A window's ramp, or the policy default when the entry did not say. */
export function rampOf(
  window: CompetitionWindow,
  defaultRampBeforeMs: number,
): number {
  return window.rampBeforeMs ?? defaultRampBeforeMs
}

/**
 * The span the planner treats as "inside the window": from the moment the ramp
 * opens to the moment the contest is over.
 *
 * Used by the suppressor. The ramp is included because the load starts rising
 * before the gun does, and a reactive trigger fired at 17:45 for a contest that
 * starts at 18:00 is the same decision path A already made.
 */
export function windowSpan(
  window: CompetitionWindow,
  defaultRampBeforeMs: number,
): { readonly from: number; readonly to: number } {
  return {
    from: window.startAt - rampOf(window, defaultRampBeforeMs),
    to: window.endAt,
  }
}

/** Build a calendar from loosely-typed entries, refusing the malformed ones. */
export function calendarFromEntries(
  entries: readonly CalendarEntryLike[],
): CompetitionCalendar {
  return new CompetitionCalendar(
    entries.map((entry, index) => {
      const startAt = instantOf(entry.startAt, 'startAt')
      const endAt = instantOf(entry.endAt, 'endAt')
      const id = entry.id ?? `window-${index + 1}`
      return {
        id,
        name: entry.name ?? id,
        startAt,
        endAt,
        ...(entry.rampBeforeMs === undefined
          ? {}
          : { rampBeforeMs: entry.rampBeforeMs }),
      }
    }),
  )
}

/**
 * CUMCM — the national undergraduate mathematical contest in modeling, the one
 * scenario P2.4 wrote down.
 *
 * **The numbers below are a modelling assumption, not a historical record.**
 * Three days beginning at 18:00 Beijing time in mid-September, and six hours of
 * ramp before it, are what the scenario document assumes; the committee
 * publishes the real dates and nobody has checked these against them. They are
 * here so a replay has a window to aim at, and any deployment that cares loads
 * its own through {@link calendarFromEntries}.
 */
export const CUMCM_2026: CompetitionWindow = Object.freeze({
  id: 'cumcm-2026',
  name: 'CUMCM 2026 (assumed schedule)',
  // 2026-09-10T18:00+08:00 → 72 h → 2026-09-13T18:00+08:00.
  startAt: Date.UTC(2026, 8, 10, 10, 0, 0),
  endAt: Date.UTC(2026, 8, 13, 10, 0, 0),
  rampBeforeMs: 6 * 3_600_000,
})

/** The seeded calendar: one window, and it is an assumption. */
export function seedCalendar(): CompetitionCalendar {
  return new CompetitionCalendar([CUMCM_2026])
}
