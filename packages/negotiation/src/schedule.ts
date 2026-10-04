// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The timer port.
 *
 * Injected rather than called directly so a test can put a negotiation at any
 * point of an hour-long lease without waiting for one — and, more to the point,
 * so the expiry paths are exercised at all. A timeout nobody can trigger in a
 * test is a timeout nobody has seen work.
 */

/** Cancels a pending timer. Idempotent. */
export type CancelTimer = () => void

export interface Scheduler {
  after(delayMs: number, callback: () => void): CancelTimer
}

/** `setTimeout`-backed, and never the reason a process refuses to exit. */
export const timerScheduler: Scheduler = {
  after(delayMs, callback) {
    const handle = setTimeout(callback, Math.max(0, delayMs))
    handle.unref?.()
    return () => clearTimeout(handle)
  },
}
