// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bootstrap.sh` 的前置检查：哪几样是**构建**要的，哪几样只是**自检**要的。
 *
 * 这条区分原先没有，代价很具体。2026-08-25 实查：内测舰队四台节点机上一台都没有
 * node（只有 `~/.bun/bin/bun`），而 ① 里那句 `command -v node || demo_die` 是无条件的。
 * 于是这份「装机 runbook」在真实部署机上从第一步就跑不起来，历次上机只能绕开它手工
 * `bun run build`——而绕开的同时也绕过了 ③ 里那段源 commit 注入（issue #70），四台节点
 * 的产物因此报 `sourceCommit=unknown`。
 *
 * 所以这里钉三件事：
 *
 * ① 缺 node 且要跑 ④ 时，**仍然**死在 ①。放宽不等于取消：自检真的会 spawn node。
 * ② 缺 node 且显式 `--skip-selftest` 时，②③ 照跑。这是舰队那条路径。
 * ③ 缺 node **不会**让 ④ 自动跳过——静默降级会让「自检过了」和「自检压根没跑」在
 *    输出里长得一模一样，那比直接失败更难发现。
 *
 * 手法：造一棵只有 `demo/env/` 与 `.tool-versions` 的一次性树，PATH 上只放桩
 * `bun` / `git`（以及需要时的 `node`）。桩让用例停在「前置检查怎么判」这一层，
 * 不去真跑 `bun install`——那既慢，也会把两件事的失败混在一个断言里。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const COMMON_SOURCE = join(REPOSITORY_ROOT, 'demo/env/common.sh')
const BOOTSTRAP_SOURCE = join(REPOSITORY_ROOT, 'demo/env/bootstrap.sh')
const ENTRY_SOURCE = join(REPOSITORY_ROOT, 'demo/lib/entry.sh')

/** 真 `.tool-versions` 里的 bun pin，桩要报同一个值，免得用例被那句 WARN 干扰。 */
const BUN_PIN = (await Bun.file(join(REPOSITORY_ROOT, '.tool-versions')).text())
  .split('\n')
  .map(line => line.trim().split(/\s+/))
  .find(([name]) => name === 'bun')?.[1]

const roots: string[] = []

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true })
})

/**
 * 每个可执行文件**整份文件只写一次**，用例里落的是指向它的软链（issue #102）。
 *
 * ## 为什么
 *
 * macOS 对**每个新写出来的可执行 inode** 收一次首次执行策略扫描
 * （Gatekeeper / `syspolicyd`）。本机实测：
 *
 * macOS 对新写出来的可执行文件收一次首次执行检查（Gatekeeper / `syspolicyd`）。
 * **它的代价不是一个常数** —— 机器空闲时全新内容约 70–100 ms，而机器一忙实测
 * 涨到 1.8–2.5 s，**没有上限**；指向一个已经执行过的 inode 的软链稳定在 4.5 ms
 * 上下。所以「每条用例现写一个可执行文件」在本地几乎看不出来，一到跑满的
 * `verify` 或 CI 上就会把用例自己的超时预算吃穿 —— 表现为「本该 pass 的用例以
 * 超时收场」，与被测逻辑毫无关系。
 *
 * 这份文件 6 条用例，每条 `scaffold()` 要写 4–5 个可执行文件（两个脚本 + 两三个
 * bin 桩），全是新 inode —— 每条用例白付近十秒扫描，而 Bun 的单测预算是 **5 s**
 * （1.3.13 不读 `bunfig` 的 `[test] timeout`）。于是机器一忙这三条最先倒。
 *
 * 这些文件的内容**全都是固定的**（两个脚本是仓库原文，桩的 body 只有那两三种），
 * 所以可以在模块作用域各写一次、当场预热，用例里只落软链。
 *
 * `bootstrap.sh` / `common.sh` 靠 `${BASH_SOURCE[0]}` 自定位，而 **bash 不解析
 * 软链** —— `BASH_SOURCE[0]` 给的是软链自己的路径，于是 `dirname` 仍落在这条
 * 用例的树里。软链因此不会把它们的 `REPO_DIR` 带偏。
 */
const SCAN_ONCE_DIR = mkdtempSync(join(tmpdir(), 'qianmo-bootstrap-shared-'))
const scanOnce = new Map<string, string>()

/** 同样内容只写一个 inode；第一次写完当场预热，把扫描付在用例计时器之外。 */
function sharedExecutable(key: string, text: string): string {
  const hit = scanOnce.get(key)
  if (hit !== undefined) return hit
  const path = join(SCAN_ONCE_DIR, key)
  writeFileSync(path, text, { mode: 0o755 })
  // **预热必须在这里**，不能等到用例里 —— 那时超时计时器已经在跑了。
  Bun.spawnSync([path, '--qianmo-warmup'], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, QIANMO_BOOTSTRAP_WARMUP: '1' },
  })
  scanOnce.set(key, path)
  return path
}

async function place(
  root: string,
  relative: string,
  from: string,
): Promise<void> {
  const text = await Bun.file(from).text()
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(sharedExecutable(relative.replaceAll('/', '_'), text), target)
}

function stub(binDir: string, name: string, body: string): void {
  symlinkSync(
    sharedExecutable(`stub_${name}_${hashBody(body)}`, `#!/bin/sh\n${body}\n`),
    join(binDir, name),
  )
}

/** 桩的 body 只有那两三种，用它做键就够把同内容折成一个 inode。 */
function hashBody(body: string): string {
  let h = 0
  for (const ch of body) h = (h * 31 + ch.charCodeAt(0)) | 0
  return (h >>> 0).toString(36)
}

/**
 * 一次性树 + 一个只有桩的 bin 目录。
 *
 * `withNode` 是正面对照：少了它，一个「永远报缺 node」的实现也能让①②全绿。
 */
async function scaffold(
  withNode: boolean,
): Promise<{ root: string; bin: string }> {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-bootstrap-'))
  roots.push(root)
  await place(root, 'demo/env/common.sh', COMMON_SOURCE)
  await place(root, 'demo/env/bootstrap.sh', BOOTSTRAP_SOURCE)
  // common.sh source 它（demo_entry 的实现）。缺了它 common.sh 在 source 阶段就死在
  // `set -e` 上，用例只看得到一个空输出 —— 与真正的前置检查失败无法区分。
  await place(root, 'demo/lib/entry.sh', ENTRY_SOURCE)
  writeFileSync(join(root, '.tool-versions'), `bun ${BUN_PIN}\n`)

  const bin = join(root, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  // `bun --version` 要报出 pin；其余子命令（install / run build / test）一律成功返回，
  // 用例关心的是「走没走到那一步」，不是那几步自己对不对。
  stub(
    bin,
    'bun',
    `[ "$1" = "--version" ] && { echo "${BUN_PIN}"; exit 0; }\nexit 0`,
  )
  // git 只答 --version；`rev-parse` 失败正是「这棵树不是仓库」那一支，与部署机一致。
  stub(
    bin,
    'git',
    '[ "$1" = "--version" ] && { echo "git version 2.43.0"; exit 0; }\nexit 1',
  )
  if (withNode) stub(bin, 'node', 'echo v22.0.0')
  return { root, bin }
}

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function runBootstrap(
  root: string,
  bin: string,
  args: readonly string[],
): ShellResult {
  const child = Bun.spawnSync(
    ['/bin/bash', join(root, 'demo/env/bootstrap.sh'), ...args],
    {
      cwd: root,
      // PATH 里**只有**桩目录和系统目录：开发机上装没装 node 不该改变结论。
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode ?? -1,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

describe('bootstrap.sh 的 node 前置', () => {
  test('缺 node 且要跑 ④ 自检：仍然死在 ①，并说清出路', async () => {
    const { root, bin } = await scaffold(false)

    const result = runBootstrap(root, bin, [])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('node 不在 PATH 上')
    expect(result.stderr).toContain('--skip-selftest')
    // 死在①，所以 ② 那一步的标题不该出现。
    expect(result.stdout).not.toContain('bun install')
  })

  test('缺 node 但显式 --skip-selftest：只 WARN，②③ 照跑', async () => {
    const { root, bin } = await scaffold(false)

    const result = runBootstrap(root, bin, ['--skip-selftest', '--skip-build'])
    expect(result.stdout).toContain('WARN')
    expect(result.stdout).toContain('已按 --skip-selftest 跳过')
    expect(result.stdout).toContain('② bun install --frozen-lockfile')
    // 走到了 ③，也就走到了那里的源 commit 注入 —— 这正是舰队那条路径要拿到的东西。
    expect(result.stdout).toContain('③ bun run build')
  })

  test('缺 node 不会让 ④ 自动跳过 —— 不给 --skip-selftest 就是失败，不是静默降级', async () => {
    const { root, bin } = await scaffold(false)

    const result = runBootstrap(root, bin, ['--skip-build'])
    expect(result.exitCode).not.toBe(0)
    // 「自检」二字根本不该出现：它连 ④ 都没走到，而不是走到了却悄悄跳过。
    expect(result.stdout).not.toContain('④ 自检')
  })

  test('有 node 时一切照旧：不 WARN、不 die，node 版本照报', async () => {
    const { root, bin } = await scaffold(true)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.stdout).toContain('node v22.0.0')
    expect(result.stdout).not.toContain('node 不在 PATH 上')
  })
})

describe('bootstrap.sh 的源 commit 注入', () => {
  test('没有 .git 也没有戳时，③ 里显式警告产物会报 unknown', async () => {
    const { root, bin } = await scaffold(true)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.stdout).toContain('sourceCommit=unknown')
    expect(result.stdout).toContain('demo/env/pack.sh')
  })

  test('有戳时，③ 里报出那个 commit', async () => {
    const { root, bin } = await scaffold(true)
    const sha = '0123456789abcdef0123456789abcdef01234567'
    writeFileSync(join(root, '.source-commit'), `${sha}\n`)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.stdout).toContain(sha)
    expect(result.stdout).not.toContain('sourceCommit=unknown')
  })
})
