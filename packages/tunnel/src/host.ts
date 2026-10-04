// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The lender's half: a listener that exists only while a lease does.
 *
 * ## The three teardown paths, and why each is real
 *
 * | path | trigger | who has to cooperate |
 * |---|---|---|
 * | released | the borrower says it is done | the borrower — but see below |
 * | expired | the lease's own deadline | nobody |
 * | peer-lost | the socket closed, or went silent past the idle window | nobody |
 *
 * The last two exist because the first cannot be relied on. A borrower that
 * crashes mid-task never sends a release, and a tunnel that waited for one
 * would be a lease that never ends — which is the failure charter AC-7's sixth
 * beat is about. So the deadline runs on the lender's own clock, and the
 * transport's disconnect callback tears down immediately.
 *
 * ## What "no residue" means here, precisely
 *
 * After teardown: the server is stopped (a later dial gets a connection error,
 * which the tests assert rather than assume), no logical channel is retained
 * for the peer to come back to (`channelRetentionMs: 0`), and the capability
 * this host was checking against is dropped. The token is held in one field of
 * one object and that object is released — this is a garbage-collected runtime,
 * so "wiped from memory" is not something this file can honestly promise, and
 * it does not.
 */

import type { QianmoMessage } from '@qianmo/protocol'
import {
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import { TeardownReason, TunnelAuditLog, TunnelEventType } from './contracts.js'

/** Cancels a pending timer. */
export type CancelTimer = () => void

export interface Scheduler {
  after(delayMs: number, callback: () => void): CancelTimer
}

export const timerScheduler: Scheduler = {
  after(delayMs, callback) {
    const handle = setTimeout(callback, Math.max(0, delayMs))
    handle.unref?.()
    return () => clearTimeout(handle)
  },
}

export interface TunnelHostOptions {
  /** The lease this tunnel serves. One tunnel, one lease. */
  readonly offerId: string
  readonly taskId: string
  /** The borrower's address; anybody else is refused. */
  readonly borrower: string
  /** Pre-shared key for the transport handshake (charter N-3). */
  readonly psk: string
  /**
   * The capability the borrower must present, exactly as this node minted it.
   * Absent means the deployment has no capability wiring — then the tunnel is
   * open to whoever holds the PSK, and this file says so rather than implying
   * more.
   */
  readonly capability?: string
  /** How long the lease runs from `open()`. */
  readonly leaseMs: number
  /** Where to listen. A unix socket keeps the test off the TCP port space. */
  readonly unix?: string
  readonly port?: number
  readonly hostname?: string
  /** Seconds of silence before a peer is considered gone. */
  readonly idleTimeoutSec?: number
  readonly audit: TunnelAuditLog
  readonly now?: () => number
  readonly scheduler?: Scheduler
  /** Called for each admitted message — this is where borrowed work runs. */
  readonly onWork?: (message: QianmoMessage) => void | Promise<void>
  /** Called once, whatever ends the tunnel. */
  readonly onClosed?: (reason: TeardownReason) => void
}

/** Default silence window before a peer counts as lost (AC-7 asks for ≤ 60 s). */
export const DEFAULT_IDLE_TIMEOUT_SEC = 30

export interface TunnelAddress {
  readonly unix?: string
  readonly port?: number
  readonly url?: string
}

/** A tunnel, from the lender's side. */
export class TunnelHost {
  readonly offerId: string
  readonly #options: TunnelHostOptions
  readonly #audit: TunnelAuditLog
  readonly #now: () => number
  readonly #scheduler: Scheduler
  #server: TransportServerHandle | null = null
  #cancelExpiry: CancelTimer | null = null
  #closed: TeardownReason | null = null
  #admitted = 0

  constructor(options: TunnelHostOptions) {
    this.offerId = options.offerId
    this.#options = options
    this.#audit = options.audit
    this.#now = options.now ?? Date.now
    this.#scheduler = options.scheduler ?? timerScheduler
  }

  get open(): boolean {
    return this.#server !== null
  }

  get closedBecause(): TeardownReason | null {
    return this.#closed
  }

  /** Messages that passed admission. */
  get carried(): number {
    return this.#admitted
  }

  /** Open the listener. Returns where the borrower should dial. */
  start(): TunnelAddress {
    if (this.#server !== null) {
      throw new Error(`tunnel ${this.offerId} is already open`)
    }
    const server = startTransportServer({
      psk: this.#options.psk,
      ...(this.#options.unix === undefined
        ? {
            port: this.#options.port ?? 0,
            hostname: this.#options.hostname ?? '127.0.0.1',
          }
        : { unix: this.#options.unix }),
      idleTimeoutSec: this.#options.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC,
      // No lingering channel: a peer that goes away has ended its lease, not
      // paused it. This is the setting that makes "peer-lost" a teardown rather
      // than a reconnect window.
      channelRetentionMs: 0,
      onPeerDisconnect: () => {
        this.close(TeardownReason.PeerLost)
      },
      onMessage: async (message: QianmoMessage): Promise<void> => {
        await this.#admit(message)
      },
    })
    this.#server = server
    this.#cancelExpiry = this.#scheduler.after(this.#options.leaseMs, () => {
      this.close(TeardownReason.Expired)
    })
    this.#audit.record(TunnelEventType.Opened, this.#now(), {
      offerId: this.offerId,
      taskId: this.#options.taskId,
      borrower: this.#options.borrower,
      leaseMs: this.#options.leaseMs,
      requiresCapability: this.#options.capability !== undefined,
    })
    return {
      ...(server.unix === undefined ? {} : { unix: server.unix }),
      ...(server.port === undefined ? {} : { port: server.port }),
      ...(server.url === undefined ? {} : { url: server.url }),
    }
  }

  /** Tear down. Idempotent: shutdown paths get run twice more often than expected. */
  close(reason: TeardownReason): void {
    if (this.#server === null && this.#closed !== null) return
    this.#closed = reason
    this.#cancelExpiry?.()
    this.#cancelExpiry = null
    const server = this.#server
    this.#server = null
    void server?.stop()
    this.#audit.record(TunnelEventType.Closed, this.#now(), {
      offerId: this.offerId,
      taskId: this.#options.taskId,
      reason,
      carried: this.#admitted,
    })
    this.#options.onClosed?.(reason)
  }

  async #admit(message: QianmoMessage): Promise<void> {
    const now = this.#now()
    const refuse = (why: string): never => {
      this.#audit.record(TunnelEventType.Refused, now, {
        offerId: this.offerId,
        taskId: message.taskId,
        from: message.from,
        reason: why,
      })
      // Thrown so the transport receipts it as rejected: a refusal the sender
      // cannot see is a refusal it will repeat.
      throw new Error(`tunnel refused the message: ${why}`)
    }

    if (message.from !== this.#options.borrower) {
      refuse('this tunnel belongs to another peer')
    }
    if (message.taskId !== this.#options.taskId) {
      refuse('this tunnel belongs to another lease')
    }
    if (this.#options.capability !== undefined) {
      // Byte equality against the token this node minted. Verifying the
      // signature again would be the same check one step further away: only
      // this node could have produced this string (rule S-1), and it is the
      // string we handed the borrower in the offer.
      if (message.cap !== this.#options.capability) {
        refuse('the message did not present this lease’s capability')
      }
    }

    this.#admitted += 1
    this.#audit.record(
      this.#admitted === 1 ? TunnelEventType.Admitted : TunnelEventType.Carried,
      now,
      {
        offerId: this.offerId,
        taskId: message.taskId,
        msgId: message.msgId,
      },
    )
    await this.#options.onWork?.(message)
  }
}
