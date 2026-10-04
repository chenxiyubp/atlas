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
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

/**
 * How often the running phase is re-stamped, as a **code constant**.
 *
 * B8 discipline (design §3.B8): observation must never become a load-bearing
 * writer. There is deliberately no option to lower this — a heartbeat that a
 * config file could turn into a 1 s fsync loop would be competing for IO with
 * the admission ledger, which is the one write on this node that a message's
 * durability actually depends on.
 *
 * The number only bounds how stale `updatedAt` may be in the post-mortem; the
 * verdict itself comes from `phase`, which is stamped once at each end.
 */
export const RESIDENT_LIFECYCLE_HEARTBEAT_MS = 30_000

export type ResidentLifecyclePhase = 'running' | 'stopped'

export interface ResidentLifecycleRecord {
  readonly phase: ResidentLifecyclePhase
  readonly pid: number
  readonly startedAt: number
  readonly updatedAt: number
  /** Node name, so a shared config directory stays readable by a human. */
  readonly node?: string
}

/**
 * What happened to the process that wrote the sentinel last.
 *
 * - `killed` — the file still said `running`. Nothing ran the shutdown path, so
 *   the previous life was taken by SIGKILL, the OOM killer, a power loss or a
 *   panic. This is the whole point of the mechanism: today answering "why did
 *   it die" means correlating four logs by hand.
 * - `clean` — the previous life stamped `stopped` on its way out.
 * - `unknown` — no sentinel, or it could not be read or parsed. A first start
 *   and a corrupt file are the same answer on purpose: neither is evidence of
 *   a kill, and inventing one would poison the only signal this file carries.
 */
export interface ResidentPriorLife {
  readonly outcome: 'killed' | 'clean' | 'unknown'
  readonly record?: ResidentLifecycleRecord
}

export interface ResidentLifecycleOptions {
  readonly path: string
  readonly node?: string
  readonly pid?: number
  readonly now?: () => number
  /** Where write and read failures are reported. They are never rethrown. */
  readonly onError?: (error: unknown) => void
}

function isRecord(value: unknown): value is ResidentLifecycleRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    (candidate.phase === 'running' || candidate.phase === 'stopped') &&
    typeof candidate.pid === 'number' &&
    Number.isFinite(candidate.pid) &&
    typeof candidate.startedAt === 'number' &&
    Number.isFinite(candidate.startedAt) &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt) &&
    (candidate.node === undefined || typeof candidate.node === 'string')
  )
}

/**
 * Termination-cause forensics, in one small file (design §3.B2, hermes B2).
 *
 * The node stamps `running` when it comes up and `stopped` when it goes down
 * through its own shutdown path. Anything that leaves `running` behind killed
 * it from the outside. Cost is two writes per life plus a 30 s heartbeat;
 * the value is that "was the last death a kill?" stops being a research task.
 *
 * ## What this mechanism deliberately does not do
 *
 * - **It does not say *why* it was killed.** OOM, SIGKILL from an operator and
 *   a host reboot all read as `killed`. Distinguishing them needs the kernel's
 *   side of the story (`dmesg`, journald), which a file written by the victim
 *   cannot have. Claiming otherwise would be a guess wearing evidence's
 *   clothes.
 * - **It does not gate anything.** No start is refused, no backoff is extended,
 *   nothing branches on the verdict. It is evidence, and B8 says evidence never
 *   changes behaviour — the restart-storm breaker that *does* change behaviour
 *   is the admission ledger's, keyed on the message that caused the crash
 *   rather than on the fact that a crash happened.
 * - **It does not survive a config-directory wipe**, and it is per config
 *   directory, not per host: two residents sharing one config directory would
 *   overwrite each other. They already cannot (`sessions.json` has the same
 *   shape), so this adds no new constraint.
 * - **It never throws.** Every path is fail-open: a sentinel that cannot be
 *   written must not be able to stop a node from serving.
 */
export class ResidentLifecycleSentinel {
  readonly #path: string
  readonly #node: string | undefined
  readonly #pid: number
  readonly #now: () => number
  readonly #onError: ((error: unknown) => void) | undefined
  #startedAt = 0
  #lastStampedAt = 0
  #started = false
  #reportedUnstarted = false
  #stopped = false

  constructor(options: ResidentLifecycleOptions) {
    if (options.path.trim() === '') {
      throw new Error('resident lifecycle path must not be empty')
    }
    this.#path = options.path
    this.#node = options.node
    this.#pid = options.pid ?? process.pid
    this.#now = options.now ?? Date.now
    this.#onError = options.onError
  }

  get path(): string {
    return this.#path
  }

  /**
   * Read the previous life's verdict, then claim the file for this one.
   *
   * The read happens **before** the write, and that ordering is the mechanism:
   * stamping first would erase the very evidence being collected.
   */
  start(): ResidentPriorLife {
    const prior = this.#read()
    this.#startedAt = this.#now()
    this.#started = true
    this.#stopped = false
    this.#stamp('running')
    return prior
  }

  /**
   * Re-stamp `running` if {@link RESIDENT_LIFECYCLE_HEARTBEAT_MS} has passed.
   *
   * Cheap to call on every poll: all but one call in sixty is a clock read and
   * a comparison.
   */
  heartbeat(): void {
    if (!this.#claimed()) return
    if (this.#stopped) return
    if (this.#now() - this.#lastStampedAt < RESIDENT_LIFECYCLE_HEARTBEAT_MS) {
      return
    }
    this.#stamp('running')
  }

  /** Mark this life as having ended on purpose. Idempotent. */
  stop(): void {
    if (!this.#claimed()) return
    if (this.#stopped) return
    this.#stopped = true
    this.#stamp('stopped')
  }

  /**
   * Whether {@link start} has claimed the file for this life.
   *
   * A heartbeat or a stop without it would stamp `startedAt: 0` for a life
   * that never read its predecessor's verdict. That is how validation report
   * B-1 (2026-09-08) stayed hidden: the resident never called `start()`, the
   * first poll's heartbeat wrote a plausible `running` anyway, and a clean
   * stop wrote `stopped` — evidence with nothing behind it. Refusing here makes
   * a missing `start()` leave no file at all, and says so once through
   * `onError` rather than on every poll.
   */
  #claimed(): boolean {
    if (this.#started) return true
    if (!this.#reportedUnstarted) {
      this.#reportedUnstarted = true
      this.#onError?.(
        new Error(
          'resident lifecycle sentinel used before start(); nothing was stamped',
        ),
      )
    }
    return false
  }

  #read(): ResidentPriorLife {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#onError?.(error)
      }
      return { outcome: 'unknown' }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) return { outcome: 'unknown' }
      return {
        outcome: parsed.phase === 'running' ? 'killed' : 'clean',
        record: parsed,
      }
    } catch {
      // A torn write is not evidence of a kill. See `unknown` above.
      return { outcome: 'unknown' }
    }
  }

  #stamp(phase: ResidentLifecyclePhase): void {
    const at = this.#now()
    const record: ResidentLifecycleRecord = {
      phase,
      pid: this.#pid,
      startedAt: this.#startedAt,
      updatedAt: at,
      ...(this.#node === undefined ? {} : { node: this.#node }),
    }
    try {
      this.#writeAtomically(`${JSON.stringify(record)}\n`)
      this.#lastStampedAt = at
    } catch (error) {
      // Fail-open, every time. See the class comment.
      this.#onError?.(error)
    }
  }

  /**
   * Write through a temp file and rename.
   *
   * Rewriting in place would leave a window in which the file holds neither the
   * old record nor the new one — and a crash inside that window is exactly the
   * event this file exists to describe.
   */
  #writeAtomically(body: string): void {
    const directory = dirname(this.#path)
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(directory, DIRECTORY_MODE)
    const temporary = `${this.#path}.${this.#pid}.${Date.now()}.tmp`
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
        writeSync(fd, body)
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
