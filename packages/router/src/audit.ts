// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The routing layer's audit trail.
 *
 * AC-3 does not ask merely that a loop be cut — it asks that cutting it leave
 * **one event carrying the whole message chain**. A cut that vanishes is
 * indistinguishable from a message that was never sent, which is exactly the
 * failure mode an operator cannot debug. So the chain fields are assembled in
 * one place ({@link chainDetail}) rather than at each call site: a detail that
 * omits `traceId` would satisfy a reviewer reading the code and fail the
 * acceptance criterion reading the log.
 *
 * ## Why three event types and not one with a `layer` field
 *
 * Charter AC-3 requires the two rate-limiting layers to be verified
 * independently and says in as many words that they must not be conflated. A
 * single `rate_limited` event with a `layer: 'runtime' | 'protocol'` field
 * would put both under one counter, and every question afterwards ("did the
 * protocol budget ever trip?") would depend on remembering to filter. Separate
 * types make the wrong query impossible rather than merely discouraged:
 *
 * | type                | layer    | in protocol.md §8 state machine? |
 * |---------------------|----------|----------------------------------|
 * | `loop_detected`     | protocol | yes — terminal state             |
 * | `rate_limited`      | protocol | yes — terminal state             |
 * | `runtime_throttled` | runtime  | **no**, by §6.4                  |
 */

import type { QianmoMessage } from '@qianmo/protocol'

/** Everything the routing layer writes down. */
export enum RouterEventType {
  /**
   * A message was cut as a loop — either the `(handler, taskId)` revisit that
   * is the real detector, or the `LIMITS.maxHops` backstop behind it.
   * protocol.md §8.2 row 11.
   */
  LoopDetected = 'loop_detected',
  /**
   * The **protocol layer's** inbound budget for one sender was exhausted.
   * protocol.md §8.2 row 10, terminal state `rate_limited`.
   */
  RateLimited = 'rate_limited',
  /**
   * A message was refused by the authorization gate (P4.3): a forged or
   * mis-bound token, a `user-confirmed` claim from a remote issuer (rule S-1),
   * or a level below what this node requires for that message.
   *
   * Separate from the two rate events because the question it answers is a
   * different one — "who is allowed to ask" rather than "how often" — and
   * because charter C-5's judgement is *refused **and** on the record*.
   */
  CapabilityDenied = 'capability_denied',
  /**
   * The **runtime layer's** per-sender-per-target token bucket refused an
   * outbound send. Deliberately not a protocol state: protocol.md §6.4 puts
   * this layer outside the state machine, and an event type that reads like a
   * wire state would invite exactly the mixing that rule forbids.
   */
  RuntimeThrottled = 'runtime_throttled',
}

/** One audit record. `detail` is free-form but must stay JSON-serializable. */
export interface RouterAuditEvent {
  readonly type: RouterEventType
  /** Epoch milliseconds. */
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

/** Somewhere durable for events to go, beyond the in-memory ring. */
export type RouterAuditSink = (event: RouterAuditEvent) => void

/** How many events {@link RouterAuditLog} keeps before it starts overwriting. */
export const DEFAULT_ROUTER_AUDIT_CAPACITY = 512

/**
 * The message chain an AC-3 event has to carry.
 *
 * `hops` is rendered as a readable path rather than kept as an array because
 * the sink contract is flat scalars — and because the one question an operator
 * asks of this field is "where has it been", which a path answers and a JSON
 * array does not.
 */
export function chainDetail(
  message: QianmoMessage,
): Readonly<Record<string, string | number>> {
  return {
    traceId: message.traceId,
    taskId: message.taskId,
    msgId: message.msgId,
    from: message.from,
    to: message.to,
    type: message.type,
    hops: message.hops.join(' -> '),
    hopCount: message.hops.length,
  }
}

/**
 * A bounded ring of recent events plus an unbounded per-type tally.
 *
 * Same shape as the activator's log and deliberately not imported from it: the
 * dependency would run backwards (the activator depends on this package), and
 * copying forty lines is cheaper than the cycle that sharing them would create.
 */
export class RouterAuditLog {
  readonly #events: RouterAuditEvent[] = []
  readonly #counts = new Map<RouterEventType, number>()
  readonly #capacity: number
  readonly #sink: RouterAuditSink | undefined

  constructor(
    capacity: number = DEFAULT_ROUTER_AUDIT_CAPACITY,
    sink?: RouterAuditSink,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `router audit capacity must be a positive integer, got ${capacity}`,
      )
    }
    this.#capacity = capacity
    this.#sink = sink
  }

  /** Record one event. Never throws on account of the sink. */
  record(
    type: RouterEventType,
    at: number,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): RouterAuditEvent {
    const event: RouterAuditEvent = { type, at, detail }
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1)
    if (this.#sink !== undefined) {
      try {
        this.#sink(event)
      } catch {
        // A failing sink must not turn "we cut a loop" into "we threw while
        // cutting a loop": the caller is mid-rejection and the ring above
        // already holds the evidence.
      }
    }
    return event
  }

  /** Events still in the ring, oldest first. */
  events(): readonly RouterAuditEvent[] {
    return [...this.#events]
  }

  /** Events of one type still in the ring, oldest first. */
  of(type: RouterEventType): readonly RouterAuditEvent[] {
    return this.#events.filter(event => event.type === type)
  }

  /** How many events of this type were ever recorded, ring evictions included. */
  count(type: RouterEventType): number {
    return this.#counts.get(type) ?? 0
  }
}
