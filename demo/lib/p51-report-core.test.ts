// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  buildP51Report,
  type ClassifiedSample,
  type P51Observations,
} from './p51-report-core.js'

const CATEGORIES = [
  'timeout',
  'oom',
  'disk-full',
  'quota-exhausted',
  'missing-dependency',
]

function sample(label: string, predicted = label): ClassifiedSample {
  return {
    label,
    predicted,
    confidence: 'high',
    evidence: ['because the runtime said so'],
    how: 'injected',
  }
}

function observations(
  overrides: Partial<P51Observations> = {},
): P51Observations {
  return {
    expectedCategories: CATEGORIES,
    perCategory: 10,
    samples: CATEGORIES.flatMap(label =>
      Array.from({ length: 10 }, () => sample(label)),
    ),
    skipped: [],
    threshold: 0.8,
    ...overrides,
  }
}

describe('P5.1 accuracy report', () => {
  test('a clean run passes with the full 50 samples', () => {
    const report = buildP51Report(observations())
    expect(report.total).toBe(50)
    expect(report.accuracy).toBe(1)
    expect(report.pass).toBe(true)
  })

  test('one category collapsing is caught even at 80% overall', () => {
    // Four categories perfect and one at zero is exactly 80%, which the DoD's
    // headline number would wave through. It is also the single most useful
    // thing this report can catch.
    const samples = CATEGORIES.flatMap(label =>
      Array.from({ length: 10 }, () =>
        label === 'oom' ? sample(label, 'unknown') : sample(label),
      ),
    )
    const report = buildP51Report(observations({ samples }))
    expect(report.accuracy).toBeCloseTo(0.8, 5)
    expect(report.checks.overallAccuracyMet).toBe(true)
    expect(report.checks.everyCategoryAboveHalf).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('a skipped category fails the run instead of shrinking the denominator', () => {
    const samples = CATEGORIES.filter(label => label !== 'disk-full').flatMap(
      label => Array.from({ length: 10 }, () => sample(label)),
    )
    const report = buildP51Report(
      observations({
        samples,
        skipped: [{ label: 'disk-full', reason: 'no /dev/full on darwin' }],
      }),
    )
    // The four categories that did run were perfect — and the run still fails,
    // because a four-category report is not evidence about five.
    expect(report.accuracy).toBe(1)
    expect(report.checks.allCategoriesInjected).toBe(false)
    expect(report.pass).toBe(false)
  })

  test('fewer than ten samples in a category fails', () => {
    const samples = CATEGORIES.flatMap(label =>
      Array.from({ length: label === 'timeout' ? 4 : 10 }, () => sample(label)),
    )
    const report = buildP51Report(observations({ samples }))
    expect(report.checks.enoughSamplesPerCategory).toBe(false)
  })

  test('an unknown verdict counts as wrong here, whatever it is in production', () => {
    const samples = CATEGORIES.flatMap(label =>
      Array.from({ length: 10 }, (_, index) =>
        index === 0 ? sample(label, 'unknown') : sample(label),
      ),
    )
    const report = buildP51Report(observations({ samples }))
    expect(report.checks.noUnknownVerdicts).toBe(false)
    expect(report.accuracy).toBeCloseTo(0.9, 5)
  })

  test('a verdict with no evidence fails even when the name is right', () => {
    const samples = [
      { ...sample('timeout'), evidence: [] },
      ...CATEGORIES.flatMap(label =>
        Array.from({ length: 10 }, () => sample(label)),
      ),
    ]
    const report = buildP51Report(observations({ samples }))
    expect(report.checks.everyVerdictHasEvidence).toBe(false)
  })
})
