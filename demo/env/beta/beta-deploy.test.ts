// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `beta-deploy.sh` —— 换产物那一步的护栏。
 *
 * ## 病根：一个会停机的部署脚本，而且它不在仓库里
 *
 * 2026-08-26 之前舰队的部署靠的是**只存在于各台机器上**的 `node-deploy.sh` /
 * `h-deploy.sh`。它们每次部署都 `mv` 一份完整的树做备份（每份 ~1.6 GB）而
 * **从不清理**：一天四次重新部署之后 workbench-iap 上累到 8 份、约 13 GB，
 * 30 GB 的盘 100% 满。失败的形状很难看 —— `mv` 已经成功、`cp` 中途没空间，
 * 于是部署树变成一棵半截树，**控制台与注册中心一起下线**，而 `console.out`
 * 里的 `sourceCommit` 还是新的，光看 banner 会以为部署成功了。
 *
 * 脚本进仓库是为了有人 review；这个文件是为了那次事故不会以另一种拼写回来。
 *
 * ## 钉的五件事
 *
 * ① **保留数收敛**：连跑多次，备份份数稳定在 `--keep`，不多不少；
 * ② **先清后装**：空间不够时**一个字节都不动**（旧树还在原地），而不是
 *    `mv` 完了才发现装不下 —— 那正是把控制台弄下线的那条路径；
 * ③ **同一秒两次部署不套娃**：秒级时间戳会撞名，而 `mv 树 已存在的目录` 是
 *    把树塞进去而不是覆盖，结果是备份里套着备份、下次清理算错份数；
 * ④ **装完少文件就当场红**：装了一棵半截树却报成功是最该挡住的事；
 * ⑤ **不许从要被换掉的那棵树里启动**（`atlas-build.sh` 那个「从自己要删的
 *    目录里启动」的坑同形），且这条要在 **C locale** 下也成立 —— ssh 过去的
 *    非交互 shell 常常正是 C locale，而那条错误消息里紧跟 `${PWD}` 的是一个
 *    全角括号：不加花括号，bash 会把它的高位字节当成变量名的一部分，
 *    `set -u` 当场报 unbound variable。**本地 UTF-8 下测不出来。**
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'beta-deploy.sh')
const made: string[] = []

afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const REAL_COMMIT = '0123456789abcdef0123456789abcdef01234567'
/** 干扰项：真机那棵 dist 里有 4 个互不相同的裸 40 位十六进制。**排在真值前面**，
 *  这样「grep 裸十六进制取第一个」的写法会稳定地取到错的那个。 */
const DECOY_HEX = '00000000000000000000000000000000000000aa'

/** 编译产物里 SOURCE_COMMIT 的**形状** —— `defines.ts` 把它替换进返回位。 */
function bundleJs(commit: string | null, extra = ''): string {
  const shape =
    commit === null
      ? ''
      : `function __src(){try{return\`${commit}\`}catch{return"unknown"}}\n`
  return `const __chunkHash="${DECOY_HEX}"\n${shape}${extra}`
}

/** 一个假 HOME，里面放一棵可装的「构建树」。 */
function sandbox(opts: { readonly js?: string } = {}): {
  readonly home: string
  readonly build: string
} {
  const home = mkdtempSync(join(tmpdir(), 'qm-deploy-'))
  made.push(home)
  const build = join(home, 'build')
  mkdirSync(join(build, 'dist'), { recursive: true })
  mkdirSync(join(build, 'demo', 'env', 'beta'), { recursive: true })
  // 校验那一步 grep 的就是它。
  writeFileSync(
    join(build, 'dist', 'cli-node.js'),
    opts.js ?? bundleJs(REAL_COMMIT),
  )
  writeFileSync(join(build, 'demo', 'env', 'beta', 'beta-up.sh'), '#!/bin/sh\n')
  return { home, build }
}

function deploy(
  home: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { readonly code: number; readonly out: string } {
  const r = Bun.spawnSync(['bash', SCRIPT, ...args], {
    // cwd 故意放在 home 之外：脚本会拒绝从 --tree 内部启动，而默认 cwd 是
    // 仓库检出，本来就不在树里 —— 这里显式钉住，免得将来换了默认值测不出来。
    cwd: tmpdir(),
    env: { ...process.env, HOME: home, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: r.exitCode ?? -1,
    out: `${r.stdout.toString()}${r.stderr.toString()}`,
  }
}

function backups(home: string): string[] {
  return readdirSync(home).filter(n => n.startsWith('tree.bak-'))
}

describe('beta-deploy.sh 的保留策略（那次把控制台弄下线的事故）', () => {
  test('连跑多次，备份份数收敛到 --keep，不无限长', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    for (let i = 0; i < 5; i += 1) {
      const r = deploy(home, ['--tree', tree, '--from', build, '--keep', '2'])
      expect(r.code).toBe(0)
    }
    // 旧脚本在这里会是 5 份、还在涨。
    expect(backups(home)).toHaveLength(2)
    expect(existsSync(join(tree, 'dist', 'cli-node.js'))).toBe(true)
  })

  test('--keep 0 一份都不留，但树本身照装', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    deploy(home, ['--tree', tree, '--from', build])
    const r = deploy(home, ['--tree', tree, '--from', build, '--keep', '0'])
    expect(r.code).toBe(0)
    expect(backups(home)).toHaveLength(0)
    expect(existsSync(join(tree, 'dist', 'cli-node.js'))).toBe(true)
  })

  test('同一秒里连着装两次不会把备份套进备份里', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    // 三次紧挨着跑，秒级时间戳几乎必然撞上至少一次。
    for (let i = 0; i < 3; i += 1) {
      expect(
        deploy(home, ['--tree', tree, '--from', build, '--keep', '9']).code,
      ).toBe(0)
    }
    // 三次部署只造两份备份 —— 第一次没有旧树可备份。这个 off-by-one 我先写错
    // 过一次，记在这里免得下次又「修」脚本去迁就一个错的期望。
    expect(backups(home)).toHaveLength(2)
    // 套娃的形状是备份里又出现一个 tree/ —— 那会让下次清理数错份数。
    for (const b of backups(home)) {
      expect(existsSync(join(home, b, 'tree'))).toBe(false)
    }
  })
})

describe('beta-deploy.sh 的护栏', () => {
  test('装完少了关键文件就当场红，且说清旧树在哪', () => {
    const { home } = sandbox()
    const broken = join(home, 'broken')
    mkdirSync(join(broken, 'dist'), { recursive: true })
    writeFileSync(join(broken, 'dist', 'cli-node.js'), 'x\n')
    // 少了 demo/env/beta/beta-up.sh。
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', broken])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('装完少了')
    expect(r.out).toContain('beta-up.sh')
  })

  test('空间不够时一个字节都不动 —— 旧树还在原地', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    const marker = join(tree, 'dist', 'cli-node.js')
    expect(existsSync(marker)).toBe(true)

    // 把「需要多少」撑到不可能满足：拿一棵巨大的构建树是不现实的，所以改用
    // 一个假的 df —— 脚本问的是 `df -Pk`，把它换成恒答 0 可用即可。
    const fakebin = join(home, 'fakebin')
    mkdirSync(fakebin, { recursive: true })
    writeFileSync(
      join(fakebin, 'df'),
      '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\n"\nprintf "/dev/fake 100 100 0 100%% /\\n"\n',
      { mode: 0o755 },
    )
    const r = deploy(home, ['--tree', tree, '--from', build], {
      PATH: `${fakebin}:${process.env.PATH ?? ''}`,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('空间不够')
    // **这条才是重点**：旧树没有被 mv 走，控制台不会因此下线。
    expect(existsSync(marker)).toBe(true)
  })

  test('拒绝从要被换掉的那棵树里启动 —— C locale 下同样成立', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)

    // cwd 落在树里。ssh 过去的非交互 shell 常常是 C locale，而那条错误消息里
    // 紧跟那个变量的是全角括号 —— 不加花括号，bash 在 C locale 下会把它的
    // 高位字节当成变量名，`set -u` 报 unbound variable 而不是这句人话。
    // 另外脚本读的是 `pwd -P` 而不是 `$PWD`：这里 spawnSync 传的 env 里带着
    // 父进程的 PWD，靠那个变量的守卫在这条路径上根本不会触发。
    const r = Bun.spawnSync(['bash', SCRIPT, '--tree', tree, '--from', build], {
      cwd: tree,
      env: { ...process.env, HOME: home, LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${r.stdout.toString()}${r.stderr.toString()}`
    expect(r.exitCode).not.toBe(0)
    expect(out).toContain('当前目录在 --tree 之下')
    expect(out).not.toContain('unbound variable')
  })

  test('路径形状先卡死：家目录本身、家目录之外、带 .. 的都拒绝', () => {
    const { home, build } = sandbox()
    const self = deploy(home, ['--tree', home, '--from', build])
    expect(self.code).not.toBe(0)
    expect(self.out).toContain('不能是家目录本身')

    const outside = deploy(home, [
      '--tree',
      '/tmp/qm-not-home',
      '--from',
      build,
    ])
    expect(outside.code).not.toBe(0)
    expect(outside.out).toContain('必须在 $HOME 之下')

    const dotdot = deploy(home, ['--tree', `${home}/../x`, '--from', build])
    expect(dotdot.code).not.toBe(0)
    expect(dotdot.out).toContain('里有 ..')
  })

  test('把产物的来源 commit 打出来 —— 那是它唯一能自证来源的东西（#70）', () => {
    const { home, build } = sandbox()
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', build])
    expect(r.code).toBe(0)
    expect(r.out).toContain(REAL_COMMIT)
    // **这一半才是这条用例的价值**：dist 里还躺着别的 40 位十六进制，认错一个
    // 就是一个自信的错答案。第一版真机试跑报的正是那个干扰项。
    expect(r.out).not.toContain(DECOY_HEX)
  })

  test('读不出来源时说读不出，不拿旁边的十六进制凑数', () => {
    // 只有干扰项、没有那个返回位形状 —— 旧写法会把 DECOY 当 commit 报出来。
    const { home, build } = sandbox({ js: bundleJs(null) })
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', build])
    expect(r.code).toBe(0) // 装是装上了，这不是失败
    expect(r.out).toContain('读不出 SOURCE_COMMIT')
    expect(r.out).not.toContain(DECOY_HEX)
  })

  test('形状不再唯一时也不敢认 —— 宁可报「读出多个候选」', () => {
    const other = 'fedcba9876543210fedcba9876543210fedcba98'
    const { home, build } = sandbox({
      js: bundleJs(
        REAL_COMMIT,
        `function __b(){try{return\`${other}\`}catch{}}\n`,
      ),
    })
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', build])
    expect(r.code).toBe(0)
    expect(r.out).toContain('个候选')
  })
})

describe('beta-deploy.sh 不许把树从活着的进程脚下抽走', () => {
  /**
   * 在 `dir` 里放一个脚本、用跑测试的这个 bun 把它跑起来，返回它的 PID。
   *
   * 守卫是按 `ps` 里的 argv 含不含树路径判定的（见 `beta-deploy.sh` 那段注释），
   * 所以固件要造的是「argv 里带着树里路径的活进程」。真机上的常驻正是这个形状：
   * 解释器在树外，脚本在树里（`node <树>/dist/cli-node.js`）。
   *
   * 这里栽过两次，两次都是固件造出来的进程不符合这个形状，不是守卫的问题：
   *
   * ① shell 脚本 + `exec sleep`：`exec` 把 shell 整个换掉，argv 变成 `sleep 120`，
   *    树路径没了。macOS 上偶然是绿的（`/bin/sh` 启动慢，`ps` 常抢在 exec 之前），
   *    Linux 的 dash 立刻 exec，一次都抢不到——CI 第一次真跑起来时那条红就是这么来的。
   * ② 把 `/bin/sleep` 拷进树里直接跑：macOS 上它是带启动约束的 Apple 平台二进制，
   *    拷到系统卷以外再执行会被内核 SIGKILL（崩溃报告写的是
   *    `SIGKILL (Code Signature Invalid)`，终止原因 `CODESIGNING` /
   *    `Launch Constraint Violation`）。杀不杀随系统状态变——同一台机器同一天里
   *    先是照常能跑、后是一启动就被杀——于是这条用例时红时绿，整仓跑与单跑都会红，
   *    看着像跨套件污染，其实与别的测试无关（2026-09-26，macOS 27.0 实测）。
   *
   * 所以不再拷任何系统二进制：解释器就是 `process.execPath`，在它自己的位置上执行，
   * 只有脚本放进树里。没有 shell、没有子进程，SIGKILL 一下就收干净。
   *
   * 起完用守卫同一条 `ps` 先自检一次。固件没造出活进程时要在这里说清楚：否则下面
   * 「邻居目录不算」那条会空转成绿，这一条则红在一个误导人的断言上。
   */
  function runFromTree(dir: string): number {
    const script = join(dir, 'qm-fake-resident.js')
    writeFileSync(script, 'setTimeout(() => {}, 120_000)\n')
    const child = Bun.spawn([process.execPath, script], {
      cwd: dir,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    child.unref()
    const table = Bun.spawnSync(['ps', '-eo', 'pid=,args='], {
      stdout: 'pipe',
      stderr: 'ignore',
    }).stdout.toString()
    const seen = table
      .split('\n')
      .some(
        l => l.trimStart().startsWith(`${child.pid} `) && l.includes(script),
      )
    if (!seen) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        /* 已经没了就算了 */
      }
      throw new Error(
        `固件没造出「argv 里带着 ${script} 的活进程」（pid ${child.pid}）——这条用例测不了守卫`,
      )
    }
    return child.pid
  }

  test('树里有进程在跑就拒绝，而且拒绝时一个字节都没动', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    const marker = join(tree, 'dist', 'cli-node.js')
    const before = backups(home).length

    const pid = runFromTree(tree)
    try {
      const r = deploy(home, ['--tree', tree, '--from', build])
      expect(r.code).not.toBe(0)
      // 只写「正跑在」不够：守卫那一节的标题「检查是否有进程正跑在这棵树上」恒会打出来。
      // 树里多了个脚本，守卫漏拍时后面的掉件守卫照样退非零，所以要认拒绝消息本身。
      expect(r.out).toContain('上面这些进程正跑在')
      expect(r.out).toContain('beta-down.sh')
      // 守卫排在最前面，所以现场干净：旧树在原地、连备份都没多出来一份。
      expect(existsSync(marker)).toBe(true)
      expect(backups(home)).toHaveLength(before)
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已经没了就算了 */
      }
    }
  })

  test('ps 数不出东西就不敢往下走 —— 守卫不成立时不许静默放行', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    const marker = join(tree, 'dist', 'cli-node.js')

    // 一个什么都不输出的 ps —— 「这台机器的 ps 不认 -eo」在真机上就长这样，
    // 而脚本把它的 stderr 咽掉了。不特判的话 live 为空、守卫欢快放行：
    // 看着在、其实从不触发，是这类守卫最坏的死法。
    const fakebin = join(home, 'fakebin-ps')
    mkdirSync(fakebin, { recursive: true })
    writeFileSync(join(fakebin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const r = deploy(home, ['--tree', tree, '--from', build], {
      PATH: `${fakebin}:${process.env.PATH ?? ''}`,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('数不出进程表')
    expect(existsSync(marker)).toBe(true)
  })

  test('只是前缀像的邻居目录不算 —— 不能把 tree-other 里的进程当成树里的', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)

    const neighbour = join(home, 'tree-other')
    mkdirSync(neighbour, { recursive: true })
    const pid = runFromTree(neighbour)
    try {
      // 少了那个结尾的 `/`，`$HOME/tree` 会把 `$HOME/tree-other` 一起框进来，
      // 于是换 A 树被 B 树里的进程挡住 —— 挡错了比不挡更难查。
      expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已经没了就算了 */
      }
    }
  })
})

describe('部署树不是一个形状 —— 整棵换会换掉树里本来就有的东西', () => {
  /** p3/p7 那种树：除了 dist/demo，还压着一整棵源码检出与 node_modules。 */
  function treeWithCheckout(home: string, tree: string): string {
    const keep = join(tree, 'node_modules', 'some-dep')
    mkdirSync(keep, { recursive: true })
    writeFileSync(join(keep, 'index.js'), 'module.exports=1\n')
    mkdirSync(join(tree, 'src'), { recursive: true })
    writeFileSync(join(tree, 'src', 'cli.ts'), '// 源码检出\n')
    return join(keep, 'index.js')
  }

  test('源头覆盖不住树里现有的顶层条目就拒绝，而且什么都没动', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    // **装两次**：第二次才会留下一份备份。只装一次的话备份数恒为 0，
    // 下面那条「份数没变」的断言就是句空话 —— 先前写成一次，白写了。
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    // 装完之后有人往树里放了 node_modules 与 src —— 真机上 p3/p7 正是这个形状。
    const witness = treeWithCheckout(home, tree)

    const backupsBefore = backups(home).length
    expect(backupsBefore).toBeGreaterThan(0)
    const r = deploy(home, ['--tree', tree, '--from', build])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('整棵换会让树里这些东西消失')
    expect(r.out).toContain('node_modules')
    expect(r.out).toContain('--only dist,demo')
    // 拒绝了就一个字节都不动 —— 这条守卫只读不写，且排在清理旧备份**之前**，
    // 所以连备份份数都不该变。（先前它排在清理之后，这个断言会挂。）
    expect(existsSync(witness)).toBe(true)
    expect(existsSync(join(tree, 'src', 'cli.ts'))).toBe(true)
    expect(backups(home)).toHaveLength(backupsBefore)
  })

  test('--only 只换点名的条目，树里其余东西原封不动', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    const witness = treeWithCheckout(home, tree)

    const r = deploy(home, ['--tree', tree, '--from', build, '--only', 'dist'])
    expect(r.code).toBe(0)
    expect(existsSync(witness)).toBe(true)
    expect(existsSync(join(tree, 'src', 'cli.ts'))).toBe(true)
    expect(existsSync(join(tree, 'dist', 'cli-node.js'))).toBe(true)
    // 备份落在树里，按条目命名 —— 旧 node-deploy.sh 就是这个约定。
    expect(
      readdirSync(tree).filter(n => n.startsWith('dist.bak-')),
    ).toHaveLength(1)
  })

  test('--only 的备份也收敛到 --keep，不像旧脚本那样无限长', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    for (let i = 0; i < 4; i += 1) {
      expect(
        deploy(home, [
          '--tree',
          tree,
          '--from',
          build,
          '--only',
          'dist,demo',
          '--keep',
          '2',
        ]).code,
      ).toBe(0)
    }
    const names = readdirSync(tree)
    // 这正是把 workbench-iap 的盘撑满的那条路径 —— 旧脚本这里会是 4 份、还在涨。
    expect(names.filter(n => n.startsWith('dist.bak-'))).toHaveLength(2)
    expect(names.filter(n => n.startsWith('demo.bak-'))).toHaveLength(2)
  })

  test('--only 要的条目源头里没有就拒绝，树没被动过', () => {
    const { home, build } = sandbox()
    const tree = join(home, 'tree')
    expect(deploy(home, ['--tree', tree, '--from', build]).code).toBe(0)
    const marker = join(tree, 'dist', 'cli-node.js')
    const r = deploy(home, [
      '--tree',
      tree,
      '--from',
      build,
      '--only',
      'nonexistent',
    ])
    expect(r.code).not.toBe(0)
    expect(existsSync(marker)).toBe(true)
  })

  test('--only 不收路径，免得 ../ 把备份写到树外面去', () => {
    const { home, build } = sandbox()
    const r = deploy(home, [
      '--tree',
      join(home, 'tree'),
      '--from',
      build,
      '--only',
      '../evil',
    ])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('只收顶层条目名')
  })
})

describe('这一类坑不许再回来（静态检查脚本本身）', () => {
  test('没有「$变量 紧跟中文标点」—— C locale 下那是 unbound variable', () => {
    const dir = resolve(import.meta.dir)
    const files = [
      ...readdirSync(dir)
        .filter(n => n.endsWith('.sh'))
        .map(n => join(dir, n)),
      ...readdirSync(join(dir, 'ops'))
        .filter(n => n.endsWith('.sh'))
        .map(n => join(dir, 'ops', n)),
    ]
    // 扫这个目录下**全部** shell 脚本，不只被测的那一个 —— 这类坑与文件无关，
    // 是写中文注释/消息的 bash 都会踩。实测把它铺开时存量是 0 处，
    // 所以这条检查不是「清理」，是「别再回来」。壳脚本 ops/legacy-deploy-shim.sh
    // 第一次跑就栽在同一个地方（第四次了）。
    expect(files.length).toBeGreaterThan(5)
    const src = files.map(f => readFileSync(f, 'utf8')).join('\n')
    // bash 认变量名到第一个非法字符为止，而全角「）」「，」「：」的高位字节
    // 在 C locale 下**不算**非法字符，于是 `$ONLY）` 整个被当成变量名，
    // `set -u` 报 unbound variable —— 真正想说的那句人话一个字也没打出来。
    // 已经栽过三次：两次在 beta_die 的错误消息里（正是最需要它说人话的时候），
    // 一次在成功路径上。逐个修没用，这里直接把形状钉死。
    const offenders: string[] = []
    const lines = src.split('\n')
    for (const [i, line] of lines.entries()) {
      // 排除注释行 —— 注释里写 `$TREE（部署树）` 是无害的。
      if (/^\s*#/.test(line)) continue
      // 不用 [^\x00-\x7f] 这种字符类 —— biome 的 noControlCharactersInRegex
      // 不收控制字符。先抓变量引用，再看紧跟其后的那个字符是不是非 ASCII。
      for (const m of line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g)) {
        const next = line.codePointAt((m.index ?? 0) + m[0].length)
        if (next !== undefined && next > 127) {
          offenders.push(`${i + 1}: ${m[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('ripgrep 必须是这台机的架构（旧 node-deploy.sh 唯一比我们多做的一件事）', () => {
  /** 本机在 dist/vendor/ripgrep 下对应的目录名。 */
  function rgDirForHost(): string {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return process.platform === 'darwin' ? `${arch}-darwin` : `${arch}-linux`
  }

  test('产物里没有本机架构的 rg 就当场红 —— 装错架构的树不算装好', () => {
    const { home, build } = sandbox()
    // 只放一个别的架构的 rg：文件在、但不是这台机能跑的那个。
    const other = rgDirForHost().startsWith('arm64')
      ? 'x64-linux'
      : 'arm64-linux'
    mkdirSync(join(build, 'dist', 'vendor', 'ripgrep', other), {
      recursive: true,
    })
    writeFileSync(
      join(build, 'dist', 'vendor', 'ripgrep', other, 'rg'),
      'x\n',
      {
        mode: 0o755,
      },
    )
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', build])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('没有这台机能用的 ripgrep')
  })

  test('rg 在但跑不起来也要红 —— 只看文件在不在，架构不对照样「在」', () => {
    const { home, build } = sandbox()
    const dir = join(build, 'dist', 'vendor', 'ripgrep', rgDirForHost())
    mkdirSync(dir, { recursive: true })
    // 可执行位有、但一跑就非零 —— 架构不对时的形状就是这样（Exec format error）。
    writeFileSync(join(dir, 'rg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', build])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('跑不起来')
  })

  test('本机架构的 rg 跑得起来就放行', () => {
    const { home, build } = sandbox()
    const dir = join(build, 'dist', 'vendor', 'ripgrep', rgDirForHost())
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'rg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', build])
    expect(r.code).toBe(0)
    expect(r.out).toContain('ripgrep 可执行')
  })

  test('整个 vendor/ripgrep 都没有时只提醒，不拦住部署', () => {
    const { home, build } = sandbox()
    const r = deploy(home, ['--tree', join(home, 'tree'), '--from', build])
    expect(r.code).toBe(0)
    expect(r.out).toContain('没有 dist/vendor/ripgrep')
  })
})
