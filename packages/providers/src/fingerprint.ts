// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Key fingerprints: how the hub and a node agree on WHICH key is in place
 * without either side showing any part of it (§2.5 `keep`, §6.3.3).
 *
 * Deliberately not "the last 4 characters" (CC Switch, hermes B9): those are
 * real key material, and reconciliation does not need them. A fingerprint is a
 * domain-separated SHA-256 of one key, truncated to 128 bits — far beyond any
 * collision risk among the handful of keys one deployment holds, and useless
 * for reconstructing a high-entropy API key.
 *
 * One fingerprint per key: a multi-key profile (P18.18) fingerprints each key
 * on its own, so rotating one key changes exactly one fingerprint.
 */

import { createHash } from 'node:crypto'

const DOMAIN = 'qianmo/provider-key-fingerprint/v1\u0000'
const PREFIX = 'fp1:'
const HEX_LENGTH = 32

export function secretFingerprint(secret: string): string {
  const digest = createHash('sha256')
    .update(DOMAIN, 'utf8')
    .update(secret, 'utf8')
    .digest('hex')
  return `${PREFIX}${digest.slice(0, HEX_LENGTH)}`
}

const FINGERPRINT_PATTERN = new RegExp(`^${PREFIX}[0-9a-f]{${HEX_LENGTH}}$`)

export function isSecretFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}

/** The 8 hex characters shown to ops (§6.3.3 「已设置 · 指纹 3f9a1c2e」). */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.startsWith(PREFIX)
    ? fingerprint.slice(PREFIX.length, PREFIX.length + 8)
    : fingerprint.slice(0, 8)
}
