// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface TimeJumpGateOptions {
  readonly periodMs: number
  readonly factor?: number
  readonly graceMs?: number
  readonly minJumpGapMs?: number
}

export const DEFAULT_TIME_JUMP_FACTOR = 2
export const DEFAULT_MIN_JUMP_GAP_MS = 2_000
export const DEFAULT_GRACE_MS = 15_000

export interface TimeJumpObservation {
  readonly jumped: boolean
  readonly gapMs: number
  readonly graceUntil: number
}

export class TimeJumpGate {
  readonly #periodMs: number
  readonly #factor: number
  readonly #graceMs: number
  readonly #minGapMs: number
  #lastSeenAt: number | null = null
  #graceUntil = 0
  #jumps = 0

  constructor(options: TimeJumpGateOptions) {
    if (!(options.periodMs > 0)) {
      throw new RangeError(`periodMs must be positive, got ${options.periodMs}`)
    }
    const factor = options.factor ?? DEFAULT_TIME_JUMP_FACTOR
    if (!(factor > 1)) {
      throw new RangeError(`factor must be greater than 1, got ${factor}`)
    }
    this.#periodMs = options.periodMs
    this.#factor = factor
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    this.#minGapMs = options.minJumpGapMs ?? DEFAULT_MIN_JUMP_GAP_MS
  }

  get jumpCount(): number {
    return this.#jumps
  }

  get thresholdMs(): number {
    return Math.max(this.#periodMs * this.#factor, this.#minGapMs)
  }

  observe(now: number): TimeJumpObservation {
    const previous = this.#lastSeenAt
    if (previous === null) {
      this.#lastSeenAt = now
      return { jumped: false, gapMs: 0, graceUntil: this.#graceUntil }
    }
    return this.observeGap(now - previous, now)
  }

  observeGap(gapMs: number, now: number): TimeJumpObservation {
    this.#lastSeenAt = now
    if (gapMs > this.thresholdMs) {
      this.#jumps += 1
      this.#graceUntil = now + this.#graceMs
      return { jumped: true, gapMs, graceUntil: this.#graceUntil }
    }
    return { jumped: false, gapMs, graceUntil: this.#graceUntil }
  }

  inGrace(now: number): boolean {
    return now < this.#graceUntil
  }

  expired(deadlineAt: number, now: number): boolean {
    if (this.inGrace(now)) return false
    return now >= deadlineAt
  }

  rebase(deadlineAt: number, observation: TimeJumpObservation): number {
    return observation.jumped ? deadlineAt + observation.gapMs : deadlineAt
  }
}
