// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 本地驱动 —— 在本机起真的 `qm resident` / `qm console` 进程，用真的传输层
 * 拨过去，读真的审计链与 transcript。
 *
 * 三条与既有 demo harness 一致的纪律（照抄理由，不是照抄代码）：
 *
 * ① **一个进程一个 `OCC_CONFIG_DIR`。** 审计链是「一个配置根一个文件」，两个
 *    常驻共用一个根 = 两条哈希链交织进同一个文件，`qm audit --verify` 会报
 *    `chain: broken` —— 一个拓扑错误看起来会像一次篡改。
 *
 * ② **就绪判据是「拨得通」，不是「进程还活着」。** 进程活着但端口没绑上的
 *    窗口真实存在，按 pid 判就绪会让后面每一条断言都在赌运气。
 *
 * ③ **端口显式分配、不用 `--port 0`。** 常驻的启动 banner **不含端口**，
 *    `onReady` 只有进程内调用方拿得到。所以外部驱动只能自己先占一个空闲口
 *    再让出来。注意 Bun 允许两个服务器绑同一个 TCP 口且都不报错，所以分配
 *    之后要靠 ② 的拨号验证真的是自己那个进程在应答。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type {
  AcceptanceDriver,
  AcceptanceRegistry,
  ConsoleSlot,
  DialOptions,
  DialProbe,
  DriverCapability,
  ExecHost,
  ExecResult,
  LauncherHost,
  NodeHandle,
  NodeSpec,
  RegistrySpec,
  ScenarioContext,
} from '../types.js'
import { startConsole, startRegistry } from './console.js'
import { rawDial, type RawAuth } from './dial.js'
import {
  REPO_ROOT,
  runCli,
  sleep,
  spawnCli,
  waitFor,
  type SpawnedProcess,
} from './spawn.js'

/** 验收专用 PSK。长度过 `PSK_MIN_LENGTH`（16），内容无秘密可言。 */
export const ACCEPTANCE_PSK = 'qianmo-acceptance-psk-0000000000'
/** 与上面不同的一把，用来测「错 PSK」。 */
export const WRONG_PSK = 'qianmo-acceptance-psk-9999999999'

/** 时间线文件在配置根里的相对路径 —— 两个驱动共用这一个名字。 */
export const TIMINGS_FILE = 'acceptance-timings.jsonl'

const LOCAL_CAPABILITIES: ReadonlySet<DriverCapability> = new Set([
  'attach-node',
  'spawn-node',
  'spawn-console',
  'restart-node',
  'mutate-node-env',
  'read-node-files',
  'exec-node-cli',
  'raw-dial',
  'run-launcher',
  'stub-upstream',
  'local-ca-fixture',
  'read-repo-source',
])

/** 本地节点句柄：比通用接口多一些只有本地拿得到的东西。 */
export interface LocalNodeHandle extends NodeHandle {
  readonly port: number
  readonly root: string
  /** 时间线文件（`--timings`），场景靠它等 turn 结束。 */
  readonly timingsPath: string
  readonly process: SpawnedProcess
  /** 按同样的参数重启（配置根不变 —— 那是身份与审计链的锚）。 */
  restart(overrides?: Partial<NodeSpec>): Promise<LocalNodeHandle>
}

/**
 * 本地腿唯一缺的那一项，以及为什么缺 —— 这段理由本身是这套件里被引用最多的
 * 一条取舍，所以它必须出现在报告里而不是只在注释里。
 */
const LOCAL_CAPABILITY_GAPS: ReadonlyMap<DriverCapability, string> = new Map([
  [
    'mirror-transport',
    '审计镜像的搬运需要 systemd 定时器 + 隧道 + 源与镜像两台机器，本地腿三个前提一个都不具备；用一次 cp 冒充会得到一条永远绿的场景，而绿的那一刻恰好证明不了任何事 —— 宁可空着',
  ],
])

/*
 * 驱动内部那两个「等它就绪」的墙钟预算。
 *
 * **一条纪律：用它们的地方一律乘 `ctx.timeoutScale`，不许写裸的常数。**
 * 与 `fleet/driver.ts` 顶部那段是同一条 —— 理由完整版在那边，这里只说本地腿
 * 独有的那半句：**CI 的 `acceptance-local` job 跑的正是这条腿，且带
 * `--timeout-scale 3`**（PR #73，理由是 GitHub 托管 runner 是共享虚拟机）。
 * 场景预算放大了 3 倍而这里没有，于是慢 runner 上驱动的等待会**先于**场景预算
 * 炸掉 —— 那种红记的是 `error`（「套件自己炸了」）而不是这条场景本来要说的
 * 话，恰好是会被人当成「套件不稳」而加豁免的那类噪声（issue #91 ①）。
 *
 * 倍率从 `ctx` 取、不在这里读 `FLEET_TIMEOUT_SCALE`：`--timeout-scale` 压得过
 * 那个默认值，驱动自己去读常量就会和场景预算用上两个不同的倍率。一份倍率、
 * 一个出处，出处是 runner。缺省 1，所以接上它是零行为变化。
 */

/** 一个常驻「起来了没有」的等待基准（banner 落地 + 真拨得通，见下）。 */
const NODE_READY_BUDGET_MS = 30_000

/**
 * `ExecHost.run` / `LauncherHost.run` 里一条命令的兜底预算 —— 场景没给
 * `timeoutMs` 时用它。
 *
 * 它**不乘倍率**：这是「一条命令卡死了」的兜底，不是「等它就绪」的墙钟；
 * 场景要更长就显式传 `timeoutMs`（两个 host 的 `run` 都认这个参数）。
 */
const HOST_RUN_BUDGET_MS = 60_000

export class LocalDriver implements AcceptanceDriver {
  readonly target = 'local' as const
  readonly capabilities = LOCAL_CAPABILITIES
  readonly capabilityGaps = LOCAL_CAPABILITY_GAPS
  /** 同一场景里第几个控制台位 —— 见 {@link LocalDriver.consoleSlot}。 */
  #consoleSeat = 0
  /** 同一场景里第几个启动器位。 */
  #launcherSeat = 0

  async startNode(
    ctx: ScenarioContext,
    spec: NodeSpec,
  ): Promise<LocalNodeHandle> {
    const root = join(ctx.workdir, `node-${spec.name}`)
    // 场景给了配置根就用它 —— 那是「证书已经签好、身份已经在里面了」的那种
    // 根（见 {@link NodeSpec.configRoot}）。不给才现开一个。
    const configRoot = spec.configRoot ?? join(root, 'config')
    mkdirSync(configRoot, { recursive: true })
    mkdirSync(join(root, 'state'), { recursive: true })
    for (const cwd of Object.values(spec.agents)) {
      mkdirSync(cwd, { recursive: true })
    }
    return await this.#launch(ctx, spec, root, configRoot)
  }

  async #launch(
    ctx: ScenarioContext,
    spec: NodeSpec,
    root: string,
    configRoot: string,
  ): Promise<LocalNodeHandle> {
    const port = await ctx.allocPort()
    // 时间线放**配置根里面**（而不是旁边的 state/）：驱动接口只暴露
    // `readNodeFile(node, relPath)`，真机腿也只能读到配置根下的东西。放在外面
    // 就成了本地专有的观测面，场景一用它就再也搬不到真机上了。
    const timingsPath = join(configRoot, TIMINGS_FILE)

    const argv = [
      'resident',
      '--node',
      spec.name,
      '--team',
      'acceptance',
      '--port',
      String(port),
      '--hostname',
      '127.0.0.1',
      '--timings',
      timingsPath,
    ]
    for (const [agent, cwd] of Object.entries(spec.agents)) {
      argv.push('--agent', `${agent}=${cwd}`)
    }
    if (spec.omitPolicyFlag !== true) {
      argv.push(
        spec.policy === 'open' ? '--open-policy' : '--require-signed-tasks',
      )
    }
    for (const trust of spec.trust ?? []) argv.push('--trust', trust)
    if (spec.auth.mode !== 'psk') argv.push('--sign-handshake')
    if (spec.auth.mode === 'credential_signature') {
      argv.push('--require-signed-handshake')
    }
    argv.push(...(spec.extraArgs ?? []))

    const psk = spec.auth.mode === 'psk' ? spec.auth.psk : ACCEPTANCE_PSK
    const proc = spawnCli({
      argv,
      env: {
        OCC_IDENTITY: 'qianmo',
        OCC_CONFIG_DIR: configRoot,
        QIANMO_TRANSPORT_PSK: psk,
        ...spec.env,
      },
    })
    ctx.cleanup(() => proc.stop())

    const endpoint = `ws://127.0.0.1:${port}`
    // 就绪判据：banner 落地 **且** 真拨得通（见文件头 ②）。
    await waitFor(() => proc.stdout().includes('"publicKey"'), {
      timeoutMs: NODE_READY_BUDGET_MS * ctx.timeoutScale,
      what: `节点 ${spec.name} 的启动 banner`,
      diagnose: () => `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`,
      signal: ctx.signal,
    })
    // 就绪判据分两档，因为**探针手里只有 PSK**。
    //
    //   · psk / signature 档：签名是可选的，一次 PSK 拨号会被接受，所以判据
    //     就是「握手走完」—— 那也是最强的判据。
    //   · credential_signature 档（`--require-signed-handshake`）：服务端要求
    //     credential proof，而探针拿不到对端的证书与私钥（那是场景自己按需
    //     签发的材料）。这时判据退到「服务端发出了 challenge 帧」：监听口已
    //     绑上、协议已经在说话。**这仍然够用**，因为常驻在开始监听之前会先
    //     `await` 一次证书目录刷新，所以「能收到 challenge」蕴含「目录已就绪」。
    //     早先这里一律按「握手走完」判，于是任何 `--require-signed-handshake`
    //     的节点都起不来 —— 表现是每条场景在 30 s 之后报超时，读起来像常驻
    //     卡死。证书维度的六条场景全撞在这上面。
    const credentialed = spec.auth.mode === 'credential_signature'
    await waitFor(
      async () => {
        // 进程已经退出就别再等了。常驻在 ACP 连续失败五次之后会 park 并退出，
        // 此后再怎么拨都不会有人应答 —— 继续等只是把一条「它死了、这是它的
        // 遗言」拖成一条「超时」，而后者不含任何排查信息。`waitFor` 不吞
        // predicate 抛的异常，所以这里抛就是立刻停。
        if (!proc.alive()) {
          throw new Error(
            `节点 ${spec.name} 在就绪之前就退出了（exit=${
              proc.exitCode() ?? '?'
            }）；stderr:\n${proc.stderr()}`,
          )
        }
        const probe = await rawDial({
          url: endpoint,
          node: 'readiness-probe',
          auth: { kind: credentialed ? 'none' : 'psk', psk },
          settleMs: 50,
          timeoutMs: 3_000,
        })
        return credentialed ? probe.frames.length > 0 : probe.authed
      },
      {
        timeoutMs: NODE_READY_BUDGET_MS * ctx.timeoutScale,
        stepMs: 200,
        what: credentialed
          ? `节点 ${spec.name} 发出 challenge 帧`
          : `节点 ${spec.name} 接受握手`,
        diagnose: () => `stderr:\n${proc.stderr()}`,
        signal: ctx.signal,
      },
    )

    const handle: LocalNodeHandle = {
      name: spec.name,
      spec,
      endpoint,
      // 本地腿上「从 runner 拨」与「从节点自己那台机器拨」是同一件事。
      hostEndpoint: endpoint,
      port,
      root,
      configRoot,
      timingsPath,
      process: proc,
      stderr: async () => proc.stderr(),
      stdout: async () => proc.stdout(),
      alive: async () => proc.alive(),
      restart: async overrides => {
        await proc.stop()
        // 端口要真的放开，否则新进程会静默绑到同一个口上（Bun 不报错）。
        await sleep(300)
        // **配置根原样带过去**，不重新按 overrides 解析：它是身份密钥与审计链
        // 的锚，换一个就不是「重启」而是「另起一个节点」。
        return await this.#launch(
          ctx,
          { ...spec, ...overrides },
          root,
          configRoot,
        )
      },
    }
    return handle
  }

  async stopNode(node: NodeHandle): Promise<void> {
    await (node as LocalNodeHandle).process.stop()
  }

  async restartNode(
    ctx: ScenarioContext,
    node: NodeHandle,
    overrides?: Partial<NodeSpec>,
  ): Promise<NodeHandle> {
    return await (node as LocalNodeHandle).restart(overrides)
  }

  /** SIGKILL，用来制造「上一条命是被打断的」那种现场。 */
  async killNode(node: NodeHandle): Promise<void> {
    const local = node as LocalNodeHandle
    process.kill(local.process.pid, 'SIGKILL')
    await sleep(500)
  }

  async dial(
    _ctx: ScenarioContext,
    node: NodeHandle,
    opts: DialOptions,
  ): Promise<DialProbe> {
    return await rawDial({
      url: node.endpoint,
      node: opts.nodeName ?? dialerNameOf(opts),
      auth: toRawAuth(opts),
      sendBeforeAuth: opts.sendBeforeAuth,
      sendAfterReady: opts.send,
      settleMs: opts.settleMs,
      timeoutMs: opts.timeoutMs,
    })
  }

  async readNodeFile(
    node: NodeHandle,
    relPath: string,
  ): Promise<string | undefined> {
    try {
      return readFileSync(join(node.configRoot, relPath), 'utf8')
    } catch {
      return undefined
    }
  }

  async writeNodeFile(
    node: NodeHandle,
    relPath: string,
    content: string,
  ): Promise<string> {
    const abs = join(node.configRoot, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    return abs
  }

  async setNodePathMode(
    node: NodeHandle,
    relPath: string,
    mode: string,
  ): Promise<void> {
    chmodSync(join(node.configRoot, relPath), Number.parseInt(mode, 8))
  }

  async listNodeDir(
    node: NodeHandle,
    relPath: string,
  ): Promise<string[] | undefined> {
    try {
      return readdirSync(join(node.configRoot, relPath))
    } catch {
      return undefined
    }
  }

  async execNode(
    node: NodeHandle,
    argv: readonly string[],
  ): Promise<ExecResult> {
    return await runCli({
      argv,
      env: {
        OCC_IDENTITY: 'qianmo',
        OCC_CONFIG_DIR: node.configRoot,
        QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK,
      },
    })
  }

  /**
   * 本地的一次性执行位置就是场景 workdir 下的两个子目录 —— runner 已经保证
   * 会清理它，所以这里不再另登记 cleanup。
   */
  async startRegistry(
    ctx: ScenarioContext,
    spec: RegistrySpec = {},
  ): Promise<AcceptanceRegistry> {
    return await startRegistry(ctx, spec)
  }

  /**
   * 本地的控制台位：一层专属目录 + 一个 `start`。
   *
   * 每次调用都换一个目录名（`console-0`、`console-1`…），一个场景里起两个
   * 控制台时两份身份不会互相盖 —— `loadOrCreateNodeKeys` 是 wx 创建、永不
   * 覆盖，共用一个根会让第二个控制台悄悄用上第一个的唤醒身份。
   */
  async consoleSlot(ctx: ScenarioContext): Promise<ConsoleSlot> {
    const seat = `console-${String(this.#consoleSeat++)}`
    const base = await this.#execHostAt(ctx, seat)
    return {
      ...base,
      start: async spec => await startConsole(ctx, base.configDir, spec),
    }
  }

  async execHost(ctx: ScenarioContext): Promise<ExecHost> {
    return await this.#execHostAt(ctx, 'exec-host')
  }

  /**
   * 本地的启动器位。
   *
   * `repoDir` 是一棵**镜像仓库树**：`demo` 软链回真仓库、`dist/cli-node.js`
   * 放一个占位文件。为什么需要它：`common.sh` 把产物路径写死成
   * `$REPO_DIR/dist/cli-node.js` 且不认任何环境变量覆盖，而 `REPO_DIR` 是从
   * `common.sh` 自己的 `BASH_SOURCE[0]` 往上三级推出来的 —— 于是「不先跑一次
   * 真构建就碰不到这条路径」，那正好撞上「不许有手工步骤」。bash 的 `cd` 走
   * 逻辑路径，`pwd` 因此答的是软链那一侧，`REPO_DIR` 就落在镜像上；**跑的仍是
   * 仓库里那份真脚本**，只有它眼中的仓库根被换掉了。唯一被伪造的事实是
   * 「产物存在」这一条。
   *
   * 真机腿不需要这一层 —— 那边 `dist/` 是真的（见 {@link LauncherHost}）。
   */
  async launcherHost(ctx: ScenarioContext): Promise<LauncherHost> {
    const seat = join(ctx.workdir, `launcher-${String(this.#launcherSeat++)}`)
    const repoDir = join(seat, 'repo-mirror')
    const betaRoot = join(seat, 'beta-root')
    const workdir = join(seat, 'work')
    mkdirSync(join(repoDir, 'dist'), { recursive: true })
    writeFileSync(
      join(repoDir, 'dist', 'cli-node.js'),
      '// qianmo acceptance placeholder —— 只为让 beta_require_occ 通过\n',
    )
    if (!existsSync(join(repoDir, 'demo'))) {
      symlinkSync(join(REPO_ROOT, 'demo'), join(repoDir, 'demo'))
    }
    mkdirSync(join(betaRoot, 'run'), { recursive: true })
    mkdirSync(join(betaRoot, 'logs'), { recursive: true })
    mkdirSync(workdir, { recursive: true })
    return {
      describe: 'runner (local)',
      repoDir,
      betaRoot,
      workdir,
      writeFile: async (relPath, content, options) => {
        const abs = join(workdir, relPath)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content, {
          ...(options?.mode === undefined
            ? {}
            : { mode: Number.parseInt(options.mode, 8) }),
        })
        return abs
      },
      // 与 `#execHostAt` 的 `run` 同形，理由也是同一条（见那边的长注释）：
      // **必须是异步 spawn**。本地腿的注册中心与控制台就跑在 runner 这个
      // 进程里（`startRegistryServer` / `Bun.serve`），`Bun.spawnSync` 把
      // 事件循环整条堵死之后，子进程只要回头打 runner 一下就永远等不到
      // 应答 —— 现场是 curl 超时（退出码 28、HTTP 000），读起来像「链路
      // 根本不通」，而链路好得很。
      //
      // 现在没炸只是因为 launcher 那几条场景跑的是 bash 脚本、不回头打
      // runner —— 那是「恰好没踩到」，不是「结构上安全」：哪天有一条
      // launcher 场景要验「脚本起出来的东西够不够得着注册中心」（#86 给
      // 证书维度加的那种对照就是这个形状），它会立刻踩中，且现场指向错误
      // 的方向。真机腿的 `launcherHost.run` 走 ssh、天生异步，两条腿在这
      // 里必须同形，否则同一条断言在本地恒红、在真机恒绿（issue #89）。
      //
      // 顺带把 `options.timeoutMs` 真正接上 —— 此前它和 `execHost.run`
      // 那次一样被整个忽略，超时只能靠外层场景超时兜，而那一层报的是
      // 「场景超时」，归因不到具体命令。
      run: async (argv, options) => {
        const child = Bun.spawn([...argv], {
          cwd: REPO_ROOT,
          env: { ...process.env, ...options?.env },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timeoutMs = options?.timeoutMs ?? HOST_RUN_BUDGET_MS
        const collected = (async () => {
          const [stdout, stderr] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          return { code: await child.exited, stdout, stderr }
        })()
        const settled = await Promise.race([
          collected,
          sleep(timeoutMs).then(() => undefined),
        ])
        if (settled !== undefined) return settled
        child.kill('SIGKILL')
        const partial = await collected
        return {
          code: -1,
          stdout: partial.stdout,
          stderr:
            `${partial.stderr}\n` +
            `[acceptance] 命令超时 ${String(timeoutMs)}ms: ${argv.join(' ')}`,
        }
      },
      exists: async absPath => existsSync(absPath),
      readFile: async absPath => {
        try {
          return readFileSync(absPath, 'utf8')
        } catch {
          return undefined
        }
      },
    }
  }

  async #execHostAt(ctx: ScenarioContext, seat: string): Promise<ExecHost> {
    const configDir = join(ctx.workdir, seat, 'config')
    const workdir = join(ctx.workdir, seat, 'work')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(workdir, { recursive: true })
    return {
      describe: `runner (local, ${seat})`,
      configDir,
      workdir,
      exec: async (argv, opts) =>
        await runCli({
          argv,
          env: {
            OCC_IDENTITY: 'qianmo',
            OCC_CONFIG_DIR: opts?.configDir ?? configDir,
            QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK,
            ...(opts?.env ?? {}),
          },
          ...(opts?.timeoutMs === undefined
            ? {}
            : { timeoutMs: opts.timeoutMs }),
        }),
      // 必须是**异步** spawn，`Bun.spawnSync` 在这里是个陷阱：本地腿的注册
      // 中心（与控制台）就跑在 runner 这个进程里（`startRegistryServer`），
      // 同步 spawn 把事件循环整条堵住之后，子进程要是回头打 runner 一下，
      // 那一下永远等不到应答 —— 现场是 curl 超时（退出码 28、HTTP 000），
      // 读起来像「链路根本不通」，而链路好得很。
      // 实测：同一个进程里 `spawnSync` 打自己的 serve 是 28/000，换成
      // `Bun.spawn` 是 200。真机腿走 ssh、天生异步，两条腿在这里必须同形，
      // 否则同一条断言在本地恒红、在真机恒绿。
      // 顺带把 `opts.timeoutMs` 真正接上 —— 此前它被整个忽略。
      run: async (argv, opts) => {
        const child = Bun.spawn([...argv], {
          cwd: workdir,
          env: { ...process.env, ...opts?.env },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timeoutMs = opts?.timeoutMs ?? HOST_RUN_BUDGET_MS
        const collected = (async () => {
          const [stdout, stderr] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          return { code: await child.exited, stdout, stderr }
        })()
        const settled = await Promise.race([
          collected,
          sleep(timeoutMs).then(() => undefined),
        ])
        if (settled !== undefined) return settled
        child.kill('SIGKILL')
        const partial = await collected
        return {
          code: -1,
          stdout: partial.stdout,
          stderr:
            `${partial.stderr}\n` +
            `[acceptance] 命令超时 ${String(timeoutMs)}ms: ${argv.join(' ')}`,
        }
      },
      writeFile: async (relPath, content) => {
        const abs = join(workdir, relPath)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
        return abs
      },
      mkdir: async relPath => {
        const abs = join(workdir, relPath)
        mkdirSync(abs, { recursive: true })
        return abs
      },
      readFile: async pathOrRelPath => {
        try {
          return readFileSync(
            isAbsolute(pathOrRelPath)
              ? pathOrRelPath
              : join(workdir, pathOrRelPath),
            'utf8',
          )
        } catch {
          return undefined
        }
      },
      freePort: async () => await ctx.allocPort(),
    }
  }
}

function dialerNameOf(opts: DialOptions): string {
  return opts.auth.mode === 'psk' || opts.auth.mode === 'none'
    ? 'probe-node'
    : opts.auth.nodeName
}

function toRawAuth(opts: DialOptions): RawAuth {
  if (opts.auth.mode === 'none') return { kind: 'none' }
  if (opts.auth.mode === 'psk') {
    return { kind: 'psk', psk: opts.auth.psk }
  }
  throw new Error(
    'LocalDriver.dial 只处理 psk / none；签名类拨号请直接用 rawDial（它能拼非法组合）',
  )
}
