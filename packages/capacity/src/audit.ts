// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the planner writes down, and why the suppressed ones are written too.
 *
 * P6.2's DoD has two halves and this file serves both. "Triggered ≥ 30 min
 * before the peak" is answered by `leadMs` on a `Predicted` event — one scalar,
 * on the record, so the claim is checkable from the trail alone rather than by
 * re-deriving it from a window id. "Does not fire on flat load" is answered by
 * the *absence* of `Predicted` and `Reactive` events, which is only a
 * meaningful absence if the near misses are visible: hence `Suppressed`.
 *
 * A suppressed decision is not a refusal. Nobody turned it down — the planner
 * had already acted on the same rise, or the cooldown from the last one had not
 * lapsed. That distinction is why the P7.2 wiring files these as `dropped`.
 *
 * Details are scalars only, in the same shape as every other layer's ring, so
 * they can go through the trail's translation unchanged.
 */

/** Everything the capacity planner writes down. */
export enum CapacityEventType {
  /** A calendar window is coming and capacity was asked for ahead of it. */
  Predicted = 'capacity.scale-up-predicted',
  /** The load moved without a calendar entry to explain it. */
  Reactive = 'capacity.scale-up-reactive',
  /** A trigger the rules held back, with the reason it was held back. */
  Suppressed = 'capacity.scale-up-suppressed',
}

export interface CapacityEvent {
  readonly type: CapacityEventType
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

export type CapacityAuditSink = (event: CapacityEvent) => void

/** A bounded ring plus an unbounded tally, same shape as the other packages. */
export class CapacityAuditLog {
  readonly #events: CapacityEvent[] = []
  readonly #counts = new Map<CapacityEventType, number>()
  readonly #capacity: number
  readonly #sink: CapacityAuditSink | undefined

  constructor(capacity = 512, sink?: CapacityAuditSink) {
    this.#capacity = capacity
    this.#sink = sink
  }

  record(
    type: CapacityEventType,
    at: number,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): void {
    const event: CapacityEvent = { type, at, detail }
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1)
    try {
      this.#sink?.(event)
    } catch {
      // A failing sink must not become a failed decision.
    }
  }

  events(): readonly CapacityEvent[] {
    return [...this.#events]
  }

  of(type: CapacityEventType): readonly CapacityEvent[] {
    return this.#events.filter(event => event.type === type)
  }

  count(type: CapacityEventType): number {
    return this.#counts.get(type) ?? 0
  }
}
