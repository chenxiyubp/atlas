// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The node's authorization face: one object the router can ask about a message.
 *
 * It answers exactly one question — "what level does this message carry, and is
 * that enough for what it is asking?" — and it answers it without touching
 * anything else. In particular it does not, and cannot, grant: the return value
 * is a ceiling the caller may respect, and there is no method here that changes
 * what the local agent is allowed to do (rule S-3).
 */

import {
  CapabilityLevel,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  levelAtLeast,
  parseAddress,
  type NoticeTrust,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { CapabilityDecision, CapabilityGate } from '@qianmo/router'
import type { NodeKeyPair } from './keys.js'
import { NonceStore } from './nonce.js'
import {
  SIGNED_TASK_POLICY,
  satisfies,
  type CapabilityPolicy,
} from './policy.js'
import {
  issueCapability,
  verifyCapability,
  type IssueInput,
  type PublicKeyDirectory,
} from './token.js'

/**
 * One message that the node **let through** and a stricter policy would not
 * have — key-distribution.md §9.2 phase ①'s whole output.
 *
 * Every field is what the refusal would have said, not a summary of it: the
 * value of running in observation mode is that "how many would this cost" is
 * a number somebody can read every day, and a number nobody can trace back to
 * a sender and a message type is a number nobody acts on.
 */
export interface ShadowRefusal {
  /** The message type, as it travelled. */
  readonly type: string
  readonly from: string
  readonly traceId: string
  readonly taskId: string
  readonly msgId: string
  /** What the shadow policy asked for. */
  readonly required: CapabilityLevel
  /** What the message actually carried — usually `read`. */
  readonly presented: CapabilityLevel
  /** The error the enforcing policy would have answered with. */
  readonly code: ProtocolErrorCode
  /** Word for word what the real refusal's `reason` would have been. */
  readonly reason: string
}

/** Where {@link ShadowRefusal}s go. Synchronous; see the class note on why. */
export type ShadowRefusalSink = (refusal: ShadowRefusal) => void

export interface NodeCapabilitiesOptions {
  /** This node's segment: the only `aud` it will accept, and its `iss`. */
  readonly node: string
  readonly directory: PublicKeyDirectory
  /** Defaults to {@link SIGNED_TASK_POLICY} — see `policy.ts` on why. */
  readonly policy?: CapabilityPolicy
  readonly nonces?: NonceStore
  /** Needed only to issue; verification never touches a private key. */
  readonly keys?: NodeKeyPair
  /**
   * The subjects whose signature this node accepts as *authorization*, as
   * opposed to merely as *identification* (issue #28).
   *
   * Empty by default, and that default is the whole safety story: a node that
   * was never told to trust an issuer never hands one a tier above
   * `untrusted`, whatever it presents.
   *
   * **Not the same question as {@link NodeCapabilitiesOptions.directory}.** The
   * directory answers "can I check this signature at all" and, under a CA, it
   * answers yes for every subject the CA ever vouched for. This list answers
   * "did *this operator* name that subject", which is a decision a CA cannot
   * make on the operator's behalf. `resident.ts` fills it from the `--trust`
   * entries plus this node's own name — the two places where a human wrote a
   * subject down. A CA-derived identity is verifiable here and still not
   * trusted here; see key-distribution.md §10.5 for why that gap is left open
   * rather than closed by widening this list.
   */
  readonly trustedIssuers?: Iterable<string>
  /**
   * Observation mode: a second policy evaluated **alongside** the real one,
   * purely so that switching to it can be costed before it is switched to
   * (§9.2 phase ①).
   *
   * The contract is one sentence and it is the whole feature: **no message's
   * fate changes**. What this produces is a record, on the messages the real
   * policy admitted and this one would not have. When the two policies agree
   * — including the case where they are the same policy — it produces
   * nothing at all, which is what makes the flag safe to leave on.
   *
   * Deliberately *not* the same switch as {@link NodeCapabilitiesOptions.policy}:
   * "record what would happen" and "make it happen" are two decisions, and a
   * single knob that does both cannot be used for the first without doing the
   * second — which is the entire reason the phase exists.
   */
  readonly shadowPolicy?: CapabilityPolicy
  /** Required for {@link NodeCapabilitiesOptions.shadowPolicy} to be observable. */
  readonly onShadowRefusal?: ShadowRefusalSink
}

/** Verifies presented capabilities and applies the node's level policy. */
export class NodeCapabilities implements CapabilityGate {
  readonly node: string
  readonly policy: CapabilityPolicy
  readonly nonces: NonceStore
  readonly #directory: PublicKeyDirectory
  readonly #keys: NodeKeyPair | undefined
  readonly #shadowPolicy: CapabilityPolicy | undefined
  readonly #onShadowRefusal: ShadowRefusalSink | undefined
  readonly #trustedIssuers: ReadonlySet<string>

  constructor(options: NodeCapabilitiesOptions) {
    this.node = options.node
    this.policy = options.policy ?? SIGNED_TASK_POLICY
    this.nonces = options.nonces ?? new NonceStore()
    this.#directory = options.directory
    this.#keys = options.keys
    this.#trustedIssuers = new Set(options.trustedIssuers ?? [])
    // Both or neither: a shadow policy with nowhere to report is work done to
    // produce nothing, and a sink with no policy can never fire. Refusing the
    // half-configuration here means the flag either observes or is absent,
    // with no third state that looks configured.
    this.#shadowPolicy =
      options.onShadowRefusal === undefined ? undefined : options.shadowPolicy
    this.#onShadowRefusal =
      options.shadowPolicy === undefined ? undefined : options.onShadowRefusal
  }

  /**
   * Classify one inbound message.
   *
   * An absent token is not an error: it is the `read` level, which is what an
   * unauthenticated peer has. Whether `read` is enough is the policy's call,
   * and the two questions are kept apart so that "you sent no token" and "your
   * token is not good enough" cannot collapse into one indistinguishable
   * rejection.
   */
  check(message: QianmoMessage, now: number): CapabilityDecision {
    if (message.cap === undefined) {
      return this.#applyPolicy(message, CapabilityLevel.Read, undefined)
    }
    const verified = verifyCapability(message.cap, {
      node: this.node,
      handler: message.to,
      taskId: message.taskId,
      now,
      directory: this.#directory,
      nonces: this.nonces,
    })
    if (!verified.ok) {
      return { ok: false, code: verified.code, reason: verified.reason }
    }
    return this.#applyPolicy(message, verified.claims.act, verified.claims.iss)
  }

  /**
   * The tier a *verified* token earns, and the only place it is decided.
   *
   * Two conditions, both necessary (issue #28):
   *
   * 1. **the issuer is on this node's explicit list** — a signature that only
   *    proves identity proves nothing about authority;
   * 2. **the token asks for at least `write-limited`** — `act` is a ceiling
   *    (rule S-3), and a `read` token is its holder saying, in the one field
   *    that binds them, that this message is not meant to cause work. Reading
   *    that as "act on it" would contradict the token rather than obey it.
   *
   * `sub` / `aud` / `taskId` are not re-checked here because they cannot be
   * re-checked *later*: `verifyCapability` already refused anything whose
   * binding did not match this node, this handler and this task, so by the
   * time this runs the tier is necessarily a property of **this one message**
   * and expires with it. There is no state here, and no method that could make
   * a peer trusted for the next message.
   */
  #tierFor(issuer: string, level: CapabilityLevel): NoticeTrust {
    if (!this.#trustedIssuers.has(issuer)) return TRUST_UNTRUSTED
    if (!levelAtLeast(level, CapabilityLevel.WriteLimited)) {
      return TRUST_UNTRUSTED
    }
    return NOTICE_TRUST_VERIFIED_CAPABILITY
  }

  /**
   * Mint a token for a peer to present back at `input.aud`.
   *
   * `user-confirmed` is not special-cased here, and does not need to be: this
   * node signs it with its own key, so a token it issues can only ever be
   * accepted by a node that considers this node's `iss` to be itself — which is
   * the same statement rule S-1 makes from the verifying side.
   */
  issue(input: IssueInput): string {
    if (this.#keys === undefined) {
      throw new Error(
        `node ${this.node} has no signing key: capabilities can be verified but not issued`,
      )
    }
    return issueCapability(this.node, this.#keys, input)
  }

  #applyPolicy(
    message: QianmoMessage,
    level: CapabilityLevel,
    issuer: string | undefined,
  ): CapabilityDecision {
    if (satisfies(this.policy, message, level)) {
      this.#observe(message, level)
      return {
        ok: true,
        level,
        // Absent issuer means no token verified, which is the floor by
        // definition — there is nothing to have trusted.
        trust:
          issuer === undefined ? TRUST_UNTRUSTED : this.#tierFor(issuer, level),
        ...(issuer === undefined ? {} : { issuer }),
      }
    }
    return {
      ok: false,
      code: ProtocolErrorCode.E_CAP_INSUFFICIENT,
      reason: insufficientReason(message, this.policy, level),
    }
  }

  /**
   * §9.2 phase ①, in one place and after the verdict is already decided.
   *
   * Placed on the *admitted* branch on purpose. A message the real policy
   * already refused is not something the switch would change — it is refused
   * either way, and the router has recorded it — so counting it here would
   * inflate the one number the phase exists to produce.
   *
   * A throwing sink is not allowed to change the verdict: it is swallowed,
   * because the alternative is an observation mode that can refuse traffic,
   * which is the exact property this mode is defined by not having.
   */
  #observe(message: QianmoMessage, level: CapabilityLevel): void {
    const shadow = this.#shadowPolicy
    const sink = this.#onShadowRefusal
    if (shadow === undefined || sink === undefined) return
    if (satisfies(shadow, message, level)) return
    try {
      sink({
        type: message.type,
        from: message.from,
        traceId: message.traceId,
        taskId: message.taskId,
        msgId: message.msgId,
        required: shadow.requiredLevel(message),
        presented: level,
        code: ProtocolErrorCode.E_CAP_INSUFFICIENT,
        reason: insufficientReason(message, shadow, level),
      })
    } catch {
      // Nothing to do with it here, and nowhere honest to put it: this method
      // has no verdict to fail.
    }
  }
}

/**
 * The sentence a refusal carries, built once.
 *
 * Shared between the real refusal and the shadow record deliberately: the
 * whole claim observation mode makes is "this is what you would have seen",
 * and two independently worded versions of it stop being that the first time
 * one of them is edited.
 */
function insufficientReason(
  message: QianmoMessage,
  policy: CapabilityPolicy,
  level: CapabilityLevel,
): string {
  const required = policy.requiredLevel(message)
  const sender = parseAddress(message.from)
  return `${message.type} from ${sender === null ? 'an unparseable sender' : sender.node} needs ${required}, presented ${level}`
}
