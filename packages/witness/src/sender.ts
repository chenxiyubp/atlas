// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Periodically turn an audit-chain head into a signed witness anchor. */

import { digestOf, readTrail } from '@qianmo/audit'
import type { NodeKeyPair } from '@qianmo/capability'
import {
  WITNESS_ANCHOR_VERSION,
  signWitnessAnchor,
  type WitnessAnchor,
} from './anchor.js'

/** Design §4.2: 60 s buys a <= 60 s window at negligible endpoint traffic. */
export const DEFAULT_WITNESS_ANCHOR_INTERVAL_MS = 60_000

/**
 * The deliberately narrow sender-side capability. It can only add an anchor.
 *
 * Resolving means the endpoint holds this exact anchor head, whether it was
 * stored now or already present; any other outcome rejects.
 */
export interface WitnessAnchorWriter {
  append(anchor: WitnessAnchor, signal?: AbortSignal): Promise<void>
}

export interface AuditWitnessSchedulerOptions {
  readonly node: string
  /** The audit path is owned by the host layer, not this workspace package. */
  readonly trailPath: string
  readonly keys: NodeKeyPair
  readonly writer: WitnessAnchorWriter
  readonly intervalMs?: number
  readonly now?: () => number
  /** Failures are observable but never allowed to stop the resident. */
  readonly onError?: (error: unknown) => void
}

/**
 * A period gate intended to be called from the resident's existing poll timer.
 *
 * It intentionally creates no timer of its own. The resident triggers it from
 * its poll loop without awaiting remote I/O, so this class coalesces direct
 * concurrent callers and prevents overlapping anchor attempts. Every failure is fail-open, following
 * the existing backup scheduler and audit sink: report it, retain the node,
 * and try again after the next period.
 *
 * A head the endpoint has already accepted is not sent again: the store keeps
 * one receipt per `(node, seq)`, so a resend can add no evidence and only
 * comes back as a refusal. The memory is per process on purpose. After a
 * restart the first period sends the current head once, and the endpoint's
 * `409` that names this same head counts as accepted — so a restart can never
 * skip an anchor, and needs no local state an attacker on the node could edit.
 */
export class AuditWitnessScheduler {
  readonly #options: AuditWitnessSchedulerOptions
  readonly #intervalMs: number
  readonly #now: () => number
  #lastAttemptAt: number | null = null
  /** The newest `(seq, head)` the endpoint confirmed; null until then. */
  #accepted: { readonly seq: number; readonly head: string } | null = null
  #inFlight: Promise<void> | null = null
  #controller: AbortController | null = null
  #closed = false
  readonly #closeReason = new Error('witness scheduler closed')

  constructor(options: AuditWitnessSchedulerOptions) {
    if (options.trailPath.trim() === '') {
      throw new Error('witness audit trail path must not be empty')
    }
    this.#options = options
    this.#intervalMs = options.intervalMs ?? DEFAULT_WITNESS_ANCHOR_INTERVAL_MS
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1_000) {
      throw new Error('witness anchor interval must be an integer >= 1000 ms')
    }
    this.#now = options.now ?? Date.now
  }

  /** Run an anchoring attempt when one full period has elapsed. */
  async tick(): Promise<void> {
    if (this.#closed) return
    if (this.#inFlight !== null) return await this.#inFlight
    const at = this.#now()
    if (
      this.#lastAttemptAt !== null &&
      at - this.#lastAttemptAt < this.#intervalMs
    ) {
      return
    }
    this.#lastAttemptAt = at
    const controller = new AbortController()
    this.#controller = controller
    const attempt = this.#anchor(at, controller.signal)
    this.#inFlight = attempt
    try {
      await attempt
    } finally {
      if (this.#controller === controller) this.#controller = null
      if (this.#inFlight === attempt) this.#inFlight = null
    }
  }

  /** Permanently disable new attempts and cancel the current one, if any. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#controller?.abort(this.#closeReason)
  }

  async #anchor(at: number, signal: AbortSignal): Promise<void> {
    try {
      const trail = readTrail(this.#options.trailPath)
      if (!trail.intact) {
        throw new Error(
          'refusing to anchor an audit trail with integrity issues',
        )
      }
      const head = trail.records.at(-1)
      if (head === undefined) return
      const digest = digestOf(head)
      const accepted = this.#accepted
      if (accepted?.seq === head.seq && accepted.head === digest) return
      const append = this.#options.writer.append(
        signWitnessAnchor(
          {
            v: WITNESS_ANCHOR_VERSION,
            node: this.#options.node,
            seq: head.seq,
            head: digest,
            count: trail.records.length,
            at,
          },
          this.#options.keys,
        ),
        signal,
      )
      void append.catch(() => {})
      if (signal.aborted) throw signal.reason
      let onAbort: (() => void) | undefined
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        await Promise.race([append, cancelled])
      } finally {
        if (onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort)
        }
      }
      this.#accepted = { seq: head.seq, head: digest }
    } catch (error) {
      if (this.#closed && signal.aborted) return
      try {
        this.#options.onError?.(error)
      } catch {
        // An error observer must not turn a witness outage into node outage.
      }
    }
  }
}
