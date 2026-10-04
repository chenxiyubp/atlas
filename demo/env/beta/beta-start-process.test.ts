// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `beta_start_process` 的存活校验（issue #40）。
 *
 * 病根不是「某处调用忘了检查」——仓库自己的三处调用都老实跟了 `beta_dump_if_dead`。
 * 病根是**这道校验是调用方的义务**：函数无条件打一行「已启动（pid N）」并写 pid 文件，
 * 而 `$!` 拿到的是后台那一格的 pid，`nohup` 随后可以以 127 退出。第一个出树调用方就
 * 漏掉了，于是操作者看到绿色的 OK、节点是死的、`run/<名字>.pid` 里还留下一个指向已死
 * pid 的陈旧记录。
 *
 * 2026-08-24 的舰队部署撞上的是最刁钻的那一种：`bun` 装在 `~/.bun/bin`，非交互 SSH 解析
 * 不到，四台里三台静默死亡，唯独 root 那台因为 `/root/.bun/bin` 在 PATH 里而活着。
 *
 * 所以这里钉四件事：
 *
 * ① 命令根本不可执行时，报的是失败而不是成功（那次故障的确切形状）；
 * ② 命令存在但立刻退出时，同样报失败，并把 stderr 摊开——只判①盖不住这一半；
 * ③ 两条失败路径都**不留下陈旧 pid 文件**；
 * ④ 正向对照：进程真活着时照旧报成功。少了它，一个「永远报失败」的实现也能全绿。
 *
 * 外加连带那半：`beta_require_occ` 的 `command -v bun` 守卫（仓库里已有三处，
 * 唯独这条主部署路径漏了）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const COMMON = join(REPOSITORY_ROOT, 'demo/env/beta/common.sh')

/** 起法脚本一旦把它打出来，就等于对操作者说「起住了」。 */
const SUCCESS_LINE = '已启动'

const roots: string[] = []
const strays: number[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-start-'))
  roots.push(value)
  // beta_start_process 只要 run/ 与 logs/ 两个目录；这里不铺全套骨架，
  // 免得把「起进程」这件事和 beta_seed_root 的行为混在一个用例里。
  mkdirSync(join(value, 'run'), { recursive: true })
  mkdirSync(join(value, 'logs'), { recursive: true })
  return value
}

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** 在真 `/bin/bash` 里 source common.sh 后跑一段脚本。 */
function runShell(
  value: string,
  lines: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): ShellResult {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      ['set -euo pipefail', '. "$1"', ...lines].join('\n'),
      'beta-start-process-test',
      COMMON,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        // locale 故意不钉：继承开发机的 UTF-8。issue #49 之前这里钉着 `LC_ALL=C`，
        // 因为 macOS 自带 bash 3.2 会把 `"$pid，"` 里的全角逗号算进变量名（`set -u`
        // 下当场 unbound variable）。那 81 处已统一改成 `${var}`，所以 UTF-8 下再跑
        // 才是真实条件；钉成 C 等于把回归掩盖掉。
        QIANMO_BETA_ROOT: value,
        ...extraEnv,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经自己走了——正向用例只要它在断言那一刻活着。
    }
  }
  for (const value of roots.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

describe('beta_start_process verifies the process is actually alive', () => {
  test('a command that cannot be executed is reported as a failure, not a start', () => {
    const value = root()
    const result = runShell(value, [
      'beta_start_process demo "$QIANMO_BETA_ROOT/config" definitely-not-on-this-path --node x',
    ])
    expect(result.exitCode).not.toBe(0)
    // 报的是病因（这条命令跑不起来），不是症状（端口没起来 / 探测超时）。
    expect(result.stderr).toContain('definitely-not-on-this-path')
    expect(result.stdout + result.stderr).not.toContain(SUCCESS_LINE)
    // 那次故障的具体形状要在提示里出现，否则人还是会去查机器而不是查 PATH。
    expect(result.stderr).toContain('.bun/bin')
  })

  test('a command that exits right after launch is reported as a failure too', () => {
    const value = root()
    // 命令本身是可执行的，所以①拦不住它——这一半只有起完再问一次才看得见。
    const result = runShell(value, [
      `beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/sh -c 'echo boom-from-stderr >&2; exit 127'`,
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).not.toContain(SUCCESS_LINE)
    expect(result.stderr).toContain('未能保持运行')
    // 信息量不能比调用方原先自己跟的那一句少：stderr 末尾必须被摊开。
    expect(result.stdout).toContain('demo stderr 末尾')
    expect(result.stdout).toContain('boom-from-stderr')
  })

  test('neither failure leaves a stale pid file behind', () => {
    const missing = root()
    runShell(missing, [
      'beta_start_process demo "$QIANMO_BETA_ROOT/config" definitely-not-on-this-path || true',
    ])
    expect(existsSync(join(missing, 'run', 'demo.pid'))).toBe(false)

    const died = root()
    runShell(died, [
      `beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/sh -c 'exit 127' || true`,
    ])
    // pid 号是会被复用的：留着一个指向已死进程的记录，就是给下一次 beta_running
    // 一个会说谎的依据，而幂等起停的全部判据就是它。
    expect(existsSync(join(died, 'run', 'demo.pid'))).toBe(false)
  })

  test('a process that stays up is still reported as started', () => {
    const value = root()
    const result = runShell(value, [
      'beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/sleep 30',
      'printf "pid=%s\\n" "$(cat "$QIANMO_BETA_ROOT/run/demo.pid")"',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(SUCCESS_LINE)
    const pid = Number(/pid=(\d+)/.exec(result.stdout)?.[1])
    expect(Number.isInteger(pid)).toBe(true)
    strays.push(pid)
    // 断言的是「pid 文件指着一个真的活着的进程」，不是「文件里有个数字」。
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  test('an already-running process is left alone (idempotence is unchanged)', () => {
    const value = root()
    const result = runShell(value, [
      'beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/sleep 30',
      'beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/sleep 30',
      'printf "pid=%s\\n" "$(cat "$QIANMO_BETA_ROOT/run/demo.pid")"',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('不重起')
    const pid = Number(/pid=(\d+)/.exec(result.stdout)?.[1])
    strays.push(pid)
    // 第二次不该再起一个：整段输出里只有一次「已启动」。
    expect(result.stdout.split(SUCCESS_LINE).length - 1).toBe(1)
  })
})

describe('beta_require_occ also guards the interpreter', () => {
  test('missing bun fails even when the build artifact is there', () => {
    const value = root()
    // 产物在不在、和跑得动它的解释器在不在，是两件事。这个用例把前者钉成「在」。
    const result = runShell(value, [
      '[ -f "$BETA_OCC" ] || { printf "artifact missing, skipping\\n"; exit 0; }',
      'beta_require_occ',
    ])
    if (result.stdout.includes('artifact missing')) {
      // dist/ 没构建时这条判据不成立——跳过而不是假装验过（见 beta-model-env 的 0000 用例）。
      expect(result.exitCode).toBe(0)
      return
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('bun 不在 PATH 上')
  })

  test('the guard is the same one the other three sites use', () => {
    const source = Bun.file(COMMON)
    return source.text().then(text => {
      // demo/env/bootstrap.sh:45、beta-retain.sh:31、remote/prepare-sandbox.sh:78
      // 都是这一行的形状。补的是漏掉的第四处，不是另起一套。
      expect(text).toContain('command -v bun >/dev/null 2>&1 ||')
    })
  })
})
