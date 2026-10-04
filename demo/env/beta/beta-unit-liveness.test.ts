// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * H 腿那两个单元的状态与现实脱节时，谁来说话（issue #64）。
 *
 * 2026-08-24 真机腿实测：`systemctl --user is-active qianmo-console.service` 答
 * `inactive`（rc=3），而同一时刻 `/v0/health` 200、38621 LISTEN、进程已跑 6539 s；
 * 同机四条 `qianmo-tunnel@<节点>.service` 全是 `active`。差别是 `Type=exec`（隧道）
 * 对 `Type=oneshot` + `RemainAfterExit=yes`（这两个），不是 user scope。
 *
 * 这里钉两件事，第二件比第一件重要：
 *
 * ① **两个方向各有一句话**。`inactive` 而进程活着 = beta-up.sh 只 enable 不 start 的
 *    正常形态；`active` 而进程答不出话 = oneshot + RemainAfterExit 的固有形状。
 * ② **一致时一个字都不说，且任何时候都不下 FAIL 判定**。少了这一条，本包最常见的
 *    正常形态（inactive + 进程活着）会在每次自检里变成一条噪音甚至一条红——那正是把
 *    「状态查出来是错的」换成「自检查出来是错的」，没有变好。
 *
 * 另钉单元模板里那句话真的在 `Description=` 上：那是 `systemctl status` 与
 * `list-units` 会打出来的唯一一行，也就是查到错答案的人唯一会看到的地方。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')
const COMMON = join(BETA_DIR, 'common.sh')

/** 问一次 `beta_unit_state_note`；返回它打出来的那段话（一致时是空串）。 */
function note(unit: string, state: string, alive: '0' | '1'): string {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        'set -euo pipefail',
        '. "$1"',
        'shift',
        'beta_unit_state_note "$@"',
      ].join('\n'),
      'beta-unit-liveness-test',
      COMMON,
      unit,
      state,
      alive,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  expect(child.exitCode).toBe(0)
  expect(child.stderr.toString()).toBe('')
  return child.stdout.toString()
}

describe('单元状态与现实脱节时说什么', () => {
  const UNIT = 'qianmo-console.service'

  test('inactive 而进程活着：说清这是正常形态，并点名 /v0/health', () => {
    const text = note(UNIT, 'inactive', '1')
    expect(text).toContain(UNIT)
    expect(text).toContain('这是正常形态，不是故障')
    expect(text).toContain('只 enable 不 start')
    expect(text).toContain('/v0/health')
  })

  test('active 而进程答不出话：归因到 oneshot + RemainAfterExit', () => {
    const text = note(UNIT, 'active', '0')
    expect(text).toContain('RemainAfterExit')
    expect(text).toContain('/v0/health')
  })

  test('两者一致时一个字都不说 —— 正常状态不该产生噪音', () => {
    expect(note(UNIT, 'active', '1')).toBe('')
    expect(note(UNIT, 'inactive', '0')).toBe('')
  })

  test('查不到状态（systemctl 什么都没回）算「不是 active」，仍然解释一句', () => {
    const text = note(UNIT, '', '1')
    expect(text).toContain('未知')
    expect(text).toContain('/v0/health')
  })
})

describe('单元模板把这句话放在会被看到的地方', () => {
  test('两个模板的 Description 都写明状态不是存活判据', () => {
    for (const base of ['qianmo-console.service', 'qianmo-registry.service']) {
      const text = readFileSync(join(BETA_DIR, 'ops', `${base}.in`), 'utf8')
      const description = text
        .split('\n')
        .find(line => line.startsWith('Description='))
      expect(description).toBeDefined()
      expect(description).toContain('NOT a liveness signal')
      expect(description).toContain('/v0/health')
    }
  })
})

describe('beta-smoke.sh 用 /v0/health 而不是单元状态判这两个进程', () => {
  const smoke = readFileSync(join(BETA_DIR, 'beta-smoke.sh'), 'utf8')

  test('①③ 两项各自把 host_unit_note 挂在两条分支上', () => {
    expect(smoke).toContain('host_unit_note "$BETA_REGISTRY_UNIT" 1')
    expect(smoke).toContain('host_unit_note "$BETA_REGISTRY_UNIT" 0')
    expect(smoke).toContain('host_unit_note "$BETA_CONSOLE_UNIT" 1')
    expect(smoke).toContain('host_unit_note "$BETA_CONSOLE_UNIT" 0')
  })

  test('host_unit_note 里没有 fail_item —— 它解释，不判定', () => {
    const body = smoke.slice(
      smoke.indexOf('host_unit_note() {'),
      smoke.indexOf('run_host() {'),
    )
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain('fail_item')
  })
})
