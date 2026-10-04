// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { buildAc6bReport, type Ac6bObservations } from './ac6b-report-core.js'

function observations(
  overrides: {
    restore?: Partial<Ac6bObservations['restore']>
    protection?: Partial<Ac6bObservations['protection']>
  } = {},
): Ac6bObservations {
  return {
    restore: {
      deleted: true,
      restoredAt: true,
      elapsedMs: 20,
      budgetMs: 600_000,
      statusIdentical: true,
      statusLines: 3,
      headIdentical: true,
      execBitPreserved: true,
      ...overrides.restore,
    },
    protection: {
      removalStatuses: [405, 405, 405, 405],
      listStatus: 403,
      readStatus: 403,
      mutationDenied: 4,
      readDenied: 2,
      snapshotSurvives: true,
      ...overrides.protection,
    },
  }
}

describe('AC-6(b)(c) report', () => {
  test('passes only when every judgement holds', () => {
    const report = buildAc6bReport(observations())
    expect(report.pass).toBe(true)
    expect(Object.values(report.checks).filter(Boolean)).toHaveLength(11)
  })

  test('a workspace that was never deleted proves nothing', () => {
    // Without this, a run in which `rm -rf` silently failed would report a
    // perfect restore of a workspace that never went away.
    const report = buildAc6bReport(
      observations({ restore: { deleted: false } }),
    )
    expect(report.checks.workspaceWasDeleted).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a clean workspace is not evidence either', () => {
    const report = buildAc6bReport(
      observations({ restore: { statusLines: 0 } }),
    )
    expect(report.checks.gitStatusWasNonTrivial).toBe(false)
  })

  test('files back but status different is still a failure', () => {
    const report = buildAc6bReport(
      observations({ restore: { statusIdentical: false } }),
    )
    expect(report.checks.restoreSucceeded).toBe(true)
    expect(report.checks.gitStatusIdentical).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('an over-budget restore fails even though it worked', () => {
    const report = buildAc6bReport(
      observations({ restore: { elapsedMs: 600_001 } }),
    )
    expect(report.checks.withinBudget).toBe(false)
  })

  test('one removal attempt getting through fails the run', () => {
    const report = buildAc6bReport(
      observations({ protection: { removalStatuses: [405, 204, 405, 405] } }),
    )
    expect(report.checks.removalRefused).toBe(false)
  })

  test('a refusal that left no audit record fails', () => {
    // AC-6(c) asks for refused *and* on the record.
    const report = buildAc6bReport(
      observations({ protection: { mutationDenied: 0 } }),
    )
    expect(report.checks.denialsAudited).toBe(false)
  })

  test('a write credential that can read fails', () => {
    const report = buildAc6bReport(
      observations({ protection: { listStatus: 200 } }),
    )
    expect(report.checks.writerCannotRead).toBe(false)
  })
})
