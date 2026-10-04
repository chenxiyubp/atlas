// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `beta_console_url_from_args` —— 控制台**实际**绑上的地址。
 *
 * 为什么这个函数值得一个独立用例：它挡的是一类**假红**。beta-up.sh 起完控制台要探
 * `/v0/health` 才算数（issue #64：systemd 单元的状态两个方向都不算数），而探哪个地址
 * 此前用的是覆盖**之前**的默认值。于是把控制台部到 `-- --hostname 0.0.0.0 --port 80`
 * 之后，脚本探 127.0.0.1:38621 收到 000 并 die，报「控制台起不来」——那一刻控制台正在
 * :80 上对公网答 200。假红出现在部署的最后一步，读起来像真的，人会照着去重启一个
 * 本来好着的进程。
 *
 * 用例按「解析器怎么读」而不是「脚本怎么写」来钉：尾参是逃生门，最后一个赢
 * （beta-up.sh 文件头），两种写法都要认。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const COMMON = 'demo/env/beta/common.sh'

function consoleUrl(args: readonly string[]): string {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      [
        'set -euo pipefail',
        '. "$1"',
        'shift',
        'beta_console_url_from_args "$@"',
      ].join('\n'),
      'beta-console-url-test',
      COMMON,
      ...args,
    ],
    {
      cwd: REPOSITORY_ROOT,
      // 根目录必须存在且合法，否则 common.sh 的 guard 在 source 时就拦下来。
      env: {
        ...process.env,
        QIANMO_BETA_ROOT: '/tmp/qianmo-beta-console-url-test',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )
  expect(child.stderr.toString()).toBe('')
  expect(child.exitCode).toBe(0)
  return child.stdout.toString()
}

describe('beta_console_url_from_args', () => {
  test('没有尾参时就是那两个拓扑常量拼出来的默认值', () => {
    expect(consoleUrl([])).toBe('http://127.0.0.1:38621')
  })

  test('与控制台无关的尾参不影响结论', () => {
    expect(
      consoleUrl(['--wake-sign', '--chat-url', 'http://127.0.0.1:39000']),
    ).toBe('http://127.0.0.1:38621')
  })

  test('尾参改端口 —— 这就是那次假红的形状', () => {
    expect(consoleUrl(['--hostname', '0.0.0.0', '--port', '80'])).toBe(
      'http://127.0.0.1:80',
    )
  })

  test('等号写法与空格写法等价', () => {
    expect(consoleUrl(['--hostname=0.0.0.0', '--port=8080'])).toBe(
      'http://127.0.0.1:8080',
    )
  })

  test('后出现的赢 —— 与被调命令的解析器一致（consoleArgs.ts 是逐个赋值的循环）', () => {
    expect(consoleUrl(['--port', '38621', '--port', '80'])).toBe(
      'http://127.0.0.1:80',
    )
    expect(
      consoleUrl(['--hostname', '10.0.0.5', '--hostname', '10.0.0.6']),
    ).toBe('http://10.0.0.6:38621')
  })

  test('只改主机时端口保持默认，只改端口时主机保持默认', () => {
    expect(consoleUrl(['--hostname', '10.0.0.5'])).toBe('http://10.0.0.5:38621')
    expect(consoleUrl(['--port', '80'])).toBe('http://127.0.0.1:80')
  })

  test('通配地址换回回环 —— 它是「绑哪些网卡」不是「拨哪个地址」', () => {
    for (const wildcard of ['0.0.0.0', '::', '[::]', '*']) {
      expect(consoleUrl(['--hostname', wildcard, '--port', '80'])).toBe(
        'http://127.0.0.1:80',
      )
    }
  })

  test('非通配的具体地址原样保留，不被换成回环', () => {
    expect(consoleUrl(['--hostname', '127.0.0.2', '--port', '80'])).toBe(
      'http://127.0.0.2:80',
    )
  })

  test('IPv6 字面量加方括号 —— 不加的话冒号分不清哪个是端口', () => {
    expect(consoleUrl(['--hostname', '::1', '--port', '80'])).toBe(
      'http://[::1]:80',
    )
    expect(consoleUrl(['--hostname', 'fd00::1'])).toBe('http://[fd00::1]:38621')
    // 已经带括号的不要再括一层。
    expect(consoleUrl(['--hostname', '[::1]', '--port', '80'])).toBe(
      'http://[::1]:80',
    )
  })
})

/**
 * 上面那组测的是函数本身。**函数对了不等于接对了**——它有两个真实调用点，而两个都
 * 没有被端到端跑到：`beta-up-args.test.ts` 的 RECORDER 对没有 `--ready` 的进程（控制台
 * 正是这种）直接 `exit 0`，于是 beta-up.sh 在 `beta_start_process` 处就结束，永远走不到
 * 下面那几行。把控制台起真、再等它答 /v0/health，成本远高于这个缺口的价值。
 *
 * 折中：钉**接线本身**。这里查的是「传进去的是不是那张最终参数表」「探活用的是不是
 * 它的结果」——正是接错时会静默失效、而单元测试看不见的那一处。同类做法见
 * `demo/env/resident-task-policy.test.ts`（对脚本正文做断言）。
 */
describe('两个调用点确实接的是 beta_console_url_from_args 的结果', () => {
  const betaUp = readFileSync(
    join(REPOSITORY_ROOT, 'demo/env/beta/beta-up.sh'),
    'utf8',
  )
  const betaSmoke = readFileSync(
    join(REPOSITORY_ROOT, 'demo/env/beta/beta-smoke.sh'),
    'utf8',
  )

  test('beta-up.sh 传的是最终那张 console_args，且在它拼完之后', () => {
    expect(
      betaUp.includes(
        'console_url="$(beta_console_url_from_args "${console_args[@]}")"',
      ),
    ).toBe(true)
    // 顺序：尾参在 console_args 拼好之后才追加，算 URL 必须排在那之后，否则解出来的是
    // 覆盖前的默认值——那正是本包要修的那个 bug。
    const appended = betaUp.indexOf(
      'console_args+=(${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"})',
    )
    const computed = betaUp.indexOf(
      'beta_console_url_from_args "${console_args[@]}"',
    )
    expect(appended).toBeGreaterThan(-1)
    expect(computed).toBeGreaterThan(appended)
  })

  test('beta-up.sh 探活与报出去的地址都用 console_url，不留旧常量', () => {
    expect(betaUp.includes('beta_http_status "$console_url/v0/health"')).toBe(
      true,
    )
    expect(betaUp.includes('BETA_CONSOLE_URL')).toBe(false)
    expect(betaSmoke.includes('BETA_CONSOLE_URL')).toBe(false)
  })

  test('beta-smoke.sh 从 console.env 取尾参再解地址', () => {
    expect(
      betaSmoke.includes(
        'beta_conf_get "$BETA_OPS_DIR/console.env" CONSOLE_EXTRA_ARGS',
      ),
    ).toBe(true)
    expect(
      betaSmoke.includes('beta_console_url_from_args ${console_extra_args[@]+'),
    ).toBe(true)
    expect(
      betaSmoke.includes('beta_http_status "$console_url/v0/health"'),
    ).toBe(true)
  })
})
