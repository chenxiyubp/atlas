// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed, off-host statement about one prefix of an audit trail.
 *
 * The second location being append-only is the load-bearing property. The
 * signature is deliberately supplementary: it proves which node emitted an
 * anchor and rejects a witness-side forgery, but a compromised node can sign a
 * new anchor. It cannot make an already-published, mismatching anchor vanish.
 */

import { signBytes, verifyBytes, type NodeKeyPair } from '@qianmo/capability'
import { SIGNATURE_PATTERN, isValidSegment } from '@qianmo/protocol'

/** Wire version of the first witness-anchor format. */
export const WITNESS_ANCHOR_VERSION = 1

/** A signed statement about the audit-chain prefix ending at `seq`. */
export interface WitnessAnchor {
  readonly v: typeof WITNESS_ANCHOR_VERSION
  readonly node: string
  readonly seq: number
  readonly head: string
  readonly count: number
  /** Epoch milliseconds at the node when it made this statement. */
  readonly at: number
  /** Ed25519 signature over {@link canonicalizeWitnessAnchor}. */
  readonly signature: string
}

/** Anchor fields before the signature is attached. */
export type UnsignedWitnessAnchor = Omit<WitnessAnchor, 'signature'>

/**
 * Witness-host metadata for one accepted anchor.
 *
 * `receivedAt` is deliberately outside {@link WitnessAnchor}: the node signs
 * only its statement, while the witness host vouches only that it accepted
 * that statement at this local time. Freshness must use this field rather than
 * the node-controlled `anchor.at`.
 */
export interface WitnessAnchorReceipt {
  readonly anchor: WitnessAnchor
  readonly receivedAt: number
}

/** A legacy bare anchor or an anchor accompanied by trusted host receipt time. */
export type WitnessEvidence = WitnessAnchor | WitnessAnchorReceipt

const SHA256_HEX = /^[0-9a-f]{64}$/

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * The one fixed byte representation that an anchor signs.
 *
 * Keep this order aligned with design §4.3: `[v, node, seq, head, count, at]`.
 * An object serialized by whichever caller happened to construct it would make
 * a valid signature depend on insertion order.
 */
export function canonicalizeWitnessAnchor(
  anchor: UnsignedWitnessAnchor,
): string {
  return JSON.stringify([
    anchor.v,
    anchor.node,
    anchor.seq,
    anchor.head,
    anchor.count,
    anchor.at,
  ])
}

/** Sign one anchor with the node's existing Ed25519 key pair. */
export function signWitnessAnchor(
  anchor: UnsignedWitnessAnchor,
  keys: NodeKeyPair,
): WitnessAnchor {
  if (!isUnsignedWitnessAnchor(anchor)) {
    throw new Error('cannot sign an invalid witness anchor')
  }
  return {
    ...anchor,
    signature: signBytes(keys, canonicalizeWitnessAnchor(anchor)),
  }
}

/** True when `value` has the complete, safe anchor wire shape. */
export function isWitnessAnchor(value: unknown): value is WitnessAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    isUnsignedWitnessAnchor(value) &&
    typeof candidate['signature'] === 'string' &&
    SIGNATURE_PATTERN.test(candidate['signature'])
  )
}

/** True when the evidence includes a valid witness-host reception time. */
export function isWitnessAnchorReceipt(
  value: unknown,
): value is WitnessAnchorReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const receipt = value as Record<string, unknown>
  return (
    isWitnessAnchor(receipt['anchor']) &&
    typeof receipt['receivedAt'] === 'number' &&
    Number.isSafeInteger(receipt['receivedAt']) &&
    receipt['receivedAt'] >= 0
  )
}

/** True for either persisted receipt evidence or a compatibility bare anchor. */
export function isWitnessEvidence(value: unknown): value is WitnessEvidence {
  return isWitnessAnchor(value) || isWitnessAnchorReceipt(value)
}

/** The signed node statement carried by either evidence representation. */
export function witnessAnchorOf(evidence: WitnessEvidence): WitnessAnchor {
  return isWitnessAnchor(evidence) ? evidence : evidence.anchor
}

/**
 * The witness-host reception time, or null for an old/local bare anchor.
 *
 * Callers may still compare a bare anchor to a trail, but may not use its
 * node-declared time to extend the freshness window.
 */
export function witnessReceivedAtOf(evidence: WitnessEvidence): number | null {
  return isWitnessAnchorReceipt(evidence) ? evidence.receivedAt : null
}

function isUnsignedWitnessAnchor(
  value: unknown,
): value is UnsignedWitnessAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const anchor = value as Record<string, unknown>
  return (
    anchor['v'] === WITNESS_ANCHOR_VERSION &&
    typeof anchor['node'] === 'string' &&
    isValidSegment(anchor['node']) &&
    isPositiveInteger(anchor['seq']) &&
    typeof anchor['head'] === 'string' &&
    SHA256_HEX.test(anchor['head']) &&
    isPositiveInteger(anchor['count']) &&
    anchor['count'] === anchor['seq'] &&
    typeof anchor['at'] === 'number' &&
    Number.isSafeInteger(anchor['at']) &&
    anchor['at'] >= 0
  )
}

/** Verify that an anchor was signed by the node whose public key was supplied. */
export function verifyWitnessAnchor(
  anchor: WitnessAnchor,
  publicKey: string,
): boolean {
  return verifyBytes(
    publicKey,
    canonicalizeWitnessAnchor(anchor),
    anchor.signature,
  )
}
