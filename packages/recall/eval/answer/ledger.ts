// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer layer's token hard cap (`docs/dev/memory-m1.md` §4 「硬上限」,
 * D-7): counted in tokens, per axis, persisted, and not reset by a restart.
 *
 * THREE LIMITS, THE TIGHTEST WINS
 *
 *   ceiling   the owner-approved upper bound of D-7, for every run ever made
 *             against this ledger: 18.5 M input, 4.8 M output. Written here in
 *             code, not in a config file, so it cannot be raised by a flag.
 *   trial     P16.4's sub-cap, a tenth of the ceiling, across all trial runs.
 *   run       the cap this run was started with. Recorded on first open;
 *             reopening the same run with a different cap is refused.
 *
 * RESERVE BEFORE, SETTLE AFTER
 *
 * Before a call the executor reserves an upper bound: the request's size for
 * input, `max_tokens` for output. A reservation that does not fit under every
 * limit is refused — the call is not made. After the call the reservation is
 * replaced by the provider's reported usage, or charged in full when there is
 * none (a failed call may still have been billed).
 *
 * Every reservation is on disk before the call goes out. A process that dies
 * mid-call leaves it there, and the next open charges it in full: nobody knows
 * whether that call was billed, so the ledger assumes it was. That is how a
 * crash-restart loop is kept from spending past the cap.
 *
 * HOLD FOR THE SECOND ROUND
 *
 * A call whose citations are rejected gets one more round. If that round did
 * not fit, the first round would be paid for and then thrown away — and paid
 * for again on resume. So before a first round goes out the executor also
 * *holds* an upper bound for the second: checked like a reservation and kept
 * out of reach of every other call until released, but never charged and
 * never written to disk. A crash drops it, which is right, because nothing
 * was spent on it.
 *
 * One process at a time: a lock file names the holder's pid. A lock whose
 * process is gone is taken over (and its reservations charged); a live one is
 * refused.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { TokenUsage } from './types.js'

/** D-7: the approved upper bound, input 18.5 M / output 4.8 M tokens. */
export const ANSWER_TOKEN_CEILING: TokenUsage = {
  input: 18_500_000,
  output: 4_800_000,
}

/** §4: P16.4's own sub-cap is a tenth of the ceiling. */
export const TRIAL_TOKEN_CEILING: TokenUsage = {
  input: ANSWER_TOKEN_CEILING.input / 10,
  output: ANSWER_TOKEN_CEILING.output / 10,
}

/** `trial` is P16.4 (30-tier trial); `comparison` is P16.12. */
export type Phase = 'trial' | 'comparison'

const PHASES: readonly Phase[] = ['trial', 'comparison']

const LEDGER_SCHEMA = 'qianmo-recall-answer-ledger/v1'

type Pending = {
  readonly runId: string
  readonly phase: Phase
  readonly callKey: string
  readonly reserved: TokenUsage
  readonly pid: number
}

type RunRecord = {
  readonly phase: Phase
  readonly cap: TokenUsage
  spent: TokenUsage
}

type LedgerState = {
  schema: typeof LEDGER_SCHEMA
  spent: TokenUsage
  byPhase: Record<Phase, TokenUsage>
  runs: Record<string, RunRecord>
  pending: Record<string, Pending>
  /** Reservations found on open, left by a process that died mid-call. */
  orphaned: { reservations: number; charged: TokenUsage }
  /** Calls whose reported usage exceeded what was reserved for them. */
  overshoots: number
}

type LimitName = 'ceiling' | 'trial' | 'run'

/** A reservation did not fit: the call must not be made. */
export class TokenCapReached extends Error {
  constructor(
    readonly limit: LimitName,
    readonly axis: keyof TokenUsage,
    readonly needed: number,
    readonly remaining: number,
  ) {
    super(
      `token cap reached: ${limit} ${axis} has ${remaining} left, the next call reserves ${needed}`,
    )
    this.name = 'TokenCapReached'
  }
}

/** Another live process holds the ledger. */
export class LedgerBusy extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`token ledger ${path} is held by live process ${pid}`)
    this.name = 'LedgerBusy'
  }
}

export type LedgerSnapshot = {
  readonly ceiling: TokenUsage
  readonly trialCeiling: TokenUsage
  readonly spent: TokenUsage
  readonly byPhase: Readonly<Record<Phase, TokenUsage>>
  readonly run: {
    readonly id: string
    readonly phase: Phase
    readonly cap: TokenUsage
    readonly spent: TokenUsage
  }
  readonly orphaned: {
    readonly reservations: number
    readonly charged: TokenUsage
  }
  readonly overshoots: number
}

type LedgerOpenOptions = {
  readonly runId: string
  readonly phase: Phase
  readonly cap: TokenUsage
}

const ZERO: TokenUsage = { input: 0, output: 0 }

const plus = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
})

function isUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null) return false
  const { input, output } = value as Record<string, unknown>
  return (
    typeof input === 'number' &&
    typeof output === 'number' &&
    Number.isInteger(input) &&
    Number.isInteger(output) &&
    input >= 0 &&
    output >= 0
  )
}

function freshState(): LedgerState {
  return {
    schema: LEDGER_SCHEMA,
    spent: ZERO,
    byPhase: { trial: ZERO, comparison: ZERO },
    runs: {},
    pending: {},
    orphaned: { reservations: 0, charged: ZERO },
    overshoots: 0,
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function readState(path: string): LedgerState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return freshState()
    throw error
  }
  // A ledger that cannot be read is never replaced by a fresh one: that
  // would be a reset of the spend, which is the one thing it exists to stop.
  const state = JSON.parse(text) as LedgerState
  if (
    state.schema !== LEDGER_SCHEMA ||
    !isUsage(state.spent) ||
    !PHASES.every(phase => isUsage(state.byPhase?.[phase])) ||
    typeof state.runs !== 'object' ||
    typeof state.pending !== 'object' ||
    !isUsage(state.orphaned?.charged) ||
    typeof state.overshoots !== 'number'
  ) {
    throw new Error(`token ledger ${path} is not a ${LEDGER_SCHEMA} file`)
  }
  return state
}

/** Same shape as `@qianmo/memory`'s store: temp file, fsync, rename. */
function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = openSync(temporary, 'wx', 0o600)
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it just is not ours.
    return isErrorCode(error, 'EPERM')
  }
}

function acquireLock(lockPath: string, ledgerPath: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(handle, String(process.pid))
      } finally {
        closeSync(handle)
      }
      return
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error
    }
    const holder = Number.parseInt(readFileSync(lockPath, 'utf8'), 10)
    if (Number.isInteger(holder) && processAlive(holder)) {
      throw new LedgerBusy(ledgerPath, holder)
    }
    rmSync(lockPath, { force: true })
  }
  throw new Error(`token ledger ${ledgerPath}: could not take the lock`)
}

export class TokenLedger {
  readonly #path: string
  readonly #lockPath: string
  readonly #runId: string
  readonly #phase: Phase
  #state: LedgerState
  #counter = 0
  #closed = false
  /** Second-round holds of calls in flight; in memory only (see the header). */
  readonly #holds = new Map<string, TokenUsage>()

  private constructor(path: string, options: LedgerOpenOptions) {
    this.#path = path
    this.#lockPath = `${path}.lock`
    this.#runId = options.runId
    this.#phase = options.phase
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    acquireLock(this.#lockPath, path)
    try {
      this.#state = readState(path)
      this.#chargeOrphans()
      this.#admitRun(options)
      this.#persist()
    } catch (error) {
      rmSync(this.#lockPath, { force: true })
      throw error
    }
  }

  /**
   * Open the ledger at `path` for one run. Takes the lock, charges any
   * reservation a dead process left behind, and records or checks the run.
   */
  static open(path: string, options: LedgerOpenOptions): TokenLedger {
    return new TokenLedger(path, options)
  }

  #chargeOrphans(): void {
    const state = this.#state
    for (const pending of Object.values(state.pending)) {
      state.spent = plus(state.spent, pending.reserved)
      state.byPhase[pending.phase] = plus(
        state.byPhase[pending.phase],
        pending.reserved,
      )
      const run = state.runs[pending.runId]
      if (run !== undefined) run.spent = plus(run.spent, pending.reserved)
      state.orphaned = {
        reservations: state.orphaned.reservations + 1,
        charged: plus(state.orphaned.charged, pending.reserved),
      }
    }
    state.pending = {}
  }

  #admitRun({ runId, phase, cap }: LedgerOpenOptions): void {
    if (!isUsage(cap)) {
      throw new Error('token ledger: the run cap must be two whole numbers')
    }
    const existing = this.#state.runs[runId]
    if (existing !== undefined) {
      if (
        existing.phase !== phase ||
        existing.cap.input !== cap.input ||
        existing.cap.output !== cap.output
      ) {
        throw new Error(
          `token ledger: run ${runId} was started as ${existing.phase} with cap ` +
            `${existing.cap.input}/${existing.cap.output}; start a new run to change it`,
        )
      }
      return
    }
    for (const [name, remaining] of this.#headroom(phase)) {
      if (name === 'run') continue
      for (const axis of ['input', 'output'] as const) {
        if (cap[axis] > remaining[axis]) {
          throw new Error(
            `token ledger: run cap ${axis} ${cap[axis]} exceeds the ${name} ` +
              `headroom ${remaining[axis]}`,
          )
        }
      }
    }
    this.#state.runs[runId] = { phase, cap, spent: ZERO }
  }

  #pendingSum(filter: (pending: Pending) => boolean): TokenUsage {
    return Object.values(this.#state.pending)
      .filter(filter)
      .reduce((sum, pending) => plus(sum, pending.reserved), ZERO)
  }

  /**
   * What is left under each limit, after spend, outstanding reservations and
   * this process's holds.
   */
  #headroom(phase: Phase): [LimitName, TokenUsage][] {
    const state = this.#state
    const held = [...this.#holds.values()].reduce(plus, ZERO)
    const minus = (limit: TokenUsage, ...used: TokenUsage[]): TokenUsage => {
      const total = used.reduce(plus, ZERO)
      return {
        input: limit.input - total.input,
        output: limit.output - total.output,
      }
    }
    const limits: [LimitName, TokenUsage][] = [
      [
        'ceiling',
        minus(
          ANSWER_TOKEN_CEILING,
          state.spent,
          this.#pendingSum(() => true),
          held,
        ),
      ],
    ]
    if (phase === 'trial') {
      limits.push([
        'trial',
        minus(
          TRIAL_TOKEN_CEILING,
          state.byPhase.trial,
          this.#pendingSum(pending => pending.phase === 'trial'),
          held,
        ),
      ])
    }
    const run = state.runs[this.#runId]
    if (run !== undefined) {
      limits.push([
        'run',
        minus(
          run.cap,
          run.spent,
          this.#pendingSum(pending => pending.runId === this.#runId),
          held,
        ),
      ])
    }
    return limits
  }

  #persist(): void {
    writeAtomic(this.#path, `${JSON.stringify(this.#state, null, 2)}\n`)
  }

  #live(): void {
    if (this.#closed) throw new Error('token ledger: already closed')
  }

  /** Throw {@link TokenCapReached} unless `bound` fits under every limit. */
  #fit(bound: TokenUsage): void {
    this.#live()
    if (!isUsage(bound)) {
      throw new Error('token ledger: a bound must be two whole numbers')
    }
    for (const [name, remaining] of this.#headroom(this.#phase)) {
      for (const axis of ['input', 'output'] as const) {
        if (bound[axis] > remaining[axis]) {
          throw new TokenCapReached(
            name,
            axis,
            bound[axis],
            Math.max(0, remaining[axis]),
          )
        }
      }
    }
  }

  /**
   * Reserve an upper bound for one call, on disk, before the call is made.
   * Throws {@link TokenCapReached} when it does not fit under every limit.
   */
  reserve(callKey: string, bound: TokenUsage): string {
    this.#fit(bound)
    this.#counter += 1
    const id = `${process.pid}-${this.#counter}`
    this.#state.pending[id] = {
      runId: this.#runId,
      phase: this.#phase,
      callKey,
      reserved: bound,
      pid: process.pid,
    }
    this.#persist()
    return id
  }

  /**
   * Hold `bound` for a call's possible second round: throws
   * {@link TokenCapReached} when it does not fit, and otherwise keeps it out
   * of every later reservation's reach until {@link release}. Not charged.
   */
  hold(bound: TokenUsage): string {
    this.#fit(bound)
    this.#counter += 1
    const id = `hold-${this.#counter}`
    this.#holds.set(id, bound)
    return id
  }

  /** Give a hold back. Releasing twice is harmless. */
  release(id: string): void {
    this.#holds.delete(id)
  }

  /**
   * Replace a reservation with what was used: the reported usage, or the whole
   * reservation when the provider reported none. Returns what was charged.
   */
  settle(id: string, usage: TokenUsage | null): TokenUsage {
    this.#live()
    const state = this.#state
    const pending = state.pending[id]
    if (pending === undefined) {
      throw new Error(`token ledger: no reservation ${id}`)
    }
    const charged = usage ?? pending.reserved
    if (!isUsage(charged)) {
      throw new Error('token ledger: usage must be two whole numbers')
    }
    if (
      charged.input > pending.reserved.input ||
      charged.output > pending.reserved.output
    ) {
      state.overshoots += 1
    }
    delete state.pending[id]
    state.spent = plus(state.spent, charged)
    state.byPhase[pending.phase] = plus(state.byPhase[pending.phase], charged)
    const run = state.runs[pending.runId]
    if (run !== undefined) run.spent = plus(run.spent, charged)
    this.#persist()
    return charged
  }

  snapshot(): LedgerSnapshot {
    const state = this.#state
    const run = state.runs[this.#runId]
    if (run === undefined) throw new Error('token ledger: run not admitted')
    return {
      ceiling: ANSWER_TOKEN_CEILING,
      trialCeiling: TRIAL_TOKEN_CEILING,
      spent: state.spent,
      byPhase: { ...state.byPhase },
      run: {
        id: this.#runId,
        phase: run.phase,
        cap: run.cap,
        spent: run.spent,
      },
      orphaned: state.orphaned,
      overshoots: state.overshoots,
    }
  }

  /** Release the lock. Outstanding reservations stay and are charged later. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      const holder = readFileSync(this.#lockPath, 'utf8')
      if (holder === String(process.pid)) rmSync(this.#lockPath)
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error
    }
  }
}
