// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { isValidSegment } from '@qianmo/protocol'
import { RETRIEVAL_MODES } from '@qianmo/recall'
import type {
  AdmissionIntegrityIssue,
  AdmissionLedger,
  AdmissionQueryResult,
  AdmissionRecord,
  DetectedAdmissionRecord,
  PendingAdmission,
  ResidentMailboxMessage,
} from './contracts.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMPACT_AFTER_READS = 128

/**
 * Recovery hand-offs one `detected` record survives before it is abandoned
 * (design §3.B3, hermes B3).
 *
 * The gap this closes: `ResidentMailboxReader` replays every pending `detected`
 * record on the next poll, and **nothing counted them**. If the record is what
 * crashed the node, replaying it crashes the node again — an unbounded crash
 * loop with no counter anywhere to stop it. The supervisor's own
 * `maxRapidFailures` does not help: it parks the *node*, which is the outcome
 * this breaker exists to avoid.
 *
 * Three, and what that buys, precisely: the record is retried on hand-offs 1
 * and 2, and the hand-off that would be the third retires it instead. So after
 * three restarts the record is gone and the node is serving new messages —
 * which is the shape roadmap P13.5 asks for. A restart produces exactly one
 * hand-off when the record kills the node during it; a record that merely fails
 * its turn without taking the node down burns its three in place, which is the
 * same verdict reached sooner and is equally correct.
 */
export const MAX_ADMISSION_RECOVERIES = 3

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const allowed = [...expected].sort()
  return (
    actual.length === allowed.length &&
    actual.every((key, index) => key === allowed[index])
  )
}

function isMailboxMessage(value: unknown): value is ResidentMailboxMessage {
  const message = record(value)
  if (message === undefined) return false
  const optional = [
    ...(message.color === undefined ? [] : ['color']),
    ...(message.summary === undefined ? [] : ['summary']),
  ]
  return (
    exactKeys(message, ['from', 'text', 'timestamp', 'read', ...optional]) &&
    typeof message.from === 'string' &&
    typeof message.text === 'string' &&
    typeof message.timestamp === 'string' &&
    typeof message.read === 'boolean' &&
    (message.color === undefined || typeof message.color === 'string') &&
    (message.summary === undefined || typeof message.summary === 'string')
  )
}

function isDetected(
  value: Record<string, unknown>,
): value is Record<string, unknown> & DetectedAdmissionRecord {
  return (
    exactKeys(value, [
      'kind',
      'messageId',
      'sessionId',
      'detectedAt',
      'agent',
      'team',
      'readBefore',
      'snapshot',
      'prompt',
      ...(value.networkMsgId === undefined ? [] : ['networkMsgId']),
      ...(value.retrieval === undefined ? [] : ['retrieval']),
    ]) &&
    value.kind === 'detected' &&
    typeof value.messageId === 'string' &&
    UUID_PATTERN.test(value.messageId) &&
    typeof value.sessionId === 'string' &&
    UUID_PATTERN.test(value.sessionId) &&
    typeof value.detectedAt === 'number' &&
    Number.isFinite(value.detectedAt) &&
    value.detectedAt >= 0 &&
    isValidSegment(value.agent) &&
    isValidSegment(value.team) &&
    record(value.readBefore) !== undefined &&
    Object.entries(record(value.readBefore) ?? {}).every(
      ([identity, count]) =>
        identity.length > 0 &&
        typeof count === 'number' &&
        Number.isInteger(count) &&
        count >= 0,
    ) &&
    Array.isArray(value.snapshot) &&
    value.snapshot.length > 0 &&
    value.snapshot.every(isMailboxMessage) &&
    typeof value.prompt === 'string' &&
    value.prompt.length > 0 &&
    (value.networkMsgId === undefined ||
      (typeof value.networkMsgId === 'string' &&
        value.networkMsgId.length > 0)) &&
    (value.retrieval === undefined ||
      RETRIEVAL_MODES.some(mode => mode === value.retrieval))
  )
}

function isMessageStamp(value: Record<string, unknown>): boolean {
  return (
    typeof value.messageId === 'string' &&
    UUID_PATTERN.test(value.messageId) &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    value.at >= 0
  )
}

function isTransition(
  value: Record<string, unknown>,
): value is Record<string, unknown> & AdmissionRecord {
  return (
    exactKeys(value, ['kind', 'messageId', 'at']) &&
    (value.kind === 'admitted' || value.kind === 'read') &&
    isMessageStamp(value)
  )
}

function isRecovering(
  value: Record<string, unknown>,
): value is Record<string, unknown> & AdmissionRecord {
  return (
    exactKeys(value, ['kind', 'messageId', 'at', 'attempt']) &&
    value.kind === 'recovering' &&
    isMessageStamp(value) &&
    typeof value.attempt === 'number' &&
    Number.isInteger(value.attempt) &&
    value.attempt >= 1
  )
}

function isAbandoned(
  value: Record<string, unknown>,
): value is Record<string, unknown> & AdmissionRecord {
  return (
    exactKeys(value, ['kind', 'messageId', 'at', 'attempts', 'reason']) &&
    value.kind === 'abandoned' &&
    isMessageStamp(value) &&
    typeof value.attempts === 'number' &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 0 &&
    typeof value.reason === 'string' &&
    value.reason.length > 0
  )
}

function isAdmissionRecord(value: unknown): value is AdmissionRecord {
  const candidate = record(value)
  return (
    candidate !== undefined &&
    (isDetected(candidate) ||
      isTransition(candidate) ||
      isRecovering(candidate) ||
      isAbandoned(candidate))
  )
}

function validateRecord(value: AdmissionRecord): void {
  if (!isAdmissionRecord(value)) throw new Error('invalid admission record')
}

export class FileAdmissionLedger implements AdmissionLedger {
  readonly #path: string
  readonly #pending = new Map<string, PendingAdmission>()
  #fd: number | null = null
  #loaded = false
  #integrityIssues: AdmissionIntegrityIssue[] = []
  #readsSinceCompaction = 0

  constructor(path: string) {
    if (path.trim() === '') throw new Error('ledger path must not be empty')
    this.#path = path
  }

  get path(): string {
    return this.#path
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

  #apply(value: AdmissionRecord): void {
    if (value.kind === 'detected') {
      if (!this.#pending.has(value.messageId)) {
        this.#pending.set(value.messageId, {
          ...value,
          attempts: 0,
          phase: 'detected',
        })
      }
      return
    }

    if (value.kind === 'admitted') {
      const detected = this.#pending.get(value.messageId)
      if (detected?.phase === 'detected') {
        this.#pending.set(value.messageId, {
          ...detected,
          phase: 'admitted',
          admittedAt: value.at,
        })
      }
      return
    }

    if (value.kind === 'recovering') {
      const pending = this.#pending.get(value.messageId)
      if (pending === undefined) return
      // `max`, not `+1`: compaction writes one `recovering` record carrying the
      // highest attempt, so replaying the file has to be idempotent.
      this.#pending.set(value.messageId, {
        ...pending,
        attempts: Math.max(pending.attempts, value.attempt),
      })
      return
    }

    // `read` and `abandoned` are the only two retirements. See
    // `AbandonedAdmissionRecord`.
    this.#pending.delete(value.messageId)
  }

  #load(): void {
    if (this.#loaded) return

    this.#pending.clear()
    this.#integrityIssues = []
    this.#readsSinceCompaction = 0
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#loaded = true
        return
      }
      throw error
    }

    const lines = raw.split('\n')
    const tail = lines.pop()
    for (const [index, line] of lines.entries()) {
      if (line === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isAdmissionRecord(parsed)) this.#apply(parsed)
        else
          this.#integrityIssues.push({
            line: index + 1,
            kind: 'corrupt_line',
          })
      } catch {
        this.#integrityIssues.push({
          line: index + 1,
          kind: 'corrupt_line',
        })
      }
    }
    if (tail !== undefined && tail !== '') {
      this.#integrityIssues.push({
        line: lines.length + 1,
        kind: 'torn_tail',
      })
    }
    this.#loaded = true
  }

  append(value: AdmissionRecord): void {
    validateRecord(value)
    this.#load()
    const fd = this.#handle()
    writeSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
    this.#apply(value)

    if (value.kind === 'read') this.#readsSinceCompaction++
  }

  recordRecovery(messageId: string, at: number): number {
    this.#load()
    const pending = this.#pending.get(messageId)
    if (pending === undefined) return 0
    const attempt = pending.attempts + 1
    this.append({ kind: 'recovering', messageId, at, attempt })
    return attempt
  }

  abandon(messageId: string, at: number, reason: string): void {
    this.#load()
    const pending = this.#pending.get(messageId)
    if (pending === undefined) return
    this.append({
      kind: 'abandoned',
      messageId,
      at,
      attempts: pending.attempts,
      reason,
    })
    // Retiring a record is what compaction is for; count it the same way a
    // `read` is counted so an abandoning node still trims its file.
    this.#readsSinceCompaction++
  }

  #result(): AdmissionQueryResult {
    return {
      pending: [...this.#pending.values()].sort(
        (left, right) => left.detectedAt - right.detectedAt,
      ),
      integrityIssues: [...this.#integrityIssues],
    }
  }

  query(): AdmissionQueryResult {
    this.#load()
    if (this.#readsSinceCompaction >= COMPACT_AFTER_READS) this.#compactLoaded()
    return this.#result()
  }

  compact(): void {
    this.#load()
    this.#compactLoaded()
  }

  #compactLoaded(): void {
    const result = this.#result()
    if (result.integrityIssues.length > 0) {
      throw new Error('cannot compact a damaged admission ledger')
    }
    const directory = dirname(this.#path)
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(directory, DIRECTORY_MODE)
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      try {
        const body = result.pending
          .flatMap(pending => {
            // `attempts` is derived state, not a field of the `detected`
            // record — leaving it in would make the rewritten line fail the
            // exact-key check on the next load, which is to say compaction
            // would corrupt the very file it just tidied.
            const lines: string[] = []
            if (pending.phase === 'detected') {
              const { phase, attempts, ...detected } = pending
              lines.push(`${JSON.stringify(detected)}\n`)
            } else {
              const { phase, attempts, admittedAt, ...detected } = pending
              lines.push(
                `${JSON.stringify(detected)}\n`,
                `${JSON.stringify({
                  kind: 'admitted',
                  messageId: detected.messageId,
                  at: admittedAt,
                })}\n`,
              )
            }
            // One record for the whole history: the breaker only ever reads the
            // total, and `#apply` takes the maximum so replay stays idempotent.
            if (pending.attempts > 0) {
              lines.push(
                `${JSON.stringify({
                  kind: 'recovering',
                  messageId: pending.messageId,
                  at: pending.detectedAt,
                  attempt: pending.attempts,
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
      this.#readsSinceCompaction = 0
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }

  #closeHandle(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
  }

  close(): void {
    this.#closeHandle()
    this.#loaded = false
    this.#pending.clear()
    this.#integrityIssues = []
    this.#readsSinceCompaction = 0
  }
}
