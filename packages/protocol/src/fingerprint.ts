// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'

/**
 * Content fingerprint — the second-level dedup key (protocol.md §7.2).
 *
 * Transport is at-least-once, so dedup runs at two levels: `msgId` catches a
 * retransmission of the same envelope, `fingerprint` catches the *semantic*
 * duplicate a crashed sender rebuilds for the same piece of work (fresh
 * `msgId`, fresh `createdAt`).
 */

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Digest of the business payload.
 *
 * `JSON.stringify` returns `undefined` for `undefined` and for functions;
 * those are not transportable payloads anyway, so they collapse onto one
 * stable sentinel rather than crashing the hasher.
 */
export function payloadDigest(payload: unknown): string {
  const encoded = JSON.stringify(payload)
  return sha256Hex(encoded === undefined ? 'undefined' : encoded)
}

/** The envelope fields that identify "the same piece of work". */
export interface FingerprintInput {
  readonly from: string
  readonly to: string
  /** {@link MessageType} value; typed as `string` to keep this module a leaf. */
  readonly type: string
  readonly taskId: string
  readonly payload: unknown
}

/**
 * `sha256_hex(JSON.stringify([from, to, type, taskId, payloadDigest]))`.
 *
 * An array, not an object — that sidesteps JSON key ordering, and it is what
 * the base already does for its own message identity.
 *
 * `msgId` / `createdAt` / `hops` / `traceId` are deliberately excluded: they
 * differ on every attempt, so including them would make the second level of
 * dedup unable to ever match.
 *
 * Honest limit: `payloadDigest` still rides on `JSON.stringify` key order, so
 * a fingerprint identifies a re-send **by the same sender implementation**.
 * It is not a cross-implementation canonical equivalence, and receivers must
 * therefore treat it as an opaque key rather than recomputing and comparing.
 */
export function computeFingerprint(input: FingerprintInput): string {
  return sha256Hex(
    JSON.stringify([
      input.from,
      input.to,
      input.type,
      input.taskId,
      payloadDigest(input.payload),
    ]),
  )
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

/** True when `value` has the shape produced by {@link computeFingerprint}. */
export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}
