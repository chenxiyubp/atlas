// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_ROOT = join(import.meta.dir, '..')
const SOURCE_ROOT = join(PACKAGE_ROOT, 'src')
const REPOSITORY_ROOT = join(PACKAGE_ROOT, '..', '..')
const ACCEPTANCE_SCRIPT = join(REPOSITORY_ROOT, 'demo', 'ac6a-sandbox.sh')

function source(): string {
  return readdirSync(SOURCE_ROOT)
    .filter(name => name.endsWith('.ts'))
    .sort()
    .map(name => readFileSync(join(SOURCE_ROOT, name), 'utf8'))
    .join('\n')
}

function forbiddenCapabilities(text: string): string[] {
  const rules: readonly [string, RegExp][] = [
    [
      'process execution',
      /node:child_process|\bspawnSync?\s*\(|\bexecFileSync?\s*\(/,
    ],
    ['network client', /\bfetch\s*\(|node:(?:http|https|net)/],
    ['daemon bearer', /QIANMO_SANDBOX_DAEMON_TOKEN/],
    ['host control socket', /docker\.sock|containerd\.sock/],
    ['daemon execution RPC', /execCommand/],
    ['destructive RPC', /destroySandbox/],
  ]
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}

describe('the reusable boundary package has no host control capability', () => {
  test('the scan has source files', () => {
    expect(
      readdirSync(SOURCE_ROOT).filter(name => name.endsWith('.ts')).length,
    ).toBe(4)
  })

  test('source can only validate and persist injected evidence', () => {
    expect(forbiddenCapabilities(source())).toEqual([])
  })

  test('red direction catches every prohibited capability class', () => {
    const fixture = [
      "import { execFileSync } from 'node:child_process'",
      "fetch('http://127.0.0.1')",
      'QIANMO_SANDBOX_DAEMON_TOKEN',
      '/var/run/docker.sock',
      "rpc('execCommand')",
      "rpc('destroySandbox')",
    ].join('\n')
    expect(forbiddenCapabilities(fixture)).toEqual([
      'process execution',
      'network client',
      'daemon bearer',
      'host control socket',
      'daemon execution RPC',
      'destructive RPC',
    ])
  })
})

describe('the real-machine acceptance entrypoint fails closed', () => {
  test('passes shell syntax validation', () => {
    const result = spawnSync('bash', ['-n', ACCEPTANCE_SCRIPT], {
      encoding: 'utf8',
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  test('missing deployment input is an error, not a skipped acceptance', () => {
    const result = spawnSync('bash', [ACCEPTANCE_SCRIPT], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('QIANMO_SANDBOX_DAEMON_URL')
  })
})
