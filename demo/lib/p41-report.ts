// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P4.1 —— 汇总每轮记录，输出判据报告并以退出码表态。
 *
 *   bun run demo/lib/p41-report.ts --rounds-file <jsonl> --rounds 10
 *
 * 证据完整性也判：JSONL 里有一行解析不了，就当作证据不干净——一份自己都读不全的
 * 记录不该给出「通过」。
 */

import { readFileSync } from 'node:fs'
import { arg, emit, intArg } from './cli-args.js'
import { buildP41Report, type P41Round } from './p41-report-core.js'

const roundsPath = arg('rounds-file')
if (roundsPath === undefined) throw new Error('--rounds-file is required')
const expectedRounds = intArg('rounds', 10)
const ackLimitMs = intArg('ack-limit-ms', 60_000)
const resultLimitMs = intArg('result-limit-ms', 300_000)

let raw = ''
try {
  raw = readFileSync(roundsPath, 'utf8')
} catch (error) {
  throw new Error(
    `cannot read ${roundsPath}: ${error instanceof Error ? error.message : String(error)}`,
  )
}

const values: P41Round[] = []
let corrupt = 0
for (const line of raw.split('\n')) {
  if (line.trim() === '') continue
  try {
    values.push(JSON.parse(line) as P41Round)
  } catch {
    corrupt += 1
  }
}

const report = buildP41Report(values, {
  expectedRounds,
  ackLimitMs,
  resultLimitMs,
})
const pass = report.pass && corrupt === 0
emit({ ...report, corruptLines: corrupt, pass })
process.exit(pass ? 0 : 1)
