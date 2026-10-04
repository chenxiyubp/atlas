// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The append-only trail on disk, and the honest version of "cannot be changed".
 *
 * ## What is actually enforced, and what is only detectable
 *
 * P7.2's DoD says "审计日志的修改尝试被拒". Three different things could mean,
 * and they are worth separating because only two of them are true here:
 *
 * 1. **The writer cannot modify** — enforced. The file descriptor is opened
 *    `O_APPEND | O_NOFOLLOW`, so every write lands at the end whatever offset
 *    anyone thinks they are at, and this class has no method that seeks,
 *    truncates, rewrites or deletes. There is no API through which the running
 *    system can alter its own history.
 * 2. **An outside edit is detectable** — enforced. Each record carries the
 *    hash of the previous one, so changing, removing or reordering any line
 *    breaks the chain from that point on and {@link readTrail} reports the
 *    first break by sequence number.
 * 3. **An outside edit is prevented** — **not** enforced. An operator with
 *    write access can still rewrite the file and recompute the chain, but an
 *    off-host witness detects that rewrite once the affected prefix is
 *    anchored. The exception is the anchoring window; its boundary and
 *    deployment conditions live in `docs/dev/audit-witness.md` §7.
 *
 * Same file discipline as `@qianmo/sandbox`'s audit — 0700 directory, 0600
 * file, `fsync` per record — because a trail that loses its last lines in a
 * crash is a trail that goes blank exactly when it is being consulted.
 */

import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  GENESIS_PREVIOUS,
  digestOf,
  type AuditInput,
  type AuditRecord,
} from './record.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

/** Why a line could not be read, or does not belong where it is. */
export interface TrailIntegrityIssue {
  /** 1-based line number in the file. */
  readonly line: number
  readonly kind: 'corrupt_line' | 'torn_tail' | 'broken_chain' | 'out_of_order'
  /** The record's own `seq`, when the line parsed at all. */
  readonly seq?: number
}

export interface TrailReadResult {
  readonly records: readonly AuditRecord[]
  readonly issues: readonly TrailIntegrityIssue[]
  /** True when every line parsed and the hash chain holds end to end. */
  readonly intact: boolean
  /**
   * Whether there was a file to read at all.
   *
   * Separated from `intact` because the two answers a caller most needs to
   * keep apart otherwise look identical: a trail that exists and holds no
   * records yet (a node that has done no protocol work — normal) reads
   * `records: []`, and so does a trail whose file is not there (the node never
   * wrote one, or the copy that was meant to arrive never did — not normal).
   * `intact` cannot carry that distinction: an absent file has no chain, so
   * both `true` and `false` are false statements about it.
   */
  readonly present: boolean
}

/** Append-only writer. No update, no delete, no seek — by construction. */
export class AuditTrail {
  readonly path: string
  #fd: number | null = null
  #seq = 0
  #prev = GENESIS_PREVIOUS

  constructor(path: string) {
    if (path.trim() === '') throw new Error('audit path must not be empty')
    this.path = path
    // Resume the chain from whatever is already on disk. A process that
    // restarted and began a fresh chain would leave a break that looks exactly
    // like tampering — and an integrity check that cries wolf on every restart
    // is one nobody reads.
    const existing = readTrail(path)
    const last = existing.records.at(-1)
    if (last !== undefined) {
      this.#seq = last.seq
      this.#prev = digestOf(last)
    }
  }

  /** Records written by this instance. */
  get written(): number {
    return this.#seq
  }

  #handle(): number {
    if (this.#fd === null) {
      const directory = dirname(this.path)
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
      this.#fd = openSync(
        this.path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      chmodSync(this.path, FILE_MODE)
    }
    return this.#fd
  }

  /**
   * Create the file now, empty, rather than on the first record.
   *
   * Without this a node that has done no protocol work has **no trail file**,
   * and "this node has nothing to report" is then indistinguishable from "the
   * trail never reached me" — which is the state an operator has to be able to
   * see, because it is the one where the audit surface is broken rather than
   * quiet. Opt-in rather than done in the constructor: a reader that only
   * wants to resume a chain should not leave a file behind.
   */
  ensure(): void {
    this.#handle()
  }

  /** Append one record. Returns exactly what was written. */
  append(input: AuditInput): AuditRecord {
    const record: AuditRecord = {
      ...input,
      seq: this.#seq + 1,
      prev: this.#prev,
    }
    const fd = this.#handle()
    writeSync(fd, `${JSON.stringify(record)}\n`)
    // Per record, not per batch: the lines that matter most are the ones
    // written just before something went wrong.
    fsyncSync(fd)
    this.#seq = record.seq
    this.#prev = digestOf(record)
    return record
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
  }
}

function parseRecord(line: string): AuditRecord | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as AuditRecord
    if (
      typeof record.seq !== 'number' ||
      typeof record.at !== 'number' ||
      typeof record.prev !== 'string' ||
      typeof record.kind !== 'string'
    ) {
      return null
    }
    return record
  } catch {
    return null
  }
}

/**
 * Read a trail and check it.
 *
 * A file that ends mid-line is a `torn_tail`, not corruption: it is what a
 * crash during the last write looks like, and calling it tampering would put
 * every hard reset in the same bucket as an edit.
 */
export function readTrail(path: string): TrailReadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No file, so no chain, so no verdict on one. `intact` stays `true` for
      // the callers that only ever asked "did the check find something wrong",
      // and `present: false` is how a caller learns there was nothing to
      // check — see {@link TrailReadResult.present}.
      return { records: [], issues: [], intact: true, present: false }
    }
    throw error
  }

  const lines = raw.split('\n')
  const endsWithNewline = raw.endsWith('\n')
  const records: AuditRecord[] = []
  const issues: TrailIntegrityIssue[] = []
  let previous = GENESIS_PREVIOUS
  let expectedSeq = 1

  for (const [index, line] of lines.entries()) {
    if (line === '') {
      const isLast = index === lines.length - 1
      if (!isLast || !endsWithNewline) {
        if (!isLast) issues.push({ line: index + 1, kind: 'corrupt_line' })
      }
      continue
    }
    const isLastLine = index === lines.length - 1
    const record = parseRecord(line)
    if (record === null) {
      issues.push({
        line: index + 1,
        kind: isLastLine && !endsWithNewline ? 'torn_tail' : 'corrupt_line',
      })
      continue
    }
    if (record.seq !== expectedSeq) {
      issues.push({ line: index + 1, kind: 'out_of_order', seq: record.seq })
    }
    if (record.prev !== previous) {
      issues.push({ line: index + 1, kind: 'broken_chain', seq: record.seq })
    }
    records.push(record)
    previous = digestOf(record)
    expectedSeq = record.seq + 1
  }

  return { records, issues, intact: issues.length === 0, present: true }
}
