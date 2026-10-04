// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D-1 A2's inference, against hand computation: per-question differences,
 * the exact sign-flip test, the question-clustered bootstrap, Holm.
 */

import { describe, expect, test } from 'bun:test'
import {
  bootstrapQuantile,
  type ClusterDifference,
  clusterBootstrap,
  clusterDifferences,
  holm,
  meanDifference,
  signFlipPValue,
} from '../eval/answer/stats.js'
import { mulberry32 } from '../eval/dataset.js'

const d = (cluster: string, numerator: number, denominator = 1) =>
  ({ cluster, numerator, denominator }) satisfies ClusterDifference

describe('per-question differences', () => {
  test('repetitions averaged per cell, cells averaged per question', () => {
    const differences = clusterDifferences([
      // q1, provider a: M1 (1,1,0) vs M0 (0,0,0) → 2/3
      { cluster: 'q1', stratum: 'a', m0: 0, m1: 1 },
      { cluster: 'q1', stratum: 'a', m0: 0, m1: 1 },
      { cluster: 'q1', stratum: 'a', m0: 0, m1: 0 },
      // q1, provider b: two repetitions, (1,1) vs (1,0) → 1/2
      { cluster: 'q1', stratum: 'b', m0: 1, m1: 1 },
      { cluster: 'q1', stratum: 'b', m0: 0, m1: 1 },
      // q2: one cell, one repetition, M1 worse
      { cluster: 'q2', stratum: 'a', m0: 1, m1: 0 },
    ])
    // q1 = (2/3 + 1/2) / 2 = 7/12
    expect(
      differences.map(x => [x.cluster, x.numerator / x.denominator]),
    ).toEqual([
      ['q1', 7 / 12],
      ['q2', -1],
    ])
    expect(meanDifference(differences)).toBeCloseTo((7 / 12 - 1) / 2, 12)
  })

  test('non-integer per-call values are refused', () => {
    expect(() =>
      clusterDifferences([{ cluster: 'q', stratum: 's', m0: 0.5, m1: 1 }]),
    ).toThrow(/integers/)
  })
})

describe('exact sign flip', () => {
  test('hand-computed p-values', () => {
    // Three positive differences: only the all-positive assignment ties.
    const three = [d('a', 1), d('b', 1), d('c', 1)]
    expect(signFlipPValue(three, 'greater')).toBe(1 / 8)
    expect(signFlipPValue(three, 'two-sided')).toBe(2 / 8)
    expect(signFlipPValue(three, 'less')).toBe(1)
    // +1 −1 +1 +1: S = 2; P(S ≥ 2) over four ±1 = (1 + 4) / 16.
    const mixed = [d('a', 1), d('b', -1), d('c', 1), d('d', 1)]
    expect(signFlipPValue(mixed, 'greater')).toBe(5 / 16)
    // A zero difference changes nothing.
    expect(signFlipPValue([...three, d('z', 0)], 'greater')).toBe(1 / 8)
    // One non-zero difference: a coin.
    expect(signFlipPValue([d('a', 2, 3), d('b', 0)], 'greater')).toBe(1 / 2)
    expect(signFlipPValue([d('a', 2, 3)], 'two-sided')).toBe(1)
  })

  test('equals brute-force enumeration on fractional differences', () => {
    const random = mulberry32(7)
    for (let trial = 0; trial < 20; trial += 1) {
      const n = 1 + Math.floor(random() * 10)
      const list = Array.from({ length: n }, (_, i) => {
        const denominator = [1, 2, 3, 6, 12][Math.floor(random() * 5)] ?? 1
        const numerator =
          Math.floor(random() * (2 * denominator + 1)) - denominator
        return d(`q${i}`, numerator, denominator)
      })
      const values = list.map(x => x.numerator / x.denominator)
      const observed = values.reduce((a, b) => a + b, 0)
      let greater = 0
      let twoSided = 0
      for (let mask = 0; mask < 1 << n; mask += 1) {
        const sum = values.reduce(
          (acc, v, i) => acc + ((mask >> i) & 1 ? -Math.abs(v) : Math.abs(v)),
          0,
        )
        if (sum >= observed - 1e-9) greater += 1
        if (Math.abs(sum) >= Math.abs(observed) - 1e-9) twoSided += 1
      }
      expect(signFlipPValue(list, 'greater')).toBeCloseTo(
        greater / (1 << n),
        12,
      )
      expect(signFlipPValue(list, 'two-sided')).toBeCloseTo(
        twoSided / (1 << n),
        12,
      )
    }
  })
})

describe('question-clustered bootstrap', () => {
  const differences = [d('a', 0), d('b', 0), d('c', 0), d('d', 1)]

  test('a fixed seed reproduces every resample; another seed does not', () => {
    const first = clusterBootstrap(differences, 10_000, 20260926)
    const again = clusterBootstrap(differences, 10_000, 20260926)
    const other = clusterBootstrap(differences, 10_000, 20260927)
    expect(Buffer.from(first.buffer).equals(Buffer.from(again.buffer))).toBe(
      true,
    )
    expect(Buffer.from(first.buffer).equals(Buffer.from(other.buffer))).toBe(
      false,
    )
  })

  test('quantiles land where the resampling distribution puts them', () => {
    // Means of 4 draws from {0,0,0,1}: P(mean ≥ 0.75) = 13/256 ≈ 5.1 %,
    // P(mean = 1) = 1/256 ≈ 0.4 %. So the 97.5 % point is 0.75.
    const sorted = clusterBootstrap(differences, 10_000, 20260926)
    expect(bootstrapQuantile(sorted, 0.975)).toBe(0.75)
    expect(bootstrapQuantile(sorted, 0.025)).toBe(0)
    for (let i = 1; i < sorted.length; i += 1) {
      expect((sorted[i] ?? 0) >= (sorted[i - 1] ?? 0)).toBe(true)
    }
  })
})

test('Holm step-down', () => {
  // Sorted: 0.01×3 = 0.03; 0.03×2 = 0.06; 0.04×1 → max(0.06, 0.04) = 0.06.
  const adjusted = holm([0.01, 0.04, 0.03])
  expect(adjusted[0]).toBeCloseTo(0.03, 12)
  expect(adjusted[1]).toBeCloseTo(0.06, 12)
  expect(adjusted[2]).toBeCloseTo(0.06, 12)
  expect(holm([0.5, 0.9])).toEqual([1, 1])
})
