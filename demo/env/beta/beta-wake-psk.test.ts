// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const COMMON = join(REPOSITORY_ROOT, 'demo/env/beta/common.sh')
const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-wake-psk-'))
  roots.push(value)
  mkdirSync(join(value, 'secrets', 'peers'), { recursive: true })
  return value
}

function loadPeerWakePsk(
  root: string,
  node: string,
): {
  readonly exitCode: number
  readonly stdout: string
} {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        'set -euo pipefail',
        '. "$1"',
        'node="$2"',
        'psk_env="$(beta_wake_psk_env "$node")"',
        'export "$psk_env=inherited-stale-psk-that-must-not-survive"',
        'if beta_export_peer_wake_psk "$node"; then loaded=1; else loaded=0; fi',
        `printf "loaded=%s\\nvalue=%s\\n" "$loaded" "\${!psk_env-}"`,
      ].join('\n'),
      'beta-wake-psk-test',
      COMMON,
      node,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        QIANMO_BETA_ROOT: root,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return { exitCode: child.exitCode, stdout: child.stdout.toString() }
}

function validateNode(
  node: string,
  collation?: string,
): {
  readonly exitCode: number
  readonly stderr: string
} {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        '[ "$#" -eq 2 ] || { printf "expected node argv\\n" >&2; exit 99; }',
        '. "$1"',
        'beta_assert_node_name "$2" test',
      ].join('\n'),
      'beta-node-name-test',
      COMMON,
      node,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        ...(collation === undefined
          ? {}
          : { LC_ALL: collation, LC_COLLATE: collation, LANG: collation }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return { exitCode: child.exitCode, stderr: child.stderr.toString() }
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { force: true, recursive: true })
})

describe('beta named wake PSKs', () => {
  test('clears an inherited named PSK when the current peer file is absent', () => {
    const result = loadPeerWakePsk(root(), 'beta-1')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('loaded=0\nvalue=\n')
  })

  test('exports only the current peer file value', () => {
    const value = root()
    writeFileSync(
      join(value, 'secrets', 'peers', 'beta-1.psk'),
      'current-peer-psk-that-replaces-the-inherited-value\n',
    )
    const result = loadPeerWakePsk(value, 'beta-1')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(
      'loaded=1\nvalue=current-peer-psk-that-replaces-the-inherited-value\n',
    )
  })

  test('enforces the protocol node grammar at the shell boundary', () => {
    for (const node of ['a', '0', 'a' + 'b'.repeat(62) + '9']) {
      expect(validateNode(node).exitCode).toBe(0)
    }

    const empty = validateNode('')
    expect(empty.exitCode).toBe(1)
    expect(empty.stderr).toContain('节点名为空')

    for (const node of [
      '-beta',
      'beta-',
      '_beta',
      'beta_',
      'Beta-1',
      'beta.1',
      'a' + 'b'.repeat(64),
    ]) {
      expect(validateNode(node).exitCode).toBe(1)
    }
  })

  // glob 的 `a-z` 是范围，范围端点按 locale 的排序规则解释：en_US.UTF-8 下它展开成
  // aAbBcC…zZ，于是大写节点名整条穿过校验（协议侧的 SEGMENT_PATTERN 按码点比较、
  // 是拒的）。上面那条用例跑在继承来的 locale 里，所以它在哪台机器上是红的取决于
  // 那台机器 —— 这条把 locale 钉死，让「大写不能绕过」在任何 runner 上都成立。
  test('rejects uppercase regardless of the collation locale', () => {
    for (const collation of ['C', 'en_US.UTF-8']) {
      for (const node of ['Beta-1', 'BETA', 'betA', 'be7A-x', 'A']) {
        const result = validateNode(node, collation)
        expect({ collation, node, exitCode: result.exitCode }).toEqual({
          collation,
          node,
          exitCode: 1,
        })
      }
      expect(validateNode('beta-1', collation).exitCode).toBe(0)
    }
  })
})
