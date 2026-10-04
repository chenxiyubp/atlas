// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  assertKeySegment,
  buildEntry,
  isRecallable,
  MEMORY_LAYERS,
  type MemoryEntry,
  type MemoryLayer,
  type MemoryRetirement,
  type MemoryWriteInput,
} from './entry.js'
import {
  describeFailure,
  MemoryEventRecorder,
  MemoryEventType,
  type MemoryEventSink,
} from './events.js'
import { parseEntry, serializeEntry } from './frontmatter.js'
import { defaultMemoryRoot, entryPath, scopeDir } from './paths.js'

/** Owner-only, matching the rest of the config root. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Thrown for store-level failures: missing entries, illegal state transitions. */
export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryStoreError'
  }
}

/**
 * A deterministic query. No model in the path, no embeddings, no ranking
 * heuristics — charter N-8 trades recall for explainability in M0, and an
 * answer that has to be defended at AC-4 has to be reproducible.
 */
export type MemoryQuery = {
  readonly layers?: readonly MemoryLayer[]
  readonly projectKey?: string
  readonly taskId?: string
  readonly period?: string
  /** All listed tags must be present (AND, not OR). */
  readonly tags?: readonly string[]
  /** Case-insensitive substring over title, summary, tags and body. */
  readonly text?: string
  /** Point on the event axis to evaluate validity at. Defaults to now. */
  readonly asOf?: Date
  /**
   * Include retired entries. This is the audit switch: recall never sets it,
   * an auditor always does. Retired entries come back with their `expiredAt`
   * and {@link MemoryRetirement} intact, which is the whole point — the record
   * was marked, not removed.
   */
  readonly includeRetired?: boolean
  readonly limit?: number
}

export type MemoryStoreOptions = {
  /** Defaults to {@link defaultMemoryRoot}. Tests pass a temporary directory. */
  readonly root?: string
  readonly now?: () => Date
  readonly newId?: () => string
  /**
   * Additional destination for scan failures. Optional — the store's own
   * {@link FileMemoryStore.events} recorder is always on, so leaving this unset
   * loses nothing. A sink that throws is contained, never propagated into
   * {@link FileMemoryStore.query}.
   */
  readonly onEvent?: MemoryEventSink
  readonly eventCapacity?: number
}

function defaultNewId(): string {
  return `qm-mem-${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

/**
 * Replace a file's contents atomically.
 *
 * Same shape as `@qianmo/registry`'s store and for the same reason: write to a
 * sibling temp file, flush it, then `rename` over the target. A process killed
 * mid-write leaves either the whole previous record or the whole new one. For a
 * store whose purpose is to be auditable, a half-written entry would be worse
 * than no entry — it reads as tampering.
 */
function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = openSync(temporary, 'wx', FILE_MODE)
    try {
      writeFileSync(handle, contents)
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

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function isMissing(error: unknown): boolean {
  return hasCode(error, 'ENOENT')
}

/**
 * How long a change to one entry waits for another change to the same entry.
 * A holder keeps the lock for one read, one fsync'd write and one rename, so
 * two seconds is contention far beyond anything a healthy node produces.
 */
const ENTRY_LOCK_WAIT_MS = 2_000

/**
 * A lock older than this was left by a process that died while holding it.
 * Wall-clock age, not the holder's pid: the resident may run in a sandbox with
 * its own pid namespace while the operator's CLI runs on the host, and a pid
 * seen from one side means nothing on the other.
 */
const ENTRY_LOCK_STALE_MS = 30_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** `true` when the lock was removed as stale; `false` when it is live or gone. */
function clearStaleLock(lock: string): boolean {
  let age: number
  try {
    age = Date.now() - statSync(lock).mtimeMs
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  if (age <= ENTRY_LOCK_STALE_MS) return false
  rmSync(lock, { force: true })
  return true
}

/**
 * Run a read-modify-write of one entry file under that entry's lock.
 *
 * `revoke` and `invalidate` both read a record, add a mark and rename a new
 * copy over it. Without this, two processes that read before either renames
 * each write back a copy missing the other's mark — and when the lost mark is
 * a revocation, the operator was told the entry is withdrawn while it goes on
 * being injected. `writeFileAtomic` keeps each copy whole; it cannot keep both
 * marks.
 *
 * The lock is a sibling file created with `wx` (exclusive create): a name that
 * does not end in `.md`, so neither this store's scan nor the base's ever reads
 * it as an entry. Waiting is synchronous because the store API is; a writer
 * that cannot get the lock in {@link ENTRY_LOCK_WAIT_MS} is refused rather than
 * left to overwrite. A lock older than {@link ENTRY_LOCK_STALE_MS} is removed.
 * Known gap: two waiters that judge the same stale lock at the same instant can
 * both proceed — the outcome is the unlocked behaviour, and it needs a crash
 * inside a millisecond-long critical section to set up.
 */
function withEntryLock<T>(entryFile: string, id: string, change: () => T): T {
  const lock = `${entryFile}.lock`
  const deadline = Date.now() + ENTRY_LOCK_WAIT_MS
  for (let attempt = 0; ; attempt++) {
    let handle: number
    try {
      handle = openSync(lock, 'wx', FILE_MODE)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      if (clearStaleLock(lock)) continue
      if (Date.now() >= deadline) {
        throw new MemoryStoreError(
          `memory entry ${id} is being changed by another writer; retry`,
        )
      }
      sleepSync(Math.min(25, 2 ** Math.min(attempt, 5)))
      continue
    }
    try {
      try {
        // Who holds it, for whoever finds a lock that outlived its writer.
        writeFileSync(handle, `${process.pid}\n`)
      } finally {
        closeSync(handle)
      }
      return change()
    } finally {
      rmSync(lock, { force: true })
    }
  }
}

/**
 * @param onFailure Called when the directory exists but cannot be listed.
 *   A layer directory that was never written to is not a failure — it is an
 *   empty table. One that is there but unreadable is a table that silently
 *   looks empty, so it goes on the record instead.
 */
function listMarkdownFiles(
  dir: string,
  onFailure?: (error: unknown) => void,
): string[] {
  let names: string[]
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch (error) {
    if (!isMissing(error)) {
      onFailure?.(error)
    }
    return []
  }
  return names.filter(name => name.endsWith('.md')).map(name => join(dir, name))
}

/**
 * The narrowest directory that can still contain every match.
 *
 * The layer tables are keyed by directory, so a query that names a project or a
 * period never touches the other layers' files. This is not an optimisation
 * detail — it is what "three tables" means on a filesystem.
 */
function searchRoots(root: string, query: MemoryQuery): string[] {
  const layers = query.layers ?? MEMORY_LAYERS
  const roots: string[] = []
  for (const layer of layers) {
    if (layer === 'working') {
      let dir = join(root, 'working')
      if (query.projectKey !== undefined) {
        dir = join(dir, query.projectKey)
        if (query.taskId !== undefined) {
          dir = join(dir, query.taskId)
        }
      }
      roots.push(dir)
    } else if (layer === 'project') {
      roots.push(
        query.projectKey === undefined
          ? join(root, 'project')
          : join(root, 'project', query.projectKey),
      )
    } else {
      roots.push(
        query.period === undefined
          ? join(root, 'baseline')
          : join(root, 'baseline', query.period),
      )
    }
  }
  return roots
}

function matchesFilters(entry: MemoryEntry, query: MemoryQuery): boolean {
  if (query.layers !== undefined && !query.layers.includes(entry.scope.layer)) {
    return false
  }
  if (query.projectKey !== undefined) {
    if (entry.scope.layer === 'baseline') {
      return false
    }
    if (entry.scope.projectKey !== query.projectKey) {
      return false
    }
  }
  if (query.taskId !== undefined) {
    if (
      entry.scope.layer !== 'working' ||
      entry.scope.taskId !== query.taskId
    ) {
      return false
    }
  }
  if (query.period !== undefined) {
    if (
      entry.scope.layer !== 'baseline' ||
      entry.scope.period !== query.period
    ) {
      return false
    }
  }
  for (const tag of query.tags ?? []) {
    if (!entry.tags.includes(tag.trim().toLowerCase())) {
      return false
    }
  }
  if (query.text !== undefined && query.text.trim().length > 0) {
    const haystack = [
      entry.title,
      entry.summary,
      entry.tags.join(' '),
      entry.body,
    ]
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(query.text.trim().toLowerCase())) {
      return false
    }
  }
  return true
}

/**
 * Newest ingest first, ties broken by id.
 *
 * Ordering is part of the deterministic-retrieval promise: the same store and
 * the same query must produce the same list in the same order on any machine,
 * or a citation reproduced by a reviewer might not point at what the agent saw.
 * Directory read order gives no such guarantee, so it is never relied on.
 */
function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export class FileMemoryStore {
  readonly #root: string
  readonly #now: () => Date
  readonly #newId: () => string

  /**
   * Where a scan writes down what it could not read. Always present — see the
   * header of `events.ts` for why partial results plus an explicit channel is
   * the only acceptable shape here, and why {@link getEntry} does the opposite.
   */
  readonly events: MemoryEventRecorder

  constructor(options: MemoryStoreOptions = {}) {
    this.#root = options.root ?? defaultMemoryRoot()
    this.#now = options.now ?? (() => new Date())
    this.#newId = options.newId ?? defaultNewId
    this.events = new MemoryEventRecorder(
      options.eventCapacity,
      options.onEvent,
    )
  }

  get root(): string {
    return this.#root
  }

  /** Persist a new entry. Returns the record exactly as it was written. */
  write(input: MemoryWriteInput): MemoryEntry {
    const id = this.#newId()
    assertKeySegment('id', id)
    const entry = buildEntry(input, id, this.#now())
    const path = entryPath(this.#root, entry.scope, entry.id)
    mkdirSync(scopeDir(this.#root, entry.scope), {
      recursive: true,
      mode: DIR_MODE,
    })
    writeFileAtomic(path, serializeEntry(entry))
    return entry
  }

  /**
   * Fetch one entry by id, retired or not.
   *
   * Deliberately ignores retirement: this is the lookup a citation check uses
   * (D-6 — a cited id that resolves to nothing is a fabricated citation), and
   * it is the lookup an audit uses. Recall goes through {@link query}, which
   * does honour retirement.
   *
   * Unlike {@link query}, this **throws** when the named record is unreadable.
   * The asymmetry is deliberate: a scan that hit one bad file still has a real
   * answer for every other file, whereas a lookup that was asked for exactly
   * this record has nothing true to return. `null` here would mean "no such
   * memory", and a citation check reading that would call a genuine entry
   * fabricated.
   */
  getEntry(id: string): MemoryEntry | null {
    return this.#locate(id)?.entry ?? null
  }

  /**
   * Deterministic recall over the layer tables.
   *
   * Returns every record it can read. Files it cannot read are skipped **and
   * reported** on {@link events} — never silently dropped, and never allowed to
   * fail the whole scan. One hand-edited file used to take recall down
   * wholesale, which on the wake path is a resident node with no memory at all.
   */
  query(query: MemoryQuery = {}): MemoryEntry[] {
    if (query.projectKey !== undefined) {
      assertKeySegment('query.projectKey', query.projectKey)
    }
    if (query.taskId !== undefined) {
      assertKeySegment('query.taskId', query.taskId)
    }
    if (query.period !== undefined) {
      assertKeySegment('query.period', query.period)
    }
    const asOf = (query.asOf ?? this.#now()).toISOString()
    const results: MemoryEntry[] = []
    const seen = new Set<string>()
    for (const dir of searchRoots(this.#root, query)) {
      for (const file of listMarkdownFiles(dir, error =>
        this.#report(MemoryEventType.LayerUnreadable, dir, error),
      )) {
        if (seen.has(file)) {
          continue
        }
        seen.add(file)
        let entry: MemoryEntry
        try {
          entry = readEntryFile(file)
        } catch (error) {
          this.#report(MemoryEventType.EntryUnreadable, file, error)
          continue
        }
        if (query.includeRetired !== true && !isRecallable(entry, asOf)) {
          continue
        }
        if (!matchesFilters(entry, query)) {
          continue
        }
        results.push(entry)
      }
    }
    results.sort(compareEntries)
    return query.limit === undefined ? results : results.slice(0, query.limit)
  }

  /**
   * 废止 — the soft delete of charter §1.5 and §6.1 T-3 对策④.
   *
   * The file is rewritten in place with `expiredAt` and the reason attached;
   * nothing is unlinked. After this the entry cannot be recalled at any `asOf`,
   * because the ingest axis is not a point-in-time question — the store has
   * withdrawn the record, full stop — while an audit query still returns it
   * together with who withdrew it and why.
   */
  revoke(id: string, revocation: { reason: string; by: string }): MemoryEntry {
    return this.retire(id, { kind: 'revoked', ...revocation })
  }

  /**
   * Shared by {@link revoke} and the sedimentation task.
   *
   * The state check and the write happen under the entry's lock, on a copy
   * read after the lock was taken — see {@link withEntryLock}. Two concurrent
   * retirements therefore produce exactly one success and one "already
   * retired", never two successes with the first reason silently overwritten.
   */
  retire(id: string, retirement: MemoryRetirement): MemoryEntry {
    const path = this.#requirePath(id)
    return withEntryLock(path, id, () => {
      const current = readEntryFile(path)
      if (current.expiredAt !== null) {
        throw new MemoryStoreError(
          `memory entry ${id} was already retired at ${current.expiredAt}`,
        )
      }
      const retired: MemoryEntry = {
        ...current,
        expiredAt: this.#now().toISOString(),
        retirement,
      }
      writeFileAtomic(path, serializeEntry(retired))
      return retired
    })
  }

  /**
   * Record that the fact stopped being true — the *event* axis, not the ingest
   * axis. The record stays live and keeps answering questions asked about
   * earlier moments; it just stops answering questions asked about now.
   *
   * This is the operation that separates "we were wrong to store this"
   * ({@link revoke}) from "this was right until Tuesday". Conflating them is
   * how a memory system starts contradicting its own history.
   */
  invalidate(id: string, at?: Date): MemoryEntry {
    const path = this.#requirePath(id)
    return withEntryLock(path, id, () => {
      const current = readEntryFile(path)
      if (current.invalidAt !== null) {
        throw new MemoryStoreError(
          `memory entry ${id} was already invalidated at ${current.invalidAt}`,
        )
      }
      const invalidAt = (at ?? this.#now()).toISOString()
      if (invalidAt < current.validAt) {
        throw new MemoryStoreError('invalidAt must not precede validAt')
      }
      const updated: MemoryEntry = { ...current, invalidAt }
      writeFileAtomic(path, serializeEntry(updated))
      return updated
    })
  }

  /** Where the entry lives; throws the same error the two changes always did. */
  #requirePath(id: string): string {
    const located = this.#locate(id)
    if (located === null) {
      throw new MemoryStoreError(`no memory entry with id ${id}`)
    }
    return located.path
  }

  #report(type: MemoryEventType, path: string, error: unknown): void {
    this.events.record({
      type,
      at: this.#now().getTime(),
      detail: { path, ...describeFailure(error) },
    })
  }

  /**
   * Scans the three layer directories, never the root itself: only files under
   * `working/`, `project/` and `baseline/` are entries. A note a human drops
   * beside them is then just a note, not a parse failure — and the rule is the
   * same one {@link query} follows, so the two can never disagree about what
   * the store contains.
   *
   * Only the file whose name matches the id is ever parsed, so a corrupt
   * *neighbour* cannot fail a lookup. A corrupt *target* throws, by design —
   * see {@link getEntry}.
   */
  #locate(id: string): { entry: MemoryEntry; path: string } | null {
    assertKeySegment('id', id)
    const filename = `${id}.md`
    for (const dir of searchRoots(this.#root, {})) {
      for (const file of listMarkdownFiles(dir)) {
        if (file.endsWith(filename)) {
          const entry = readEntryFile(file)
          if (entry.id === id) {
            return { entry, path: file }
          }
        }
      }
    }
    return null
  }
}

/**
 * Reads and parses one entry file, letting the failure escape.
 *
 * Writes are atomic, so a file that does not parse was not produced by this
 * store — it was hand-edited, truncated by something outside the contract, or
 * corrupted. That is worth knowing about either way; what differs is who gets
 * told. The two callers make that choice, not this function: {@link
 * FileMemoryStore.query} catches and records, {@link FileMemoryStore.getEntry}
 * lets it through.
 */
function readEntryFile(path: string): MemoryEntry {
  return parseEntry(readFileSync(path, 'utf8'))
}
