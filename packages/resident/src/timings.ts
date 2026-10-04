// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ResidentTimingStage =
  | 'acp_ready'
  | 'detected'
  /**
   * The turn was handed to the node turn gate.
   *
   * There is deliberately no `dequeued` to pair with it: `admitted` already
   * marks the moment execution began, and a second stage naming the same
   * instant would only invite the two to drift.
   */
  | 'queued'
  | 'admitted'
  | 'read'
  | 'first_content'
  | 'turn_completed'
  | 'turn_failed'

export interface ResidentTimingEvent {
  readonly stage: ResidentTimingStage
  readonly at: number
  readonly sessionId: string
  readonly inputMessageId?: string
  readonly networkMsgId?: string
  readonly agent?: string
  readonly activityReconnectFactor?: number
  /**
   * The position this turn took in the queue when it was handed over — `1`
   * means it went straight to the front. Recorded with `queued`, absent
   * everywhere else.
   *
   * Observation only: nothing reads it back to decide anything, which is the
   * point (hermes B8 — instrumenting the queue must not change how it behaves).
   */
  readonly queueDepth?: number
  readonly error?: string
}

export type ResidentTimingSink = (event: ResidentTimingEvent) => void

export const DEFAULT_RESIDENT_TIMING_CAPACITY = 256

export class ResidentTimingRecorder {
  readonly #sink: ResidentTimingSink | undefined
  readonly #capacity: number
  readonly #events: ResidentTimingEvent[] = []

  constructor(
    sink?: ResidentTimingSink,
    capacity = DEFAULT_RESIDENT_TIMING_CAPACITY,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        'resident timing capacity must be a positive integer',
      )
    }
    this.#sink = sink
    this.#capacity = capacity
  }

  record(event: ResidentTimingEvent): void {
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    try {
      this.#sink?.(event)
    } catch {
      // Timing is evidence, not part of admission or execution semantics.
    }
  }

  all(): readonly ResidentTimingEvent[] {
    return [...this.#events]
  }
}
