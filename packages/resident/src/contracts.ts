// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ProtocolErrorCode } from '@qianmo/protocol'
import type { RetrievalMode } from '@qianmo/recall'

export interface ResidentMailboxMessage {
  readonly from: string
  readonly text: string
  readonly timestamp: string
  readonly read: boolean
  readonly color?: string
  readonly summary?: string
}

/**
 * Which requester a prompt is being assembled for (design §4.4).
 *
 * The two halves stay apart. `sessionKeyOf` is the only place in the repository
 * allowed to join them into a key (§4.3 invariant 7), and a scope that carried
 * the joined form would be a second such place by the back door.
 */
export interface ResidentPromptScope {
  readonly agent: string
  /** Absent means the requester sent none; it falls back to `DEFAULT_CONTEXT`. */
  readonly contextId: string | undefined
}

export interface DetectedAdmissionRecord {
  readonly kind: 'detected'
  readonly messageId: string
  readonly sessionId: string
  readonly detectedAt: number
  readonly agent: string
  readonly team: string
  readonly readBefore: Readonly<Record<string, number>>
  readonly snapshot: readonly ResidentMailboxMessage[]
  readonly prompt: string
  readonly networkMsgId?: string
  /**
   * How this turn's memory block was retrieved (`docs/dev/memory-m1.md`
   * §5.4). Written only while the semantic overlay is on, where a timeout can
   * make one turn hybrid and the next deterministic under the same input —
   * the record is what lets "why were these entries shown" be answered
   * afterwards. Absent means M0: the overlay was off, or recall failed and
   * the turn carried no block.
   */
  readonly retrieval?: RetrievalMode
}

/**
 * A turn's user message together with how its memory block was retrieved.
 * `formatPrompt` returns a bare string when there is nothing to record.
 */
export interface ResidentAssembledPrompt {
  readonly prompt: string
  readonly retrieval?: RetrievalMode
}

/**
 * What a prompt formatter may return. Asynchronous only when the semantic
 * overlay has to wait for an embedding (two-stage assembly, §5.4).
 */
export type ResidentFormattedPrompt =
  | string
  | ResidentAssembledPrompt
  | Promise<string | ResidentAssembledPrompt>

export interface AdmittedAdmissionRecord {
  readonly kind: 'admitted'
  readonly messageId: string
  readonly at: number
}

export interface ReadAdmissionRecord {
  readonly kind: 'read'
  readonly messageId: string
  readonly at: number
}

/**
 * One recovery hand-off of a `detected` record that outlived the life that
 * wrote it (design §3.B3, hermes B3).
 *
 * Written **before** the record is acted on, which is the only ordering that
 * survives the failure being counted: a stamp written afterwards is a stamp a
 * crash never writes, and the loop this breaker exists to break is exactly the
 * one where the record takes the node down before it can finish.
 */
export interface RecoveringAdmissionRecord {
  readonly kind: 'recovering'
  readonly messageId: string
  readonly at: number
  /** 1-based, and the value carried across compaction. */
  readonly attempt: number
}

/**
 * A `detected` record retired without ever being read.
 *
 * The **only** retirement other than `read`, and it exists so that the ledger's
 * "a promise is kept until it is fulfilled" property has a bounded exception
 * rather than an unbounded crash loop. It is the terminal state of the restart
 * breaker and of nothing else.
 */
export interface AbandonedAdmissionRecord {
  readonly kind: 'abandoned'
  readonly messageId: string
  readonly at: number
  readonly attempts: number
  readonly reason: string
}

export type AdmissionRecord =
  | DetectedAdmissionRecord
  | AdmittedAdmissionRecord
  | ReadAdmissionRecord
  | RecoveringAdmissionRecord
  | AbandonedAdmissionRecord

export type PendingAdmission = DetectedAdmissionRecord & {
  /**
   * Recovery hand-offs this record has already survived. `0` for one detected
   * in this very poll.
   */
  readonly attempts: number
} & (
    | { readonly phase: 'detected' }
    | { readonly phase: 'admitted'; readonly admittedAt: number }
  )

export interface AdmissionIntegrityIssue {
  readonly line: number
  readonly kind: 'corrupt_line' | 'torn_tail'
}

export interface AdmissionQueryResult {
  readonly pending: readonly PendingAdmission[]
  readonly integrityIssues: readonly AdmissionIntegrityIssue[]
}

export interface AdmissionLedger {
  append(record: AdmissionRecord): void
  query(): AdmissionQueryResult
  /**
   * Durably count one recovery hand-off of `messageId`, returning the new
   * total. Callers use the total to decide whether to retry or
   * {@link AdmissionLedger.abandon}.
   */
  recordRecovery(messageId: string, at: number): number
  /** Retire a pending record without a read. See the record type's comment. */
  abandon(messageId: string, at: number, reason: string): void
  compact(): void
  close(): void
}

export interface ResidentMailboxPort {
  readAll(
    agent: string,
    team: string,
  ): Promise<readonly ResidentMailboxMessage[]>
  markRead(
    agent: string,
    team: string,
    snapshot: readonly ResidentMailboxMessage[],
    readBefore: Readonly<Record<string, number>>,
  ): Promise<number>
}

export interface ResidentTurnInput {
  readonly sessionId: string
  readonly messageId: string
  readonly prompt: string
  readonly networkMsgId?: string
  readonly agent?: string
}

export type ResidentTurnResult =
  | { readonly outcome: 'completed'; readonly content: string }
  | {
      readonly outcome: 'failed'
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

export interface ResidentTurnPort {
  isAccepted(input: ResidentTurnInput): Promise<boolean>
  execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult>
}
