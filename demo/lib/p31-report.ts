// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import type { ActivationOutcome } from '@qianmo/activator'
import type { ResidentTimingEvent } from '@qianmo/resident/timings'
import { arg, emit, intArg } from './cli-args.js'
import { buildP31Report, checkP31Factors } from './p31-report-core.js'

function required(name: string): string {
  const value = arg(name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

function lines(path: string): {
  readonly values: unknown[]
  readonly corrupt: number
} {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { values: [], corrupt: 0 }
  }
  const values: unknown[] = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      values.push(JSON.parse(line))
    } catch {
      corrupt += 1
    }
  }
  return { values, corrupt }
}

function numberArg(name: string): number | undefined {
  const raw = arg(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`)
  return value
}

const activatorPath = required('activator-timings')
const residentPath = required('resident-timings')
const expectedRounds = intArg('rounds', 10)
const latencyLimitMs = intArg('latency-limit-ms', 60_000)
const expectedResidentFactor = numberArg('expected-resident-reconnect-factor')
const expectedKeepaliveFactor = numberArg('expected-keepalive-time-jump-factor')
const actualKeepaliveFactor = numberArg('keepalive-time-jump-factor')
const wanted = arg('msg-id')
const checkFactorsOnly = arg('check-factors') !== undefined
const waitMs = intArg('wait-ms', 0)
const pollMs = intArg('poll-ms', 500)
if (waitMs < 0) throw new Error('--wait-ms must not be negative')
if (pollMs < 100) throw new Error('--poll-ms must be at least 100')

function evaluate(): {
  readonly payload: Record<string, unknown>
  pass: boolean
} {
  const activator = lines(activatorPath)
  const resident = lines(residentPath)
  const factorCheck =
    expectedResidentFactor === undefined ||
    expectedKeepaliveFactor === undefined ||
    actualKeepaliveFactor === undefined
      ? null
      : checkP31Factors(
          resident.values as ResidentTimingEvent[],
          expectedResidentFactor,
          actualKeepaliveFactor,
          expectedKeepaliveFactor,
        )
  const report = buildP31Report(
    activator.values as ActivationOutcome[],
    resident.values as ResidentTimingEvent[],
    { expectedRounds, latencyLimitMs },
  )
  const corruptLines = {
    activator: activator.corrupt,
    resident: resident.corrupt,
  }
  const evidenceClean = activator.corrupt === 0 && resident.corrupt === 0

  if (checkFactorsOnly) {
    return {
      payload: { factorCheck, corruptLines },
      pass: factorCheck?.pass === true && evidenceClean,
    }
  }
  if (wanted !== undefined) {
    const entry = report.entries.find(candidate => candidate.msgId === wanted)
    return {
      payload: {
        msgId: wanted,
        found: entry !== undefined,
        entry,
        factorCheck,
        corruptLines,
      },
      pass:
        entry?.status === 'responsive' &&
        factorCheck?.pass === true &&
        evidenceClean,
    }
  }

  const pass = report.pass && factorCheck?.pass === true && evidenceClean
  return {
    payload: { ...report, pass, factorCheck, corruptLines },
    pass,
  }
}

const deadline = Date.now() + waitMs
for (;;) {
  const result = evaluate()
  if (result.pass || waitMs === 0 || Date.now() >= deadline) {
    emit(result.payload)
    process.exit(result.pass ? 0 : 1)
  }
  await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
}
