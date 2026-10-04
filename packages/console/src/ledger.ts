// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The line format of the account book and the session table: an append-only,
 * hash-chained NDJSON file, read strictly.
 *
 * ## Same chain as `@qianmo/audit`, different record
 *
 * Each line carries the SHA-256 of the previous line's canonical form, the
 * first one {@link GENESIS_PREVIOUS} — the construction `@qianmo/audit` uses,
 * so an edit, a deletion in the middle or a reordering breaks the chain from
 * that line on. The record itself is not an `AuditRecord`: that shape names
 * its writer through the closed `AuditSource` enum, and the console's ledger
 * page renders every member of that enum into its source filter. Adding a
 * `console` member would change the page of every console that never turns
 * accounts on, which is exactly what P15 promises not to do
 * (`tenancy-m1.md` §1.5, M-0). Borrowing an existing member would put account
 * records under a writer that did not write them.
 *
 * ## Strict, because the lenient reading is the dangerous one
 *
 * The chat transcript skips a line it cannot read (`console.md` §6.5): one
 * lost turn is cheaper than a page that will not open. Here the arithmetic is
 * reversed. A `revoked` line that is skipped puts the person it revoked back
 * in, so this reader has exactly two answers — every line parsed, chained and
 * in sequence, or a single {@link LedgerIssue} and no entries at all. A torn
 * last line is an issue too: the chain before it is still intact, and an
 * operator who has looked at it can cut it off, but the console does not
 * decide on its own that a half-written line did not matter.
 *
 * What the chain does not catch is truncation at the tail, or a whole file
 * swapped for an older copy. Both need write access to the console's config
 * root, which is the hub-compromise case `tenancy-m1.md` §1.4 lists as not
 * defended.
 */

import { createHash } from 'node:crypto'
import { GENESIS_PREVIOUS } from '@qianmo/audit'

/** A value a ledger record may hold. Flat on purpose: no nesting to canonicalise. */
export type LedgerValue = string | number | boolean

/** One record's payload. */
export type LedgerData = Readonly<Record<string, LedgerValue>>

/** One line of the ledger, as it lands on disk. */
export interface LedgerEntry {
  /** Position in the file, from 1. */
  readonly seq: number
  /** Epoch ms. */
  readonly at: number
  readonly kind: string
  readonly data: LedgerData
  /** SHA-256 of the previous entry's canonical form. */
  readonly prev: string
}

/** Why a ledger could not be read. The first problem found, never a list. */
interface LedgerIssue {
  /** 1-based line number, or 0 for a whole-file problem. */
  readonly line: number
  readonly reason: string
}

/** Either every entry, or the reason there are none. */
type LedgerReadResult =
  | { readonly ok: true; readonly entries: readonly LedgerEntry[] }
  | { readonly ok: false; readonly issue: LedgerIssue }

const KEYS = ['at', 'data', 'kind', 'prev', 'seq'] as const
const DIGEST = /^[0-9a-f]{64}$/
/**
 * Data keys are plain identifiers. Besides keeping the format boring, this is
 * what keeps `__proto__` out of the object the reader builds.
 */
const DATA_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/

/**
 * The bytes an entry hashes as. Field order and data-key order are fixed here,
 * so two writers that build the same entry differently still chain the same.
 */
function canonical(entry: LedgerEntry): string {
  const data = Object.keys(entry.data)
    .sort()
    .map(key => [key, entry.data[key]])
  return JSON.stringify([entry.seq, entry.at, entry.kind, data, entry.prev])
}

/** SHA-256 of an entry's canonical form, hex. */
export function ledgerDigest(entry: LedgerEntry): string {
  return createHash('sha256').update(canonical(entry), 'utf8').digest('hex')
}

/** The line to append for `entry`, newline included. */
export function encodeLedgerEntry(entry: LedgerEntry): string {
  return `${JSON.stringify({
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    data: entry.data,
    prev: entry.prev,
  })}\n`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseData(value: unknown): LedgerData | null {
  if (!isPlainObject(value)) return null
  const out: Record<string, LedgerValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!DATA_KEY.test(key)) return null
    if (typeof item === 'string' || typeof item === 'boolean') {
      out[key] = item
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      out[key] = item
    } else {
      return null
    }
  }
  return out
}

function parseLine(line: string): LedgerEntry | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return '不是 JSON'
  }
  if (!isPlainObject(parsed)) return '不是对象'
  const keys = Object.keys(parsed).sort()
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i])) {
    return '字段集不对'
  }
  const { seq, at, kind, prev } = parsed
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    return 'seq 不对'
  }
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    return 'at 不对'
  }
  if (typeof kind !== 'string' || kind.length === 0) return 'kind 不对'
  if (typeof prev !== 'string' || !DIGEST.test(prev)) return 'prev 不对'
  const data = parseData(parsed['data'])
  if (data === null) return 'data 不对'
  return { seq, at, kind, data, prev }
}

/**
 * Read a whole ledger strictly. See the module note for why there is no
 * partial answer.
 */
export function readLedger(text: string): LedgerReadResult {
  if (text.length === 0) return { ok: true, entries: [] }
  if (!text.endsWith('\n')) {
    const lines = text.split('\n').length
    return { ok: false, issue: { line: lines, reason: '末行不完整' } }
  }
  const lines = text.slice(0, -1).split('\n')
  const entries: LedgerEntry[] = []
  let previous = GENESIS_PREVIOUS
  for (const [index, line] of lines.entries()) {
    const entry = parseLine(line)
    if (typeof entry === 'string') {
      return { ok: false, issue: { line: index + 1, reason: entry } }
    }
    if (entry.seq !== index + 1) {
      return { ok: false, issue: { line: index + 1, reason: 'seq 不连续' } }
    }
    if (entry.prev !== previous) {
      return { ok: false, issue: { line: index + 1, reason: '哈希链断开' } }
    }
    entries.push(entry)
    previous = ledgerDigest(entry)
  }
  return { ok: true, entries }
}

/** The `prev` the next entry after `entries` must carry. */
export function nextPrevious(entries: readonly LedgerEntry[]): string {
  const last = entries.at(-1)
  return last === undefined ? GENESIS_PREVIOUS : ledgerDigest(last)
}
