// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseAddress } from './address.js'
import {
  ProtocolError,
  ProtocolErrorCode,
  downgradeErrorCode,
  isLegacyErrorCode,
  issue,
} from './errors.js'
import { computeFingerprint } from './fingerprint.js'
import { LIMITS } from './limits.js'

/** Envelope version currently spoken on the network. */
export const ENVELOPE_VERSION = 0

/** Every message kind the v0 protocol carries. */
export enum MessageType {
  /** Ask an agent to perform work. */
  TaskRequest = 'task.request',
  /**
   * A-class acknowledgement: the target agent has taken the message into its
   * input. Payload is field-closed — see {@link AckPayload}.
   */
  Ack = 'ack',
  /** Terminal answer to a `task.request`, correlated by `taskId` (C-1). */
  TaskResult = 'task.result',
  /** Liveness probe. */
  Ping = 'ping',
  /** Reply to `ping`. */
  Pong = 'pong',
  /** Bring a sleeping agent back to `running`. */
  Wake = 'wake',
  /** Delivery or processing failure, payload carries a ProtocolErrorCode. */
  Error = 'error',
  /** Ask a peer to lend capacity (P5.2, §13). */
  ResourceRequest = 'resource.request',
  /** Answer to a request: terms, and how long they stand. */
  ResourceOffer = 'resource.offer',
  /** Take an offer. */
  ResourceGrant = 'resource.grant',
  /** End a lease, from either side. */
  ResourceRelease = 'resource.release',
  /**
   * Node-originated announcement: the handling node telling a peer it already
   * has a channel with that something happened (protocol.md §14).
   *
   * The only type an agent raises on its own initiative. It is not a reply, it
   * opens no turn on the receiver, it carries a **fresh** `taskId` every time,
   * and it asks for no protocol `ack` — see {@link createNotify} for why each
   * of those is load-bearing rather than incidental.
   */
  Notify = 'notify',
}

/** All message types, in declaration order. */
export const MESSAGE_TYPES: readonly MessageType[] = Object.freeze(
  Object.values(MessageType),
)

/**
 * The types every v0 node has always spoken — the floor of capability
 * discovery (protocol.md §14.6).
 *
 * A peer that declares nothing is assumed to speak exactly these, so a type
 * added after this list must be declared before it is used. Written out rather
 * than derived from the enum for the same reason `LEGACY_ERROR_CODES` is: a
 * derived floor would rise on its own every time the enum grows, and a floor
 * that moves is not a floor.
 */
export const LEGACY_MESSAGE_TYPES: readonly MessageType[] = Object.freeze([
  MessageType.TaskRequest,
  MessageType.Ack,
  MessageType.TaskResult,
  MessageType.Ping,
  MessageType.Pong,
  MessageType.Wake,
  MessageType.Error,
  MessageType.ResourceRequest,
  MessageType.ResourceOffer,
  MessageType.ResourceGrant,
  MessageType.ResourceRelease,
])

const LEGACY_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set<string>(
  LEGACY_MESSAGE_TYPES,
)

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set<string>(MESSAGE_TYPES)

/** True when `value` is one of the known {@link MessageType} members. */
export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && MESSAGE_TYPE_SET.has(value)
}

/**
 * Message types that *answer* an earlier message under its `taskId`, rather
 * than asking a handler to do something.
 *
 * The distinction is not cosmetic: it is what keeps loop detection (D-2) from
 * eating the reply path. A reply is addressed back at the requester and
 * carries the request's `taskId` by contract (C-1), so `(handler, taskId)`
 * revisit — the loop key — is the *expected* shape of a correct `ack` and a
 * correct `task.result`. Judging replies by that key would declare AC-2's
 * return path a loop on its first message.
 *
 * **`notify` is deliberately absent**, and the reason is positive rather than
 * "it happens not to be an answer". The exemption exists for types that are
 * *forced* to reuse somebody else's `taskId`; `notify` reuses none (every one
 * carries a fresh id — {@link createNotify}), so it never takes the shape the
 * exemption was written for. Granting it the exemption anyway would open a hole
 * in the loop net that any message can walk through by calling itself a
 * notification.
 */
export function isReplyType(type: MessageType): boolean {
  return (
    type === MessageType.Ack ||
    type === MessageType.TaskResult ||
    type === MessageType.Error ||
    type === MessageType.Pong ||
    // A negotiation runs both ways over one task id by design (§13), so every
    // message after the opening request answers the one before it. Treating
    // them as requests would make the second leg of every negotiation look
    // like a handler being revisited — which is exactly what the loop key
    // describes.
    type === MessageType.ResourceOffer ||
    type === MessageType.ResourceGrant ||
    type === MessageType.ResourceRelease
  )
}

/**
 * The only value the **envelope's** `trust` field ever takes: what a message
 * says about its own trustworthiness is worth nothing, so the field is pinned
 * and `validate.ts` refuses anything else.
 *
 * It is also the floor of {@link NoticeTrust} — the receiver-written tier — so
 * that the two labels cannot drift into disagreeing about the word for "no
 * evidence at all". They remain two different statements: this constant on the
 * envelope is a sender's self-description, the same constant on a notice is
 * the receiver's own finding.
 */
export const TRUST_UNTRUSTED = 'untrusted'

/**
 * The receiver's finding that a message was authorized by a subject this node
 * was explicitly configured to trust, for this task alone (issue #28).
 *
 * **Never a wire value.** It is produced by `@qianmo/capability` *after* a
 * presented token verified, carried through the routing layer, and rendered by
 * `@qianmo/adapter` into the mailbox notice. No sender can put it anywhere:
 * the envelope's `trust` field is still pinned to {@link TRUST_UNTRUSTED}, and
 * the only field of the envelope this tier is derived from — `cap` — is a
 * signature this node checked against a public key it was handed out of band.
 *
 * What it claims is narrow, and the notice text says so in the same words: the
 * *request* is authorized, the *content* is still remote text.
 */
export const NOTICE_TRUST_VERIFIED_CAPABILITY = 'verified-capability'

/**
 * The two tiers a receiver-written provenance notice can carry (§9.4).
 *
 * A closed union with a default: everything is {@link TRUST_UNTRUSTED} unless
 * a verification result says otherwise, so a layer that forgets to pass the
 * tier along produces the safe value rather than an absent one.
 */
export type NoticeTrust =
  | typeof TRUST_UNTRUSTED
  | typeof NOTICE_TRUST_VERIFIED_CAPABILITY

/**
 * Provenance label (protocol.md §10.2).
 *
 * The receiving node fills this in from what it can verify itself; it never
 * takes the envelope's own account of where it came from. A sender still has
 * to emit the field — it seeds `node` / `agent` from its own `from` address,
 * and the receiver overwrites all of it on the way in.
 */
export interface MessageOrigin {
  /** Source node segment. */
  readonly node: string
  /** Source agent segment. */
  readonly agent: string
  /** `iss` of the capability token presented, when there was one. */
  readonly capIss?: string
  /** Epoch ms at which this node took the message in. */
  readonly receivedAt?: number
}

/**
 * The v0 wire envelope. Immutable by contract: routing produces new envelopes
 * (see {@link withHop}) rather than mutating one in flight.
 */
export interface QianmoMessage<P = unknown> {
  /** Envelope version. Always `0` for this release. */
  readonly v: 0
  /**
   * Unique id of *this transmission*. An at-least-once retransmission keeps
   * the same value — it is the receiver's first-level dedup key (§7.2).
   */
  readonly msgId: string
  /**
   * W3C `traceparent`: `00-<32 hex>-<16 hex>-<2 hex>` (§7.1). Only the
   * trace-id segment is stable across hops. Audit correlation only — the
   * request/reply correlation key is {@link QianmoMessage.taskId} (C-1).
   */
  readonly traceId: string
  /**
   * Task identifier. Half of the loop-detection key (D-2), the correlation
   * key between a request and its ack / result (C-1), and part of the
   * content fingerprint.
   */
  readonly taskId: string
  /** Conversation context spanning several tasks. Optional (A2A alignment). */
  readonly contextId?: string
  /** Sender address, `qianmo://<node>/<agent>`. */
  readonly from: string
  /** Recipient address, `qianmo://<node>/<agent>`. */
  readonly to: string
  readonly type: MessageType
  /**
   * Business payload, discriminated by `type`. Cross-node content is always
   * untrusted, and it must never restate an envelope field (no second `to`,
   * no second deadline, no second trace) — routing and business must not have
   * two sources of truth.
   */
  readonly payload: P
  /** Epoch milliseconds when the sender created the envelope. */
  readonly createdAt: number
  /**
   * DELIVERY deadline in ms from `createdAt`, covering `created → acked`
   * (§5.1). Expiry lands the message in `expired`.
   */
  readonly deliverTtlMs: number
  /**
   * TASK deadline in ms from `createdAt`, covering
   * `created → completed / failed` (§5.1). Expiry lands the message in
   * `timeout`.
   */
  readonly taskTtlMs: number
  /**
   * Node names already traversed, oldest first. A `maxHops` backstop and an
   * audit trail — **not** the loop detector (§6.2).
   */
  readonly hops: readonly string[]
  /** Content fingerprint, the second-level dedup key (§7.2). */
  readonly fingerprint: string
  /** Provenance label, authoritative only once the receiver has written it. */
  readonly origin: MessageOrigin
  /** Trust marker. Always {@link TRUST_UNTRUSTED}. */
  readonly trust: typeof TRUST_UNTRUSTED
  /** Capability token (Ed25519, detached signature). Absent means read-only. */
  readonly cap?: string
  /**
   * Hard spending ceiling. M0 pins it to `0` (charter N-1): the field exists
   * so the "a hard cap can stop the message" mechanism is exercised, nothing
   * more. A non-zero value is rejected outbound with `E_BUDGET_EXHAUSTED`.
   */
  readonly costLimit: number
}

/** Fields a caller supplies to {@link createMessage}; the rest are defaulted. */
export interface CreateMessageInput<P = unknown> {
  readonly from: string
  readonly to: string
  readonly type: MessageType
  readonly payload: P
  readonly msgId?: string
  readonly traceId?: string
  readonly taskId?: string
  readonly contextId?: string
  readonly createdAt?: number
  readonly deliverTtlMs?: number
  readonly taskTtlMs?: number
  readonly hops?: readonly string[]
  /** Override the computed fingerprint. Only re-senders should need this. */
  readonly fingerprint?: string
  readonly origin?: MessageOrigin
  readonly cap?: string
  readonly costLimit?: number
}

/** Fresh, collision-resistant identifier for envelopes and tasks. */
export function newId(): string {
  return crypto.randomUUID()
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A fresh W3C `traceparent` (§7.1): `00-<32 hex>-<16 hex>-01`.
 *
 * Sampled (`01`) because C-6 wants every cross-node message reconstructable
 * from the audit log. Per-hop `parent-id` regeneration is the routing layer's
 * job; the trace-id segment is what stays constant end to end.
 */
export function newTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`
}

const TRACEPARENT_PATTERN = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/

/**
 * Continue a trace at the next hop: same trace-id, fresh parent-id (§7.1).
 *
 * W3C `traceparent` names the *caller's* span in `parent-id`, so a relay that
 * passes the header through unchanged tells every downstream span that its
 * parent is the origin — the chain flattens and "who forwarded this to whom"
 * stops being answerable, which is the one question C-6 asks of the field.
 * Only the trace-id segment is meant to survive a hop, and it is what audit
 * correlation keys on.
 *
 * A value that is not a well-formed traceparent is returned untouched: this
 * function is not a validator, and inventing a header for a malformed one
 * would hide the malformation from the check that does reject it.
 */
export function advanceTraceparent(traceparent: string): string {
  if (!TRACEPARENT_PATTERN.test(traceparent)) return traceparent
  const [version, traceId, , flags] = traceparent.split('-')
  return `${version}-${traceId}-${randomHex(8)}-${flags}`
}

function originOf(from: string): MessageOrigin {
  const parsed = parseAddress(from)
  // A malformed `from` is caught by validation; do not invent a provenance.
  return parsed === null
    ? { node: '', agent: '' }
    : { node: parsed.node, agent: parsed.agent }
}

/**
 * Build a well-formed envelope, defaulting every field the caller omits:
 * ids, `traceId` as a fresh traceparent, both deadlines from `LIMITS`, an
 * empty hop list, the computed fingerprint, an origin seeded from `from`,
 * `trust` and a zero `costLimit`.
 */
export function createMessage<P>(
  input: CreateMessageInput<P>,
): QianmoMessage<P> {
  const taskId = input.taskId ?? newId()
  return {
    v: ENVELOPE_VERSION,
    msgId: input.msgId ?? newId(),
    traceId: input.traceId ?? newTraceparent(),
    taskId,
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
    from: input.from,
    to: input.to,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt ?? Date.now(),
    deliverTtlMs: input.deliverTtlMs ?? LIMITS.defaultTtlMs,
    taskTtlMs: input.taskTtlMs ?? LIMITS.defaultTaskTtlMs,
    hops: Object.freeze([...(input.hops ?? [])]),
    fingerprint:
      input.fingerprint ??
      computeFingerprint({
        from: input.from,
        to: input.to,
        type: input.type,
        taskId,
        payload: input.payload,
      }),
    origin: input.origin ?? originOf(input.from),
    trust: TRUST_UNTRUSTED,
    ...(input.cap === undefined ? {} : { cap: input.cap }),
    costLimit: input.costLimit ?? 0,
  }
}

/**
 * Append `node` to the hop list, returning a new envelope.
 *
 * Wiring — protocol.md §6.3 pins the call sites to **exactly two**, and the
 * router built in P4.2 must honour that:
 *
 * 1. **Initial seeding**: the sender calls `withHop(msg, selfNode)` after
 *    {@link createMessage} and before handing the envelope to the transport,
 *    so `hops[0]` is the originating node. Skipping this leaves the audit
 *    chain headless and under-counts `maxHops` by one.
 * 2. **Before forwarding**: a relay calls it before passing the envelope on.
 *
 * The **terminal node does not call it** — it forwards nothing, so appending
 * itself would only inflate the hop count of the reply. One sentence: call it
 * right before handing a message to the transport, first time or n-th time.
 *
 * `hops` is a `maxHops` backstop plus an audit trail; it is **not** the loop
 * detector (D-2). Loop detection is keyed on `(handler address, taskId)` and
 * lives in the routing layer, not in this package — a node may legitimately be
 * traversed twice for two different handlers.
 *
 * Throws {@link ProtocolError} with `E_TOO_MANY_HOPS` when the append would
 * overflow `LIMITS.maxHops` — routers must reject instead of forwarding.
 */
export function withHop<P>(
  message: QianmoMessage<P>,
  node: string,
): QianmoMessage<P> {
  if (message.hops.length + 1 > LIMITS.maxHops) {
    throw new ProtocolError([
      issue(
        ProtocolErrorCode.E_TOO_MANY_HOPS,
        'hops',
        `hop limit ${LIMITS.maxHops} exceeded`,
      ),
    ])
  }
  return { ...message, hops: Object.freeze([...message.hops, node]) }
}

/**
 * Epoch ms at which delivery gives up: `createdAt + deliverTtlMs` (§5.1).
 *
 * The end of this window is `acked` — the target agent having actually read
 * the message — not "written into the mailbox". A message that made it to
 * disk but was then evicted has *not* been delivered, and this deadline is
 * what still catches it (§4.5).
 */
export function deliveryExpiresAt(message: QianmoMessage): number {
  return message.createdAt + message.deliverTtlMs
}

/**
 * True when the DELIVERY deadline has passed at `now` → terminal `expired`.
 *
 * Evaluated in three places, none skippable (rule T-1): before sending, on
 * arrival before the mailbox write, and while watching for the read flag.
 * The last two must first clear the time-jump gate (T-2) — a node that just
 * thawed would otherwise judge every in-flight message dead at once.
 */
export function isDeliveryExpired(
  message: QianmoMessage,
  now: number = Date.now(),
): boolean {
  return now > deliveryExpiresAt(message)
}

/** Epoch ms at which the task gives up: `createdAt + taskTtlMs` (§5.1). */
export function taskExpiresAt(message: QianmoMessage): number {
  return message.createdAt + message.taskTtlMs
}

/**
 * True when the TASK deadline has passed at `now` → terminal `timeout`.
 *
 * This is the sender-side deadline for a terminal `task.result`; it is the
 * one that may absorb the seconds of working-set warm-up an A-class ack
 * deliberately excludes (§4.3).
 */
export function isTaskExpired(
  message: QianmoMessage,
  now: number = Date.now(),
): boolean {
  return now > taskExpiresAt(message)
}

/** Canonical JSON encoding used for size accounting and transport. */
export function serializeMessage(message: QianmoMessage): string {
  return JSON.stringify(message)
}

const ENCODER = new TextEncoder()

/** Size of the serialized envelope in bytes (UTF-8). */
export function messageBytes(message: QianmoMessage): number {
  return ENCODER.encode(serializeMessage(message)).length
}

/**
 * Payload of an `ack`, and the whole of it (rule K-1, protocol.md §4.3).
 *
 * `ack` is A-class: it asserts that the target agent has taken the message
 * into its input — the `read` flag flipped — and nothing else. Correlation
 * identifiers remain in the envelope, so the payload only names the handler
 * and the instant at which it observed the read.
 */
export interface AckPayload {
  /** Address of the acknowledging handler, `qianmo://<node>/<agent>`. */
  readonly handler: string
  /** Local epoch ms at which the read flag was observed. */
  readonly ackAt: number
}

const ACK_PAYLOAD_KEYS: readonly string[] = ['handler', 'ackAt']

/** True when `value` is an {@link AckPayload} with no extra fields. */
export function isAckPayload(value: unknown): value is AckPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  if (keys.length !== ACK_PAYLOAD_KEYS.length) return false
  if (!ACK_PAYLOAD_KEYS.every(key => keys.includes(key))) return false
  const payload = value as Record<string, unknown>
  return (
    parseAddress(payload['handler']) !== null &&
    typeof payload['ackAt'] === 'number' &&
    Number.isFinite(payload['ackAt']) &&
    payload['ackAt'] > 0
  )
}

/**
 * Marker carried by a reply the sender's delivery ledger is re-sending.
 *
 * `true` or absent, never `false`, for the reason spelled out on
 * {@link NotifyPayload.redelivered}: two encodings of one fact are two
 * fingerprints for one message, which defeats the honesty the flag exists for.
 *
 * A redelivery is a **new envelope** — new `msgId`, new `createdAt`, same
 * `taskId` — because retransmitting the original after its `deliverTtlMs` has
 * passed earns an `E_TTL_EXPIRED` and nothing else (protocol.md §14.4③). So
 * neither level of the receiver's dedup absorbs it silently, which is the
 * point: the duplicate is visible, and `taskId` is what the receiver suppresses
 * it by.
 */
type Redelivered = true

/**
 * Terminal result of a `task.request`.
 *
 * Closed apart from {@link Redelivered}, which is optional in both branches.
 */
export type TaskResultPayload =
  | {
      readonly outcome: 'completed'
      readonly content: string
      readonly completedAt: number
      readonly redelivered?: Redelivered
    }
  | {
      readonly outcome: 'failed'
      readonly code: ProtocolErrorCode
      readonly reason: string
      readonly completedAt: number
      readonly redelivered?: Redelivered
    }

/** Input accepted by {@link createTaskResult}; the factory supplies the clock. */
export type TaskResultInput =
  | {
      readonly outcome: 'completed'
      readonly content: string
      readonly redelivered?: Redelivered
    }
  | {
      readonly outcome: 'failed'
      readonly code: ProtocolErrorCode
      readonly reason: string
      readonly redelivered?: Redelivered
    }

const TASK_RESULT_COMPLETED_KEYS: readonly string[] = [
  'outcome',
  'content',
  'completedAt',
]
const TASK_RESULT_FAILED_KEYS: readonly string[] = [
  'outcome',
  'code',
  'reason',
  'completedAt',
]
/**
 * The only key a `task.result` may carry beyond its branch's required set.
 *
 * Kept as a one-element whitelist rather than folded into the two arrays above
 * so the shape stays readable as what it is: a closed payload with a single
 * documented exception, not a payload that has started accepting extras.
 */
const TASK_RESULT_OPTIONAL_KEYS: ReadonlySet<string> = new Set<string>([
  'redelivered',
])
const PROTOCOL_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(ProtocolErrorCode),
)

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every(key => keys.includes(key))
  )
}

/**
 * Every key present is either required by the branch or the one permitted
 * optional, and every required key is present.
 *
 * This is the exact-count check the two branches used to get, widened by
 * exactly one field. The property that mattered — a peer cannot smuggle
 * business fields into a terminal result — is unchanged, because an unlisted
 * key is still a rejection.
 */
function hasTaskResultKeys(
  payload: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(payload)
  return (
    keys.every(
      key => required.includes(key) || TASK_RESULT_OPTIONAL_KEYS.has(key),
    ) && required.every(key => keys.includes(key))
  )
}

/** True when `value` is a well-formed successful or failed task result. */
export function isTaskResultPayload(
  value: unknown,
): value is TaskResultPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const payload = value as Record<string, unknown>
  const completedAt = payload['completedAt']
  if (
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt) ||
    completedAt <= 0
  ) {
    return false
  }
  // Only `true`. See {@link Redelivered}.
  if ('redelivered' in payload && payload['redelivered'] !== true) return false
  if (payload['outcome'] === 'completed') {
    return (
      hasTaskResultKeys(payload, TASK_RESULT_COMPLETED_KEYS) &&
      typeof payload['content'] === 'string'
    )
  }
  if (payload['outcome'] === 'failed') {
    return (
      hasTaskResultKeys(payload, TASK_RESULT_FAILED_KEYS) &&
      typeof payload['code'] === 'string' &&
      PROTOCOL_ERROR_CODES.has(payload['code']) &&
      typeof payload['reason'] === 'string' &&
      payload['reason'].length > 0
    )
  }
  return false
}

/** Build the A-class `ack` after `handler` observes the input read. */
export function createAck(
  original: QianmoMessage,
  handler: string,
  now: number = Date.now(),
): QianmoMessage<AckPayload> {
  return createMessage({
    from: handler,
    to: original.from,
    type: MessageType.Ack,
    traceId: original.traceId,
    taskId: original.taskId,
    ...(original.contextId === undefined
      ? {}
      : { contextId: original.contextId }),
    createdAt: now,
    payload: { handler, ackAt: now },
  })
}

/** Build the terminal `task.result` for an original request. */
export function createTaskResult(
  original: QianmoMessage,
  handler: string,
  result: TaskResultInput,
  now: number = Date.now(),
): QianmoMessage<TaskResultPayload> {
  return createMessage({
    from: handler,
    to: original.from,
    type: MessageType.TaskResult,
    traceId: original.traceId,
    taskId: original.taskId,
    ...(original.contextId === undefined
      ? {}
      : { contextId: original.contextId }),
    createdAt: now,
    payload: { ...result, completedAt: now },
  })
}

/** Payload of a protocol `error`; correlation stays in the envelope. */
export interface ErrorPayload {
  readonly code: ProtocolErrorCode
  readonly reason: string
}

/** Build the standard `error` reply for a rejected message. */
export function errorReply(
  original: QianmoMessage,
  code: ProtocolErrorCode,
  reason: string,
  now: number = Date.now(),
): QianmoMessage<ErrorPayload> {
  return createMessage({
    from: original.to,
    to: original.from,
    type: MessageType.Error,
    traceId: original.traceId,
    taskId: original.taskId,
    ...(original.contextId === undefined
      ? {}
      : { contextId: original.contextId }),
    createdAt: now,
    payload: { code, reason },
  })
}

/** Node name embedded in `to`, or `null` when the address is malformed. */
export function destinationNode(message: QianmoMessage): string | null {
  return parseAddress(message.to)?.node ?? null
}

/** Where a `notify` came from. `watch` = a watch job; `task` = out-of-band
 * commentary on an existing task; `health` = the node talking about itself. */
export const NOTIFY_KINDS = ['watch', 'task', 'health'] as const

/** How loud a `notify` is. Ordering is informational, not a filter. */
export const NOTIFY_SEVERITIES = ['info', 'warn', 'error'] as const

/** Payload of a `notify` (protocol.md §14.2). Field-controlled, not field-closed. */
export interface NotifyPayload {
  readonly kind: (typeof NOTIFY_KINDS)[number]
  readonly severity: (typeof NOTIFY_SEVERITIES)[number]
  /**
   * One line, for a human.
   *
   * There is no separate ceiling on its length: charter §3.3 C-4 pins the
   * protocol's numbers at eight and this does not deserve a ninth, so the bound
   * is the one every payload already has, `LIMITS.maxMessageBytes`. Anything
   * long belongs in `detail`, and anything longer than that belongs on disk
   * behind a reference (§9.3).
   */
  readonly summary: string
  /** Local epoch ms at which the thing was *observed*, not sent. */
  readonly observedAt: number
  readonly detail?: string
  /**
   * Sender-side idempotency key. **The receiver does not consume it** (§14.4):
   * suppression by this key is the sending ledger's job, because the receiver
   * would need unbounded new per-context state to do the same work twice.
   */
  readonly dedupKey?: string
  /**
   * Set when the sender's ledger is re-sending a fact it already tried to
   * deliver. Honest at-least-once: a repeat is visible, never silent.
   *
   * `true` or absent, never `false` — two spellings of one fact would be two
   * different fingerprints for one notification.
   */
  readonly redelivered?: true
  /** Which task or watch job caused this. Audit correlation, **not** a
   * correlation key — rule C-1 keeps that role for `taskId` alone. */
  readonly causeTaskId?: string
}

const NOTIFY_REQUIRED_KEYS: readonly string[] = [
  'kind',
  'severity',
  'summary',
  'observedAt',
]
const NOTIFY_OPTIONAL_KEYS: readonly string[] = [
  'detail',
  'dedupKey',
  'redelivered',
  'causeTaskId',
]
const NOTIFY_ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  ...NOTIFY_REQUIRED_KEYS,
  ...NOTIFY_OPTIONAL_KEYS,
])
const NOTIFY_KIND_SET: ReadonlySet<string> = new Set<string>(NOTIFY_KINDS)
const NOTIFY_SEVERITY_SET: ReadonlySet<string> = new Set<string>(
  NOTIFY_SEVERITIES,
)

/**
 * True when `value` is a well-formed {@link NotifyPayload}.
 *
 * ## Why this one is a whitelist where `ack` counts keys
 *
 * `isAckPayload` demands an *exact* key set, which is the right shape for a
 * payload that has no optional fields: it says "a field this version does not
 * understand is a field nobody verified". `notify` has four optional fields, so
 * an exact count cannot express it — and the property exact counting buys
 * beyond a whitelist is "both ends must be the same version", which for this
 * type is a liability rather than an asset: the whole point of §14.6's
 * capability discovery is that a newer sender and an older receiver stay
 * interoperable.
 *
 * `isTaskResultPayload` sat with `ack` until P13.5 gave it {@link Redelivered},
 * and it now uses the same required-plus-whitelist shape for the same reason —
 * one optional field is still one more than an exact count can express.
 *
 * A whitelist keeps the property that actually matters — a remote peer cannot
 * smuggle business fields in — because an unlisted key is still a rejection.
 * **Do not "unify" this back to `hasExactKeys`**: every `notify` carrying an
 * optional field would start being refused as malformed.
 */
export function isNotifyPayload(value: unknown): value is NotifyPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const payload = value as Record<string, unknown>
  const keys = Object.keys(payload)
  if (!keys.every(key => NOTIFY_ALLOWED_KEYS.has(key))) return false
  if (!NOTIFY_REQUIRED_KEYS.every(key => keys.includes(key))) return false

  if (!NOTIFY_KIND_SET.has(payload['kind'] as string)) return false
  if (!NOTIFY_SEVERITY_SET.has(payload['severity'] as string)) return false
  if (
    typeof payload['summary'] !== 'string' ||
    payload['summary'].length === 0
  ) {
    return false
  }
  const observedAt = payload['observedAt']
  if (
    typeof observedAt !== 'number' ||
    !Number.isFinite(observedAt) ||
    observedAt <= 0
  ) {
    return false
  }
  if ('detail' in payload && typeof payload['detail'] !== 'string') return false
  if (
    'dedupKey' in payload &&
    (typeof payload['dedupKey'] !== 'string' ||
      payload['dedupKey'].length === 0)
  ) {
    return false
  }
  // Only `true`. See the field's own comment: `false` is the same fact as
  // absent, and one fact with two encodings fingerprints as two messages.
  if ('redelivered' in payload && payload['redelivered'] !== true) return false
  if (
    'causeTaskId' in payload &&
    (typeof payload['causeTaskId'] !== 'string' ||
      payload['causeTaskId'].length === 0)
  ) {
    return false
  }
  return true
}

/** What {@link createNotify} needs. Note the absence of a `taskId`. */
export interface CreateNotifyInput {
  /** Announcing handler, `qianmo://<node>/<agent>`. */
  readonly from: string
  /** Peer to announce to — one this node already has a channel with. */
  readonly to: string
  /**
   * The grouping key, and the reason this is **required** rather than optional
   * (§14.3): with a fresh `taskId` on every notification, `contextId` is the
   * only thing that says two of them belong to one watch job. A notification
   * without it cannot be grouped by anything downstream, so an omission would
   * only ever be an oversight.
   */
  readonly contextId: string
  readonly payload: NotifyPayload
  /** Defaults to `LIMITS.defaultNotifyTtlMs`. */
  readonly deliverTtlMs?: number
  readonly createdAt?: number
  readonly msgId?: string
  readonly traceId?: string
  readonly cap?: string
}

/**
 * Build a `notify`.
 *
 * Three properties are fixed here rather than left to callers, because each one
 * is a bug that only shows up on the *second* message:
 *
 * 1. **A fresh `taskId`, always.** The tempting alternative — reuse the task or
 *    job id that caused the notification — puts every notification of one job on
 *    the same `(handler, taskId)` loop key. The first is fresh and lands; the
 *    second is `E_LOOP` and is cut. There is no parameter to pass one in, so
 *    the mistake cannot be made from outside this function.
 * 2. **`taskTtlMs === deliverTtlMs`.** `notify` never enters the task state
 *    machine, but the envelope field is mandatory. Leaving it at the 5-minute
 *    default would leave a notification whose delivery window has already closed
 *    looking alive for another four and a half minutes to anything reading the
 *    state machine.
 * 3. **No `ack` is requested.** Not expressible in the envelope, and that is the
 *    point: A-class `ack` is defined (§4.3) as "the target agent took this into
 *    its input", and the hub is not an agent and has no mailbox to read from.
 *    Delivery evidence for `notify` is the transport receipt plus the sender's
 *    ledger; see protocol.md §14.5.
 */
export function createNotify(
  input: CreateNotifyInput,
): QianmoMessage<NotifyPayload> {
  const deliverTtlMs = input.deliverTtlMs ?? LIMITS.defaultNotifyTtlMs
  return createMessage<NotifyPayload>({
    from: input.from,
    to: input.to,
    type: MessageType.Notify,
    contextId: input.contextId,
    payload: input.payload,
    // Deliberately not forwarded from the caller: see (1) above.
    taskId: newId(),
    deliverTtlMs,
    taskTtlMs: deliverTtlMs,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.msgId === undefined ? {} : { msgId: input.msgId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.cap === undefined ? {} : { cap: input.cap }),
  })
}

/**
 * Resolve what a peer said it speaks: an absent or empty declaration means the
 * legacy floor, never "nothing" (protocol.md §14.6).
 *
 * Empty counts as absent on purpose — a peer that sends `supportedTypes: []`
 * has almost certainly built the list from a source that came up empty, and
 * reading that as "speaks no message type at all" would take a working link and
 * silence it.
 */
export function resolvePeerTypes(
  declared: readonly string[] | undefined,
): readonly string[] {
  return declared === undefined || declared.length === 0
    ? LEGACY_MESSAGE_TYPES
    : declared
}

/** True when the peer's declaration covers `type`. */
export function peerSupportsType(
  declared: readonly string[] | undefined,
  type: MessageType,
): boolean {
  return resolvePeerTypes(declared).includes(type)
}

/**
 * True when the peer's declaration proves it is newer than the legacy floor.
 *
 * v1 of the frame grammar has exactly **one** capability signal, and it names
 * message types. So this is the proxy rule N-1 has to use: a peer that declares
 * a type outside {@link LEGACY_MESSAGE_TYPES} is running a build from after the
 * floor, and therefore knows the error codes that shipped with it.
 *
 * The proxy holds as long as post-legacy codes ship alongside post-legacy
 * types, which is true of `E_BUSY` and `notify`. A future code that ships
 * *without* a new type would need a capability channel of its own —
 * protocol.md §12.3 records that as unfinished rather than pretending this
 * covers it.
 */
export function peerIsPostLegacy(
  declared: readonly string[] | undefined,
): boolean {
  if (declared === undefined) return false
  return declared.some(type => !LEGACY_MESSAGE_TYPE_SET.has(type))
}

/**
 * Rule N-1 applied: the code to actually put on the wire towards this peer.
 *
 * Call it at every point that puts a `ProtocolErrorCode` into a message aimed
 * at a peer — `task.result{failed}`, `error`, a rejected receipt. Sending a
 * post-legacy code to a peer that cannot parse it does not degrade to "an
 * outcome it cannot name"; it degrades to the message not arriving at all — the
 * `LEGACY_ERROR_CODES` doc comment in `errors.ts` traces that path.
 */
export function errorCodeForPeer(
  code: ProtocolErrorCode,
  declared: readonly string[] | undefined,
): ProtocolErrorCode {
  if (isLegacyErrorCode(code)) return code
  return peerIsPostLegacy(declared) ? code : downgradeErrorCode(code)
}
