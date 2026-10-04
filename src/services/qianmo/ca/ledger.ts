// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The issuance ledger: one line per certificate this CA has handed out.
 *
 * ## Why a ledger, when `issued/<node>.crt` already exists
 *
 * That file holds the latest certificate per node, and a re-issue replaces it
 * — every quarter, by design (§6.2). The certificate it replaced is usually
 * still in date, and two things need its fingerprint afterwards: revoking it
 * (`refresh-rl --revoke <node>=<fingerprint256>`), and the compromise review
 * in ca-runbook.md §6.3, which compares every certificate in the registry
 * against what this CA actually signed. Before the ledger, the only copy of
 * that fingerprint was the file that had just been overwritten.
 *
 * ## Append-only, atomic, fail-closed
 *
 * - **Append-only.** A write is the previous bytes, unchanged, plus new lines.
 *   Nothing here rewrites or removes an entry.
 * - **Atomic.** The new content goes to a temporary file beside the ledger,
 *   is flushed, and replaces the ledger with one `rename`. A crash leaves
 *   either the old ledger or the new one, never half a line.
 * - **Fail-closed.** A line that is not exactly what this module writes, a
 *   last line without its newline, or one fingerprint recorded twice stops
 *   `ca issue` before anything is signed. A ledger that cannot be read cannot
 *   be appended to without losing the claim it exists to support — that every
 *   certificate this CA signed is in it.
 */

import { X509Certificate, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isValidSegment } from '@qianmo/protocol'
import { isFingerprint256 } from './caKeys.js'
import { CA_PUBLIC_FILE_MODE, issuanceLedgerPath } from './paths.js'

/** Version of a ledger line. A different value is a migration, not a surprise. */
const LEDGER_VERSION = 1

/** Upper-case hex, as the serial is recorded; 20 octets is RFC 5280's cap. */
const SERIAL_PATTERN = /^[0-9A-F]{1,40}$/

/** One certificate this CA handed out. */
interface IssuanceRecord {
  readonly v: typeof LEDGER_VERSION
  readonly node: string
  readonly serial: string
  readonly fingerprint256: string
  /** ISO 8601, UTC. */
  readonly notBefore: string
  /** ISO 8601, UTC. */
  readonly notAfter: string
  /**
   * ISO 8601, UTC. For `source: 'issue'` the CA machine's clock at signing;
   * for `'import'` the certificate's own `notBefore`, which `qm ca issue`
   * stamps at signing time too — the best record there is for a certificate
   * signed before the ledger existed.
   */
  readonly issuedAt: string
  /**
   * `issue`: recorded when it was signed. `import`: a certificate signed
   * before this ledger existed, recorded when a re-issue was about to replace
   * its `issued/<node>.crt` copy.
   */
  readonly source: 'issue' | 'import'
}

/** A ledger as read: its exact bytes, and those bytes parsed. */
interface IssuanceLedger {
  readonly path: string
  readonly bytes: string
  readonly records: readonly IssuanceRecord[]
}

function isoInstant(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && isoInstant(parsed) === value
}

/** The one serialization. Key order is fixed, so a line has one spelling. */
function lineOf(record: IssuanceRecord): string {
  return JSON.stringify({
    v: record.v,
    node: record.node,
    serial: record.serial,
    fingerprint256: record.fingerprint256,
    notBefore: record.notBefore,
    notAfter: record.notAfter,
    issuedAt: record.issuedAt,
    source: record.source,
  })
}

function parseLine(line: string): IssuanceRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  const { v, node, serial, fingerprint256, notBefore, notAfter, issuedAt } = raw
  const source = raw['source']
  if (
    v !== LEDGER_VERSION ||
    typeof node !== 'string' ||
    !isValidSegment(node) ||
    typeof serial !== 'string' ||
    !SERIAL_PATTERN.test(serial) ||
    !isFingerprint256(fingerprint256) ||
    !isIsoInstant(notBefore) ||
    !isIsoInstant(notAfter) ||
    !isIsoInstant(issuedAt) ||
    (source !== 'issue' && source !== 'import')
  ) {
    return null
  }
  const record: IssuanceRecord = {
    v,
    node,
    serial,
    fingerprint256,
    notBefore,
    notAfter,
    issuedAt,
    source,
  }
  // Byte-for-byte what this module would have written. Anything else — an
  // extra field, reordered keys, a hand edit — is not a line it wrote.
  return lineOf(record) === line ? record : null
}

/**
 * Read and check the whole ledger. A missing file is an empty ledger (the CA
 * has issued nothing since the ledger was introduced); anything unreadable
 * throws.
 */
export function readIssuanceLedger(directory: string): IssuanceLedger {
  const path = issuanceLedgerPath(directory)
  if (!existsSync(path)) return { path, bytes: '', records: [] }
  const bytes = readFileSync(path, 'utf8')
  const refuse = (what: string): never => {
    throw new Error(
      `${path}: ${what}. The ledger is the only record of superseded ` +
        'certificates, so nothing is issued until it reads cleanly; restore ' +
        'it from the offline backup (ca-runbook.md §4)',
    )
  }
  if (bytes !== '' && !bytes.endsWith('\n')) {
    refuse('the last line is incomplete')
  }
  const records: IssuanceRecord[] = []
  const seen = new Set<string>()
  const lines = bytes === '' ? [] : bytes.slice(0, -1).split('\n')
  for (const [index, line] of lines.entries()) {
    const record = parseLine(line)
    if (record === null) {
      refuse(`line ${String(index + 1)} is not a ledger record`)
    } else if (seen.has(record.fingerprint256)) {
      refuse(
        `line ${String(index + 1)} records ${record.fingerprint256} a second time`,
      )
    } else {
      seen.add(record.fingerprint256)
      records.push(record)
    }
  }
  return { path, bytes, records }
}

/** The ledger line for one certificate. */
export function issuanceRecordOf(
  certificate: X509Certificate,
  node: string,
  source: IssuanceRecord['source'],
  issuedAt: number,
): IssuanceRecord {
  return {
    v: LEDGER_VERSION,
    node,
    serial: certificate.serialNumber.toUpperCase(),
    fingerprint256: certificate.fingerprint256,
    notBefore: isoInstant(Date.parse(certificate.validFrom)),
    notAfter: isoInstant(Date.parse(certificate.validTo)),
    issuedAt: isoInstant(issuedAt),
    source,
  }
}

/**
 * Replace `path` with `content` in one step: write a sibling, flush it,
 * `rename` it over. Same directory, because `rename` is only atomic within
 * one filesystem.
 */
export function replaceFileAtomically(path: string, content: string): void {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    const handle = openSync(temporary, 'wx', CA_PUBLIC_FILE_MODE)
    try {
      writeFileSync(handle, content)
      // Without the flush the rename can land before the bytes do, which on
      // a power loss is the torn file the temporary was meant to prevent.
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Append `records` to the ledger that was read as `ledger`.
 *
 * Refuses when the file changed since it was read — the caller holds the
 * issue lock, so a change means something outside this tool wrote to it, and
 * appending on top would bless whatever that was.
 */
export function appendIssuanceRecords(
  ledger: IssuanceLedger,
  records: readonly IssuanceRecord[],
): void {
  const seen = new Set(ledger.records.map(record => record.fingerprint256))
  for (const record of records) {
    if (seen.has(record.fingerprint256)) {
      throw new Error(`${ledger.path} already records ${record.fingerprint256}`)
    }
    seen.add(record.fingerprint256)
  }
  const current = existsSync(ledger.path)
    ? readFileSync(ledger.path, 'utf8')
    : ''
  if (current !== ledger.bytes) {
    throw new Error(
      `${ledger.path} changed while this issue was running; nothing was ` +
        'recorded and no certificate was written',
    )
  }
  replaceFileAtomically(
    ledger.path,
    ledger.bytes + records.map(record => `${lineOf(record)}\n`).join(''),
  )
}

/** One human-readable line per record, for `qm ca ledger`. */
export function formatIssuanceRecord(record: IssuanceRecord): string {
  return (
    `${record.issuedAt}  ${record.node}  ${record.fingerprint256}` +
    `  serial ${record.serial}  not after ${record.notAfter}` +
    (record.source === 'import' ? '  (imported)' : '')
  )
}
