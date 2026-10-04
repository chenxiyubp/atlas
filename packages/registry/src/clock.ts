// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Time source, injected so TTL behaviour is testable without waiting. */
export interface Clock {
  now(): number
}

/** Wall-clock implementation used in production. */
export const systemClock: Clock = {
  now: () => Date.now(),
}

/** Clock a test drives by hand. */
export class ManualClock implements Clock {
  #current: number

  constructor(start = 0) {
    this.#current = start
  }

  now(): number {
    return this.#current
  }

  /** Move time forward by `ms` and return the new instant. */
  advance(ms: number): number {
    this.#current += ms
    return this.#current
  }

  /** Jump to an absolute instant. */
  set(instant: number): void {
    this.#current = instant
  }
}
