// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Effort levels only ever move DOWN (§3.4, hermes B4).
 *
 * The base runtime does not clamp `max`/`xhigh` against what a model accepts
 * (`effort.ts`: "API errors are the user's responsibility"), and some vendor
 * adapters map a level UP (`medium → high`). So the clamp happens here, once,
 * at compile time: a requested level not in the model's set becomes the
 * highest accepted level not above it, and when nothing is at or below it the
 * profile is refused rather than silently raised.
 */

import { EFFORT_LEVELS, type EffortLevel, type ModelEffort } from './types.js'

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === 'string' &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  )
}

function rank(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level)
}

/** `levels` in canonical low → max order, duplicates dropped. */
export function sortEffortLevels(
  levels: readonly EffortLevel[],
): EffortLevel[] {
  return EFFORT_LEVELS.filter(level => levels.includes(level))
}

/**
 * The highest level in `levels` that is not above `requested`, or `null` when
 * every accepted level is higher (the caller refuses with `bad-value`).
 */
export function clampEffortDown(
  requested: EffortLevel,
  levels: readonly EffortLevel[],
): EffortLevel | null {
  let best: EffortLevel | null = null
  for (const level of levels) {
    if (rank(level) > rank(requested)) continue
    if (best === null || rank(level) > rank(best)) best = level
  }
  return best
}

/**
 * One level that is valid for EVERY constrained model, clamped down from
 * `requested`.
 *
 * `CLAUDE_CODE_EFFORT_LEVEL` is a single process-wide value that outranks the
 * per-slot settings, so clamping it per model is not enough: `max` clamps to
 * `max` for a `[low, high, max]` model and to `high` for a `[low, medium,
 * high]` one, and no single env value is both. The answer is the highest level
 * at or below `requested` that every set contains. `null` when there is none.
 * An empty list of sets constrains nothing.
 */
export function clampSharedEffortDown(
  requested: EffortLevel,
  levelSets: readonly (readonly EffortLevel[])[],
): EffortLevel | null {
  const common = EFFORT_LEVELS.filter(level =>
    levelSets.every(set => set.includes(level)),
  )
  return clampEffortDown(requested, common)
}

/**
 * What an `always` model without its own `level` is compiled with: `high`,
 * the level the APIs apply when none is sent (base `effort.ts`,
 * `getDisplayedEffortLevel`).
 *
 * Writing nothing is not an option. The runtime would then fall back to its
 * family default — `xhigh` for a third-party opus/sonnet slot — which is not
 * clamped against `levels` and lands on the wire for a model that may only
 * accept up to `high` (observed through `computeEffectiveProviderState`).
 */
export const UNSPECIFIED_EFFORT_LEVEL: EffortLevel = 'high'

/**
 * The level that goes into `modelSettings` for this model: `undefined` when
 * nothing is written (`never`, or `auto` without a level), `null` when the
 * request cannot be clamped into `levels` (the profile is refused).
 */
export function compiledEffortLevel(
  effort: ModelEffort,
): EffortLevel | null | undefined {
  if (effort.send === 'never') return undefined
  const requested =
    effort.level ??
    (effort.send === 'always' ? UNSPECIFIED_EFFORT_LEVEL : undefined)
  if (requested === undefined) return undefined
  if (effort.levels === undefined) return requested
  return clampEffortDown(requested, effort.levels)
}
