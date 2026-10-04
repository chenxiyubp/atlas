// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 页头标签这一格：**存量 `LABEL` 过期时会不会被说出来**，以及 `--help` 有没有说清
 * 它的唯一入口（issue #60）。
 *
 * 病根与 #45 同形。那次清理删掉了 `console.conf` 旧 schema 的三个键并报了很响的警，
 * 却把同一个文件里同样过时的 `LABEL` 原样留下继续沿用：2026-08-24 铺新产物时 H 上
 * 躺着的是单节点时代的「…审计视图：beta-1（…权威副本在节点本机）」，而控制台早已是
 * 四目标形态。标签不影响任何一条链路，所以**没有任何别的东西会为此变红**——一条 WARN
 * 是唯一会说话的地方。
 *
 * 这里钉的重点是**判据的窄**，不是「能报出来」：一条会误报的警等于没有警。所以
 * 「区间写法算提全」「派生默认永不报」「`beta-1` 不算点到 `beta-10`」这三条与
 * 「单节点标签配四节点名册要报」同等重要——现场那份**正确**的标签正是区间写法，
 * 判据宽一格就会每跑一次假警报一次。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')
const COMMON = join(BETA_DIR, 'common.sh')
const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-label-'))
  roots.push(value)
  return value
}

/** 四台机器那份地址表的最小形状：每节点两条地址行，没有 `node` 坐标行（直连）。 */
function peersFile(where: string, nodes: readonly string[]): string {
  const path = join(where, 'peers.conf')
  const lines: string[] = []
  let port = 38631
  for (const node of nodes) {
    lines.push(`qianmo://${node}/${node}   ws://127.0.0.1:${port}`)
    lines.push(`qianmo://${node}/ops      ws://127.0.0.1:${port}`)
    port += 1
  }
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

function bash(
  script: string,
  env: Record<string, string> = {},
): {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
} {
  const child = Bun.spawnSync(['/bin/bash', '-c', script], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, PATH: '/usr/bin:/bin', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

/** 直接问 `beta_label_roster_drift`：`missing <节点>` / `extra <节点>`，一行一条。 */
function drift(label: string, nodes: readonly string[]): readonly string[] {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        'set -euo pipefail',
        '. "$1"',
        'shift',
        'beta_label_roster_drift "$@"',
      ].join('\n'),
      'beta-label-test',
      COMMON,
      label,
      ...nodes,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  expect(child.exitCode).toBe(0)
  return child.stdout
    .toString()
    .split('\n')
    .filter(line => line.length > 0)
}

/** 跑一次真的 `beta_resolve_console_conf`，返回它的 WARN 与回写后的 console.conf。 */
function resolveConsoleConf(
  where: string,
  nodes: readonly string[],
  options: { readonly stored?: string; readonly env?: string } = {},
): { readonly stderr: string; readonly conf: string } {
  peersFile(where, nodes)
  mkdirSync(join(where, 'logs'), { recursive: true })
  const conf = join(where, 'console.conf')
  if (options.stored !== undefined) {
    writeFileSync(conf, `LABEL=${options.stored}\n`, { mode: 0o600 })
  }
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        'set -euo pipefail',
        '. "$1"',
        'beta_load_peers',
        'beta_resolve_console_conf',
        'printf "resolved=%s\\n" "$BETA_LABEL"',
      ].join('\n'),
      'beta-label-test',
      COMMON,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        QIANMO_BETA_ROOT: where,
        ...(options.env === undefined
          ? {}
          : { QIANMO_BETA_LABEL: options.env }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  expect(child.exitCode).toBe(0)
  return {
    stderr: child.stderr.toString() + child.stdout.toString(),
    conf: readFileSync(conf, 'utf8'),
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const value = roots.pop()
    if (value !== undefined) rmSync(value, { recursive: true, force: true })
  }
})

describe('页头标签与名册的漂移判据', () => {
  const FOUR = ['beta-1', 'beta-2', 'beta-3', 'beta-4'] as const

  test('单节点时代的存量标签配四节点名册：点名不到的三个全报出来', () => {
    expect(
      drift(
        '阡陌内测环境 · 审计视图：beta-1（镜像 · 滞后 ≤ 5 min，权威副本在节点本机）',
        FOUR,
      ),
    ).toEqual(['missing beta-2', 'missing beta-3', 'missing beta-4'])
  })

  test('区间写法算提全 —— 现场那份正确的标签必须一声不吭', () => {
    expect(
      drift(
        '阡陌内测环境 · 审计视图：beta-1..4（镜像 · 滞后 ≤ 5 min，权威副本在各节点本机）',
        FOUR,
      ),
    ).toEqual([])
  })

  test('派生默认一个节点都没点名，永远不报', () => {
    expect(drift('阡陌内测环境 · 多节点审计视图', FOUR)).toEqual([])
  })

  test('逐个列全（全角顿号分隔）也算提全', () => {
    expect(drift('审计视图：beta-1、beta-2、beta-3、beta-4', FOUR)).toEqual([])
  })

  test('点名了名册里已经没有的节点 —— 那是删掉 peer 之后的形状', () => {
    expect(
      drift('审计视图：beta-1..3 与 beta-9', ['beta-1', 'beta-2', 'beta-3']),
    ).toEqual(['extra beta-9'])
  })

  test('`beta-1` 不算点到 `beta-10`：切词按完整的词，不是子串', () => {
    expect(drift('审计视图：beta-10', ['beta-1', 'beta-10'])).toEqual([
      'missing beta-1',
    ])
  })

  test('标签里的纯数字（「滞后 ≤ 5 min」）不会被当成节点', () => {
    expect(drift('阡陌内测环境 · 滞后 ≤ 5 min', FOUR)).toEqual([])
  })
})

describe('beta_resolve_console_conf 对过期标签的处置', () => {
  const FOUR = ['beta-1', 'beta-2', 'beta-3', 'beta-4'] as const

  test('存量单节点标签会被 WARN 点名，且仍然照旧沿用（只报不改）', () => {
    const where = root()
    const stored = '阡陌内测环境 · 审计视图：beta-1（权威副本在节点本机）'
    const { stderr, conf } = resolveConsoleConf(where, FOUR, { stored })
    expect(stderr).toContain('页头标签点名的节点与')
    expect(stderr).toContain('beta-2 beta-3 beta-4')
    expect(stderr).toContain('QIANMO_BETA_LABEL')
    // 报了不等于改了：标签是运维的展示决定，脚本没有权限替他改。
    expect(conf).toContain(`LABEL=${stored}`)
  })

  test('存量区间标签配同样的四节点名册：一个字都不说', () => {
    const where = root()
    const { stderr } = resolveConsoleConf(where, FOUR, {
      stored: '阡陌内测环境 · 审计视图：beta-1..4（镜像 · 滞后 ≤ 5 min）',
    })
    expect(stderr).not.toContain('页头标签点名的节点与')
  })

  test('没有 console.conf 时用派生默认，也不报', () => {
    const where = root()
    const { stderr, conf } = resolveConsoleConf(where, FOUR)
    expect(stderr).not.toContain('页头标签点名的节点与')
    expect(conf).toContain('LABEL=阡陌内测环境 · 多节点审计视图')
  })

  test('环境变量给的标签同样受检 —— 上一轮的标签粘进来一样会过期', () => {
    const where = root()
    const { stderr, conf } = resolveConsoleConf(where, FOUR, {
      env: '阡陌内测环境 · 审计视图：beta-1',
    })
    expect(stderr).toContain('页头标签点名的节点与')
    expect(stderr).toContain('环境变量 QIANMO_BETA_LABEL')
    expect(conf).toContain('LABEL=阡陌内测环境 · 审计视图：beta-1')
  })
})

describe('--help 说清页头标签的唯一入口', () => {
  test('点名 QIANMO_BETA_LABEL，并说明没有 --label、尾参活不过重启', () => {
    const help = bash(`'${join(BETA_DIR, 'beta-up.sh')}' --help`, {
      QIANMO_BETA_ROOT: join(root(), 'unused'),
    })
    expect(help.exitCode).toBe(0)
    const text = help.stdout + help.stderr
    expect(text).toContain('QIANMO_BETA_LABEL')
    expect(text).toContain('本脚本没有 --label')
    expect(text).toContain('console.conf')
  })
})
