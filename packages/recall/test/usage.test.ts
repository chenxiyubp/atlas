// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { occConfigPath } from '../../../src/config/paths.js'
import { estimateEmbeddingTokens } from '../src/embedding.js'
import {
  defaultEmbeddingUsagePath,
  FileEmbeddingUsageMeter,
} from '../src/index.js'
import { DAY_MS, ManualClock } from './helpers.js'

let directory: string
let path: string
let clock: ManualClock

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-recall-usage-'))
  path = join(directory, 'qianmo', 'embedding', 'usage.json')
  clock = new ManualClock(Date.UTC(2026, 8, 26, 12, 0, 0))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function meter(dailyTokenLimit: number): FileEmbeddingUsageMeter {
  return new FileEmbeddingUsageMeter({ dailyTokenLimit, path, now: clock.now })
}

describe('embedding usage meter', () => {
  test('the default file is derived from the identity config root', () => {
    const saved = process.env.OCC_CONFIG_DIR
    process.env.OCC_CONFIG_DIR = directory
    try {
      expect(defaultEmbeddingUsagePath()).toBe(
        occConfigPath('qianmo', 'embedding', 'usage.json'),
      )
      expect(defaultEmbeddingUsagePath()).toBe(
        join(directory, 'qianmo', 'embedding', 'usage.json'),
      )
    } finally {
      if (saved === undefined) delete process.env.OCC_CONFIG_DIR
      else process.env.OCC_CONFIG_DIR = saved
    }
  })

  test('counts tokens, survives a new instance, and reconciles downwards', () => {
    const first = meter(1_000)
    expect(first.remaining()).toBe(1_000)
    first.charge(300)
    first.charge(-50)

    const restarted = meter(1_000)
    expect(restarted.used()).toBe(250)
    expect(restarted.remaining()).toBe(750)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      day: '2026-09-26',
      tokens: 250,
    })

    restarted.charge(-10_000)
    expect(restarted.used()).toBe(0)
  })

  test('the window is the UTC day; a clock that runs backwards keeps counting', () => {
    const usage = meter(100)
    usage.charge(80)
    clock.advance(DAY_MS)
    expect(usage.used()).toBe(0)
    usage.charge(10)
    expect(JSON.parse(readFileSync(path, 'utf8')).day).toBe('2026-09-27')

    clock.advance(-DAY_MS)
    expect(usage.used()).toBe(10)
    expect(usage.remaining()).toBe(90)
  })

  test('never goes over the limit in what it reports as remaining', () => {
    const usage = meter(10)
    usage.charge(25)
    expect(usage.remaining()).toBe(0)
  })

  test('the file is private to the node', () => {
    meter(10).charge(1)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  test('a limit that is not a non-negative integer is refused', () => {
    expect(() => meter(-1)).toThrow()
    expect(() => meter(1.5)).toThrow()
    expect(() => meter(Number.NaN)).toThrow()
    expect(() => meter(1).charge(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe('token estimate', () => {
  test('dense scripts count per character, the rest per 2.5 characters', () => {
    expect(estimateEmbeddingTokens('')).toBe(0)
    expect(estimateEmbeddingTokens('向量检索')).toBe(4)
    expect(estimateEmbeddingTokens('abcde')).toBe(2)
    expect(estimateEmbeddingTokens('用 Bun')).toBe(1 + 2)
  })
})
