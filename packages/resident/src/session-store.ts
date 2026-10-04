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
} from 'node:fs'
import { dirname } from 'node:path'
import { isValidSegment } from '@qianmo/protocol'
import { DEFAULT_CONTEXT, isSessionKey, sessionKeyOf } from './session-key.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * File-level backstop for `sessions.json`, well above
 * `maxSessionsPerAgent * (plausible agent count)`.
 *
 * It exists so a bug in the policy layer above surfaces as a loud write
 * failure instead of an unbounded file (G-6). Reaching it is not a normal
 * operating point.
 */
export const MAX_STORED_RESIDENT_SESSIONS = 256

/**
 * What one `(agent, contextId)` key maps to.
 *
 * `createdAt` / `lastUsedAt` exist for the GC in `session-gc.ts` — an LRU
 * needs a durable clock, otherwise a restart resets every session's age to
 * "just now" and the idle TTL never fires on a node that restarts daily.
 */
export interface ResidentSessionRecord {
  readonly sessionId: string
  readonly createdAt: number
  readonly lastUsedAt: number
}

export interface ResidentSessionStore {
  get(key: string): ResidentSessionRecord | undefined
  set(key: string, record: ResidentSessionRecord): void
  delete(key: string): void
  entries(): Readonly<Record<string, ResidentSessionRecord>>
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isSessionRecord(value: unknown): value is ResidentSessionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return (
    keys.length === 3 &&
    keys[0] === 'createdAt' &&
    keys[1] === 'lastUsedAt' &&
    keys[2] === 'sessionId' &&
    typeof record.sessionId === 'string' &&
    UUID_PATTERN.test(record.sessionId) &&
    isTimestamp(record.createdAt) &&
    isTimestamp(record.lastUsedAt)
  )
}

/**
 * Reads either format and always returns the new one.
 *
 * The legacy shape is `{ "<agent>": "<sessionId>" }` — one session per agent,
 * no timestamps, no context. Refusing to read it would mean every existing
 * node loses every session the moment it upgrades, which is a worse failure
 * than the one fail-closed parsing is there to prevent. So legacy keys are
 * lifted onto `sessionKeyOf(agent, DEFAULT_CONTEXT)` — the same bucket a
 * request with no `contextId` resolves to, so the upgrade is a no-op for a
 * node that only ever had one context.
 *
 * A file is one format or the other. A mixture is treated as invalid: writes
 * are atomic, so a half-migrated file is corruption, not a state we produce.
 */
function parseStoredSessions(
  parsed: unknown,
  migratedAt: number,
): Record<string, ResidentSessionRecord> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('resident session store is invalid')
  }
  const raw = Object.entries(parsed as Record<string, unknown>)
  if (raw.length === 0) return {}

  if (raw.every(([, value]) => typeof value === 'string')) {
    const migrated: Record<string, ResidentSessionRecord> = {}
    for (const [agent, sessionId] of raw) {
      if (!isValidSegment(agent) || !UUID_PATTERN.test(sessionId as string)) {
        throw new Error('resident session store is invalid')
      }
      migrated[sessionKeyOf(agent, DEFAULT_CONTEXT)] = {
        sessionId: sessionId as string,
        createdAt: migratedAt,
        lastUsedAt: migratedAt,
      }
    }
    return migrated
  }

  const sessions: Record<string, ResidentSessionRecord> = {}
  for (const [key, value] of raw) {
    if (!isSessionKey(key) || !isSessionRecord(value)) {
      throw new Error('resident session store is invalid')
    }
    sessions[key] = value
  }
  return sessions
}

function validateWrite(key: string, record: ResidentSessionRecord): void {
  if (!isSessionKey(key)) throw new Error('session key is invalid')
  if (!isSessionRecord(record)) throw new Error('session record is invalid')
}

/**
 * G-6: refuse to grow past the ceiling instead of dropping entries to fit.
 *
 * The policy layer (`ResidentSessionManager`) evicts before it writes, so a
 * healthy node never reaches this. When it does, throwing is the only honest
 * answer: silently discarding a mapping here would strand a live ACP session
 * with nothing pointing at it, and nothing would ever report it.
 */
function assertRoomFor(
  sessions: Readonly<Record<string, ResidentSessionRecord>>,
  key: string,
  maxEntries: number,
): void {
  if (key in sessions) return
  if (Object.keys(sessions).length < maxEntries) return
  throw new Error(
    `resident session store is full (${maxEntries} entries); evict before writing`,
  )
}

export interface ResidentSessionStoreOptions {
  /** Hard entry ceiling. Defaults to {@link MAX_STORED_RESIDENT_SESSIONS}. */
  readonly maxEntries?: number
  /** Clock used to stamp legacy records at migration time. */
  readonly now?: () => number
}

export class FileResidentSessionStore implements ResidentSessionStore {
  readonly #path: string
  readonly #maxEntries: number
  readonly #sessions: Record<string, ResidentSessionRecord>

  constructor(path: string, options: ResidentSessionStoreOptions = {}) {
    if (path.trim() === '')
      throw new Error('session store path must not be empty')
    this.#path = path
    this.#maxEntries = options.maxEntries ?? MAX_STORED_RESIDENT_SESSIONS
    this.#sessions = this.#read((options.now ?? Date.now)())
  }

  get path(): string {
    return this.#path
  }

  get(key: string): ResidentSessionRecord | undefined {
    return this.#sessions[key]
  }

  set(key: string, record: ResidentSessionRecord): void {
    validateWrite(key, record)
    assertRoomFor(this.#sessions, key, this.#maxEntries)
    const previous = this.#sessions[key]
    this.#sessions[key] = record
    try {
      this.#write()
    } catch (error) {
      if (previous === undefined) delete this.#sessions[key]
      else this.#sessions[key] = previous
      throw error
    }
  }

  delete(key: string): void {
    if (!(key in this.#sessions)) return
    const previous = this.#sessions[key]
    delete this.#sessions[key]
    try {
      this.#write()
    } catch (error) {
      if (previous !== undefined) this.#sessions[key] = previous
      throw error
    }
  }

  entries(): Readonly<Record<string, ResidentSessionRecord>> {
    return { ...this.#sessions }
  }

  #read(migratedAt: number): Record<string, ResidentSessionRecord> {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('resident session store is corrupt')
    }
    return parseStoredSessions(parsed, migratedAt)
  }

  #write(): void {
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
        writeFileSync(fd, `${JSON.stringify(this.#sessions)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.#path)
      chmodSync(this.#path, FILE_MODE)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

export class MemoryResidentSessionStore implements ResidentSessionStore {
  readonly #sessions: Record<string, ResidentSessionRecord> = {}
  readonly #maxEntries: number

  constructor(options: ResidentSessionStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? MAX_STORED_RESIDENT_SESSIONS
  }

  get(key: string): ResidentSessionRecord | undefined {
    return this.#sessions[key]
  }

  set(key: string, record: ResidentSessionRecord): void {
    validateWrite(key, record)
    assertRoomFor(this.#sessions, key, this.#maxEntries)
    this.#sessions[key] = record
  }

  delete(key: string): void {
    delete this.#sessions[key]
  }

  entries(): Readonly<Record<string, ResidentSessionRecord>> {
    return { ...this.#sessions }
  }
}
