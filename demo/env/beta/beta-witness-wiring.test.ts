// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 审计见证（P11.4）在内测拓扑里的两段接线：
 *
 *  ① H 一侧：peers.conf 坐标行的 `witness-port=` → 隧道那条 SSH 会话多一个
 *    `-R 127.0.0.1:<口>:127.0.0.1:<口>`（节点经它把锚点写到 H 的回环端点）；
 *  ② 节点一侧：尾参里有 `--witness-url` 时，把写 token 从 0600 文件读进环境——
 *    不上命令行；缺文件、权限宽、明文 http 指向回环以外，都在起进程之前拦下。
 *
 * 做法与 beta-oom-score.test.ts 相同：source 真的 common.sh，直接调函数。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BETA_DIR = import.meta.dir
const COMMON = resolve(BETA_DIR, 'common.sh')
const TOKEN = 'f'.repeat(64)
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beta-witness-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'root', 'secrets'), { recursive: true })
  return dir
}

function bash(
  dir: string,
  body: string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      `set -euo pipefail\n. "$1"\n${body}`,
      'beta-witness-test',
      COMMON,
    ],
    {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        QIANMO_BETA_ROOT: join(dir, 'root'),
        ...env,
      },
    },
  )
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

function peers(dir: string, nodeLine: string): void {
  writeFileSync(
    join(dir, 'root', 'peers.conf'),
    ['qianmo://beta-1/ops  ws://127.0.0.1:38631', nodeLine, ''].join('\n'),
  )
}

describe('① witness-port= → 隧道的 -R', () => {
  test('给了就多一个 -R，端口两端相同', () => {
    const dir = root()
    peers(
      dir,
      'node beta-1 user=u host=h.example local-port=38631 key=/k witness-port=38640',
    )
    const result = bash(
      dir,
      'beta_load_peers; printf "[%s]" "$(beta_tunnel_extra_args 0)"',
    )
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('[-R 127.0.0.1:38640:127.0.0.1:38640]')
  })

  test('没给就是空串（单元里展开成零个参数）', () => {
    const dir = root()
    peers(dir, 'node beta-1 user=u host=h.example local-port=38631 key=/k')
    const result = bash(
      dir,
      'beta_load_peers; printf "[%s]" "$(beta_tunnel_extra_args 0)"',
    )
    expect(result.stdout).toBe('[]')
  })

  test('witness-port 不是端口号就拒绝', () => {
    const dir = root()
    peers(
      dir,
      'node beta-1 user=u host=h.example local-port=38631 key=/k witness-port=abc',
    )
    const result = bash(dir, 'beta_load_peers')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('witness-port')
  })

  test('单元模板里 $TUNNEL_EXTRA_ARGS 不带花括号，且排在目的地之前', () => {
    const unit = readFileSync(
      resolve(BETA_DIR, 'ops', 'qianmo-tunnel@.service.in'),
      'utf8',
    )
    const exec =
      unit.split('\n').find(line => line.startsWith('ExecStart=')) ?? ''
    expect(exec).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: systemd 的变量引用，不是 JS 模板占位
      ' $TUNNEL_EXTRA_ARGS ${NODE_SSH_USER}@${NODE_SSH_HOST}',
    )
  })
})

describe('② beta_prepare_witness', () => {
  function withToken(dir: string, mode = 0o600): void {
    const file = join(dir, 'root', 'secrets', 'witness-write-token')
    writeFileSync(file, `${TOKEN}\n`)
    chmodSync(file, mode)
  }
  const call = (passThrough: string) =>
    `PASS_THROUGH=(${passThrough}); beta_prepare_witness; printf 'env=[%s]\\n' "\${QIANMO_WITNESS_WRITE_TOKEN:-}"`

  test('有 --witness-url：写 token 从文件进环境，输出里不出现 token', () => {
    const dir = root()
    withToken(dir)
    const result = bash(
      dir,
      call('--trust a=b --witness-url http://127.0.0.1:38640'),
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`env=[${TOKEN}]`)
    expect(result.stdout.replace(`env=[${TOKEN}]`, '')).not.toContain(TOKEN)
  })

  test('--witness-url=<值> 的写法同样认', () => {
    const dir = root()
    withToken(dir)
    const result = bash(dir, call('--witness-url=https://witness.example'))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`env=[${TOKEN}]`)
  })

  test('没有 --witness-url：即使文件在也不读', () => {
    const dir = root()
    withToken(dir)
    const result = bash(dir, call('--trust a=b'))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('env=[]')
  })

  test.each([
    ['缺 token 文件', 'missing'],
    ['token 文件权限过宽', 'wide'],
    ['明文 http 指向回环以外', 'remote'],
  ])('%s：在起进程之前拦下', (_label, kind) => {
    const dir = root()
    if (kind === 'wide') withToken(dir, 0o644)
    if (kind === 'remote') withToken(dir)
    const url =
      kind === 'remote' ? 'http://10.0.0.5:38640' : 'http://127.0.0.1:38640'
    const result = bash(dir, call(`--witness-url ${url}`))
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
  })
})

describe('③ beta_prepare_console_anchors（见证不在 H 上）', () => {
  function withReadToken(dir: string, mode = 0o600): void {
    const file = join(dir, 'root', 'secrets', 'witness-read-token')
    writeFileSync(file, `${TOKEN}\n`)
    chmodSync(file, mode)
  }
  const call = (passThrough: string) =>
    `PASS_THROUGH=(${passThrough}); beta_prepare_console_anchors; printf 'env=[%s]\\n' "\${QIANMO_WITNESS_READ_TOKEN:-}"`

  test('--anchors 是回环 HTTP：读 token 从文件进环境，输出里不出现 token', () => {
    const dir = root()
    withReadToken(dir)
    const result = bash(
      dir,
      call('--chat-sign --anchors http://127.0.0.1:38640'),
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`env=[${TOKEN}]`)
    expect(result.stdout.replace(`env=[${TOKEN}]`, '')).not.toContain(TOKEN)
  })

  test('--anchors 是本机目录：不读 token（见证在 H 上的形态）', () => {
    const dir = root()
    withReadToken(dir)
    const result = bash(dir, call('--anchors=/srv/witness/store'))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('env=[]')
  })

  test.each([
    ['缺读 token 文件', 'missing', 'http://127.0.0.1:38640'],
    ['读 token 文件权限过宽', 'wide', 'http://127.0.0.1:38640'],
    ['明文 http 指向回环以外', 'remote', 'http://10.0.0.5:38640'],
  ])('%s：在起控制台之前拦下', (_label, kind, url) => {
    const dir = root()
    if (kind === 'wide') withReadToken(dir, 0o644)
    if (kind === 'remote') withReadToken(dir)
    const result = bash(dir, call(`--anchors ${url}`))
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
  })

  test('H 腿在起控制台之前调它', () => {
    const text = readFileSync(resolve(BETA_DIR, 'beta-up.sh'), 'utf8')
    const start = text.indexOf('beta_start_process "$BETA_CONSOLE_PROC"')
    expect(start).toBeGreaterThan(0)
    const before = text.slice(0, start)
    expect(before.lastIndexOf('beta_prepare_console_anchors')).toBeGreaterThan(
      before.lastIndexOf('console_args+=('),
    )
  })
})

describe('beta-up.sh 的节点腿', () => {
  test('在起 resident 之前调 beta_prepare_witness', () => {
    const text = readFileSync(resolve(BETA_DIR, 'beta-up.sh'), 'utf8')
    const start = text.indexOf('beta_start_process "$BETA_NODE"')
    const before = text.slice(0, start)
    const at = before.lastIndexOf('beta_prepare_witness')
    expect(at).toBeGreaterThan(before.lastIndexOf('run_node() {'))
    expect(before.slice(at)).not.toContain('beta_start_process')
  })

  test('tunnel-<node>.env 写出 TUNNEL_EXTRA_ARGS，且 bash 能 source（mirror-pull.sh 就是这么读的）', () => {
    const text = readFileSync(resolve(BETA_DIR, 'beta-up.sh'), 'utf8')
    const line =
      text
        .split('\n')
        .find(l => l.trimStart().startsWith("printf 'TUNNEL_EXTRA_ARGS=")) ?? ''
    expect(line).not.toBe('')
    for (const [extra, expected] of [
      [
        "printf -- '-R 127.0.0.1:38640:127.0.0.1:38640'",
        '-R 127.0.0.1:38640:127.0.0.1:38640',
      ],
      [':', ''],
    ] as const) {
      const dir = root()
      const envFile = join(dir, 'tunnel.env')
      const child = Bun.spawnSync([
        '/bin/bash',
        '-c',
        `set -euo pipefail\nbeta_tunnel_extra_args() { ${extra}; }\ni=0\n{ ${line.trim()}; } >"$1"\n. "$1"\nprintf '[%s]' "$TUNNEL_EXTRA_ARGS"`,
        'tunnel-env-test',
        envFile,
      ])
      expect(child.stderr.toString()).toBe('')
      expect(child.exitCode).toBe(0)
      expect(child.stdout.toString()).toBe(`[${expected}]`)
    }
  })
})
