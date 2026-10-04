// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  DIAGNOSIS_SCHEMA,
  FAILURE_CAUSES,
  FailureCause,
  SUGGESTED_ACTIONS,
  classifyFailure,
  diagnose,
  isNamedCause,
  observationFromTaskResult,
} from '../src/index.js'

describe('the 137 problem', () => {
  test('a killed process alone is not a diagnosis', () => {
    // Exit 137 says SIGKILL and nothing else. Naming a cause from it would be
    // a coin flip between timeout and OOM.
    const diagnosis = classifyFailure({ exitCode: 137, stderr: '' })
    expect(diagnosis.cause).toBe(FailureCause.Unknown)
    expect(diagnosis.evidence.join(' ')).toContain('137')
  })

  test('the same exit code is a timeout when the enforcer says so', () => {
    const diagnosis = classifyFailure({
      exitCode: 137,
      timeoutEnforced: true,
      timeoutMs: 5_000,
      durationMs: 5_002,
    })
    expect(diagnosis.cause).toBe(FailureCause.Timeout)
    expect(diagnosis.confidence).toBe('high')
  })

  test('and an OOM when the kernel counter moved', () => {
    const diagnosis = classifyFailure({ exitCode: 137, oomKillDelta: 1 })
    expect(diagnosis.cause).toBe(FailureCause.OutOfMemory)
    expect(diagnosis.confidence).toBe('high')
  })

  test('both at once resolves to OOM, with the timeout kept as an alternative', () => {
    // Raising the deadline would change nothing here; raising the ceiling might.
    const diagnosis = classifyFailure({
      exitCode: 137,
      oomKillDelta: 2,
      timeoutEnforced: true,
      timeoutMs: 1_000,
      durationMs: 1_100,
    })
    expect(diagnosis.cause).toBe(FailureCause.OutOfMemory)
    expect(diagnosis.alternatives).toContain(FailureCause.Timeout)
  })

  test('SIGKILL that our supervisor did not send reads as OOM', () => {
    // Measured while building P5.1's injector: a Bun process that exhausts
    // memory is killed by the OS having written **nothing at all** — no exit
    // code of its own, no stderr. The only thing left to reason from is that we
    // did not send the signal.
    const diagnosis = classifyFailure({
      exitCode: null,
      signal: 'SIGKILL',
      timeoutEnforced: false,
      stderr: '',
      durationMs: 3_000,
    })
    expect(diagnosis.cause).toBe(FailureCause.OutOfMemory)
    // Medium, not high: an operator's `kill -9` is indistinguishable. The
    // high-confidence answer is `oomKillDelta`, which needs cgroup v2.
    expect(diagnosis.confidence).toBe('medium')
  })

  test('the same kill with the kernel counter present is high confidence', () => {
    const diagnosis = classifyFailure({
      exitCode: null,
      signal: 'SIGKILL',
      timeoutEnforced: false,
      oomKillDelta: 1,
    })
    expect(diagnosis.cause).toBe(FailureCause.OutOfMemory)
    expect(diagnosis.confidence).toBe('high')
  })

  test('a SIGKILL we did send is never re-read as an OOM', () => {
    const diagnosis = classifyFailure({
      exitCode: 137,
      timeoutEnforced: true,
      timeoutMs: 200,
      durationMs: 205,
    })
    expect(diagnosis.cause).toBe(FailureCause.Timeout)
    expect(diagnosis.alternatives).not.toContain(FailureCause.OutOfMemory)
  })

  test('a deadline reached with nobody claiming the kill is a low-confidence timeout', () => {
    const diagnosis = classifyFailure({
      exitCode: 137,
      timeoutMs: 1_000,
      durationMs: 1_500,
    })
    expect(diagnosis.cause).toBe(FailureCause.Timeout)
    expect(diagnosis.confidence).toBe('low')
  })
})

describe('the other three causes', () => {
  test('exit 127 is a missing dependency without reading anything', () => {
    const diagnosis = classifyFailure({ exitCode: 127 })
    expect(diagnosis.cause).toBe(FailureCause.MissingDependency)
    expect(diagnosis.confidence).toBe('high')
  })

  test('a 429 is quota exhaustion, and names the service', () => {
    const diagnosis = classifyFailure({
      exitCode: 1,
      httpStatus: 429,
      service: 'provider-a',
    })
    expect(diagnosis.cause).toBe(FailureCause.QuotaExhausted)
    expect(diagnosis.evidence.join(' ')).toContain('provider-a')
  })

  test('ENOSPC in the output is disk full', () => {
    const diagnosis = classifyFailure({
      exitCode: 1,
      stderr: "Error: ENOSPC: no space left on device, write 'fill'",
    })
    expect(diagnosis.cause).toBe(FailureCause.DiskFull)
  })

  test('a module that will not resolve is a missing dependency', () => {
    const diagnosis = classifyFailure({
      exitCode: 1,
      stderr: "Error: Cannot find module 'left-pad'",
    })
    expect(diagnosis.cause).toBe(FailureCause.MissingDependency)
  })

  test('a heap death is an OOM even with no kernel counter', () => {
    // Node kills itself before the kernel gets involved, so `oomKillDelta`
    // stays zero and the text is the only evidence there is.
    const diagnosis = classifyFailure({
      exitCode: 134,
      stderr:
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    })
    expect(diagnosis.cause).toBe(FailureCause.OutOfMemory)
    expect(diagnosis.confidence).toBe('medium')
  })
})

describe('what the classifier refuses to do', () => {
  test('a missing input file is not called a missing dependency', () => {
    // ENOENT is what any task gets for opening any missing file. A rule broad
    // enough to catch it would mislabel most ordinary failures.
    const diagnosis = classifyFailure({
      exitCode: 1,
      stderr: "Error: ENOENT: no such file or directory, open 'data/input.csv'",
    })
    expect(diagnosis.cause).toBe(FailureCause.Unknown)
  })

  test('an ordinary test failure stays unknown rather than being named', () => {
    const diagnosis = classifyFailure({
      exitCode: 1,
      stderr: 'expect(received).toBe(expected)\n\n  Expected: 2\n  Received: 3',
    })
    expect(diagnosis.cause).toBe(FailureCause.Unknown)
    expect(isNamedCause(diagnosis.cause)).toBe(false)
    expect(diagnosis.suggestedAction).toBe(
      SUGGESTED_ACTIONS[FailureCause.Unknown],
    )
  })

  test('every cause has an action, including unknown', () => {
    for (const cause of FAILURE_CAUSES) {
      expect(SUGGESTED_ACTIONS[cause].length).toBeGreaterThan(20)
    }
  })

  test('a diagnosis always carries the evidence it used', () => {
    for (const observation of [
      { exitCode: 127 },
      { exitCode: 1, httpStatus: 429 },
      { exitCode: 1, stderr: 'ENOSPC' },
      { exitCode: 0 },
    ]) {
      expect(classifyFailure(observation).evidence.length).toBeGreaterThan(0)
    }
  })
})

describe('the event and the P3.2 bridge', () => {
  test('diagnose wraps the verdict with a schema and a clock', () => {
    const event = diagnose(
      { exitCode: 127 },
      { at: 1_800_000_000_000, taskId: 'task-9' },
    )
    expect(event.schema).toBe(DIAGNOSIS_SCHEMA)
    expect(event.at).toBe(1_800_000_000_000)
    expect(event.taskId).toBe('task-9')
    expect(event.cause).toBe(FailureCause.MissingDependency)
  })

  test('the bridge takes the first non-zero exit code, not the last', () => {
    // The agent runs before the tests; if the agent died, the test exit code
    // describes a run that never happened.
    const observation = observationFromTaskResult({
      agentExitCode: 127,
      testExitCode: 1,
      failure: { phase: 'agent', code: 'E_AGENT', message: 'agent exited 127' },
    })
    expect(observation.exitCode).toBe(127)
    expect(classifyFailure(observation).cause).toBe(
      FailureCause.MissingDependency,
    )
  })

  test('a clean agent with failing tests keeps the test exit code', () => {
    const observation = observationFromTaskResult({
      agentExitCode: 0,
      testExitCode: 1,
      failure: { phase: 'verification', code: 'E_TESTS', message: 'red' },
    })
    expect(observation.exitCode).toBe(1)
  })

  test('captured logs are folded in and the phase is carried as context', () => {
    const observation = observationFromTaskResult(
      {
        agentExitCode: 1,
        testExitCode: null,
        failure: { phase: 'agent', code: 'E_RUN', message: 'see the log' },
      },
      { agentOutput: 'RateLimitError: quota exceeded for this key' },
    )
    expect(observation.context?.['phase']).toBe('agent')
    expect(classifyFailure(observation).cause).toBe(FailureCause.QuotaExhausted)
  })
})
