// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `beta_stop_link` 必须停掉**任何没停下来的**链路单元，不只是此刻恰好 `active` 的。
 *
 * 2026-09-26 在 H 上清三条指向已终止机器的隧道：`beta-down.sh beta-1 beta-2 beta-3`
 * 报告三条都「已取消开机自启」，其中 beta-2 却没有「已停止」——它在那一刻处于
 * `activating`（`Restart=always` 的退避里），旧写法只认 `active`，于是它被取消了自启、
 * 却继续每几秒重启一次、继续往 journald 里刷。一条死隧道一天到晚几乎都在 `activating`，
 * 所以这不是小概率，是常态。
 *
 * `systemctl` 用 PATH 上的桩代替：`is-active` 按环境变量答状态，其余动作记进日志。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const COMMON = resolve(import.meta.dir, 'common.sh')
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function stopLink(state: string, enabled = 'enabled'): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'beta-stop-link-'))
  dirs.push(dir)
  const log = join(dir, 'systemctl.log')
  writeFileSync(log, '')
  writeFileSync(
    join(dir, 'systemctl'),
    [
      '#!/usr/bin/env bash',
      'echo "$*" >> "$STUB_LOG"',
      'case "$2" in',
      '  show-environment) exit 0 ;;',
      '  is-active) echo "$STUB_STATE"; [ "$STUB_STATE" = active ] ;;',
      '  is-enabled) echo "$STUB_ENABLED"; [ "$STUB_ENABLED" = enabled ] ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(join(dir, 'systemctl'), 0o755)
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      ['set -euo pipefail', '. "$1"', 'beta_stop_link beta-2'].join('\n'),
      'beta-stop-link-test',
      COMMON,
    ],
    {
      env: {
        PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: dir,
        QIANMO_BETA_ROOT: join(dir, 'root'),
        STUB_LOG: log,
        STUB_STATE: state,
        STUB_ENABLED: enabled,
      },
    },
  )
  expect(child.stderr.toString()).toBe('')
  expect(child.exitCode).toBe(0)
  return readFileSync(log, 'utf8').trim().split('\n')
}

describe('beta_stop_link', () => {
  test.each([
    'active',
    'activating',
    'deactivating',
    'reloading',
  ])('单元处在 %s：隧道与镜像 timer 都被 stop', state => {
    const calls = stopLink(state)
    expect(calls).toContain('--user stop qianmo-tunnel@beta-2.service')
    expect(calls).toContain('--user stop qianmo-mirror@beta-2.timer')
  })

  test.each(['inactive', 'failed'])('单元已经是 %s：不 stop', state => {
    const calls = stopLink(state)
    expect(calls.some(call => call.includes(' stop '))).toBe(false)
  })

  test('自启着的一律取消自启，与在不在跑无关', () => {
    const calls = stopLink('inactive', 'enabled')
    expect(calls).toContain('--user disable qianmo-tunnel@beta-2.service')
    expect(calls).toContain('--user disable qianmo-mirror@beta-2.timer')
  })
})
