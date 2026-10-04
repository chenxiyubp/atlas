// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const PROBE = join(REPO_ROOT, 'scripts/qianmo-policy-switch-probes.ts')
const BETA_SMOKE = join(REPO_ROOT, 'demo/env/beta/beta-smoke.sh')
const S3_SCRIPTS = [
  'demo/env/smoke.sh',
  'demo/ac3-loop-rate.sh',
  'make -C demo p61-smoke',
  'demo/env/beta/beta-smoke.sh',
] as const
const RESIDENT_LAUNCHERS = [
  'demo/env/up.sh',
  'demo/env/remote/prepare-sandbox.sh',
  'demo/env/beta/beta-up.sh',
] as const

interface Criterion {
  readonly id: string
  readonly verdict: string
  readonly reason: string
  readonly detail?: Record<string, unknown>
}

interface Report {
  readonly criteria: readonly Criterion[]
}

const directories: string[] = []

function runProbe(
  args: readonly string[],
  env?: Record<string, string | undefined>,
): {
  readonly exitCode: number
  readonly report: Report
} {
  const result = Bun.spawnSync(
    [process.execPath, 'run', PROBE, '--nodes', '2', ...args],
    { cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    exitCode: result.exitCode,
    report: JSON.parse(result.stdout.toString()) as Report,
  }
}

function criterion(report: Report, id: string): Criterion {
  const found = report.criteria.find(one => one.id === id)
  if (found === undefined) throw new Error(`missing criterion ${id}`)
  return found
}

function optionLines(path: string): readonly string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('P12.4 policy switch deployment contract', () => {
  test('every real resident launcher keeps the phase-one flags paired once', () => {
    for (const launcher of RESIDENT_LAUNCHERS) {
      const lines = optionLines(join(REPO_ROOT, launcher))
      for (const flag of ['--open-policy', '--audit-signed-tasks']) {
        expect(
          lines.filter(line =>
            new RegExp(`^\\s*${flag}(?:\\s|\\\\|$)`).test(line),
          ).length,
        ).toBe(1)
      }
    }
  })

  test('beta smoke sends a task request for phase-one observation', () => {
    expect(readFileSync(BETA_SMOKE, 'utf8')).toMatch(/--task\s+"\$addr"/)
  })

  test('missing S-3 evidence remains not-collected and fails the process', () => {
    const result = runProbe([])
    const s3 = criterion(result.report, 'S-3')

    expect(result.exitCode).toBe(1)
    expect(s3.verdict).toBe('not-collected')
    expect(s3.reason).toContain('§9.2 阶段 ①')
    expect(s3.reason).toContain('--open-policy + --audit-signed-tasks')
    expect(s3.reason).toContain('7 天观察窗口')
    expect(s3.detail?.['requiredScripts']).toEqual(S3_SCRIPTS)
    expect(criterion(result.report, 'S-5').verdict).toBe('pass')
  })

  test('SIGNED_TASK_POLICY evidence without beta-smoke fails S-3', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qianmo-s3-evidence-'))
    directories.push(directory)
    const evidence = join(directory, 's3.json')
    writeFileSync(
      evidence,
      JSON.stringify({
        policy: 'SIGNED_TASK_POLICY',
        results: S3_SCRIPTS.slice(0, -1).map(script => ({ script, ok: true })),
      }),
    )

    const result = runProbe(['--s3-results', evidence])
    const s3 = criterion(result.report, 'S-3')

    expect(result.exitCode).toBe(1)
    expect(s3.verdict).toBe('fail')
    expect(s3.reason).toContain('demo/env/beta/beta-smoke.sh')
    expect(s3.detail?.['missing']).toEqual(['demo/env/beta/beta-smoke.sh'])
  })

  test('wrong policy evidence fails S-3 even when all scripts passed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qianmo-s3-evidence-'))
    directories.push(directory)
    const evidence = join(directory, 's3.json')
    writeFileSync(
      evidence,
      JSON.stringify({
        policy: 'OPEN_POLICY',
        results: S3_SCRIPTS.map(script => ({ script, ok: true })),
      }),
    )

    const result = runProbe(['--s3-results', evidence])
    const s3 = criterion(result.report, 'S-3')

    expect(result.exitCode).toBe(1)
    expect(s3.verdict).toBe('fail')
    expect(s3.reason).toContain('SIGNED_TASK_POLICY')
  })

  test('complete SIGNED_TASK_POLICY evidence passes S-3 but not the full probe', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qianmo-s3-evidence-'))
    directories.push(directory)
    const evidence = join(directory, 's3.json')
    writeFileSync(
      evidence,
      JSON.stringify({
        policy: 'SIGNED_TASK_POLICY',
        results: S3_SCRIPTS.map(script => ({ script, ok: true })),
      }),
    )

    const result = runProbe(['--s3-results', evidence])

    expect(result.exitCode).toBe(1)
    expect(criterion(result.report, 'S-3').verdict).toBe('pass')
    expect(criterion(result.report, 'S-1').verdict).toBe('not-collected')
  })

  test('does not claim the revocation mechanism ran without OpenSSL', () => {
    const result = runProbe([], {
      ...process.env,
      PATH: dirname(process.execPath),
    })
    const s4 = criterion(result.report, 'S-4')

    expect(result.exitCode).toBe(1)
    expect(s4.verdict).toBe('not-collected')
    expect(s4.reason).not.toContain('已就地跑通')
    expect(s4.detail?.['mechanism']).toBeUndefined()
  })

  test('S-4 keeps an authenticated connection through a temporary empty directory', () => {
    const result = runProbe([])
    const mechanism = criterion(result.report, 'S-4').detail?.['mechanism']

    // This machine-level drill is intentionally optional in environments
    // without OpenSSL. Where it can run, the same real signed connection must
    // survive an untrusted empty agents snapshot, then still receive 4003
    // immediately once a fresh signed RL revokes its certificate.
    if (mechanism === undefined) return
    expect(mechanism).toMatchObject({
      temporaryAbsencePermanentlyInvalidated: [],
      connectionsAfterTemporaryAbsence: 1,
      clientClosedAfterTemporaryAbsence: false,
      directoryRestored: true,
      connectionsAfterRevocation: 0,
      channelsAfterRevocation: 0,
      closedWithUnauthorized: true,
      reconnectRejected: true,
      ok: true,
    })
  })
})
