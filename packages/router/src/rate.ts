// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rate limits, kept apart by construction.
 *
 * Charter AC-3 asks for two *inbound-facing* limits and adds a rule about them:
 * they are verified independently and **must not be mixed** in code or
 * documents. protocol.md §6.4 states the split:
 *
 * | layer    | who is counted                        | ceiling                    | on trip |
 * |----------|---------------------------------------|----------------------------|---------|
 * | protocol | a receiving node, per sending node    | `LIMITS.ratePerMinute`     | terminal state `rate_limited` + `error(E_RATE_LIMITED)` |
 * | runtime  | one sender, per target address        | {@link RUNTIME_RATE}       | local refusal, **not** a wire state (§6.4) |
 *
 * They are two classes, with two key shapes, two ceilings from two sources, two
 * audit event types and two refusal codes. Nothing is shared but the bucket
 * arithmetic. That is deliberate: the cheapest way to end up with one mechanism
 * wearing two names is to give them one implementation and a flag.
 *
 * {@link NotifyBudget} (P13.2) is a **third** thing and shares nothing with
 * either, not even the arithmetic. Both of the above ask "is this peer sending
 * me too much"; it asks "am *I* about to bother a person too much", it counts
 * outbound rather than inbound, and it is a sliding window rather than a bucket
 * precisely because a burst allowance is wrong for that question. Its own doc
 * comment carries the argument. **Do not fold it into `KeyedBuckets`** — the
 * mixing rule above exists for exactly this temptation.
 *
 * ## Why the runtime ceiling is not in `LIMITS`
 *
 * `@qianmo/protocol`'s `LIMITS` is the single source for **protocol-level**
 * numbers (CLAUDE.md §2.2), and protocol.md §6.4 says in as many words that the
 * runtime layer is not defined by that document. A runtime knob parked in
 * `LIMITS` would be quoted as a protocol guarantee by the next reader, and
 * changing it would then need a charter amendment it does not deserve. It lives
 * here, next to the only code that enforces it.
 *
 * ## Why the protocol budget counts nodes, not agents
 *
 * "Per sender" could mean the sending agent. It must not: a peer that wanted
 * more than its share would then only have to name more agents, and the budget
 * meant to protect this node from that peer would scale with the peer's
 * imagination. The peer is authenticated as a node (one handshake, one PSK), so
 * the node is the unit that can actually be held to a number.
 */

import { LIMITS, parseAddress } from '@qianmo/protocol'

/**
 * Runtime-layer ceiling: one sender, one target, 20 messages per 60 s
 * (charter AC-3 ①). Not a protocol number — see the module header.
 */
export const RUNTIME_RATE = {
  capacity: 20,
  windowMs: 60_000,
} as const

/** Ceiling on how many distinct keys either limiter tracks at once. */
export const DEFAULT_MAX_RATE_KEYS = 4_096

/**
 * Continuous-refill token bucket.
 *
 * Continuous rather than a fixed window on purpose: a fixed window lets a
 * sender spend its whole budget in the last millisecond of one window and again
 * in the first of the next, i.e. twice the ceiling back to back, which is
 * exactly the burst the limit exists to stop.
 */
export class TokenBucket {
  readonly #capacity: number
  readonly #windowMs: number
  #tokens: number
  #updatedAt: number

  constructor(capacity: number, windowMs: number, now: number) {
    if (!(capacity > 0)) {
      throw new RangeError(`bucket capacity must be positive, got ${capacity}`)
    }
    if (!(windowMs > 0)) {
      throw new RangeError(`bucket window must be positive, got ${windowMs}`)
    }
    this.#capacity = capacity
    this.#windowMs = windowMs
    this.#tokens = capacity
    this.#updatedAt = now
  }

  /** Last instant this bucket was touched — the eviction ordering key. */
  get updatedAt(): number {
    return this.#updatedAt
  }

  /**
   * Tokens available at `now`, without spending one **and without touching the
   * bucket**.
   *
   * Purity matters here beyond tidiness: eviction asks every bucket whether it
   * is full, and a `peek` that stamped `updatedAt` on the way past would leave
   * every bucket looking freshly used — which is exactly the ordering eviction
   * then sorts by.
   */
  peek(now: number): number {
    return this.#tokensAt(now)
  }

  /** True when the bucket is untouched — nothing to remember about it. */
  full(now: number): boolean {
    return this.#tokensAt(now) >= this.#capacity
  }

  /** Spend one token; false when the ceiling has been reached. */
  tryConsume(now: number): boolean {
    this.#tokens = this.#tokensAt(now)
    // Forward only. A clock that stepped backwards must not become the new
    // baseline, or the step would be credited as elapsed time on the next call.
    this.#updatedAt = Math.max(this.#updatedAt, now)
    if (this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }

  #tokensAt(now: number): number {
    // A clock that went backwards (NTP step, or a caller passing a gated time)
    // must not mint tokens; treat it as no elapsed time rather than negative.
    const elapsed = Math.max(0, now - this.#updatedAt)
    if (elapsed === 0) return this.#tokens
    return Math.min(
      this.#capacity,
      this.#tokens + (elapsed * this.#capacity) / this.#windowMs,
    )
  }
}

/** Shared bookkeeping for a bounded map of buckets. */
abstract class KeyedBuckets {
  readonly #buckets = new Map<string, TokenBucket>()
  readonly #capacity: number
  readonly #windowMs: number
  readonly #maxKeys: number

  protected constructor(capacity: number, windowMs: number, maxKeys: number) {
    this.#capacity = capacity
    this.#windowMs = windowMs
    this.#maxKeys = maxKeys
  }

  /** Keys currently tracked. */
  get size(): number {
    return this.#buckets.size
  }

  /** Tokens left for `key` at `now`, for tests and diagnostics. */
  protected tokensOf(key: string, now: number): number {
    return this.#buckets.get(key)?.peek(now) ?? this.#capacity
  }

  protected consume(key: string, now: number): boolean {
    let bucket = this.#buckets.get(key)
    if (bucket === undefined) {
      bucket = new TokenBucket(this.#capacity, this.#windowMs, now)
      this.#buckets.set(key, bucket)
      this.#evict(now)
    }
    return bucket.tryConsume(now)
  }

  clear(): void {
    this.#buckets.clear()
  }

  /**
   * Keep the map bounded.
   *
   * Refilled buckets go first because a full bucket carries no information: a
   * sender at its full allowance is indistinguishable from one that has never
   * been seen. Only if that is not enough does the oldest-touched entry go —
   * which is the one whose bucket has had the longest to refill anyway.
   */
  #evict(now: number): void {
    if (this.#buckets.size <= this.#maxKeys) return
    for (const [key, bucket] of this.#buckets) {
      if (this.#buckets.size <= this.#maxKeys) return
      if (bucket.full(now)) this.#buckets.delete(key)
    }
    while (this.#buckets.size > this.#maxKeys) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, bucket] of this.#buckets) {
        if (bucket.updatedAt < oldestAt) {
          oldestAt = bucket.updatedAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) return
      this.#buckets.delete(oldestKey)
    }
  }
}

export interface RuntimeThrottleOptions {
  readonly capacity?: number
  readonly windowMs?: number
  readonly maxKeys?: number
}

/**
 * Runtime layer: what one sender may send to one target address.
 *
 * This is the layer that catches the auto-reply ping-pong. Two agents answering
 * each other build a fresh `taskId` every lap and hand each envelope to the
 * transport with an empty hop list, so neither the loop key nor `maxHops` ever
 * sees anything unusual — each individual message is, in fact, perfectly legal.
 * What is not legal is twenty-one of them a minute at one address.
 */
export class RuntimeThrottle extends KeyedBuckets {
  constructor(options: RuntimeThrottleOptions = {}) {
    super(
      options.capacity ?? RUNTIME_RATE.capacity,
      options.windowMs ?? RUNTIME_RATE.windowMs,
      options.maxKeys ?? DEFAULT_MAX_RATE_KEYS,
    )
  }

  /** Spend one token for the `from → to` pair. */
  admit(from: string, to: string, now: number): boolean {
    return this.consume(`${from} ${to}`, now)
  }

  /** Tokens left for the pair, for diagnostics and tests. */
  remaining(from: string, to: string, now: number): number {
    return this.tokensOf(`${from} ${to}`, now)
  }
}

export interface InboundBudgetOptions {
  /** Defaults to `LIMITS.ratePerMinute` — the protocol's number, not ours. */
  readonly perMinute?: number
  readonly maxKeys?: number
}

/** Protocol layer: what one sending **node** may deliver into this node. */
export class InboundBudget extends KeyedBuckets {
  constructor(options: InboundBudgetOptions = {}) {
    super(
      options.perMinute ?? LIMITS.ratePerMinute,
      60_000,
      options.maxKeys ?? DEFAULT_MAX_RATE_KEYS,
    )
  }

  /**
   * Spend one token for the node behind `from`.
   *
   * A malformed `from` is charged to the literal string instead of being waved
   * through: validation rejects it moments later anyway, and an unparseable
   * address must not be the one input that skips accounting.
   */
  admit(from: string, now: number): boolean {
    return this.consume(parseAddress(from)?.node ?? from, now)
  }

  /** Tokens left for a sending node, for diagnostics and tests. */
  remaining(node: string, now: number): number {
    return this.tokensOf(node, now)
  }
}

export interface NotifyBudgetOptions {
  /** Defaults to `LIMITS.notifyRatePerMinute`. */
  readonly perMinute?: number
  /** Width of the window, ms. Defaults to a minute; injected in tests. */
  readonly windowMs?: number
}

/**
 * What one node may push at a human, per sliding minute (protocol.md §14.7).
 *
 * ## Why this one is not a token bucket
 *
 * Everything else in this file is, and for good reasons — but they are reasons
 * about *load*, and this limit is not about load. The two inbound/runtime
 * budgets protect a machine from traffic, so a burst allowance is a feature:
 * spending a minute's worth at once costs the receiver nothing it cannot
 * absorb. This budget protects a *person* from an unattended agent, and a burst
 * is precisely the failure mode.
 *
 * The measurable difference is not the first burst — an empty window and a full
 * bucket both admit the ceiling at once — it is what a bucket permits *around*
 * one. A bucket with capacity C refilling at C per minute admits C immediately
 * and another C over the following minute: **up to twice the nominal rate
 * inside one minute**, which is the arithmetic that turns "60 a minute" into a
 * 120-notification hour of someone's evening. A window admits C per window,
 * every window, with no accounting trick that gets a 61st through.
 *
 * ## Why there is no key
 *
 * The other two limiters are keyed (per sender, per target) because they answer
 * "is this *peer* being unreasonable". This one answers "is this *node* being
 * unreasonable", and a node that has found two ways to be noisy has not earned
 * two budgets. One window per node, which is what `LIMITS.notifyRatePerMinute`
 * says it is.
 *
 * The window is half-open, `(now - windowMs, now]`: an admission exactly
 * `windowMs` old has left it. That is what makes "at most C per window" true of
 * *every* window rather than of the ones that happen to line up with a batch.
 *
 * Memory is bounded by construction: at most `perMinute` timestamps are ever
 * retained, since admitting is what appends and the ceiling is what stops it.
 */
export class NotifyBudget {
  readonly #perMinute: number
  readonly #windowMs: number
  /** Admission instants inside the current window, oldest first. */
  #admitted: number[] = []

  constructor(options: NotifyBudgetOptions = {}) {
    const perMinute = options.perMinute ?? LIMITS.notifyRatePerMinute
    const windowMs = options.windowMs ?? 60_000
    if (!(perMinute > 0)) {
      throw new RangeError(`notify ceiling must be positive, got ${perMinute}`)
    }
    if (!(windowMs > 0)) {
      throw new RangeError(`notify window must be positive, got ${windowMs}`)
    }
    this.#perMinute = perMinute
    this.#windowMs = windowMs
  }

  /** Width of the window this budget promises over. */
  get windowMs(): number {
    return this.#windowMs
  }

  /**
   * Take one slot, or refuse.
   *
   * A refusal is not a retry hint: the caller's answer is to hold the
   * notification in its delivery ledger, not to spin. `retryAfterMs` gives it
   * the instant the window actually opens.
   */
  admit(now: number): boolean {
    this.#prune(now)
    if (this.#admitted.length >= this.#perMinute) return false
    this.#admitted.push(now)
    return true
  }

  /** Slots left in the window at `now`, without taking one. */
  remaining(now: number): number {
    this.#prune(now)
    return Math.max(0, this.#perMinute - this.#admitted.length)
  }

  /** Ms until a slot frees up, or `0` when one is free already. */
  retryAfterMs(now: number): number {
    this.#prune(now)
    if (this.#admitted.length < this.#perMinute) return 0
    const oldest = this.#admitted[0]
    if (oldest === undefined) return 0
    return Math.max(0, oldest + this.#windowMs - now)
  }

  clear(): void {
    this.#admitted = []
  }

  /**
   * Drop everything that has aged out of the window.
   *
   * A clock that stepped backwards prunes nothing rather than un-admitting
   * anything: the same "forward only" rule the buckets follow, and for the same
   * reason — a backwards step must never mint allowance.
   */
  #prune(now: number): void {
    const floor = now - this.#windowMs
    let index = 0
    while (index < this.#admitted.length) {
      const at = this.#admitted[index]
      if (at === undefined || at > floor) break
      index += 1
    }
    if (index > 0) this.#admitted = this.#admitted.slice(index)
  }
}
