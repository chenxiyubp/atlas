// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { LIMITS } from '@qianmo/protocol'
import { NOTIFY_POLICIES, assertJob, dedupKeyOf } from '../src/job.js'

const VALID = {
  id: 'watch-ci',
  title: '盯 CI 主干',
  target: 'qianmo://beta-1/planner',
  prompt: 'check the main branch build and summarise anything red',
  schedule: { everyMs: 3_600_000 },
  taskTtlMs: 900_000,
  notifyPolicy: 'agent-initiated',
}

describe('the dedup key', () => {
  test('is "<jobId>:<fireAtMs>", spelled in one function', () => {
    expect(dedupKeyOf('watch-ci', 1_700_000_000_000)).toBe(
      'watch-ci:1700000000000',
    )
  })

  test('keys on the scheduled instant, so a retry of one slot keeps one key', () => {
    // The failure this pins: keying on the attempt clock would mint a fresh key
    // for every retry, which is indistinguishable from having no key at all.
    const scheduled = 1_700_000_000_000
    expect(dedupKeyOf('watch-ci', scheduled)).toBe(
      dedupKeyOf('watch-ci', scheduled),
    )
    expect(dedupKeyOf('watch-ci', scheduled)).not.toBe(
      dedupKeyOf('watch-ci', scheduled + 1),
    )
  })
})

describe('job validation', () => {
  test('accepts a well-formed job and freezes it', () => {
    const job = assertJob(VALID)
    expect(job.id).toBe('watch-ci')
    expect(job.target).toBe('qianmo://beta-1/planner')
    expect(job.schedule.everyMs).toBe(3_600_000)
    expect(job.schedule.anchorMs).toBeUndefined()
    expect(Object.isFrozen(job)).toBe(true)
    expect(Object.isFrozen(job.schedule)).toBe(true)
  })

  test('rejects a non-finite or non-positive everyMs', () => {
    for (const everyMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => assertJob({ ...VALID, schedule: { everyMs } })).toThrow()
    }
  })

  test('rejects a non-finite or non-positive taskTtlMs', () => {
    for (const taskTtlMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '5m',
    ]) {
      expect(() => assertJob({ ...VALID, taskTtlMs })).toThrow()
    }
  })

  test('rejects a target that is not a qianmo address', () => {
    for (const target of [
      'https://beta-1/planner',
      'qianmo://beta-1',
      'qianmo://beta-1/planner/extra',
      'qianmo://BETA-1/planner',
      42,
    ]) {
      expect(() => assertJob({ ...VALID, target })).toThrow()
    }
  })

  test('rejects a job id that would traverse out of the claim directory', () => {
    // The id is both the contextId and a directory name; a separator in it is a
    // path traversal wearing a schedule entry's clothes.
    for (const id of ['../escape', 'a/b', '..', '', 'x:y', 'has space']) {
      expect(() => assertJob({ ...VALID, id })).toThrow()
    }
  })

  test('rejects a prompt that cannot fit in one envelope', () => {
    // Caught at registration because it would otherwise fail identically on
    // every fire, forever, into a channel that is silent by design.
    const prompt = 'x'.repeat(LIMITS.maxMessageBytes + 1)
    expect(() => assertJob({ ...VALID, prompt })).toThrow()
  })

  test('rejects an unknown notify policy and accepts every declared one', () => {
    expect(() => assertJob({ ...VALID, notifyPolicy: 'loud' })).toThrow()
    for (const notifyPolicy of NOTIFY_POLICIES) {
      expect(assertJob({ ...VALID, notifyPolicy }).notifyPolicy).toBe(
        notifyPolicy,
      )
    }
  })

  test('does not default taskTtlMs to the protocol number', () => {
    // §4.1 point 4: the job names its own deadline. A default here would be the
    // node quietly inheriting a five-minute budget for a twenty-minute job.
    const { taskTtlMs: _omitted, ...withoutTtl } = VALID
    expect(() => assertJob(withoutTtl)).toThrow()
    expect(assertJob(VALID).taskTtlMs).not.toBe(LIMITS.defaultTaskTtlMs)
  })
})
