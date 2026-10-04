// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const COMPACT_AFTER_RETIREMENTS = 128

/**
 * How many times one reply is put on the wire before the ledger gives up.
 *
 * Three, matching the admission ledger's recovery ceiling for the same reason:
 * a reply that three separate lives of this node could not get receipted is
 * not going to be got receipted by a fourth, and the entry would otherwise be
 * retried on every reconnect for as long as the file exists.
 */
export const MAX_DELIVERY_ATTEMPTS = 3

export type DeliveryPhase = 'pending' | 'attempting'

/** A reply this node still owes a peer. */
export interface DeliveryLedgerEntry {
  readonly deliveryId: string
  /** Correlation key of the task this reply terminates (rule C-1). */
  readonly taskId: string
  /** Node segment of the recipient — which channel this has to go back on. */
  readonly peerNode: string
  /**
   * The reply envelope, held opaquely.
   *
   * This package does not construct or validate protocol messages, and it is
   * not about to learn how just to persist one: it stores what the host handed
   * it and hands the same thing back. Re-minting the envelope on redelivery is
   * the host's job, because only the host knows that an expired `deliverTtlMs`
   * has to become a fresh envelope rather than a retransmission (protocol.md
   * §14.4③).
   */
  readonly envelope: Readonly<Record<string, unknown>>
  readonly openedAt: number
  readonly attempts: number
  readonly phase: DeliveryPhase
}

export interface DeliveryIntegrityIssue {
  readonly line: number
  readonly kind: 'corrupt_line' | 'torn_tail'
}

export interface DeliveryLedger {
  open(input: {
    readonly taskId: string
    readonly peerNode: string
    readonly envelope: Readonly<Record<string, unknown>>
  }): string | undefined
  attempt(deliveryId: string): number
  settle(
    deliveryId: string,
    outcome: 'delivered' | 'failed',
    reason?: string,
  ): void
  abandon(deliveryId: string, reason: string): void
  outstanding(peerNode?: string): readonly DeliveryLedgerEntry[]
  close(): void
}

interface OpenRecord {
  readonly kind: 'pending'
  readonly deliveryId: string
  readonly taskId: string
  readonly peerNode: string
  readonly envelope: Readonly<Record<string, unknown>>
  readonly at: number
}

interface AttemptRecord {
  readonly kind: 'attempting'
  readonly deliveryId: string
  readonly at: number
  readonly attempt: number
}

interface RetireRecord {
  readonly kind: 'delivered' | 'failed' | 'abandoned'
  readonly deliveryId: string
  readonly at: number
  readonly reason?: string
}

type DeliveryRecord = OpenRecord | AttemptRecord | RetireRecord

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isFiniteAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseRecord(value: unknown): DeliveryRecord | undefined {
  const candidate = asRecord(value)
  if (candidate === undefined) return undefined
  if (!isNonEmpty(candidate.deliveryId) || !isFiniteAt(candidate.at)) {
    return undefined
  }
  if (candidate.kind === 'pending') {
    const envelope = asRecord(candidate.envelope)
    if (
      envelope === undefined ||
      !isNonEmpty(candidate.taskId) ||
      !isNonEmpty(candidate.peerNode)
    ) {
      return undefined
    }
    return {
      kind: 'pending',
      deliveryId: candidate.deliveryId,
      taskId: candidate.taskId,
      peerNode: candidate.peerNode,
      envelope,
      at: candidate.at,
    }
  }
  if (candidate.kind === 'attempting') {
    if (
      typeof candidate.attempt !== 'number' ||
      !Number.isInteger(candidate.attempt) ||
      candidate.attempt < 1
    ) {
      return undefined
    }
    return {
      kind: 'attempting',
      deliveryId: candidate.deliveryId,
      at: candidate.at,
      attempt: candidate.attempt,
    }
  }
  if (
    candidate.kind === 'delivered' ||
    candidate.kind === 'failed' ||
    candidate.kind === 'abandoned'
  ) {
    if (
      candidate.reason !== undefined &&
      typeof candidate.reason !== 'string'
    ) {
      return undefined
    }
    return {
      kind: candidate.kind,
      deliveryId: candidate.deliveryId,
      at: candidate.at,
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    }
  }
  return undefined
}

interface OutstandingState {
  readonly open: OpenRecord
  attempts: number
  phase: DeliveryPhase
}

/**
 * The delivery obligation ledger (design §3.B1, hermes B1).
 *
 * ## The hole it fills
 *
 * `#settleTask` puts a terminal `task.result` on the wire and waits for the
 * transport receipt. When that receipt does not come, the only thing that
 * happens today is a call to `onError` — the answer a peer was waiting for is
 * gone, with nothing anywhere that remembers it was owed. That is the single
 * **traceless loss** the state review named, and this file is the record that
 * makes it traceable: four states, `pending → attempting → delivered / failed`,
 * with a ceiling past which a poison entry becomes `abandoned`.
 *
 * ## What this mechanism deliberately does not do
 *
 * - **It never dials.** A redelivery leaves on the first contact *from* the
 *   peer after a restart, never on a connection this node opens. That is not a
 *   simplification, it is invariant H-2: a resident node does not dial out, and
 *   a redelivery path that did would be the one exception that voids the
 *   property. A peer that never comes back keeps its entry until the ceiling.
 * - **It does not re-mint envelopes.** It stores what it was given. The host
 *   builds the fresh envelope for a redelivery, because "same `taskId`, new
 *   `msgId`, new `createdAt`" is a protocol judgement (protocol.md §14.4③:
 *   retransmitting the original after its `deliverTtlMs` has passed just earns
 *   an `E_TTL_EXPIRED`).
 * - **It does not deduplicate for the peer.** It marks a redelivery so the peer
 *   *can*; suppressing the duplicate is the receiver's business and it already
 *   has `taskId` to do it with.
 * - **It does not throw on damage, unlike the admission ledger.** That
 *   difference is deliberate and worth stating plainly: a torn admission record
 *   means a message this node promised to read may be lost, so it is loud. A
 *   torn *delivery* record means one reply may go out twice or not at all —
 *   worse than nothing, better than a node that refuses to serve. Roadmap
 *   P13.5 puts the reliability kit on the fail-open side of that line, so
 *   damaged lines are counted, reported, and stepped over.
 * - **It has no timer.** Nothing in here retries on a schedule; every attempt
 *   is driven by the host, either at startup or on contact from the peer.
 */
export class FileDeliveryLedger implements DeliveryLedger {
  readonly #path: string
  readonly #now: () => number
  readonly #maxAttempts: number
  readonly #onError: ((error: unknown) => void) | undefined
  readonly #newId: () => string
  readonly #outstanding = new Map<string, OutstandingState>()
  #integrityIssues: DeliveryIntegrityIssue[] = []
  #fd: number | null = null
  #loaded = false
  #retirements = 0

  constructor(
    path: string,
    options: {
      readonly now?: () => number
      readonly maxAttempts?: number
      readonly onError?: (error: unknown) => void
      readonly newDeliveryId?: () => string
    } = {},
  ) {
    if (path.trim() === '') {
      throw new Error('delivery ledger path must not be empty')
    }
    this.#path = path
    this.#now = options.now ?? Date.now
    this.#maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS
    this.#onError = options.onError
    this.#newId = options.newDeliveryId ?? randomUUID
  }

  get path(): string {
    return this.#path
  }

  get maxAttempts(): number {
    return this.#maxAttempts
  }

  /** Damaged lines seen at load. Reported, never fatal. */
  integrityIssues(): readonly DeliveryIntegrityIssue[] {
    this.#load()
    return [...this.#integrityIssues]
  }

  open(input: {
    readonly taskId: string
    readonly peerNode: string
    readonly envelope: Readonly<Record<string, unknown>>
  }): string | undefined {
    this.#load()
    const record: OpenRecord = {
      kind: 'pending',
      deliveryId: this.#newId(),
      taskId: input.taskId,
      peerNode: input.peerNode,
      envelope: input.envelope,
      at: this.#now(),
    }
    if (!this.#append(record)) return undefined
    return record.deliveryId
  }

  /**
   * Claim the next attempt for an entry, returning its number.
   *
   * `0` means "do not send": either the entry is unknown (already retired, or
   * the open write failed) or it has hit the ceiling, in which case it has just
   * been marked `abandoned`.
   */
  attempt(deliveryId: string): number {
    this.#load()
    const state = this.#outstanding.get(deliveryId)
    if (state === undefined) return 0
    if (state.attempts >= this.#maxAttempts) {
      this.abandon(
        deliveryId,
        `delivery abandoned after ${state.attempts} attempts without a receipt`,
      )
      return 0
    }
    const next = state.attempts + 1
    this.#append({
      kind: 'attempting',
      deliveryId,
      at: this.#now(),
      attempt: next,
    })
    // Counted in memory even when the append failed: fail-open must not mean
    // "retry forever". An entry whose attempts cannot be written down still
    // stops at the ceiling for as long as this process is alive.
    state.attempts = next
    state.phase = 'attempting'
    return next
  }

  settle(
    deliveryId: string,
    outcome: 'delivered' | 'failed',
    reason?: string,
  ): void {
    this.#load()
    if (!this.#outstanding.has(deliveryId)) return
    this.#append({
      kind: outcome,
      deliveryId,
      at: this.#now(),
      ...(reason === undefined ? {} : { reason }),
    })
    this.#outstanding.delete(deliveryId)
    this.#afterRetirement()
  }

  abandon(deliveryId: string, reason: string): void {
    this.#load()
    if (!this.#outstanding.has(deliveryId)) return
    this.#append({
      kind: 'abandoned',
      deliveryId,
      at: this.#now(),
      reason,
    })
    this.#outstanding.delete(deliveryId)
    this.#afterRetirement()
  }

  /** Everything still owed, oldest first; optionally for one peer only. */
  outstanding(peerNode?: string): readonly DeliveryLedgerEntry[] {
    this.#load()
    return [...this.#outstanding.values()]
      .filter(
        state => peerNode === undefined || state.open.peerNode === peerNode,
      )
      .sort((left, right) => left.open.at - right.open.at)
      .map(state => ({
        deliveryId: state.open.deliveryId,
        taskId: state.open.taskId,
        peerNode: state.open.peerNode,
        envelope: state.open.envelope,
        openedAt: state.open.at,
        attempts: state.attempts,
        phase: state.phase,
      }))
  }

  close(): void {
    this.#closeHandle()
    this.#loaded = false
    this.#outstanding.clear()
    this.#integrityIssues = []
    this.#retirements = 0
  }

  #afterRetirement(): void {
    this.#retirements++
    if (this.#retirements < COMPACT_AFTER_RETIREMENTS) return
    this.#compact()
  }

  #apply(record: DeliveryRecord): void {
    if (record.kind === 'pending') {
      if (!this.#outstanding.has(record.deliveryId)) {
        this.#outstanding.set(record.deliveryId, {
          open: record,
          attempts: 0,
          phase: 'pending',
        })
      }
      return
    }
    if (record.kind === 'attempting') {
      const state = this.#outstanding.get(record.deliveryId)
      if (state === undefined) return
      // `max`, not `+1`: compaction collapses an entry's attempts into a single
      // record carrying the highest number, so replaying must be idempotent.
      state.attempts = Math.max(state.attempts, record.attempt)
      state.phase = 'attempting'
      return
    }
    this.#outstanding.delete(record.deliveryId)
  }

  #load(): void {
    if (this.#loaded) return
    this.#loaded = true
    this.#outstanding.clear()
    this.#integrityIssues = []
    this.#retirements = 0

    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Fail-open: an unreadable obligation ledger costs visibility, not
        // service.
        this.#onError?.(error)
      }
      return
    }

    const lines = raw.split('\n')
    const tail = lines.pop()
    for (const [index, line] of lines.entries()) {
      if (line === '') continue
      let parsed: DeliveryRecord | undefined
      try {
        parsed = parseRecord(JSON.parse(line))
      } catch {
        parsed = undefined
      }
      if (parsed === undefined) {
        this.#integrityIssues.push({ line: index + 1, kind: 'corrupt_line' })
        continue
      }
      this.#apply(parsed)
    }
    if (tail !== undefined && tail !== '') {
      this.#integrityIssues.push({
        line: lines.length + 1,
        kind: 'torn_tail',
      })
    }
  }

  #handle(): number {
    if (this.#fd === null) {
      const directory = dirname(this.#path)
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
      this.#fd = openSync(
        this.#path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      chmodSync(this.#path, FILE_MODE)
    }
    return this.#fd
  }

  /** Append one record. Returns false when the write failed (fail-open). */
  #append(record: DeliveryRecord): boolean {
    try {
      const fd = this.#handle()
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } catch (error) {
      this.#onError?.(error)
      // Applied in memory regardless, so this process still behaves correctly
      // for the rest of its life; only the crash-recovery half is lost.
      this.#apply(record)
      return false
    }
    this.#apply(record)
    return true
  }

  /**
   * Rewrite the file down to what is still owed.
   *
   * Never refuses on damage — see the class comment. Compacting *is* how a
   * damaged file heals here: the unparseable lines are the ones left behind.
   */
  #compact(): void {
    const entries = this.outstanding()
    const directory = dirname(this.#path)
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    try {
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
      const fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      try {
        const body = entries
          .flatMap(entry => {
            const open: OpenRecord = {
              kind: 'pending',
              deliveryId: entry.deliveryId,
              taskId: entry.taskId,
              peerNode: entry.peerNode,
              envelope: entry.envelope,
              at: entry.openedAt,
            }
            const lines = [`${JSON.stringify(open)}\n`]
            if (entry.attempts > 0) {
              lines.push(
                `${JSON.stringify({
                  kind: 'attempting',
                  deliveryId: entry.deliveryId,
                  at: entry.openedAt,
                  attempt: entry.attempts,
                })}\n`,
              )
            }
            return lines
          })
          .join('')
        writeFileSync(fd, body)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      this.#closeHandle()
      renameSync(temporary, this.#path)
      this.#integrityIssues = []
      this.#retirements = 0
    } catch (error) {
      rmSync(temporary, { force: true })
      this.#onError?.(error)
    }
  }

  #closeHandle(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
  }
}
