// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Capability tokens: the wire shape of authorization (protocol.md §10.1, D-8).
 *
 * Types, encoding and structural validation only — signing and verification
 * need a key and therefore live in `@qianmo/capability`. The split is the same
 * one this package makes everywhere: what a valid message *looks like* is
 * shared by every node and every tool; what a node *can prove* is not.
 *
 * ## Why a per-node signature and not the pre-shared key
 *
 * The PSK is symmetric, so any node holding it can mint a token that claims to
 * come from any other node — including a token that claims the user confirmed
 * something. That would turn charter C-5 ("a message must not authorize on the
 * user's behalf") from a structural guarantee into a promise. With per-node
 * Ed25519, `user-confirmed` is a signature only the target node's own private
 * key can produce, so a remote peer is not *unwilling* to forge it — it is
 * unable (rule S-1).
 *
 * ## Encoding, fixed here and nowhere else
 *
 * Public keys are base64url without padding, 43 characters — RFC 8037's OKP
 * `x` parameter, which is exactly what `node:crypto` hands back from a JWK
 * export, so no re-encoding step can disagree with another. protocol.md §10.1
 * says this encoding is defined once; {@link PUBLIC_KEY_PATTERN} is that once,
 * and `@qianmo/registry` and `@qianmo/capability` both import it rather than
 * writing their own.
 *
 * ## The token is `<claims>.<sig>`, and the signature covers the bytes as sent
 *
 * A detached signature over *re-serialized* claims would need a canonical JSON
 * encoding, and every canonicalization scheme is a source of "these two are the
 * same object but not the same bytes" bugs (§7.2 hit the same wall and answered
 * it by hashing an array). So verification signs and checks the claims segment
 * **exactly as it travelled**, and only then parses it. Nothing has to agree
 * about key order because nothing re-encodes.
 */

import { isValidAddress, isValidSegment } from './address.js'

/**
 * The three permission levels of charter §3.3 C-5, lowest first.
 *
 * They are a ladder, not a set: `write-limited` implies everything `read`
 * allows. {@link levelAtLeast} is the only comparison anyone should write.
 */
export enum CapabilityLevel {
  /** May look, may not change anything. The level of an unsigned message. */
  Read = 'read',
  /** May cause bounded local work — the level a cross-node task needs. */
  WriteLimited = 'write-limited',
  /**
   * The user said yes. Only ever issued by the node that asked them, and
   * accepted only from that node's own key (rule S-1).
   */
  UserConfirmed = 'user-confirmed',
}

/** Every level, lowest first. */
export const CAPABILITY_LEVELS: readonly CapabilityLevel[] = Object.freeze([
  CapabilityLevel.Read,
  CapabilityLevel.WriteLimited,
  CapabilityLevel.UserConfirmed,
])

const LEVEL_RANK: ReadonlyMap<CapabilityLevel, number> = new Map(
  CAPABILITY_LEVELS.map((level, index) => [level, index]),
)

/** True when `value` is one of the three levels. */
export function isCapabilityLevel(value: unknown): value is CapabilityLevel {
  return typeof value === 'string' && LEVEL_RANK.has(value as CapabilityLevel)
}

/** True when `actual` sits at or above `required` on the ladder. */
export function levelAtLeast(
  actual: CapabilityLevel,
  required: CapabilityLevel,
): boolean {
  return (LEVEL_RANK.get(actual) ?? -1) >= (LEVEL_RANK.get(required) ?? 0)
}

/**
 * Ed25519 public key: base64url, unpadded, 43 characters (32 raw bytes).
 *
 * The single definition of the encoding (§10.1). Private key material shares
 * the shape but never shares a home with this constant — it does not belong on
 * a wire and has no format to agree on with anyone.
 */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** True when `value` is a well-formed node public key. */
export function isNodePublicKey(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_KEY_PATTERN.test(value)
}

/** Ed25519 signature: base64url, unpadded, 86 characters (64 raw bytes). */
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/

/** What a capability token asserts (protocol.md §10.1). */
export interface CapabilityClaims {
  /** Issuing node — the holder of the signing private key. */
  readonly iss: string
  /** The authorized handler, `qianmo://<node>/<agent>`. */
  readonly sub: string
  /**
   * The node the token may be presented to. A token replayed at a third node
   * fails here, which is the whole reason the field exists.
   */
  readonly aud: string
  readonly act: CapabilityLevel
  /** Bound to one task: there are no general-purpose tokens. */
  readonly taskId: string
  /** Not valid before (epoch ms). */
  readonly nbf: number
  /** Not valid after (epoch ms). Never later than the task deadline. */
  readonly exp: number
  /** Replay guard, remembered until `exp` — same clock as the dedup table. */
  readonly nonce: string
}

const CLAIM_KEYS: readonly (keyof CapabilityClaims)[] = [
  'iss',
  'sub',
  'aud',
  'act',
  'taskId',
  'nbf',
  'exp',
  'nonce',
]

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Structural check of a decoded claims object — no crypto, no clock.
 *
 * Field-closed: an unexpected key is a rejection rather than something to
 * ignore. A token is an authorization statement, and a statement carrying
 * fields this version does not understand is one nobody can say they verified.
 */
export function isCapabilityClaims(value: unknown): value is CapabilityClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const claims = value as Record<string, unknown>
  const keys = Object.keys(claims)
  if (keys.length !== CLAIM_KEYS.length) return false
  if (!CLAIM_KEYS.every(key => keys.includes(key))) return false
  return (
    isValidSegment(claims['iss']) &&
    isValidAddress(claims['sub']) &&
    isValidSegment(claims['aud']) &&
    isCapabilityLevel(claims['act']) &&
    typeof claims['taskId'] === 'string' &&
    claims['taskId'].length > 0 &&
    isPositiveFinite(claims['nbf']) &&
    isPositiveFinite(claims['exp']) &&
    typeof claims['nonce'] === 'string' &&
    claims['nonce'].length > 0
  )
}

/** Serialize claims in a fixed key order and base64url-encode them. */
export function encodeClaims(claims: CapabilityClaims): string {
  const ordered: Record<string, unknown> = {}
  for (const key of CLAIM_KEYS) ordered[key] = claims[key]
  return Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64url')
}

/**
 * Decode a claims segment, or `null` when it is not one.
 *
 * Takes the segment exactly as it arrived — the caller must have verified the
 * signature over *these* bytes, not over anything re-encoded from the result.
 */
export function decodeClaims(segment: string): CapabilityClaims | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  return isCapabilityClaims(parsed) ? parsed : null
}

/** A token split into the part that was signed and the signature over it. */
export interface CapabilityParts {
  /** The claims segment, byte-for-byte as received. */
  readonly signed: string
  readonly signature: string
  readonly claims: CapabilityClaims
}

/** Split and structurally validate a `<claims>.<sig>` token. */
export function parseCapabilityToken(token: unknown): CapabilityParts | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null
  const signed = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!SIGNATURE_PATTERN.test(signature)) return null
  const claims = decodeClaims(signed)
  if (claims === null) return null
  return { signed, signature, claims }
}
