// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { TimeJumpGate } from '@qianmo/protocol'

interface FreezeAwareWatchdogOptions {
  readonly timeoutMs: number
  readonly onTimeout: () => void
  readonly now?: () => number
  readonly cadenceMs?: number
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
}

const DEFAULT_CADENCE_MS = 10_000

function scheduleTimer(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/**
 * Opaque handle returned by {@link setFreezeAwareTimeout}, standing in for the
 * `ReturnType<typeof setTimeout>` the base files used to hold. Only `stop()` is
 * exposed, so a base file never has to name the watchdog class.
 */
export interface FreezeAwareTimer {
  /** Cancels the pending callback; the `clearTimeout` half of the pair. */
  stop(): void
}

export class FreezeAwareWatchdog implements FreezeAwareTimer {
  readonly #options: FreezeAwareWatchdogOptions
  readonly #now: () => number
  readonly #cadenceMs: number
  readonly #timeoutMs: number
  readonly #gate: TimeJumpGate
  #deadlineAt = 0
  #timer: { cancel(): void } | null = null
  #running = false

  constructor(options: FreezeAwareWatchdogOptions) {
    if (!Number.isFinite(options.timeoutMs)) {
      throw new RangeError(`timeoutMs must be finite, got ${options.timeoutMs}`)
    }
    // A non-positive timeout is a misconfiguration (`CLAUDE_STREAM_IDLE_TIMEOUT_MS=-1`
    // survives `parseInt` untouched), and the thing it replaced — `setTimeout`
    // with a negative delay — fired at once and produced the proper timeout
    // error. Throwing from inside a stream reader instead would escape that
    // classification and kill the request, so clamp rather than throw.
    this.#timeoutMs = Math.max(1, options.timeoutMs)
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#cadenceMs = Math.min(
      options.cadenceMs ?? DEFAULT_CADENCE_MS,
      this.#timeoutMs,
    )
    this.#gate = new TimeJumpGate({ periodMs: this.#cadenceMs })
  }

  reset(): void {
    const now = this.#now()
    this.#gate.observe(now)
    this.#deadlineAt = now + this.#timeoutMs
    this.#running = true
    this.#schedule()
  }

  stop(): void {
    this.#running = false
    this.#timer?.cancel()
    this.#timer = null
  }

  #schedule(): void {
    this.#timer?.cancel()
    if (!this.#running) return
    const now = this.#now()
    const remaining = Math.max(0, this.#deadlineAt - now)
    const delay =
      remaining === 0 ? this.#cadenceMs : Math.min(this.#cadenceMs, remaining)
    const schedule = this.#options.schedule ?? scheduleTimer
    this.#timer = schedule(delay, () => {
      this.#timer = null
      this.#tick()
    })
  }

  #tick(): void {
    if (!this.#running) return
    const now = this.#now()
    const observation = this.#gate.observe(now)
    this.#deadlineAt = this.#gate.rebase(this.#deadlineAt, observation)
    if (this.#gate.expired(this.#deadlineAt, now)) {
      this.stop()
      this.#options.onTimeout()
      return
    }
    this.#schedule()
  }
}

/**
 * `setTimeout`-shaped injection point for the stream idle watchdogs living in
 * base files (`services/api/claude.ts`, `services/api/gemini/client.ts`,
 * `services/api/openai/responsesAdapter.ts`).
 *
 * Why it exists (roadmap P10.3②): those three call sites originally read
 * `const t = setTimeout(cb, ms)` / `clearTimeout(t)`. Replacing them in place
 * with a `new FreezeAwareWatchdog({ timeoutMs, onTimeout })` object literal
 * re-indented whole callback bodies and produced the only *semantic* code
 * conflict of the v2.46.0 upstream-sync drill (see
 * `docs/dev/upstream-sync-drill.md` §5③). Per the same drill's rule ⑥ —
 * derive *underneath* the shape upstream already has — this pair keeps the
 * argument order, the trailing-args passthrough and the handle-plus-clear
 * idiom of the globals it stands in for, so each base file is left with a
 * one-identifier change instead of a rewritten block.
 *
 * Behaviour is exactly `new FreezeAwareWatchdog(...)` + `reset()`: the callback
 * fires once, `delayMs` after the last `reset`, measured across sandbox freezes
 * via `TimeJumpGate` rather than off raw wall clock.
 */
export function setFreezeAwareTimeout<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delayMs: number,
  ...args: TArgs
): FreezeAwareTimer {
  const watchdog = new FreezeAwareWatchdog({
    timeoutMs: delayMs,
    onTimeout: () => callback(...args),
  })
  watchdog.reset()
  return watchdog
}

/**
 * `clearTimeout` half of {@link setFreezeAwareTimeout}. Nullable by design so a
 * base file can keep its original `clearTimeout(maybeNullHandle)` shape.
 */
export function clearFreezeAwareTimeout(
  timer: FreezeAwareTimer | null | undefined,
): void {
  timer?.stop()
}
