// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Loop detection at **handler granularity** — the mechanism D-2 replaced node
 * granularity with (protocol.md §6.1, charter AC-3).
 *
 * ## The key is `(handler address, taskId)`, and why it is not the node
 *
 * Node granularity — "this message already visited me, cut it" — is the design
 * RFC 3261 Appendix A records SIP having shipped and then having had to
 * classify as a specification-level bug. It kills the legitimate spiral: one
 * node hosting several agents is *supposed* to be traversed more than once when
 * two different handlers on it are addressed for the same task. The failure is
 * silent and looks exactly like a network fault.
 *
 * So the key is the full `qianmo://<node>/<agent>` of the handler, paired with
 * the task identifier. Same handler, same task, second time → loop. Same node,
 * different handler → routing, not a loop, and the reverse test in this
 * package's suite exists precisely to keep someone from "simplifying" the key
 * back to the node segment.
 *
 * ## Replies are not judged by this key
 *
 * `ack`, `task.result`, `error` and `pong` all travel back to the requester
 * carrying the request's `taskId` (rule C-1). That is the same shape as a
 * revisit, so running the guard over them would cut AC-2's return path on its
 * very first message. {@link isReplyType} is the line, and it lives in
 * `@qianmo/protocol` because "which types are answers" is a property of the
 * wire contract rather than of this table.
 *
 * ## Seeding the origin
 *
 * D-2 named a second defect next to the granularity one: **the originating node
 * does not seed itself.** Without seeding, the first return of a task to the
 * handler that started it looks fresh, and A→B→A is only caught on the second
 * lap — if at all. {@link LoopGuard.seed} is that seeding, called from the
 * outbound path with the sender's own `from` address.
 *
 * ## Entries expire on the delivery deadline
 *
 * Same clock as the dedup table (§7.2): past that deadline the message is
 * `expired` anyway, so a later arrival is refused by the deadline check and not
 * by this table. Holding the key longer would only grow the table, and holding
 * it shorter would open a window in which a loop reads as fresh traffic.
 */

import {
  deliveryExpiresAt,
  isReplyType,
  LIMITS,
  type QianmoMessage,
} from '@qianmo/protocol'

/** What {@link LoopGuard.admit} decided about one message. */
export enum LoopVerdict {
  /** First time this handler is asked to do this task. Recorded. */
  Fresh = 'fresh',
  /** `(handler, taskId)` seen before — the loop detector proper. */
  Revisited = 'revisited',
  /** `hops` outran `LIMITS.maxHops` — the backstop behind the detector. */
  HopLimitExceeded = 'hop-limit-exceeded',
  /**
   * A reply, which this table deliberately does not judge. Recorded nowhere,
   * refused nowhere.
   */
  NotSubject = 'not-subject',
}

/**
 * Ceiling on retained `(handler, taskId)` pairs.
 *
 * Reached only under abuse — entries normally expire within one delivery
 * deadline — and then the soonest-expiring go first, the same policy the dedup
 * table uses for the same reason: they are the ones whose protection is about
 * to lapse anyway.
 */
export const DEFAULT_LOOP_CAPACITY = 10_000

export interface LoopGuardOptions {
  readonly capacity?: number
  /** Hop backstop. Defaults to `LIMITS.maxHops`; injected in tests. */
  readonly maxHops?: number
}

interface Visit {
  readonly taskId: string
  readonly handler: string
  readonly expiresAt: number
}

/** Per-node table of which handlers have already been asked to do which task. */
export class LoopGuard {
  /** `taskId` → handler address → expiry. Nested so release is O(handlers). */
  readonly #tasks = new Map<string, Map<string, number>>()
  readonly #capacity: number
  readonly #maxHops: number
  #size = 0

  constructor(options: LoopGuardOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_LOOP_CAPACITY
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `loop guard capacity must be a positive integer, got ${capacity}`,
      )
    }
    this.#capacity = capacity
    this.#maxHops = options.maxHops ?? LIMITS.maxHops
  }

  /** Pairs currently retained. */
  get size(): number {
    return this.#size
  }

  /**
   * Record that `handler` owns `taskId` here, without judging anything.
   *
   * Two callers, both legitimate: the outbound path seeding the originating
   * handler, and {@link admit} recording a fresh arrival.
   */
  seed(handler: string, taskId: string, expiresAt: number): void {
    let handlers = this.#tasks.get(taskId)
    if (handlers === undefined) {
      handlers = new Map<string, number>()
      this.#tasks.set(taskId, handlers)
    }
    if (!handlers.has(handler)) this.#size += 1
    handlers.set(handler, expiresAt)
    this.#enforceCap()
  }

  /**
   * Classify one inbound message and, when it is fresh, record it.
   *
   * `now` is the caller's clock **after** the time-jump gate (rule T-2): a node
   * that just thawed would otherwise prune every entry in the same instant its
   * gated deadline check is still admitting the messages those entries protect,
   * and a loop would slip through in exactly the window where a frozen node is
   * least able to notice.
   */
  admit(message: QianmoMessage, now: number): LoopVerdict {
    this.prune(now)

    if (message.hops.length > this.#maxHops) {
      return LoopVerdict.HopLimitExceeded
    }
    if (isReplyType(message.type)) return LoopVerdict.NotSubject

    const handlers = this.#tasks.get(message.taskId)
    const seenAt = handlers?.get(message.to)
    if (seenAt !== undefined && seenAt > now) return LoopVerdict.Revisited

    this.seed(message.to, message.taskId, deliveryExpiresAt(message))
    return LoopVerdict.Fresh
  }

  /**
   * Forget every handler recorded for `taskId`.
   *
   * protocol.md §8.2 rows 19–20: a terminal `task.result` releases the loop key
   * along with the dedup key. Expiry alone would get there too — this only
   * makes the table small sooner, so a caller that never calls it is still
   * correct, just less tidy.
   */
  release(taskId: string): void {
    const handlers = this.#tasks.get(taskId)
    if (handlers === undefined) return
    this.#size -= handlers.size
    this.#tasks.delete(taskId)
  }

  /** Drop every expired pair; returns how many went. */
  prune(now: number): number {
    let removed = 0
    for (const [taskId, handlers] of this.#tasks) {
      for (const [handler, expiresAt] of handlers) {
        if (expiresAt <= now) {
          handlers.delete(handler)
          removed += 1
        }
      }
      if (handlers.size === 0) this.#tasks.delete(taskId)
    }
    this.#size -= removed
    return removed
  }

  clear(): void {
    this.#tasks.clear()
    this.#size = 0
  }

  #enforceCap(): void {
    if (this.#size <= this.#capacity) return
    const visits: Visit[] = []
    for (const [taskId, handlers] of this.#tasks) {
      for (const [handler, expiresAt] of handlers) {
        visits.push({ taskId, handler, expiresAt })
      }
    }
    visits.sort((a, b) => a.expiresAt - b.expiresAt)
    const excess = this.#size - this.#capacity
    for (let index = 0; index < excess; index += 1) {
      const visit = visits[index]
      if (visit === undefined) break
      const handlers = this.#tasks.get(visit.taskId)
      if (handlers === undefined) continue
      if (handlers.delete(visit.handler)) this.#size -= 1
      if (handlers.size === 0) this.#tasks.delete(visit.taskId)
    }
  }
}
