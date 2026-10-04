// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  ProtocolError,
  ProtocolErrorCode,
  issue,
  newId,
} from '@qianmo/protocol'
import { occConfigPath } from 'src/config/paths.js'

/**
 * The node-local blob staging area (protocol.md §9.3).
 *
 * ## Why it exists
 *
 * `LIMITS.maxMessageBytes` is 256 KiB, while one base mailbox entry's `text`
 * tops out at `MAX_MAILBOX_MESSAGE_TEXT_BYTES` (64 KiB). A protocol-legal
 * message between those two numbers would blow up on the last hop — and not
 * as a single rejected write. That 64 KiB is a **read/write invariant of the
 * whole mailbox**: `assertMailboxMessageSize` is reached through
 * `toMailboxMessage` (`src/utils/agents/teammateMailbox.ts:96-128`), which
 * both `parseMailboxMessages` on the read path (`:130-136`) and
 * `writeToMailbox` on the write path (`:401`) go through, and `writeToMailbox`
 * re-reads the entire mailbox under the lock before appending (`:399`). One
 * oversized entry on disk therefore makes every subsequent read *and* write of
 * that mailbox throw: the agent stays alive and goes permanently deaf. A
 * poison pill, not a bounced message.
 *
 * So an oversized payload is spilled to disk and the envelope carries a
 * {@link BlobRef} instead. The object that reaches the mailbox is then always
 * "envelope shell + one reference": bounded, and independent of business
 * payload size. The poison pill goes from *possible* to *unreachable*.
 *
 * ## Where it lives
 *
 * Under {@link occConfigPath} — never a hand-built `~/.occ`. Qianmo derives a
 * second identity layer on top of the base's isolation, and a hardcoded path
 * is the one way that isolation fails (CLAUDE.md §1.1②).
 */
export const BLOB_DIR_SEGMENTS: readonly string[] = Object.freeze([
  'qianmo',
  'blobs',
])

/** Absolute path of the default staging area, derived from `paths.ts`. */
export function blobStoreDir(): string {
  return occConfigPath(...BLOB_DIR_SEGMENTS)
}

/** What replaces an oversized `payload` inside the envelope (§9.3). */
export interface BlobRef {
  readonly $blob: {
    readonly id: string
    readonly bytes: number
    readonly sha256: string
  }
}

/** True when `value` has the {@link BlobRef} shape. */
export function isBlobRef(value: unknown): value is BlobRef {
  if (typeof value !== 'object' || value === null) return false
  const ref = (value as { $blob?: unknown }).$blob
  if (typeof ref !== 'object' || ref === null) return false
  const record = ref as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    typeof record['bytes'] === 'number' &&
    Number.isInteger(record['bytes']) &&
    record['bytes'] >= 0 &&
    typeof record['sha256'] === 'string' &&
    /^[0-9a-f]{64}$/.test(record['sha256'])
  )
}

/**
 * On-disk record.
 *
 * The payload is stored as the *serialized string* rather than as nested JSON
 * so that the checksum covers exactly the bytes that are read back. Round
 * tripping through `JSON.parse` would reorder integer-like object keys, and a
 * re-serialization would then fail its own checksum.
 */
interface BlobRecord {
  readonly id: string
  readonly taskId: string
  readonly expiresAt: number
  readonly bytes: number
  readonly sha256: string
  readonly payloadJson: string
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function unavailable(reason: string): ProtocolError {
  return new ProtocolError([
    issue(ProtocolErrorCode.E_PAYLOAD_UNAVAILABLE, 'payload', reason),
  ])
}

function isBlobRecord(value: unknown): value is BlobRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['taskId'] === 'string' &&
    typeof record['expiresAt'] === 'number' &&
    typeof record['bytes'] === 'number' &&
    typeof record['sha256'] === 'string' &&
    typeof record['payloadJson'] === 'string'
  )
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

/** Options for a {@link BlobStore}. */
export interface BlobStoreOptions {
  /**
   * Override the staging directory. Production leaves it unset so the path
   * comes from `paths.ts`; tests point it at a temp directory.
   */
  readonly dir?: string
}

/**
 * File-backed staging area for payloads too large for one mailbox entry.
 *
 * A blob's lifetime is the TASK deadline of the message that spilled it
 * (§9.3.5): the handler may legitimately fetch it any time until the task
 * itself times out, and not one moment longer. {@link BlobStore.prune}
 * enforces that; nothing here expires a blob on read.
 */
export class BlobStore {
  readonly dir: string

  constructor(options: BlobStoreOptions = {}) {
    this.dir = options.dir ?? blobStoreDir()
  }

  private pathOf(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  /**
   * Stage `payload` and return the reference that replaces it in the envelope.
   *
   * `expiresAt` is the message's task deadline (`taskExpiresAt(message)`).
   */
  async put(
    payload: unknown,
    options: { readonly taskId: string; readonly expiresAt: number },
  ): Promise<BlobRef> {
    const payloadJson = JSON.stringify(payload) ?? 'null'
    const bytes = Buffer.byteLength(payloadJson, 'utf8')
    const sha256 = sha256Hex(payloadJson)
    const id = newId()
    const record: BlobRecord = {
      id,
      taskId: options.taskId,
      expiresAt: options.expiresAt,
      bytes,
      sha256,
      payloadJson,
    }

    await mkdir(this.dir, { recursive: true })
    const finalPath = this.pathOf(id)
    const tempPath = `${finalPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(tempPath, JSON.stringify(record), 'utf-8')
      await rename(tempPath, finalPath)
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      throw error
    }

    return { $blob: { id, bytes, sha256 } }
  }

  /**
   * Fetch a staged payload.
   *
   * Throws {@link ProtocolError} with `E_PAYLOAD_UNAVAILABLE` when the blob is
   * gone (already reclaimed), unreadable, or fails its checksum — never a
   * silent downgrade, because the handler has to be able to report the failure
   * as a `task.result` (§9.3.6).
   */
  async get(ref: BlobRef): Promise<unknown> {
    const { id, bytes, sha256 } = ref.$blob
    let raw: string
    try {
      raw = await readFile(this.pathOf(id), 'utf-8')
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        throw unavailable(`blob ${id} is gone`)
      }
      throw unavailable(`blob ${id} could not be read: ${String(error)}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw unavailable(`blob ${id} is not valid JSON`)
    }
    if (!isBlobRecord(parsed)) {
      throw unavailable(`blob ${id} has an unexpected record shape`)
    }
    if (parsed.id !== id) {
      throw unavailable(`blob ${id} carries a mismatched id ${parsed.id}`)
    }
    if (parsed.bytes !== bytes || parsed.sha256 !== sha256) {
      throw unavailable(`blob ${id} does not match its reference`)
    }
    if (sha256Hex(parsed.payloadJson) !== sha256) {
      throw unavailable(`blob ${id} failed its checksum`)
    }

    try {
      return JSON.parse(parsed.payloadJson)
    } catch {
      throw unavailable(`blob ${id} holds an unparseable payload`)
    }
  }

  /** Delete every blob whose task deadline has passed. Returns the count. */
  async prune(now: number = Date.now()): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return 0
      throw error
    }

    let removed = 0
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const path = join(this.dir, entry)
      let record: unknown
      try {
        record = JSON.parse(await readFile(path, 'utf-8'))
      } catch {
        // Unreadable staging files are garbage by definition; reclaim them.
        await unlink(path).catch(() => undefined)
        removed++
        continue
      }
      if (isBlobRecord(record) && record.expiresAt > now) continue
      await unlink(path).catch(() => undefined)
      removed++
    }
    return removed
  }
}
