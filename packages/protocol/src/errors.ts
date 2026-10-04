// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Stable, wire-visible error codes for the Qianmo protocol. */
export enum ProtocolErrorCode {
  /** The value is not a message-shaped object, or a required field is missing. */
  E_BAD_ENVELOPE = 'E_BAD_ENVELOPE',
  /** Envelope version is unknown or unsupported. */
  E_BAD_VERSION = 'E_BAD_VERSION',
  /** `from` / `to` is not a well-formed `qianmo://<node>/<agent>` address. */
  E_BAD_ADDRESS = 'E_BAD_ADDRESS',
  /** `type` is not a member of {@link MessageType}. */
  E_BAD_TYPE = 'E_BAD_TYPE',
  /** Serialized message exceeds `LIMITS.maxMessageBytes`. */
  E_TOO_LARGE = 'E_TOO_LARGE',
  /** The DELIVERY deadline `createdAt + deliverTtlMs` is in the past. */
  E_TTL_EXPIRED = 'E_TTL_EXPIRED',
  /** `hops` is longer than `LIMITS.maxHops`. */
  E_TOO_MANY_HOPS = 'E_TOO_MANY_HOPS',
  /** Loop detected on `(handler address, taskId)` — see protocol.md §6.1. */
  E_LOOP = 'E_LOOP',
  /** Sender exceeded `LIMITS.ratePerMinute`. */
  E_RATE_LIMITED = 'E_RATE_LIMITED',
  /** The destination agent is unknown to this node. */
  E_UNKNOWN_AGENT = 'E_UNKNOWN_AGENT',
  /** The TASK deadline `createdAt + taskTtlMs` passed with no terminal result. */
  E_TASK_TIMEOUT = 'E_TASK_TIMEOUT',
  /** The target accepted the task but its execution ended unsuccessfully. */
  E_TASK_FAILED = 'E_TASK_FAILED',
  /** The target mailbox evicted the message while compacting. */
  E_EVICTED = 'E_EVICTED',
  /** The last hop could not write the message into the target mailbox. */
  E_UNDELIVERABLE = 'E_UNDELIVERABLE',
  /** A blob-referenced payload is gone or fails its checksum. */
  E_PAYLOAD_UNAVAILABLE = 'E_PAYLOAD_UNAVAILABLE',
  /** Capability token failed signature / `aud` / `exp` / `nonce` validation. */
  E_CAP_INVALID = 'E_CAP_INVALID',
  /**
   * Capability level is too low for the requested action, or a
   * `user-confirmed` token was not issued by this very node.
   */
  E_CAP_INSUFFICIENT = 'E_CAP_INSUFFICIENT',
  /** `costLimit` is non-zero — M0 caps every message at zero spend. */
  E_BUDGET_EXHAUSTED = 'E_BUDGET_EXHAUSTED',
  /**
   * A resource negotiation was refused: over the lender's ceiling, an offer
   * that has expired, or an offer that is not on the table (§13).
   */
  E_RESOURCE_REFUSED = 'E_RESOURCE_REFUSED',
  /**
   * The node is not taking new work: its turn queue is at
   * `LIMITS.maxQueuedTurns`, or an operator has engaged the emergency stop.
   *
   * **Post-legacy — subject to rule N-1** (see {@link LEGACY_ERROR_CODES}).
   * One code with two reasons rather than two codes, because every additional
   * code carries the compatibility weight described below and because a sender
   * does the same thing about both: come back later.
   */
  E_BUSY = 'E_BUSY',
}

/**
 * The codes every v0 node has always understood — the floor of the code table.
 *
 * ## Rule N-1: a new error code is not a free addition
 *
 * `isTaskResultPayload` checks membership in the *local* code set, so a peer
 * built before a code existed does not read a `task.result{failed}` carrying it
 * as "an outcome I cannot name". It reads the whole payload as malformed and
 * **refuses the message** — the result does not arrive at all, and the sender
 * waits out its task deadline for an answer that was already computed.
 *
 * Hence the rule, written down in protocol.md §11: a post-legacy code may only
 * be put on the wire towards a peer that has declared it speaks the release the
 * code shipped in (§2.7 capability discovery). Towards every other peer it is
 * downgraded to the nearest legacy code — {@link downgradeErrorCode}.
 *
 * This list is written out rather than derived from the enum: deriving it would
 * quietly move the floor every time a code is added, which is the one thing it
 * exists to hold still.
 */
export const LEGACY_ERROR_CODES: readonly ProtocolErrorCode[] = Object.freeze([
  ProtocolErrorCode.E_BAD_ENVELOPE,
  ProtocolErrorCode.E_BAD_VERSION,
  ProtocolErrorCode.E_BAD_ADDRESS,
  ProtocolErrorCode.E_BAD_TYPE,
  ProtocolErrorCode.E_TOO_LARGE,
  ProtocolErrorCode.E_TTL_EXPIRED,
  ProtocolErrorCode.E_TOO_MANY_HOPS,
  ProtocolErrorCode.E_LOOP,
  ProtocolErrorCode.E_RATE_LIMITED,
  ProtocolErrorCode.E_UNKNOWN_AGENT,
  ProtocolErrorCode.E_TASK_TIMEOUT,
  ProtocolErrorCode.E_TASK_FAILED,
  ProtocolErrorCode.E_EVICTED,
  ProtocolErrorCode.E_UNDELIVERABLE,
  ProtocolErrorCode.E_PAYLOAD_UNAVAILABLE,
  ProtocolErrorCode.E_CAP_INVALID,
  ProtocolErrorCode.E_CAP_INSUFFICIENT,
  ProtocolErrorCode.E_BUDGET_EXHAUSTED,
  ProtocolErrorCode.E_RESOURCE_REFUSED,
])

const LEGACY_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(
  LEGACY_ERROR_CODES,
)

/** True when `code` is one every peer, however old, can already parse. */
export function isLegacyErrorCode(code: ProtocolErrorCode): boolean {
  return LEGACY_ERROR_CODE_SET.has(code)
}

/**
 * Nearest legacy code for each post-legacy one (rule N-1).
 *
 * `E_BUSY` → `E_RATE_LIMITED`: both say "this node will not take it right now,
 * try later", which is the whole of what the sender acts on. The loss is
 * diagnostic detail in the `reason` string, not a change of outcome.
 */
const CODE_DOWNGRADES: Readonly<
  Partial<Record<ProtocolErrorCode, ProtocolErrorCode>>
> = Object.freeze({
  [ProtocolErrorCode.E_BUSY]: ProtocolErrorCode.E_RATE_LIMITED,
})

/**
 * The legacy code that stands in for `code`, or `code` itself when it is
 * already legacy.
 *
 * Every post-legacy code must have an entry in {@link CODE_DOWNGRADES}; one
 * that does not is returned unchanged, which is the loud failure (a peer
 * refusing the message) rather than a silent one.
 */
export function downgradeErrorCode(code: ProtocolErrorCode): ProtocolErrorCode {
  if (isLegacyErrorCode(code)) return code
  return CODE_DOWNGRADES[code] ?? code
}

/** A single reason why a message was rejected. */
export interface ProtocolIssue {
  readonly code: ProtocolErrorCode
  /** Offending field path, or `""` when the whole envelope is at fault. */
  readonly field: string
  readonly message: string
}

/** Convenience constructor for {@link ProtocolIssue}. */
export function issue(
  code: ProtocolErrorCode,
  field: string,
  message: string,
): ProtocolIssue {
  return { code, field, message }
}

/** Error carrying a {@link ProtocolErrorCode}, thrown by the `assert*` helpers. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode
  readonly field: string
  readonly issues: readonly ProtocolIssue[]

  constructor(issues: readonly ProtocolIssue[]) {
    const first = issues[0]
    super(first ? `${first.code}: ${first.message}` : 'protocol error')
    this.name = 'ProtocolError'
    this.code = first?.code ?? ProtocolErrorCode.E_BAD_ENVELOPE
    this.field = first?.field ?? ''
    this.issues = issues
  }
}
