// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What an on-demand tunnel is in M0, stated before anything is built.
 *
 * **It is not a new encryption layer.** Charter N-3 keeps M0 on TLS plus a
 * pre-shared key and says so as a limitation; inventing a second crypto scheme
 * here would be both out of scope and worse than the one we have. What "按需
 * 加密隧道" actually buys is in the first two words: the connection **exists
 * only while a lease does**. Before the negotiation there is nothing listening;
 * after the lease ends there is nothing listening, no channel retained, and no
 * copy of the credential anywhere in the process.
 *
 * So a tunnel is exactly three things on top of `@qianmo/transport`:
 *
 * 1. a listener opened **after** a lease exists and bound to it;
 * 2. an admission check on the first message: the borrower must present the
 *    capability the lender itself minted (rule S-1 makes that check meaningful
 *    — only this node could have signed it);
 * 3. **three teardown paths, none of which need the peer to cooperate**:
 *    normal release, lease expiry, and the peer disappearing.
 *
 * The third is why reconnect is off. `@qianmo/transport`'s client reconnects by
 * default, which is right for a node link and exactly wrong here: a tunnel that
 * comes back after the borrower died is a tunnel that outlives its lease.
 */

/** Why a tunnel closed. Closed set — an unexplained teardown is not one. */
export enum TeardownReason {
  /** The borrower said it was finished. */
  Released = 'released',
  /** The lease ran out of time. */
  Expired = 'expired',
  /** The peer went away without saying anything. */
  PeerLost = 'peer-lost',
  /** The lender withdrew it, or something failed on this side. */
  Withdrawn = 'withdrawn',
}

/** Everything the tunnel layer writes down. */
export enum TunnelEventType {
  /** A listener was opened for a lease. */
  Opened = 'tunnel.opened',
  /** The borrower presented a valid capability and was let in. */
  Admitted = 'tunnel.admitted',
  /** Somebody was turned away: no token, wrong token, wrong lease. */
  Refused = 'tunnel.refused',
  /** Work crossed the tunnel. */
  Carried = 'tunnel.carried',
  /** The tunnel closed, with the reason. */
  Closed = 'tunnel.closed',
}

export interface TunnelEvent {
  readonly type: TunnelEventType
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

export type TunnelAuditSink = (event: TunnelEvent) => void

/** A bounded ring plus an unbounded tally, same shape as the other packages. */
export class TunnelAuditLog {
  readonly #events: TunnelEvent[] = []
  readonly #counts = new Map<TunnelEventType, number>()
  readonly #capacity: number
  readonly #sink: TunnelAuditSink | undefined

  constructor(capacity = 512, sink?: TunnelAuditSink) {
    this.#capacity = capacity
    this.#sink = sink
  }

  record(
    type: TunnelEventType,
    at: number,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): void {
    const event: TunnelEvent = { type, at, detail }
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1)
    try {
      this.#sink?.(event)
    } catch {
      // A failing sink must not keep a tunnel open.
    }
  }

  events(): readonly TunnelEvent[] {
    return [...this.#events]
  }

  of(type: TunnelEventType): readonly TunnelEvent[] {
    return this.#events.filter(event => event.type === type)
  }

  count(type: TunnelEventType): number {
    return this.#counts.get(type) ?? 0
  }
}
