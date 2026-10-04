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
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { dedupKeyOf } from './job.js'

/**
 * Durable scheduler state: one claim per `(jobId, fireAtMs)`, one state file.
 *
 * ## Why `wx` is the primitive
 *
 * `openSync(path, 'wx')` — `O_CREAT | O_EXCL` — is the only cross-process
 * atomic test-and-set POSIX hands out without a lock daemon. The kernel decides
 * the winner inside the syscall: exactly one caller gets a file descriptor,
 * every other caller gets `EEXIST`, and no interleaving of the two processes
 * changes that. There is no window between the test and the set because there
 * is no test.
 *
 * Everything else that looks like it would work does not:
 *
 * - `existsSync(path)` then write is a **TOCTOU race**, and the race window is
 *   the whole point. Two processes both see "no claim", both write, both fire.
 * - An in-memory `Set` is not a CAS at all. It is correct for exactly one
 *   process and answers "no one has claimed this" with perfect confidence
 *   about a question it cannot see the other half of.
 * - Advisory locks (`flock`) answer a different question — "who may proceed
 *   now" — and release on process death, which is the opposite of what a
 *   claim needs.
 *
 * And the scenario is not theoretical. Roadmap F7 names it: **an operator
 * starts a second `qm console`.** That is a thing operators do, on purpose,
 * while debugging, and the machine has no way to tell them not to. What it can
 * do is make the second one lose every race it enters.
 *
 * ## A claim is a tombstone, not a lock
 *
 * It is never released. A dispatch that fails does **not** free its claim, and
 * that is the at-most-once property doing its job: the retry for a failed fire
 * is the next scheduled instant, held back by `backoff.ts` — a different
 * `fireAtMs`, therefore a different key. Releasing on failure would turn
 * at-most-once into at-least-once at exactly the moment the target is already
 * struggling.
 *
 * Because it is not a lock it needs no lease, and because it needs no lease it
 * needs no agreement about the clock between two hubs. That is worth more than
 * the crash-recovery a lease would buy: a hub that dies mid-dispatch leaves a
 * slot unrun, which the next scheduled instant covers, whereas a lease that
 * expires under a *slow* dispatch delivers the turn twice.
 *
 * ## The state file is memory; the claim file is the promise
 *
 * Two hubs sharing this directory share `state.json`, and writes to it are
 * last-writer-wins. That is tolerable only because at-most-once does not rest
 * on it: the worst a lost state write can do is make a hub forget when a job
 * last ran, and the claim file then refuses the make-up run that forgetting
 * would otherwise cause. Anything whose correctness *does* depend on two hubs
 * agreeing belongs in a claim, not in here.
 *
 * ## Fail-open, and why this is not the admission ledger
 *
 * `@qianmo/resident`'s admission ledger fails **closed** on damage: a torn
 * record there means a message this node promised to read may be lost, and
 * refusing to continue is the right answer. This store is on the other side of
 * that line, per roadmap P13.5's rule for the reliability kit. A corrupt state
 * file here costs one job's memory of when it last ran — a duplicate-suppressed
 * make-up run, at worst. Refusing to start would turn "one watch job is
 * confused" into "no watch job runs", which is a strictly larger outage caused
 * entirely by the safety mechanism.
 *
 * Fail-open is not fail-silent. Every damaged read and every failed write goes
 * to `onError`; §4.1 point 6 requires a scheduler's absence to be *visible*,
 * and a store that swallowed its own faults would be the quietest way to be
 * absent.
 */

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const STATE_FILE = 'state.json'
const CLAIMS_DIR = 'claims'
const CLAIM_SUFFIX = '.claim'

/**
 * How many claim files one job keeps, whatever the retention window says.
 *
 * A minute-cadence job leaves 1,440 files a day. Unbounded, "at most once"
 * becomes "until the filesystem runs out of inodes", which is around day forty
 * and looks nothing like a scheduling bug when it arrives.
 */
export const MAX_CLAIMS_PER_JOB = 256

/**
 * Floor on how long a claim is kept: `max(2 * everyMs, 1h)`.
 *
 * It has to exceed the catch-up grace, or pruning would delete the tombstone
 * for a slot that `reserve.ts` can still legitimately plan — and the second
 * fire would find no claim in its way. It does, at every period:
 * `catchUpGraceMs` is capped at two hours and only reaches that cap once the
 * period is four hours, by which point `2 * everyMs` is eight. `test/store`
 * pins that relationship rather than trusting this paragraph.
 */
export const MIN_CLAIM_RETENTION_MS = 3_600_000

export function claimRetentionMs(everyMs: number): number {
  return Math.max(2 * everyMs, MIN_CLAIM_RETENTION_MS)
}

/** What a fire did, once it is over. */
export type FireOutcome = 'completed' | 'failed' | 'skipped' | 'preempted'

export interface JobState {
  /** Latest **scheduled** instant retired for this job. See `PlanFireInput`. */
  readonly lastFiredAt: number | undefined
  readonly consecutiveFailures: number
  readonly lastOutcome: FireOutcome | undefined
  /** Wall clock at which `lastOutcome` was recorded — the backoff's baseline. */
  readonly lastOutcomeAt: number | undefined
}

const EMPTY_STATE: JobState = {
  lastFiredAt: undefined,
  consecutiveFailures: 0,
  lastOutcome: undefined,
  lastOutcomeAt: undefined,
}

const FIRE_OUTCOMES: readonly string[] = [
  'completed',
  'failed',
  'skipped',
  'preempted',
]

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseState(value: unknown): JobState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (!isCount(raw.consecutiveFailures)) return undefined
  if (raw.lastFiredAt !== undefined && !isCount(raw.lastFiredAt)) {
    return undefined
  }
  if (raw.lastOutcomeAt !== undefined && !isCount(raw.lastOutcomeAt)) {
    return undefined
  }
  if (
    raw.lastOutcome !== undefined &&
    (typeof raw.lastOutcome !== 'string' ||
      !FIRE_OUTCOMES.includes(raw.lastOutcome))
  ) {
    return undefined
  }
  return {
    lastFiredAt: raw.lastFiredAt as number | undefined,
    consecutiveFailures: raw.consecutiveFailures,
    lastOutcome: raw.lastOutcome as FireOutcome | undefined,
    lastOutcomeAt: raw.lastOutcomeAt as number | undefined,
  }
}

export interface SchedulerStoreOptions {
  readonly now?: () => number
  /** Where damage and failed writes are reported. Never a chance to veto. */
  readonly onError?: (error: unknown) => void
  readonly maxClaimsPerJob?: number
}

export class SchedulerStore {
  readonly #root: string
  readonly #statePath: string
  readonly #claimsRoot: string
  readonly #now: () => number
  readonly #onError: ((error: unknown) => void) | undefined
  readonly #maxClaimsPerJob: number
  #state: Record<string, JobState>

  constructor(root: string, options: SchedulerStoreOptions = {}) {
    if (root.trim() === '') {
      throw new Error('scheduler store root must not be empty')
    }
    this.#root = root
    this.#statePath = join(root, STATE_FILE)
    this.#claimsRoot = join(root, CLAIMS_DIR)
    this.#now = options.now ?? Date.now
    this.#onError = options.onError
    this.#maxClaimsPerJob = options.maxClaimsPerJob ?? MAX_CLAIMS_PER_JOB
    this.#state = this.#read()
  }

  get root(): string {
    return this.#root
  }

  stateOf(jobId: string): JobState {
    return this.#state[jobId] ?? EMPTY_STATE
  }

  entries(): Readonly<Record<string, JobState>> {
    return { ...this.#state }
  }

  /**
   * Take the slot, or lose it. The kernel picks.
   *
   * `true` means this process, and no other, may dispatch `(jobId, fireAtMs)`.
   * `false` means someone already has — another hub, or this hub before a
   * restart that lost its state file. Both are the same answer to the caller:
   * do not fire.
   *
   * A claim whose *write* fails after the exclusive create succeeded is still a
   * won claim. The file exists and is empty; the body is diagnostics, and
   * `engaged` is the file's existence, not its contents. Losing the body must
   * not hand the slot back.
   */
  claim(jobId: string, fireAtMs: number): boolean {
    const path = this.#claimPath(jobId, fireAtMs)
    let fd: number
    try {
      mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
      fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      // Anything else — EACCES, ENOSPC, EROFS — is reported and read as
      // "lost". This is the one place the kit does not fail open, and it is
      // the right way round: a claim store that cannot record a claim cannot
      // promise at-most-once, and a missed watch run is cheaper than a
      // duplicate one with side effects.
      this.#onError?.(error)
      return false
    }
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({
          dedupKey: dedupKeyOf(jobId, fireAtMs),
          claimedAt: this.#now(),
          pid: process.pid,
        })}\n`,
      )
      fsyncSync(fd)
    } catch (error) {
      this.#onError?.(error)
    } finally {
      closeSync(fd)
    }
    return true
  }

  /** True when this slot has already been claimed. Diagnostics only. */
  claimed(jobId: string, fireAtMs: number): boolean {
    try {
      statSync(this.#claimPath(jobId, fireAtMs))
      return true
    } catch {
      return false
    }
  }

  /**
   * Retire a scheduled instant with its outcome.
   *
   * `lastFiredAt` advances on every outcome including the failures — the grid
   * is a grid, and a failed lap does not entitle a job to run the same slot
   * again. The failure counter is what carries the retry policy, and it is
   * reset by a success and by nothing else.
   */
  recordFire(jobId: string, fireAtMs: number, outcome: FireOutcome): void {
    const previous = this.stateOf(jobId)
    const consecutiveFailures =
      outcome === 'failed'
        ? previous.consecutiveFailures + 1
        : outcome === 'completed'
          ? 0
          : previous.consecutiveFailures
    this.#state[jobId] = {
      lastFiredAt: fireAtMs,
      consecutiveFailures,
      lastOutcome: outcome,
      lastOutcomeAt: this.#now(),
    }
    this.#write()
  }

  forget(jobId: string): void {
    if (!(jobId in this.#state)) return
    delete this.#state[jobId]
    this.#write()
  }

  /**
   * Keep the claim directory bounded — see {@link MAX_CLAIMS_PER_JOB}.
   *
   * Age first, count second. Age is the correctness argument (a claim older
   * than any instant `reserve.ts` can still plan cannot suppress anything), and
   * the count is the backstop for a job whose period was edited downward and
   * whose retention window therefore covers far more slots than it used to.
   */
  pruneClaims(jobId: string, everyMs: number): void {
    const directory = join(this.#claimsRoot, jobId)
    let names: readonly string[]
    try {
      names = readdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#onError?.(error)
      }
      return
    }

    const slots: number[] = []
    for (const name of names) {
      if (!name.endsWith(CLAIM_SUFFIX)) continue
      const at = Number(name.slice(0, -CLAIM_SUFFIX.length))
      if (!Number.isSafeInteger(at)) continue
      slots.push(at)
    }
    slots.sort((left, right) => left - right)

    const floor = this.#now() - claimRetentionMs(everyMs)
    const doomed = new Set(slots.filter(at => at < floor))
    const surviving = slots.filter(at => !doomed.has(at))
    const excess = surviving.length - this.#maxClaimsPerJob
    for (let index = 0; index < excess; index++) {
      const at = surviving[index]
      if (at !== undefined) doomed.add(at)
    }

    for (const at of doomed) {
      try {
        rmSync(join(directory, `${at}${CLAIM_SUFFIX}`), { force: true })
      } catch (error) {
        this.#onError?.(error)
      }
    }
  }

  #claimPath(jobId: string, fireAtMs: number): string {
    return join(this.#claimsRoot, jobId, `${fireAtMs}${CLAIM_SUFFIX}`)
  }

  #read(): Record<string, JobState> {
    let raw: string
    try {
      raw = readFileSync(this.#statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#onError?.(error)
      }
      return {}
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.#onError?.(error)
      return {}
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      this.#onError?.(new Error('scheduler state file is not an object'))
      return {}
    }

    const state: Record<string, JobState> = {}
    for (const [jobId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const record = parseState(value)
      if (record === undefined) {
        // One unreadable job, not a whole unreadable hub: the others still have
        // their own memory of when they last ran, and this one falls back to
        // "never" — a duplicate-suppressed make-up run at worst.
        this.#onError?.(
          new Error(`scheduler state for job ${jobId} is unreadable`),
        )
        continue
      }
      state[jobId] = record
    }
    return state
  }

  /** Temp-then-rename, the house pattern. A failed write is reported, not thrown. */
  #write(): void {
    const temporary = `${this.#statePath}.${process.pid}.${this.#now()}.tmp`
    try {
      mkdirSync(this.#root, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(this.#root, DIRECTORY_MODE)
      const fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      try {
        writeFileSync(fd, `${JSON.stringify(this.#state)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.#statePath)
      chmodSync(this.#statePath, FILE_MODE)
    } catch (error) {
      rmSync(temporary, { force: true })
      // Kept in memory regardless. The claim file is the durable half of
      // at-most-once, so a hub that cannot write its state still does not
      // double-fire — it only forgets, and forgetting costs one make-up run
      // that the claim then suppresses.
      this.#onError?.(error)
    }
  }
}
