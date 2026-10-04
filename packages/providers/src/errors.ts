// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The closed error-code set of the sixth action (§2.5). `code` is for
 * programs, `message` is Chinese for people; a response never carries any
 * value from the request, only key names, hashes and fingerprints.
 *
 * `unsupported-multi-key` is the one addition to the §2.5 list: a profile may
 * hold up to {@link MAX_KEYS_PER_PROFILE} keys (P18.18 schema, decided
 * 2026-10-03), but a v1 node delivers exactly one. A request carrying more is
 * refused by name instead of having the extras silently dropped — silently
 * using one key would let the hub believe rotation is in effect when it is
 * not. Nodes advertise `capabilities.multiKey: false` until P18.18.
 */
export const PROVIDER_ERROR_CODES = [
  'bad-request',
  'version-skew',
  'unsupported-op',
  'node-mismatch',
  'unknown-key',
  'bad-value',
  'effort-unsendable',
  'retired-model',
  'secret-mismatch',
  'unsupported-multi-key',
  'conflict',
  'busy',
  'write-failed',
  'probe-failed',
] as const

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number]

export function isProviderErrorCode(
  value: unknown,
): value is ProviderErrorCode {
  return (
    typeof value === 'string' &&
    (PROVIDER_ERROR_CODES as readonly string[]).includes(value)
  )
}

/** One reason a profile or request was refused. `path` is a JSON pointer-ish dotted path. */
export type ProviderIssue = {
  code: ProviderErrorCode
  message: string
  path: string
}
