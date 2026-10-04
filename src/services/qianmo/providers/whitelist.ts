// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The node's env whitelist (§2.6): which `settings.json` env keys a delivered
 * profile may own.
 *
 * Exactly the base's single list of provider keys (`ALL_PROFILE_ENV_KEYS`,
 * the same set `/provider` activation clears) plus the closed compat set from
 * `@qianmo/providers`. Everything else in `env` belongs to the node and its
 * operators and is never touched.
 *
 * userSettings `env` is applied to the whole process (`managedEnv.ts`), so this
 * check runs on the COMPILED patch as well, after the profile schema has
 * already been checked: a compiler bug must not be able to write `PATH` either.
 */

import {
  COMPAT_KEYS,
  isForbiddenEnvKey,
  type ProviderIssue,
} from '@qianmo/providers'
import { ALL_PROFILE_ENV_KEYS } from '../../providerProfiles/envKeys.js'

export const MANAGED_ENV_KEYS: ReadonlySet<string> = new Set([
  ...ALL_PROFILE_ENV_KEYS,
  ...COMPAT_KEYS,
])

/**
 * Env keys whose values are credentials. Hashed by fingerprint, never named
 * with a value anywhere. Every entry is in `ALL_PROFILE_ENV_KEYS` (asserted by
 * the test suite), so a base rename cannot silently drop one.
 */
export const SECRET_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'OPENCODE_API_KEY',
]

export function isManagedEnvKey(key: string): boolean {
  return MANAGED_ENV_KEYS.has(key) && !isForbiddenEnvKey(key)
}

/** `null` when every key in `env` may be written by a profile. */
export function checkEnvAgainstWhitelist(
  env: Readonly<Record<string, unknown>>,
): ProviderIssue | null {
  for (const key of Object.keys(env)) {
    if (!isManagedEnvKey(key)) {
      return {
        code: 'unknown-key',
        path: `env.${key}`,
        message: `${key} 不在节点白名单里`,
      }
    }
  }
  return null
}

/**
 * Provider-shaped keys present in an environment, by name only — what the
 * resident inherited at start (§2.4 `inheritedProviderKeys`, `env-residue`).
 */
export function inheritedProviderKeyNames(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.keys(env)
    .filter(
      key =>
        env[key] !== undefined &&
        (MANAGED_ENV_KEYS.has(key) || key.startsWith('CLAUDE_CODE_USE_')),
    )
    .sort()
}
