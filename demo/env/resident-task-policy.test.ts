// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 每一处起常驻节点的脚本都必须**显式**写出任务策略开关。
 *
 * 为什么这条值得一个用例：内测舰队四台在 2026-08-23 的实查里跑在
 * `requireSignedTasks:false`，而它们的 `/proc/<pid>/cmdline` 里既没有
 * `--open-policy` 也没有 `--require-signed-tasks`——开放策略不是配出来的，是
 * 「跑着一个 P12.4 翻默认之前的构建」的副作用。**依赖默认值意味着安全姿态由构建
 * 日期决定**，而故障要等到第一次真用时才出现（issue #10）。
 *
 * 所以这里钉两件事：
 *
 * ① 已知的三处起法各自写全了策略开关；
 * ② **没有第四处**——新增一处起法而忘了写策略，会在这里变红，而不是等到某次例行
 *    部署之后。只断言①的用例挡不住这个方向。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const DEMO_ROOT = join(REPOSITORY_ROOT, 'demo')

/** 起法脚本 → 该处必须出现的开关。 */
const REQUIRED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  // 真实内测舰队。§9.2 阶段①：开放策略 + 审计「若强制会被拒」的每一条。
  //
  // 外加 `--allow-workspace-edits`：它不是任务策略，是**权限姿态**，但落在同一条
  // 纪律上——省掉它，这台节点能不能在自己的工作区里干活就由「跑的是哪一版产物」
  // 决定。2026-08-28 在 p11 上就是这个形状：投递、回执、已读、终态回复全绿，
  // 而 agent 建不出一个文件。演示拓扑不列它：那两处是本机跑给人看的，放宽与否
  // 该是各自的决定，不该被这条用例代劳。
  'demo/env/beta/beta-up.sh': [
    '--open-policy',
    '--audit-signed-tasks',
    '--allow-workspace-edits',
  ],
  // 本机演示拓扑：发送方不出示令牌，强制策略下 ac2/ac3/p41 会被全拒。
  'demo/env/up.sh': ['--open-policy', '--audit-signed-tasks'],
  // 远端沙箱腿，同一条理由。
  'demo/env/remote/prepare-sandbox.sh': [
    '--open-policy',
    '--audit-signed-tasks',
  ],
}

function shellScripts(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...shellScripts(full))
    } else if (entry.endsWith('.sh')) {
      found.push(full)
    }
  }
  return found.sort()
}

/**
 * 一行是不是真的在**起** resident，而不是在别处提到这个词。
 *
 * 三种形状：`bun "$OCC" resident \`（反斜杠续行）、`args=( … bun "$OCC" resident
 * … )`（数组）、`set -- resident \`（把参数攒进 `$@`）。判据是 `resident` 这个
 * 词后面跟着行尾、续行符或第一个 `--` 选项——子命令后面只可能是这三样。
 *
 * 两类不算：注释行（`demo/p73-baseline.sh`、`demo/env/bootstrap.sh` 的用法说明
 * 就是这种），以及散文里的这个词（`demo/p31-resident-wake.sh` 有一句
 * `no complete resident response`，早先一版判据把它当成了第四处起法）。
 */
function isResidentLaunch(line: string): boolean {
  const code = line.trim()
  if (code.startsWith('#')) return false
  return /(^|\s)resident(\s+--|\s*\\?$)/.test(code)
}

/**
 * 取这条起法的完整参数块。仓库里两种形状：
 *
 * - **反斜杠续行**（`demo/env/up.sh`、`remote/prepare-sandbox.sh`）：`resident`
 *   那一行以 `\` 结尾，块一直收到第一条不以 `\` 结尾的行为止。
 * - **数组**（`demo/env/beta/beta-up.sh`）：`args=(` … `)`，`resident` 在块内，
 *   所以先往回找到那个 `(`，再往下收到单独一行 `)`。
 *
 * 注释行一律剔掉——「策略开关写在注释里」和没写是一回事。
 */
function launchBlock(lines: readonly string[], residentLine: number): string {
  const code = (index: number): string => (lines[index] ?? '').trim()
  const collected: string[] = []
  const push = (index: number): void => {
    if (!code(index).startsWith('#')) collected.push(code(index))
  }

  if (code(residentLine).endsWith('\\')) {
    let index = residentLine
    push(index)
    while (code(index).endsWith('\\') && index + 1 < lines.length) {
      index++
      push(index)
    }
    return collected.join('\n')
  }

  let start = residentLine
  while (start > 0 && !code(start).endsWith('(')) start--
  for (let index = start; index < lines.length; index++) {
    push(index)
    if (index > start && code(index) === ')') break
  }
  return collected.join('\n')
}

function launchSites(): Map<string, string> {
  const sites = new Map<string, string>()
  for (const file of shellScripts(DEMO_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (!isResidentLaunch(lines[index] ?? '')) continue
      sites.set(relative(REPOSITORY_ROOT, file), launchBlock(lines, index))
      break
    }
  }
  return sites
}

describe('resident launches state their task policy', () => {
  test('every launch site in demo/ is a known one', () => {
    // 新增一处起法就必须在上面的表里给它写明策略开关；忘了写会在这里变红。
    expect([...launchSites().keys()].sort()).toEqual(
      Object.keys(REQUIRED_FLAGS).sort(),
    )
  })

  test('each launch spells the policy out instead of taking the default', () => {
    const sites = launchSites()
    for (const [file, flags] of Object.entries(REQUIRED_FLAGS)) {
      const block = sites.get(file)
      expect(block).toBeDefined()
      for (const flag of flags) {
        // 断言带上文件名，红的时候不用去猜是哪一处。
        expect({ file, flag, present: block?.includes(flag) }).toEqual({
          file,
          flag,
          present: true,
        })
      }
    }
  })

  test('the policy switch is in the argv, not only in a comment', () => {
    // 起法脚本里策略开关的**理由**都写在紧邻的注释里（那是对的），所以「文件里
    // 出现过这个字符串」不能作为判据：参数块才算数。这条用剔掉注释后的块再确认
    // 一次，钉住上面两条用的确实是 argv 那一份。
    for (const [file, block] of launchSites()) {
      for (const line of block.split('\n')) {
        expect(line.startsWith('#')).toBe(false)
      }
      expect(block).toMatch(/--(open-policy|require-signed-tasks)\b/)
      expect(file).toMatch(/\.sh$/)
    }
  })
})
