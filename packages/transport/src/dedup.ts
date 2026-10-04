// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { deliveryExpiresAt, type QianmoMessage } from '@qianmo/protocol'

/**
 * Receiver-side dedup, the other half of at-least-once delivery.
 *
 * Two levels, exactly as protocol.md §7.2 defines them, because they catch
 * different failures:
 *
 * | level | key           | catches                                          |
 * |-------|---------------|--------------------------------------------------|
 * | 1     | `msgId`       | the transport resending the same envelope         |
 * | 2     | `fingerprint` | a restarted sender rebuilding the same work item  |
 *
 * Both entries expire at the envelope's own **delivery** deadline. That is not
 * an arbitrary retention window: past it the message is `expired` anyway, so a
 * late retransmission is refused by the deadline check rather than by dedup,
 * and keeping the key longer would only grow the table.
 *
 * The fingerprint is treated as an opaque key and never recomputed here —
 * `@qianmo/protocol` is explicit that it identifies a resend *by the same
 * sender implementation*, not a canonical equivalence across implementations.
 */

/** Result of {@link DedupTable.admit}. */
export enum DedupVerdict {
  /** Not seen before; the caller should handle it. */
  Fresh = 'fresh',
  /** Same envelope arriving again (level 1). */
  DuplicateMsgId = 'duplicate-msgid',
  /** Same work item, rebuilt by the sender (level 2). */
  DuplicateFingerprint = 'duplicate-fingerprint',
}

export interface DedupOptions {
  /** Injected clock; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Hard cap on retained entries. Reached only under abuse — the deadline
   * normally keeps the table small — and then the soonest-expiring entries go
   * first, which is the closest thing to "the ones we need least".
   */
  readonly maxEntries?: number
}

/** Default cap: generous next to `LIMITS.ratePerMinute`, still bounded. */
export const DEFAULT_MAX_ENTRIES = 10_000

interface Entry {
  readonly msgId: string
  readonly fingerprint: string
  readonly expiresAt: number
}

export class DedupTable {
  private readonly byMsgId = new Map<string, Entry>()
  private readonly byFingerprint = new Map<string, Entry>()
  private readonly now: () => number
  private readonly maxEntries: number

  constructor(options: DedupOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /** Entries currently retained (level-1 keys). */
  get size(): number {
    return this.byMsgId.size
  }

  /**
   * Classify a message and, when it is fresh, record it.
   *
   * Recording happens here rather than after the handler so that two copies
   * arriving back to back cannot both slip through; a handler that then fails
   * calls {@link forget} to put the message back in play.
   */
  admit(message: QianmoMessage): DedupVerdict {
    const now = this.now()
    this.pruneExpired(now)

    const seenById = this.byMsgId.get(message.msgId)
    if (seenById !== undefined && seenById.expiresAt > now) {
      return DedupVerdict.DuplicateMsgId
    }
    const seenByFingerprint = this.byFingerprint.get(message.fingerprint)
    if (seenByFingerprint !== undefined && seenByFingerprint.expiresAt > now) {
      return DedupVerdict.DuplicateFingerprint
    }

    const entry: Entry = {
      msgId: message.msgId,
      fingerprint: message.fingerprint,
      expiresAt: deliveryExpiresAt(message),
    }
    this.byMsgId.set(entry.msgId, entry)
    this.byFingerprint.set(entry.fingerprint, entry)
    this.enforceCap()
    return DedupVerdict.Fresh
  }

  /** True when this exact envelope is currently remembered. */
  hasMsgId(msgId: string): boolean {
    const entry = this.byMsgId.get(msgId)
    return entry !== undefined && entry.expiresAt > this.now()
  }

  /**
   * Drop what {@link admit} recorded for `message`.
   *
   * The one legitimate caller is a receiver whose handler threw: the message
   * was never handled, so remembering it would turn a transient failure into
   * permanent silent loss when the sender retries.
   */
  forget(message: QianmoMessage): void {
    this.byMsgId.delete(message.msgId)
    const byFingerprint = this.byFingerprint.get(message.fingerprint)
    if (byFingerprint !== undefined && byFingerprint.msgId === message.msgId) {
      this.byFingerprint.delete(message.fingerprint)
    }
  }

  /** Drop every expired entry; returns how many went. */
  pruneExpired(now: number = this.now()): number {
    let removed = 0
    for (const [msgId, entry] of this.byMsgId) {
      if (entry.expiresAt <= now) {
        this.byMsgId.delete(msgId)
        const current = this.byFingerprint.get(entry.fingerprint)
        if (current !== undefined && current.msgId === msgId) {
          this.byFingerprint.delete(entry.fingerprint)
        }
        removed += 1
      }
    }
    return removed
  }

  clear(): void {
    this.byMsgId.clear()
    this.byFingerprint.clear()
  }

  private enforceCap(): void {
    if (this.byMsgId.size <= this.maxEntries) return
    const ordered = [...this.byMsgId.values()].sort(
      (a, b) => a.expiresAt - b.expiresAt,
    )
    const excess = this.byMsgId.size - this.maxEntries
    for (let index = 0; index < excess; index += 1) {
      const entry = ordered[index]
      if (entry === undefined) break
      this.byMsgId.delete(entry.msgId)
      const current = this.byFingerprint.get(entry.fingerprint)
      if (current !== undefined && current.msgId === entry.msgId) {
        this.byFingerprint.delete(entry.fingerprint)
      }
    }
  }
}
