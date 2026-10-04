// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `FleetDriver` 把 SSH 传输层与被测系统分开说的那几条护栏（issue #96、#98）。
 *
 * 这些都属于「改坏了要到下一次真跑才发现」，而真跑一轮两小时、还得有人手动
 * 起隧道 —— 所以它们必须落在分片里。前半是 #96 点名的三条；后半（本文件下半
 * 部分）是 #98 的**全量分类**：34 个 `#ssh` 调用点逐条钉，外加一条结构棘轮
 * 挡住第 35 个裸调用点。
 *
 * ## 怎么注入而不用 mock
 *
 * 假一个 `ssh` 出来，经 `FleetConfig.sshBin` 交给驱动。整个套件的 SSH 面因此
 * 可控，而一个 `mock.module` 都不用加（仓库的 mock 卫生棘轮对内联 mock 零容忍，
 * 而这里本来也不需要）。假 ssh 拿到的**最后一个参数**就是远端命令原文，按内容
 * 回不同的答案 —— 退出码 255 就是一次传输层失败。
 *
 * 为什么不改 `PATH`：`Bun.spawn(['ssh', …])` 的可执行文件解析用的是**进程启动
 * 时**的 PATH，测试里改 `process.env.PATH` 对它无效（实测 `Bun.which` 回 null）。
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
import { dirname, join } from 'node:path'
import { FRAME_VERSION, FrameType } from '@qianmo/transport'
import {
  FleetDriver,
  fleetConfigFromEnv,
  TUNNEL_REVIVE_ATTEMPTS,
} from '../fleet/driver.js'
import {
  cleanupFailures,
  fromNdjson,
  renderSummary,
  summarize,
  toNdjson,
  transportErrors,
} from '../report-core.js'
import { runScenario } from '../runner.js'
import { isTransportError, TRANSPORT_RETRY_ATTEMPTS } from '../transport.js'
import type {
  NodeHandle,
  NodeSpec,
  Scenario,
  ScenarioContext,
  ScenarioResult,
} from '../types.js'

/** 假 ssh 回给 `mktemp -d` 的那个根，形状与真的一致（带 SCRATCH_PREFIX）。 */
const FAKE_ROOT = '/home/fake/.cache/qianmo-acceptance/run.AAAABBBB'

const madeDirs: string[] = []
/** 每个驱动都开着一个 SSH 复用目录，跑完要拆 —— 见 `afterEach`。 */
const openDrivers: FleetDriver[] = []
/** 本地假节点（`Bun.serve`）—— 每条用例跑完关掉。 */
const openServers: { stop: () => void }[] = []
/** `bareCtx` 收下的清理 —— 真跑时由 runner 执行，这里由 `afterEach` 执行。 */
const bareCleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  // `dispose` 是真机腿收尾的那一条（issue #100）：不拆的话每个驱动都会在 /tmp
  // 下留一个复用目录。这里连带把它当护栏用 —— 拆不干净在本地就看得见。
  for (const fn of bareCleanups.splice(0)) {
    try {
      await fn()
    } catch {
      // 清理失败在这里不是被测对象 —— 那条纪律由 runner 那半边的用例钉。
    }
  }
  for (const driver of openDrivers.splice(0)) await driver.dispose()
  for (const server of openServers.splice(0)) server.stop()
  for (const dir of madeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 一个**只答握手**的本地假节点：开了就发 challenge，收到任何帧就回 ready。
 *
 * ## 它解掉的是「一次成功的 spawn 拿不到句柄」
 *
 * `#launchDisposable` 那条真路径最后一步是 `rawDial` —— 一次真的 WebSocket
 * 握手。此前的结论是「假 ssh 搭不出来」，于是一次性句柄的 `stdout` / `stderr`
 * / `alive` 三条（#98 那张表的第 5、6、7 条）只有结构棘轮、没有行为护栏。
 *
 * 复核之后那条结论**不成立**：就绪判据确实是驱动自己去 dial，但 dial 的目标
 * 是 `endpoint`，而 `restartNode` 的 `endpoint` 来自**调用方给的句柄**，测试
 * 可以随便填。于是握手不必真有节点：`ws` 客户端 + `Bun.serve` 的 WebSocket
 * 服务端，按 `parseFrame` 认得的形状发两帧就够了 —— challenge 一帧、ready
 * 一帧，`rawDial` 的 `authed` 就为真。
 *
 * **不校验 mac**：这个假节点不是被测对象，它只负责让「一次成功的启动」在单测
 * 里真的发生。握手本身的对错由 `handshake` 那一整维场景去问真节点。
 */
function fakeNodeServer(): { readonly url: string; readonly stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, self): Response | undefined {
      if (self.upgrade(request)) return undefined
      return new Response('expected a websocket upgrade', { status: 400 })
    },
    websocket: {
      open(ws): void {
        ws.send(
          JSON.stringify({
            t: FrameType.Challenge,
            v: FRAME_VERSION,
            nonce: 'acceptance-fake-node-nonce',
          }),
        )
      },
      message(ws): void {
        ws.send(JSON.stringify({ t: FrameType.Ready, v: FRAME_VERSION }))
      },
    },
  })
  const handle = {
    url: `ws://127.0.0.1:${String(server.port)}`,
    stop: (): void => {
      void server.stop(true)
    },
  }
  openServers.push(handle)
  return handle
}

/** 记一笔，好让 `afterEach` 把它的复用目录拆掉。 */
function track(made: FleetDriver): FleetDriver {
  openDrivers.push(made)
  return made
}

/**
 * 写一个假 `ssh` 到临时目录，返回它的绝对路径。
 *
 * `script` 是 bash 片段，进来时 `$cmd` 已经是远端命令原文。
 *
 * ## 复用那几条先短路掉（issue #100）
 *
 * SSH 连接复用之后，同一个假 `ssh` 还会被拿去建 master（`-M -N`）与问它在不在
 * （`-O check` / `-O exit`）。那几条**一条远端命令都不跑** —— `-M -N` 只建连接，
 * `-O` 只跟本地 socket 说话 —— 所以本文件这些「远端命令答什么」的脚本对它们
 * 不适用：让 `exit 2` 那种脚本也去答 master，等于把一次远端命令的返回码冒充成
 * 链路失败，方向正好反了。
 *
 * 于是这里给它们一个恒成功的短路：本文件测的是**命令连接**上的分类，而
 * 「master 建不起来会怎样」在 `fleetSshMux.test.ts` 里单独钉。
 */
/**
 * 整份文件**只写这一个**可执行 inode —— 假 `ssh` 靠软链复用它（issue #102）。
 *
 * ## 为什么不能每条用例现写一个
 *
 * macOS 对**每个新写出来的可执行 inode** 收一次首次执行策略扫描
 * （Gatekeeper / `syspolicyd`）。这台机器上实测：
 *
 * macOS 对新写出来的可执行文件收一次首次执行检查（Gatekeeper / `syspolicyd`）。
 * **它的代价不是一个常数** —— 机器空闲时全新内容约 70–100 ms，而机器一忙实测
 * 涨到 1.8–2.5 s，**没有上限**；指向一个已经执行过的 inode 的软链稳定在 4.5 ms
 * 上下。所以「每条用例现写一个可执行文件」在本地几乎看不出来，一到跑满的
 * `verify` 或 CI 上就会把用例自己的超时预算吃穿 —— 表现为「本该 pass 的用例以
 * 超时收场」，与被测逻辑毫无关系。
 *
 * **指向同一个 inode 的软链走的是已扫描的快路，约 450 倍差距。**这份文件有
 * 五十多处 `fakeSsh`，各写一个 inode 就是两分多钟的纯扫描，而这些钱全都记在
 * 用例自己的超时预算里 —— 表现为「本该 pass 的用例以场景超时收场」，与被测
 * 逻辑毫无关系（issue #102 是同一个病在 `demo/env` 下的另一份）。
 *
 * 每条用例自己的行为写进 `behavior.sh`，那是**数据文件、不可执行**，所以不
 * 触发任何扫描；shim 按 `$0` 的目录去取它，于是软链之间互不干扰。
 */
const SHIM_ROOT = mkdtempSync(join(tmpdir(), 'qm-ssh-shim-'))
const SHIM_REAL = join(SHIM_ROOT, 'ssh-real')
writeFileSync(
  SHIM_REAL,
  `#!/bin/bash\nd="$(dirname "$0")"\n` +
    `case " $* " in *" -M "*|*" -O "*) exit 0;; esac\n` +
    // 真 `ssh -N` 会**一直活着**，所以长命隧道默认挂住 —— 第一版这里直接
    // exit 0，于是隧道在单测里生下来就是死的，而驱动如今会问它死没死
    // （#105），一问就当场说「隧道退了」，把本该测别的东西的用例带偏。
    // 旁边放一个 `tunnel-dies` 文件则让它当场死掉，那是 #105 那个现场，
    // 只能这样造（`behavior.sh` 在这一支之后才被 source，够不着）。
    // `-M` 那一支上面已经退了，这里再挡一次是为了与 fleetSshMux 的同一个
    // shim 保持同形 —— 那边没有上面那行早退。
    `case " $* " in *" -M "*) ;; *" -N "*)\n` +
    // `tunnel-dies` 里写着「头几次要死掉」，每次调用往 `tunnel-calls` 追一个
    // 字节记数。写 `9` 就是怎么重建都不通，写 `1` 就是抖一下之后恢复 ——
    // 后者才证明看门狗真把隧道建回来了，而不只是重试过。
    `  if [ -f "$d/tunnel-dies" ]; then\n` +
    `    printf x >> "$d/tunnel-calls"\n` +
    `    n=$(wc -c < "$d/tunnel-calls" | tr -d ' ')\n` +
    `    if [ "$n" -le "$(cat "$d/tunnel-dies")" ]; then\n` +
    `      printf 'bind [127.0.0.1]:45998: Address already in use\\n' >&2; exit 255\n` +
    `    fi\n` +
    `  fi\n` +
    `  exec sleep 300;; esac\n` +
    `cmd="\${@: -1}"\n. "$d/behavior.sh"\nexit 0\n`,
  { mode: 0o755 },
)
// 空行为文件，只为下面那次预热能跑通。
writeFileSync(join(SHIM_ROOT, 'behavior.sh'), 'true\n')
// **预热必须在模块作用域**：把那 2 秒扫描付在「还没有任何用例的超时计时器在
// 跑」的时候。放进 `beforeAll` 就晚了。
Bun.spawnSync([SHIM_REAL, 'warmup'], { stdout: 'ignore', stderr: 'ignore' })

/**
 * 写一个假 `ssh`，返回它的绝对路径。
 *
 * `script` 是 bash 片段，进来时 `$cmd` 已经是远端命令原文。落地的是一条指向
 * {@link SHIM_REAL} 的**软链** + 一个不可执行的 `behavior.sh`，所以不付扫描。
 */
function fakeSsh(script: string, tunnelDies = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
  madeDirs.push(dir)
  const bin = join(dir, 'ssh')
  symlinkSync(SHIM_REAL, bin)
  writeFileSync(join(dir, 'behavior.sh'), `${script}\n`)
  // 头 `tunnelDies` 次长命隧道当场死掉，之后正常挂住（见 SHIM_REAL）。
  if (tunnelDies > 0)
    writeFileSync(join(dir, 'tunnel-dies'), String(tunnelDies))
  return bin
}

/** 那个假 ssh 一共被要求建了几次长命隧道。 */
function tunnelSpawns(sshBin: string): number {
  const f = join(dirname(sshBin), 'tunnel-calls')
  return existsSync(f) ? readFileSync(f, 'utf8').length : 0
}

function driver(sshBin: string): FleetDriver {
  return track(
    new FleetDriver({
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
      spawnMachines: [
        { ssh: 'fake-host', label: 'fake', repoRel: 'atlas-beta' },
      ],
      psk: {},
      sshBin,
    }),
  )
}

/** 一条只做「开一次性目录」的场景 —— 清理由 runner 在 `finally` 里跑。 */
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

async function runOnce(
  sshBin: string,
  scenario = OPEN_LAUNCHER,
): Promise<ScenarioResult> {
  // 预算是**上限**，不是这些用例要观察的东西 —— 没有一条靠 `runOnce` 超时来
  // 断言。它必须宽到能装下最坏那条路径：`#sshRetry` 打满（退避 750 + 1500 ms）
  // + 三次假 `ssh` 起停 + SSH 复用建 master 的那几趟（issue #100 之后多出来的）。
  // 原先的 4 s 恰好卡在那个和上，于是「打满仍不通」那条会**间歇**地以场景超时
  // 收场而不是 `errorKind=transport` —— 实测 8 轮里飘出来一次。
  return await runScenario(scenario, driver(sshBin), 30_000, false, 1)
}

/** 结果里全部 `log` 证据拼成一段。 */
function logsOf(result: ScenarioResult): string {
  return result.evidence
    .filter(e => e.label === 'log')
    .map(e => e.value)
    .join('\n')
}

/**
 * 假 ssh 的公共分支：开一次性目录、pgrep 清扫、家目录都照常答。
 *
 * 顺序有讲究 —— 开目录那条命令里也有 `$HOME`，所以它必须排在家目录那条前面。
 */
const OPEN_SCRATCH = `if [[ "$cmd" == *'$d/config'* ]]; then printf '%s\\n' '${FAKE_ROOT}'; exit 0; fi`
const HAPPY_PREFIX = [
  OPEN_SCRATCH,
  `if [[ "$cmd" == *"pgrep"* ]]; then exit 0; fi`,
  `if [[ "$cmd" == *'$HOME'* ]]; then printf '/home/fake\\n'; exit 0; fi`,
].join('\n')

describe('一次性目录的清理（issue #96 ①）', () => {
  it('远端 rm 失败时，报告里看得见 —— 而不是静默丢下 107 MB', async () => {
    const bin = fakeSsh(
      [
        HAPPY_PREFIX,
        `if [[ "$cmd" == *"rm -rf --"* ]]; then`,
        `  printf 'rm=1\\nleft=104857\\n'`,
        `  printf 'rm: 无法删除: Read-only file system\\n' >&2`,
        `  exit 0`,
        `fi`,
      ].join('\n'),
    )
    const result = await runOnce(bin)
    // 场景本身仍然是绿的：清理失败是套件的运维债，不是被测系统答错了。
    expect(result.outcome).toBe('pass')
    const logs = logsOf(result)
    expect(logs).toContain('cleanup 失败')
    expect(logs).toContain('远端 rm -rf 失败 (1)')
    expect(logs).toContain('104857 KB')
    expect(logs).toContain(FAKE_ROOT)
    // 汇总表也要说出来 —— 它只展开红行的证据，绿行的残留原本一个字都没有。
    const run = summarize([result], {
      target: 'fleet',
      startedAt: '',
      finishedAt: '',
    })
    expect(cleanupFailures(run)).toHaveLength(1)
  })

  it('删是删掉了但目录还在（rm 报 0）也算没做干净', async () => {
    const bin = fakeSsh(
      [
        HAPPY_PREFIX,
        `if [[ "$cmd" == *"rm -rf --"* ]]; then printf 'rm=0\\nleft=42\\n'; exit 0; fi`,
      ].join('\n'),
    )
    const logs = logsOf(await runOnce(bin))
    expect(logs).toContain('删完目录还在，约 42 KB')
  })

  it('清理都成功时一个字都不多写（绿场景的产物不变）', async () => {
    const bin = fakeSsh(
      [
        HAPPY_PREFIX,
        `if [[ "$cmd" == *"rm -rf --"* ]]; then printf 'rm=0\\nleft=no\\n'; exit 0; fi`,
      ].join('\n'),
    )
    const result = await runOnce(bin)
    expect(result.outcome).toBe('pass')
    expect(result.evidence.filter(e => e.label === 'log')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// issue #96 ②：来源探针无重试，且一台问不到就把整份结论降级成「未知」。
//
// 探针是**纯读一次日志**，重发绝对安全，而「问不到」的代价高得离谱 —— 那一轮
// 5 台里 4 台一致报 fa80e006…、只有 beta-2 抖了一下，首栏就写成「被测端 未知」。
// ---------------------------------------------------------------------------

/** 那一轮舰队上真实的那一版。 */
const FLEET_SHA = 'fa80e006f18a931cb6386b99a7d5e6503991e2a9'

/** 让假 ssh 记一笔调用次数，用来证明「重试了」或「没重试」。 */
function counterScript(file: string): string {
  return `printf 'x' >> '${file}'`
}

function countOf(file: string): number {
  try {
    return readFileSync(file, 'utf8').length
  } catch {
    return 0
  }
}

describe('来源探针的重试（issue #96 ②）', () => {
  it('前两次链路抖动、第三次答上 —— 那就是答上了，不记「未知」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [
        counterScript(counter),
        `n=$(wc -c < '${counter}' | tr -d ' ')`,
        `if [ "$n" -lt 3 ]; then`,
        `  printf 'kex_exchange_identification: Connection closed by remote host\\n' >&2`,
        `  exit 255`,
        `fi`,
        `printf 'log=/home/fake/qianmo-beta/logs/beta-1.out\\nreadable=yes\\nsourceCommit=${FLEET_SHA}\\n'`,
      ].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units).toHaveLength(1)
    expect(units[0]?.commit).toBe(FLEET_SHA)
    expect(countOf(counter)).toBe(3)
  })

  it('打满还是不通：说的是「SSH 链路失败」并带上重发次数，不是「采集失败」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [
        counterScript(counter),
        `printf 'Connection closed by 203.0.113.9 port 22\\n' >&2`,
        `exit 255`,
      ].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units[0]?.commit).toBeUndefined()
    expect(units[0]?.detail).toContain('SSH 链路失败 (255')
    expect(units[0]?.detail).toContain('对端关闭了连接')
    expect(units[0]?.detail).toContain('已重发 2 次')
    expect(countOf(counter)).toBe(TRANSPORT_RETRY_ATTEMPTS)
  })

  it('认证被拒这类「重试也没用」的 255 一次定音，不白打两次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [
        counterScript(counter),
        `printf 'fake-host: Permission denied (publickey).\\n' >&2`,
        `exit 255`,
      ].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units[0]?.detail).toContain('重试没用')
    expect(countOf(counter)).toBe(1)
  })

  it('远端命令自己非零（不是 255）不算链路失败，也不重试', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [counterScript(counter), `printf 'boom\\n' >&2`, `exit 2`].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units[0]?.detail).toContain('采集失败 (2)')
    expect(countOf(counter)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// issue #96 ③：传输层 255 无区分、无重试，一次打嗝就是一条 error。
//
// 那一轮唯一的红：`#scratch` 里开一次性目录撞上 gcloud IAP 的
// `[SSL: UNEXPECTED_EOF_WHILE_READING]`，rc=255。栈停在开目录那一步，
// `beta-up.sh` 一行都没跑到 —— 它不可能是在回答场景那个问题，而同条重跑就 PASS。
// ---------------------------------------------------------------------------

/** 那次真跑的原文（gcloud IAP 的 ProxyCommand 抛的）。 */
const IAP_EOF =
  'ERROR: [0] Error during local connection to [stdin]: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol'

describe('传输层失败与产品结论分开（issue #96 ③）', () => {
  it('抖一下就恢复：重试接住，场景照常给出它本来的结论', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [
        `if [[ "$cmd" == *'$d/config'* ]]; then`,
        `  ${counterScript(counter)}`,
        `  n=$(wc -c < '${counter}' | tr -d ' ')`,
        `  if [ "$n" -lt 2 ]; then printf '${IAP_EOF}\\n' >&2; exit 255; fi`,
        `  printf '%s\\n' '${FAKE_ROOT}'`,
        `  exit 0`,
        `fi`,
        `if [[ "$cmd" == *"pgrep"* ]]; then exit 0; fi`,
        `if [[ "$cmd" == *"rm -rf --"* ]]; then printf 'rm=0\\nleft=no\\n'; exit 0; fi`,
        `if [[ "$cmd" == *'$HOME'* ]]; then printf '/home/fake\\n'; exit 0; fi`,
      ].join('\n'),
    )
    const result = await runOnce(bin)
    // 重试成功 = 那一步确实做成了、套件确实问到了被测系统。**这不是放水。**
    expect(result.outcome).toBe('pass')
    expect(result.errorKind).toBeUndefined()
    expect(countOf(counter)).toBe(2)
  })

  it('打满仍不通：记成 error 且标出是链路 —— 判定一个字不松', async () => {
    const bin = fakeSsh(
      [
        `if [[ "$cmd" == *'$d/config'* ]]; then :; elif [[ "$cmd" == *'$HOME'* ]]; then printf '/home/fake\\n'; exit 0; fi`,
        `printf '${IAP_EOF}\\n' >&2`,
        `exit 255`,
      ].join('\n'),
    )
    const result = await runOnce(bin)
    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBe('transport')
    expect(result.actual).toContain('SSH 链路失败 (255')
    expect(result.actual).toContain('gcloud IAP 隧道半路 EOF')
    expect(result.actual).toContain('不是被测系统的回答')

    // **铁律：不许把 error 悄悄变成绿。**
    const run = summarize([result], {
      target: 'fleet',
      startedAt: '2026-08-25T00:00:00.000Z',
      finishedAt: '2026-08-25T00:00:20.000Z',
    })
    expect(run.counts.error).toBe(1)
    expect(run.pass).toBe(false)
    expect(transportErrors(run)).toHaveLength(1)
    const text = renderSummary(run)
    expect(text).toContain('SSH 链路失败')
    expect(text).toContain('照样计入判定')
    expect(text).toContain('判定: FAIL')
  })

  it('errorKind 经 NDJSON 原样往返，且只在那一类上出现', async () => {
    const bin = fakeSsh([`printf 'boom\\n' >&2`, `exit 255`].join('\n'))
    const transportResult = await runOnce(bin)
    const run = summarize([transportResult], {
      target: 'fleet',
      startedAt: '2026-08-25T00:00:00.000Z',
      finishedAt: '2026-08-25T00:00:20.000Z',
    })
    const back = fromNdjson(toNdjson(run))
    expect(back?.results[0]?.errorKind).toBe('transport')

    // 远端命令自己非零不是链路失败 —— 那是被测系统（或它的机器）的回答。
    const plain = fakeSsh(
      [
        `if [[ "$cmd" == *'$d/config'* ]]; then :; elif [[ "$cmd" == *'$HOME'* ]]; then printf '/home/fake\\n'; exit 0; fi`,
        `printf 'mkdir: 权限不够\\n' >&2`,
        `exit 1`,
      ].join('\n'),
    )
    const plainResult = await runOnce(plain)
    expect(plainResult.outcome).toBe('error')
    expect(plainResult.errorKind).toBeUndefined()
  })
})

describe('sshBin 只是护栏的注入点', () => {
  it('fleetConfigFromEnv 永远不填它 —— 真跑没有办法把整条腿指向假 ssh', () => {
    expect(fleetConfigFromEnv().sshBin).toBeUndefined()
    // 也不许有对应的环境变量：一个「把 SSH 换掉」的运维开关，换来的风险远大于
    // 它的用处 —— 整条真机腿会变成对着一个假二进制的自说自话。
    process.env.QIANMO_ACCEPTANCE_SSH_BIN = '/bin/true'
    try {
      expect(fleetConfigFromEnv().sshBin).toBeUndefined()
    } finally {
      delete process.env.QIANMO_ACCEPTANCE_SSH_BIN
    }
  })
})

// ---------------------------------------------------------------------------
// issue #98：34 个 `#ssh` 调用点全量分类。
//
// #97 把判据（`isTransportFailure` / `TransportFailure` / `errorKind`）建好了，
// 但只接了四个调用点。下一轮真机腿（103 分钟）唯一的红落在**第五个**
// —— `#freePortOn` 的 `ss -H -ltn` 撞上一次 `Connection closed by`，报告上写着
// 「audit/full-rewrite-not-detected-locally 炸了」。逐处点名的做法本身不成立。
//
// 所以这一节按 `#ssh` 头上那张全表逐条钉，外加一条**结构棘轮**挡住第 35 个裸
// 调用点 —— 那才是「不用再挑一遍」的唯一保证。
// ---------------------------------------------------------------------------

/**
 * 那次真跑的 stderr 原文（形状逐字保留，地址换成 RFC 5737 文档保留段）。
 *
 * 真跑时这里是内测机的公网 IP。仓库公开后不该把机器地址留在树上，而这一节测的是
 * stderr 的解析与分类，地址取什么值都不影响任何断言。
 */
const CLOSED = 'Connection closed by 203.0.113.7 port 22'

const FAKE_HOME = '/home/fake'

/**
 * 除被注入的那一条之外，其余远端命令一律照常答。
 *
 * 顺序有讲究：开一次性目录那条命令里同时有 `$d/config`、`chmod 700` 与
 * `$HOME`，所以它必须排在最前；`$HOME` 那条是兜底（几乎每条命令的 PATH
 * 前缀里都有它），必须排在最后。
 */
const BASE = [
  OPEN_SCRATCH,
  `if [[ "$cmd" == *"rm -rf --"* ]]; then printf 'rm=0\\nleft=no\\n'; exit 0; fi`,
  `if [[ "$cmd" == *"pgrep -f 'run"* ]]; then exit 0; fi`,
  `if [[ "$cmd" == *"ss -H -ltn"* ]]; then printf '22\\n38625\\n'; exit 0; fi`,
  `if [[ "$cmd" == *"beta-root/run"* ]]; then exit 0; fi`,
  `if [[ "$cmd" == *'$HOME'* ]]; then printf '${FAKE_HOME}\\n'; exit 0; fi`,
].join('\n')

/** 让匹配到的那条命令回一次链路失败（rc=255 + 那段真原文）。 */
function linkDown(match: string, counter?: string): string {
  return [
    `if [[ "$cmd" == *${JSON.stringify(match)}* ]]; then`,
    ...(counter === undefined ? [] : [`  ${counterScript(counter)}`]),
    `  printf '${CLOSED}\\n' >&2`,
    `  exit 255`,
    `fi`,
  ].join('\n')
}

/** 让匹配到的那条命令**远端自己**答一个非零码（不是链路问题）。 */
function remoteFails(match: string, code: number, message: string): string {
  return [
    `if [[ "$cmd" == *${JSON.stringify(match)}* ]]; then`,
    `  printf '${message}\\n' >&2`,
    `  exit ${String(code)}`,
    `fi`,
  ].join('\n')
}

/** 前 `n` 次链路失败、之后照常答 —— 用来证明「重试接住了」。 */
function flaky(
  match: string,
  counter: string,
  failures: number,
  answer: string,
): string {
  return [
    `if [[ "$cmd" == *${JSON.stringify(match)}* ]]; then`,
    `  ${counterScript(counter)}`,
    `  n=$(wc -c < '${counter}' | tr -d ' ')`,
    `  if [ "$n" -le ${String(failures)} ]; then printf '${CLOSED}\\n' >&2; exit 255; fi`,
    `  printf '${answer}\\n'`,
    `  exit 0`,
    `fi`,
  ].join('\n')
}

function newCounter(): string {
  return tmpFile('calls')
}

/** 一个自己开目录的临时文件路径（跑完由 `afterEach` 收掉）。 */
function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
  madeDirs.push(dir)
  return join(dir, name)
}

/** 带控制台机器的一份配置 —— 审计镜像那三趟采集要它。 */
function driverWithConsole(sshBin: string): FleetDriver {
  return track(
    new FleetDriver({
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
      spawnMachines: [
        { ssh: 'fake-host', label: 'fake', repoRel: 'atlas-beta' },
      ],
      psk: {},
      consoleHost: 'fake-console',
      sshBin,
    }),
  )
}

const ATTACH_SPEC: NodeSpec = {
  name: 'beta-1',
  agents: { main: '/tmp/never-used' },
  auth: { mode: 'psk', psk: 'qianmo-acceptance-psk-0000000000' },
  policy: 'open',
  attach: true,
}

const DISPOSABLE_SPEC: NodeSpec = {
  name: 'beta-throwaway',
  agents: { main: '/tmp/never-used' },
  auth: { mode: 'psk', psk: 'qianmo-acceptance-psk-0000000000' },
  policy: 'open',
}

/**
 * 手搭一个**一次性**句柄。
 *
 * `stopNode` / `writeNodeFile` / `setNodePathMode` 只看 `disposable` 这一栏，
 * 手搭出来直接喂给它们，钉的是同一段代码。
 *
 * `endpoint` 可以指到一个本地假节点（{@link fakeNodeServer}）—— `restartNode`
 * 把它原样交给 `#launchDisposable` 的就绪判据，于是那条真路径**跑得完整**，
 * 一次成功的 spawn 会真的交回一个句柄。
 *
 * `tunnelAlive` 是那条转发隧道的死活。默认活着（真跑的常态）；钉成 `false`
 * 就是「隧道自己退了、重建也没建回来」那个现场 —— 见 issue #105。真隧道会自己
 * 重建（{@link TUNNEL_REVIVE_ATTEMPTS}），手搭的这个不会，所以两个谓词同值。
 */
function disposableHandle(
  endpoint = 'ws://127.0.0.1:45999',
  tunnelAlive = true,
): NodeHandle {
  return {
    name: DISPOSABLE_SPEC.name,
    spec: DISPOSABLE_SPEC,
    ssh: 'fake-host',
    occPath: `${FAKE_HOME}/atlas-beta/dist/cli-node.js`,
    endpoint,
    hostEndpoint: 'ws://127.0.0.1:41999',
    configRoot: `${FAKE_ROOT}/config`,
    disposable: {
      machine: { ssh: 'fake-host', label: 'fake', repoRel: 'atlas-beta' },
      root: FAKE_ROOT,
      configRoot: `${FAKE_ROOT}/config`,
      remotePort: 41_999,
      occPath: `${FAKE_HOME}/atlas-beta/dist/cli-node.js`,
      tunnel: {
        localPort: 45_998,
        // 手搭的这个不重建，所以「死了」与「重建预算用完了」是同一件事。
        exhausted: () => !tunnelAlive,
        exitCode: () => (tunnelAlive ? null : 255),
        diagnose: () =>
          'to fake-host 的转发隧道（本地 45998 → 41999）已退出 (255)：' +
          'bind [127.0.0.1]:45998: Address already in use',
      },
    },
    stdout: async () => '',
    stderr: async () => '',
    alive: async () => true,
  } as unknown as NodeHandle
}

/**
 * 一个不经 runner 的最小 ctx —— 直接调驱动方法时用。
 *
 * `cleanup` **必须真的收着**：真跑时由 runner 逐条执行，而驱动往里登记的东西
 * 里有长命隧道那个 `ssh -N`。丢掉它等于每条这样的用例都在测试机上留一个活
 * 进程（假 ssh 也一样挂着，见 SHIM_REAL 的 `-N` 那一支）。`afterEach` 收尾。
 */
function bareCtx(timeoutScale = 0.02): ScenarioContext {
  return {
    workdir: '/tmp/qm-fake-workdir',
    allocPort: async () => 45_998,
    cleanup: (fn: () => void | Promise<void>) => {
      bareCleanups.push(fn)
    },
    log: () => {},
    signal: new AbortController().signal,
    timeoutScale,
  } as unknown as ScenarioContext
}

/** 这个异常是不是一次被正确标记的传输层失败。 */
async function transportThrow(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn()
  } catch (err) {
    expect(isTransportError(err)).toBe(true)
    expect((err as Error).message).toContain('不是被测系统的回答')
    return err as Error
  }
  throw new Error('本该抛 TransportFailure，却正常返回了')
}

/** 一条只问「给我一个空闲端口」的场景 —— 直捣 `#freePortOn`。 */
const ASK_PORT: Scenario = {
  id: 'launcher/fake-free-port',
  dimension: 'launcher',
  title: '在落机上要一个空闲端口',
  expected: '要得到一个没人在听的高位口',
  requires: ['run-launcher'],
  async run(ctx) {
    const host = await ctx.driver.execHost(ctx)
    const port = await host.freePort()
    return { ok: port >= 41_000, actual: String(port), evidence: [] }
  },
}

describe('#freePortOn —— issue #98 的那条现场（第 33 条）', () => {
  it('抖一下就恢复：重试接住，场景照常给出它本来的结论', async () => {
    const counter = newCounter()
    const bin = fakeSsh(
      [flaky('ss -H -ltn', counter, 1, '22\\n38625'), BASE].join('\n'),
    )
    const result = await runOnce(bin, ASK_PORT)
    // 重试成功 = 那一步确实做成了、套件确实问到了被测系统。**这不是放水。**
    expect(result.outcome).toBe('pass')
    expect(result.errorKind).toBeUndefined()
    expect(countOf(counter)).toBe(2)
  }, 60_000)

  it('打满仍不通：error + errorKind=transport + 整轮判红，判定一个字不松', async () => {
    const counter = newCounter()
    const bin = fakeSsh([linkDown('ss -H -ltn', counter), BASE].join('\n'))
    const result = await runOnce(bin, ASK_PORT)
    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBe('transport')
    expect(result.actual).toContain('SSH 链路失败 (255')
    expect(result.actual).toContain('对端关闭了连接')
    expect(result.actual).toContain('取监听端口表')
    expect(result.actual).toContain('不是被测系统的回答')
    expect(countOf(counter)).toBe(TRANSPORT_RETRY_ATTEMPTS)

    // **铁律：不许把 error 悄悄变成绿。**
    const run = summarize([result], {
      target: 'fleet',
      startedAt: '2026-08-25T00:00:00.000Z',
      finishedAt: '2026-08-25T00:00:20.000Z',
    })
    expect(run.counts.error).toBe(1)
    expect(run.pass).toBe(false)
    expect(transportErrors(run)).toHaveLength(1)
    expect(renderSummary(run)).toContain('判定: FAIL')
  }, 60_000)

  it('远端自己答不出端口表（不是 255）仍按原样报，不冒充链路失败', async () => {
    const bin = fakeSsh(
      [remoteFails('ss -H -ltn', 127, 'ss: command not found'), BASE].join(
        '\n',
      ),
    )
    const result = await runOnce(bin, ASK_PORT)
    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBeUndefined()
    expect(result.actual).toContain('取监听端口表失败 (127)')
  }, 60_000)
})

describe('launcherHost 的 exists / readFile —— issue #98 ①', () => {
  /** 场景问「那个文件在不在」，把答案原样交出来。 */
  const ASK_EXISTS: Scenario = {
    id: 'launcher/fake-exists',
    dimension: 'launcher',
    title: '问启动器位上某个文件在不在',
    expected: '答得出在或不在',
    requires: ['run-launcher'],
    async run(ctx) {
      const host = await ctx.driver.launcherHost(ctx)
      const there = await host.exists(`${host.betaRoot}/run/beta-1.pid`)
      return { ok: !there, actual: there ? 'yes' : 'no', evidence: [] }
    },
  }

  it('链路失败不再答「文件不存在」——那是一条假绿，且看不出与链路有关', async () => {
    const counter = newCounter()
    const bin = fakeSsh([linkDown('test -e ', counter), BASE].join('\n'))
    const result = await runOnce(bin, ASK_EXISTS)
    // 改之前：`stdout` 为空 → `includes('yes')` 为 false → 答「不存在」→
    // 上面那条 `ok: !there` **通过**，一条彻头彻尾的假绿。
    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBe('transport')
    expect(result.actual).toContain('在不在')
    expect(countOf(counter)).toBe(TRANSPORT_RETRY_ATTEMPTS)
  }, 60_000)

  it('答得上来的时候照答 —— `no` 仍然是 `no`，没有把观察变成红', async () => {
    const bin = fakeSsh(
      [
        `if [[ "$cmd" == *"test -e "* ]]; then printf 'no\\n'; exit 0; fi`,
        BASE,
      ].join('\n'),
    )
    const result = await runOnce(bin, ASK_EXISTS)
    expect(result.outcome).toBe('pass')
    expect(result.actual).toBe('no')

    const yes = fakeSsh(
      [
        `if [[ "$cmd" == *"test -e "* ]]; then printf 'yes\\n'; exit 0; fi`,
        BASE,
      ].join('\n'),
    )
    const there = await runOnce(yes, ASK_EXISTS)
    expect(there.outcome).toBe('fail')
    expect(there.actual).toBe('yes')
  }, 60_000)

  it('远端既不答 yes 也不答 no 时同样抛 —— 「问不到」不许折成 false', async () => {
    const bin = fakeSsh(
      [
        `if [[ "$cmd" == *"test -e "* ]]; then printf 'sh: bad substitution\\n' >&2; exit 0; fi`,
        BASE,
      ].join('\n'),
    )
    const result = await runOnce(bin, ASK_EXISTS)
    expect(result.outcome).toBe('error')
    expect(result.actual).toContain('问不出')
  }, 60_000)

  it('readFile 链路失败不再答「文件是空的」', async () => {
    const d = driver(fakeSsh([linkDown('cat -- '), BASE].join('\n')))
    const host = await d.launcherHost(bareCtx())
    const err = await transportThrow(async () => await host.readFile('/etc/x'))
    expect(err.message).toContain('/etc/x')
  }, 60_000)

  it('readFile 真读到空 / 真没有这个文件，仍然是 undefined', async () => {
    const d = driver(
      fakeSsh(
        [`if [[ "$cmd" == *"cat -- "* ]]; then exit 0; fi`, BASE].join('\n'),
      ),
    )
    const host = await d.launcherHost(bareCtx())
    expect(await host.readFile('/etc/x')).toBeUndefined()
  }, 60_000)
})

describe('幂等的那些接重试，且绝不冒充一次观察', () => {
  it('#tail（第 34 条）：证据栏不许静默变空', async () => {
    const counter = newCounter()
    const d = driver(
      fakeSsh([flaky('tail -200', counter, 2, 'banner line'), BASE].join('\n')),
    )
    const node = await d.startNode(bareCtx(), ATTACH_SPEC)
    expect((await node.stdout()).trim()).toBe('banner line')
    expect(countOf(counter)).toBe(3)

    const dead = driver(fakeSsh([linkDown('tail -200'), BASE].join('\n')))
    const deadNode = await dead.startNode(bareCtx(), ATTACH_SPEC)
    await transportThrow(async () => await deadNode.stderr())
  }, 60_000)

  it('#attach().alive（第 1 条）：链路失败不许答「节点死了」', async () => {
    const d = driver(
      fakeSsh([linkDown('resident --node beta-1'), BASE].join('\n')),
    )
    const node = await d.startNode(bareCtx(), ATTACH_SPEC)
    await transportThrow(async () => await node.alive())
  }, 60_000)

  it('readNodeFile / listNodeDir（第 10、13 条）：不许答「文件/目录不存在」', async () => {
    const d = driver(
      fakeSsh([linkDown('cat -- '), linkDown('ls -1 --'), BASE].join('\n')),
    )
    const node = await d.startNode(bareCtx(), ATTACH_SPEC)
    await transportThrow(async () => await d.readNodeFile(node, 'trail.jsonl'))
    await transportThrow(async () => await d.listNodeDir(node, 'peers'))
  }, 60_000)

  it('execHost.mkdir / readFile（第 18、19 条）：建不成要说，读不到要抛', async () => {
    const failing = driver(
      fakeSsh(
        [remoteFails('mkdir -p -- ', 1, 'mkdir: Permission denied'), BASE].join(
          '\n',
        ),
      ),
    )
    const host = await failing.execHost(bareCtx())
    await expect(host.mkdir('certs')).rejects.toThrow('建目录 certs 失败 (1)')

    const down = driver(fakeSsh([linkDown('cat -- '), BASE].join('\n')))
    const readHost = await down.execHost(bareCtx())
    await transportThrow(async () => await readHost.readFile('ca.pem'))
  }, 60_000)

  it('setNodePathMode（第 12 条）：chmod 的返回码不再被丢掉', async () => {
    const d = driver(
      fakeSsh(
        [
          remoteFails('chmod 0400 --', 1, 'chmod: Operation not permitted'),
          BASE,
        ].join('\n'),
      ),
    )
    await expect(
      d.setNodePathMode(disposableHandle(), 'qianmo/identity.json', '0400'),
    ).rejects.toThrow('改成 0400 失败 (1)')
  }, 60_000)

  it('launcherHost 开位（第 24 条）：run/ 与 logs/ 没建成要当场说', async () => {
    const d = driver(
      fakeSsh(
        [remoteFails('beta-root/run', 1, 'mkdir: No space left'), BASE].join(
          '\n',
        ),
      ),
    )
    await expect(d.launcherHost(bareCtx())).rejects.toThrow(
      '开启动器位失败 (1)',
    )
  }, 60_000)

  it('审计镜像的三趟采集（第 30、31、32 条）：不再静默给出一排「(取不到)」', async () => {
    const declared = [
      `if [[ "$cmd" == *"ps -eo args"* ]]; then`,
      `  printf -- '--audit beta-1=/var/mirror/beta-1.jsonl\\n'`,
      `  printf -- '--audit-mirror beta-1=5\\n'`,
      `  printf 'console-port=38621\\nconsole-health=200\\n'`,
      `  exit 0`,
      `fi`,
    ].join('\n')

    // ① 申报那一趟：此前记成 `failure` → 场景一条 **fail**（「读不到搬运
    //    现场」）。用套件够不着机器去否掉一条产品结论，方向正好反了。
    const noDeclare = driverWithConsole(
      fakeSsh([linkDown('ps -eo args'), BASE].join('\n')),
    )
    await transportThrow(async () => await noDeclare.inspectMirrorTransport())

    // ② 每节点那一趟。
    const noUnit = driverWithConsole(
      fakeSsh([declared, linkDown('systemctl --user show'), BASE].join('\n')),
    )
    await transportThrow(async () => await noUnit.inspectMirrorTransport())

    // ③ 权威副本那一趟（这一条喂的是前缀哈希那个承重断言）。
    const noAuthority = driverWithConsole(
      fakeSsh(
        [
          declared,
          `if [[ "$cmd" == *"systemctl --user show"* ]]; then`,
          `  printf 'observed-at=1000\\nlast-trigger-sec=990\\n'`,
          `  printf 'ExecMainStatus=0\\nResult=success\\n'`,
          `  printf 'mirror-mtime=995\\nmirror-bytes=128\\nmirror-md5=abc\\n'`,
          `  exit 0`,
          `fi`,
          linkDown('authoritative-bytes'),
          BASE,
        ].join('\n'),
      ),
    )
    await transportThrow(async () => await noAuthority.inspectMirrorTransport())
  }, 60_000)

  it('远端命令自己非零仍按观察处理 —— 镜像那条照旧记 failure，不抛', async () => {
    const d = driverWithConsole(
      fakeSsh(
        [remoteFails('ps -eo args', 1, 'ps: no such option'), BASE].join('\n'),
      ),
    )
    const report = await d.inspectMirrorTransport()
    expect(report.failure).toContain('读控制台申报失败 (1)')
  }, 60_000)
})

describe('非幂等的只判返回码，一次都不重发', () => {
  it('execNode（第 14 条）：255 不再被读成「这条命令失败了」，且只发一次', async () => {
    const counter = newCounter()
    const d = driver(
      fakeSsh([linkDown('cli-node.js', counter), BASE].join('\n')),
    )
    const node = await d.startNode(bareCtx(), ATTACH_SPEC)
    await transportThrow(async () => await d.execNode(node, ['peers', 'list']))
    expect(countOf(counter)).toBe(1)
  }, 60_000)

  it('execHost.exec / run（第 15、16 条）：同上，各只发一次', async () => {
    const counter = newCounter()
    const d = driver(
      fakeSsh([linkDown('cli-node.js', counter), BASE].join('\n')),
    )
    const host = await d.execHost(bareCtx())
    await transportThrow(async () => await host.exec(['ca', 'init']))
    expect(countOf(counter)).toBe(1)

    const runCounter = newCounter()
    const d2 = driver(
      fakeSsh([linkDown('openssl', runCounter), BASE].join('\n')),
    )
    const host2 = await d2.execHost(bareCtx())
    await transportThrow(async () => await host2.run(['openssl', 'version']))
    expect(countOf(runCounter)).toBe(1)
  }, 60_000)

  it('写文件那三条（第 11、17、25 条）：255 与「远端写不进去」分开说，都不重发', async () => {
    const counter = newCounter()
    const d = driver(fakeSsh([linkDown('cat > ', counter), BASE].join('\n')))
    const host = await d.execHost(bareCtx())
    await transportThrow(async () => await host.writeFile('chain.json', '{}'))
    expect(countOf(counter)).toBe(1)

    await transportThrow(
      async () =>
        await d.writeNodeFile(disposableHandle(), 'qianmo/trail.jsonl', 'x'),
    )

    const launcher = await d.launcherHost(bareCtx())
    await transportThrow(
      async () => await launcher.writeFile('peers.conf', 'x'),
    )

    // 远端自己写不进去仍是一次观察 —— 原样报，不冒充链路失败。
    const denied = driver(
      fakeSsh(
        [remoteFails('cat > ', 1, 'bash: Permission denied'), BASE].join('\n'),
      ),
    )
    const deniedHost = await denied.execHost(bareCtx())
    await expect(deniedHost.writeFile('chain.json', '{}')).rejects.toThrow(
      '写 chain.json 失败 (1)',
    )
  }, 60_000)

  it('launcherHost.run（第 26 条）：beta-up.sh 那趟绝不重发', async () => {
    const counter = newCounter()
    const d = driver(
      fakeSsh([linkDown('beta-up.sh', counter), BASE].join('\n')),
    )
    const host = await d.launcherHost(bareCtx())
    await transportThrow(
      async () => await host.run([`${host.repoDir}/beta-up.sh`, '--dry-run']),
    )
    expect(countOf(counter)).toBe(1)
  }, 60_000)

  it('#killGroup（第 9 条）：停不掉要说出来，一次性常驻不许静默存活', async () => {
    const counter = newCounter()
    const down = driver(
      fakeSsh([linkDown('node.pid', counter), BASE].join('\n')),
    )
    await transportThrow(async () => await down.stopNode(disposableHandle()))
    expect(countOf(counter)).toBe(1)

    const failed = driver(
      fakeSsh(
        [
          remoteFails('node.pid', 1, 'kill: Operation not permitted'),
          BASE,
        ].join('\n'),
      ),
    )
    await expect(failed.killNode(disposableHandle())).rejects.toThrow(
      '硬杀一次性节点',
    )
  }, 60_000)

  it('#launchDisposable 的启动与 banner（第 2、3、4 条）', async () => {
    // ② 启动那一趟：255 不再变成一句「节点没有起来」。
    const counter = newCounter()
    const start = driver(
      fakeSsh([linkDown('setsid bun', counter), BASE].join('\n')),
    )
    await transportThrow(
      async () => await start.restartNode(bareCtx(), disposableHandle()),
    )
    expect(countOf(counter)).toBe(1)

    // ③ 读 banner 那一趟：同样不许把「读不到」说成「没起来」。
    const banner = driver(
      fakeSsh(
        [
          `if [[ "$cmd" == *"setsid bun"* ]]; then printf 'node-pid=4242\\n'; exit 0; fi`,
          linkDown('out.log'),
          BASE,
        ].join('\n'),
      ),
    )
    await transportThrow(
      async () => await banner.restartNode(bareCtx(), disposableHandle()),
    )

    // ④ 诊断那一段走 `#diag`：读不到时明说「取不到」，**不掀掉**外面那条
    //    已经成立的结论（节点确实没起来）。
    const diag = driver(
      fakeSsh(
        [
          `if [[ "$cmd" == *"setsid bun"* ]]; then printf 'node-pid=4242\\n'; exit 0; fi`,
          `if [[ "$cmd" == *"out.log"* ]]; then printf '起不来\\n'; exit 0; fi`,
          linkDown('err.log'),
          BASE,
        ].join('\n'),
      ),
    )
    let message = ''
    try {
      await diag.restartNode(bareCtx(), disposableHandle())
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('没有起来')
    expect(message).toContain('取不到')
    expect(message).toContain('SSH 链路失败')
  }, 60_000)

  it('#startConsole 的启动与 banner（第 20、21、22 条），以及 #killByPidFile（第 23 条）', async () => {
    const counter = newCounter()
    const bin = fakeSsh(
      [linkDown('setsid bun', counter), linkDown('console.pid'), BASE].join(
        '\n',
      ),
    )
    const spawnConsole: Scenario = {
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
    const result = await runOnce(bin, spawnConsole)
    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBe('transport')
    // 启动那一趟只发一次（`setsid bun` 不幂等）。
    expect(countOf(counter)).toBe(1)
    // 清理**先登记再启动**，所以那个控制台的 pid 文件照样被去停 —— 停不成时
    // 报告里要看得见，而不是让它静默活在机器上。
    expect(logsOf(result)).toContain('cleanup 失败')
    expect(logsOf(result)).toContain('停一次性控制台')

    // banner 读不到时同样不许说成「控制台没有起来」。
    const bannerDown = fakeSsh(
      [
        `if [[ "$cmd" == *"setsid bun"* ]]; then exit 0; fi`,
        `if [[ "$cmd" == *"console.pid"* ]]; then exit 0; fi`,
        linkDown('console.out.log'),
        BASE,
      ].join('\n'),
    )
    const bannerResult = await runOnce(bannerDown, spawnConsole)
    expect(bannerResult.outcome).toBe('error')
    expect(bannerResult.errorKind).toBe('transport')
    expect(bannerResult.actual).toContain('banner')
  }, 60_000)
})

describe('反向隧道的就绪探测（第 29 条）', () => {
  it('循环自己就是重试，打到预算还是 255 就说链路，不说「隧道没通」', async () => {
    const counter = newCounter()
    const bin = fakeSsh([linkDown('/v0/agents', counter), BASE].join('\n'))
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
    // 倍率 0.1：反向隧道预算 30 s → 3 s，场景预算 120 s → 12 s。**不要再压到
    // 0.02** —— 这条用例只想看那行 argv，而 2.4 s 的场景预算会在机器忙的时候
    // 先于隧道起来就到期，于是 `reverse.length` 为 0，红得与本意无关。
    const result = await runScenario(
      registryScenario,
      driver(bin),
      120_000,
      false,
      0.1,
    )
    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBe('transport')
    expect(result.actual).toContain('反向隧道')
    // 循环自己就是重试 —— 再套一层 `#sshRetry` 等于把每轮变成三次往返。
    expect(countOf(counter)).toBeGreaterThan(1)
  }, 60_000)

  /**
   * `ssh -R` 自己死掉时，说的是那条隧道退了，而不是「隧道还没通，再等等」。
   *
   * 正向那条的同一个病（#105）。这边的误报比正向轻 —— 消息里本来就写着
   * 「反向隧道」，不至于赖到被测系统头上 —— 但代价一样在：远端那次 curl 只
   * 会回 `000`，读起来像还没通，于是整个预算白等一遍，最后那句话也说不出
   * 是哪一侧坏的。
   */
  it('`ssh -R` 自己退了：当场说它退了，不等满预算（issue #105）', async () => {
    // 远端那次 curl **正常答 `000`** —— 就是「隧道还没通」的样子，链路本身
    // 一点问题没有。第二个参数让长命隧道生下来就死。这样一来，两种结论的
    // 差别就干净了：不问隧道 = 等满 30 s 再说一句「没通：000」（连
    // `errorKind` 都没有）；问了 = 当场说它退了、原文带上。
    const bin = fakeSsh(
      [
        `if [[ "$cmd" == *"/v0/agents"* ]]; then printf '000\\n'; exit 0; fi`,
        BASE,
      ].join('\n'),
      9,
    )
    const scenario: Scenario = {
      id: 'console/fake-registry-dead-tunnel',
      dimension: 'console',
      title: '反向转发的 ssh 自己死了',
      expected: '当场说那条隧道退了',
      requires: ['spawn-console'],
      async run(ctx) {
        await ctx.driver.startRegistry?.(ctx)
        return { ok: true, actual: '通了', evidence: [] }
      },
    }
    // 倍率 1 = 反向隧道预算 30 s。死掉的隧道该在第一轮就被认出来。
    const began = Date.now()
    const result = await runScenario(scenario, driver(bin), 120_000, false, 1)
    const took = Date.now() - began

    expect(result.outcome).toBe('error')
    expect(result.errorKind).toBe('transport')
    expect(String(result.actual)).toContain('反向隧道')
    expect(String(result.actual)).toContain('Address already in use')
    // 没等满 30 s 的预算 —— 重建打完就问隧道。
    expect(took).toBeLessThan(20_000)
    // **真的试过重建**：1 次首建 + 3 次重建。少了就是看门狗没跑，多了就是
    // 预算没兜住（那会把一条断链拖成无限重连）。
    expect(tunnelSpawns(bin)).toBe(1 + TUNNEL_REVIVE_ATTEMPTS)
    expect(String(result.actual)).toContain(
      `已重建 ${String(TUNNEL_REVIVE_ATTEMPTS)} 次仍不通`,
    )
  }, 120_000)

  /**
   * 抖一下就恢复 —— 看门狗把隧道**建回来了**，场景照常给出它本来的结论。
   *
   * 这条与上一条是一对：上一条证明重建有上限、打满会如实红；这条证明重建
   * 真的管用。少了它，「自愈」就只是「多试了几次然后还是红」。
   *
   * 为什么这条可以重试而 `#once` 那半边不行：`ssh -R` 在远端**不留任何痕迹**，
   * 重建一次不会让被测系统多看见一个字节。判据与 `#read` 是同一条。
   */
  it('隧道抖一下就恢复：看门狗把它建回来，场景照常通（issue #105）', async () => {
    // 头 2 次建隧道失败，第 3 次成功。**远端那次 curl 跟着隧道走** —— 隧道
    // 没建起来就答 `000`（转发不通），建起来才答 `200`。不把两者挂钩的话，
    // curl 恒答 200 会让就绪循环在第一拍就返回，重建那段根本不会被跑到。
    const bin = fakeSsh(
      [
        `if [[ "$cmd" == *"/v0/agents"* ]]; then`,
        `  n=$(wc -c < "$d/tunnel-calls" 2>/dev/null | tr -d ' '); n=\${n:-0}`,
        `  if [ "$n" -gt "$(cat "$d/tunnel-dies")" ]; then printf '200\\n'; else printf '000\\n'; fi`,
        `  exit 0`,
        `fi`,
        BASE,
      ].join('\n'),
      2,
    )
    const scenario: Scenario = {
      id: 'console/fake-registry-flaky-tunnel',
      dimension: 'console',
      title: '反向转发的 ssh 抖了两次',
      expected: '建回来之后照常通',
      requires: ['spawn-console'],
      async run(ctx) {
        await ctx.driver.startRegistry?.(ctx)
        return { ok: true, actual: '通了', evidence: [] }
      },
    }
    const result = await runScenario(scenario, driver(bin), 120_000, false, 1)

    // 场景绿了 = 那条隧道真的建回来了。**这不是放水**：远端那次 curl 照样
    // 得答 200，断言一个字没松。
    expect(result.outcome).toBe('pass')
    expect(result.errorKind).toBeUndefined()
    // 1 次首建（死）+ 2 次重建（第 1 次死、第 2 次活）。
    expect(tunnelSpawns(bin)).toBe(3)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// issue #91 ②：起进程那两趟的**远端**预算也要吃 `--timeout-scale`。
//
// #91 修的另外四处是 `Date.now() + 常数` 的形状，乘一下就完了。这两处不是：
// 一个是 `#ssh` 的超时参数，另一个整个跑在**远端**（`for _ in $(seq 1 N)`），
// 那边取不到 `ctx`。所以倍率必须在 runner 这边算成拍数再拼进脚本 —— 下面三条
// 分别钉「拍数真的乘了」「远端慢一步不再被记成 error」「ssh 自己那格也乘了」。
// ---------------------------------------------------------------------------

/** 抄下假 ssh 收到的那条启动命令原文（多行，原样落盘）。 */
function launchRecorder(file: string): string {
  return [
    `if [[ "$cmd" == *"setsid bun"* ]]; then`,
    `  printf '%s\\n' "$cmd" >> '${file}'`,
    `  exit 0`,
    `fi`,
  ].join('\n')
}

describe('远端就绪预算吃 --timeout-scale（issue #91 ②）', () => {
  it('倍率进了远端脚本的 seq 拍数 —— 一次性节点与一次性控制台都是', async () => {
    const seen = async (
      scale: number,
      what: 'node' | 'console',
    ): Promise<string> => {
      const file = tmpFile('launch-cmd')
      const bin = fakeSsh([launchRecorder(file), BASE].join('\n'))
      if (what === 'node') {
        const d = driver(bin)
        await expect(
          d.restartNode(bareCtx(scale), disposableHandle()),
        ).rejects.toThrow('没有起来')
      } else {
        const d = driverWithConsole(bin)
        const slot = await d.consoleSlot(bareCtx(scale))
        await expect(
          slot.start({ registryUrl: 'http://127.0.0.1:39999' }),
        ).rejects.toThrow('没有起来')
      }
      return readFileSync(file, 'utf8')
    }

    // 基准 60 s / 一拍 0.5 s = 120 拍。倍率 1 时与改造前逐字节相同。
    expect(await seen(1, 'node')).toContain('seq 1 120')
    expect(await seen(1, 'console')).toContain('seq 1 120')
    // CI 的 `--timeout-scale 3`。
    expect(await seen(3, 'node')).toContain('seq 1 360')
    // 真机腿默认的 `FLEET_TIMEOUT_SCALE = 4`。
    expect(await seen(4, 'node')).toContain('seq 1 480')
    expect(await seen(4, 'console')).toContain('seq 1 480')
    // 倍率再小也不许拼出 `seq 1 0` —— 那会让远端一次都不看就往下走。
    expect(await seen(0.001, 'node')).toContain('seq 1 1')
  }, 120_000)

  it('远端慢于基准预算、快于放大后预算：倍率 1 记 error，倍率 4 正常通过', async () => {
    // 假 ssh 扮演一台「起得慢」的机器：从启动命令里读出远端要轮询几拍，
    // 只有拍数够到 `READY_AT_TICK` 才认为 banner 落了地。**改造前那条脚本里
    // 恒是 `seq 1 120`**，所以倍率 4 的那一行在改造前与倍率 1 的这一行走的是
    // 同一个分支 —— 下面倍率 1 的断言就是改造前的行为。
    const READY_AT_TICK = 200
    const slowNode = (marker: string): string =>
      [
        `if [[ "$cmd" == *"setsid bun"* ]]; then`,
        `  n=$(printf '%s' "$cmd" | sed -n 's/.*seq 1 \\([0-9]*\\).*/\\1/p' | head -1)`,
        `  if [ "\${n:-0}" -ge ${String(READY_AT_TICK)} ]; then`,
        `    printf '{"publicKey":"fake-key"}\\n' > '${marker}'`,
        `  fi`,
        `  exit 0`,
        `fi`,
        `if [[ "$cmd" == *"out.log"* ]]; then cat '${marker}' 2>/dev/null; exit 0; fi`,
        BASE,
      ].join('\n')

    const node = fakeNodeServer()
    const restartScenario = (endpoint: string): Scenario => ({
      id: 'recovery/fake-slow-restart',
      dimension: 'recovery',
      title: '重启一个起得慢的一次性节点',
      expected: '起得来',
      requires: ['restart-node'],
      async run(ctx) {
        const back = await ctx.driver.restartNode(
          ctx,
          disposableHandle(endpoint),
        )
        return { ok: true, actual: back.name, evidence: [] }
      },
    })

    // 倍率 1 = 改造前：远端只轮询 120 拍，banner 没落地 → 一条 **error**。
    const slowMarker = tmpFile('marker-scale-1')
    const slow = await runScenario(
      restartScenario(node.url),
      driver(fakeSsh(slowNode(slowMarker))),
      60_000,
      false,
      1,
    )
    expect(slow.outcome).toBe('error')
    expect(slow.actual).toContain('没有起来')

    // 倍率 4 = 真机腿：480 拍够到 200 拍，banner 落地，整条路径走完并交回句柄。
    const fastMarker = tmpFile('marker-scale-4')
    const fast = await runScenario(
      restartScenario(node.url),
      driver(fakeSsh(slowNode(fastMarker))),
      60_000,
      false,
      4,
    )
    expect(fast.outcome).toBe('pass')
    expect(fast.errorKind).toBeUndefined()
  }, 120_000)

  it('那趟 ssh 自己的墙钟预算同乘 —— 否则远端还在轮询就被 SIGKILL', async () => {
    // 假 ssh 让启动那一趟真的耗 3 s（远端起得慢的样子），之后才写 banner。
    // 这条脚本**不看** `seq` 拍数，所以两次跑唯一的差别就是 `#ssh` 的超时。
    const slowSsh = (marker: string): string =>
      [
        `if [[ "$cmd" == *"setsid bun"* ]]; then`,
        `  sleep 3`,
        `  printf '{"publicKey":"fake-key"}\\n' > '${marker}'`,
        `  exit 0`,
        `fi`,
        `if [[ "$cmd" == *"out.log"* ]]; then cat '${marker}' 2>/dev/null; exit 0; fi`,
        BASE,
      ].join('\n')

    const node = fakeNodeServer()
    // 倍率 0.02 → 120 s × 0.02 = 2.4 s，短于远端那 3 s：ssh 被 SIGKILL，
    // banner 永远写不出来。改造前这里恒是 120 s，这一跑会成功。
    const killedMarker = tmpFile('marker-killed')
    const killed = driver(fakeSsh(slowSsh(killedMarker)))
    await expect(
      killed.restartNode(bareCtx(0.02), disposableHandle(node.url)),
    ).rejects.toThrow('没有起来')

    // 倍率 0.06 → 7.2 s，宽于那 3 s：同一个假 ssh 这次跑完，整条路径走通。
    const okMarker = tmpFile('marker-ok')
    const ok = driver(fakeSsh(slowSsh(okMarker)))
    const back = await ok.restartNode(bareCtx(0.06), disposableHandle(node.url))
    expect(back.name).toBe(DISPOSABLE_SPEC.name)
  }, 120_000)

  /**
   * 隧道自己死掉时，说的是「套件的链路断了」，不是「节点起来了但拨不通」。
   *
   * ## 这条钉的是 issue #105
   *
   * `#tunnel` 第一版只返回端口、把 ssh 子进程的句柄丢掉。隧道一旦自己退出
   * （本地口被抢、远端拒转发、网断），本地口就没人听 —— 而拨号方看到的只是
   * `1006 Failed to connect`，与「节点根本没起来」长得一模一样。于是就绪循环
   * 对着一个死掉的本地口拨满整个预算（真机腿上是 266 s），最后写下一句
   * **关于被测节点的假结论**。
   *
   * 两件事一起钉：话要说对（`errorKind=transport`、文本点名链路），以及
   * **要快** —— 拨满预算再说错话和当场说错话，前者还多烧四分钟。
   */
  it('转发隧道自己死了：说的是链路失败，且不拨满预算（issue #105）', async () => {
    const landed = (marker: string): string =>
      [
        `if [[ "$cmd" == *"setsid bun"* ]]; then`,
        `  printf '{"publicKey":"fake-key"}\\n' > '${marker}'`,
        `  exit 0`,
        `fi`,
        `if [[ "$cmd" == *"out.log"* ]]; then cat '${marker}' 2>/dev/null; exit 0; fi`,
        BASE,
      ].join('\n')

    // 倍率 1 = 60 s 的就绪预算。端口 45999 上没有任何东西在听，所以
    // `rawDial` 每一拍都是 1006 —— 与真机腿上那次一模一样的现场。
    const d = driver(fakeSsh(landed(tmpFile('marker-dead-tunnel'))))
    const began = Date.now()
    const err = await transportThrow(
      async () =>
        await d.restartNode(bareCtx(1), disposableHandle(undefined, false)),
    )
    const took = Date.now() - began

    // ① 话说对了：点名是链路、带上隧道临死前那句话，且**不含**那句关于节点的。
    expect(err.message).toContain('转发隧道')
    expect(err.message).toContain('Address already in use')
    expect(err.message).not.toContain('起来了但拨不通')
    // ② 没拨满预算。60 s 的一小半都用不到 —— 第一拍拨不通就问隧道。
    expect(took).toBeLessThan(20_000)
  }, 120_000)

  it('隧道活着的时候不抢话 —— 拨不通仍然按「节点起来了但拨不通」报', async () => {
    const landed = [
      `if [[ "$cmd" == *"setsid bun"* ]]; then exit 0; fi`,
      `if [[ "$cmd" == *"out.log"* ]]; then printf '{"publicKey":"k"}\\n'; exit 0; fi`,
      BASE,
    ].join('\n')
    // 同样拨不通，但隧道好好活着 —— 那这条结论就该落在被测节点头上。
    const d = driver(fakeSsh(landed))
    await expect(
      d.restartNode(bareCtx(0.02), disposableHandle(undefined, true)),
    ).rejects.toThrow('起来了但拨不通')
  }, 120_000)

  it('ssh 那格必须宽于远端轮询那格 —— 两者乘同一个倍率，余量在任何倍率下都在', () => {
    const source = readFileSync(
      new URL('../fleet/driver.ts', import.meta.url),
      'utf8',
    )
    const read = (name: string): number =>
      Number.parseInt(
        new RegExp(`const ${name} = ([0-9_]+)`)
          .exec(source)?.[1]
          ?.replaceAll('_', '') ?? '0',
        10,
      )
    const remote = read('REMOTE_BANNER_POLL_BUDGET_MS')
    const ssh = read('REMOTE_LAUNCH_SSH_BUDGET_MS')
    expect(remote).toBeGreaterThan(0)
    // 远端还在轮询就把 ssh 掐掉 = 把「起得慢」记成一次链路失败，方向正好反了。
    expect(ssh).toBeGreaterThan(remote)
    // 两处调用点都必须写成 `× ctx.timeoutScale`，一处漏掉就是 #91 的原病。
    const scaled = source.split(
      'REMOTE_LAUNCH_SSH_BUDGET_MS * ctx.timeoutScale',
    )
    expect(scaled).toHaveLength(3)
    const ticks = source.split('remotePollTicks(ctx.timeoutScale)')
    expect(ticks).toHaveLength(3)
    // 裸的 `seq 1 <常数>` 只剩「等进程死掉」那两处（`seq 1 20`），它们不是
    // 就绪竞速，后面还紧跟一刀 `kill -KILL` 兜底。
    const bare = [...source.matchAll(/for _ in \$\(seq 1 (\d+)\)/g)].map(
      m => m[1],
    )
    expect(bare).toEqual(['20', '20', '20'])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// #98 那张表的第 5、6、7 条与第 22 条的另一半：**一次成功的 spawn 之后**，
// 句柄上那几个闭包各自的行为。
//
// 这四条此前只有结构棘轮，没有行为护栏，当时的结论是「拿到句柄要一次真的
// WebSocket 握手，假 ssh 搭不出来」。复核之后那条结论不成立 —— 握手的对端是
// `endpoint`，而 `endpoint` 是**调用方给的**（`restartNode` 直接透传句柄那一
// 栏，`consoleSlot` 那条则经 `ctx.allocPort()`）。所以两条真路径都跑得完整：
// 节点侧起一个本地 WebSocket 假节点（{@link fakeNodeServer}），控制台侧起一个
// 本地 HTTP 假控制台答 `/v0/health` 200。
//
// 钉的是同一件事：**一次 rc=255 不许折成一段空文本 / 一句「节点死了」。**
// 那几个闭包全是喂给场景断言的输入，静默变空会以「产品坏了」的形态红。
// ---------------------------------------------------------------------------

/**
 * 「先照常答，等测试点火之后再链路失败」的假 ssh 分支。
 *
 * 一次成功的启动必须先发生（`#launchDisposable` 读 banner 用的是同一条
 * `cat out.log`），所以不能一上来就 255 —— 用一个标记文件当开关。
 */
function armable(match: string, arm: string, answer: string): string {
  return [
    `if [[ "$cmd" == *${JSON.stringify(match)}* ]]; then`,
    `  if [ -f '${arm}' ]; then printf '${CLOSED}\\n' >&2; exit 255; fi`,
    `  printf '${answer}\\n'`,
    `  exit 0`,
    `fi`,
  ].join('\n')
}

describe('一次性句柄的三个闭包（第 5、6、7 条）', () => {
  /** 起一个真的一次性节点句柄，外加「让某条命令开始链路失败」的开关。 */
  async function launched(): Promise<{
    readonly node: NodeHandle
    readonly arm: () => void
  }> {
    const armFile = tmpFile('arm')
    const server = fakeNodeServer()
    const d = driver(
      fakeSsh(
        [
          `if [[ "$cmd" == *"setsid bun"* ]]; then exit 0; fi`,
          // `alive` 那条：链路好的时候如实答 alive，点火之后 255。
          armable('echo alive', armFile, 'alive'),
          armable('err.log', armFile, 'some stderr'),
          armable('out.log', armFile, '{"publicKey":"fake-key"}'),
          BASE,
        ].join('\n'),
      ),
    )
    const node = await d.restartNode(bareCtx(1), disposableHandle(server.url))
    return {
      node,
      arm: (): void => {
        writeFileSync(armFile, 'x')
      },
    }
  }

  it('先证明这条真路径跑得通 —— 三个闭包在链路好的时候如实作答', async () => {
    const { node } = await launched()
    expect(node.name).toBe(DISPOSABLE_SPEC.name)
    expect(await node.stdout()).toContain('"publicKey"')
    expect((await node.stderr()).trim()).toBe('some stderr')
    expect(await node.alive()).toBe(true)
  }, 60_000)

  it('rc=255 之后：`stdout` 不许静默变空，`alive` 不许答「节点死了」', async () => {
    const { node, arm } = await launched()
    arm()
    // 改之前这三条都是裸 `#ssh`：stdout 折成空串（证据栏静默变空）、
    // stderr 同样、`alive` 因为 stdout 里没有 `alive` 而答 false ——
    // 「节点死了」是一条**关于被测系统的观察**，而这一趟根本没问到。
    await transportThrow(async () => await node.stdout())
    await transportThrow(async () => await node.stderr())
    await transportThrow(async () => await node.alive())
  }, 60_000)

  it('远端命令自己非零仍按观察处理 —— 不冒充链路失败', async () => {
    const server = fakeNodeServer()
    const d = driver(
      fakeSsh(
        [
          `if [[ "$cmd" == *"setsid bun"* ]]; then exit 0; fi`,
          `if [[ "$cmd" == *"out.log"* ]]; then printf '{"publicKey":"k"}\\n'; exit 0; fi`,
          // 日志文件真的不存在：远端 `cat … || true` 回 0 且什么都没有。
          `if [[ "$cmd" == *"err.log"* ]]; then exit 0; fi`,
          `if [[ "$cmd" == *"echo alive"* ]]; then printf 'dead\\n'; exit 0; fi`,
          BASE,
        ].join('\n'),
      ),
    )
    const node = await d.restartNode(bareCtx(1), disposableHandle(server.url))
    // 空 stderr 与一句真的 `dead` 都是**被测系统的回答**，原样交出去。
    expect(await node.stderr()).toBe('')
    expect(await node.alive()).toBe(false)
  }, 60_000)
})

describe('一次性控制台句柄的两个闭包（第 21、22 条）', () => {
  /**
   * 起一个真的一次性控制台句柄。
   *
   * 就绪判据是 `GET <隧道本地口>/v0/health` 答 200 —— 那个本地口来自
   * `ctx.allocPort()`，测试自己说了算，于是在同一个口上起一个假控制台就够了。
   * 隧道那条 `ssh -N -L` 由假 ssh 扮演（起来就退，不影响判据）。
   */
  async function started(armFile: string): Promise<{
    readonly banner: () => Promise<string>
    readonly stderr: () => Promise<string>
  }> {
    const port = 45_998
    const health = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: (request): Response =>
        new URL(request.url).pathname === '/v0/health'
          ? new Response('ok')
          : new Response('no', { status: 404 }),
    })
    openServers.push({
      stop: (): void => {
        void health.stop(true)
      },
    })
    const d = driverWithConsole(
      fakeSsh(
        [
          `if [[ "$cmd" == *"setsid bun"* ]]; then exit 0; fi`,
          armable('console.err.log', armFile, 'console stderr'),
          armable(
            'console.out.log',
            armFile,
            'view-token vvv\\nadmin-token aaa',
          ),
          BASE,
        ].join('\n'),
      ),
    )
    const slot = await d.consoleSlot(bareCtx(1))
    const handle = await slot.start({ registryUrl: 'http://127.0.0.1:39999' })
    expect(handle.adminToken).toBe('aaa')
    expect(handle.viewToken).toBe('vvv')
    return { banner: handle.banner, stderr: handle.stderr }
  }

  it('链路好的时候如实答，rc=255 之后两条都抛 —— 两枚 token 不许静默丢', async () => {
    const armFile = tmpFile('arm-console')
    const handle = await started(armFile)
    expect(await handle.banner()).toContain('admin-token')
    expect((await handle.stderr()).trim()).toBe('console stderr')

    writeFileSync(armFile, 'x')
    await transportThrow(async () => await handle.banner())
    await transportThrow(async () => await handle.stderr())
  }, 60_000)
})

describe('结构棘轮：不许再出现第 35 个裸 #ssh 调用点', () => {
  /**
   * 这一条才是「不用再挑一遍」的保证。
   *
   * 前两轮真机腿各花两小时，红的都是「有个调用点没被枚举到」—— 第一次在
   * `#scratch`，第二次在 `#freePortOn`。人工扫一遍必然漏，所以把「裸 `#ssh`
   * 只允许出现在这三处」写成断言：新加一个调用点必须先选 `#read` / `#once` /
   * `#diag` 中的一个，选不出来就说明它的幂等性没想清楚。
   */
  it('裸 this.#ssh( 只剩三处，且各有各的理由', () => {
    const source = readFileSync(
      new URL('../fleet/driver.ts', import.meta.url),
      'utf8',
    )
    const lines = source.split('\n')
    const bare: string[] = []
    lines.forEach((line, i) => {
      if (!line.includes('this.#ssh(')) return
      bare.push(`${String(i + 1)}: ${line.trim()}`)
    })
    // ① / ② `#sshRetry` 的重发循环（首发与重发各一处）；
    // ③ `#once` 的那一次；
    // ④ `#reverseTunnel` 的轮询 —— 那个 for 循环自己就是重试，注释写了为什么。
    expect(bare).toHaveLength(4)
    const where = bare.join('\n')
    expect(where).toContain('let result = await this.#ssh(')
    expect(where).toContain('result = await this.#ssh(')
    expect(where).toContain('const probe = await this.#ssh(')
    expect(where).toContain('const result = await this.#ssh(')
  }, 60_000)

  it('那张全表还在 —— 34 条一条不少，改动调用点必须同步改它', () => {
    const source = readFileSync(
      new URL('../fleet/driver.ts', import.meta.url),
      'utf8',
    )
    const table = source.slice(
      source.indexOf('| # | 调用点 | 远端命令 |'),
      source.indexOf('另有两处**本来就对、不用改**'),
    )
    const rows = table
      .split('\n')
      .filter(l => /^\s*\* \| \d+ \|/.test(l))
      .map(l => Number.parseInt(/\| (\d+) \|/.exec(l)?.[1] ?? '0', 10))
    expect(rows).toHaveLength(34)
    // 编号连续 —— 缺一条就是漏了一个调用点。
    expect(rows).toEqual(Array.from({ length: 34 }, (_, i) => i + 1))

    // **表的行数必须等于真实调用点数。**上面两条只证明「表自己是完整的
    // 1..34」，一张停在 2026-08 的表照样能通过 —— 而这条 issue 的病根恰恰是
    // 「有个调用点没人看过」。所以再钉一次真实计数：新加一个 `#read` / `#once`
    // / `#diag` 而不往表里补一行，这里就红。
    const used = ['#read(', '#once(', '#diag('].reduce(
      (n, w) => n + source.split(`this.${w}`).length - 1,
      0,
    )
    expect(used).toBe(rows.length)
  }, 60_000)
})
