// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The paired, interleaved schedule of §4 and D-1 A1: the M0 and M1 arms run
 * in the same period, call for call.
 *
 * The unit is one repetition of one question to one provider. Each unit is a
 * pair of calls, one per arm. The order of the pairs is shuffled, and within a
 * pair a coin decides which arm goes first; both from a seed derived from the
 * run id, so a run's schedule is reproducible and two runs differ. Workers
 * take whole pairs and run the two calls back to back, so at any moment the
 * number of calls started under one arm exceeds the other by at most the
 * number of workers — a provider drifting mid-run moves both arms together.
 */

import { mulberry32, shuffled } from '../dataset.js'
import type { Arm } from './types.js'

export type Unit = {
  readonly corpus: string
  readonly tier: number
  readonly seed: number
  readonly queryId: string
  readonly kind: string
  readonly provider: string
  /** 1-based repetition. */
  readonly rep: number
}

export type ScheduledPair = {
  readonly unit: Unit
  /** The arms in the order their calls are made. */
  readonly order: readonly Arm[]
}

export function unitKey(unit: Unit): string {
  return [
    unit.corpus,
    unit.tier,
    unit.seed,
    unit.queryId,
    unit.provider,
    `rep${unit.rep}`,
  ].join('/')
}

/** One call of one arm; `round` 2 is the call after a rejection. */
export function callKey(unit: Unit, arm: Arm, round: 1 | 2): string {
  return `${unitKey(unit)}/${arm}/r${round}`
}

/** FNV-1a over the run id: the schedule seed. */
export function scheduleSeed(runId: string): number {
  let hash = 0x811c9dc5
  for (const char of runId) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * Shuffle the units and give every pair its within-pair order.
 *
 * With one arm the "pair" is a single call and only the shuffle applies.
 */
export function schedulePairs(
  units: readonly Unit[],
  arms: readonly Arm[],
  seed: number,
): ScheduledPair[] {
  const random = mulberry32(seed)
  const order = shuffled(units, random)
  return order.map(unit => {
    if (arms.length < 2) return { unit, order: [...arms] }
    const flip = random() < 0.5
    return { unit, order: flip ? [...arms].reverse() : [...arms] }
  })
}
