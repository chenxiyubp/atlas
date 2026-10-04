// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { QianmoMessage } from '@qianmo/protocol'
import { ReceiptStatus, type ReceiptFrame } from './frames.js'

/** Default outbox depth, matching the base's replay buffer. */
export const DEFAULT_MAX_QUEUED = 1_000

/** Raised when an outbox cannot retain another unreceipted envelope. */
export class OutboxFullError extends Error {
  constructor(depth: number) {
    super(`transport outbox is full (${depth} unreceipted messages)`)
    this.name = 'OutboxFullError'
  }
}

/** Raised when the receiving peer rejects an envelope. */
export class TransportReceiptError extends Error {
  readonly msgId: string
  readonly receiptCode: ReceiptFrame['code']

  constructor(frame: ReceiptFrame) {
    super(
      `transport message ${frame.msgId} rejected${frame.code === undefined ? '' : ` (${frame.code})`}`,
    )
    this.name = 'TransportReceiptError'
    this.msgId = frame.msgId
    this.receiptCode = frame.code
  }
}

export type SuccessfulReceiptStatus =
  | ReceiptStatus.Accepted
  | ReceiptStatus.Duplicate

type ReceiptWaiter = {
  readonly resolve: (status: SuccessfulReceiptStatus) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface EnvelopeOutboxOptions {
  readonly maxQueued?: number
  readonly canWrite: () => boolean
  readonly write: (message: QianmoMessage) => void
  readonly isClosed: () => boolean
  readonly onReceipt?: (frame: ReceiptFrame, known: boolean) => void
}

/** Receipt-driven at-least-once queue shared by both directions of a channel. */
export class EnvelopeOutbox {
  readonly #messages = new Map<string, QianmoMessage>()
  readonly #receiptWaiters = new Map<string, ReceiptWaiter>()
  readonly #drainWaiters = new Set<{
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }>()
  readonly #maxQueued: number
  readonly #options: EnvelopeOutboxOptions

  constructor(options: EnvelopeOutboxOptions) {
    this.#options = options
    this.#maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED
  }

  get pending(): number {
    return this.#messages.size
  }

  send(message: QianmoMessage): void {
    if (this.#options.isClosed()) throw new Error('transport channel is closed')
    if (
      !this.#messages.has(message.msgId) &&
      this.#messages.size >= this.#maxQueued
    ) {
      throw new OutboxFullError(this.#messages.size)
    }
    this.#messages.set(message.msgId, message)
    if (this.#options.canWrite()) this.#options.write(message)
  }

  sendAndWait(
    message: QianmoMessage,
    timeoutMs = 5_000,
  ): Promise<SuccessfulReceiptStatus> {
    if (this.#receiptWaiters.has(message.msgId)) {
      return Promise.reject(
        new Error(`already waiting for transport message ${message.msgId}`),
      )
    }

    const result = new Promise<SuccessfulReceiptStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.#receiptWaiters.get(message.msgId)
        if (waiter?.timer !== timer) return
        this.#receiptWaiters.delete(message.msgId)
        reject(
          new Error(
            `message ${message.msgId} was not receipted within ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)
      this.#receiptWaiters.set(message.msgId, { resolve, reject, timer })
    })

    try {
      this.send(message)
    } catch (error) {
      const waiter = this.#receiptWaiters.get(message.msgId)
      if (waiter !== undefined) {
        this.#receiptWaiters.delete(message.msgId)
        clearTimeout(waiter.timer)
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return result
  }

  waitForDrain(timeoutMs = 5_000): Promise<void> {
    if (this.#messages.size === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#drainWaiters.delete(waiter)
        reject(new Error(`outbox did not drain within ${timeoutMs}ms`))
      }, timeoutMs)
      const waiter = {
        resolve: (): void => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error: Error): void => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.#drainWaiters.add(waiter)
    })
  }

  replay(): void {
    if (!this.#options.canWrite()) return
    for (const message of this.#messages.values()) this.#options.write(message)
  }

  receive(frame: ReceiptFrame): void {
    const known = this.#messages.delete(frame.msgId)
    const waiter = this.#receiptWaiters.get(frame.msgId)
    if (waiter !== undefined) {
      this.#receiptWaiters.delete(frame.msgId)
      clearTimeout(waiter.timer)
    }

    this.#options.onReceipt?.(frame, known)
    if (frame.status === ReceiptStatus.Rejected) {
      waiter?.reject(new TransportReceiptError(frame))
    } else {
      waiter?.resolve(frame.status)
    }

    if (this.#messages.size === 0) {
      const waiters = [...this.#drainWaiters]
      this.#drainWaiters.clear()
      for (const waiter of waiters) waiter.resolve()
    }
  }

  close(error: Error): void {
    for (const waiter of this.#receiptWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#receiptWaiters.clear()
    // Drain waiters get the close reason, not silence: a caller blocked here
    // when the channel died would otherwise wait out its own timeout and then
    // be told "did not drain", which describes the symptom and hides the cause.
    const draining = [...this.#drainWaiters]
    this.#drainWaiters.clear()
    for (const waiter of draining) waiter.reject(error)
    // Nothing here can ever be receipted now; keeping the envelopes would make
    // `pending` report a queue that no longer exists.
    this.#messages.clear()
  }
}
