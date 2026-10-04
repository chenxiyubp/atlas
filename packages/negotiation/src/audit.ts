// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The negotiation audit trail.
 *
 * Lending a machine is the one thing in this system where the interesting
 * question months later is "who agreed to what, and when did it end" — so every
 * transition writes a line, including the boring ones. `Released` in particular
 * is not an optional nicety: an audit trail with grants and no releases reads
 * as a system that lends and never takes back.
 */

/** Everything the negotiation layer writes down. */
export enum NegotiationEventType {
  /** A request arrived and was answered with terms. */
  Offered = 'negotiation.offered',
  /** A request or a grant was turned away, with the reason. */
  Refused = 'negotiation.refused',
  /** The borrower took an offer and the lease started. */
  Leased = 'negotiation.leased',
  /** The reservation or lease ended, however it ended. */
  Released = 'negotiation.released',
  /** The borrower gave up on an offer it had asked for. */
  Abandoned = 'negotiation.abandoned',
}

export interface NegotiationEvent {
  readonly type: NegotiationEventType
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

export type NegotiationAuditSink = (event: NegotiationEvent) => void

/** A bounded ring plus an unbounded tally, same shape as the other packages. */
export class NegotiationAuditLog {
  readonly #events: NegotiationEvent[] = []
  readonly #counts = new Map<NegotiationEventType, number>()
  readonly #capacity: number
  readonly #sink: NegotiationAuditSink | undefined

  constructor(capacity = 512, sink?: NegotiationAuditSink) {
    this.#capacity = capacity
    this.#sink = sink
  }

  record(
    type: NegotiationEventType,
    at: number,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): void {
    const event: NegotiationEvent = { type, at, detail }
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1)
    try {
      this.#sink?.(event)
    } catch {
      // A failing sink must not become a failed negotiation.
    }
  }

  events(): readonly NegotiationEvent[] {
    return [...this.#events]
  }

  of(type: NegotiationEventType): readonly NegotiationEvent[] {
    return this.#events.filter(event => event.type === type)
  }

  count(type: NegotiationEventType): number {
    return this.#counts.get(type) ?? 0
  }
}
