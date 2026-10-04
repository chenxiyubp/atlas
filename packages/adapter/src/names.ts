// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Name normalization for the last hop (protocol.md §2.2 rule A-1, §2.3 A-2).
 *
 * The base runs team names through *two* sanitizers that disagree:
 *
 * - the roster directory goes through `sanitizeName`
 *   (`src/utils/swarm/teamHelpers.ts:102-104`): non-alphanumeric → `-`,
 *   lowercased, then `avoidReservedName`;
 * - the inbox directory goes through `sanitizePathComponent`
 *   (`src/utils/task/tasks.ts:311-313`): `[^a-zA-Z0-9_-]` → `-`, keeping `_`
 *   and case, and with no reserved-name handling at all.
 *
 * A team called `My_Team` therefore lands in roster `my-team` and inbox
 * `My_Team`; a team called `con` lands in roster `_con` and inbox `con`. Both
 * are directory forks, and both are avoided *at the source* rather than by
 * patching the base: if a name is lowercase, made only of `[a-z0-9-]`, and is
 * not one of the 22 Windows device names, then **both** sanitizers are the
 * identity on it.
 *
 * `_` is excluded for a precise reason: it is the one character class the two
 * functions actually disagree on (`sanitizeName` turns it into `-`,
 * `sanitizePathComponent` keeps it). Agent segments are *not* subject to this
 * restriction — they only ever meet `sanitizePathComponent` — so they may
 * still contain `_` (protocol.md §2.3).
 */

/**
 * The 22 device names Windows reserves at every directory level, with or
 * without an extension.
 *
 * Mirrors the base's own list (`src/utils/filesystem/reservedNames.ts:18-25`)
 * — but where the base *repairs* such a name by prefixing `_`, Qianmo
 * **forbids** it outright (rule A-1). Repair is what creates the fork in the
 * first place: only one of the two base sanitizers applies it.
 */
export const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set<string>([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_unused, i) => `lpt${i + 1}`),
])

/** Rule A-2's shape for a node-local team name. */
export const TEAM_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Upper bound on a normalized team name, matching {@link TEAM_NAME_PATTERN}. */
export const MAX_TEAM_NAME_LENGTH = 64

/** Why {@link normalizeTeamName} / {@link assertTeamName} refused a name. */
export type TeamNameRejection = 'empty' | 'malformed' | 'reserved-device-name'

/** Thrown by {@link normalizeTeamName} / {@link assertTeamName}. */
export class InvalidTeamNameError extends Error {
  readonly reason: TeamNameRejection
  readonly input: string

  constructor(input: string, reason: TeamNameRejection, message: string) {
    super(message)
    this.name = 'InvalidTeamNameError'
    this.input = input
    this.reason = reason
  }
}

/**
 * True when `name` is one of the reserved Windows device names.
 *
 * Compared on the stem before the first `.`, because `nul.txt` addresses the
 * null device just as `nul` does.
 */
export function isReservedDeviceName(name: string): boolean {
  const stem = name.split('.')[0] ?? ''
  return RESERVED_DEVICE_NAMES.has(stem.toLowerCase())
}

/** True when `value` already satisfies rule A-2 and is not a device name. */
export function isNormalizedTeamName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TEAM_NAME_PATTERN.test(value) &&
    !isReservedDeviceName(value)
  )
}

/**
 * Fold an arbitrary team name onto rule A-2's alphabet, or refuse it.
 *
 * Lowercases, maps everything outside `[a-z0-9-]` to `-` (so `_` folds the way
 * `sanitizeName` would), collapses and trims runs of `-`, and truncates to
 * {@link MAX_TEAM_NAME_LENGTH}.
 *
 * Refuses rather than repairs in two cases, because repairing either one is
 * what reintroduces a fork:
 *
 * - nothing usable is left (`""`, `"---"`, `"你好"` → all dashes);
 * - the result is a reserved device name — the base would prefix `_` on the
 *   roster path only, and `_con` is not reachable by normalization, so there
 *   is no fixed point to fold onto.
 *
 * Idempotent: `normalizeTeamName(normalizeTeamName(x)) === normalizeTeamName(x)`.
 */
export function normalizeTeamName(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TEAM_NAME_LENGTH)
    // Truncation can expose a fresh trailing dash.
    .replace(/-+$/, '')

  if (folded.length === 0) {
    throw new InvalidTeamNameError(
      raw,
      'empty',
      `team name ${JSON.stringify(raw)} normalizes to nothing`,
    )
  }
  if (isReservedDeviceName(folded)) {
    throw new InvalidTeamNameError(
      raw,
      'reserved-device-name',
      `team name ${JSON.stringify(folded)} is a reserved Windows device name (rule A-1)`,
    )
  }
  return folded
}

/** Return `name` unchanged when it satisfies A-2, otherwise throw. */
export function assertTeamName(name: string): string {
  if (isReservedDeviceName(name)) {
    throw new InvalidTeamNameError(
      name,
      'reserved-device-name',
      `team name ${JSON.stringify(name)} is a reserved Windows device name (rule A-1)`,
    )
  }
  if (!TEAM_NAME_PATTERN.test(name)) {
    throw new InvalidTeamNameError(
      name,
      name.length === 0 ? 'empty' : 'malformed',
      `team name ${JSON.stringify(name)} does not match ${TEAM_NAME_PATTERN}`,
    )
  }
  return name
}
