// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  HANDOFF_TRANSITIONS,
  HandoffLedger,
  HandoffLedgerError,
  type HandoffState,
  replayLedger,
} from '../src/ledger.js'
import {
  cleanupTemporaries,
  sampleManifest,
  sampleResult,
  tempDir,
} from './helpers.js'

afterAll(cleanupTemporaries)

function ledgerPath(): string {
  return join(tempDir(), 'hub', 'handoff', 'ledger.ndjson')
}

function clock(): () => number {
  let t = 1_790_000_000_000
  return () => (t += 1000)
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof HandoffLedgerError) return error.code
    throw error
  }
  return undefined
}

describe('HandoffLedger', () => {
  test('a task walks the whole chain and survives a restart', () => {
    const path = ledgerPath()
    const ledger = HandoffLedger.open(path, { now: clock() })
    expect(ledger.list()).toEqual([])
    expect(existsSync(path)).toBe(false)

    ledger.accept('t-1', sampleManifest())
    ledger.dispatch('t-1', 'beta-1')
    ledger.start('t-1')
    ledger.complete('t-1', sampleResult('t-1'))
    const returned = ledger.markReturned('t-1')
    ledger.close()

    expect(returned.state).toBe('returned')
    expect(returned.node).toBe('beta-1')
    expect(returned.result).toEqual(sampleResult('t-1'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(5)

    const reopened = HandoffLedger.open(path)
    expect(reopened.tornTail).toBeNull()
    expect(reopened.get('t-1')).toEqual(returned)
    expect(reopened.get('t-1')?.manifest).toEqual(sampleManifest())
  })

  test('the failure edges: accepted, dispatched and running may fail', () => {
    const ledger = HandoffLedger.open(ledgerPath(), { now: clock() })
    ledger.accept('a', sampleManifest())
    ledger.accept('b', sampleManifest())
    ledger.accept('c', sampleManifest())
    expect(ledger.fail('a', 'deadline passed before dispatch').state).toBe(
      'failed',
    )
    ledger.dispatch('b', 'beta-1')
    expect(ledger.fail('b', 'node refused: E_BUSY').reason).toBe(
      'node refused: E_BUSY',
    )
    ledger.dispatch('c', 'beta-1')
    ledger.start('c')
    ledger.fail('c', 'turn failed')
    expect(ledger.markReturned('c').state).toBe('returned')
  })

  test('illegal transitions are refused and leave the file alone', () => {
    const path = ledgerPath()
    const ledger = HandoffLedger.open(path, { now: clock() })
    ledger.accept('t', sampleManifest())
    const size = () => readFileSync(path).length
    const before = size()

    expect(codeOf(() => ledger.start('t'))).toBe('illegal_transition')
    expect(codeOf(() => ledger.complete('t', sampleResult('t')))).toBe(
      'illegal_transition',
    )
    expect(codeOf(() => ledger.markReturned('t'))).toBe('illegal_transition')
    ledger.dispatch('t', 'beta-1')
    expect(codeOf(() => ledger.complete('t', sampleResult('t')))).toBe(
      'illegal_transition',
    )
    expect(codeOf(() => ledger.dispatch('t', 'beta-2'))).toBe(
      'illegal_transition',
    )
    ledger.start('t')
    ledger.complete('t', sampleResult('t'))
    expect(codeOf(() => ledger.fail('t', 'late'))).toBe('illegal_transition')
    ledger.markReturned('t')
    for (const step of [
      () => ledger.markReturned('t'),
      () => ledger.dispatch('t', 'beta-1'),
      () => ledger.fail('t', 'x'),
    ]) {
      expect(codeOf(step)).toBe('illegal_transition')
    }
    expect(codeOf(() => ledger.start('nope'))).toBe('unknown_task')
    expect(codeOf(() => ledger.accept('t', sampleManifest()))).toBe(
      'duplicate_task',
    )
    // Accept, dispatch, start, complete, return: five lines, nothing else.
    expect(size()).toBeGreaterThan(before)
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(5)
  })

  test('the transition table is exactly the documented chain plus failure edges', () => {
    const edges = Object.entries(HANDOFF_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map(to => `${from}→${to}`),
    )
    expect(edges.sort()).toEqual(
      [
        'accepted→dispatched',
        'accepted→failed',
        'dispatched→running',
        'dispatched→failed',
        'running→done',
        'running→failed',
        'done→returned',
        'failed→returned',
      ].sort(),
    )
    expect(
      HANDOFF_TRANSITIONS.returned satisfies readonly HandoffState[],
    ).toEqual([])
  })

  test('one unfinished task per node, also across a restart', () => {
    const path = ledgerPath()
    const first = HandoffLedger.open(path, { now: clock() })
    first.accept('a', sampleManifest())
    first.dispatch('a', 'beta-1')
    first.close()

    const ledger = HandoffLedger.open(path, { now: clock() })
    expect(ledger.activeOn('beta-1')?.taskId).toBe('a')
    ledger.accept('b', sampleManifest())
    expect(codeOf(() => ledger.dispatch('b', 'beta-1'))).toBe('node_busy')
    ledger.dispatch('b', 'beta-2')
    ledger.start('a')
    expect(ledger.activeOn('beta-1')?.taskId).toBe('a')
    ledger.complete('a', sampleResult('a'))
    // done releases the node; the task still remembers where it ran.
    expect(ledger.activeOn('beta-1')).toBeUndefined()
    expect(ledger.get('a')?.node).toBe('beta-1')
    ledger.accept('c', sampleManifest())
    expect(ledger.dispatch('c', 'beta-1').node).toBe('beta-1')
  })

  test('a half-written last line is reported, not applied, and cut before the next append', () => {
    const path = ledgerPath()
    const ledger = HandoffLedger.open(path, { now: clock() })
    ledger.accept('t', sampleManifest())
    ledger.dispatch('t', 'beta-1')
    ledger.close()
    const intact = readFileSync(path)
    const torn = '{"v":1,"at":1790000009000,"taskId":"t","state":"run'
    appendFileSync(path, torn)

    const recovered = HandoffLedger.open(path, { now: clock() })
    expect(recovered.tornTail).toEqual({ line: 3, bytes: torn.length })
    expect(recovered.get('t')?.state).toBe('dispatched')
    // Reading did not modify the file.
    expect(readFileSync(path).length).toBe(intact.length + torn.length)

    recovered.start('t')
    recovered.close()
    const text = readFileSync(path, 'utf8')
    expect(text.startsWith(intact.toString('utf8'))).toBe(true)
    expect(text).not.toContain(torn)

    const again = HandoffLedger.open(path)
    expect(again.tornTail).toBeNull()
    expect(again.get('t')?.state).toBe('running')
  })

  test('a torn tail with no complete line before it', () => {
    const replay = replayLedger('{"v":1,"at":')
    expect(replay.tasks.size).toBe(0)
    expect(replay.tornTail).toEqual({ line: 1, bytes: 12 })
    expect(replay.validBytes).toBe(0)
  })

  test('damage before the last newline refuses to open, naming the line', () => {
    const good = (() => {
      const path = ledgerPath()
      const ledger = HandoffLedger.open(path, { now: clock() })
      ledger.accept('t', sampleManifest())
      ledger.dispatch('t', 'beta-1')
      ledger.close()
      return readFileSync(path, 'utf8').split('\n').slice(0, 2)
    })()
    const cases: [string, string[], number][] = [
      ['garbled middle line', [good[0] ?? '', '{oops', good[1] ?? ''], 2],
      ['garbled complete last line', [good[0] ?? '', '{oops'], 2],
      ['transition before acceptance', [good[1] ?? '', good[0] ?? ''], 1],
      [
        'extra field',
        [good[0] ?? '', (good[1] ?? '').replace('"node"', '"extra":1,"node"')],
        2,
      ],
      [
        'unknown state',
        [good[0] ?? '', (good[1] ?? '').replace('dispatched', 'paused')],
        2,
      ],
    ]
    for (const [name, lines, line] of cases) {
      const file = join(tempDir(), 'ledger.ndjson')
      writeFileSync(file, `${lines.join('\n')}\n`)
      let caught: unknown
      try {
        HandoffLedger.open(file)
      } catch (error) {
        caught = error
      }
      expect(caught, name).toBeInstanceOf(HandoffLedgerError)
      expect((caught as HandoffLedgerError).code, name).toBe('corrupt')
      expect((caught as HandoffLedgerError).line, name).toBe(line)
    }
  })

  test('two tasks holding one node in the file is corruption', () => {
    const path = ledgerPath()
    const ledger = HandoffLedger.open(path, { now: clock() })
    ledger.accept('a', sampleManifest())
    ledger.accept('b', sampleManifest())
    ledger.dispatch('a', 'beta-1')
    ledger.close()
    const forged = readFileSync(path, 'utf8')
      .trimEnd()
      .split('\n')
      .at(-1)
      ?.replace('"taskId":"a"', '"taskId":"b"')
    appendFileSync(path, `${forged}\n`)
    let caught: unknown
    try {
      HandoffLedger.open(path)
    } catch (error) {
      caught = error
    }
    expect((caught as HandoffLedgerError).code).toBe('corrupt')
    expect((caught as HandoffLedgerError).line).toBe(4)
  })

  test('inputs are validated before anything is written', () => {
    const path = ledgerPath()
    const ledger = HandoffLedger.open(path, { now: clock() })
    expect(codeOf(() => ledger.accept('a.b', sampleManifest()))).toBe(
      'invalid_input',
    )
    expect(
      codeOf(() =>
        ledger.accept('t', { ...sampleManifest(), cwd: 'relative/path' }),
      ),
    ).toBe('invalid_input')
    expect(existsSync(path)).toBe(false)
    ledger.accept('t', sampleManifest())
    expect(codeOf(() => ledger.dispatch('t', 'Beta 1'))).toBe('invalid_input')
    ledger.dispatch('t', 'beta-1')
    expect(codeOf(() => ledger.fail('t', ' '))).toBe('invalid_input')
    ledger.start('t')
    expect(
      codeOf(() =>
        ledger.complete('t', { ...sampleResult('t'), branch: 'main' }),
      ),
    ).toBe('invalid_input')
    expect(ledger.get('t')?.state).toBe('running')
  })

  test('an empty path is refused', () => {
    expect(codeOf(() => HandoffLedger.open(' '))).toBe('invalid_input')
  })
})
