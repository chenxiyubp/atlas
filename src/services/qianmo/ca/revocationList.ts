// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed revocation list — RL, not an X.509 CRL (§6.4).
 *
 * §6.4 rejected three other options and the reasons are worth keeping next to
 * the code: an X.509 CRL would need a certificate library because `node:crypto`
 * cannot parse one, and adding a runtime supply chain for a format both ends
 * of which we control is a bad trade; short lifetimes alone would force the CA
 * online, destroying two of the three benefits §3.3 gets from it being offline;
 * and a status flag on the registry would put the revocation authority in a
 * house with no door (`console.md` §8.2 — anybody can write there).
 *
 * What is left is the cheapest thing that works: an ordinary JSON document
 * signed with `signBytes`, verified with `verifyBytes`, both already present
 * for capability tokens. **Zero new dependencies**, and the signature is what
 * makes it safe to hand the zero-auth registry as a courier — tampering is
 * detectable, so the registry only ever gets to be unavailable, never lying.
 *
 * ## The signature covers the bytes as delivered
 *
 * Same discipline as the capability token (protocol.md §10.1, roadmap v2.22 ①):
 * the payload travels base64url-encoded and is verified exactly as it arrived,
 * then parsed. Nothing re-serializes, so no canonical-JSON scheme has to be
 * agreed on, and "these two objects are equal but not byte-equal" cannot
 * happen. It is also why the artefact carries no human-readable copy of its
 * own contents: a second rendering of the same facts is a second thing to
 * disagree with the first (CLAUDE.md §1.1⑧). The CLI prints the decoded list.
 */

import { signBytes, verifyBytes, type NodeKeyPair } from '@qianmo/capability'
import { isValidSegment } from '@qianmo/protocol'
import { isFingerprint256 } from './caKeys.js'

/** Version of the RL document. Bumping it is a migration, not a surprise. */
export const REVOCATION_LIST_VERSION = 1

/**
 * How long a freshly signed RL stays fresh: 30 days (§6.2).
 *
 * An argued number, not a derived one — §6.2 records the trade openly: a shorter
 * window shrinks the interval in which a compromised node can hide behind a
 * suppressed RL (§11 T-C), at the cost of asking a person to do a chore more
 * often, and "a design that assumes someone does a weekly chore is a design
 * that fails". The number pairs with the 90-day certificate lifetime below;
 * §12 K-14 records that the reviewer accepted both explicitly.
 */
export const REVOCATION_LIST_VALID_MS = 30 * 24 * 60 * 60 * 1000

/** The longest a revocation reason may be. Bounded because it reaches logs. */
const MAX_REASON_LENGTH = 200

/** One revoked certificate. */
export interface RevocationEntry {
  /** The node whose certificate this was — for humans reading the list. */
  readonly node: string
  /**
   * The certificate's SHA-256 fingerprint, and the field that actually decides.
   *
   * Keyed on the certificate rather than on the node because §6.5 says a
   * compromised node comes back as a NEW identity: revoking "everything this
   * node ever had" would either be wrong (it re-joins under a new segment
   * anyway) or dangerous (a `node`-keyed entry could catch a re-issued, clean
   * certificate).
   */
  readonly fingerprint256: string
  readonly reason: string
  /** When the revocation was decided, epoch ms. */
  readonly at: number
}

/** The document the CA signs (§6.4's shape, written once). */
export interface RevocationList {
  readonly version: number
  readonly issuedAt: number
  /** After this instant the list is stale and §6.4's fail-closed rule applies. */
  readonly nextUpdate: number
  readonly revoked: readonly RevocationEntry[]
}

/**
 * The published artefact: the signed bytes, and the signature over them.
 *
 * Not exported — nothing outside this file needs to name it. A reader takes
 * `unknown` and gets a {@link RevocationList} back or `null`, which is the
 * only shape a verifier should hand out anyway.
 */
interface SignedRevocationList {
  /** base64url of the JSON that was signed, byte-for-byte. */
  readonly payload: string
  readonly signature: string
}

const LIST_KEYS: readonly (keyof RevocationList)[] = [
  'version',
  'issuedAt',
  'nextUpdate',
  'revoked',
]

const ENTRY_KEYS: readonly (keyof RevocationEntry)[] = [
  'node',
  'fingerprint256',
  'reason',
  'at',
]

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRevocationEntry(value: unknown): value is RevocationEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entry = value as Record<string, unknown>
  const keys = Object.keys(entry)
  if (keys.length !== ENTRY_KEYS.length) return false
  if (!ENTRY_KEYS.every(key => keys.includes(key))) return false
  return (
    isValidSegment(entry['node']) &&
    isFingerprint256(entry['fingerprint256']) &&
    typeof entry['reason'] === 'string' &&
    entry['reason'].length > 0 &&
    entry['reason'].length <= MAX_REASON_LENGTH &&
    !/[\r\n]/.test(entry['reason']) &&
    isEpochMs(entry['at'])
  )
}

/**
 * Structural check of a decoded list — no crypto, no clock.
 *
 * Field-closed, exactly as `isCapabilityClaims` is and for the same reason: a
 * revocation list carrying fields this version does not understand is one
 * nobody can honestly say they checked.
 */
export function isRevocationList(value: unknown): value is RevocationList {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const list = value as Record<string, unknown>
  const keys = Object.keys(list)
  if (keys.length !== LIST_KEYS.length) return false
  if (!LIST_KEYS.every(key => keys.includes(key))) return false
  if (list['version'] !== REVOCATION_LIST_VERSION) return false
  if (!isEpochMs(list['issuedAt']) || !isEpochMs(list['nextUpdate'])) {
    return false
  }
  if (list['nextUpdate'] <= list['issuedAt']) return false
  const revoked = list['revoked']
  return Array.isArray(revoked) && revoked.every(isRevocationEntry)
}

/** Serialize in a fixed key order and base64url-encode. */
function encodeRevocationList(list: RevocationList): string {
  const ordered = {
    version: list.version,
    issuedAt: list.issuedAt,
    nextUpdate: list.nextUpdate,
    revoked: list.revoked.map(entry => ({
      node: entry.node,
      fingerprint256: entry.fingerprint256,
      reason: entry.reason,
      at: entry.at,
    })),
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64url')
}

/** Sign a list with the CA's key pair. */
export function signRevocationList(
  caKeys: NodeKeyPair,
  list: RevocationList,
): SignedRevocationList {
  if (!isRevocationList(list)) {
    throw new Error('refusing to sign a malformed revocation list')
  }
  const payload = encodeRevocationList(list)
  return { payload, signature: signBytes(caKeys, payload) }
}

/**
 * Verify and decode a published RL, or `null` when it is not one.
 *
 * Order matters and mirrors `verifyCapability`: the signature is checked over
 * the segment as delivered, and only a verified segment is ever parsed. The
 * clock is deliberately NOT consulted here — a stale list is still an authentic
 * statement by the CA, and §6.4 gives staleness its own behaviour (fail-closed
 * to the explicit `--trust` entries) rather than treating it as forgery. The
 * two must stay distinguishable to whoever reads the log.
 */
export function verifyRevocationList(
  caPublicKey: string,
  artefact: unknown,
): RevocationList | null {
  if (typeof artefact !== 'object' || artefact === null) return null
  const signed = artefact as Record<string, unknown>
  const payload = signed['payload']
  const signature = signed['signature']
  if (typeof payload !== 'string' || typeof signature !== 'string') return null
  if (!verifyBytes(caPublicKey, payload, signature)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  return isRevocationList(parsed) ? parsed : null
}
