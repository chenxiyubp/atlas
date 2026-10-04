// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The calendar, which is where path A's entire "prediction" comes from.
 *
 * Every one of these cases is arithmetic on dates somebody typed in. That is
 * the point: if the lead time P6.2 claims were coming from anywhere else, it
 * would not be checkable this cheaply.
 */

import { describe, expect, test } from 'bun:test'
import {
  CUMCM_2026,
  CompetitionCalendar,
  calendarFromEntries,
  rampOf,
  seedCalendar,
  windowSpan,
  type CompetitionWindow,
} from '../src/index.js'

const HOUR = 3_600_000
const MINUTE = 60_000
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0)

function window(overrides: Partial<CompetitionWindow> = {}): CompetitionWindow {
  return {
    id: 'w-1',
    name: 'a window',
    startAt: T0 + 24 * HOUR,
    endAt: T0 + 27 * HOUR,
    ...overrides,
  }
}

describe('building a calendar', () => {
  test('entries accept ISO strings and epoch milliseconds alike', () => {
    const calendar = calendarFromEntries([
      {
        id: 'iso',
        startAt: '2026-09-10T10:00:00.000Z',
        endAt: '2026-09-13T10:00:00.000Z',
      },
      { id: 'epoch', startAt: T0, endAt: T0 + HOUR },
    ])
    const [first, second] = calendar.all()
    // Sorted by start, so the June one comes first however it was written.
    expect(first?.id).toBe('epoch')
    expect(second?.startAt).toBe(Date.parse('2026-09-10T10:00:00.000Z'))
  })

  test('an entry with no id still gets a stable one', () => {
    const calendar = calendarFromEntries([{ startAt: T0, endAt: T0 + HOUR }])
    expect(calendar.all()[0]?.id).toBe('window-1')
    expect(calendar.all()[0]?.name).toBe('window-1')
  })

  test('a window that ends before it starts is refused, not sorted away', () => {
    expect(() =>
      calendarFromEntries([{ id: 'bad', startAt: T0 + HOUR, endAt: T0 }]),
    ).toThrow('ends at or before it starts')
  })

  test('an unparseable timestamp is refused rather than becoming NaN', () => {
    expect(() =>
      calendarFromEntries([{ startAt: 'next september', endAt: T0 }]),
    ).toThrow('not an ISO timestamp')
  })

  test('duplicate ids are refused: the once-per-window rule keys on them', () => {
    expect(
      () => new CompetitionCalendar([window({ id: 'w' }), window({ id: 'w' })]),
    ).toThrow('unique')
  })
})

describe('arming a window', () => {
  test('the ramp, not the horizon, is what makes the lead time', () => {
    const calendar = new CompetitionCalendar([
      window({ rampBeforeMs: 6 * HOUR }),
    ])
    const start = T0 + 24 * HOUR
    const horizon = 45 * MINUTE
    // Armed from `startAt - ramp - horizon` onwards, and not a bucket earlier.
    expect(
      calendar.armedAt(start - 6 * HOUR - horizon, horizon, 0),
    ).toHaveLength(1)
    expect(
      calendar.armedAt(start - 6 * HOUR - horizon - 1, horizon, 0),
    ).toHaveLength(0)
  })

  test('a window with no ramp of its own falls back to the policy default', () => {
    const bare = window()
    expect(rampOf(bare, 2 * HOUR)).toBe(2 * HOUR)
    expect(rampOf(window({ rampBeforeMs: 0 }), 2 * HOUR)).toBe(0)
  })

  test('a window that is already over arms nothing', () => {
    const calendar = new CompetitionCalendar([window()])
    expect(
      calendar.armedAt(T0 + 28 * HOUR, 45 * MINUTE, 6 * HOUR),
    ).toHaveLength(0)
    expect(calendar.activeAt(T0 + 25 * HOUR)?.id).toBe('w-1')
    expect(calendar.activeAt(T0 + 28 * HOUR)).toBeUndefined()
  })

  test('the suppression span opens with the ramp and closes with the contest', () => {
    const span = windowSpan(window({ rampBeforeMs: 3 * HOUR }), 6 * HOUR)
    expect(span.from).toBe(T0 + 21 * HOUR)
    expect(span.to).toBe(T0 + 27 * HOUR)
  })
})

describe('the seeded calendar', () => {
  test('it holds CUMCM and nothing else', () => {
    const windows = seedCalendar().all()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.id).toBe('cumcm-2026')
  })

  test('the seeded schedule is 72 hours with a six-hour ramp', () => {
    // These numbers are a modelling assumption and the name says so — the test
    // pins the shape the replays were written against, not a historical fact.
    expect(CUMCM_2026.endAt - CUMCM_2026.startAt).toBe(72 * HOUR)
    expect(CUMCM_2026.rampBeforeMs).toBe(6 * HOUR)
    expect(CUMCM_2026.name).toContain('assumed')
  })
})
