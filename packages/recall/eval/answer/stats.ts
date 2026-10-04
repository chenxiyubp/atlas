// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The inference of D-1 A2: the question is the unit of analysis.
 *
 * For every question: the repetitions of each (tier, provider) cell are
 * averaged per arm, the paired difference M1 − M0 is taken per cell, and the
 * cells are averaged — providers, and tiers when two are pooled. What is
 * tested is the list of per-question differences, never the 3 × n Bernoulli
 * draws underneath (those are not independent).
 *
 *   sign flip    exact: under H0 each question's difference is symmetric
 *                about 0. Per-call values are whole numbers, so every
 *                difference sits on a lattice 1/D and the null distribution of
 *                the sum is a convolution — computed exactly, no sampling.
 *   bootstrap    questions resampled with replacement; iterations and seed
 *                come from the preregistration, never from here.
 *   Holm         step-down adjustment for the secondary comparisons (A5).
 */

import { mulberry32 } from '../dataset.js'

/** One repetition of one question, both arms, one per-call value each. */
export type PairedObservation = {
  /** The cluster: one question. */
  readonly cluster: string
  /** The cell within it: tier × provider. */
  readonly stratum: string
  readonly m0: number
  readonly m1: number
}

/** A question's difference as an exact fraction `numerator / denominator`. */
export type ClusterDifference = {
  readonly cluster: string
  readonly numerator: number
  readonly denominator: number
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b

/**
 * Per-question differences.
 *
 * Throws on a non-integer per-call value: the exact test depends on the
 * lattice, and every §2.2 per-call metric is a count.
 */
export function clusterDifferences(
  observations: readonly PairedObservation[],
): ClusterDifference[] {
  const byCluster = new Map<string, Map<string, { sum: number; n: number }>>()
  for (const { cluster, stratum, m0, m1 } of observations) {
    if (!Number.isInteger(m0) || !Number.isInteger(m1)) {
      throw new Error(`stats: per-call values must be integers (${cluster})`)
    }
    const cells = byCluster.get(cluster) ?? new Map()
    byCluster.set(cluster, cells)
    const cell = cells.get(stratum) ?? { sum: 0, n: 0 }
    cells.set(stratum, { sum: cell.sum + (m1 - m0), n: cell.n + 1 })
  }
  return [...byCluster.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cluster, cells]) => {
      // mean over cells of (sum_i / n_i) = Σ sum_i·(L/n_i) / (L·cells)
      const list = [...cells.values()]
      const common = list.reduce((acc, cell) => lcm(acc, cell.n), 1)
      const numerator = list.reduce(
        (acc, cell) => acc + cell.sum * (common / cell.n),
        0,
      )
      return { cluster, numerator, denominator: common * list.length }
    })
}

export function meanDifference(
  differences: readonly ClusterDifference[],
): number {
  if (differences.length === 0) return Number.NaN
  return (
    differences.reduce((acc, d) => acc + d.numerator / d.denominator, 0) /
    differences.length
  )
}

type Alternative = 'greater' | 'less' | 'two-sided'

/**
 * Exact sign-flip permutation p-value of the mean difference.
 *
 * `greater` is P(S ≥ s), `less` P(S ≤ s), `two-sided` P(|S| ≥ |s|), over
 * all 2^n sign assignments. Ties count toward the p-value.
 */
export function signFlipPValue(
  differences: readonly ClusterDifference[],
  alternative: Alternative,
): number {
  if (differences.length === 0) return 1
  const scale = differences.reduce((acc, d) => lcm(acc, d.denominator), 1)
  const weights = differences.map(d => (d.numerator * scale) / d.denominator)
  const observed = weights.reduce((acc, w) => acc + w, 0)
  const magnitudes = weights.map(w => Math.abs(w))
  const total = magnitudes.reduce((acc, w) => acc + w, 0)
  // probability[s + total] = P(S = s)
  let probability = new Float64Array(2 * total + 1)
  probability[total] = 1
  for (const magnitude of magnitudes) {
    if (magnitude === 0) continue
    const next = new Float64Array(2 * total + 1)
    for (let index = 0; index < probability.length; index += 1) {
      const mass = probability[index] ?? 0
      if (mass === 0) continue
      next[index + magnitude] = (next[index + magnitude] ?? 0) + mass / 2
      next[index - magnitude] = (next[index - magnitude] ?? 0) + mass / 2
    }
    probability = next
  }
  let p = 0
  for (let index = 0; index < probability.length; index += 1) {
    const sum = index - total
    const mass = probability[index] ?? 0
    const inTail =
      alternative === 'greater'
        ? sum >= observed
        : alternative === 'less'
          ? sum <= observed
          : Math.abs(sum) >= Math.abs(observed)
    if (inTail) p += mass
  }
  return Math.min(1, p)
}

/** Sorted bootstrap means, questions resampled with replacement. */
export function clusterBootstrap(
  differences: readonly ClusterDifference[],
  iterations: number,
  seed: number,
): Float64Array {
  const values = differences.map(d => d.numerator / d.denominator)
  const means = new Float64Array(iterations)
  if (values.length === 0) return means.fill(Number.NaN)
  const random = mulberry32(seed)
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0
    for (let i = 0; i < values.length; i += 1) {
      sum += values[Math.floor(random() * values.length)] ?? 0
    }
    means[b] = sum / values.length
  }
  return means.sort()
}

/** The `p` quantile of sorted bootstrap means (the ⌈p·B⌉-th value). */
export function bootstrapQuantile(sorted: Float64Array, p: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  )
  return sorted[index] ?? Number.NaN
}

/** Holm step-down adjusted p-values, in the input order. */
export function holm(pValues: readonly number[]): number[] {
  const m = pValues.length
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p || a.index - b.index)
  const adjusted = new Array<number>(m).fill(1)
  let running = 0
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p))
    adjusted[index] = running
  })
  return adjusted
}
