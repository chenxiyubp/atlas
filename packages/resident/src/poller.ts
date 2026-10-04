// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ResidentPollerOptions {
  readonly poll: () => Promise<void>
  readonly intervalMs?: number
  readonly onError?: (error: unknown) => void
  /**
   * Asked before every poll; `true` skips this tick (design §3.B6, ESTOP).
   *
   * A skip, not a stop: the timer keeps running, so clearing the sentinel
   * resumes the node within one interval with nothing to restart. Skipping
   * here is what makes "no new work" true at the source — the admission loop
   * is the only thing that turns an unread mailbox entry into a turn.
   *
   * **Nothing already running is touched.** ESTOP is pause-new-work; a turn
   * that is mid-flight has a `task.result` owed to a peer.
   *
   * A predicate that throws is read as "not paused" and reported: the
   * reliability kit fails open, so a sentinel this poller cannot evaluate must
   * not be able to halt it.
   */
  readonly paused?: () => boolean
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
}

export const DEFAULT_RESIDENT_POLL_INTERVAL_MS = 500

function defaultSchedule(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class ResidentPoller {
  readonly #options: ResidentPollerOptions
  #running = false
  #timer: { cancel(): void } | null = null

  constructor(options: ResidentPollerOptions) {
    this.#options = options
  }

  get running(): boolean {
    return this.#running
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#schedule(0)
  }

  stop(): void {
    this.#running = false
    this.#timer?.cancel()
    this.#timer = null
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return
    const schedule = this.#options.schedule ?? defaultSchedule
    this.#timer = schedule(delayMs, () => {
      this.#timer = null
      void this.#tick()
    })
  }

  /** Fail-open evaluation of {@link ResidentPollerOptions.paused}. */
  #paused(): boolean {
    try {
      return this.#options.paused?.() ?? false
    } catch (error) {
      this.#options.onError?.(error)
      return false
    }
  }

  async #tick(): Promise<void> {
    try {
      if (this.#paused()) return
      await this.#options.poll()
    } catch (error) {
      this.#options.onError?.(error)
    } finally {
      this.#schedule(
        this.#options.intervalMs ?? DEFAULT_RESIDENT_POLL_INTERVAL_MS,
      )
    }
  }
}
