// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SSH 连接复用的护栏（issue #100）。
 *
 * 这条改动的效果是**数量**上的：一轮两千次连接建立 → 五次。所以护栏也必须是
 * 数量上的 —— 「看起来在复用其实没有」是这类改动最难发现的失败形态，而它在
 * 报告上与「复用生效了」长得一模一样。
 *
 * ## 怎么数
 *
 * 假一个 `ssh` 出来（经 `FleetConfig.sshBin`，与 `fleetTransport.test.ts` 同一个
 * 注入点，零 `mock.module`），让它把自己每次拿到的 argv 追加进一个日志文件。
 * 于是一轮跑完之后，「建了几次 master」「几条命令走了复用」「两条长命隧道带没
 * 带 `ControlPath=none`」全部是可数的。
 *
 * 真机上的数字另有实测，写在 PR 描述里：`cornna-p2` 20 条命令 20 → 1 次握手，
 * 经 IAP 的 `workbench-iap` 10 条命令 10 → 1 次。判据是 ssh 客户端 `-v` 里的
 * `Authenticated to` —— 那一行只在密钥交换 + 认证都完成之后才打印。
 */

/**
 * 场景预算一律写 30 s，不是 4 s（issue #102 的邻居）。
 *
 * 预算是**上限**，这些用例没有一条靠它到期来断言 —— 而 4 s 恰好卡在最坏路径的
 * 和上：`#sshRetry` 打满（退避 750 + 1500 ms）+ 假 `ssh` 起停 + SSH 复用建
 * master 那几趟，再加上 macOS 对每个新写的可执行文件收的首次执行策略扫描
 * （代价不是常数：空闲时约 70–100 ms，机器一忙实测涨到 1.8–2.5 s，没有上限）。
 * 完整 `verify` 里机器跑热之后就会撞墙，表现为「本该 pass 的用例以场景超时收
 * 场」，与被测逻辑毫无关系。
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SPAWN_MACHINES,
  FleetDriver,
  fleetConfigFromEnv,
} from '../fleet/driver.js'
import {
  CONTROL_DIR_BASE,
  CONTROL_DIR_PREFIX,
  CONTROL_PATH_TOKEN,
  CONTROL_PATH_TOKEN_BYTES,
  MASTER_IDLE_PERSIST_S,
  MASTER_OPEN_TIMEOUT_MS,
  SshMultiplex,
  TUNNEL_NO_MUX_ARGS,
  UNIX_SOCKET_PATH_MAX,
} from '../fleet/sshMux.js'
import {
  DEFAULT_SCENARIO_TIMEOUT_MS,
  FLEET_TIMEOUT_SCALE,
  runScenario,
} from '../runner.js'
import { ALL_SCENARIOS } from '../registry.js'
import { TRANSPORT_RETRY_ATTEMPTS } from '../transport.js'
import type { Scenario, ScenarioResult } from '../types.js'

/** 假 ssh 回给 `mktemp -d` 的那个根，形状与真的一致。 */
const FAKE_ROOT = '/home/fake/.cache/qianmo-acceptance/run.AAAABBBB'

const madeDirs: string[] = []
const openDrivers: FleetDriver[] = []
const openMuxes: SshMultiplex[] = []

afterEach(async () => {
  for (const driver of openDrivers.splice(0)) await driver.dispose()
  for (const mux of openMuxes.splice(0)) await mux.dispose()
  for (const dir of madeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 写一个会记账的假 `ssh`：每次调用把整条 argv 追加进 `log`，**一次调用一行**。
 *
 * 远端命令自己是多行的（`lines.join('\n')`），所以记账前先把换行折成字面量
 * `\n` —— 否则「一次调用」与「一行」对不上，数出来的连接数全是错的。
 *
 * `script` 是 bash 片段，进来时 `$cmd` 已经是最后一个参数（命令连接上就是远端
 * 命令原文，master / `-O` 那几条上是目标名）。
 */
/**
 * 整份文件**只写这一个**可执行 inode —— 假 `ssh` 靠软链复用它（issue #102）。
 *
 * macOS 对新写出来的可执行文件收一次首次执行检查（Gatekeeper / `syspolicyd`）。
 * **它的代价不是一个常数** —— 机器空闲时全新内容约 70–100 ms，而机器一忙实测
 * 涨到 1.8–2.5 s，**没有上限**；指向一个已经执行过的 inode 的软链稳定在 4.5 ms
 * 上下。所以「每条用例现写一个可执行文件」在本地几乎看不出来，一到跑满的
 * `verify` 或 CI 上就会把用例自己的超时预算吃穿 —— 表现为「本该 pass 的用例以
 * 超时收场」，与被测逻辑毫无关系。
 *
 * argv 日志的落点仍是**调用方给的外部路径**（`logPath()`），经一个不可执行的
 * `logpath` 文件传给 shim；每条用例的行为同样写在不可执行的 `behavior.sh` 里，
 * 按 `$0` 的目录去取，所以软链之间互不干扰。
 */
const SHIM_ROOT = mkdtempSync(join(tmpdir(), 'qm-ssh-shim-'))
const SHIM_REAL = join(SHIM_ROOT, 'ssh-real')
writeFileSync(
  SHIM_REAL,
  `#!/bin/bash\nargv="$*"\nd="$(dirname "$0")"\n` +
    `if [ -f "$d/logpath" ]; then\n` +
    `  printf '%s\\n' "\${argv//$'\\n'/\\\\n}" >> "$(cat "$d/logpath")"\n` +
    `fi\n` +
    // 真 `ssh -N` 会**一直活着**。第一版这里直接 exit 0，于是长命隧道在
    // 单测里生下来就是死的 —— 而驱动如今会问它死没死（#105），一问就当场
    // 说「隧道退了」，把本该测别的东西的用例带偏。挂住它，形状才对得上。
    `case " $* " in *" -M "*) ;; *" -N "*) exec sleep 300;; esac\n` +
    `cmd="\${@: -1}"\n. "$d/behavior.sh"\nexit 0\n`,
  { mode: 0o755 },
)
writeFileSync(join(SHIM_ROOT, 'behavior.sh'), 'true\n')
// **预热必须在模块作用域**：把那两秒扫描付在还没有任何用例计时器在跑的时候。
Bun.spawnSync([SHIM_REAL, 'warmup'], { stdout: 'ignore', stderr: 'ignore' })

/** 写一个假 `ssh`（软链 + 数据文件，不付扫描），返回它的绝对路径。 */
function fakeSsh(script: string, log: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
  madeDirs.push(dir)
  const bin = join(dir, 'ssh')
  symlinkSync(SHIM_REAL, bin)
  writeFileSync(join(dir, 'behavior.sh'), `${script}\n`)
  writeFileSync(join(dir, 'logpath'), log)
  return bin
}

/** 这一轮的 argv 日志落点。 */
function logPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-ssh-log-'))
  madeDirs.push(dir)
  return join(dir, 'argv.log')
}

function driver(sshBin: string, sshMultiplex: boolean): FleetDriver {
  const made = new FleetDriver({
    hosts: [
      {
        ssh: 'fake-host',
        node: 'beta-1',
        tunnelPort: 38_631,
        endpoint: 'ws://127.0.0.1:38631',
        configRoot: '/home/fake/qianmo-beta/nodes/beta-1/config',
        occPath: '/home/fake/atlas-beta/dist/cli-node.js',
      },
    ],
    spawnMachines: [{ ssh: 'fake-host', label: 'fake', repoRel: 'atlas-beta' }],
    psk: {},
    sshBin,
    sshMultiplex,
  })
  openDrivers.push(made)
  return made
}

/** 一次 argv 记账的分类。 */
interface Tally {
  readonly all: readonly string[]
  /** `ssh -M -N …` —— 一次**真握手**。 */
  readonly masters: readonly string[]
  /** `ssh -O check` / `ssh -O exit` —— 纯本地 socket，不发网络包。 */
  readonly control: readonly string[]
  /** `-N -R` / `-N -L` 两条长命隧道。 */
  readonly tunnels: readonly string[]
  /** 剩下的就是远端命令。 */
  readonly commands: readonly string[]
}

function tally(log: string): Tally {
  const all = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '')
    : []
  const has = (line: string, flag: string): boolean =>
    ` ${line} `.includes(` ${flag} `)
  const masters = all.filter(l => has(l, '-M'))
  const control = all.filter(
    l => l.includes('-O check') || l.includes('-O exit'),
  )
  const tunnels = all.filter(
    l => !has(l, '-M') && (has(l, '-R') || has(l, '-L')),
  )
  const commands = all.filter(
    l => !masters.includes(l) && !control.includes(l) && !tunnels.includes(l),
  )
  return { all, masters, control, tunnels, commands }
}

/** 一条只做「开一次性目录」的场景 —— 它对一台机器发好几条远端命令。 */
const OPEN_LAUNCHER: Scenario = {
  id: 'launcher/fake-open',
  dimension: 'launcher',
  title: '只开一次性目录，什么都不跑',
  expected: '开得出来',
  requires: ['run-launcher'],
  async run(ctx) {
    const host = await ctx.driver.launcherHost(ctx)
    return { ok: true, actual: host.betaRoot, evidence: [] }
  },
}

const OPEN_SCRATCH = `if [[ "$cmd" == *'$d/config'* ]]; then printf '%s\\n' '${FAKE_ROOT}'; exit 0; fi`
const HAPPY = [
  OPEN_SCRATCH,
  `if [[ "$cmd" == *"pgrep"* ]]; then exit 0; fi`,
  `if [[ "$cmd" == *'$HOME'* ]]; then printf '/home/fake\\n'; exit 0; fi`,
].join('\n')

/** 结果里全部 `log` 证据拼成一段。 */
function logsOf(result: ScenarioResult): string {
  return result.evidence
    .filter(e => e.label === 'log')
    .map(e => e.value)
    .join('\n')
}

describe('ControlPath 的长度账（issue #100 ①）', () => {
  it('展开后远在 macOS 的 104 字节上限之内', () => {
    const mux = new SshMultiplex({ sshBin: 'ssh', sshArgs: [], enabled: true })
    openMuxes.push(mux)
    const path = mux.controlPath()
    expect(path.startsWith(`${CONTROL_DIR_BASE}/${CONTROL_DIR_PREFIX}`)).toBe(
      true,
    )
    expect(path.endsWith(`/${CONTROL_PATH_TOKEN}`)).toBe(true)
    // ssh 自己去展开 `%C`（40 位十六进制），所以要核的是展开后的长度。
    const expanded =
      path.length - CONTROL_PATH_TOKEN.length + CONTROL_PATH_TOKEN_BYTES
    expect(expanded).toBeLessThan(UNIX_SOCKET_PATH_MAX)
    // 留够余量：顶着上限过一次不算过。59 vs 104。
    expect(expanded).toBeLessThan(80)
  })

  it('两轮并行跑各占一个目录，socket 不会互相踩', () => {
    const a = new SshMultiplex({ sshBin: 'ssh', sshArgs: [], enabled: true })
    const b = new SshMultiplex({ sshBin: 'ssh', sshArgs: [], enabled: true })
    openMuxes.push(a, b)
    expect(a.controlPath()).not.toBe(b.controlPath())
  })

  it('建 master 打满也炸不掉场景预算', () => {
    // `#read` / `#diag` 的退避重发会连 master 一起再试，所以最坏是
    // `TRANSPORT_RETRY_ATTEMPTS` 次 × 每次的 master 预算。它必须小于真机腿的
    // 场景预算 —— 否则一次链路失败会以「场景超时」的形态收场，而超时记的是
    // 「套件自己炸了」，那条 `errorKind='transport'` 的分类就白做了。
    const worst = MASTER_OPEN_TIMEOUT_MS * TRANSPORT_RETRY_ATTEMPTS
    expect(worst).toBeLessThan(
      DEFAULT_SCENARIO_TIMEOUT_MS * FLEET_TIMEOUT_SCALE,
    )
  })

  it('关着复用时一个目录都不开', () => {
    const mux = new SshMultiplex({ sshBin: 'ssh', sshArgs: [], enabled: false })
    openMuxes.push(mux)
    expect(mux.enabled).toBe(false)
    expect(mux.establishedTargets()).toEqual([])
  })
})

describe('复用真的生效 —— 数连接建立次数（issue #100）', () => {
  it('开着：一台机器只建一次 master，其余全走复用', async () => {
    const log = logPath()
    const result = await runScenario(
      OPEN_LAUNCHER,
      driver(fakeSsh(HAPPY, log), true),
      30_000,
      false,
      1,
    )
    expect(result.outcome).toBe('pass')
    const t = tally(log)
    // **这就是这条 issue 的那个数字**：命令好几条，真握手只有一次。
    expect(t.masters).toHaveLength(1)
    expect(t.commands.length).toBeGreaterThan(2)
    // 每一条命令都带着复用参数 —— 少一条就是它自己又建了一次连接。
    for (const line of t.commands) {
      expect(line).toContain('ControlMaster=no')
      expect(line).toContain(`ControlPath=${CONTROL_DIR_BASE}/`)
      expect(line).toContain(CONTROL_PATH_TOKEN)
    }
    // master 起没起来问的是 socket（`-O check`），不是「fork 成功了没有」。
    expect(t.control.some(l => l.includes('-O check'))).toBe(true)
  }, 60_000)

  it('关掉：一次 master 都不建，命令行与改造前逐字节相同', async () => {
    const log = logPath()
    const result = await runScenario(
      OPEN_LAUNCHER,
      driver(fakeSsh(HAPPY, log), false),
      30_000,
      false,
      1,
    )
    expect(result.outcome).toBe('pass')
    const t = tally(log)
    expect(t.masters).toHaveLength(0)
    expect(t.control).toHaveLength(0)
    expect(t.commands.length).toBeGreaterThan(2)
    for (const line of t.commands) {
      expect(line).not.toContain('ControlMaster')
      expect(line).not.toContain('ControlPath')
      // 改造前的形状：`-n -o BatchMode=yes <目标> <命令>`。
      expect(line.startsWith('-n -o BatchMode=yes fake-host ')).toBe(true)
    }
  }, 60_000)

  it('两种模式发出去的远端命令条数一模一样 —— 复用不改语义', async () => {
    const onLog = logPath()
    const offLog = logPath()
    await runScenario(
      OPEN_LAUNCHER,
      driver(fakeSsh(HAPPY, onLog), true),
      30_000,
      false,
      1,
    )
    await runScenario(
      OPEN_LAUNCHER,
      driver(fakeSsh(HAPPY, offLog), false),
      30_000,
      false,
      1,
    )
    const on = tally(onLog)
    const off = tally(offLog)
    expect(on.commands).toHaveLength(off.commands.length)
    // 连接建立次数才是差的那一栏：off 每条命令一次，on 只有一次。
    expect(on.masters.length).toBe(1)
    expect(off.commands.length).toBeGreaterThan(on.masters.length)
  }, 60_000)
})

describe('两条长命隧道显式退出复用（issue #100 ②）', () => {
  const registryScenario: Scenario = {
    id: 'console/fake-registry',
    dimension: 'console',
    title: '起一次性注册中心并把它反向转发到落机',
    expected: '转发得通',
    requires: ['spawn-console'],
    async run(ctx) {
      await ctx.driver.startRegistry?.(ctx)
      return { ok: true, actual: '通了', evidence: [] }
    },
  }

  const consoleScenario: Scenario = {
    id: 'console/fake-start',
    dimension: 'console',
    title: '起一个一次性控制台',
    expected: '起得来',
    requires: ['spawn-console'],
    async run(ctx) {
      const slot = await ctx.driver.consoleSlot?.(ctx)
      if (slot === undefined)
        return { ok: false, actual: '没有位', evidence: [] }
      await slot.start({ registryUrl: 'http://127.0.0.1:39999' })
      return { ok: true, actual: '起来了', evidence: [] }
    },
  }

  it('`ssh -N -R` 那条不共享 master', async () => {
    const log = logPath()
    // 倍率 0.1：反向隧道预算 30 s → 3 s，场景预算 120 s → 12 s。**不要再压回
    // 0.02** —— 这条用例只想看那行 argv，而 2.4 s 的场景预算会在机器忙的时候先于
    // 隧道起来就到期，`reverse.length` 于是为 0，红得与本意无关（实测飘出来过）。
    await runScenario(
      registryScenario,
      driver(fakeSsh(HAPPY, log), true),
      120_000,
      false,
      0.1,
    )
    const t = tally(log)
    const reverse = t.tunnels.filter(l => l.includes(' -R '))
    expect(reverse.length).toBeGreaterThan(0)
    for (const line of reverse) {
      expect(line).toContain('ControlMaster=no')
      expect(line).toContain('ControlPath=none')
    }
  }, 60_000)

  it('`ssh -N -L` 那条也不共享 master', async () => {
    const log = logPath()
    const bin = fakeSsh(
      [
        // banner 要过得去，`#tunnel` 才轮得到被拉起来。
        `if [[ "$cmd" == *"console.out.log"* ]]; then printf 'admin-token=x\\n'; exit 0; fi`,
        HAPPY,
      ].join('\n'),
      log,
    )
    // 倍率同上，理由见上一条用例。
    await runScenario(consoleScenario, driver(bin, true), 120_000, false, 0.1)
    const t = tally(log)
    const forward = t.tunnels.filter(l => l.includes(' -L '))
    expect(forward.length).toBeGreaterThan(0)
    for (const line of forward) {
      expect(line).toContain('ControlMaster=no')
      expect(line).toContain('ControlPath=none')
    }
  }, 60_000)

  it('两条长命隧道共用同一处 spawn，那处带且只带一次 TUNNEL_NO_MUX_ARGS', () => {
    const source = readFileSync(
      new URL('../fleet/driver.ts', import.meta.url),
      'utf8',
    )
    // 行为护栏之外再钉一次结构：将来新增第三条长命隧道时，漏带这两个参数会
    // 让「杀掉隧道进程」与「转发真的撤掉」脱钩，而那种坑不会当场表现出来。
    //
    // **原先这里钉的是「两处 spawn 各带一次」。** 那两处是逐字互抄的，于是
    // #105 那个缺陷（丢掉子进程句柄）只长在其中一条上、另一条原地等下一次。
    // 现在两条走同一个 `#longTunnel`，所以钉的改成「只有一处，且两条都从它
    // 出来」—— 数量从 2 变 1 是修好了，不是漏了。
    expect(source.split('...TUNNEL_NO_MUX_ARGS').length - 1).toBe(1)
    expect(source.split('this.#longTunnel(').length - 1).toBe(2)
    // 那一处必须真的在 `#longTunnel` 体内，而不是又冒出来一条独立的隧道。
    const body = source.slice(source.indexOf('  #longTunnel('))
    expect(body.indexOf('...TUNNEL_NO_MUX_ARGS')).toBeGreaterThan(-1)
    expect(TUNNEL_NO_MUX_ARGS).toEqual([
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
    ])
  })
})

describe('master 建不起来时如实红（issue #100 ⑤）', () => {
  it('不静默退回：远端命令一行都不发，红成 errorKind=transport', async () => {
    const log = logPath()
    const bin = fakeSsh(
      [
        // 建 master 与问它在不在都挂掉 —— 现场就是那两轮真跑的那条错。
        `if [[ " $* " == *" -M "* || "$*" == *"-O check"* ]]; then`,
        `  printf 'Connection closed by 203.0.113.7 port 22\\n' >&2`,
        `  exit 255`,
        `fi`,
        HAPPY,
      ].join('\n'),
      log,
    )
    const result = await runScenario(
      OPEN_LAUNCHER,
      driver(bin, true),
      20_000,
      false,
      1,
    )
    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBe('transport')
    const t = tally(log)
    // **一条远端命令都没发出去。**对非幂等调用点来说这比原先更安全：原先一次
    // 握手抖动也可能发生在命令送出之后。
    expect(t.commands).toHaveLength(0)
    expect(t.masters.length).toBeGreaterThan(0)
    const said = `${String(result.actual)}\n${logsOf(result)}`
    expect(said).toContain('复用 master 建不起来')
    expect(said).toContain('QIANMO_ACCEPTANCE_SSH_MULTIPLEX=0')
    // 分类没变：链路失败仍然说「这不是被测系统的回答」。
    expect(said).toContain('不是被测系统的回答')
  }, 60_000)
})

describe('收尾真的把 master 拆了（issue #100 ③）', () => {
  it('dispose 逐台发 `-O exit`，复用目录随之消失', async () => {
    const log = logPath()
    const d = driver(fakeSsh(HAPPY, log), true)
    await runScenario(OPEN_LAUNCHER, d, 30_000, false, 1)
    expect(d.multiplexedTargets()).toEqual(['fake-host'])
    const before = tally(log)
    const dir = before.commands[0]?.match(/ControlPath=(\S+)\//)?.[1]
    expect(dir).toBeDefined()
    expect(existsSync(String(dir))).toBe(true)

    await d.dispose()
    const after = tally(log)
    expect(after.control.filter(l => l.includes('-O exit'))).toHaveLength(1)
    expect(after.control.some(l => l.endsWith('fake-host'))).toBe(true)
    // 不靠 `ControlPersist` 超时 —— 拆完这一刻目录就得没了。
    expect(existsSync(String(dir))).toBe(false)
    expect(d.multiplexedTargets()).toEqual([])
  }, 60_000)
})

describe('SIGKILL 之后那条有界兜底：ControlPersist', () => {
  it('只挂在建 master 那条上 —— 命令连接、`-O` 那两条、长命隧道都不带', async () => {
    const log = logPath()
    const d = driver(fakeSsh(HAPPY, log), true)
    await runScenario(OPEN_LAUNCHER, d, 30_000, false, 1)
    await d.dispose()
    const t = tally(log)
    expect(t.masters).toHaveLength(1)
    // ② 建 master 的 argv 里确实有它，而且是算出来的那个值。
    for (const line of t.masters) {
      expect(line).toContain(`ControlPersist=${String(MASTER_IDLE_PERSIST_S)}`)
    }
    // 别处一律不带：命令连接带了没有意义（它们不是 master），`-O exit` 带了
    // 会让「拆」这件事看起来像在配置过期时间。
    for (const line of [...t.commands, ...t.control, ...t.tunnels]) {
      expect(line).not.toContain('ControlPersist')
    }
  }, 60_000)

  it('① 正常路径仍是显式 `-O exit` 立刻拆 —— 一台一条，不等任何超时', async () => {
    const log = logPath()
    const d = driver(fakeSsh(HAPPY, log), true)
    await runScenario(OPEN_LAUNCHER, d, 30_000, false, 1)
    const established = d.multiplexedTargets()
    expect(established).toEqual(['fake-host'])

    const startedAt = Date.now()
    await d.dispose()
    const elapsed = Date.now() - startedAt
    const t = tally(log)
    const exits = t.control.filter(l => l.includes('-O exit'))
    // 建起来几台就拆几条，一条不少。
    expect(exits).toHaveLength(established.length)
    for (const target of established) {
      expect(exits.some(l => l.endsWith(target))).toBe(true)
    }
    // 「立刻」= 拆的耗时与 `ControlPersist` 毫无关系（后者是 2 h）。
    expect(elapsed).toBeLessThan(MASTER_IDLE_PERSIST_S * 1_000)
    expect(elapsed).toBeLessThan(5_000)
    expect(d.multiplexedTargets()).toEqual([])
  }, 60_000)

  it('③ 值必须宽于「一轮里同一台机器两次命令之间最长间隔」', () => {
    // 这个间隔不是拍脑袋的：场景**顺序**跑，一次性进程的落机按场景轮转
    // （`FleetDriver.#machineFor`），所以一台机器会被连着若干条场景跳过。
    // 下面按**真实场景表**把那个上界算出来 —— 场景表长了、倍率大了、落机少
    // 了，这条会先红，逼人重新推算，而不是让 master 在一轮跑到一半时过期。
    const machineCaps = new Set([
      'spawn-node',
      'spawn-console',
      'restart-node',
      'run-launcher',
      'local-ca-fixture',
      'exec-node-cli',
      'read-node-files',
      'read-repo-source',
      'attach-node',
      'mirror-transport',
    ])
    const budgetOf = (scenario: Scenario): number =>
      (scenario.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS) * FLEET_TIMEOUT_SCALE
    const machines = DEFAULT_SPAWN_MACHINES.length
    expect(machines).toBeGreaterThan(0)
    let cursor = 0
    let clock = 0
    let worstGapMs = 0
    const lastTouched = new Map<number, number>()
    for (const scenario of ALL_SCENARIOS) {
      const touches = (scenario.requires ?? []).some(r => machineCaps.has(r))
      if (touches) {
        const machine = cursor++ % machines
        const previous = lastTouched.get(machine)
        if (previous !== undefined) {
          worstGapMs = Math.max(worstGapMs, clock - previous)
        }
        lastTouched.set(machine, clock + budgetOf(scenario))
      }
      clock += budgetOf(scenario)
    }
    // 算出来是 56 min（115 条场景、四台落机、倍率 4）。
    expect(worstGapMs).toBeGreaterThan(0)
    expect(MASTER_IDLE_PERSIST_S * 1_000).toBeGreaterThan(worstGapMs)
    // 而且要留够余量 —— 顶着上限过一次不算过。
    expect(MASTER_IDLE_PERSIST_S * 1_000).toBeGreaterThan(worstGapMs * 2)
    // 另一头也钉住：它是**兜底**，不是「等于没配」。`SIGKILL` 之后那几条到
    // 生产机的闲置会话最多活这么久，超过一整轮墙钟上界就失去意义了。
    const wholeRunMs = ALL_SCENARIOS.reduce((n, s) => n + budgetOf(s), 0)
    expect(MASTER_IDLE_PERSIST_S * 1_000).toBeLessThan(wholeRunMs)
  })
})

describe('复用开关（issue #100 ④）', () => {
  const KEY = 'QIANMO_ACCEPTANCE_SSH_MULTIPLEX'
  const restore = (previous: string | undefined): void => {
    if (previous === undefined) delete process.env[KEY]
    else process.env[KEY] = previous
  }

  it('默认开 —— 一轮两千次握手里出一次抖动是必然事件', () => {
    const previous = process.env[KEY]
    delete process.env[KEY]
    try {
      expect(fleetConfigFromEnv().sshMultiplex).toBe(true)
    } finally {
      restore(previous)
    }
  })

  it('`0` 与 `false` 关得掉，别的值一律当没关', () => {
    const previous = process.env[KEY]
    try {
      for (const off of ['0', 'false', ' 0 ']) {
        process.env[KEY] = off
        expect(fleetConfigFromEnv().sshMultiplex).toBe(false)
      }
      for (const on of ['1', 'true', 'yes', '', 'no']) {
        process.env[KEY] = on
        expect(fleetConfigFromEnv().sshMultiplex).toBe(true)
      }
    } finally {
      restore(previous)
    }
  })
})
