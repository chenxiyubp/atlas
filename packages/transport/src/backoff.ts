// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reconnection backoff and the time-jump gate.
 *
 * Two independent concerns live here because they interact:
 *
 * 1. **Backoff** — exponential with jitter and a total budget, so a node that
 *    cannot reach its peer neither hammers it nor gives up on the first blip.
 * 2. **The time-jump gate** — a frozen node's wall clock keeps moving (E4:
 *    `CLOCK_MONOTONIC` advances across a freeze, so switching clock sources
 *    does not help), and `setInterval` does not replay missed ticks. On thaw
 *    every "how long since X" test crosses its threshold at once. Without a
 *    gate, a node that slept 34 s wakes up, sees its whole reconnect budget
 *    spent, and declares itself dead — the failure E4 was written to prevent.
 */

/** Knobs of {@link ReconnectSchedule}. */
export interface BackoffOptions {
  /** Delay before the first retry, doubling from there. */
  readonly baseDelayMs: number
  /** Ceiling on a single delay. */
  readonly maxDelayMs: number
  /** Fraction of the delay spread randomly, ± this much. */
  readonly jitterRatio: number
  /** Total time to keep retrying before declaring the peer gone. */
  readonly giveUpAfterMs: number
  /**
   * Lateness beyond the previously scheduled retry greater than
   * `maxDelayMs × this` is read as "the process was frozen", not ordinary
   * backoff, and resets the budget instead of consuming it.
   */
  readonly timeJumpFactor: number
}

/**
 * Defaults, matching the base's own WebSocket client so a mixed deployment
 * behaves alike: 1 s base, 30 s ceiling, ±25 % jitter, 10 min budget, and a
 * freeze threshold of twice the ceiling
 * (`src/cli/transports/WebSocketTransport.ts:24-27, :37`).
 */
export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
  giveUpAfterMs: 600_000,
  timeJumpFactor: 2,
}

/** Source of randomness for jitter; `Math.random` in production, fixed in tests. */
export type RandomSource = () => number

/**
 * Delay before retry number `attempt` (1-based), jitter included.
 *
 * Jitter is symmetric around the exponential value: without it, a rack of
 * nodes knocked offline together comes back in lockstep and knocks the peer
 * over again.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: RandomSource = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1)
  const base = Math.min(options.baseDelayMs * 2 ** exponent, options.maxDelayMs)
  const spread = base * options.jitterRatio * (2 * random() - 1)
  return Math.max(0, Math.round(base + spread))
}

/** What {@link ReconnectSchedule.next} decided. */
export type ReconnectDecision =
  | {
      readonly action: 'retry'
      /** 1-based attempt number this decision covers. */
      readonly attempt: number
      readonly delayMs: number
      /** True when the budget was reset because the process looked frozen. */
      readonly timeJumpDetected: boolean
    }
  | { readonly action: 'give-up'; readonly elapsedMs: number }

/**
 * The retry clock for one connection.
 *
 * Stateful on purpose: attempt count and budget start have to survive across
 * calls, and the time-jump test needs the previous attempt's timestamp. All
 * time arrives as an argument — the schedule never reads a clock itself, which
 * is what makes a 30 s outage testable in microseconds.
 */
export class ReconnectSchedule {
  private attempts = 0
  private startedAt: number | null = null
  private expectedRetryAt: number | null = null

  constructor(
    private readonly options: BackoffOptions = DEFAULT_BACKOFF,
    private readonly random: RandomSource = Math.random,
  ) {}

  /** Attempts made since the last success. */
  get attemptCount(): number {
    return this.attempts
  }

  /** Milliseconds spent in the current outage, or 0 when connected. */
  elapsed(now: number): number {
    return this.startedAt === null ? 0 : now - this.startedAt
  }

  /** Clear the outage: called when a connection comes up. */
  succeeded(): void {
    this.attempts = 0
    this.startedAt = null
    this.expectedRetryAt = null
  }

  /**
   * Whether {@link next} would still retry, spending nothing to find out.
   *
   * For a caller that has to decide something *else* on the answer, before the
   * retry itself: the client abandons its channel id after a 4004, and that
   * abandonment only makes sense if a dial carrying the new id follows. `next`
   * cannot answer it — it moves the attempt count, the budget start and the
   * time-jump timestamp, so "ask it and undo it" is not on offer — and a second
   * reading of the give-up rule written at the call site would be a copy free
   * to drift past the time-jump reset that has to precede it.
   */
  willRetry(now: number): boolean {
    return this.survey(now).elapsed < this.options.giveUpAfterMs
  }

  /**
   * The budget as {@link next} would read it at `now`, taking nothing.
   *
   * The E4 reset has to run before the give-up test, which makes "is the budget
   * spent" a two-step question; this is the one place it is answered.
   */
  private survey(now: number): {
    readonly timeJumpDetected: boolean
    readonly elapsed: number
  } {
    const threshold = this.options.maxDelayMs * this.options.timeJumpFactor
    const timeJumpDetected =
      this.expectedRetryAt !== null && now - this.expectedRetryAt > threshold
    const startedAt =
      timeJumpDetected || this.startedAt === null ? now : this.startedAt
    return { timeJumpDetected, elapsed: now - startedAt }
  }

  /**
   * Decide what to do about a connection that just failed or dropped.
   *
   * The time-jump test runs *before* the budget test, so a thawed node gets a
   * fresh budget rather than an immediate `give-up` (E4). The cost of being
   * wrong is one extra reconnect attempt; the cost of the opposite mistake is
   * a node that never comes back.
   */
  next(now: number): ReconnectDecision {
    const { timeJumpDetected, elapsed } = this.survey(now)
    if (timeJumpDetected) this.attempts = 0
    if (timeJumpDetected || this.startedAt === null) this.startedAt = now

    if (elapsed >= this.options.giveUpAfterMs) {
      return { action: 'give-up', elapsedMs: elapsed }
    }

    this.attempts += 1
    const delayMs = backoffDelay(this.attempts, this.options, this.random)
    this.expectedRetryAt = now + delayMs
    return {
      action: 'retry',
      attempt: this.attempts,
      delayMs,
      timeJumpDetected,
    }
  }
}
