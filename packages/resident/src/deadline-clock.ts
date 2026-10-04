// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { TimeJumpGate } from '@qianmo/protocol'

interface ResidentDeadlineClockOptions {
  readonly periodMs: number
  readonly now?: () => number
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
}

function scheduleTimer(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class ResidentDeadlineClock {
  readonly #options: ResidentDeadlineClockOptions
  readonly #now: () => number
  readonly #gate: TimeJumpGate
  readonly #jumps: Array<{
    at: number
    gapMs: number
    cumulativeGapMs: number
  }> = []
  #running = false
  #timer: { cancel(): void } | null = null

  constructor(options: ResidentDeadlineClockOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#gate = new TimeJumpGate({ periodMs: options.periodMs })
  }

  nowFor = (createdAt: number): number => {
    const now = this.#now()
    this.#observe(now)
    const index = this.#firstJumpEndingAfter(createdAt)
    if (index >= this.#jumps.length) return now
    const first = this.#jumps[index]!
    const totalGap = this.#jumps.at(-1)?.cumulativeGapMs ?? 0
    const firstOverlap = first.at - Math.max(createdAt, first.at - first.gapMs)
    return now - firstOverlap - (totalGap - first.cumulativeGapMs)
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#gate.observe(this.#now())
    this.#schedule()
  }

  stop(): void {
    this.#running = false
    this.#timer?.cancel()
    this.#timer = null
  }

  #firstJumpEndingAfter(createdAt: number): number {
    let low = 0
    let high = this.#jumps.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.#jumps[middle]!.at <= createdAt) low = middle + 1
      else high = middle
    }
    return low
  }

  #observe(at: number): void {
    const observation = this.#gate.observe(at)
    if (observation.jumped) {
      this.#jumps.push({
        at,
        gapMs: observation.gapMs,
        cumulativeGapMs:
          (this.#jumps.at(-1)?.cumulativeGapMs ?? 0) + observation.gapMs,
      })
    }
  }

  #schedule(): void {
    if (!this.#running) return
    const schedule = this.#options.schedule ?? scheduleTimer
    this.#timer = schedule(this.#options.periodMs, () => {
      this.#timer = null
      this.#observe(this.#now())
      this.#schedule()
    })
  }
}
