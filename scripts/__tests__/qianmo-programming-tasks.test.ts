// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts/qianmo-programming-tasks.ts')
const RESULT_SCHEMA = 'qianmo.p32.task-result.v1'
const directories: string[] = []

function environment(
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return env
}

function invoke(
  args: readonly string[],
  overrides: Record<string, string | undefined>,
): {
  readonly exitCode: number
  readonly stdout: string
  readonly result: Record<string, unknown>
  readonly report: Record<string, unknown>
} {
  const output = mkdtempSync(join(tmpdir(), 'qianmo-p32-contract-'))
  directories.push(output)
  const child = Bun.spawnSync(
    [process.execPath, 'run', SCRIPT, ...args, '--output-dir', output],
    {
      cwd: REPO_ROOT,
      env: environment(overrides),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdout = child.stdout.toString()
  const result = JSON.parse(stdout) as Record<string, unknown>
  const artifactsRoot = result['artifactsRoot']
  if (typeof artifactsRoot !== 'string')
    throw new Error('missing artifactsRoot')
  const report = JSON.parse(
    readFileSync(join(artifactsRoot, 'report.json'), 'utf8'),
  ) as Record<string, unknown>
  return { exitCode: child.exitCode, stdout, result, report }
}

function expectFailure(run: ReturnType<typeof invoke>, code: string): void {
  expect(run.exitCode).toBe(1)
  for (const result of [run.result, run.report]) {
    expect(result['schemaVersion']).toBe(RESULT_SCHEMA)
    expect(result['failure']).toMatchObject({ code })
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('P3.2 task result contract', () => {
  test('unknown tasks produce a deterministic report without leaking provider input', () => {
    const secret = 'p32-contract-secret-that-must-not-appear'
    const run = invoke(['--tasks', 'does-not-exist'], {
      ANTHROPIC_API_KEY: secret,
      ANTHROPIC_BASE_URL: 'https://provider.invalid',
    })

    expectFailure(run, 'UNKNOWN_TASK')
    expect(run.stdout).not.toContain(secret)
    expect(JSON.stringify(run.report)).not.toContain(secret)
  })

  test('missing credentials use the same structured failure envelope', () => {
    const run = invoke(['--tasks', 'protocol-agent-of'], {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
    })

    expectFailure(run, 'MISSING_PROVIDER_CREDENTIAL')
  })
})
