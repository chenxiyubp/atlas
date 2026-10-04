// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `beta-up.sh` 的参数面：尾参透传与 `--print-wake-identity`（issue #38）。
 *
 * 病根是**已实现的能力用本仓库的部署脚本部署不出来**：`--trust <节点>=<公钥>` 与
 * `--wake-sign` 由常驻/控制台实现着，而起法脚本对未知参数一律 `beta_die`，自己又没有
 * 任何表达它们的方式。2026-08-24 的舰队部署因此只能在部署机上手写瘦封装绕开这里的参数
 * 解析——那份封装不在仓库里，不可重复、不可交接。
 *
 * 所以这里钉四件事：
 *
 * ① `--` 之后的参数**原样**落到底层命令行上（node 腿 → resident，host 腿 → console）；
 * ② 透传不吃掉脚本自己那份策展：`--open-policy` 等仍在，且透传参数排在最后；
 * ③ `--print-wake-identity` 是前台查询：标准输出上只有那一行公钥，且用的是控制台**自己**
 *    那个配置根——拿另一个根打出来的公钥与控制台真正用于签名的不是同一把；
 * ④ 未知参数把本脚本支持的参数集一并打出来，且密钥值形式的尾参当场被拦下。
 *
 * 做法：把两个脚本复制进一棵临时「仓库」，并在复制出来的 common.sh 末尾把
 * `beta_start_process` 换成一个只**记录底层命令行**的桩。这样断言的就是真参数解析的
 * 产物，而不是对源码做字符串匹配；同时不起任何真进程、不碰端口。
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')

/**
 * 把 `beta_start_process` 换成一个只记账的桩。
 *
 * 注册中心那一步要放行，host 腿才走得到控制台：它的 `--ready <文件>` 是下游那个等待
 * 循环的唯一判据，所以桩把它写出来并返回；其余进程记完就整脚本退出——再往下是就绪
 * 探测，那要真端口，而本用例问的是命令行长什么样。
 */
const RECORDER = `
beta_start_process() {
  local name="$1"
  shift 2
  {
    printf '=== %s\\n' "$name"
    printf '%s\\n' "$@"
  } >>"$BETA_ARGV_LOG"
  local a prev='' ready=''
  for a in "$@"; do
    if [ "$prev" = '--ready' ]; then ready="$a"; fi
    prev="$a"
  done
  if [ -n "$ready" ]; then
    printf '{}\\n' >"$ready"
    return 0
  fi
  exit 0
}
`

/** 假的 occ 产物：记下 argv 与配置根，`--print-wake-identity` 时打一行身份。 */
const FAKE_OCC = `#!/usr/bin/env bun
const args = process.argv.slice(2)
const fs = require('node:fs')
fs.appendFileSync(
  process.env.FAKE_OCC_LOG,
  JSON.stringify({ args, configDir: process.env.OCC_CONFIG_DIR ?? '' }) + '\\n',
)
if (args.includes('--print-wake-identity')) {
  process.stdout.write('console=fake-public-key-0123456789\\n')
}
`

/**
 * 假的 `systemctl`：本包对它的全部要求就是「在不在」「--user 通不通」，外加几个查询。
 *
 * 有它这几条用例才走得到 H 腿的单元派生（issue #45）——真机上那一段永远执行，开发机上
 * 却因为没有 systemd 而整段跳过，于是「渲染出来的单元长什么样」在用例里是个盲区。
 * 它把每次调用记下来，断言据此看「脚本到底对 systemd 做了什么」。
 *
 * 两个查询的答案是**故意**给「还没装过」那一档：`is-enabled` 答 disabled、`is-active`
 * 答 inactive，于是首跑路径（enable、但绝不 start）会被完整走一遍。
 */
const FAKE_SYSTEMCTL = `#!/bin/bash
printf '%s\\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
for a in "$@"; do
  case "$a" in
    is-enabled) printf 'disabled\\n'; exit 1 ;;
    is-active)  printf 'inactive\\n'; exit 3 ;;
  esac
done
exit 0
`

/**
 * 两个 systemctl 桩**整个文件只写一次，并在这里先跑一次**。
 *
 * 不是洁癖，是 issue #56 那条偶发红的病根。macOS 对**新写出来的可执行文件的第一次
 * exec** 要走一遍策略扫描（Gatekeeper/`syspolicyd`）；同一个 inode 第二次起就只剩
 * 约 2 ms。实测本文件的用例：写这几个文件 1.7 ms、跑 `beta-up.sh` 124 ms，而那一次
 * 首执行扫描 **p50 就有 300 ms**——占单条用例七成以上的墙钟。它还没有上界：把
 * 「写一个新脚本、执行它一次」的负载并发跑起来（6 路），同一次扫描 p50 涨到 2273 ms、
 * 实测最坏 4278 ms，而写文件与跑脚本这两段纹丝不动。
 *
 * 单条用例的预算是 **5 000 ms**（`bunfig.toml` 里那个 `[test] timeout = 10000`
 * Bun 1.3.13 根本不读），于是「每个用例各写一份桩」就等于让每条用例都押一次那个没有
 * 上界的尾巴。完整 62 分片跑正是最能把它拉长的场景：每个分片都在不停 exec 新写出的
 * 文件。实测未修前 17 轮红 1 轮，红的正是本文件的
 * 「the host leg hands --wake-sign to console」——6034 ms，TimeoutError，
 * 而它的中位数只有 459 ms。
 *
 * 同一条结论 `ops/mirror-pull.test.ts` 已经写过一遍（那里是每个用例各拷一份脚本），
 * 本文件当时没跟上。**新增任何需要被直接 exec 的桩，都要挂在这里，不要放进
 * `scratch()`。**
 *
 * 桩本身没有每用例状态：它只往 `$FAKE_SYSTEMCTL_LOG` 追加，而那个路径仍然是每个用例
 * 自己的，所以共享 inode 不会让用例之间互相看见。
 */
const STUB_HOME = mkdtempSync(join(tmpdir(), 'qianmo-beta-up-args-bin-'))
const STUB_BIN = join(STUB_HOME, 'bin')
const NO_SYSTEMD_BIN = join(STUB_HOME, 'bin-no-systemd')
mkdirSync(STUB_BIN, { recursive: true })
writeFileSync(join(STUB_BIN, 'systemctl'), FAKE_SYSTEMCTL)
chmodSync(join(STUB_BIN, 'systemctl'), 0o755)
// 「这台机器上 systemd --user 用不了」那一档也要**钉死**，不能靠「PATH 上恰好没有
// systemctl」——Linux runner 上它就在 /usr/bin 下。装一个 `--user` 一律不通的桩，
// 于是那条分支在 macOS 与 Linux 上走的是同一条路。
mkdirSync(NO_SYSTEMD_BIN, { recursive: true })
writeFileSync(join(NO_SYSTEMD_BIN, 'systemctl'), '#!/bin/bash\nexit 1\n')
chmodSync(join(NO_SYSTEMD_BIN, 'systemctl'), 0o755)
// 首执行扫描在**模块作用域**付掉：这里没有任何用例的超时在跑。少了这两行，文件里
// 第一条用例仍然要独自扛那条尾巴。
for (const bin of [STUB_BIN, NO_SYSTEMD_BIN]) {
  Bun.spawnSync([join(bin, 'systemctl'), '--version'], {
    env: { ...process.env, FAKE_SYSTEMCTL_LOG: join(STUB_HOME, 'warmup.log') },
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

afterAll(() => {
  rmSync(STUB_HOME, { force: true, recursive: true })
})

const scratches: string[] = []

interface Scratch {
  readonly repo: string
  readonly root: string
  readonly argvLog: string
  readonly occLog: string
  /** XDG_CONFIG_HOME —— 单元只许装进这里，**绝不碰开发机真实的 ~/.config**。 */
  readonly xdg: string
  readonly systemctlLog: string
  readonly stubBin: string
  /** 里面那个 systemctl 对 `--user` 一律答不通。 */
  readonly noSystemdBin: string
}

/** 一棵临时「仓库」+ 一个临时内测根。 */
function scratch(): Scratch {
  const base = mkdtempSync(join(tmpdir(), 'qianmo-beta-up-args-'))
  scratches.push(base)
  const repo = join(base, 'repo')
  const beta = join(repo, 'demo/env/beta')
  mkdirSync(beta, { recursive: true })
  mkdirSync(join(repo, 'dist'), { recursive: true })
  copyFileSync(join(BETA_DIR, 'beta-up.sh'), join(beta, 'beta-up.sh'))
  // `--purge-state` 那条用例要跑它，而它第一步会调 beta-down.sh。两个都走
  // `/bin/bash <路径>`，脚本是被当数据读的，不产生新的可执行 inode，所以不必
  // 进 SCAN_ONCE（见文件头对 issue #56 的注）。
  for (const name of ['beta-reset.sh', 'beta-down.sh']) {
    copyFileSync(join(BETA_DIR, name), join(beta, name))
    chmodSync(join(beta, name), 0o755)
  }
  chmodSync(join(beta, 'beta-up.sh'), 0o755)
  const common = readFileSync(join(BETA_DIR, 'common.sh'), 'utf8')
  writeFileSync(join(beta, 'common.sh'), common + RECORDER)
  // common.sh source 它（demo_entry 的实现，真源在 demo/lib/entry.sh）。缺了它
  // common.sh 死在 source 阶段的 `set -e` 上，而这套用例断言的是命令行**内容**——
  // 于是失败会显示成「录到的命令行是空的」，看不出根因。
  mkdirSync(join(repo, 'demo/lib'), { recursive: true })
  copyFileSync(
    join(BETA_DIR, '..', '..', 'lib', 'entry.sh'),
    join(repo, 'demo/lib/entry.sh'),
  )
  // demo 入口的构建产物桩。`demo_entry` 只查在不在（真源 demo/lib/*.ts 与产物
  // dist/demo/*.js 二选一），而这套用例断言的是**命令行长什么样**，不跑那个入口——
  // RECORDER 在它被 exec 之前就把命令行录下来了。所以内容无所谓，存在才有所谓。
  mkdirSync(join(repo, 'dist/demo'), { recursive: true })
  for (const entry of ['p81-registry', 'p81-probe']) {
    writeFileSync(
      join(repo, `dist/demo/${entry}.js`),
      `// stub for ${entry}; beta-up-args 只断言命令行，不执行它\n`,
    )
  }
  writeFileSync(join(repo, 'dist/cli-node.js'), FAKE_OCC)
  chmodSync(join(repo, 'dist/cli-node.js'), 0o755)
  // 单元模板：**真源在仓库**，所以整棵原样带进临时仓库，用例断言的就是它们派生出来
  // 的那份内容。
  const ops = join(beta, 'ops')
  mkdirSync(ops, { recursive: true })
  for (const name of readdirSync(join(BETA_DIR, 'ops'))) {
    if (name.endsWith('.in') || name === 'mirror-pull.sh') {
      copyFileSync(join(BETA_DIR, 'ops', name), join(ops, name))
    }
  }

  const root = join(base, 'beta-root')
  mkdirSync(join(root, 'secrets', 'peers'), { recursive: true })
  // PSK 由 H 生成后分发，脚本在本机永不生成——所以用例得先把它放好。
  writeFileSync(join(root, 'secrets', 'transport-psk'), 'psk-for-test\n')
  chmodSync(join(root, 'secrets', 'transport-psk'), 0o600)

  return {
    repo,
    root,
    argvLog: join(base, 'argv.log'),
    occLog: join(base, 'occ.log'),
    xdg: join(base, 'xdg'),
    systemctlLog: join(base, 'systemctl.log'),
    stubBin: STUB_BIN,
    noSystemdBin: NO_SYSTEMD_BIN,
  }
}

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function runBetaUp(
  place: Scratch,
  args: readonly string[],
  options: { readonly systemd?: boolean } = {},
): ShellResult {
  // 默认带上假 systemctl；`systemd: false` 换成那个「--user 一律不通」的桩。
  const stubPath =
    options.systemd === false ? `${place.noSystemdBin}:` : `${place.stubBin}:`
  const child = Bun.spawnSync(
    ['/bin/bash', join(place.repo, 'demo/env/beta/beta-up.sh'), ...args],
    {
      cwd: place.repo,
      env: {
        ...process.env,
        // bun 要在 PATH 上（beta_require_occ 的解释器守卫，issue #40），git 要在 PATH 上
        // （节点腿给每个 agent 建真工作区）。
        PATH: `${stubPath}${dirname(process.execPath)}:/usr/bin:/bin`,
        // 单元只许落在临时目录里。这一条不是整洁，是安全：BETA_SYSTEMD_USER_DIR 的
        // 默认值是 $HOME/.config/systemd/user，不钉住它就等于让用例往开发机真实的
        // systemd 目录里装东西。
        XDG_CONFIG_HOME: place.xdg,
        FAKE_SYSTEMCTL_LOG: place.systemctlLog,
        // locale 故意不钉：继承开发机的 UTF-8，让 macOS 自带 bash 3.2 真的按多字节
        // 跑一遍被测脚本。issue #49 之前这里钉着 `LC_ALL=C` 绕开「变量紧跟全角标点」
        // 的 unbound variable，现在 demo/env 全树都写 `${var}`，钉 locale 反而会把
        // 这条真实回归掩盖掉。静态判据另由 shell-fullwidth-expansion.test.ts 守着。
        QIANMO_BETA_ROOT: place.root,
        BETA_ARGV_LOG: place.argvLog,
        FAKE_OCC_LOG: place.occLog,
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

/** 桩记下来的那几段底层命令行，按进程名分开。 */
function recorded(place: Scratch): Map<string, string[]> {
  const blocks = new Map<string, string[]>()
  if (!existsSync(place.argvLog)) return blocks
  let current: string[] | undefined
  for (const line of readFileSync(place.argvLog, 'utf8').split('\n')) {
    if (line.startsWith('=== ')) {
      current = []
      blocks.set(line.slice(4), current)
    } else if (line !== '' && current !== undefined) {
      current.push(line)
    }
  }
  return blocks
}

function writePeers(place: Scratch, lines: readonly string[]): void {
  writeFileSync(join(place.root, 'peers.conf'), `${lines.join('\n')}\n`)
  chmodSync(join(place.root, 'peers.conf'), 0o600)
}

afterEach(() => {
  for (const value of scratches.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

describe('beta-up.sh forwards tail arguments to the underlying command', () => {
  test('the node leg hands --trust to resident, verbatim and last', () => {
    const place = scratch()
    const result = runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-1',
      '--agent',
      'planner',
      '--',
      '--trust',
      'console=fake-public-key-0123456789',
    ])
    const argv = recorded(place).get('beta-1')
    expect({ argv: argv !== undefined, stderr: result.stderr }).toEqual({
      argv: true,
      stderr: result.stderr,
    })
    const args = argv ?? []
    expect(args.slice(0, 3)).toEqual([
      'bun',
      join(place.repo, 'dist/cli-node.js'),
      'resident',
    ])
    // 原样落到命令行上：值里的等号不被拆开，参数也不被重排。
    expect(args).toContain('--trust')
    expect(args[args.indexOf('--trust') + 1]).toBe(
      'console=fake-public-key-0123456789',
    )
    // 透传不吃掉脚本自己那份策展（任务策略两个开关由 resident-task-policy 用例守着）。
    expect(args).toContain('--open-policy')
    expect(args).toContain('--audit-signed-tasks')
    // 追加在**最后**：逃生门的语义是「真要覆盖上面某个默认值时，最后一个赢」。
    expect(args.indexOf('--trust')).toBeGreaterThan(
      args.indexOf('--open-policy'),
    )
    expect(args[args.length - 1]).toBe('console=fake-public-key-0123456789')
  })

  test('the host leg hands --wake-sign to console, verbatim and last', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const result = runBetaUp(place, ['--role', 'host', '--', '--wake-sign'])
    const blocks = recorded(place)
    const argv = blocks.get('console')
    expect({ argv: argv !== undefined, stderr: result.stderr }).toEqual({
      argv: true,
      stderr: result.stderr,
    })
    const args = argv ?? []
    expect(args.slice(0, 3)).toEqual([
      'bun',
      join(place.repo, 'dist/cli-node.js'),
      'console',
    ])
    expect(args[args.length - 1]).toBe('--wake-sign')
    // 两枚 token 仍然走文件形式——尾参是逃生门，不是把这条纪律换掉的旁路。
    expect(args).toContain('--view-token-file')
    expect(args).toContain('--admin-token-file')
    // 注册中心那一段没有被尾参污染：透传只发给这条腿的**底层命令**。
    expect(blocks.get('registry') ?? []).not.toContain('--wake-sign')
  })

  test('host 腿把服务器归属传给控制台 —— 走隧道的节点报 host= 而不是隧道口', () => {
    const place = scratch()
    writePeers(place, [
      'node beta-1 user=ops host=203.0.113.7 local-port=38631',
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
      'qianmo://beta-2/planner ws://198.51.100.9:38625',
    ])
    // `--only console`：不加的话有坐标行的 peers 会让 host 腿真的去建 SSH 隧道，
    // 用例会卡在 ssh 的超时上（实测一条跑了 90 s）。这里要测的是 argv，不是链路。
    const result = runBetaUp(place, ['--role', 'host', '--only', 'console'])
    const args = recorded(place).get('console') ?? []
    expect({ got: args.length > 0, stderr: result.stderr }).toEqual({
      got: true,
      stderr: result.stderr,
    })
    // beta-1 走隧道：端点是 ws://127.0.0.1:38631，那是宿主机上的口——归属必须报
    // 坐标行里的 host=，否则名册上四个节点看起来都在同一台机器上。
    expect(args).toContain('beta-1=203.0.113.7')
    // beta-2 直连：从端点解出主机名。
    expect(args).toContain('beta-2=198.51.100.9')
    expect(args.filter(one => one === '--node-server')).toHaveLength(2)
  })

  test('server= 覆盖 host=，传出去的是那个短名', () => {
    const place = scratch()
    writePeers(place, [
      'node beta-1 user=ops host=203.0.113.7 local-port=38631 server=p11',
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
    ])
    const result = runBetaUp(place, ['--role', 'host', '--only', 'console'])
    const args = recorded(place).get('console') ?? []
    expect({ got: args.includes('beta-1=p11'), stderr: result.stderr }).toEqual(
      {
        got: true,
        stderr: result.stderr,
      },
    )
    expect(args).not.toContain('beta-1=203.0.113.7')
  })

  test('multiple tail arguments keep their order and their spaces', () => {
    const place = scratch()
    const result = runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
      '--trust',
      'other=k2',
      '--label',
      'two words',
    ])
    expect(result.stderr).not.toContain('未知参数')
    const args = recorded(place).get('beta-2') ?? []
    expect(args.slice(-6)).toEqual([
      '--trust',
      'console=k1',
      '--trust',
      'other=k2',
      '--label',
      'two words',
    ])
  })

  // 注意它问的是**一棵没有尾参记录的树**。带上记录之后，一个空的 `--` 是「明确
  // 清空」而不是「什么都没说」——见下面那个 describe。
  test('a bare `--` with nothing after it changes nothing', () => {
    const bare = scratch()
    runBetaUp(bare, ['--role', 'node', '--node', 'beta-3', '--'])
    const plain = scratch()
    runBetaUp(plain, ['--role', 'node', '--node', 'beta-3'])
    const withDashes = recorded(bare).get('beta-3') ?? []
    const without = recorded(plain).get('beta-3') ?? []
    expect(withDashes.length).toBeGreaterThan(0)
    // 命令行里带着各自的临时仓库与临时内测根，所以比的是「把这两段抹掉之后完全一样」。
    const normalise =
      (place: Scratch) =>
      (value: string): string =>
        value.replace(place.repo, '<repo>').replace(place.root, '<root>')
    expect(withDashes.map(normalise(bare))).toEqual(
      without.map(normalise(plain)),
    )
  })
})

/**
 * 节点腿的尾参活过一次「停机 → 换产物 → 起机」（issue #111）。
 *
 * 现场是这样丢的：停机前 beta-2 的 argv 结尾带着一个 `--trust <节点>=<公钥>`，
 * `beta-down.sh` → 换产物 → `beta-up.sh --role node --node beta-2` 之后那一个不见了，
 * 其余（`--team` / `--port` / `--open-policy` / `--audit-signed-tasks` / `--timings` /
 * `--agent`）一字不差 —— 因为那些是脚本按 `--role`/`--node` 推导的，而尾参只存在于
 * 当初那一次命令行里。
 *
 * 丢的是策略不是显示项：节点照常启动、照常在名册上在线、拨号照常 426，所有存活判据
 * 全绿，只有真去发一个签名唤醒任务时才失败。
 */
describe('beta-up.sh 节点腿的尾参记录', () => {
  /** 把每次跑各自的临时路径抹掉，只留下形状。 */
  function shape(place: Scratch, node: string): string[] {
    return (recorded(place).get(node) ?? []).map(value =>
      value.replace(place.repo, '<repo>').replace(place.root, '<root>'),
    )
  }

  test('不带 `--` 重跑，argv 与上一次逐字节一致 —— 这就是 #111 的判据', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
    ])
    const before = shape(place, 'beta-2')
    expect(before.slice(-2)).toEqual(['--trust', 'console=k1'])

    // 「停机 → 换产物 → 起机」里的那次起机：谁都不会再把尾参抄一遍。
    runBetaUp(place, ['--role', 'node', '--node', 'beta-2'])

    expect(shape(place, 'beta-2')).toEqual(before)
  })

  test('带了新的 `--` 就以这一趟为准，并重写记录', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
    ])
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k2',
    ])
    expect(shape(place, 'beta-2').slice(-2)).toEqual(['--trust', 'console=k2'])

    // 记录跟着走，所以第三趟不带 `--` 沿用的是 k2 而不是 k1。
    runBetaUp(place, ['--role', 'node', '--node', 'beta-2'])
    expect(shape(place, 'beta-2').slice(-2)).toEqual(['--trust', 'console=k2'])
  })

  test('一个空的 `--` 是「明确清空」，不是「什么都没说」', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
    ])
    const cleared = runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
    ])
    // 撤销这个方向必须出声：它恰恰是唯一一个让人以为还开着的方向。
    expect(`${cleared.stdout}${cleared.stderr}`).toContain('会被清空')

    runBetaUp(place, ['--role', 'node', '--node', 'beta-2'])
    expect(shape(place, 'beta-2')).not.toContain('--trust')
  })

  test('沿用的时候要说出来，说的就是那一串', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
    ])
    const again = runBetaUp(place, ['--role', 'node', '--node', 'beta-2'])
    const said = `${again.stdout}${again.stderr}`
    expect(said).toContain('沿用上一次记下的尾参')
    expect(said).toContain('--trust console=k1')
  })

  test('每个节点各记各的，一棵树上不串', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
    ])
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-3',
      '--',
      '--trust',
      'console=k9',
    ])
    runBetaUp(place, ['--role', 'node', '--node', 'beta-2'])
    expect(shape(place, 'beta-2').slice(-2)).toEqual(['--trust', 'console=k1'])
  })

  /**
   * 含空白的尾参也活得过重启 —— 控制台那半边做不到，而那不是本可以不管的差别：
   * `console.env` 是一行 `KEY=值` 交给 systemd 分词，所以它对含空白的尾参只能 WARN
   * 一句「没被持久化」。这份记录一行一个参数、读写两边都是本脚本，没有理由继承那个
   * 限制。
   */
  test('含空白的尾参照样活过重启（console.env 做不到的那一格）', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--label',
      'two words',
    ])
    runBetaUp(place, ['--role', 'node', '--node', 'beta-2'])
    expect(shape(place, 'beta-2').slice(-2)).toEqual(['--label', 'two words'])
  })

  /**
   * 记录是 PASS_THROUGH 的**第二个来源**，那道 token 守卫必须也管得着它。
   *
   * 守卫本身跑在解析期（`--` 刚被吃进来那一刻），而记录是在 `run_node` 里才读
   * 回来的 —— 少了第二次调用，这条守卫就正好变成它自己那句话里说的「旁路」：
   * 手改一次记录文件，往后每一次不带 `--` 的重起都把 token 摆进 `ps` 里，而且
   * 一次都不会再提醒。
   */
  test('从记录里读回来的尾参也要过 token 守卫', () => {
    const place = scratch()
    // 命令行那条路进不来（解析期就被拦下），所以直接写记录 —— 文件头也确实
    // 邀请人手改它。
    mkdirSync(join(place.root, 'state'), { recursive: true })
    writeFileSync(
      join(place.root, 'state', 'beta-2.passthrough'),
      '--admin-token\nsupersecret\n',
    )
    const result = runBetaUp(place, ['--role', 'node', '--node', 'beta-2'])

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('--admin-token')
    // 拦下了就不该起进程。
    expect(recorded(place).get('beta-2')).toBeUndefined()
  })

  /**
   * `beta-reset.sh --purge-state` 会把记录一起带走 —— 那是对的（显式重置），
   * 但它清掉之后，下一次不带 `--` 的节点腿会起在一个**没有 --trust 的策略面**
   * 上，而所有存活判据照旧全绿。那正是 issue #111 那个形状换了一扇门进来。
   * 所以它必须点名说出来，而不是只提 timings。
   */
  test('--purge-state 会点名说它要清掉哪几份尾参记录', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
    ])
    const reset = Bun.spawnSync(
      [
        '/bin/bash',
        join(place.repo, 'demo/env/beta/beta-reset.sh'),
        '--purge-state',
      ],
      {
        cwd: place.repo,
        env: {
          ...process.env,
          PATH: `${place.stubBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          QIANMO_BETA_ROOT: place.root,
          XDG_CONFIG_HOME: place.xdg,
          FAKE_SYSTEMCTL_LOG: place.systemctlLog,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const said = `${reset.stdout.toString()}${reset.stderr.toString()}`
    expect(said).toContain('beta-2')
    expect(said).toContain('--trust console=k1')
  })

  test('记录是 0600 —— 里面会有 --trust 这类策略事实', () => {
    const place = scratch()
    runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
    ])
    const file = join(place.root, 'state', 'beta-2.passthrough')
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('beta-up.sh --print-wake-identity', () => {
  test('prints only the identity line, from the console config root', () => {
    const place = scratch()
    const result = runBetaUp(place, ['--print-wake-identity'])
    expect(result.exitCode).toBe(0)
    // 标准输出上只有那一行：它要能被 `$(...)` 直接接住喂给下一条命令的 --trust。
    expect(result.stdout).toBe('console=fake-public-key-0123456789\n')
    const calls = readFileSync(place.occLog, 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { args: string[]; configDir: string })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['console', '--print-wake-identity'])
    // 配置根必须和控制台那一份是同一个：另一个根里那把私钥是另一把，而症状只会在
    // 节点侧表现为验签失败。
    expect(calls[0]?.configDir).toBe(join(place.root, 'nodes/console/config'))
    // 它不是一次启动：没有任何进程被起过。
    expect(existsSync(place.argvLog)).toBe(false)
    expect(existsSync(join(place.root, 'run', 'console.pid'))).toBe(false)
  })

  test('carries the tail arguments into the query', () => {
    const place = scratch()
    // 身份由 --chat-from 决定。这一路与 `--role host -- --chat-from …` 必须问出同一把
    // 钥匙，否则分发出去的是一把控制台根本不用来签名的公钥，而症状只在节点侧表现为
    // 验签失败。
    const result = runBetaUp(place, [
      '--print-wake-identity',
      '--',
      '--chat-from',
      'qianmo://ops/operator',
    ])
    expect(result.exitCode).toBe(0)
    const call = JSON.parse(
      readFileSync(place.occLog, 'utf8').split('\n')[0] ?? '{}',
    ) as { args: string[] }
    expect(call.args).toEqual([
      'console',
      '--print-wake-identity',
      '--chat-from',
      'qianmo://ops/operator',
    ])
  })

  test('refuses to answer for the node leg', () => {
    const place = scratch()
    const result = runBetaUp(place, ['--print-wake-identity', '--role', 'node'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--print-wake-identity')
    expect(existsSync(place.occLog)).toBe(false)
  })
})

describe('beta-up.sh says what it accepts', () => {
  test('an unknown argument prints the whole supported set', () => {
    const place = scratch()
    const result = runBetaUp(place, ['--role', 'node', '--trust', 'a=b'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--trust')
    // 「本脚本支持的参数集」= 每一个开关都在，不是一句「用 --help 看用法」。
    for (const flag of [
      '--role host|node',
      '--node <名字>',
      '--agent <名字>',
      '--port <端口>',
      '--print-wake-identity',
      '-- <args>...',
    ]) {
      expect({ flag, shown: result.stderr.includes(flag) }).toEqual({
        flag,
        shown: true,
      })
    }
    // 顺手把出口指出来：这条路上最常见的未知参数就是该走尾参透传的那些。
    expect(result.stderr).toContain('把它放到 -- 后面透传')
  })

  test('a token value in the tail is refused before anything starts', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const result = runBetaUp(place, [
      '--role',
      'host',
      '--',
      '--admin-token',
      'super-secret-value',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--admin-token-file')
    // 关键是**没有任何进程被起过**：拦在起进程之前，密钥才没有进过任何一份进程列表。
    expect(existsSync(place.argvLog)).toBe(false)
    expect(result.stdout + result.stderr).not.toContain('super-secret-value')
  })
})

/**
 * H 腿的开机自启（issue #45）。
 *
 * 病根是内测环境里隧道与审计镜像都有 systemd 单元，**唯独控制台与注册中心没有**——
 * 两者都是裸进程，H 一重启就都没了、且不会自动回来。2026-08-24 部署里刚配好的四目标
 * 控制台同样是易失的。
 *
 * 这里钉的是「单元长什么样」而不是「systemd 收没收下」：后者要真机。四件事：
 * ① 两个单元真的被派生并装进 systemd --user 目录，且没有留下未替换的占位符；
 * ② 它们调的是**仓库脚本**，不是手写薄壳（薄壳正是 #38 那份不可交接的东西）；
 * ③ `--wake-sign` 这类尾参活过重启：它落进 console.env，单元从那里取；
 * ④ 注册中心那一趟（单元自己开机时跑的就是它）**不会**把 console.env 抹掉。
 */
describe('beta-up.sh --role host provisions systemd units for console and registry', () => {
  function unitText(place: Scratch, base: string): string {
    return readFileSync(join(place.xdg, 'systemd/user', base), 'utf8')
  }

  test('两个单元都装进了 systemd --user，且没有未替换的占位符', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const result = runBetaUp(place, ['--role', 'host'])
    expect(result.stderr).not.toContain('FAIL')

    for (const base of ['qianmo-registry.service', 'qianmo-console.service']) {
      expect(existsSync(join(place.root, 'ops', base))).toBe(true)
      const text = unitText(place, base)
      // 留下一个 @FOO@ 的后果是单元起不来，而报错只会说某个路径不存在。
      expect(text).not.toMatch(/@[A-Z_]+@/)
      expect(text).toContain('[Install]')
      // PATH 必须显式给：systemd --user 的 PATH 极小而整套脚本硬依赖 bun。
      expect(text).toMatch(/^Environment=PATH=.+/m)
    }
    // enable 了、但**没有** start：本脚本这一趟自己就在起进程，让 systemd 再起一次
    // 等于自己等自己。
    const calls = readFileSync(place.systemctlLog, 'utf8')
    expect(calls).toContain('--user enable qianmo-console.service')
    expect(calls).toContain('--user enable qianmo-registry.service')
    expect(calls).not.toContain('--user start qianmo-console.service')
    expect(calls).not.toContain('--user start qianmo-registry.service')
  })

  test('单元调的是仓库脚本，不是手写薄壳', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    runBetaUp(place, ['--role', 'host'])

    const registry = unitText(place, 'qianmo-registry.service')
    expect(registry).toContain(
      'demo/env/beta/beta-up.sh --role host --only links --only registry',
    )
    expect(registry).toContain('demo/env/beta/beta-down.sh registry')

    const console_ = unitText(place, 'qianmo-console.service')
    expect(console_).toContain(
      'demo/env/beta/beta-up.sh --role host --only console --',
    )
    expect(console_).toContain('demo/env/beta/beta-down.sh console')
    // 控制台排在注册中心之后：反过来的话开机头几十秒的空页面和「注册中心没起来」
    // 长得一模一样。
    expect(console_).toContain('Requires=qianmo-registry.service')
  })

  test('尾参活过重启：--wake-sign 落进 console.env，单元从那里取', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    runBetaUp(place, ['--role', 'host', '--', '--wake-sign'])

    const env = readFileSync(join(place.root, 'ops/console.env'), 'utf8')
    expect(env).toContain('CONSOLE_EXTRA_ARGS=--wake-sign')
    // systemd 只对 `$VAR` 这种写法分词；写成 `${VAR}` 会把整串当成一个参数。
    expect(unitText(place, 'qianmo-console.service')).toContain(
      '$CONSOLE_EXTRA_ARGS',
    )
  })

  test('注册中心那一趟不会把 console.env 抹掉', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    runBetaUp(place, ['--role', 'host', '--', '--wake-sign'])
    const before = readFileSync(join(place.root, 'ops/console.env'), 'utf8')

    // 开机时注册中心单元跑的正是这一条，而它没有尾参。若它照样重写 console.env，
    // 每次重启就会静默把签名唤醒关掉一次——而那个方向看起来还是「开着的」。
    runBetaUp(place, [
      '--role',
      'host',
      '--only',
      'links',
      '--only',
      'registry',
    ])
    expect(readFileSync(join(place.root, 'ops/console.env'), 'utf8')).toBe(
      before,
    )
  })

  test('--only 只起点名的那一块', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    runBetaUp(place, [
      '--role',
      'host',
      '--only',
      'console',
      '--',
      '--wake-sign',
    ])
    const blocks = recorded(place)
    expect(blocks.has('console')).toBe(true)
    expect(blocks.has('registry')).toBe(false)
  })

  test('--only 拼错 / 用在节点腿上当场拒绝，而不是安静地什么都不起', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    // 「一块都不匹配」若只是跳过，结果是一趟什么都没起还退 0——systemd 会把它记成
    // 一次成功的启动，而控制台根本不在。
    const typo = runBetaUp(place, ['--role', 'host', '--only', 'consle'])
    expect(typo.exitCode).not.toBe(0)
    expect(typo.stderr).toContain('--only 只认')

    const wrongLeg = runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-1',
      '--only',
      'console',
    ])
    expect(wrongLeg.exitCode).not.toBe(0)
    expect(wrongLeg.stderr).toContain('--only 只对 --role host 有意义')
  })

  test('systemd --user 用不了的机器上如实说「重启后不会自动回来」，而不是装作铺好了', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const result = runBetaUp(place, ['--role', 'host'], { systemd: false })
    expect(result.stdout).toContain('没有可用的 systemd --user')
    expect(result.stdout).toContain('不会**在重启后自动回来')
    expect(existsSync(join(place.xdg, 'systemd/user'))).toBe(false)
  })
})

/**
 * console.conf 的旧 schema（issue #45 的后半段）。
 *
 * `AUDIT_NODE` / `AUDIT_PATH` / `WAKE_NODE` 曾经也存在这里。改成「只认 peers.conf」之后
 * 它们再也没人读——**而没人读不等于没人写**：2026-08-24 的实查里 H 上那份 2026-08-18 的
 * console.conf 还整整齐齐写着它们。一份看着像配置、实际一个字都不生效的文件，会把下一个
 * 照着它配的人直接带沟里。
 */
describe('beta-up.sh reports and drops the legacy console.conf schema', () => {
  test('读到旧键要报出来，并在回写时删掉', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const conf = join(place.root, 'console.conf')
    writeFileSync(
      conf,
      [
        'LABEL=旧的页头',
        'AUDIT_NODE=beta-1',
        'AUDIT_PATH=/somewhere/trail.ndjson',
        'WAKE_NODE=beta-1',
        '',
      ].join('\n'),
    )
    chmodSync(conf, 0o600)

    const result = runBetaUp(place, ['--role', 'host'])
    for (const key of ['AUDIT_NODE', 'AUDIT_PATH', 'WAKE_NODE']) {
      expect(result.stdout).toContain(key)
    }
    expect(result.stdout).toContain('一个字都不生效')

    // 判的是**赋值行**没了，不是这三个词没出现过：回写出来的文件头会点名它们，
    // 好让下一个手改这个文件的人当场知道写了也不算数。
    const after = readFileSync(conf, 'utf8')
    const assignments = after
      .split('\n')
      .filter(line => /^[A-Z_]+=/.test(line))
      .map(line => line.split('=')[0])
    expect(assignments).toEqual(['LABEL'])
    // LABEL 照旧留着——它是这个文件现在**唯一**的用途。
    expect(after).toContain('LABEL=旧的页头')
  })

  test('没有旧键时一个字都不多说', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const result = runBetaUp(place, ['--role', 'host'])
    expect(result.stdout).not.toContain('旧 schema')
  })
})
