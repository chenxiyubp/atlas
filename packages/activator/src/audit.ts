// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The audit trail shared by both faces of this component.
 *
 * P2.5's DoD ③ does not ask merely that a destructive call fail — it asks that
 * it *fail and leave an audit event*. A denial that vanishes is worse than no
 * denial at all: it tells the operator nothing was attempted. So the counter
 * for a denial is deliberately kept outside the ring buffer. The ring can drop
 * a routine heartbeat tick under pressure; it must never be able to drop the
 * evidence that someone reached for `destroy`.
 */

/** Everything worth writing down, on either face. */
export enum ActivatorEventType {
  /** A call was refused because it is outside the capability surface. */
  CapabilityDenied = 'capability.denied',
  /** A heartbeat reached the daemon. */
  KeepaliveTick = 'keepalive.tick',
  /** A heartbeat did not reach the daemon. */
  KeepaliveTickFailed = 'keepalive.tick-failed',
  /** Enough heartbeats failed in a row that the freeze threshold is at risk. */
  KeepaliveDegraded = 'keepalive.degraded',
  /** The gap between two observations says this process was frozen (E4). */
  TimeJumpDetected = 'time-jump.detected',
  /** A request was taken in and written to the journal. */
  RequestAccepted = 'request.accepted',
  /** The request was refused before acceptance — queue full, already expired. */
  RequestRefused = 'request.refused',
  /** A wake was issued for the target sandbox. */
  WakeStarted = 'wake.started',
  /** Several requests joined one in-flight wake instead of stampeding it. */
  WakeCoalesced = 'wake.coalesced',
  /** A readiness probe could not complete a handshake with the target. */
  LinkProbeFailed = 'link.probe-failed',
  /** A forwarding link to a target sandbox was established. */
  LinkOpened = 'link.opened',
  /** A forwarding link exhausted its reconnect budget and had to be replaced. */
  LinkGaveUp = 'link.gave-up',
  /** The target answered a readiness probe. */
  TargetReady = 'target.ready',
  /** The envelope was handed to the forward target. */
  RequestForwarded = 'request.forwarded',
  /** The request reached a terminal failure, and the sender was told. */
  RequestFailed = 'request.failed',
  /** A task captured an authenticated source return channel. */
  TaskRouteRegistered = 'task-route.registered',
  /** A protocol ack/result/error was relayed to the source channel. */
  TaskReplyForwarded = 'task-reply.forwarded',
  /** A reply did not match the task's source/target/sandbox route. */
  TaskReplyRejected = 'task-reply.rejected',
  /** A task produced no terminal result before its task deadline. */
  TaskRouteExpired = 'task-route.expired',
  /** A journal entry survived a crash and was replayed. */
  RecoveryReplayed = 'recovery.replayed',
  /** A journal line was truncated by a crash mid-write and could not be read. */
  JournalTorn = 'journal.torn',
}

/** One audit record. `detail` is free-form but must stay JSON-serializable. */
export interface AuditEvent {
  readonly type: ActivatorEventType
  /** Epoch milliseconds. */
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

/** Somewhere durable for events to go, beyond the in-memory ring. */
export type AuditSink = (event: AuditEvent) => void

/** How many events {@link AuditLog} keeps before it starts overwriting. */
export const DEFAULT_AUDIT_CAPACITY = 512

/**
 * A bounded ring of recent events plus an unbounded per-type tally.
 *
 * The tally is what makes "leave an audit event" checkable long after the fact:
 * a test — or an operator hours later — can ask how many denials happened
 * without needing the individual records to still be in the ring.
 */
export class AuditLog {
  readonly #events: AuditEvent[] = []
  readonly #counts = new Map<ActivatorEventType, number>()
  readonly #capacity: number
  readonly #sink: AuditSink | undefined

  constructor(capacity: number = DEFAULT_AUDIT_CAPACITY, sink?: AuditSink) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `audit capacity must be a positive integer, got ${capacity}`,
      )
    }
    this.#capacity = capacity
    this.#sink = sink
  }

  /** Record one event. Never throws on account of the sink. */
  record(
    type: ActivatorEventType,
    at: number,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): AuditEvent {
    const event: AuditEvent = { type, at, detail }
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1)
    if (this.#sink !== undefined) {
      try {
        this.#sink(event)
      } catch {
        // A failing sink must not take down the heartbeat that was reporting
        // to it — losing the sandbox is a strictly worse outcome than losing
        // one log line, and the ring above already has the event.
      }
    }
    return event
  }

  /** Events still in the ring, oldest first. */
  events(): readonly AuditEvent[] {
    return [...this.#events]
  }

  /** Events of one type still in the ring, oldest first. */
  of(type: ActivatorEventType): readonly AuditEvent[] {
    return this.#events.filter(event => event.type === type)
  }

  /** How many events of this type were ever recorded, ring evictions included. */
  count(type: ActivatorEventType): number {
    return this.#counts.get(type) ?? 0
  }
}
