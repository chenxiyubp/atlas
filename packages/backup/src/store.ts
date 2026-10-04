// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The store itself: immutable snapshot objects on a host-side directory.
 *
 * Two properties, and everything here exists to hold them:
 *
 * 1. **Nothing is ever overwritten.** Every snapshot is created with `wx`, so a
 *    colliding id fails rather than replaces. Ids are assigned by the store
 *    from its own clock and counter, never by the caller, so "collide on
 *    purpose" is not an available move either.
 * 2. **There is no removal path.** Not a guarded one, not an admin one — the
 *    class has no method that unlinks, and the object handed to the sandbox
 *    side ({@link FileSnapshotStore.writer}) has only `create`. AC-6(c) is a
 *    statement about what code exists, which is the only kind of statement that
 *    stays true when the caller is an agent with a shell.
 *
 * Retention will eventually have to exist, and when it does it belongs to an
 * operator-run tool over this directory — not to a method on this class that an
 * inbound path could reach. Charter N-12 keeps it out of M0 entirely.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digestOf } from './archive.js'
import {
  BackupEventType,
  type SnapshotArchive,
  type SnapshotMeta,
  type SnapshotRequest,
  type SnapshotWriter,
} from './contracts.js'

/** One audit line from the backup path. */
export interface BackupAuditEvent {
  readonly type: BackupEventType
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

export type BackupAuditSink = (event: BackupAuditEvent) => void

/** A bounded ring plus an unbounded tally, same shape as the other packages. */
export class BackupAuditLog {
  readonly #events: BackupAuditEvent[] = []
  readonly #counts = new Map<BackupEventType, number>()
  readonly #capacity: number
  readonly #sink: BackupAuditSink | undefined

  constructor(capacity = 512, sink?: BackupAuditSink) {
    this.#capacity = capacity
    this.#sink = sink
  }

  record(
    type: BackupEventType,
    at: number,
    detail: Readonly<Record<string, string | number | boolean>> = {},
  ): void {
    const event: BackupAuditEvent = { type, at, detail }
    this.#events.push(event)
    if (this.#events.length > this.#capacity) this.#events.shift()
    this.#counts.set(type, (this.#counts.get(type) ?? 0) + 1)
    try {
      this.#sink?.(event)
    } catch {
      // A failing sink must not turn a refusal into an exception.
    }
  }

  events(): readonly BackupAuditEvent[] {
    return [...this.#events]
  }

  of(type: BackupEventType): readonly BackupAuditEvent[] {
    return this.#events.filter(event => event.type === type)
  }

  count(type: BackupEventType): number {
    return this.#counts.get(type) ?? 0
  }
}

export interface FileSnapshotStoreOptions {
  /** Directory the store owns. Created on first write, mode 0700. */
  readonly root: string
  readonly audit?: BackupAuditLog
  readonly now?: () => number
  /** Largest archive accepted, in bytes. Refused rather than truncated. */
  readonly maxBytes?: number
}

/** Default ceiling on one archive: 512 MiB. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

interface StoredMeta extends SnapshotMeta {
  readonly version: 1
}

function metaPath(root: string, id: string): string {
  return join(root, `${id}.json`)
}

function archivePath(root: string, id: string): string {
  return join(root, `${id}.tar.gz`)
}

/**
 * A snapshot store on the local filesystem.
 *
 * Held by the **host**. The sandbox never sees this object; it sees whatever
 * `service.ts` exposes over a socket, which is strictly less.
 */
export class FileSnapshotStore implements SnapshotArchive {
  readonly root: string
  readonly audit: BackupAuditLog
  readonly #now: () => number
  readonly #maxBytes: number
  #counter = 0

  constructor(options: FileSnapshotStoreOptions) {
    this.root = options.root
    this.audit = options.audit ?? new BackupAuditLog()
    this.#now = options.now ?? Date.now
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES
  }

  /**
   * The write-only face, for the side that must not be able to read or remove.
   *
   * A separate object rather than `this` narrowed by a type: a cast recovers a
   * type, but it cannot recover a method that is not on the object handed over.
   */
  writer(): SnapshotWriter {
    return { create: request => this.#create(request) }
  }

  async list(workspace?: string): Promise<readonly SnapshotMeta[]> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch {
      return []
    }
    const metas: SnapshotMeta[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(
          await readFile(join(this.root, name), 'utf8'),
        ) as StoredMeta
        if (workspace !== undefined && parsed.workspace !== workspace) continue
        metas.push(parsed)
      } catch {
        // A torn or hand-edited sidecar hides one snapshot from the listing; it
        // must not hide the rest. The archive beside it is still on disk and an
        // operator can still read it by id.
      }
    }
    return metas.sort((a, b) => a.createdAt - b.createdAt)
  }

  async read(id: string): Promise<Uint8Array | null> {
    if (!isSnapshotId(id)) return null
    try {
      const bytes = new Uint8Array(await readFile(archivePath(this.root, id)))
      this.audit.record(BackupEventType.SnapshotRead, this.#now(), {
        id,
        bytes: bytes.byteLength,
      })
      return bytes
    } catch {
      return null
    }
  }

  /** The newest snapshot of `workspace`, or `null` when there is none. */
  async latest(workspace: string): Promise<SnapshotMeta | null> {
    const all = await this.list(workspace)
    return all.at(-1) ?? null
  }

  async #create(request: SnapshotRequest): Promise<SnapshotMeta> {
    if (request.archive.byteLength === 0) {
      throw new Error('refusing to store an empty snapshot')
    }
    if (request.archive.byteLength > this.#maxBytes) {
      throw new Error(
        `snapshot is ${request.archive.byteLength} bytes, over the ${this.#maxBytes}-byte ceiling`,
      )
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const at = this.#now()
    const id = this.#nextId(at)
    const meta: StoredMeta = {
      version: 1,
      id,
      workspace: request.workspace,
      reason: request.reason,
      createdAt: at,
      bytes: request.archive.byteLength,
      sha256: digestOf(request.archive),
      ...(request.label === undefined ? {} : { label: request.label }),
    }
    // `wx` on both: an id that already exists is a bug in the counter, and the
    // one thing that must never happen here is a silent overwrite.
    await writeFile(archivePath(this.root, id), request.archive, {
      flag: 'wx',
      mode: 0o600,
    })
    await writeFile(
      metaPath(this.root, id),
      `${JSON.stringify(meta, null, 2)}\n`,
      { flag: 'wx', mode: 0o600, encoding: 'utf8' },
    )
    this.audit.record(BackupEventType.SnapshotCreated, at, {
      id,
      workspace: request.workspace,
      reason: request.reason,
      bytes: meta.bytes,
      sha256: meta.sha256,
    })
    return meta
  }

  /**
   * Ids sort in creation order and are assigned here, never by the caller.
   *
   * The counter is what makes two snapshots taken in the same millisecond
   * distinct; the timestamp is what makes the directory readable to a human at
   * three in the morning.
   */
  #nextId(at: number): string {
    this.#counter += 1
    return `${String(at).padStart(14, '0')}-${String(this.#counter).padStart(4, '0')}`
  }
}

/** Ids this store issues: digits and one dash, nothing that can traverse. */
const SNAPSHOT_ID_PATTERN = /^\d{14}-\d{4,}$/

/**
 * True when `value` is an id this store could have issued.
 *
 * Used before touching the filesystem: the id arrives from an HTTP path in
 * `service.ts`, and `../../etc/passwd` is a perfectly good string.
 */
export function isSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && SNAPSHOT_ID_PATTERN.test(value)
}
