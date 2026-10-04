// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Naming one key: `profileId + keyId`.
 *
 * A profile holds 1..8 keys (P18.18 decision, 2026-10-03), so "the secret of
 * profile X" is no longer a complete address. The hub's secret store (P18.6)
 * keys its entries by {@link secretSlotKey}, and should bind the same pair
 * (plus the profile revision) into the AEAD additional data so a ciphertext
 * cannot be replayed onto another key of the same profile.
 *
 * Both ids are `[a-z0-9-]`, so `:` cannot occur inside either and the joined
 * form parses back unambiguously.
 */

const PROFILE_ID_PATTERN = /^[a-z0-9-]{1,48}$/
const KEY_ID_PATTERN = /^[a-z0-9-]{1,32}$/

export type SecretRef = { profileId: string; keyId: string }

export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value)
}

export function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID_PATTERN.test(value)
}

export function secretSlotKey(ref: SecretRef): string {
  if (!isProfileId(ref.profileId) || !isKeyId(ref.keyId)) {
    throw new TypeError('secretSlotKey: profileId 或 keyId 不合法')
  }
  return `${ref.profileId}:${ref.keyId}`
}

export function parseSecretSlotKey(slot: string): SecretRef | null {
  const separator = slot.indexOf(':')
  if (separator < 0) return null
  const profileId = slot.slice(0, separator)
  const keyId = slot.slice(separator + 1)
  return isProfileId(profileId) && isKeyId(keyId) ? { profileId, keyId } : null
}
