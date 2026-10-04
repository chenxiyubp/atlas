// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 源 commit 怎么跟着代码上机（issue #70 剩下的那一半）。
 *
 * 前一半已经落地：`scripts/defines.ts` 把源 commit 注成 `MACRO.SOURCE_COMMIT`，
 * 常驻启动行与控制台 banner 都报它。但在**部署路径上**它一直是 `unknown`——送代码
 * 那一步不带 `.git`（仓库根下压着 `.claude` 与含凭据的 `.occ`，裸同步是事故），
 * 机器上 `bun run build` 时 git 无从问起。
 *
 * 补法是两个脚本对半接：`demo/env/pack.sh` 在源端把 HEAD 封进包里的 `.source-commit`，
 * `demo/env/bootstrap.sh` 在机器上读回来经 `OCC_SOURCE_COMMIT` 交给 defines.ts。
 *
 * 这里钉四组：
 *
 * ① **git 压过一切**。树本身就是仓库时，戳文件与环境变量都不许说话。这一条不是洁癖：
 *    上一轮 shell 里残留的一个 `export OCC_SOURCE_COMMIT` 会给开发机上每一次构建
 *    贴上一个陈旧的 SHA，而产物看上去完全正常。
 * ② **戳文件的形状要验**。它是从别的机器搬来的普通文件；一个截断了半截的值长得
 *    很像 commit，会一路流进产物、启动行和验收报告，没人会怀疑。
 * ③ **三种结局各有各的话**。「有戳」「本树就是仓库」「什么都没有」必须能被操作者
 *    区分开——第三种是唯一会产出 `unknown` 的，它必须显式警告，而不是安静通过。
 * ④ **pack.sh 出的包本身**：戳在里面且等于 HEAD，凭据目录与 `node_modules` 不在里面，
 *    脏树被拒。第二条是这套工具里唯一一条会造成外泄的失败面，所以正面钉住。
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
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const COMMON_SOURCE = join(REPOSITORY_ROOT, 'demo/env/common.sh')
const PACK_SOURCE = join(REPOSITORY_ROOT, 'demo/env/pack.sh')

/** 一个形状合法的 commit，用来和「形状不合法」的那几个对照。 */
const SHA = '0123456789abcdef0123456789abcdef01234567'
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

const roots: string[] = []

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true })
})

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * 造一棵一次性的「仓库」：只有 `demo/env/common.sh`（真文件的副本）。
 *
 * 必须是副本而不是 source 真路径——`common.sh` 的 `REPO_DIR` 是从 `BASH_SOURCE[0]`
 * 往上两级推出来的，source 真文件等于把本仓库当被测树，那样既测不了「没有 .git」
 * 这一支，也会让用例受开发机当前 HEAD 影响。
 */
function tree(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-source-commit-'))
  roots.push(value)
  mkdirSync(join(value, 'demo/env'), { recursive: true })
  // common.sh source 它（demo_entry 的实现）。一次性树里缺这个文件，`set -e` 会让
  // common.sh 在 source 阶段就死掉，而用例看到的是**一个空 stdout** —— 那读起来像
  // 「被测函数什么都没输出」，与真正的失败无法区分。抄真文件，别写替身。
  mkdirSync(join(value, 'demo/lib'), { recursive: true })
  writeFileSync(
    join(value, 'demo/lib/entry.sh'),
    readFileSync(join(REPOSITORY_ROOT, 'demo/lib/entry.sh'), 'utf8'),
    { mode: 0o755 },
  )
  return value
}

/** 把仓库里的真脚本抄进一次性树里的同一个相对位置。 */
async function place(
  root: string,
  relative: string,
  from: string,
): Promise<void> {
  const text = await Bun.file(from).text()
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, { mode: 0o755 })
}

/** 在真 `/bin/bash` 里 source 一次性树的 common.sh 后跑几行。 */
function runShell(
  root: string,
  lines: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): ShellResult {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      ['set -euo pipefail', '. "$1"', ...lines].join('\n'),
      'source-commit-test',
      join(root, 'demo/env/common.sh'),
    ],
    {
      cwd: root,
      // 只留系统 PATH：用例不该因为开发机上装了什么而改变结论。git 在这两个目录里。
      env: { PATH: '/usr/bin:/bin', HOME: root, ...extraEnv },
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

/** 在一次性树里建一个真 git 仓库并提交一次，返回 HEAD。 */
function initGit(root: string): string {
  const run = (...args: string[]): string => {
    const child = Bun.spawnSync(args, {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_AUTHOR_NAME: 'qianmo',
        GIT_AUTHOR_EMAIL: 'qianmo@example.invalid',
        GIT_COMMITTER_NAME: 'qianmo',
        GIT_COMMITTER_EMAIL: 'qianmo@example.invalid',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((child.exitCode ?? -1) !== 0) {
      throw new Error(`${args.join(' ')} 失败：${child.stderr.toString()}`)
    }
    return child.stdout.toString().trim()
  }
  run('git', 'init', '-q', '-b', 'main')
  run('git', 'add', '-A')
  run('git', 'commit', '-q', '-m', 'seed')
  return run('git', 'rev-parse', 'HEAD')
}

describe('demo_source_commit —— 判定与优先级', () => {
  test('本树就是 git 仓库时打印空串，戳文件与环境变量都压不过它', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    writeFileSync(join(root, '.source-commit'), `${SHA}\n`)
    const head = initGit(root)

    const result = runShell(root, ['demo_source_commit'], {
      OCC_SOURCE_COMMIT: OTHER_SHA,
    })

    // 空串 = 「不该由我们说」：defines.ts 会自己去问 git。这里顺带证明它问得到，
    // 否则「空串」也可能是因为 git 在用例环境里根本跑不起来。
    expect(result.stdout).toBe('')
    expect(head).toMatch(/^[0-9a-f]{40}$/)
  })

  test('没有 git 时用戳文件', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    writeFileSync(join(root, '.source-commit'), `${SHA}\n`)

    expect(runShell(root, ['demo_source_commit']).stdout).toBe(SHA)
  })

  test('没有 git 时环境变量排在戳文件之上', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    writeFileSync(join(root, '.source-commit'), `${SHA}\n`)

    const result = runShell(root, ['demo_source_commit'], {
      OCC_SOURCE_COMMIT: OTHER_SHA,
    })
    expect(result.stdout).toBe(OTHER_SHA)
  })

  test('两个都没有时打印空串', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)

    expect(runShell(root, ['demo_source_commit']).stdout).toBe('')
  })

  test('戳文件里的空白被吃掉，-dirty 后缀保留', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    writeFileSync(join(root, '.source-commit'), `  ${SHA}-dirty  \n\n`)

    expect(runShell(root, ['demo_source_commit']).stdout).toBe(`${SHA}-dirty`)
  })

  test.each([
    ['截断了一半', SHA.slice(0, 20)],
    ['带路径的日志行', `HEAD is now at ${SHA}`],
    ['分支名', 's4/p11-console'],
    ['空文件', ''],
  ])('形状不对的戳（%s）当作没有戳，并在 stderr 上说一句', async (_name, content) => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    writeFileSync(join(root, '.source-commit'), `${content}\n`)

    const result = runShell(root, ['demo_source_commit'])
    // 静默降级是这条里最坏的结果：「戳坏了」会看起来和「压根没打包戳」一模一样。
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('不是一个 commit')
  })
})

describe('demo_export_source_commit —— 三种结局各说一句', () => {
  test('有戳：export 出去并报出那个 commit', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    writeFileSync(join(root, '.source-commit'), `${SHA}\n`)

    const result = runShell(root, [
      'demo_export_source_commit',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是 shell 的参数展开，不是 JS 模板串
      'printf "exported=%s\\n" "${OCC_SOURCE_COMMIT:-<unset>}"',
    ])
    expect(result.stdout).toContain(`exported=${SHA}`)
    expect(result.stdout).toContain(SHA)
  })

  test('本树就是仓库：报 git 的 HEAD，且**不**设 OCC_SOURCE_COMMIT', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    const head = initGit(root)

    const result = runShell(root, [
      'demo_export_source_commit',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是 shell 的参数展开，不是 JS 模板串
      'printf "exported=%s\\n" "${OCC_SOURCE_COMMIT:-<unset>}"',
    ])
    expect(result.stdout).toContain(head)
    // 设了就等于用环境变量覆盖 git —— defines.ts 那一侧会忽略它，但一个被设过的
    // 变量会继续泄给这次构建之后的一切子进程。
    expect(result.stdout).toContain('exported=<unset>')
  })

  test('什么都没有：显式 WARN，并指向 pack.sh', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)

    const result = runShell(root, ['demo_export_source_commit'])
    expect(result.stdout).toContain('WARN')
    expect(result.stdout).toContain('sourceCommit=unknown')
    expect(result.stdout).toContain('demo/env/pack.sh')
  })
})

describe('pack.sh —— 源端把 HEAD 封进包里', () => {
  /** 跑一次性树里的 pack.sh。 */
  function runPack(root: string, args: readonly string[]): ShellResult {
    const child = Bun.spawnSync(
      ['/bin/bash', join(root, 'demo/env/pack.sh'), ...args],
      {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          GIT_AUTHOR_NAME: 'qianmo',
          GIT_AUTHOR_EMAIL: 'qianmo@example.invalid',
          GIT_COMMITTER_NAME: 'qianmo',
          GIT_COMMITTER_EMAIL: 'qianmo@example.invalid',
        },
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

  /** 列出 tarball 里的条目。 */
  function entries(tarball: string): string[] {
    const child = Bun.spawnSync(['tar', '-tzf', tarball], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((child.exitCode ?? -1) !== 0) throw new Error(child.stderr.toString())
    return child.stdout.toString().split('\n').filter(Boolean)
  }

  async function packable(): Promise<{ root: string; head: string }> {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    await place(root, 'demo/env/pack.sh', PACK_SOURCE)
    // 两个「绝不该进包」的东西：凭据目录与依赖树。前者是 .gitignore 挡住的，
    // 后者是 git 压根不跟踪的 —— 用例要证明的正是「不靠排除表也不会漏」。
    mkdirSync(join(root, '.occ'), { recursive: true })
    writeFileSync(
      join(root, '.occ/credentials.json'),
      '{"token":"never-ship-me"}',
    )
    mkdirSync(join(root, 'node_modules/left-pad'), { recursive: true })
    writeFileSync(join(root, 'node_modules/left-pad/index.js'), '')
    writeFileSync(join(root, '.gitignore'), '.occ\nnode_modules\ndist\n')
    const head = initGit(root)
    return { root, head }
  }

  test('包里有 .source-commit，值等于 HEAD', async () => {
    const { root, head } = await packable()
    const output = join(root, 'out.tar.gz')

    const result = runPack(root, ['--output', output])
    expect(result.exitCode).toBe(0)
    expect(entries(output)).toContain('.source-commit')

    const extracted = join(root, 'x')
    mkdirSync(extracted, { recursive: true })
    Bun.spawnSync(['tar', '-xzf', output, '-C', extracted], {
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(
      (await Bun.file(join(extracted, '.source-commit')).text()).trim(),
    ).toBe(head)
  })

  test('包里没有 .git / .occ / node_modules', async () => {
    const { root } = await packable()
    const output = join(root, 'out.tar.gz')
    expect(runPack(root, ['--output', output]).exitCode).toBe(0)

    const listed = entries(output)
    expect(listed.some(entry => entry.startsWith('.git/'))).toBe(false)
    expect(listed.some(entry => entry.startsWith('.occ'))).toBe(false)
    expect(listed.some(entry => entry.startsWith('node_modules'))).toBe(false)
    // 正面对照：跟踪的文件确实在里面，否则上面三条空包也能全绿。
    expect(listed).toContain('demo/env/pack.sh')
  })

  test('脏树被拒，且不产出包', async () => {
    const { root } = await packable()
    const output = join(root, 'out.tar.gz')
    writeFileSync(join(root, 'demo/env/common.sh'), '# 本地改了一行没提交\n', {
      flag: 'a',
    })

    const result = runPack(root, ['--output', output])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('先提交')
    expect(await Bun.file(output).exists()).toBe(false)
  })

  test('不在仓库顶层时明确报错，而不是打出一个空包', async () => {
    const root = tree()
    await place(root, 'demo/env/common.sh', COMMON_SOURCE)
    await place(root, 'demo/env/pack.sh', PACK_SOURCE)

    const result = runPack(root, ['--output', join(root, 'out.tar.gz')])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('git 仓库的顶层')
  })
})
