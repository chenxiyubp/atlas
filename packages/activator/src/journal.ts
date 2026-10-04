// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The write-ahead journal that makes DoD ④ true.
 *
 * P2.5's fourth acceptance criterion is not "the process restarts" — a
 * supervisor gives you that. It is that a request caught by the activator and
 * then interrupted by `kill -9` ends up **either forwarded or explicitly
 * failed, never silently dropped**. Silence is the outcome to design against:
 * the sender is holding a delivery deadline, and a dropped request looks
 * exactly like a slow one until the deadline passes, at which point nobody can
 * tell whether the message was lost here or somewhere else.
 *
 * The ordering rule that buys this is one line long and everything depends on
 * it: **the `accepted` record is fsynced before the caller is told the request
 * was accepted.** Either the record is on disk, in which case a restart finds
 * it and drives it to a terminal state; or it is not, in which case acceptance
 * was never claimed and the request is still the sender's — and
 * `@qianmo/transport` delivers at least once, so it will come again.
 *
 * Append-only NDJSON, one record per line, compacted on recovery. A crash can
 * only truncate the final line, and a truncated final line is reported as
 * {@link ActivatorEventType.JournalTorn} rather than skipped quietly — the
 * whole file exists to avoid quiet skipping.
 */

import {
  closeSync,
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
import type { QianmoMessage } from '@qianmo/protocol'
import { occConfigPath } from '../../../src/config/paths.js'
import { ActivatorEventType, type AuditLog } from './audit.js'

/** A request was taken in and is now this component's responsibility. */
export interface AcceptedRecord {
  readonly kind: 'accepted'
  /** Identity of this attempt, unique per acceptance. */
  readonly requestId: string
  readonly sandboxName: string
  readonly acceptedAt: number
  readonly envelope: QianmoMessage
}

/** A request left this component's responsibility, one way or the other. */
export interface TerminalRecord {
  readonly kind: 'terminal'
  readonly requestId: string
  readonly at: number
  /** `failed` still means the sender was told; it never means "dropped". */
  readonly outcome: 'forwarded' | 'failed'
  readonly reason?: string
}

export type JournalRecord = AcceptedRecord | TerminalRecord

/** Durable record of what this component still owes an answer for. */
export interface RequestJournal {
  /** Must be durable on return: the caller acts on that guarantee. */
  append(record: JournalRecord): void
  /** Accepted requests with no terminal record. Oldest first. */
  pending(): readonly AcceptedRecord[]
  /** Drop settled records. Safe to skip; it only bounds the file. */
  compact(): void
}

/**
 * Where the journal lives by default.
 *
 * Via {@link occConfigPath}, never `join(homedir(), ...)`: the config root is
 * identity-scoped and overridable, and a hand-built path resolves to one fixed
 * directory, punching through the isolation the whole node identity rests on.
 */
export function defaultJournalPath(): string {
  return occConfigPath('activator', 'inflight.ndjson')
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600

function isRecord(value: unknown): value is JournalRecord {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  const requestId = (value as { requestId?: unknown }).requestId
  if (typeof requestId !== 'string' || requestId === '') return false
  return kind === 'accepted' || kind === 'terminal'
}

/** NDJSON journal on one file. */
export class FileRequestJournal implements RequestJournal {
  readonly #path: string
  readonly #audit: AuditLog | undefined
  #fd: number | null = null

  constructor(path: string = defaultJournalPath(), audit?: AuditLog) {
    this.#path = path
    this.#audit = audit
  }

  get path(): string {
    return this.#path
  }

  #handle(): number {
    if (this.#fd === null) {
      mkdirSync(dirname(this.#path), { recursive: true, mode: DIR_MODE })
      this.#fd = openSync(this.#path, 'a', FILE_MODE)
    }
    return this.#fd
  }

  /**
   * Append one record and flush it.
   *
   * Synchronous and fsynced, both on purpose. The caller's next statement is
   * allowed to assume the record survives a power cut, and an async write would
   * make that assumption false in exactly the window that matters.
   */
  append(record: JournalRecord): void {
    const fd = this.#handle()
    writeSync(fd, `${JSON.stringify(record)}\n`)
    fsyncSync(fd)
  }

  /** Release the file descriptor. The journal reopens on the next append. */
  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
  }

  #read(): { records: JournalRecord[]; torn: number; corrupt: number } {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch {
      return { records: [], torn: 0, corrupt: 0 }
    }
    const lines = raw.split('\n')
    // A file that ends in a newline yields one trailing empty element; a file
    // whose last write was cut short does not. That difference is the only
    // signal available for "the crash landed mid-record", so it is used rather
    // than guessed at.
    const trailing = lines.pop()
    const records: JournalRecord[] = []
    let corrupt = 0
    for (const line of lines) {
      if (line === '') continue
      const parsed = this.#parse(line)
      if (parsed === null) corrupt += 1
      else records.push(parsed)
    }
    let torn = 0
    if (trailing !== undefined && trailing !== '') {
      const parsed = this.#parse(trailing)
      if (parsed === null) torn = 1
      else records.push(parsed)
    }
    return { records, torn, corrupt }
  }

  #parse(line: string): JournalRecord | null {
    try {
      const value: unknown = JSON.parse(line)
      return isRecord(value) ? value : null
    } catch {
      return null
    }
  }

  pending(): readonly AcceptedRecord[] {
    const { records, torn, corrupt } = this.#read()
    if (this.#audit !== undefined && (torn > 0 || corrupt > 0)) {
      // Reported, not swallowed. A torn tail is the expected shape of a crash
      // during an append; a corrupt middle line is not, and the two are told
      // apart so an operator can tell a crash from a damaged disk.
      this.#audit.record(ActivatorEventType.JournalTorn, Date.now(), {
        path: this.#path,
        tornTailLines: torn,
        corruptLines: corrupt,
      })
    }
    const accepted = new Map<string, AcceptedRecord>()
    for (const record of records) {
      if (record.kind === 'accepted') accepted.set(record.requestId, record)
      else accepted.delete(record.requestId)
    }
    return [...accepted.values()].sort((a, b) => a.acceptedAt - b.acceptedAt)
  }

  /**
   * Rewrite the file with only what is still owed.
   *
   * Temp file plus `rename`, same as the registry's store: `rename` within one
   * directory is atomic on POSIX, so a process killed at any instant during
   * compaction leaves either the whole old journal or the whole new one.
   */
  compact(): void {
    const survivors = this.pending()
    const directory = dirname(this.#path)
    mkdirSync(directory, { recursive: true, mode: DIR_MODE })
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    try {
      const handle = openSync(temporary, 'wx', FILE_MODE)
      try {
        const body = survivors
          .map(record => `${JSON.stringify(record)}\n`)
          .join('')
        writeFileSync(handle, body)
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      this.close()
      renameSync(temporary, this.#path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

/** In-memory journal, for callers that accept losing in-flight work on a crash. */
export class MemoryRequestJournal implements RequestJournal {
  readonly #records: JournalRecord[] = []

  append(record: JournalRecord): void {
    this.#records.push(record)
  }

  pending(): readonly AcceptedRecord[] {
    const accepted = new Map<string, AcceptedRecord>()
    for (const record of this.#records) {
      if (record.kind === 'accepted') accepted.set(record.requestId, record)
      else accepted.delete(record.requestId)
    }
    return [...accepted.values()].sort((a, b) => a.acceptedAt - b.acceptedAt)
  }

  compact(): void {
    const survivors = this.pending()
    this.#records.length = 0
    this.#records.push(...survivors)
  }
}
