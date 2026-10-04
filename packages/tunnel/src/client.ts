// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The borrower's half.
 *
 * One deliberate difference from every other client in this repo: **reconnect
 * is off**. `@qianmo/transport` reconnects by default, which is right for a
 * node link that should survive a flaky network, and exactly wrong for a
 * tunnel — a tunnel that comes back after the lease ended, or after the
 * borrower itself died and was restarted, is a lease that outlived its terms.
 * If the connection drops, the lease is over; ask for a new one.
 */

import {
  MessageType,
  createMessage,
  parseAddress,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  TransportClient,
  type HandshakeIdentity,
  type TransportEndpoint,
} from '@qianmo/transport'
import { TunnelAuditLog, TunnelEventType } from './contracts.js'

export interface TunnelClientOptions {
  readonly address: string
  readonly node: string
  readonly psk: string
  readonly endpoint: TransportEndpoint
  readonly taskId: string
  readonly lender: string
  /** The token the lender minted for this lease, presented on every message. */
  readonly capability?: string
  /**
   * Sign this borrower's half of the tunnel handshake and check the lender's
   * half back (key-distribution.md §7.1 / §7.1.1).
   *
   * The peer this checks against is the **lender's node segment**, taken from
   * {@link TunnelClientOptions.lender} rather than from the endpoint: the
   * endpoint is what a negotiated offer said to dial, and §11 T-B′ is exactly
   * the case where that string was tampered with. Looking the key up under
   * the node the borrower was *lent* capacity by is what makes a redirected
   * offer unable to answer.
   *
   * Optional because a tunnel is short-lived and its authorization already
   * rides on {@link TunnelClientOptions.capability} — a lease token the
   * lender minted and verifies per message. Signing adds the connection-level
   * half of that; it does not replace it.
   */
  readonly signing?: HandshakeIdentity
  readonly audit: TunnelAuditLog
  readonly now?: () => number
}

/** A tunnel, from the borrower's side. */
export class TunnelClient {
  readonly #options: TunnelClientOptions
  readonly #audit: TunnelAuditLog
  readonly #now: () => number
  #client: TransportClient | null = null

  constructor(options: TunnelClientOptions) {
    this.#options = options
    this.#audit = options.audit
    this.#now = options.now ?? Date.now
  }

  get connected(): boolean {
    return this.#client?.isReady() ?? false
  }

  async connect(timeoutMs = 5_000): Promise<void> {
    // The lender is an address (`qianmo://<node>/<agent>`); the handshake
    // names nodes. An unparseable lender leaves both fields off rather than
    // guessing — `TransportClient` refuses `signing` without `peerNode`, and
    // a guess here would be a guess about whose signature to accept.
    const lenderNode = parseAddress(this.#options.lender)?.node
    const signing = this.#options.signing
    const client = new TransportClient({
      endpoint: this.#options.endpoint,
      node: this.#options.node,
      psk: this.#options.psk,
      keepAliveIntervalMs: 0,
      ...(lenderNode === undefined ? {} : { peerNode: lenderNode }),
      ...(signing === undefined || lenderNode === undefined ? {} : { signing }),
      // See the module header: a tunnel does not come back.
      backoff: { giveUpAfterMs: 0 },
    })
    this.#client = client
    await client.connect(timeoutMs)
  }

  /** Send one piece of work over the tunnel, waiting for its receipt. */
  async send(payload: unknown, timeoutMs = 5_000): Promise<void> {
    const client = this.#client
    if (client === null) throw new Error('tunnel client is not connected')
    const message = createMessage({
      from: this.#options.address,
      to: this.#options.lender,
      type: MessageType.TaskRequest,
      taskId: this.#options.taskId,
      payload,
      createdAt: this.#now(),
      ...(this.#options.capability === undefined
        ? {}
        : { cap: this.#options.capability }),
    })
    await client.sendAndWait(message, timeoutMs)
    this.#audit.record(TunnelEventType.Carried, this.#now(), {
      taskId: this.#options.taskId,
      msgId: message.msgId,
      side: 'borrower',
    })
  }

  /** Close the connection. Idempotent. */
  async close(): Promise<void> {
    const client = this.#client
    this.#client = null
    await client?.close()
  }

  /** The envelope that ends the lease on the negotiation channel, not here. */
  releaseMessage(offerId: string): QianmoMessage {
    const now = this.#now()
    return createMessage({
      from: this.#options.address,
      to: this.#options.lender,
      type: MessageType.ResourceRelease,
      taskId: this.#options.taskId,
      payload: { offerId, reason: 'completed', releasedAt: now },
      createdAt: now,
    })
  }
}
