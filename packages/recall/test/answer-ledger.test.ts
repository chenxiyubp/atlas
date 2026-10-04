// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The token ledger (§4 「硬上限」): counted in tokens, persisted, not reset by
 * a restart, and refusing a call that does not fit.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANSWER_TOKEN_CEILING,
  LedgerBusy,
  TokenCapReached,
  TokenLedger,
  TRIAL_TOKEN_CEILING,
} from '../eval/answer/ledger.js'

let directory: string
let path: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-ledger-'))
  path = join(directory, 'ledger.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const CAP = { input: 1_000, output: 500 }

describe('limits', () => {
  test('the D-7 ceiling and the P16.4 sub-cap are written in code', () => {
    expect(ANSWER_TOKEN_CEILING).toEqual({
      input: 18_500_000,
      output: 4_800_000,
    })
    expect(TRIAL_TOKEN_CEILING).toEqual({ input: 1_850_000, output: 480_000 })
  })

  test('reserve, settle with usage, settle without usage', () => {
    const ledger = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'trial',
      cap: CAP,
    })
    const a = ledger.reserve('k1', { input: 300, output: 200 })
    expect(ledger.settle(a, { input: 120, output: 40 })).toEqual({
      input: 120,
      output: 40,
    })
    const b = ledger.reserve('k2', { input: 300, output: 200 })
    // No usage reported: the whole reservation is charged.
    expect(ledger.settle(b, null)).toEqual({ input: 300, output: 200 })
    const snapshot = ledger.snapshot()
    expect(snapshot.spent).toEqual({ input: 420, output: 240 })
    expect(snapshot.byPhase.trial).toEqual({ input: 420, output: 240 })
    expect(snapshot.run.spent).toEqual({ input: 420, output: 240 })
    ledger.close()
  })

  test('a reservation over the run cap is refused, counting outstanding ones', () => {
    const ledger = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'comparison',
      cap: CAP,
    })
    ledger.reserve('k1', { input: 600, output: 100 })
    expect(() => ledger.reserve('k2', { input: 600, output: 100 })).toThrow(
      TokenCapReached,
    )
    try {
      ledger.reserve('k2', { input: 10, output: 450 })
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(TokenCapReached)
      const cap = error as TokenCapReached
      expect([cap.limit, cap.axis, cap.needed, cap.remaining]).toEqual([
        'run',
        'output',
        450,
        400,
      ])
    }
    ledger.close()
  })

  test('a preset spend near the ceiling refuses the first reservation', () => {
    writeFileSync(
      path,
      JSON.stringify({
        schema: 'qianmo-recall-answer-ledger/v1',
        spent: { input: ANSWER_TOKEN_CEILING.input - 50, output: 0 },
        byPhase: {
          trial: { input: 0, output: 0 },
          comparison: { input: ANSWER_TOKEN_CEILING.input - 50, output: 0 },
        },
        runs: {},
        pending: {},
        orphaned: { reservations: 0, charged: { input: 0, output: 0 } },
        overshoots: 0,
      }),
    )
    const ledger = TokenLedger.open(path, {
      runId: 'r2',
      phase: 'comparison',
      cap: { input: 50, output: 500 },
    })
    expect(() => ledger.reserve('k', { input: 51, output: 1 })).toThrow(
      /ceiling input has 50 left/,
    )
    ledger.close()
  })

  test('a run cap larger than the headroom is refused at open', () => {
    expect(() =>
      TokenLedger.open(path, {
        runId: 'big',
        phase: 'trial',
        cap: { input: TRIAL_TOKEN_CEILING.input + 1, output: 1 },
      }),
    ).toThrow(/exceeds the trial headroom/)
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  test('a run keeps the cap it started with', () => {
    TokenLedger.open(path, { runId: 'r1', phase: 'trial', cap: CAP }).close()
    expect(() =>
      TokenLedger.open(path, {
        runId: 'r1',
        phase: 'trial',
        cap: { input: 2_000, output: 500 },
      }),
    ).toThrow(/start a new run/)
  })
})

describe('second-round hold', () => {
  test('a hold counts against every reservation until released, and is never charged', () => {
    const ledger = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'trial',
      cap: CAP,
    })
    const hold = ledger.hold({ input: 700, output: 100 })
    // 1000 − 700 held leaves 300: a 301 reservation does not fit.
    expect(() => ledger.reserve('k', { input: 301, output: 1 })).toThrow(
      TokenCapReached,
    )
    const id = ledger.reserve('k', { input: 300, output: 1 })
    // Nor does a second hold the first one already covers.
    expect(() => ledger.hold({ input: 1, output: 1 })).toThrow(TokenCapReached)
    ledger.settle(id, { input: 10, output: 1 })
    ledger.release(hold)
    ledger.release(hold)
    expect(() => ledger.reserve('k2', { input: 990, output: 1 })).not.toThrow()
    expect(ledger.snapshot().run.spent).toEqual({ input: 10, output: 1 })
    ledger.close()
  })

  test('a hold left by a crash is not charged: it was never written down', () => {
    const ledger = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'trial',
      cap: CAP,
    })
    ledger.hold({ input: 900, output: 400 })
    expect(JSON.parse(readFileSync(path, 'utf8')).pending).toEqual({})
    ledger.close()
    const reopened = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'trial',
      cap: CAP,
    })
    expect(reopened.snapshot().spent).toEqual({ input: 0, output: 0 })
    expect(() =>
      reopened.reserve('k', { input: 1000, output: 500 }),
    ).not.toThrow()
    reopened.close()
  })
})

describe('persistence', () => {
  test('spend survives reopening; a second holder is refused', () => {
    const first = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'trial',
      cap: CAP,
    })
    first.settle(first.reserve('k', { input: 100, output: 100 }), {
      input: 70,
      output: 30,
    })
    expect(() =>
      TokenLedger.open(path, { runId: 'r1', phase: 'trial', cap: CAP }),
    ).toThrow(LedgerBusy)
    first.close()
    const second = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'trial',
      cap: CAP,
    })
    expect(second.snapshot().run.spent).toEqual({ input: 70, output: 30 })
    // The run's remaining cap is what was left, not the whole cap again.
    expect(() => second.reserve('k2', { input: 931, output: 1 })).toThrow(
      TokenCapReached,
    )
    second.close()
  })

  test('a process killed mid-call: its reservation is charged in full on the next open', () => {
    const ledgerModule = fileURLToPath(
      new URL('../eval/answer/ledger.ts', import.meta.url),
    )
    const script = [
      `import { TokenLedger } from ${JSON.stringify(ledgerModule)}`,
      `const ledger = TokenLedger.open(${JSON.stringify(path)}, { runId: 'r1', phase: 'trial', cap: { input: 1000, output: 500 } })`,
      `ledger.reserve('in-flight', { input: 400, output: 300 })`,
      // Exit without settling or closing: the call's fate is unknown.
      'process.exit(0)',
    ].join('\n')
    const child = Bun.spawnSync(['bun', '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode).toBe(0)
    expect(existsSync(`${path}.lock`)).toBe(true)
    const pending = JSON.parse(readFileSync(path, 'utf8')).pending
    expect(Object.keys(pending).length).toBe(1)

    const reopened = TokenLedger.open(path, {
      runId: 'r1',
      phase: 'trial',
      cap: CAP,
    })
    const snapshot = reopened.snapshot()
    expect(snapshot.orphaned).toEqual({
      reservations: 1,
      charged: { input: 400, output: 300 },
    })
    expect(snapshot.spent).toEqual({ input: 400, output: 300 })
    expect(snapshot.run.spent).toEqual({ input: 400, output: 300 })
    reopened.close()
    expect(JSON.parse(readFileSync(path, 'utf8')).pending).toEqual({})
  }, 30_000)

  test('an unreadable ledger is never replaced by a fresh one', () => {
    writeFileSync(path, '{"schema":"something else"}')
    expect(() =>
      TokenLedger.open(path, { runId: 'r1', phase: 'trial', cap: CAP }),
    ).toThrow(/is not a qianmo-recall-answer-ledger\/v1 file/)
    expect(readFileSync(path, 'utf8')).toBe('{"schema":"something else"}')
  })
})
