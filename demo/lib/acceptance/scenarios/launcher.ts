// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 启动器维度 —— PR #48（issue #38 / #40）的验收面。
 *
 * 这一维跑的是**仓库自带的真 shell 脚本**（`/bin/bash` 里 source
 * `demo/env/beta/common.sh`，或直接 exec `beta-up.sh`），不是它们的 TypeScript
 * 替身。理由与 `scripts/test-shards.sh` 把 `demo/env` 单独列一格是同一条：
 * 这些脚本要证明的东西恰恰是「在真 bash 上会怎样」，而开发机的 macOS bash 3.2
 * 与线上的 Linux bash 5 差别就在这一层。
 *
 * **locale 不再被钉成 `C`**：issue #49（全角标点紧跟变量名）已在 PR #58 修掉，
 * 并由 `demo/env/shell-fullwidth-expansion.test.ts` 静态守着。钉 `LC_ALL=C`
 * 等于绕开脚本真实的运行条件，而那正是 #49 藏身的地方 —— 所以这里跟随进程
 * 自己的 locale。
 *
 * **七条都经 `ctx.driver.launcherHost()`（issue #65）**，不再直接
 * `Bun.spawnSync` 本地的 `/bin/bash`。于是真机腿上它们跑的是**那台机器上部署
 * 好的那一份脚本**，在那台机器的 bash 上 —— 「用哪份脚本、代价是什么」写在
 * `types.ts` 的 {@link LauncherHost} 头注里，改这一维之前先读那一段。
 *
 * 三条安全前提，一条都不能松：
 *
 * ① **`QIANMO_BETA_ROOT` 一律指向一次性根。** 脚本写出来的 `run/*.pid`、
 *    `logs/*`、`peers.conf` 全落在那儿，碰不到 `~/qianmo-beta`。
 * ② **PATH 里只有假 `bun`**（`<假 bun 目录>:/usr/bin:/bin`），真 `bun` 在
 *    `~/.bun/bin`，不在这条 PATH 上。所以即使某一步没被截住，也只会以
 *    「命令不可执行」收场，**不会真的起一个节点** —— 那台机器上 38625 正被
 *    内测节点占着，而 Bun 允许两个服务器绑同一个口且都不报错。
 * ③ 场景结束时按 pid 文件把假进程收干净。
 */

import { Checks } from '../checks.js'
import type { LauncherHost, Scenario, ScenarioContext } from '../types.js'

/**
 * 在真 bash 里 source `common.sh` 之后跑几行。
 *
 * `$1` 是 `common.sh` 的绝对路径 —— 由启动器位给出，本地是镜像树、真机是
 * 部署检出。
 */
async function runShell(
  host: LauncherHost,
  lines: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await host.run(
    [
      '/bin/bash',
      '-c',
      ['set -euo pipefail', '. "$1"', ...lines].join('\n'),
      'qianmo-acceptance',
      `${host.repoDir}/demo/env/beta/common.sh`,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        QIANMO_BETA_ROOT: host.betaRoot,
        ...extraEnv,
      },
      timeoutMs: 60_000,
    },
  )
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }
}

/**
 * 造一个假 `bun`：把自己被怎么调起来的记下来，返回它所在的目录。
 *
 * `linger` 决定它记完之后是否挂住。**默认挂住**，因为 `beta_start_process`
 * 的成功判据正是「宽限期之后进程还活着」—— 记完就退等于让每条启动场景都撞上
 * 那道存活校验（PR #48 加的那道），观察点会前移到「起不来」而不是「怎么起的」。
 */
async function stubBunDir(
  host: LauncherHost,
  argvLog: string,
  options: { readonly linger?: boolean } = {},
): Promise<string> {
  // `--ready <路径>`：注册中心用一个 ready 文件宣告自己起来了，而 beta-up.sh
  // 会卡在那儿等 30 s 再 die。假 bun 替它写一下，控制台那一步才够得着。
  const script = `#!/bin/bash
printf '%s\\n' "OCC_CONFIG_DIR=\${OCC_CONFIG_DIR:-}" >>"${argvLog}"
printf '%s\\n' "ARGV: $*" >>"${argvLog}"
prev=''
for arg in "$@"; do
  if [ "$prev" = '--ready' ]; then printf '{"stub":true}\\n' >"$arg"; fi
  prev="$arg"
done
${options.linger === false ? 'exit 0' : 'sleep 30'}
`
  const path = await host.writeFile('stub-bin/bun', script, { mode: '755' })
  return path.slice(0, path.lastIndexOf('/'))
}

/** 场景结束时按 pid 文件把假进程收干净，别把 `sleep` 留在机器上。 */
function killStubsOnCleanup(ctx: ScenarioContext, host: LauncherHost): void {
  ctx.cleanup(async () => {
    // 一条 bash 收干净：pid 文件在目标机上，逐个读回 runner 再 kill 是两倍
    // 往返，而清理路径上还可能带着超时。
    await host.run([
      '/bin/bash',
      '-c',
      `for f in "$1"/run/*.pid; do [ -e "$f" ] || continue; p="$(cat "$f")"; ` +
        `case "$p" in ''|*[!0-9]*) continue;; esac; kill -KILL "$p" 2>/dev/null || true; done`,
      'qianmo-acceptance',
      host.betaRoot,
    ])
  })
}

export const launcherScenarios: readonly Scenario[] = [
  {
    id: 'launcher/start-process-missing-command',
    dimension: 'launcher',
    title: 'beta_start_process：命令不可执行时报失败，且不留 pid 文件',
    expected:
      '退出码非零、stderr 含「起不来」与 .bun/bin 提示、run/<名>.pid 不存在',
    requires: ['run-launcher'],
    timeoutMs: 90_000,
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      const result = await runShell(host, [
        'beta_start_process demo "$QIANMO_BETA_ROOT/config" definitely-not-a-real-binary',
      ])
      const pidFile = `${host.betaRoot}/run/demo.pid`
      return new Checks()
        .note('执行位置', host.describe)
        .note('stdout', result.stdout)
        .note('stderr', result.stderr)
        .expect(result.exitCode !== 0, '退出码非零', result.exitCode)
        .contains(result.stderr, '起不来', 'stderr')
        .contains(result.stderr, '.bun/bin', 'stderr（要指出最常见的那个成因）')
        .notContains(result.stdout, '已启动', 'stdout（不许报成功）')
        .expect(!(await host.exists(pidFile)), 'pid 文件没有被写出来', pidFile)
        .done('起不来时不谎报成功')
    },
  },

  {
    id: 'launcher/start-process-dies-immediately',
    dimension: 'launcher',
    title: 'beta_start_process：命令存在但立刻退出时也报失败，并摊开 stderr',
    expected:
      '退出码非零、stdout 含「未能保持运行」之外的日志尾巴、pid 文件被清掉',
    requires: ['run-launcher'],
    timeoutMs: 90_000,
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      const result = await runShell(host, [
        'beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/bash -c "echo boom >&2; exit 3"',
      ])
      const pidFile = `${host.betaRoot}/run/demo.pid`
      const output = `${result.stdout}\n${result.stderr}`
      return new Checks()
        .note('执行位置', host.describe)
        .note('stdout', result.stdout)
        .note('stderr', result.stderr)
        .expect(result.exitCode !== 0, '退出码非零', result.exitCode)
        .contains(output, '未能保持运行', '输出')
        .contains(output, 'boom', '输出（子进程的 stderr 要被摊开）')
        .expect(!(await host.exists(pidFile)), '陈旧 pid 文件被清掉', pidFile)
        .done('起了就死也算失败')
    },
  },

  {
    id: 'launcher/start-process-happy-path',
    dimension: 'launcher',
    title: 'beta_start_process：进程真活着时照旧报成功（正向对照）',
    expected: '退出码 0、stdout 含「已启动」、pid 文件存在',
    requires: ['run-launcher'],
    timeoutMs: 90_000,
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      killStubsOnCleanup(ctx, host)
      const result = await runShell(host, [
        'beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/sleep 30',
        'cat "$(beta_pidfile demo)"',
      ])
      const pidFile = `${host.betaRoot}/run/demo.pid`
      return new Checks()
        .note('执行位置', host.describe)
        .note('stdout', result.stdout)
        .note('stderr', result.stderr)
        .eq(result.exitCode, 0, '退出码')
        .contains(result.stdout, '已启动', 'stdout')
        .expect(await host.exists(pidFile), 'pid 文件存在', pidFile)
        .done('正向对照成立')
    },
  },

  {
    id: 'launcher/beta-up-passthrough-trust',
    dimension: 'launcher',
    title: 'beta-up.sh 尾参能表达 --trust（节点腿）',
    expected: '`-- --trust <节点>=<公钥>` 原样出现在 resident 的命令行末尾',
    requires: ['run-launcher'],
    timeoutMs: 120_000,
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      const argvLog = `${host.workdir}/argv-node.log`
      const bin = await stubBunDir(host, argvLog)
      killStubsOnCleanup(ctx, host)

      const child = await host.run(
        [
          '/bin/bash',
          `${host.repoDir}/demo/env/beta/beta-up.sh`,
          '--role',
          'node',
          '--node',
          'beta-acc',
          '--',
          '--trust',
          'console=fake-public-key-0123456789',
        ],
        {
          env: {
            // 只有假 bun：真 bun 在 ~/.bun/bin，不在这条 PATH 上（见文件头 ②）。
            PATH: `${bin}:/usr/bin:/bin`,
            QIANMO_BETA_ROOT: host.betaRoot,
            QIANMO_BETA_START_GRACE_S: '0',
            QIANMO_TRANSPORT_PSK: 'qianmo-acceptance-psk-0000000000',
          },
          timeoutMs: 90_000,
        },
      )
      const log = (await host.readFile(argvLog)) ?? ''
      return (
        new Checks()
          .note('执行位置', host.describe)
          .note('beta-up stdout', child.stdout.slice(0, 3_000))
          .note('beta-up stderr', child.stderr.slice(0, 3_000))
          .note('截获的命令行', log === '' ? '(没有截到)' : log)
          .expect(log !== '', '截到了 resident 的命令行', log)
          // 尾参必须落在**末尾**：它是 `--` 之后原样附加的，夹在中间说明被
          // 重排过，而重排会让 `--agent name=cwd` 这类成对参数错位。
          .expect(
            log
              .trimEnd()
              .endsWith('--trust console=fake-public-key-0123456789'),
            '尾参原样落在命令行末尾',
            log,
          )
          .contains(log, '--trust', '截获的命令行')
          .contains(log, 'console=fake-public-key-0123456789', '截获的命令行')
          .done('节点腿尾参透传可用')
      )
    },
  },

  {
    id: 'launcher/beta-up-passthrough-wake-sign',
    dimension: 'launcher',
    title: 'beta-up.sh 尾参能表达 --wake-sign（控制台腿）',
    expected: '`-- --wake-sign` 原样出现在 console 的命令行末尾',
    requires: ['run-launcher'],
    timeoutMs: 120_000,
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      const argvLog = `${host.workdir}/argv-host.log`
      const bin = await stubBunDir(host, argvLog)
      killStubsOnCleanup(ctx, host)
      // 控制台腿要求地址表里至少有一条 —— 那是脚本的前置（运维单页第一步），
      // 不是本场景要断言的东西，所以在这里补齐而不是让它 die 在前面。
      await host.run(
        [
          '/bin/bash',
          '-c',
          `printf '%s\\n' 'qianmo://beta-acc/planner ws://127.0.0.1:38625' > "$1/peers.conf" && chmod 600 "$1/peers.conf"`,
          'qianmo-acceptance',
          host.betaRoot,
        ],
        { timeoutMs: 30_000 },
      )

      const child = await host.run(
        [
          '/bin/bash',
          `${host.repoDir}/demo/env/beta/beta-up.sh`,
          '--role',
          'host',
          '--',
          '--wake-sign',
        ],
        {
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            QIANMO_BETA_ROOT: host.betaRoot,
            QIANMO_BETA_START_GRACE_S: '0',
            QIANMO_TRANSPORT_PSK: 'qianmo-acceptance-psk-0000000000',
          },
          timeoutMs: 90_000,
        },
      )
      const log = (await host.readFile(argvLog)) ?? ''
      const consoleLine =
        log.split('\n').find(line => line.includes(' console ')) ?? ''
      return new Checks()
        .note('执行位置', host.describe)
        .note('beta-up stdout', child.stdout.slice(0, 3_000))
        .note('beta-up stderr', child.stderr.slice(0, 3_000))
        .note('截获的命令行', log === '' ? '(没有截到)' : log)
        .expect(log !== '', '截到了命令行', log)
        .expect(consoleLine !== '', '其中有 console 那条', log)
        .contains(consoleLine, '--wake-sign', 'console 的命令行')
        .expect(
          consoleLine.trimEnd().endsWith('--wake-sign'),
          '尾参原样落在命令行末尾',
          consoleLine,
        )
        .done('控制台腿尾参透传可用')
    },
  },

  {
    id: 'launcher/print-wake-identity-starts-nothing',
    dimension: 'launcher',
    title: 'beta-up.sh --print-wake-identity 走专用路径，不起后台进程',
    expected: 'stdout 只有那一行身份，run/console.pid 不存在',
    requires: ['run-launcher'],
    timeoutMs: 120_000,
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      const argvLog = `${host.workdir}/argv-identity.log`
      // 这条的 stub 不能 `sleep`：`--print-wake-identity` 是**同步**取一行，
      // 挂住会让整条场景耗到超时，而超时记的是 `error` 而不是它要证明的事。
      const bin = await stubBunDir(host, argvLog, { linger: false })
      killStubsOnCleanup(ctx, host)

      const child = await host.run(
        [
          '/bin/bash',
          `${host.repoDir}/demo/env/beta/beta-up.sh`,
          '--print-wake-identity',
        ],
        {
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            QIANMO_BETA_ROOT: host.betaRoot,
            QIANMO_TRANSPORT_PSK: 'qianmo-acceptance-psk-0000000000',
          },
          timeoutMs: 90_000,
        },
      )
      const pidFile = `${host.betaRoot}/run/console.pid`
      const log = (await host.readFile(argvLog)) ?? ''
      return new Checks()
        .note('执行位置', host.describe)
        .note('stdout', child.stdout)
        .note('stderr', child.stderr.slice(0, 3_000))
        .note('截获的命令行', log === '' ? '(没有截到)' : log)
        .expect(log !== '', '截到了命令行', log)
        .contains(log, '--print-wake-identity', '截获的命令行')
        .expect(
          !(await host.exists(pidFile)),
          'run/console.pid 不存在（这条路径不起后台进程）',
          pidFile,
        )
        .notContains(
          child.stdout,
          '已启动',
          'stdout（不该走 beta_start_process）',
        )
        .done('查身份不是一次启动')
    },
  },

  {
    id: 'launcher/beta-up-refuses-token-in-passthrough',
    dimension: 'launcher',
    title: 'beta-up.sh 拒绝把 token 放进尾参（命令行会进进程列表）',
    expected: '退出码非零，stderr 说明为什么不能这么传',
    requires: ['run-launcher'],
    timeoutMs: 90_000,
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      const child = await host.run(
        [
          '/bin/bash',
          `${host.repoDir}/demo/env/beta/beta-up.sh`,
          '--role',
          'host',
          '--',
          '--admin-token',
          'this-should-be-refused',
        ],
        {
          env: {
            PATH: '/usr/bin:/bin',
            QIANMO_BETA_ROOT: host.betaRoot,
          },
          timeoutMs: 60_000,
        },
      )
      return new Checks()
        .note('执行位置', host.describe)
        .note('stderr', child.stderr)
        .expect(child.code !== 0, '退出码非零', child.code)
        .contains(child.stderr, '--admin-token', 'stderr')
        .contains(child.stderr, '进程列表', 'stderr（要说清为什么）')
        .done('尾参不许夹带 token')
    },
  },
]
