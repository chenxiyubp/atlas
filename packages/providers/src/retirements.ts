// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Model retirement table (§4.6).
 *
 * A node whose model enters the 14-day window reports `retiring-model`; past
 * the date the compiler refuses to deliver it (`retired-model`). Entries are
 * keyed by the exact wire id, which is only safe because every id listed here
 * is vendor-unique — an id that two vendors share needs a host scope first.
 *
 * Someone has to keep this current (§12 「下线表要有人维护」): it records what
 * the vendor pages said on `verifiedAt`, nothing more.
 */

export type Retirement = {
  modelId: string
  vendor: string
  /** ISO 8601 with offset — the vendor's own wall-clock time. */
  retireAt: string
  /** Suggested replacements, best first. Empty when the vendor names none. */
  replacements: readonly string[]
  source: { url: string; verifiedAt: string }
  note?: string
}

export const RETIRING_WINDOW_DAYS = 14

const MIMO_DEPRECATION_PAGE =
  'https://mimo.mi.com/static/docs/updates/deprecate.md'

export const RETIREMENTS: readonly Retirement[] = [
  {
    modelId: 'mimo-v2.5-pro',
    vendor: '小米 MiMo',
    retireAt: '2026-10-21T10:00:00+08:00',
    replacements: ['mimo-v2.6-pro'],
    source: { url: MIMO_DEPRECATION_PAGE, verifiedAt: '2026-10-03' },
    note: '厂商原文：没有系统替换模型，到期直接下线',
  },
  {
    modelId: 'mimo-v2.5',
    vendor: '小米 MiMo',
    retireAt: '2026-10-21T10:00:00+08:00',
    replacements: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    source: { url: MIMO_DEPRECATION_PAGE, verifiedAt: '2026-10-03' },
    note: '厂商原文：没有系统替换模型，到期直接下线',
  },
  {
    modelId: 'mimo-v2-flash',
    vendor: '小米 MiMo',
    retireAt: '2026-06-30T00:00:00+08:00',
    replacements: ['mimo-v2.6-flash'],
    source: { url: MIMO_DEPRECATION_PAGE, verifiedAt: '2026-10-03' },
    note: '厂商页面只写了日期 2026-06-30，没写时刻，这里取当日 00:00 北京时间',
  },
]

export function retirementOf(modelId: string): Retirement | undefined {
  return RETIREMENTS.find(entry => entry.modelId === modelId)
}

export type RetirementStatus = 'active' | 'retiring' | 'retired'

/** `retireAt` may come from the table or from a model entry's own field. */
export function retirementStatusAt(
  retireAt: string | undefined,
  now: Date,
): RetirementStatus {
  if (retireAt === undefined) return 'active'
  const at = Date.parse(retireAt)
  if (Number.isNaN(at)) return 'active'
  const remaining = at - now.getTime()
  if (remaining <= 0) return 'retired'
  return remaining <= RETIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ? 'retiring'
    : 'active'
}

/**
 * Status of a model id at `now`. A model entry may carry its own `retireAt`
 * (a date the table does not have yet); when both exist, the EARLIER one
 * applies, so a profile can never postpone a retirement the table records.
 */
export function modelRetirementStatus(
  modelId: string,
  now: Date,
  ownRetireAt?: string,
): RetirementStatus {
  const tableAt = retirementOf(modelId)?.retireAt
  const candidates = [tableAt, ownRetireAt].filter(
    (value): value is string =>
      value !== undefined && !Number.isNaN(Date.parse(value)),
  )
  if (candidates.length === 0) return 'active'
  const earliest = candidates.reduce((a, b) =>
    Date.parse(a) <= Date.parse(b) ? a : b,
  )
  return retirementStatusAt(earliest, now)
}
