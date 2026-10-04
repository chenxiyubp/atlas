// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The closed compat key set (§3.6) and the env keys no profile may ever name.
 *
 * Why closed: userSettings `env` is applied to the process wholesale
 * (`managedEnv.ts`), so a whitelist gap is a remote `PATH` write. Every key a
 * profile can set beyond the base's own `ALL_PROFILE_ENV_KEYS` is listed here
 * with the only values it accepts; anything else is `unknown-key`.
 */

import { isEffortLevel } from './effort.js'

type ValueCheck = (value: string) => string | null

const exactly =
  (expected: string): ValueCheck =>
  value =>
    value === expected ? null : `只能是 ${expected}`

const positiveInteger =
  (min: number, max: number): ValueCheck =>
  value => {
    if (!/^[1-9][0-9]*$/.test(value)) return '必须是正整数'
    const n = Number(value)
    return n >= min && n <= max ? null : `必须在 ${min} 到 ${max} 之间`
  }

/**
 * `ANTHROPIC_CUSTOM_HEADERS` is a newline-separated `Name: value` list. Only
 * one header is allowed: `anthropic-workspace-id`, which multi-workspace
 * Anthropic keys require on every request (§4.2). Anything else could smuggle
 * a credential or a routing header past the closed set.
 */
const workspaceHeaderOnly: ValueCheck = value => {
  const match = /^anthropic-workspace-id:\s*([A-Za-z0-9_-]{1,128})$/.exec(value)
  return match ? null : '只能是一行 anthropic-workspace-id: <id>'
}

const COMPAT_RULES = {
  CLAUDE_CODE_EFFORT_LEVEL: (value: string) =>
    isEffortLevel(value) ? null : '必须是 low/medium/high/xhigh/max 之一',
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: exactly('1'),
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: exactly('1'),
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: positiveInteger(1, 10_000_000),
  API_TIMEOUT_MS: positiveInteger(30_000, 1_800_000),
  ANTHROPIC_CUSTOM_HEADERS: workspaceHeaderOnly,
  CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE: exactly('0'),
} as const satisfies Record<string, ValueCheck>

export type CompatKey = keyof typeof COMPAT_RULES

/** §3.6, in table order. */
export const COMPAT_KEYS: readonly CompatKey[] = Object.keys(
  COMPAT_RULES,
) as CompatKey[]

export function isCompatKey(key: string): key is CompatKey {
  return Object.hasOwn(COMPAT_RULES, key)
}

/** `null` when `value` is acceptable for `key`, else a reason in Chinese. */
export function checkCompatValue(key: CompatKey, value: string): string | null {
  return COMPAT_RULES[key](value)
}

/**
 * Compat keys a profile may set directly. The two effort keys are not among
 * them: the compiler derives those from `effortLock` and the models' `send`
 * (§3.4), and a hand-set copy would be a second source for the same fact.
 */
export const PROFILE_SETTABLE_COMPAT_KEYS: readonly CompatKey[] =
  COMPAT_KEYS.filter(
    key =>
      key !== 'CLAUDE_CODE_EFFORT_LEVEL' &&
      key !== 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  )

/**
 * Env keys refused outright, whatever list they appear in.
 *
 * `CLAUDE_CODE_USE_*` because the lane is expressed by `modelType`, never by a
 * provider switch; the rest because they act on the process rather than on a
 * provider. The whitelist already excludes them — this list exists so a future
 * widening of the whitelist cannot let them back in unnoticed.
 */
const FORBIDDEN_EXACT: ReadonlySet<string> = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'HOME',
  'SHELL',
  'OCC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'OCC_IDENTITY',
])

const FORBIDDEN_PREFIXES: readonly string[] = ['CLAUDE_CODE_USE_']

export function isForbiddenEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    FORBIDDEN_EXACT.has(upper) ||
    FORBIDDEN_PREFIXES.some(prefix => upper.startsWith(prefix))
  )
}
