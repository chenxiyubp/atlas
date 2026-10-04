// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Issuing and verifying capability tokens (protocol.md §10.1).
 *
 * ## The order of the checks, and why the nonce is last
 *
 * Structure, then binding (`aud` / `sub` / `taskId`), then the clock, then rule
 * S-1, then the signature, then the replay guard. Every step before the
 * signature is a rejection made on *unverified* claims, which is sound in one
 * direction only: refusing on an unverified claim costs an attacker a message,
 * while accepting on one would be the whole vulnerability.
 *
 * The nonce is consumed last, after the signature verifies, and that ordering
 * is the point rather than an optimization. Consume it earlier and anyone able
 * to guess a nonce could burn it with unsigned garbage, turning the replay
 * guard into a way to make the legitimate token bounce.
 *
 * ## Expiry is not gated by the time-jump rule
 *
 * Rule T-2 stops a thawed node from declaring every in-flight delivery dead at
 * once. It is deliberately **not** applied here: extending the life of an
 * authorization because the machine was asleep is the wrong direction of
 * failure. An expired token is expired; the sender can mint another, and the
 * cost of that is one round trip rather than an authorization that outlives its
 * own deadline by however long a freeze happened to last.
 */

import {
  CapabilityLevel,
  ProtocolErrorCode,
  encodeClaims,
  parseCapabilityToken,
  type CapabilityClaims,
} from '@qianmo/protocol'
import { signBytes, verifyBytes, type NodeKeyPair } from './keys.js'
import type { NonceStore } from './nonce.js'

/** Where a node's published Ed25519 public key comes from. */
export interface PublicKeyDirectory {
  /**
   * The key `node` publishes, or `null` when this node has never been told.
   *
   * Synchronous on purpose: the inbound gate runs inside a message handler, and
   * a lookup that could block would put an unauthenticated peer in charge of
   * how long that handler takes. A registry-backed directory therefore caches,
   * and refreshes on its own schedule.
   *
   * There is no trust-on-first-use here. Learning a key from the first message
   * that claims it would let whoever speaks first *become* that node.
   */
  publicKeyOf(node: string): string | null
}

/** A directory backed by a plain map — tests, fixtures, and small deployments. */
export class StaticPublicKeyDirectory implements PublicKeyDirectory {
  readonly #keys = new Map<string, string>()

  /**
   * Two different keys under one node name is a contradiction, not an update,
   * and last-write-wins is the worst available way to settle it.
   *
   * Every check that runs *before* the signature — `aud` / `sub` / `taskId`,
   * the clock, rule S-1 — still passes on the key that won, so the only
   * symptom left is `capability signature does not verify` on tokens that were
   * in fact minted correctly. That reads as a broken Ed25519 implementation
   * rather than as a name written down twice, and the hunt goes into the
   * verifier. Refusing the list outright is the difference between a
   * one-line diagnosis and a day in the wrong file.
   *
   * The same name with the *same* key is not a conflict: that is one list
   * stitched together from two places that agree, and refusing it would only
   * push deduplication onto every caller.
   *
   * {@link put} still replaces without complaint — that is the refresh path a
   * registry-backed cache needs, where a new key genuinely supersedes the old
   * one. Only the constructor, which is one operator writing one list, fails
   * fast.
   */
  constructor(entries: Iterable<readonly [string, string]> = []) {
    const all = [...entries]
    for (const [node, key] of all) {
      const existing = this.#keys.get(node)
      if (existing !== undefined && existing !== key) {
        const count = all.filter(([name]) => name === node).length
        throw new Error(
          `conflicting public keys for node ${node}: ${count} entries name` +
            ' it and they do not agree. A node publishes exactly one key —' +
            ' keep the right entry and drop the rest.',
        )
      }
      this.#keys.set(node, key)
    }
  }

  publicKeyOf(node: string): string | null {
    return this.#keys.get(node) ?? null
  }

  /** Publish or replace a node's key — the refresh path for a cache. */
  put(node: string, publicKey: string): void {
    this.#keys.set(node, publicKey)
  }

  delete(node: string): void {
    this.#keys.delete(node)
  }

  get size(): number {
    return this.#keys.size
  }
}

/** What {@link verifyCapability} needs to know about the message in hand. */
export interface VerifyContext {
  /** The node doing the verifying. Must equal the token's `aud`. */
  readonly node: string
  /** The handler the message is addressed to. Must equal the token's `sub`. */
  readonly handler: string
  /** The task the message belongs to. Must equal the token's `taskId`. */
  readonly taskId: string
  readonly now: number
  readonly directory: PublicKeyDirectory
  readonly nonces: NonceStore
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: CapabilityClaims }
  | {
      readonly ok: false
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

function invalid(reason: string): VerifyResult {
  return { ok: false, code: ProtocolErrorCode.E_CAP_INVALID, reason }
}

function insufficient(reason: string): VerifyResult {
  return { ok: false, code: ProtocolErrorCode.E_CAP_INSUFFICIENT, reason }
}

/** Claims a caller supplies; the issuer fills in `iss` and the nonce. */
export interface IssueInput {
  readonly sub: string
  readonly aud: string
  readonly act: CapabilityLevel
  readonly taskId: string
  readonly nbf: number
  readonly exp: number
  readonly nonce?: string
}

/**
 * Mint a token signed by this node.
 *
 * The signature covers the encoded claims segment, and that same string is
 * what the verifier checks — see the module header on why nothing is
 * re-serialized in between.
 */
export function issueCapability(
  issuer: string,
  keys: NodeKeyPair,
  input: IssueInput,
): string {
  if (!(input.exp > input.nbf)) {
    throw new RangeError(
      `capability exp (${input.exp}) must be after nbf (${input.nbf})`,
    )
  }
  const claims: CapabilityClaims = {
    iss: issuer,
    sub: input.sub,
    aud: input.aud,
    act: input.act,
    taskId: input.taskId,
    nbf: input.nbf,
    exp: input.exp,
    nonce: input.nonce ?? crypto.randomUUID(),
  }
  const signed = encodeClaims(claims)
  return `${signed}.${signBytes(keys, signed)}`
}

/** Verify a presented token against the message it arrived with. */
export function verifyCapability(
  token: unknown,
  context: VerifyContext,
): VerifyResult {
  const parts = parseCapabilityToken(token)
  if (parts === null) return invalid('capability token is malformed')
  const { claims, signed, signature } = parts

  if (claims.aud !== context.node) {
    // The replay-to-a-third-node case the field exists for.
    return invalid(
      `capability audience ${claims.aud} is not this node ${context.node}`,
    )
  }
  if (claims.sub !== context.handler) {
    return invalid(
      `capability subject ${claims.sub} does not match handler ${context.handler}`,
    )
  }
  if (claims.taskId !== context.taskId) {
    return invalid('capability is bound to another task')
  }
  if (context.now < claims.nbf) return invalid('capability is not yet valid')
  if (context.now >= claims.exp) return invalid('capability has expired')

  // Rule S-1, and it runs before the signature check on purpose: this is a
  // refusal, and refusing early costs nothing. A remote `user-confirmed` token
  // is not "a signature we could not check" — it is a claim this node will not
  // accept from anyone but itself, however well signed.
  if (
    claims.act === CapabilityLevel.UserConfirmed &&
    claims.iss !== context.node
  ) {
    return insufficient(
      `user-confirmed capability issued by ${claims.iss}, not by this node (rule S-1)`,
    )
  }

  const publicKey = context.directory.publicKeyOf(claims.iss)
  if (publicKey === null) {
    return invalid(`no published public key for issuer ${claims.iss}`)
  }
  if (!verifyBytes(publicKey, signed, signature)) {
    return invalid('capability signature does not verify')
  }

  if (
    !context.nonces.admit(claims.iss, claims.nonce, claims.exp, context.now)
  ) {
    return invalid('capability nonce has already been used')
  }

  return { ok: true, claims }
}
