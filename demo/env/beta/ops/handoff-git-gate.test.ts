// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `handoff-git-gate.sh`：authorized_keys 里 `command=` 的那道闸门（P17.4）。
 *
 * 跑的是仓库里那一份真脚本，分三层：
 *
 * - **真 git 端到端**：`GIT_SSH_COMMAND` 指向一个名叫 `ssh` 的小包装（名字决定 git 把它当
 *   OpenSSH，会带 `-o SendEnv=GIT_PROTOCOL`）。包装替 sshd 做它收到 exec 请求之后的事：把客户端
 *   发来的命令放进 `SSH_ORIGINAL_COMMAND`，用干净环境 `/bin/sh -c` 跑 `authorized-key` 生成的那一行
 *   里的 `command=`。然后真跑 git push / fetch / ls-remote / archive。
 * - **判定表**：照 sshd 的样子直接起闸门，`PATH` 最前面放三个哨兵（git-upload-pack、
 *   git-receive-pack、git-upload-archive），它们只记下自己被 exec 时的 argv 与 `GIT_*` 环境。
 *   拒绝 = 哨兵没被碰过 + 退出码 3 + stderr 恰好一行、带上那条原因 + 注入标记文件不存在；
 *   放行 = 哨兵收到的唯一参数是规范化路径。
 * - **authorized_keys 行的形状**，以及 sshd 直接 exec 它所需的可执行位。
 *
 * 包装与哨兵**整个文件只建一次**，它们和仓库里那份闸门脚本都在模块作用域先空跑一次：macOS 第一次
 * 执行一个新写出的文件要付一笔没有上界的扫描代价（mirror-pull.test.ts 文件头有实测），不能让它落在
 * 5 s 的单测预算里。
 *
 * 这里的包装只模拟 sshd 的两件事。`restrict` 真拦得住什么、真 sshd 给 SSH_ORIGINAL_COMMAND 什么值，
 * 是对着本机真 sshd 实测的，结论在脚本头注里。
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'handoff-git-gate.sh')
const REPO = resolve(import.meta.dir, '../../../..')
// 公钥不是秘密；内嵌一把固定的，主体用例就不依赖 ssh-keygen。
const PUBKEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII5aX31/2SxvioVXoQ8Z2jdy46S6lPOQ4/jWC71mjzqY handoff-gate@test'

const GIT_BIN = Bun.which('git')
const BASH_BIN = Bun.which('bash')
if (GIT_BIN === null || BASH_BIN === null) {
  throw new Error('这套用例要真 git 与 bash')
}
/**
 * 「中枢」那一侧的 PATH：sshd 给的是一条很短的系统 PATH，这里同样只放 git 与 bash 所在目录。
 *
 * git 的 exec-path 排在最前面：macOS 的 `/usr/bin/git`、`/usr/bin/git-upload-pack` 是 xcrun 垫片，
 * 每次调用 30–120 ms（直接调真 git 10 ms，实测），一次端到端要穿过十几次，单条用例因此逼近
 * 5 s 预算。exec-path 里是同一个真 git（Linux 上 /usr/bin 本来就是真二进制，这一项只是重复）。
 */
const GIT_EXEC_PATH = Bun.spawnSync([GIT_BIN, '--exec-path'])
  .stdout.toString()
  .trim()
const SYSTEM_PATH = [
  ...new Set(
    [
      GIT_EXEC_PATH,
      dirname(GIT_BIN),
      dirname(BASH_BIN),
      '/usr/bin',
      '/bin',
    ].filter(dir => dir !== ''),
  ),
].join(':')

/** 准备夹具用的 git：不读本机的全局与系统配置（模板钩子、签名提交都会改变行为）。 */
const FIXTURE_GIT_ENV = {
  PATH: SYSTEM_PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'gate-test',
  GIT_AUTHOR_EMAIL: 'gate-test@example.invalid',
  GIT_COMMITTER_NAME: 'gate-test',
  GIT_COMMITTER_EMAIL: 'gate-test@example.invalid',
}

function git(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: options.cwd,
    env: { ...FIXTURE_GIT_ENV, HOME: tmpdir(), ...options.env },
    stdin: 'ignore',
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function gitOk(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const result = git(args, options)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} → ${result.code}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

// ── 模块作用域：只建一次的东西 ────────────────────────────────────────────────

const SHARED = mkdtempSync(join(tmpdir(), 'qianmo-handoff-gate-'))
/** 注入成功的证据。每条用例开始前清掉：一条出事不该让后面几十条连坐变红、指错方向。 */
const MARKER = join(SHARED, 'pwned')
const TRACE = join(SHARED, 'git-trace.out')
beforeEach(() => {
  rmSync(MARKER, { force: true })
  rmSync(TRACE, { force: true })
})

/** 哨兵：只记下自己被 exec 时的 argv 与 GIT_* 环境，退出 0。 */
const SENTINEL = `#!/bin/sh
{
  printf 'argv0=%s\\n' "\${0##*/}"
  printf 'argc=%s\\n' "$#"
  for a in "$@"; do printf 'arg=%s\\n' "$a"; done
  env | grep '^GIT_' | sort
} >"\${SENTINEL_LOG:?}"
`
const SENTINEL_BIN = join(SHARED, 'sentinel-bin')
mkdirSync(SENTINEL_BIN)
for (const name of [
  'git-upload-pack',
  'git-receive-pack',
  'git-upload-archive',
]) {
  writeFileSync(join(SENTINEL_BIN, name), SENTINEL)
  chmodSync(join(SENTINEL_BIN, name), 0o755)
}

/**
 * 替 sshd 做它收到 exec 请求之后的事。git 实测发来的形状是
 * `[-o SendEnv=GIT_PROTOCOL] [-p <端口>] <主机> <命令>`（文件头注里有完整的实测表），别的选项
 * 一概当错，免得包装悄悄吞掉一个我们没想到的调用形状。`SendEnv=GIT_PROTOCOL` 照
 * `AcceptEnv GIT_PROTOCOL` 的服务端处理：只把这一个变量带过去。
 */
const SSH_WRAPPER = `#!/bin/bash
set -euo pipefail
proto=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      if [ "$2" = SendEnv=GIT_PROTOCOL ]; then proto="\${GIT_PROTOCOL-}"; fi
      shift 2
      ;;
    -p) shift 2 ;;
    -*) printf 'ssh 包装：没见过的选项 %s\\n' "$1" >&2; exit 255 ;;
    *) break ;;
  esac
done
[ "$#" -eq 2 ] || { printf 'ssh 包装：要 <主机> <命令>，收到 %s 个\\n' "$#" >&2; exit 255; }
printf '%s\\n' "$2" >>"$WRAP_LOG"
cd "$HUB_HOME"
if [ -n "$proto" ]; then
  exec env -i HOME="$HUB_HOME" PATH="$HUB_PATH" SSH_ORIGINAL_COMMAND="$2" \\
    GIT_PROTOCOL="$proto" /bin/sh -c "$HUB_FORCED_COMMAND"
fi
exec env -i HOME="$HUB_HOME" PATH="$HUB_PATH" SSH_ORIGINAL_COMMAND="$2" \\
  /bin/sh -c "$HUB_FORCED_COMMAND"
`
const SSH_BIN = join(SHARED, 'ssh-bin')
const SSH = join(SSH_BIN, 'ssh')
mkdirSync(SSH_BIN)
writeFileSync(SSH, SSH_WRAPPER)
chmodSync(SSH, 0o755)

// 首执行开销在这里付掉（每个都在做任何事之前退出，退出码不看）。
for (const executable of [
  SCRIPT,
  SSH,
  join(SENTINEL_BIN, 'git-upload-pack'),
  join(SENTINEL_BIN, 'git-receive-pack'),
  join(SENTINEL_BIN, 'git-upload-archive'),
]) {
  Bun.spawnSync([executable], {
    env: { PATH: SYSTEM_PATH },
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

/**
 * 判定表用的「中枢」，只读，整份文件共用：
 *
 * ```
 * <world>/outside.git                 根目录外的真裸仓
 * <world>/home/                       $HOME
 * <world>/home/hub -> hub-real        闸门的根目录参数（本身是软链）
 * <world>/home/hub-real/proj.git      合法裸仓
 * <world>/home/hub-real-evil/a.git    前缀相同的兄弟目录
 * ```
 */
function buildWorld() {
  const world = join(SHARED, 'world')
  const home = join(world, 'home')
  const rootReal = join(home, 'hub-real')
  const root = join(home, 'hub')
  mkdirSync(rootReal, { recursive: true })
  symlinkSync('hub-real', root)
  const bare = (path: string) => gitOk(['init', '-q', '--bare', path])
  bare(join(world, 'outside.git'))
  bare(join(home, 'hub-real-evil', 'a.git'))
  bare(join(rootReal, 'proj.git'))
  bare(join(rootReal, 'plain'))
  symlinkSync('plain', join(rootReal, 'alias.git'))
  symlinkSync('proj.git', join(rootReal, 'inner-link.git'))
  symlinkSync(join(world, 'outside.git'), join(rootReal, 'escape.git'))
  symlinkSync(world, join(rootReal, 'linkdir'))
  bare(join(rootReal, 'nonbare.git'))
  gitOk([
    'config',
    '--file',
    join(rootReal, 'nonbare.git', 'config'),
    'core.bare',
    'false',
  ])
  gitOk(['init', '-q', join(rootReal, 'worktree.git')])
  bare(join(rootReal, 'nested.git'))
  cpSync(join(world, 'outside.git'), join(rootReal, 'nested.git', '.git'), {
    recursive: true,
  })
  writeFileSync(join(rootReal, 'file.git'), 'not a repo\n')

  // 物理路径里带空格与 $()：请求走的是白名单字符的软链，exec 出去的是这个物理路径。
  // 经 shell 再求值一次，参数就会被拆开或被替换。
  const oddReal = join(world, 'odd $(id) dir', 'repos')
  mkdirSync(oddReal, { recursive: true })
  bare(join(oddReal, 'proj.git'))
  const oddRoot = join(home, 'hub-odd')
  symlinkSync(oddReal, oddRoot)

  // 物理路径里带 *：根目录比较时不加引号，globXroot 就会被当成 glob*root 之下。
  const globReal = join(world, 'glob*root')
  mkdirSync(globReal)
  bare(join(globReal, 'proj.git'))
  bare(join(world, 'globXroot', 'a.git'))
  const globRoot = join(home, 'hub-glob')
  symlinkSync(globReal, globRoot)

  return { world, home, root, rootReal, oddRoot, oddReal, globRoot }
}
const W = buildWorld()
const PROJ_CANON = realpathSync(join(W.rootReal, 'proj.git'))

afterAll(() => {
  rmSync(SHARED, { recursive: true, force: true })
})

// ── 判定表的跑法 ───────────────────────────────────────────────────────────────

let runSeq = 0

type GateRun = {
  code: number
  stdout: string
  stderr: string
  /** 哨兵记下的内容；没被 exec 就是 undefined。 */
  exec: string | undefined
}

function gate(
  command: string | undefined,
  options: {
    args?: readonly string[]
    env?: Record<string, string>
    home?: string
  } = {},
): GateRun {
  const log = join(SHARED, `sentinel-${++runSeq}.log`)
  const env: Record<string, string> = {
    HOME: options.home ?? W.home,
    PATH: `${SENTINEL_BIN}:${SYSTEM_PATH}`,
    SENTINEL_LOG: log,
    ...options.env,
  }
  if (command !== undefined) env.SSH_ORIGINAL_COMMAND = command
  const result = Bun.spawnSync([SCRIPT, ...(options.args ?? [W.root])], {
    // sshd 在 $HOME 里起 command=；这里故意不在：~/ 与相对路径必须按 $HOME 展开，不能靠 $PWD。
    cwd: '/',
    env,
    stdin: 'ignore',
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exec: existsSync(log) ? readFileSync(log, 'utf8') : undefined,
  }
}

function expectOneLine(stderr: string): void {
  expect(stderr.endsWith('\n')).toBe(true)
  expect(stderr.slice(0, -1)).not.toContain('\n')
}

function expectDenied(run: GateRun, reason: string): void {
  // 先看哨兵：放行了的话，这一条比退出码更说明问题。
  expect(run.exec).toBeUndefined()
  expect(existsSync(MARKER)).toBe(false)
  expect(run.code).toBe(3)
  expect(run.stdout).toBe('')
  expectOneLine(run.stderr)
  expect(run.stderr).toStartWith('[handoff-git-gate] 拒绝：')
  expect(run.stderr).toContain(reason)
}

function expectServed(
  run: GateRun,
  service: 'upload-pack' | 'receive-pack',
  canonical: string,
): void {
  expect(run.stderr).toBe('')
  expect(run.code).toBe(0)
  expect(run.exec).toBe(`argv0=git-${service}\nargc=1\narg=${canonical}\n`)
}

const NO_REPO = '根目录下没有这个仓'
const NOT_ONLY = '只放行'
const QUOTES = '恰好包在一对单引号里'
const CHARSET = '不允许的字符'
const DOTDOT = '不许有 .. 段'

// ── 放行 ───────────────────────────────────────────────────────────────────────

describe('放行：exec 的是规范化路径，且只有这一个参数', () => {
  test.each([
    [
      '绝对路径经软链的根目录',
      `git-upload-pack '${W.root}/proj.git'`,
      'upload-pack',
    ],
    [
      '绝对路径用根目录的真实目录',
      `git-upload-pack '${W.rootReal}/proj.git'`,
      'upload-pack',
    ],
    [
      '绝对路径已经是物理路径',
      `git-receive-pack '${PROJ_CANON}'`,
      'receive-pack',
    ],
    ['URL 末尾带 /', `git-receive-pack '${W.root}/proj.git/'`, 'receive-pack'],
    [
      '~/ 形式 + git upload-pack 空格形式',
      "git upload-pack '~/hub/proj.git'",
      'upload-pack',
    ],
    [
      '相对路径 + git receive-pack 空格形式',
      "git receive-pack 'hub/proj.git'",
      'receive-pack',
    ],
    [
      '根目录内的软链指向根目录内的仓',
      `git-upload-pack '${W.root}/inner-link.git'`,
      'upload-pack',
    ],
  ] as const)('%s', (_label, command, service) => {
    expectServed(gate(command), service, PROJ_CANON)
  })

  test('物理路径里有空格与 $()：原样作为一个参数交出去，不经 shell 再求值', () => {
    expectServed(
      gate("git-upload-pack '~/hub-odd/proj.git'", { args: [W.oddRoot] }),
      'upload-pack',
      realpathSync(join(W.oddReal, 'proj.git')),
    )
  })

  test('GIT_* 在闸门里就被清掉，只留 GIT_PROTOCOL', () => {
    const run = gate(`git-upload-pack '${W.root}/proj.git'`, {
      env: {
        GIT_PROTOCOL: 'version=2',
        GIT_DIR: W.world,
        GIT_EXEC_PATH: W.world,
        GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='touch ${MARKER}'`,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'uploadpack.packObjectsHook',
        GIT_CONFIG_VALUE_0: `touch ${MARKER}`,
        GIT_TRACE: TRACE,
      },
    })
    // 闸门自己那条 `git config` 若还吃这些变量，GIT_TRACE 就会写出这个文件。
    expect(existsSync(TRACE)).toBe(false)
    expect(existsSync(MARKER)).toBe(false)
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    expect(run.exec).toBe(
      `argv0=git-upload-pack\nargc=1\narg=${PROJ_CANON}\nGIT_PROTOCOL=version=2\n`,
    )
  })
})

// ── 拒绝：路径 ─────────────────────────────────────────────────────────────────

describe('拒绝：路径', () => {
  test.each([
    [
      '越界绝对路径：根目录外的真裸仓',
      `git-upload-pack '${W.world}/outside.git'`,
      NO_REPO,
    ],
    [
      '越界绝对路径：前缀相同的兄弟目录',
      `git-receive-pack '${W.home}/hub-real-evil/a.git'`,
      NO_REPO,
    ],
    [
      '../ 穿越：根目录/..',
      `git-upload-pack '${W.root}/../outside.git'`,
      DOTDOT,
    ],
    [
      '../ 穿越：进仓再上两层',
      `git-receive-pack '${W.root}/proj.git/../../../outside.git'`,
      DOTDOT,
    ],
    ['../ 穿越：~/ 形式', "git-upload-pack '~/hub/../../outside.git'", DOTDOT],
    [
      '../ 穿越：相对形式',
      "git-upload-pack 'hub/../hub-real-evil/a.git'",
      DOTDOT,
    ],
    ['../ 穿越：结尾的 ..', `git-upload-pack '${W.root}/proj.git/..'`, DOTDOT],
    ['根下软链指向根外的仓', `git-upload-pack '${W.root}/escape.git'`, NO_REPO],
    [
      '根下软链目录指向根外',
      `git-receive-pack '${W.root}/linkdir/outside.git'`,
      NO_REPO,
    ],
    [
      '非 .git 路径（它本身是个真裸仓）',
      `git-upload-pack '${W.root}/plain'`,
      '<名字>.git',
    ],
    ['只有 .git 没有名字', `git-upload-pack '${W.root}/.git'`, '<名字>.git'],
    [
      '名字是 .git，软链到一个非 .git 目录',
      `git-upload-pack '${W.root}/alias.git'`,
      '解析之后不是',
    ],
    [
      '非裸仓：core.bare=false',
      `git-receive-pack '${W.root}/nonbare.git'`,
      '不是裸仓',
    ],
    [
      '非裸仓：带工作区的仓',
      `git-receive-pack '${W.root}/worktree.git'`,
      '不是裸仓',
    ],
    [
      '非裸仓：工作区仓里的 .git',
      `git-receive-pack '${W.root}/worktree.git/.git'`,
      '<名字>.git',
    ],
    [
      '裸仓里藏着一个 .git（upload-pack 会先进那里）',
      `git-upload-pack '${W.root}/nested.git'`,
      '不是裸仓',
    ],
    [
      '仓不存在：闸门不建仓',
      `git-receive-pack '${W.root}/missing.git'`,
      NO_REPO,
    ],
    ['是文件不是目录', `git-upload-pack '${W.root}/file.git'`, NO_REPO],
    ['空路径', "git-upload-pack ''", '路径是空的'],
    ['~<用户>/ 形式', "git-upload-pack '~root/x.git'", '~<用户>/'],
    [
      '以 - 开头（会被当成选项）',
      "git-upload-pack '--help.git'",
      '不能以 - 开头',
    ],
  ] as const)('%s', (_label, command, reason) => {
    expectDenied(gate(command), reason)
  })

  test('根目录的物理路径里有 *：按字面比较，不当通配', () => {
    // 先证明这个根目录本身是好的，下面那一条才说明问题。
    expectServed(
      gate("git-upload-pack '~/hub-glob/proj.git'", { args: [W.globRoot] }),
      'upload-pack',
      realpathSync(join(W.world, 'glob*root', 'proj.git')),
    )
    expectDenied(
      gate(`git-upload-pack '${W.world}/globXroot/a.git'`, {
        args: [W.globRoot],
      }),
      NO_REPO,
    )
  })

  test('$HOME 不是绝对路径时，相对路径与 ~/ 都拒绝', () => {
    expectDenied(
      gate("git-upload-pack 'hub/proj.git'", { home: 'relative-home' }),
      '$HOME 不是绝对路径',
    )
    expectDenied(
      gate("git-upload-pack '~/hub/proj.git'", { home: '' }),
      '$HOME 不是绝对路径',
    )
  })
})

// ── 拒绝：命令 ─────────────────────────────────────────────────────────────────

describe('拒绝：命令', () => {
  test.each([
    ['git-upload-archive', `git-upload-archive '${W.root}/proj.git'`, NOT_ONLY],
    [
      'git upload-archive（空格形式）',
      `git upload-archive '${W.root}/proj.git'`,
      NOT_ONLY,
    ],
    ['空命令', '', '没有命令'],
    ['sh -c', `sh -c 'git-upload-pack ${W.root}/proj.git'`, NOT_ONLY],
    ['bash（交互 shell）', 'bash -i', NOT_ONLY],
    ['scp 上传', `scp -t ${W.root}`, NOT_ONLY],
    ['scp 下载', `scp -f ${W.root}/proj.git/config`, NOT_ONLY],
    ['sftp 子系统（internal-sftp）', 'internal-sftp', NOT_ONLY],
    ['sftp 子系统（sftp-server）', '/usr/lib/openssh/sftp-server', NOT_ONLY],
    [
      'rsync',
      `rsync --server --sender -vlogDtpre.iLsfxC . ${W.root}/`,
      NOT_ONLY,
    ],
    [
      'git 的其他子命令',
      `git config --file ${W.root}/proj.git/config core.bare`,
      NOT_ONLY,
    ],
    ['动词后面没有路径', 'git-upload-pack', NOT_ONLY],
    ['动词大小写不对', `Git-Upload-Pack '${W.root}/proj.git'`, NOT_ONLY],
    ['动词与路径之间两个空格', `git-upload-pack  '${W.root}/proj.git'`, QUOTES],
    [
      '动词与路径之间是制表符',
      `git-upload-pack\t'${W.root}/proj.git'`,
      NOT_ONLY,
    ],
    ['多带一个选项', `git-upload-pack --strict '${W.root}/proj.git'`, QUOTES],
    ['路径没带引号', `git-upload-pack ${W.root}/proj.git`, QUOTES],
    ['路径用双引号', `git-upload-pack "${W.root}/proj.git"`, QUOTES],
    [
      '只有前半个引号（NUL 截断后的残形）',
      `git-upload-pack '${W.root}/proj.git`,
      QUOTES,
    ],
    [
      '两段引号（两个路径）',
      `git-upload-pack '${W.root}/proj.git' '${W.world}/outside.git'`,
      CHARSET,
    ],
  ] as const)('%s', (_label, command, reason) => {
    expectDenied(gate(command), reason)
  })

  test('交互登录：SSH_ORIGINAL_COMMAND 根本不存在', () => {
    expectDenied(gate(undefined), '没有命令')
  })

  test('命令超过 4096 字节', () => {
    expectDenied(
      gate(`git-upload-pack '${W.root}/${'a'.repeat(5000)}.git'`),
      '4096',
    )
  })
})

// ── 拒绝：注入 ─────────────────────────────────────────────────────────────────

describe('拒绝：shell 元字符与控制字符（标记文件始终不出现）', () => {
  const touch = `touch ${MARKER}`
  test.each([
    ['; 在引号外', `git-upload-pack '${W.root}/proj.git'; ${touch}`, QUOTES],
    ['; 在引号内', `git-upload-pack '${W.root}/proj.git;${touch}'`, CHARSET],
    ['&& 在引号外', `git-upload-pack '${W.root}/proj.git' && ${touch}`, QUOTES],
    ['| 在引号外', `git-receive-pack '${W.root}/proj.git' | ${touch}`, QUOTES],
    ['$() 在引号内', `git-upload-pack '${W.root}/$(${touch}).git'`, CHARSET],
    ['$() 顶替动词', `$(${touch}) '${W.root}/proj.git'`, NOT_ONLY],
    ['反引号在引号内', `git-upload-pack '${W.root}/\`${touch}\`.git'`, CHARSET],
    ['IFS 变量展开', `git-upload-pack '${W.root}/proj\${IFS}.git'`, CHARSET],
    ['换行在引号外', `git-upload-pack '${W.root}/proj.git'\n${touch}`, QUOTES],
    ['换行在引号内', `git-upload-pack '${W.root}/proj\n.git'`, CHARSET],
    ['回车', `git-upload-pack '${W.root}/proj.git\r'`, CHARSET],
    ['制表符在路径里', `git-upload-pack '${W.root}/pr\toj.git'`, CHARSET],
    ['其他控制字符 \\x01', `git-upload-pack '${W.root}/proj\x01.git'`, CHARSET],
    ['ESC 序列', `git-upload-pack '${W.root}/proj\x1b[31m.git'`, CHARSET],
    ['DEL', `git-upload-pack '${W.root}/proj\x7f.git'`, CHARSET],
    ['非 ASCII', `git-upload-pack '${W.root}/项目.git'`, CHARSET],
    ['空格', `git-upload-pack '${W.root}/a b.git'`, CHARSET],
    ['反斜杠', `git-upload-pack '${W.root}/a\\b.git'`, CHARSET],
    ["git 的 '\\'' 转义", `git-upload-pack '${W.root}/it'\\''s.git'`, CHARSET],
    ["git 的 '\\!' 转义", `git-upload-pack '${W.root}/bang'\\!'.git'`, CHARSET],
    ['glob', `git-upload-pack '${W.root}/*.git'`, CHARSET],
    ['重定向', `git-upload-pack '${W.root}/proj.git>${MARKER}'`, CHARSET],
  ] as const)('%s', (_label, command, reason) => {
    expectDenied(gate(command), reason)
  })

  test('NUL 送不进 SSH_ORIGINAL_COMMAND：环境变量是 C 字符串，连进程都起不来', () => {
    // sshd 那一侧同样拒收带 NUL 的 exec 请求。真能到闸门的只有截断后的残形，
    // 见「拒绝：命令」里的「只有前半个引号」。
    expect(() =>
      Bun.spawnSync([SCRIPT, W.root], {
        env: {
          PATH: SYSTEM_PATH,
          SSH_ORIGINAL_COMMAND: `git-upload-pack '${W.root}/proj.git\0'; ${touch}`,
        },
      }),
    ).toThrow()
    expect(existsSync(MARKER)).toBe(false)
  })
})

// ── 闸门自身的配置错 ───────────────────────────────────────────────────────────

describe('配置错：退出码 2，有效的请求也不放行', () => {
  const valid = `git-upload-pack '${W.root}/proj.git'`
  test.each([
    ['没有参数', [], 'handoff-git-gate.sh <根目录>'],
    ['根目录是相对路径', ['hub'], '绝对路径'],
    ['根目录不存在', [join(W.home, 'nope')], '根目录不存在'],
    ['根目录是 /', ['/'], '不能是 /'],
    ['多一个参数', [W.root, 'extra'], '只能有一个参数'],
  ] as const)('%s', (_label, args, reason) => {
    const run = gate(valid, { args })
    expect(run.exec).toBeUndefined()
    expect(run.code).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain(reason)
  })
})

// ── 真 git 端到端 ──────────────────────────────────────────────────────────────

/**
 * 一份新的中枢与一份本地仓库。中枢的 `command=` 取自 `authorized-key` 真生成的那一行，
 * 所以这里同时验证了那一行能被 `/bin/sh -c` 原样跑起来。
 */
function hub() {
  const base = mkdtempSync(join(SHARED, 'e2e-'))
  const home = join(base, 'hub-home')
  const rootReal = join(home, 'repos-real')
  const root = join(home, 'repos')
  mkdirSync(rootReal, { recursive: true })
  symlinkSync('repos-real', root)
  gitOk(['init', '-q', '--bare', join(rootReal, 'proj.git')])
  gitOk(['init', '-q', '--bare', join(base, 'outside.git')])

  const pub = join(base, 'key.pub')
  writeFileSync(pub, `${PUBKEY}\n`)
  const line = Bun.spawnSync(
    [SCRIPT, 'authorized-key', '--root', root, '--pubkey', pub],
    { env: { PATH: SYSTEM_PATH } },
  ).stdout.toString()
  const forced = line.match(/^restrict,command="([^"]+)" /)?.[1]
  if (forced === undefined)
    throw new Error(`authorized-key 没给出那一行：${line}`)

  const wrapLog = join(base, 'wrap.log')
  const env = {
    HOME: join(base, 'client-home'),
    GIT_SSH_COMMAND: SSH,
    WRAP_LOG: wrapLog,
    HUB_HOME: home,
    HUB_PATH: SYSTEM_PATH,
    HUB_FORCED_COMMAND: forced,
  }
  const client = join(base, 'client')
  gitOk(['init', '-q', '-b', 'main', client], { env })
  writeFileSync(join(client, 'hello.txt'), 'handoff\n')
  gitOk(['add', 'hello.txt'], { cwd: client, env })
  gitOk(['commit', '-q', '-m', 'first'], { cwd: client, env })
  const head = gitOk(['rev-parse', 'HEAD'], { cwd: client, env })
  return {
    base,
    home,
    root,
    rootReal,
    client,
    head,
    env,
    sent: () => (existsSync(wrapLog) ? readFileSync(wrapLog, 'utf8') : ''),
    refOnHub: (ref: string) =>
      git([
        '--git-dir',
        join(rootReal, 'proj.git'),
        'rev-parse',
        '--verify',
        '-q',
        ref,
      ]).stdout.trim(),
  }
}

describe('真 git 经闸门', () => {
  test('push 进中枢裸仓再 fetch 回来（根目录是软链；ssh:// 绝对路径与 ~/ 形式；协议 v2）', () => {
    const h = hub()
    const push = git(
      [
        'push',
        `ssh://hub${h.root}/proj.git`,
        'HEAD:refs/heads/main',
        'HEAD:refs/qianmo/wip/dev/main',
      ],
      { cwd: h.client, env: h.env },
    )
    expect(push.stderr).not.toContain('handoff-git-gate')
    expect(push.code).toBe(0)
    expect(h.refOnHub('refs/heads/main')).toBe(h.head)
    expect(h.refOnHub('refs/qianmo/wip/dev/main')).toBe(h.head)

    const other = join(h.base, 'other')
    gitOk(['init', '-q', other], { env: h.env })
    const fetch = git(
      [
        '-c',
        'protocol.version=2',
        'fetch',
        'hub:~/repos/proj.git',
        'refs/qianmo/wip/dev/main:refs/remotes/hub/wip',
      ],
      { cwd: other, env: h.env },
    )
    expect(fetch.code).toBe(0)
    expect(
      gitOk(['rev-parse', 'refs/remotes/hub/wip'], { cwd: other, env: h.env }),
    ).toBe(h.head)
    expect(
      gitOk(['show', 'refs/remotes/hub/wip:hello.txt'], {
        cwd: other,
        env: h.env,
      }),
    ).toBe('handoff')

    // 客户端真发出去的就是文件头注里的那两种形状。
    expect(h.sent()).toBe(
      `git-receive-pack '${h.root}/proj.git'\ngit-upload-pack '~/repos/proj.git'\n`,
    )
  })

  test('相对路径、git upload-pack / receive-pack 空格形式、协议 v0、URL 末尾的 /', () => {
    const h = hub()
    const push = git(
      [
        'push',
        '--receive-pack',
        'git receive-pack',
        'hub:repos-real/proj.git',
        'HEAD:refs/heads/main',
      ],
      { cwd: h.client, env: h.env },
    )
    expect(push.code).toBe(0)
    expect(h.refOnHub('refs/heads/main')).toBe(h.head)

    const fetch = git(
      [
        '-c',
        'protocol.version=0',
        'fetch',
        '--upload-pack',
        'git upload-pack',
        'hub:repos/proj.git',
        'main:refs/remotes/hub/main',
      ],
      { cwd: h.client, env: h.env },
    )
    expect(fetch.code).toBe(0)

    const listed = git(
      ['ls-remote', `ssh://hub${h.root}/proj.git/`, 'refs/heads/main'],
      {
        cwd: h.client,
        env: h.env,
      },
    )
    expect(listed.code).toBe(0)
    expect(listed.stdout).toBe(`${h.head}\trefs/heads/main\n`)

    expect(h.sent()).toBe(
      [
        "git receive-pack 'repos-real/proj.git'",
        "git upload-pack 'repos/proj.git'",
        `git-upload-pack '${h.root}/proj.git/'`,
        '',
      ].join('\n'),
    )
  })

  test('被拒时 git 失败、看得到闸门那一句，中枢上什么都没变', () => {
    const h = hub()
    const outside = git(
      ['push', `hub:${h.base}/outside.git`, 'HEAD:refs/heads/main'],
      {
        cwd: h.client,
        env: h.env,
      },
    )
    expect(outside.code).not.toBe(0)
    expect(outside.stderr).toContain(`[handoff-git-gate] 拒绝：${NO_REPO}`)
    expect(
      git([
        '--git-dir',
        join(h.base, 'outside.git'),
        'rev-parse',
        '--verify',
        '-q',
        'refs/heads/main',
      ]).stdout,
    ).toBe('')

    const missing = git(['push', 'hub:repos/new.git', 'HEAD:refs/heads/main'], {
      cwd: h.client,
      env: h.env,
    })
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('闸门不建仓')
    expect(existsSync(join(h.rootReal, 'new.git'))).toBe(false)

    const archive = git(['archive', '--remote=hub:repos/proj.git', 'HEAD'], {
      cwd: h.client,
      env: h.env,
    })
    expect(archive.code).not.toBe(0)
    expect(archive.stderr).toContain(`[handoff-git-gate] 拒绝：${NOT_ONLY}`)
  })
})

// ── authorized_keys 那一行 ─────────────────────────────────────────────────────

describe('authorized-key', () => {
  function authorizedKey(args: readonly string[]) {
    const result = Bun.spawnSync([SCRIPT, 'authorized-key', ...args], {
      env: { PATH: SYSTEM_PATH },
    })
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  }

  function pubkeyFile(content: string): string {
    const dir = mkdtempSync(join(SHARED, 'pub-'))
    const file = join(dir, 'key.pub')
    writeFileSync(file, content)
    return file
  }

  test('恰好一行：restrict + command="<闸门> <根目录>" + 公钥原样；不开任何转发', () => {
    const result = authorizedKey([
      '--root',
      W.root,
      '--pubkey',
      pubkeyFile(`${PUBKEY}\n`),
    ])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(
      `restrict,command="${SCRIPT} ${W.root}" ${PUBKEY}\n`,
    )
    const options = result.stdout.slice(0, result.stdout.indexOf('" ') + 1)
    expect(options).toBe(`restrict,command="${SCRIPT} ${W.root}"`)
    expect(options).not.toMatch(
      /port-forwarding|permitopen|permitlisten|agent-forwarding|x11-forwarding|pty|user-rc|environment=/i,
    )
  })

  test('没有结尾换行的公钥文件也认', () => {
    const result = authorizedKey([
      '--root',
      W.root,
      '--pubkey',
      pubkeyFile(PUBKEY),
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).toEndWith(` ${PUBKEY}\n`)
  })

  test.skipIf(Bun.which('ssh-keygen') === null)(
    'OpenSSH 自己的解析器认得这一行（ssh-keygen -l 读 authorized_keys 格式）',
    () => {
      const result = authorizedKey([
        '--root',
        W.root,
        '--pubkey',
        pubkeyFile(`${PUBKEY}\n`),
      ])
      const file = join(mkdtempSync(join(SHARED, 'ak-')), 'authorized_keys')
      writeFileSync(file, result.stdout)
      const parsed = Bun.spawnSync(['ssh-keygen', '-l', '-f', file])
      expect(parsed.stderr.toString()).toBe('')
      expect(parsed.exitCode).toBe(0)
      expect(parsed.stdout.toString()).toContain('handoff-gate@test (ED25519)')
    },
  )

  test.each([
    [
      '根目录是相对路径',
      () => ['--root', 'hub', '--pubkey', pubkeyFile(PUBKEY)],
      '绝对路径',
    ],
    [
      '根目录带空格（command= 要再过一次 shell）',
      () => ['--root', `${W.home}/a b`, '--pubkey', pubkeyFile(PUBKEY)],
      '只许',
    ],
    [
      '根目录带双引号',
      () => ['--root', `${W.home}/a"b`, '--pubkey', pubkeyFile(PUBKEY)],
      '只许',
    ],
    [
      '根目录带 ..',
      () => ['--root', `${W.root}/..`, '--pubkey', pubkeyFile(PUBKEY)],
      '..',
    ],
    [
      '根目录不存在',
      () => ['--root', join(W.home, 'nope'), '--pubkey', pubkeyFile(PUBKEY)],
      '根目录不存在',
    ],
    ['缺 --pubkey', () => ['--root', W.root], '用法'],
    [
      '公钥文件不存在',
      () => ['--root', W.root, '--pubkey', join(W.home, 'nope.pub')],
      '公钥文件不存在',
    ],
    [
      '公钥已经带了选项',
      () => ['--root', W.root, '--pubkey', pubkeyFile(`restrict ${PUBKEY}\n`)],
      '不像一把 OpenSSH 公钥',
    ],
    [
      '给的是私钥',
      () => [
        '--root',
        W.root,
        '--pubkey',
        pubkeyFile(
          '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
        ),
      ],
      '恰好一行',
    ],
    [
      '两把公钥',
      () => [
        '--root',
        W.root,
        '--pubkey',
        pubkeyFile(`${PUBKEY}\n${PUBKEY}\n`),
      ],
      '恰好一行',
    ],
    [
      '公钥正文不是 base64',
      () => [
        '--root',
        W.root,
        '--pubkey',
        pubkeyFile('ssh-ed25519 AAAA"; rm -rf / x\n'),
      ],
      '不是 base64',
    ],
    [
      '不认识的参数',
      () => ['--root', W.root, '--from', '10.0.0.1'],
      '不认识的参数',
    ],
  ] as const)('拒绝：%s', (_label, args, reason) => {
    const result = authorizedKey(args())
    expect(result.code).toBe(2)
    // 失败时一个字节都不往 stdout 写：那里的内容是要被贴进 authorized_keys 的。
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(reason)
  })
})

describe('sshd 直接 exec 它', () => {
  test('在 git 索引里是 100755', () => {
    const out = Bun.spawnSync(
      ['git', 'ls-files', '-s', '--', 'demo/env/beta/ops/handoff-git-gate.sh'],
      { cwd: REPO },
    )
    expect(out.stdout.toString().split(/\s+/)[0]).toBe('100755')
  })
})
