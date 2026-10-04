// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 节点腿在起 resident 之前把自己的 oom_score_adj 调高（`beta_raise_oom_score`）。
 *
 * 内测节点借住在别人的机器上：同机跑着代理、nginx 与别的服务，内存 1~2 GB，一个 agent
 * 轮次峰值约 370 MB。内存打满时内核按 oom_score 挑进程，不调的话被挑中的可能是那台
 * 机器的主业。这里钉：默认 1000、`off` 可关、非法值拒绝、写不进去只 WARN 不拦节点，
 * 以及 beta-up.sh 真的在 `beta_start_process` 之前调它（子进程继承这个值）。
 *
 * 大部分格子把写入目标换成临时文件（`BETA_OOM_ADJ_PATH`），所以在 macOS 上也跑；
 * 真 /proc 那一格只在 Linux 上跑。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BETA_DIR = import.meta.dir
const COMMON = resolve(BETA_DIR, 'common.sh')
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function raise(
  value: string | undefined,
  options: { target?: 'file' | 'unwritable' | 'proc' } = {},
): { code: number; stdout: string; stderr: string; written: string } {
  const dir = mkdtempSync(join(tmpdir(), 'beta-oom-'))
  dirs.push(dir)
  const target = options.target ?? 'file'
  const file = join(dir, 'oom_score_adj')
  writeFileSync(file, '0\n')
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    QIANMO_BETA_ROOT: join(dir, 'root'),
  }
  if (value !== undefined) env.QIANMO_BETA_OOM_SCORE_ADJ = value
  if (target === 'file') env.BETA_OOM_ADJ_PATH = file
  if (target === 'unwritable') {
    env.BETA_OOM_ADJ_PATH = join(dir, 'no-such-dir', 'oom_score_adj')
  }
  const script =
    target === 'proc'
      ? '. "$1"; beta_raise_oom_score; printf "now=%s\\n" "$(cat /proc/self/oom_score_adj)"'
      : '. "$1"; beta_raise_oom_score'
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      `set -euo pipefail\n${script}`,
      'beta-oom-test',
      COMMON,
    ],
    { env },
  )
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    written: readFileSync(file, 'utf8'),
  }
}

describe('beta_raise_oom_score', () => {
  test('默认写 1000', () => {
    const result = raise(undefined)
    expect(result.code).toBe(0)
    expect(result.written).toBe('1000\n')
    expect(result.stdout).toContain('oom_score_adj=1000')
  })

  test('显式给一个 0~1000 的值就写那个值', () => {
    expect(raise('900').written).toBe('900\n')
  })

  test('off：一个字节都不写，并说一句', () => {
    const result = raise('off')
    expect(result.code).toBe(0)
    expect(result.written).toBe('0\n')
    expect(result.stdout).toContain('未调整')
  })

  test.each(['abc', '1001', '-5'])('非法值「%s」拒绝', value => {
    const result = raise(value)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('QIANMO_BETA_OOM_SCORE_ADJ')
    expect(result.written).toBe('0\n')
  })

  test('空串与没给一样，取默认 1000（与其余 QIANMO_BETA_* 同一个约定）', () => {
    expect(raise('').written).toBe('1000\n')
  })

  test('写不进去只 WARN，不拦节点起来', () => {
    const result = raise(undefined, { target: 'unwritable' })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('WARN')
  })

  test.skipIf(!existsSync('/proc/self/oom_score_adj'))(
    '真 /proc：同一个 shell 之后起的子进程继承 1000',
    () => {
      const result = raise(undefined, { target: 'proc' })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('now=1000')
    },
  )
})

describe('beta-up.sh 的节点腿', () => {
  test('在起 resident 的那一行之前调 beta_raise_oom_score', () => {
    const text = readFileSync(resolve(BETA_DIR, 'beta-up.sh'), 'utf8')
    const start = text.indexOf('beta_start_process "$BETA_NODE"')
    expect(start).toBeGreaterThan(0)
    const before = text.slice(0, start)
    const raiseAt = before.lastIndexOf('beta_raise_oom_score')
    expect(raiseAt).toBeGreaterThan(before.lastIndexOf('run_node() {'))
    // 中间不能再夹一次起进程：继承关系只对「之后」起的子进程成立。
    expect(before.slice(raiseAt)).not.toContain('beta_start_process')
  })
})
