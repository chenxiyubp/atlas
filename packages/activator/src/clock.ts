// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Clock, scheduler, and the time-jump gate.
 *
 * The gate is the reason this file exists. E4 measured a Bun process across
 * three freeze/thaw rounds and found:
 *
 *   - `CLOCK_MONOTONIC` **keeps advancing while the sandbox is frozen**
 *     (`gap_mono` and `gap_wall` agreed to within 10 ms across 34 s and 97 s
 *     freezes). Reaching for a monotonic clock does not dodge this; there is
 *     no clock source in the sandbox that skips the freeze.
 *   - `setInterval` does **not** replay missed ticks: a 34.7 s gap produced
 *     exactly one tick.
 *
 * Put together: at the instant of thaw, every "how long since I last saw X"
 * test crosses its threshold *simultaneously*. Without a gate a resident node
 * wakes up, concludes that its peer is gone, its in-flight deliveries have all
 * expired and its own retry budget is spent — and declares itself dead once per
 * wake. protocol.md §5.3 rule T-2 makes the gate mandatory for exactly this
 * reason, and P2.5 needs it on both faces: the heartbeat must not read a thaw
 * as "the daemon stopped answering", and the activator must not read a thaw as
 * "the target never became ready".
 *
 * Deliberately not imported from `@qianmo/transport`. That package has a gate
 * of the same lineage inside `ReconnectSchedule`, but it is welded to retry
 * budgets and is not part of that package's public surface; reaching into
 * another package's internals to share nine lines of arithmetic would buy a
 * coupling worth far more than the nine lines. The shapes differ too: there,
 * a jump resets an attempt budget; here, it opens a grace window during which
 * deadline judgements are suspended.
 */

/** Wall-clock source. Injected everywhere so tests never sleep to pass. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number
}

/** The real clock. */
export const systemClock: Clock = { now: () => Date.now() }

/** Cancels a pending timer. Idempotent. */
export type CancelTimer = () => void

/**
 * Somewhere to put a delayed callback.
 *
 * A port rather than a direct `setTimeout` call so a keepalive covering hours
 * of wall clock can be exercised in a millisecond, and so a test can place the
 * process at any point of a freeze without freezing anything.
 */
export interface Scheduler {
  after(delayMs: number, callback: () => void): CancelTimer
}

/**
 * `setTimeout`-backed scheduler.
 *
 * `setTimeout` rather than `setInterval` on purpose: `setInterval` does not
 * replay missed ticks (E4), so an interval-driven heartbeat silently loses
 * every beat it slept through and then keeps its original phase. Rescheduling
 * from the completion of each beat keeps the *gap* bounded, which is the
 * property the freeze threshold actually cares about.
 */
export const timerScheduler: Scheduler = {
  after(delayMs, callback) {
    const handle = setTimeout(callback, Math.max(0, delayMs))
    // Node/Bun timers hold the event loop open; a heartbeat must not be the
    // reason a CLI refuses to exit.
    handle.unref?.()
    return () => clearTimeout(handle)
  },
}

export {
  DEFAULT_GRACE_MS,
  DEFAULT_MIN_JUMP_GAP_MS,
  DEFAULT_TIME_JUMP_FACTOR,
  TimeJumpGate,
  type TimeJumpGateOptions,
  type TimeJumpObservation,
} from '@qianmo/protocol'
