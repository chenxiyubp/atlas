// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 服务器归属 —— `beta_peer_server` 与它的校验器。
 *
 * 为什么这件事需要脚本代劳：走隧道的节点在名册上的端点是 `ws://127.0.0.1:386xx`，四个
 * 节点长得几乎一样，而它们其实分散在四台机器上。「这个节点在哪台机器上」只有 peers.conf
 * 知道（坐标行的 host=），控制台看不到。
 *
 * 判定不出来时必须**降级**而不是猜：运维照着一个猜出来的机器名去查，比没有归属更贵。
 * 下面每一条负向用例钉的都是这个方向。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const COMMON = 'demo/env/beta/common.sh'
const roots: string[] = []

function root(peers: readonly string[]): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-server-'))
  roots.push(value)
  mkdirSync(join(value, 'secrets', 'peers'), { recursive: true })
  writeFileSync(join(value, 'peers.conf'), `${peers.join('\n')}\n`, {
    mode: 0o600,
  })
  return value
}

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** source common.sh 后跑几行 bash，拿 stdout / rc。 */
function run(betaRoot: string, lines: readonly string[]): ShellResult {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      ['set -uo pipefail', '. "$1"', 'shift', ...lines].join('\n'),
      'beta-server-attribution-test',
      COMMON,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        QIANMO_BETA_ROOT: betaRoot,
        // hostname 的回退分支要可预期，否则用例结果跟着开发机的机器名走。
        PATH: `${join(REPOSITORY_ROOT, 'demo/env/beta')}:${process.env['PATH'] ?? ''}`,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode ?? -1,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString(),
  }
}

function server(betaRoot: string, node: string): ShellResult {
  return run(betaRoot, ['beta_load_peers', `beta_peer_server ${node}`])
}

afterAll(() => {
  for (const one of roots) rmSync(one, { recursive: true, force: true })
})

describe('beta_peer_server', () => {
  test('有坐标行时用 host=', () => {
    const place = root([
      'node beta-1 user=ops host=203.0.113.7 local-port=38631',
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
    ])
    const got = server(place, 'beta-1')
    expect(got.exitCode).toBe(0)
    expect(got.stdout).toBe('203.0.113.7')
  })

  test('server= 覆盖 host= —— 稳定短名不跟着 IP 变', () => {
    const place = root([
      'node beta-1 user=ops host=203.0.113.7 local-port=38631 server=p11',
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
    ])
    expect(server(place, 'beta-1').stdout).toBe('p11')
  })

  test('没有坐标行时取端点里的主机名', () => {
    const place = root(['qianmo://beta-9/planner ws://node9.example:38625'])
    expect(server(place, 'beta-9').stdout).toBe('node9.example')
  })

  test('IPv6 端点剥掉方括号', () => {
    const place = root(['qianmo://beta-9/planner ws://[2001:db8::5]:38625'])
    expect(server(place, 'beta-9').stdout).toBe('2001:db8::5')
  })

  test('端点是回环时取本机 hostname —— 报 127.0.0.1 等于什么都没说', () => {
    const place = root(['qianmo://beta-4/planner ws://127.0.0.1:38625'])
    const got = server(place, 'beta-4')
    expect(got.exitCode).toBe(0)
    // 不钉具体值（跟着开发机走），钉「不是回环地址」这件事。
    expect(got.stdout).not.toBe('127.0.0.1')
    expect(got.stdout.length).toBeGreaterThan(0)
  })

  test('名册上没有的节点：返回 1，不打印', () => {
    const place = root(['qianmo://beta-1/planner ws://203.0.113.7:38625'])
    const got = server(place, 'beta-nope')
    expect(got.exitCode).toBe(1)
    expect(got.stdout).toBe('')
  })
})

describe('server= 的校验（坏值必须当场拦下，不能进控制台命令行）', () => {
  const bad: readonly (readonly [string, string])[] = [
    ['空值', 'server='],
    ['带斜杠', 'server=a/b'],
    ['带空格会被分词成未知键', 'server=a b'],
    ['超长', `server=${'x'.repeat(65)}`],
    ['带引号', 'server=a"b'],
    ['带分号', 'server=a;b'],
  ]
  for (const [why, kv] of bad) {
    test(`拒绝：${why}`, () => {
      const place = root([
        `node beta-1 user=ops host=203.0.113.7 local-port=38631 ${kv}`,
        'qianmo://beta-1/planner ws://127.0.0.1:38631',
      ])
      const got = run(place, ['beta_load_peers', 'echo UNREACHED'])
      expect(got.exitCode).not.toBe(0)
      expect(got.stdout).not.toContain('UNREACHED')
    })
  }

  test('合法值放行：短名、IPv4、IPv6、带点和下划线', () => {
    for (const good of ['p11', '203.0.113.7', '2001:db8::5', 'a_b.c-d']) {
      const place = root([
        `node beta-1 user=ops host=203.0.113.7 local-port=38631 server=${good}`,
        'qianmo://beta-1/planner ws://127.0.0.1:38631',
      ])
      expect(server(place, 'beta-1').stdout).toBe(good)
    }
  })
})

describe('local-server —— 本机也要有个名字', () => {
  test('回环端点用 local-server 给的名字，而不是 hostname', () => {
    const place = root([
      'local-server p11',
      'qianmo://beta-4/planner ws://127.0.0.1:38625',
    ])
    const got = server(place, 'beta-4')
    expect(got.exitCode).toBe(0)
    expect(got.stdout).toBe('p11')
  })

  test('只作用于回环 —— 远端节点仍走 host=', () => {
    const place = root([
      'local-server p11',
      'node beta-1 user=ops host=203.0.113.7 local-port=38631',
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
      'qianmo://beta-4/planner ws://127.0.0.1:38625',
    ])
    expect(server(place, 'beta-1').stdout).toBe('203.0.113.7')
    expect(server(place, 'beta-4').stdout).toBe('p11')
  })

  test('给两次是笔误，当场拦下 —— 两个名字里生效哪个说不清', () => {
    const place = root([
      'local-server p11',
      'local-server p12',
      'qianmo://beta-4/planner ws://127.0.0.1:38625',
    ])
    const got = run(place, ['beta_load_peers', 'echo UNREACHED'])
    expect(got.exitCode).not.toBe(0)
    expect(got.stdout).not.toContain('UNREACHED')
  })

  test('多余字段是笔误，不静默吃掉', () => {
    const place = root([
      'local-server p11 还有别的',
      'qianmo://beta-4/planner ws://127.0.0.1:38625',
    ])
    const got = run(place, ['beta_load_peers', 'echo UNREACHED'])
    expect(got.exitCode).not.toBe(0)
    expect(got.stdout).not.toContain('UNREACHED')
  })

  test('坏名字走同一个校验器', () => {
    for (const bad of ['a/b', 'a;b', 'x'.repeat(65)]) {
      const place = root([
        `local-server ${bad}`,
        'qianmo://beta-4/planner ws://127.0.0.1:38625',
      ])
      const got = run(place, ['beta_load_peers', 'echo UNREACHED'])
      expect(got.exitCode).not.toBe(0)
      expect(got.stdout).not.toContain('UNREACHED')
    }
  })

  test('空值也是笔误 —— 不能退回 hostname 装作没写过', () => {
    const place = root([
      'local-server',
      'qianmo://beta-4/planner ws://127.0.0.1:38625',
    ])
    const got = run(place, ['beta_load_peers', 'echo UNREACHED'])
    expect(got.exitCode).not.toBe(0)
    expect(got.stdout).not.toContain('UNREACHED')
  })
})
