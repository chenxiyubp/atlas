// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The embedding cost cap (`docs/dev/memory-m1.md` §5.5).
 *
 * TOKENS, NOT CALLS
 *
 * One batch call can carry a thousand texts, so a call counter bounds nothing.
 * The meter counts tokens: the provider's own `usage` when it reports one, the
 * pessimistic estimate from `embedding.ts` when it does not.
 *
 * PERSISTED, SO A RESTART LOOP CANNOT RESET IT
 *
 * A node that crashes and restarts in a loop (P13.5 B3) would, with an
 * in-memory counter, start every life with a fresh day's budget. The counter
 * lives in one small file under the identity config root and is written
 * before the call it pays for — the estimate is reserved first and reconciled
 * against reported usage afterwards, so a process that dies mid-call has
 * already paid. A file that cannot be read is an error, never a zero: the
 * caller falls back to deterministic recall until someone looks at it.
 *
 * One file per config root is one counter per node (M1 has no tenants,
 * `tenancy-m1.md` §3.8 point 4). The window is the UTC calendar day.
 */

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
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { occConfigPath } from '../../../src/config/paths.js'

/**
 * Where the counter lives by default.
 *
 * Via {@link occConfigPath}: the config root is identity-scoped and
 * overridable, and a hand-built path would resolve to one fixed directory
 * whatever identity the node runs as.
 */
export function defaultEmbeddingUsagePath(): string {
  return occConfigPath('qianmo', 'embedding', 'usage.json')
}

export type EmbeddingUsageMeter = {
  /** Tokens still spendable in the current window. Never negative. */
  remaining(): number
  /**
   * Durably add `tokens` to the current window. Negative values reconcile an
   * earlier reservation; the total never drops below zero.
   */
  charge(tokens: number): void
}

type UsageRecord = {
  readonly version: 1
  readonly day: string
  readonly tokens: number
}

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10)
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 3 &&
    record.version === 1 &&
    typeof record.day === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.day) &&
    typeof record.tokens === 'number' &&
    Number.isInteger(record.tokens) &&
    record.tokens >= 0
  )
}

type FileEmbeddingUsageMeterOptions = {
  /**
   * Tokens per UTC day for this node. `0` spends nothing, which makes every
   * ranked recall fall back to deterministic — the default the design asks
   * for (§5.5).
   */
  readonly dailyTokenLimit: number
  /** Defaults to {@link defaultEmbeddingUsagePath}. */
  readonly path?: string
  /** Wall clock deciding the window. Injected for tests only. */
  readonly now?: () => Date
}

export class FileEmbeddingUsageMeter implements EmbeddingUsageMeter {
  readonly #path: string
  readonly #limit: number
  readonly #now: () => Date

  constructor(options: FileEmbeddingUsageMeterOptions) {
    if (
      !Number.isSafeInteger(options.dailyTokenLimit) ||
      options.dailyTokenLimit < 0
    ) {
      throw new Error(
        `dailyTokenLimit must be a non-negative integer, got ${String(options.dailyTokenLimit)}`,
      )
    }
    this.#limit = options.dailyTokenLimit
    this.#path = options.path ?? defaultEmbeddingUsagePath()
    this.#now = options.now ?? (() => new Date())
  }

  get path(): string {
    return this.#path
  }

  /** Tokens already charged to the current window. */
  used(): number {
    return this.#window().tokens
  }

  remaining(): number {
    return Math.max(0, this.#limit - this.used())
  }

  charge(tokens: number): void {
    if (!Number.isFinite(tokens)) {
      throw new Error(`cannot charge ${String(tokens)} embedding tokens`)
    }
    const window = this.#window()
    this.#write({
      version: 1,
      day: window.day,
      tokens: Math.max(0, window.tokens + Math.ceil(tokens)),
    })
  }

  /**
   * The record that counts now. A record from an earlier day is a new window;
   * one from a *later* day (the clock went backwards) keeps counting, because
   * treating it as spent is the side that cannot overspend.
   */
  #window(): UsageRecord {
    const today = dayOf(this.#now())
    const stored = this.#read()
    if (stored !== undefined && stored.day >= today) return stored
    return { version: 1, day: today, tokens: 0 }
  }

  #read(): UsageRecord | undefined {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (!isUsageRecord(parsed)) {
      throw new Error(
        `embedding usage file ${this.#path} is unreadable; refusing to treat it as zero`,
      )
    }
    return parsed
  }

  /** Write-then-rename, fsynced: a crash leaves the old count or the new one. */
  #write(record: UsageRecord): void {
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
        writeSync(fd, `${JSON.stringify(record)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.#path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}
