// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 真机舰队驱动 —— 四节点 + 控制台，走真实链路。
 *
 * ## 状态：已对真舰队跑过（2026-08-24）
 *
 * 第一轮真跑正如预言的那样是一次调试：套件报 `pass=11 fail=0 skip=104` + exit 0
 * +「判定: PASS」，而这个驱动**一次都没被调用过**（issue #61）。那轮的红不在
 * 被测系统上，在套件上。修完的现在：`startNode`(附着) / `alive` / `stdout` /
 * `stderr` / `listNodeDir` / `readNodeFile` / `execNode` / `execHost` / `dial` /
 * `inspectMirrorTransport` 都对着真机验过。
 *
 * **拨号地址是这个文件最容易再错一次的地方**，见 {@link FleetHost.endpoint}。
 *
 * ## 两种节点句柄，别混用（issue #65）
 *
 * `startNode` 在这条腿上有**两条**分岔，由 {@link NodeSpec.attach} 选：
 *
 * | | 是什么 | 谁用 | 能不能停/重启/写 |
 * | --- | --- | --- | --- |
 * | 附着 | 部署好的那台内测节点本人 | 声明 `attach-node` 的场景 | **一律不能** |
 * | 一次性 | 在一台舰队机器上现起的、跑完就杀掉并 `rm -rf` 的常驻 | 声明 `spawn-node` 的场景 | 能 |
 *
 * 「一次性节点」不是「重起内测节点」的委婉说法 —— 那件事仍然禁止，
 * {@link FleetDriver.stopNode} 对附着句柄照旧抛。它跑的是**那台机器上部署好的
 * 那个 `dist/cli-node.js`**，在真机的内核与架构上，只是配置根、端口、PSK 全是
 * 本场景自己的。于是：
 *
 *   · **正向拨号第一次成为可能**，而且**一把生产 PSK 都不需要读**。此前这条腿
 *     的数据面只有「错 PSK → 4003」一条，信封投递 / 能力 token / 限额在线上
 *     一条都没验过（PR #63 自陈的第 2 条缺口）。
 *   · 篡改、重启、硬杀这类**要动配置根**的场景也成立了 —— 动的是一次性根。
 *
 * ## 与本地驱动的**能力差**，以及为什么
 *
 * 真机腿仍然**没有**这两种能力，需要它们的场景如实记 `skip`：
 *
 * | 能力 | 为什么没有 |
 * | --- | --- |
 * | `mutate-node-env` | 本轮没有场景要它。一次性节点上它随 `restart-node` 一起成立，但没有场景验证过 —— 不声明未经验证的能力 |
 * | `stub-upstream` | 真机打真实模型端点，那正是真机腿的意义；插一个假上游会把这条腿变成一次慢十倍的本地跑 |
 *
 * `local-ca-fixture` **已经补齐**（此前卡在签发顺序上）：`execHost` 多了
 * `forNodeSpawn`（夹具位落在本场景的落机上）、`readFile`（产物回 runner）与
 * `run`（openssl），`NodeSpec.configRoot` 让「先签证书、再用同一个根起节点」
 * 这个顺序成立。于是离线 CA 那条链在真机上跑的是**部署好的那个
 * `dist/cli-node.js`** 的 `qm ca` / `qm cert`，证书文件也真的在节点那台机器上。
 *
 * ## 一次性节点落在哪台机器上
 *
 * 轮转 {@link DEFAULT_SPAWN_MACHINES}：`cornna-p2` / `cornna-p3` / `cornna-p7`
 * （aarch64）+ `workbench-iap`（x86_64）。**承载 beta-4 的那台不在里面**，理由
 * 是内存：它一共 967 MB、可用约 380 MB，而一个常驻带上它的 ACP 子进程实测占
 * **约 370 MB**。在它上面起第二个常驻，最可能的结局是 OOM killer 挑走
 * beta-4 —— 而「跑完舰队仍然是好的」是这条腿的前置条件，不是它的目标。
 * x86_64 的覆盖由 H 提供，架构面没有因此变窄。
 *
 * ## 舰队拓扑
 *
 * 四节点 `cornna-p2`(beta-1) / `cornna-p3`(beta-2) / `cornna-p7`(beta-3) /
 * `cornna-p11`(beta-4)，控制台在 `workbench-iap`。
 *
 * **别名不是身份，动手前先验 `hostname`。**2026-08-25 `~/.ssh/config` 里
 * `cornna-p11` / `cornna-p12` 被对调过一次：beta-4 一直在 `ECS114873`（967 MB）
 * 上跑，而那台的别名从 `cornna-p12` 变成了 `cornna-p11`；`cornna-p12` 现在指向
 * 另一台空机 `ECS111744`（464 MB，没有 `~/qianmo-beta`）。改别名不改机器，所以
 * 下面那条「内存不够、不进一次性表」的理由跟着**机器**走，不跟着别名走。
 *
 * **`bun` 在每一台上都位于 `~/.bun/bin/bun`，非交互 SSH 解析不到**（H 上实测
 * `which bun` 也答不出来）—— 这正是 issue #40 那次事故的成因，所以每条远端命令
 * 都显式补 PATH。别把它「简化」掉。
 *
 * **一次性常驻用 `setsid` 起**，于是它和它的 ACP 子进程落在同一个进程组里，
 * `kill -- -<pid>` 一次收干净。实测不加这一步的话，杀掉常驻会把 ACP 子进程
 * （约 250 MB）留在机器上，一轮下来能攒出几十个。
 *
 * ## SSH 连接复用：一台机器一次真握手（issue #100）
 *
 * 一轮 105 条场景 × 每条十几到二十几次 SSH ≈ 两千次**连接建立**，而
 * `Connection closed by <ip> port 22` 发生在握手阶段、远端命令一行都没执行到。
 * 连着两轮真跑都是「产品满分、栽在一次握手抖动上」，且**每轮出在不同的调用点**
 * —— 追着补重试永远追不上，何况 34 个调用点里 11 个非幂等（见
 * {@link FleetDriver.#once}）。
 *
 * 所以 {@link FleetDriver.#ssh} 现在走 `ControlMaster`：两千次连接建立 → 五次。
 * 做法、`ControlPath` 的长度账、以及「建不起来时如实红」都写在
 * {@link SshMultiplex} 的头注里。三件与本文件有关的：
 *
 *   · **两条长命隧道显式退出复用**（{@link TUNNEL_NO_MUX_ARGS}）；
 *   · **收尾在 {@link FleetDriver.dispose}**，由入口的 `finally` 与信号处理器
 *     调用，不靠 `ControlPersist` 超时；
 *   · `QIANMO_ACCEPTANCE_SSH_MULTIPLEX=0` 一键退回老路。
 *
 * 顺带一个好处：来源探针（{@link FleetDriver.testedProvenance}）在场景循环**之
 * 前**就把五台机器都问了一遍，于是那五次真握手的开销落在任何场景预算之外。
 */

import { randomBytes } from 'node:crypto'
import type {
  AcceptanceConsole,
  AcceptanceDriver,
  AcceptanceRegistry,
  ConsoleSlot,
  ConsoleSpec,
  DialOptions,
  DialProbe,
  DriverCapability,
  ExecHost,
  ExecHostWhere,
  ExecResult,
  LauncherHost,
  MirrorTransportReport,
  MirrorTransportUnit,
  NodeHandle,
  NodeSpec,
  RegistrySpec,
  ScenarioContext,
  TestedProvenance,
  TestedUnitProvenance,
} from '../types.js'
import {
  consoleLaunch,
  http,
  startRegistry,
  tokensFromBanner,
} from '../local/console.js'
import { rawDial } from '../local/dial.js'
import { ACCEPTANCE_PSK, TIMINGS_FILE } from '../local/driver.js'
import { TRAIL_PATH } from '../observe.js'
import { SshMultiplex, TUNNEL_NO_MUX_ARGS } from './sshMux.js'
import {
  isRetriableTransportFailure,
  isTransportFailure,
  TRANSPORT_RETRY_ATTEMPTS,
  TRANSPORT_RETRY_BACKOFF_MS,
  TransportFailure,
  transportSignature,
} from '../transport.js'

/**
 * 一次性目录的家目录相对前缀。
 *
 * 放在 `.cache` 下而不是内测根下：那棵树是部署产物，验收不该往里塞东西；
 * 而这个前缀出现在每一次 `rm -rf` 的路径里，是那条命令的安全前提。
 */
const SCRATCH_PREFIX = '.cache/qianmo-acceptance'

/** 一台真机。 */
export interface FleetHost {
  /** SSH 目标（`~/.ssh/config` 里的别名），如 `cornna-p2`。 */
  readonly ssh: string
  /** 节点名，如 `beta-1`。 */
  readonly node: string
  /**
   * 拨号地址。**这是 runner 那一侧看到的地址，不是节点自己看到的。**
   *
   * 节点在自己机器上听 `127.0.0.1:38625`（四台一模一样），所以直接写那个值
   * 等于让 runner 去拨自己的 38625 —— 那正是 issue #61 第 3 条：四台共用一个
   * 常量、从舰队外拨永远拨不到任何一台。数据面本身是好的，缺的只是**按主机
   * 分配的端口**。见 {@link FleetHost.tunnelPort} 与 {@link fleetConfigFromEnv}。
   */
  readonly endpoint: string
  /**
   * 这台节点在**控制台机器 H** 上的隧道入口端口（38631–38634，一台一个）。
   *
   * 数据面是 H 单点辐射：H 上四条 `qianmo-tunnel@<节点>` 把
   * `127.0.0.1:3863x` 转到各自节点的 38625。所以「从舰队外拨得到某台节点」
   * 等价于「能打到 H 的 3863x」。
   */
  readonly tunnelPort: number
  /** 节点配置根的**绝对路径**，如 `/home/cornna/qianmo-beta/nodes/beta-1/config`。 */
  readonly configRoot: string
  /** `dist/cli-node.js` 的绝对路径。 */
  readonly occPath: string
  /** 额外要补进 PATH 的目录（`~/.bun/bin`，非交互 SSH 解析不到它）。 */
  readonly extraPath?: string
}

/**
 * 一台能承载**一次性进程**的舰队机器。
 *
 * 与 {@link FleetHost} 分开而不是加个布尔字段：`FleetHost` 的每个字段都描述
 * 「这台机器上那个内测节点」（节点名、隧道口、生产配置根），而承载一次性进程
 * 只需要「SSH 得到、有部署好的产物、有 bun」。控制台机器 H 满足后者却一个前者
 * 都没有 —— 塞进 `hosts` 会立刻污染 {@link FleetDriver.inspectMirrorTransport}
 * （它逐台去问 `qianmo-mirror@<节点>`）和 `execHost` 的轮转。
 */
export interface SpawnMachine {
  /** SSH 目标。 */
  readonly ssh: string
  /** 进证据用的标签，形如 `cornna-p2 (aarch64)`。 */
  readonly label: string
  /** 部署检出相对家目录的位置，如 `atlas-beta`。 */
  readonly repoRel: string
}

export interface FleetConfig {
  readonly hosts: readonly FleetHost[]
  /**
   * 能起一次性节点 / 控制台的机器。空表 = 这条腿没有 `spawn-node`。
   *
   * **不要把内存吃紧的机器放进来**，理由见文件头「一次性节点落在哪台机器上」。
   */
  readonly spawnMachines: readonly SpawnMachine[]
  /**
   * 控制台机器的 SSH 目标（`workbench-iap`）。
   *
   * 驱动此前根本没有「控制台主机」这个概念，而审计镜像的**搬运**那一半全部
   * 发生在它上面：四条 `qianmo-mirror@<节点>` user-scope 单元、镜像文件、
   * 以及跑着的控制台自己申报的滞后上限（issue #62）。
   */
  readonly consoleHost?: string
  /** 传输层 PSK。按节点分的话给一张表。 */
  readonly psk: Readonly<Record<string, string>>
  /** SSH 额外参数。 */
  readonly sshArgs?: readonly string[]
  /**
   * SSH 可执行文件 —— **只给护栏测试用的注入点**，缺省 `ssh`。
   *
   * 存在的理由：`#ssh` 走 `Bun.spawn(['ssh', …])`，而 Bun 在**进程启动时**就把
   * PATH 定住了，测试里改 `process.env.PATH` 对它无效（实测 `Bun.which` 直接回
   * `null`）。于是「假 ssh 回一个 rc=255」这类注入没有别的入口。
   *
   * **`fleetConfigFromEnv` 故意不填它，也没有对应的环境变量** —— 真跑永远是
   * `ssh`。一个能把整条腿指向假二进制的运维开关，换来的风险远大于它的用处。
   */
  readonly sshBin?: string
  /**
   * SSH 连接复用（`ControlMaster`）。**缺省开**；
   * `QIANMO_ACCEPTANCE_SSH_MULTIPLEX=0` 一键退回「每条命令自己建一次连接」。
   *
   * 为什么要这个开关：复用是传输层配置，它出问题的形态（master 卡住、某台机
   * 的 sshd 禁了多路复用）与被测系统毫无关系，而那时候需要的是**一条命令换回
   * 老路**，不是改代码再发一版。为什么默认开：见 {@link SshMultiplex} 的头注，
   * 一轮两千次握手里出一次抖动是必然事件。
   */
  readonly sshMultiplex?: boolean
}

/**
 * 舰队默认拓扑。**裸名 `beta-4` 是黑洞，节点四必须用 `cornna-p11`。**
 *
 * `endpoint` 不写在这里 —— 它由 {@link fleetConfigFromEnv} 按 `tunnelPort` 与
 * 拨号主机现拼，因为「从哪儿拨」是运行环境的事实而不是拓扑的事实。
 */
export const DEFAULT_FLEET_HOSTS: readonly Omit<
  FleetHost,
  'occPath' | 'endpoint'
>[] = [
  {
    ssh: 'cornna-p2',
    node: 'beta-1',
    tunnelPort: 38_631,
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-1/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p3',
    node: 'beta-2',
    tunnelPort: 38_632,
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-2/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p7',
    node: 'beta-3',
    tunnelPort: 38_633,
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-3/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p11',
    node: 'beta-4',
    tunnelPort: 38_634,
    configRoot: '/root/qianmo-beta/nodes/beta-4/config',
  },
]

/**
 * 舰队默认的一次性进程承载机。
 *
 * 承载 beta-4 的那台（现别名 `cornna-p11`）**故意不在里面** —— 它一共 967 MB
 * 内存、可用约 380 MB，而一个常驻 + ACP 子进程实测约 370 MB。见文件头。
 */
export const DEFAULT_SPAWN_MACHINES: readonly SpawnMachine[] = [
  { ssh: 'cornna-p2', label: 'cornna-p2 (aarch64)', repoRel: 'atlas-beta' },
  { ssh: 'cornna-p3', label: 'cornna-p3 (aarch64)', repoRel: 'atlas-beta' },
  { ssh: 'cornna-p7', label: 'cornna-p7 (aarch64)', repoRel: 'atlas-beta' },
  // 与 `DEFAULT_CONSOLE_HOST` 是同一台机器，但**写成字面量**：那个常量声明在
  // 本文件末尾，在这里引用会撞上 TDZ。两处同名不是巧合，是同一台 H。
  {
    ssh: 'workbench-iap',
    label: 'workbench-iap (x86_64)',
    repoRel: 'atlas-beta',
  },
]

/** 一条端口转发的句柄 —— 端口，加上「它自己还活着没有」。 */
interface TunnelHandle {
  readonly localPort: number
  /**
   * 重建预算用完了、这条隧道再也起不来了。
   *
   * **这里故意没有 `alive()`。** 隧道会自己重建（见
   * {@link TUNNEL_REVIVE_ATTEMPTS}），两次之间有一小段谁都不在的窗口 ——
   * 「现在活着吗」在那个窗口里为假，而结论应该是「再等等」。给出那个谓词，
   * 下一个写守卫的人几乎一定会拿它当判据，于是把自愈又变回瞬时判死。
   * 要判「别再等了」只有这一个入口。
   */
  readonly exhausted: () => boolean
  /** 当前那条还活着时是 `null`。 */
  readonly exitCode: () => number | null
  /** 给人看的一句话：死在哪一步、重建过几次、它临死前写的 stderr。 */
  readonly diagnose: () => string
}

/** 一个一次性节点的家当 —— 只有这种句柄才允许停 / 重启 / 往配置根里写。 */
interface DisposableNode {
  readonly machine: SpawnMachine
  /** 目标机上的一次性根（日志与 pid 文件落在它下面）。 */
  readonly root: string
  /**
   * 节点的配置根。缺省是 `${root}/config`，但场景可以经
   * {@link NodeSpec.configRoot} 换成一个**已经装着身份与证书**的根 —— 那正是
   * 证书这一维搬上真机的前提。存在这里而不是每次现算，是因为重启必须复用它。
   */
  readonly configRoot: string
  /** 节点在**它自己那台机器**上监听的端口。 */
  readonly remotePort: number
  readonly occPath: string
  /**
   * runner 够到它的那条转发隧道。**存在这里是为了让就绪循环问得到它** ——
   * 隧道死掉与节点没起来在拨号方看来是同一个 `1006`，不问就会把一次套件侧的
   * 链路故障写成一条关于被测系统的结论（issue #96 立的规矩）。
   */
  readonly tunnel: TunnelHandle
}

interface FleetNodeHandle extends NodeHandle {
  /** 这个句柄落在哪台机器上。 */
  readonly ssh: string
  /** 那台机器上 `dist/cli-node.js` 的绝对路径。 */
  readonly occPath: string
  /**
   * 一次性节点专有。**附着来的内测节点上是 undefined**，而每一个会改动目标
   * 状态的方法（`stopNode` / `restartNode` / `killNode` / `writeNodeFile` /
   * `setNodePathMode`）都先看它 —— 那是「不许动生产」这条纪律在代码里的位置。
   */
  readonly disposable?: DisposableNode
}

/**
 * 真机腿缺的那几项，以及为什么缺。与本文件头注那张表同一批理由 —— 写在这里
 * 是为了让它们进报告：只印一句「缺少能力: spawn-node」的 skip，读的人分不出
 * 「这条腿天然做不到」和「谁忘了实现」。
 */
const FLEET_CAPABILITY_GAPS: ReadonlyMap<DriverCapability, string> = new Map([
  [
    'spawn-node',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）',
  ],
  [
    'spawn-console',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）',
  ],
  [
    'restart-node',
    '重启只对一次性节点开放，而这一轮没有可承载一次性进程的舰队机器；部署好的内测节点永远不重启 —— 那会打断内测使用者，并在它的审计链上留下一次计划外中断',
  ],
  [
    'mutate-node-env',
    '本轮没有场景要它。一次性节点上它随 restart-node 一起成立（restartNode 收 Partial<NodeSpec>，env 在里面），但没有任何场景验证过 —— 不声明未经验证的能力',
  ],
  [
    'run-launcher',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）',
  ],
  [
    'stub-upstream',
    '真机打真实模型端点，那正是这条腿的意义；插一个假上游会把它变成一次慢十倍的本地跑',
  ],
  [
    'local-ca-fixture',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）—— 签发链要跑在被测二进制那台机器上，而这一轮一台都没有',
  ],
  ['mirror-transport', '没有配置控制台主机（QIANMO_ACCEPTANCE_CONSOLE_HOST）'],
])

/*
 * 驱动内部那几个「等它就绪」的墙钟预算。
 *
 * **一条纪律：用它们的地方一律乘 `ctx.timeoutScale`，不许写裸的
 * `Date.now() + <常数>`。**
 *
 * 这几个等待存在的意义是把「起来了但拨不通」和「压根没起来」分开说 —— 一条
 * 指名道姓的错误消息，比让场景撞上通用的场景级超时有用得多。但那份价值有个
 * 前提：**它们必须晚于场景预算触发才对**。倍率此前只作用于场景预算，够不到
 * 驱动内部，于是真机腿（`FLEET_TIMEOUT_SCALE = 4`）或忙 runner（CI 上
 * `--timeout-scale 3`）上它们会先炸，把一条只是慢了一步的场景记成 `error`
 * （「套件自己炸了」）—— 那既不算覆盖也不指向任何产品问题，还恰好是会被人
 * 当成「套件不稳」而加豁免的那类噪声（issue #85 ②，与 PR #69 同一条纪律）。
 *
 * 为什么从 `ctx` 取而不是在这里读 `FLEET_TIMEOUT_SCALE`：`--timeout-scale`
 * 可以压过那个默认值（PR #73），驱动自己去读常量就会和场景预算用上两个不同
 * 的倍率 —— 一份倍率、一个出处，出处是 runner。
 *
 * ## 跑在**远端**的那种预算也算（issue #91 ②）
 *
 * 起一次性节点 / 一次性控制台那两趟里，「等 banner 落地」的轮询是拼进远端
 * 脚本的一句 `for _ in $(seq 1 N); do … sleep 0.5; done`。远端取不到 `ctx`，
 * 所以倍率必须**在 runner 这边算成拍数**再拼进去（{@link remotePollTicks}）；
 * 那一趟 ssh 自己的墙钟预算（{@link REMOTE_LAUNCH_SSH_BUDGET_MS}）同乘。
 * 两个数一起乘才对：只乘 ssh 那个，远端仍然 60 s 就放弃、banner 读空 → 报
 * 「节点没起来」；只乘远端那个，ssh 会在远端还在轮询时被 SIGKILL → 报成一次
 * 链路失败。
 *
 * **`#killGroup` / `#killByPidFile` 里那两个 `seq 1 20` 不在这条纪律里**：
 * 它们等的是「刚被 `kill -TERM` 的那个本地进程死掉没有」，不是一次就绪竞速，
 * 而且后面紧跟一刀 `kill -KILL` 兜底 —— 等满 5 s 不会把任何东西记成红。
 */

/** 一次性节点「拨得通了没有」与一次性控制台 `/v0/health` 的等待基准。 */
const DISPOSABLE_READY_BUDGET_MS = 60_000

/** 反向隧道「通了没有」的等待基准（远端 curl 探一次，每拍一次 SSH 往返）。 */
const REVERSE_TUNNEL_READY_BUDGET_MS = 30_000

/**
 * 一条长命隧道自己死掉之后，最多再把它建回来几次。
 *
 * **重建是幂等的**，所以它该重试 —— 与 {@link FleetDriver.#read} 同一条判据：
 * `ssh -L` / `ssh -R` 在远端不留任何痕迹，重建一次不会让被测系统多看见一个
 * 字节。这跟 `#once` 那半边（起进程、`kill`、`qm ca`）是两回事，别混。
 *
 * 为什么需要它：真机腿有一台走 gcloud IAP，那条 websocket 会半路 EOF ——
 * 第 6 轮实测 `iap_tunnel_websocket.py` 抛 `ConnectionCreationError`，一条
 * 隧道断了就把整轮判红，而它与被测系统毫无关系。这与第 1、2 轮那个「两千次
 * 握手总会抖一次」是同一类问题，而那次的解法同样不是放宽判定，是让链路自己
 * 扛住（issue #100 的连接复用）。
 *
 * **重建用完仍不通就如实红**：`exhausted()` 为真时就绪循环立刻抛，报告里带着
 * 重建次数。自愈不等于把失败藏起来。
 */
export const TUNNEL_REVIVE_ATTEMPTS = 3

/** 每次重建前的退避，按第几次线性放大。 */
const TUNNEL_REVIVE_BACKOFF_MS = 800

/**
 * 远端「等 banner 落地」的轮询预算基准 —— 一次性节点与一次性控制台共用。
 *
 * **这一条跑在远端**（`for _ in $(seq 1 N); do … sleep 0.5; done`），所以倍率
 * 没法在那边现取：要在 runner 这边先算成拍数，再把那个数拼进脚本。见
 * {@link remotePollTicks}。
 *
 * 轮询之所以放在远端而不是每 0.5 s 往返一次 SSH：经 IAP 的那台一次往返要一秒
 * 上下，轮询放在 runner 侧等于给每个节点加半分钟。
 */
const REMOTE_BANNER_POLL_BUDGET_MS = 60_000

/** 远端轮询的一拍（脚本里那个 `sleep 0.5`）。 */
const REMOTE_BANNER_POLL_INTERVAL_MS = 500

/**
 * 起进程那一趟 ssh 自己的墙钟预算基准。
 *
 * **必须宽于 {@link REMOTE_BANNER_POLL_BUDGET_MS}**：远端脚本还在轮询、这边就
 * 把 ssh SIGKILL 掉的话，一次「远端起得慢」会被记成一次链路失败 —— 方向正好
 * 反了。两者乘的是同一个倍率，所以这条余量在任何倍率下都成立（护栏见
 * `fleetTransport.test.ts`）。
 */
const REMOTE_LAUNCH_SSH_BUDGET_MS = 120_000

/**
 * 远端轮询要跑几拍 —— 倍率在 runner 这边算好了再拼进脚本。
 *
 * 至少一拍：倍率给得极小（单测里用 0.02）时也不能拼出 `seq 1 0`，那会让远端
 * 一次都不看就往下走，于是「起得慢」变成「没起来」。
 */
function remotePollTicks(timeoutScale: number): number {
  return Math.max(
    1,
    Math.round(
      (REMOTE_BANNER_POLL_BUDGET_MS * timeoutScale) /
        REMOTE_BANNER_POLL_INTERVAL_MS,
    ),
  )
}

/** 远端轮询那句 `sleep`，秒为单位。 */
const REMOTE_POLL_SLEEP_SEC = String(REMOTE_BANNER_POLL_INTERVAL_MS / 1_000)

/**
 * 采一台机器的「你是哪一版」要等多久。
 *
 * 不乘倍率：这一趟发生在**场景循环之外**（整轮开跑前一次），没有 `ctx`，也就
 * 没有那个倍率可乘。它只是一次 `grep` + 一次 SSH 往返，30 s 足够；而它超时的
 * 后果是**这台报「未知」**，不是整轮炸掉 —— 「问不到」本来就是这条报告要如实
 * 说出来的一种答案。
 */
const PROVENANCE_PROBE_TIMEOUT_MS = 30_000

/**
 * 控制台 banner 落在哪儿。
 *
 * `beta-up.sh` 把控制台的 stdout 送进 `$QIANMO_BETA_ROOT/logs/console.out`，而
 * `QIANMO_BETA_ROOT` 缺省是 `$HOME/qianmo-beta`（见 `demo/env/beta/common.sh`）。
 * 部署改了路径就用 `QIANMO_ACCEPTANCE_CONSOLE_LOG` 指过去 —— 探不到时报告写
 * 「未知」并把试过的路径原样带上，那比猜一个更有用。
 */
const DEFAULT_CONSOLE_LOG = '$HOME/qianmo-beta/logs/console.out'

export class FleetDriver implements AcceptanceDriver {
  readonly target = 'fleet' as const
  readonly capabilities: ReadonlySet<DriverCapability>
  readonly capabilityGaps = FLEET_CAPABILITY_GAPS
  readonly #config: FleetConfig
  /** `execHost` 不点名时的轮转游标 —— 见那个方法的注释。 */
  #execHostCursor = 0
  /** 一次性节点的落机轮转游标 —— 全压第一台等于只覆盖一种架构。 */
  #spawnCursor = 0
  /** `ssh <目标> echo $HOME` 的结果缓存（p12 是 /root，其余是 /home/cornna）。 */
  readonly #homes = new Map<string, Promise<string>>()
  /** 场景 → 它的落机。见 {@link FleetDriver.#machineFor}。 */
  readonly #machines = new WeakMap<ScenarioContext, SpawnMachine>()
  /**
   * 这一轮的 SSH 复用 master —— 一台机器一次真握手（issue #100）。
   *
   * 它**只**接在 {@link FleetDriver.#ssh} 上。两条长命隧道显式退出复用，见
   * {@link TUNNEL_NO_MUX_ARGS}。
   */
  readonly #mux: SshMultiplex

  constructor(config: FleetConfig) {
    this.#config = config
    this.#mux = new SshMultiplex({
      sshBin: config.sshBin ?? 'ssh',
      sshArgs: config.sshArgs ?? [],
      enabled: config.sshMultiplex ?? true,
    })
    const caps: DriverCapability[] = [
      'attach-node',
      'raw-dial',
      'read-node-files',
      'exec-node-cli',
      // 静态断言读的是**运行机上的这份仓库源码**，与目标是本地还是真机无关。
      // 真机腿照跑一遍，是为了「验收当时那份源码长这样」也进真机的报告。
      'read-repo-source',
    ]
    if (config.consoleHost !== undefined) caps.push('mirror-transport')
    if (config.spawnMachines.length > 0) {
      caps.push(
        'spawn-node',
        'restart-node',
        'spawn-console',
        'run-launcher',
        // 签发链跑在落机上（`execHost({ forNodeSpawn: true })`），证书与 CA 根
        // 因此和一次性节点同机。没有落机 = 没有地方跑 `qm ca`，这一项随之消失。
        'local-ca-fixture',
      )
    }
    this.capabilities = new Set(caps)
  }

  /**
   * 一轮结束把 SSH 复用 master 逐台拆掉（issue #100 ③）。
   *
   * **不靠 `ControlPersist` 超时** —— 那些 socket 背后是到生产机的活会话，跑完
   * 之后还挂着几条不可接受。挂在入口的 `finally` 上，于是场景抛异常、超时、
   * 判定失败这些路径都会走到；Ctrl-C 走信号处理器，`process.exit()` 走
   * {@link FleetDriver.disposeSync}。
   *
   * 它**不是** {@link AcceptanceDriver} 的必备项：本地驱动没有跨场景的进程或
   * 套接字要收，那条腿因此逐字节不变。
   */
  async dispose(): Promise<void> {
    await this.#mux.dispose()
  }

  /**
   * 同步版收尾 —— 只给 `process.on('exit')` 那条最后防线用。
   *
   * 正常路径已经在 `finally` 里 `await dispose()` 过了，到这里是空转。留着是
   * 因为「还挂着到生产机的会话」这件事不该依赖任何一条路径没被绕过。
   */
  disposeSync(): void {
    this.#mux.disposeSync()
  }

  /** 这一轮已经建起复用 master 的机器 —— 护栏与排查用。 */
  multiplexedTargets(): readonly string[] {
    return this.#mux.establishedTargets()
  }

  /**
   * 两条分岔：附着到部署好的那台，或在一台舰队机器上起一个一次性节点。
   *
   * 选择权在 {@link NodeSpec.attach} —— 驱动看不到场景的 `requires`，所以
   * 「我要的是一台现成的节点」必须由规格自己说出来。见文件头那张表。
   *
   * 附着分支里 `spec` 的 agent / policy / trust 全部**被忽略**：真机上那些是
   * 部署时决定的，声明 `attach-node` 的场景本来就不关心它们。
   */
  async startNode(ctx: ScenarioContext, spec: NodeSpec): Promise<NodeHandle> {
    if (spec.attach === true) return this.#attach(spec)
    return await this.#spawn(ctx, spec)
  }

  #attach(spec: NodeSpec): FleetNodeHandle {
    const host =
      this.#config.hosts.find(h => h.node === spec.name) ??
      this.#config.hosts[0]
    if (host === undefined) {
      throw new Error('舰队配置里一台机器都没有')
    }
    return {
      name: host.node,
      spec,
      ssh: host.ssh,
      occPath: host.occPath,
      endpoint: host.endpoint,
      // 节点在自己机器上一律听 38625；那个值只有在那台机器上才有意义。
      hostEndpoint: 'ws://127.0.0.1:38625',
      configRoot: host.configRoot,
      stdout: async () => await this.#tail(host, 'out'),
      stderr: async () => await this.#tail(host, 'err'),
      alive: async () => {
        // 纯读一次进程表，重发绝对安全。链路失败时**绝不答 `dead`** —— 那是
        // 一条关于被测系统的观察，而这一趟根本没问到（issue #98 的那张表）。
        const probe = await this.#read(
          host.ssh,
          [
            `test -S /proc/1 || true; pgrep -f "resident --node ${host.node}" >/dev/null && echo alive || echo dead`,
          ],
          `问 ${host.node} 还活着没有`,
        )
        return probe.stdout.includes('alive')
      },
    }
  }

  /**
   * 在一台舰队机器上起一个**一次性**常驻：一次性配置根、自己挑的端口、自己的
   * PSK，跑完杀掉并 `rm -rf`。
   *
   * 三件事必须一起成立，缺一条这个方法就是假的：
   *
   * ① **跑的是那台机器上部署好的 `dist/cli-node.js`**，不是把 runner 的源码
   *    推过去。被测对象是产物 + 那台机器，这条腿的全部价值在这里。
   * ② **runner 拨得到它。** 节点听在目标机的回环上，所以要现开一条
   *    `ssh -L`；隧道的生命周期挂在场景上（见 {@link FleetDriver.#tunnel}）。
   *    这**不是**把「套件不自己建隧道」那条决定推翻了 —— 那条说的是「runner
   *    怎么够得着**既有**舰队」属于运行环境；而这里的端口是驱动自己刚分配的，
   *    除了驱动没有第二个人知道它，谈不上由环境去配。
   * ③ **就绪判据是拨得通**，与本地驱动同一条纪律：进程活着但端口没绑上的窗口
   *    真实存在，何况这里还多一层隧道预热。
   */
  async #spawn(ctx: ScenarioContext, spec: NodeSpec): Promise<NodeHandle> {
    const machine = await this.#machineFor(ctx)
    const home = await this.#homeOf(machine.ssh)
    const occPath = `${home}/${machine.repoRel}/dist/cli-node.js`
    const root = await this.#scratch(ctx, machine.ssh)
    const remotePort = await this.#freePortOn(machine.ssh)
    // 隧道先于进程建：它一旦建好就在整条场景里有效，重启不必重建。
    const tunnel = await this.#tunnel(ctx, machine.ssh, remotePort)
    const disposable: DisposableNode = {
      machine,
      root,
      configRoot: spec.configRoot ?? `${root}/config`,
      remotePort,
      occPath,
      tunnel,
    }
    const endpoint = `ws://127.0.0.1:${String(tunnel.localPort)}`
    return await this.#launchDisposable(ctx, spec, disposable, endpoint)
  }

  /** 起（或重起）一次性常驻，并等到它拨得通。配置根与端口都原样复用。 */
  async #launchDisposable(
    ctx: ScenarioContext,
    spec: NodeSpec,
    disposable: DisposableNode,
    endpoint: string,
  ): Promise<NodeHandle> {
    const { machine, root, configRoot, remotePort, occPath } = disposable
    const psk = spec.auth.mode === 'psk' ? spec.auth.psk : ACCEPTANCE_PSK

    const argv = [
      'resident',
      '--node',
      spec.name,
      // 与本地驱动同一个 team —— 信箱路径按它分目录，两边不一致的话
      // `observe.ts` 的信箱读取在真机腿上会一律读空。
      '--team',
      'acceptance',
      '--port',
      String(remotePort),
      '--hostname',
      '127.0.0.1',
      '--timings',
      `${configRoot}/${TIMINGS_FILE}`,
    ]
    const agentDirs: string[] = []
    for (const agent of Object.keys(spec.agents)) {
      // 规格里的工作区路径是 **runner 上的**，在目标机上不存在。这里只取 agent
      // 名、把工作区落在一次性根下 —— 场景断言的是「哪个 agent 收到了」，
      // 工作区在哪台机器上的哪个目录不是断言对象。
      const dir = `${root}/work/agents/${agent}`
      agentDirs.push(dir)
      argv.push('--agent', `${agent}=${dir}`)
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

    const env: Record<string, string> = {
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: configRoot,
      QIANMO_TRANSPORT_PSK: psk,
      ...spec.env,
    }
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}='${shellQuote(v)}' `)
      .join('')
    const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
    const outLog = `${root}/out.log`
    const errLog = `${root}/err.log`
    const pidFile = `${root}/node.pid`

    // **不重试**：这一趟起进程。重发一次的后果是同一个配置根上两个常驻抢同
    // 一个端口，比一条 `error` 糟得多。只判「有没有走到远端」。
    const started = await this.#once(
      machine.ssh,
      [
        `set -e`,
        // 配置根一起建：场景给的那个根（`NodeSpec.configRoot`）多半已经存在
        // （签发链刚在里面造过身份），而驱动自己开的那个只有 `#scratch` 建过
        // 一次 —— 两种来源在这里合流，`mkdir -p` 对已存在的目录是幂等的。
        `mkdir -p '${shellQuote(configRoot)}' ${agentDirs.map(d => `'${shellQuote(d)}'`).join(' ')}`,
        `: > '${shellQuote(outLog)}'`,
        `: > '${shellQuote(errLog)}'`,
        // `setsid` 让常驻成为新会话的组长，于是它和 ACP 子进程同组，停的时候
        // `kill -- -<pid>` 一次收干净。实测非交互 shell 里 setsid 不会 fork，
        // 所以 `$!` 就是常驻自己的 pid，也就是那个组号。
        `PATH="$HOME/.bun/bin:$PATH" ${envPrefix}setsid bun '${shellQuote(occPath)}' ${quoted} ` +
          `>'${shellQuote(outLog)}' 2>'${shellQuote(errLog)}' </dev/null &`,
        `p=$!`,
        `printf '%s\\n' "$p" > '${shellQuote(pidFile)}'`,
        // 在**远端**轮询 banner，理由见 {@link REMOTE_BANNER_POLL_BUDGET_MS}。
        // 拍数由 runner 这边按倍率算好再拼进来 —— 远端取不到 `ctx`。
        `for _ in $(seq 1 ${String(remotePollTicks(ctx.timeoutScale))}); do`,
        `  if grep -q '"publicKey"' '${shellQuote(outLog)}'; then break; fi`,
        `  if ! kill -0 "$p" 2>/dev/null; then break; fi`,
        `  sleep ${REMOTE_POLL_SLEEP_SEC}`,
        `done`,
        `printf 'node-pid=%s\\n' "$p"`,
      ],
      `在 ${machine.label} 上起一次性节点 ${spec.name}`,
      { timeoutMs: REMOTE_LAUNCH_SSH_BUDGET_MS * ctx.timeoutScale },
    )
    // banner 是纯读一次日志。**这一条必须能分清「读不到」和「里面没有」** ——
    // 一次 rc=255 让 stdout 为空，于是下面那句会说「节点没有起来」，而节点
    // 多半好好地跑着。
    const banner = await this.#read(
      machine.ssh,
      [`cat '${shellQuote(outLog)}' 2>/dev/null || true`],
      `读一次性节点 ${spec.name} 的启动 banner`,
    )
    if (!banner.stdout.includes('"publicKey"')) {
      // 这一段只进错误文本，所以用 `#diag`：它读不到时给一句「取不到」，
      // 而不是抛掉外面那条**已经成立**的结论。
      const diag = await this.#diag(
        machine.ssh,
        [`cat '${shellQuote(errLog)}' 2>/dev/null || true`],
        `一次性节点 ${spec.name} 的 stderr`,
      )
      // **抛**而不是返回一个半死的句柄：`recovery/foreign-identity-refused`
      // 断言的正是这条异常的文本（「拒绝覆盖别人的身份文件」），而一个
      // 「起来了但什么都不答」的句柄会让那条场景在后面某个断言上红得毫无线索。
      throw new Error(
        `一次性节点 ${spec.name} 在 ${machine.label} 上没有起来\n` +
          `启动命令退出码 ${String(started.code)}\n` +
          `stdout:\n${banner.stdout}\nstderr:\n${diag}`,
      )
    }

    const handle: FleetNodeHandle = {
      name: spec.name,
      spec,
      ssh: machine.ssh,
      occPath,
      endpoint,
      hostEndpoint: `ws://127.0.0.1:${remotePort}`,
      configRoot,
      disposable,
      // 三条都是纯读，重发绝对安全 —— 而且三条都是**喂给场景断言的输入**：
      // 静默变空的证据栏与一句假的 `dead` 都会以「产品坏了」的形态红。
      stdout: async () =>
        (
          await this.#read(
            machine.ssh,
            [`cat '${shellQuote(outLog)}' 2>/dev/null || true`],
            `读一次性节点 ${spec.name} 的 stdout`,
          )
        ).stdout,
      stderr: async () =>
        (
          await this.#read(
            machine.ssh,
            [`cat '${shellQuote(errLog)}' 2>/dev/null || true`],
            `读一次性节点 ${spec.name} 的 stderr`,
          )
        ).stdout,
      alive: async () =>
        (
          await this.#read(
            machine.ssh,
            [
              `p="$(cat '${shellQuote(pidFile)}' 2>/dev/null || echo)"`,
              `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo alive; else echo dead; fi`,
            ],
            `问一次性节点 ${spec.name} 还活着没有`,
          )
        ).stdout.includes('alive'),
    }

    // 就绪判据与本地驱动同构，见 `local/driver.ts` 里那段长注释：拿不到对端
    // 证书私钥的场景（`--require-signed-handshake`）只能退到「收到 challenge」。
    const credentialed = spec.auth.mode === 'credential_signature'
    const deadline = Date.now() + DISPOSABLE_READY_BUDGET_MS * ctx.timeoutScale
    for (;;) {
      const probe = await rawDial({
        url: endpoint,
        node: 'readiness-probe',
        auth: { kind: credentialed ? 'none' : 'psk', psk },
        settleMs: 50,
        timeoutMs: 4_000,
      })
      if (credentialed ? probe.frames.length > 0 : probe.authed) break
      // **先问隧道，再问节点。** 隧道自己退出（本地口被抢、远端拒转发、
      // 网络断）之后本地口没人听，拨号只会得到 `1006 Failed to connect` ——
      // 与「节点根本没起来」一模一样。不问它，就会对着一个死掉的本地口拨满
      // 整个预算，然后写下一句关于被测节点的假结论。这是套件到目标机的链路，
      // 判红照旧（见 {@link TransportFailure} 头注），但话要说对。
      //
      // 判据是 `exhausted()` 而不是「现在死了没有」：隧道会自己重建，重建
      // 之间那一小段谁都不在的窗口不是失败，是「再等等」。
      if (disposable.tunnel.exhausted()) {
        throw new TransportFailure({
          ssh: machine.ssh,
          what: `等一次性节点 ${spec.name} 拨得通`,
          code: disposable.tunnel.exitCode() ?? -1,
          stderr: disposable.tunnel.diagnose(),
          attempts: 1,
        })
      }
      if (ctx.signal.aborted || Date.now() >= deadline) {
        // 同上：这一段只进错误文本，读不到时说「取不到」，不掀掉外面那条
        // 已经成立的结论（拨不通是拨号那一侧观察到的，与这次读日志无关）。
        const diag = await this.#diag(
          machine.ssh,
          [`cat '${shellQuote(errLog)}' 2>/dev/null || true`],
          `一次性节点 ${spec.name} 的 stderr`,
        )
        throw new Error(
          `一次性节点 ${spec.name} 在 ${machine.label} 上起来了但拨不通 ` +
            `(${endpoint} → ${machine.ssh}:${String(remotePort)})\n` +
            `最后一次拨号: ${JSON.stringify(probe).slice(0, 400)}\n` +
            `stderr:\n${diag.slice(0, 1_500)}`,
        )
      }
      await sleep(400)
    }
    // **杀进程的清理必须登记在这里，而不是只靠 `#scratch` 的 `rm -rf`。**
    // 第一版漏了这一条，于是一次跑完之后每台机器上都留着还活着的常驻：
    // 清理逆序跑，先拆隧道、再 `rm -rf`，而那个常驻活得好好的，转头就把
    // 配置目录**又建了回来** —— 现场是「目录删了又冒出来、里面只有 config/」，
    // 而真正的问题是一个没人管的进程带着它的 ACP 子进程在内测机上驻留。
    // 登记在这里，逆序就成了「杀进程 → 拆隧道 → 删目录」。
    ctx.cleanup(async () => {
      await this.#killGroup(handle, disposable, 'TERM')
    })
    ctx.log(`一次性节点 ${spec.name} 落在 ${machine.label}，端点 ${endpoint}`)
    return handle
  }

  /**
   * 停一个**一次性**节点。附着来的那台照旧抛 —— 停了内测就断了。
   *
   * 杀的是整个进程组：ACP 子进程与常驻同组，只杀常驻会把它（实测约 250 MB）
   * 留在机器上。
   */
  async stopNode(node: NodeHandle): Promise<void> {
    const disposable = requireDisposable(node, '停')
    await this.#killGroup(node as FleetNodeHandle, disposable, 'TERM')
  }

  /** SIGKILL 掉一个一次性节点 —— 制造「上一条命是被打断的」那种现场。 */
  async killNode(node: NodeHandle): Promise<void> {
    const disposable = requireDisposable(node, '硬杀')
    await this.#killGroup(node as FleetNodeHandle, disposable, 'KILL')
  }

  async #killGroup(
    node: FleetNodeHandle,
    disposable: DisposableNode,
    signal: 'TERM' | 'KILL',
  ): Promise<void> {
    const pidFile = `${disposable.root}/node.pid`
    // **不重试**：`kill` 不幂等（pid 复用之后那一刀会打到别人头上），见
    // `#sshRetry` 的头注。这条要的是「判返回码」而不是「再打一次」——
    // 丢掉返回码的后果是一次性常驻带着它的 ACP 子进程静默活在内测机上，
    // 而报告里一个字都没有（issue #98 ②）。
    const killed = await this.#once(
      node.ssh,
      [
        `p="$(cat '${shellQuote(pidFile)}' 2>/dev/null || echo)"`,
        `[ -n "$p" ] || exit 0`,
        // 先按组杀（`-$p`），组不在了再按 pid 补一刀。
        `kill -${signal} -"$p" 2>/dev/null || kill -${signal} "$p" 2>/dev/null || true`,
        ...(signal === 'TERM'
          ? [
              `for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done`,
              `kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
            ]
          : []),
        `for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done`,
      ],
      `${signal === 'KILL' ? '硬杀' : '停'}一次性节点 ${node.name}`,
    )
    if (killed.code !== 0) {
      // 抛出去。这个方法有两种调用者，两种都需要它说话：`stopNode` /
      // `killNode` 那条是场景自己要的动作，没做成就是一条如实的红；
      // `ctx.cleanup` 那条由 runner 逐条 try/catch，记成一行「cleanup 失败」
      // 而不打断同场景其它清理。
      throw new Error(
        `在 ${node.ssh} 上${signal === 'KILL' ? '硬杀' : '停'}一次性节点 ` +
          `${node.name} 没跑成 (${killed.code}): ${killed.stderr.trim().slice(0, 300)}`,
      )
    }
  }

  /**
   * 停掉再按（可覆盖的）同一份参数起回来。**配置根与端口都原样复用** ——
   * 前者是身份密钥与审计链的锚，后者让那条隧道继续有效。
   *
   * 附着来的内测节点上抛：重启它会打断内测使用者，并在它的审计链上留下一次
   * 计划外中断。
   */
  async restartNode(
    ctx: ScenarioContext,
    node: NodeHandle,
    overrides?: Partial<NodeSpec>,
  ): Promise<NodeHandle> {
    const disposable = requireDisposable(node, '重启')
    await this.#killGroup(node as FleetNodeHandle, disposable, 'TERM')
    // 端口要真的放开再绑回去。
    await sleep(500)
    return await this.#launchDisposable(
      ctx,
      { ...node.spec, ...overrides },
      disposable,
      node.endpoint,
    )
  }

  async dial(
    _ctx: ScenarioContext,
    node: NodeHandle,
    opts: DialOptions,
  ): Promise<DialProbe> {
    const fleetNode = node as FleetNodeHandle
    // 缺省 PSK 按句柄的种类取：一次性节点用它自己那把（场景挑的），附着来的
    // 才回落到配置里的生产 PSK。混用会让「错 PSK 被拒」这条在一次性节点上
    // 变成「对 PSK 被接受」——一次方向相反的假红。
    const fallback =
      fleetNode.disposable === undefined
        ? (this.#config.psk[fleetNode.name] ?? '')
        : node.spec.auth.mode === 'psk'
          ? node.spec.auth.psk
          : ACCEPTANCE_PSK
    if (opts.auth.mode !== 'psk' && opts.auth.mode !== 'none') {
      throw new Error(
        'FleetDriver.dial 只处理 psk / none；签名类拨号请直接用 rawDial',
      )
    }
    return await rawDial({
      url: node.endpoint,
      node: opts.nodeName ?? 'acceptance-probe',
      auth:
        opts.auth.mode === 'none'
          ? { kind: 'none' }
          : {
              kind: 'psk',
              psk: opts.auth.psk === '' ? fallback : opts.auth.psk,
            },
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
    const fleetNode = node as FleetNodeHandle
    // 纯读一次文件。**`undefined` 在这里的含义是「那台机器上没有这个文件」**
    // —— 一次 rc=255 也让 stdout 为空，于是链路失败会变成一句「文件不存在」
    // 喂进场景的 `expect`。`#read` 打满不通就抛，不再冒充一次观察。
    // `cat --` 而不是 `cat`：路径里的前导 `-` 否则会被当成参数。
    const result = await this.#read(
      fleetNode.ssh,
      [
        `cat -- '${shellQuote(`${node.configRoot}/${relPath}`)}' 2>/dev/null || true`,
      ],
      `读节点 ${node.name} 配置根下的 ${relPath}`,
    )
    return result.stdout === '' ? undefined : result.stdout
  }

  /**
   * 往配置根下写一个文件。**只对一次性节点开放** —— 见
   * {@link AcceptanceDriver.writeNodeFile} 与 {@link FleetNodeHandle.disposable}。
   */
  async writeNodeFile(
    node: NodeHandle,
    relPath: string,
    content: string,
  ): Promise<string> {
    requireDisposable(node, '写配置根')
    const fleetNode = node as FleetNodeHandle
    const abs = `${node.configRoot}/${relPath}`
    // **不重试**：写文件是改目标状态。返回码这里本来就判着，缺的只是
    // 「链路失败」与「远端写不进去」分开说 —— 两者的下一步动作完全不同。
    // 内容经 stdin 进去，不进命令行：审计链一行里带引号与换行，拼进 argv 迟早出事。
    const written = await this.#once(
      fleetNode.ssh,
      [
        `mkdir -p -- "$(dirname -- '${shellQuote(abs)}')"`,
        `cat > '${shellQuote(abs)}'`,
      ],
      `往节点 ${node.name} 的配置根写 ${relPath}`,
      { stdin: content },
    )
    if (written.code !== 0) {
      throw new Error(
        `在 ${fleetNode.ssh} 上写 ${relPath} 失败 (${written.code}): ${written.stderr.slice(0, 300)}`,
      )
    }
    return abs
  }

  async setNodePathMode(
    node: NodeHandle,
    relPath: string,
    mode: string,
  ): Promise<void> {
    requireDisposable(node, '改权限位')
    const fleetNode = node as FleetNodeHandle
    // `chmod <固定位>` 重发结果相同（与 `#scratch` 里那条 `chmod 700` 同类），
    // 所以接重试。返回码此前是整个丢掉的 —— 权限位没改成时，靠它立现场的场景
    // 会在后面某个断言上以「产品没拦住」的形态红（issue #98 ③）。
    const changed = await this.#read(
      fleetNode.ssh,
      [`chmod ${mode} -- '${shellQuote(`${node.configRoot}/${relPath}`)}'`],
      `把节点 ${node.name} 的 ${relPath} 权限位改成 ${mode}`,
    )
    if (changed.code !== 0) {
      throw new Error(
        `在 ${fleetNode.ssh} 上把 ${relPath} 改成 ${mode} 失败 ` +
          `(${changed.code}): ${changed.stderr.trim().slice(0, 300)}`,
      )
    }
  }

  async listNodeDir(
    node: NodeHandle,
    relPath: string,
  ): Promise<string[] | undefined> {
    const fleetNode = node as FleetNodeHandle
    // 与 `readNodeFile` 同一条：`undefined` 的含义是「那个目录不在（或空）」，
    // 一次链路失败绝不许伪装成它。
    const result = await this.#read(
      fleetNode.ssh,
      [
        `ls -1 -- '${shellQuote(`${node.configRoot}/${relPath}`)}' 2>/dev/null || true`,
      ],
      `列节点 ${node.name} 配置根下的 ${relPath}`,
    )
    if (result.stdout.trim() === '') return undefined
    return result.stdout.split('\n').filter(line => line !== '')
  }

  async execNode(
    node: NodeHandle,
    argv: readonly string[],
  ): Promise<ExecResult> {
    const fleetNode = node as FleetNodeHandle
    const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
    // **不重试**：跑的是任意一条 `qm` 子命令，签发、注册、写审计链都在里面，
    // 重发一次可能造出第二条记录。只判「有没有走到远端」—— 少了这一判，
    // `{code: 255, stdout: ''}` 会原样交给场景，读起来正是「这条命令失败了」。
    return await this.#once(
      fleetNode.ssh,
      [
        `PATH="$HOME/.bun/bin:$PATH" OCC_IDENTITY=qianmo OCC_CONFIG_DIR='${shellQuote(node.configRoot)}' ` +
          `bun '${shellQuote(fleetNode.occPath)}' ${quoted}`,
      ],
      `在节点 ${node.name} 上跑 qm ${argv[0] ?? ''}`,
    )
  }

  /**
   * 真机上的一次性执行位置：`$HOME/.cache/qianmo-acceptance/<随机>` 下的
   * `config/` 与 `work/`，跑完 `rm -rf` 掉。
   *
   * **为什么不复用生产配置根** —— 见 {@link ExecHost} 的对比表。一句话：那些
   * 命令会往配置根里生成身份密钥并可能落 settings，而生产根下的身份与审计链
   * 是内测节点在用的东西，也是成果边界的证据。
   *
   * 清理挂 `ctx.cleanup`，runner 在 `finally` 里逆序跑，超时路径也会跑到。
   * `rm -rf` 的路径由 `mktemp -d` 自己回显、且被钉在那个前缀下 —— 拼一个
   * 可能为空的变量再 `rm -rf` 是这类脚本最经典的事故形态。
   */
  async execHost(
    ctx: ScenarioContext,
    where?: ExecHostWhere,
  ): Promise<ExecHost> {
    // 点了名就落在那个节点所在的机器上 —— 那类场景（`qm resident-wake`）要拨的
    // 正是这个节点的回环口，落在别处得穿隧道，而隧道只在 runner 那一侧存在。
    //
    // 不点名就在四台内测节点之间轮着来，而不是永远第一台：四台里 p12 是
    // x86_64、另外三台是 aarch64 —— 全压在 hosts[0] 上，「验收跑过真机」就只
    // 覆盖了一种架构。这里用 `hosts` 而不是 `spawnMachines`，因为这条路径跑的
    // 是**会结束的**子命令，p12 那点内存扛得住，没有理由把它排除在外。
    // 落在哪台机器写进每条结果的证据里（`执行位置`），所以红了照样可归因。
    const named = where?.sameMachineAs as FleetNodeHandle | undefined
    let ssh: string
    let occPath: string
    let describe: string
    if (named !== undefined) {
      ssh = named.ssh
      occPath = named.occPath
      describe = `${named.ssh} (与节点 ${named.name} 同机)`
    } else if (where?.forNodeSpawn === true) {
      // 夹具位：落在本场景的**落机**上，与后面 `#spawn` 起的一次性节点同机。
      // 走 `hosts` 轮转的话，`--trust-ca` 指向的会是另一台机器上的路径。
      const machine = await this.#machineFor(ctx)
      const home = await this.#homeOf(machine.ssh)
      ssh = machine.ssh
      occPath = `${home}/${machine.repoRel}/dist/cli-node.js`
      describe = `${machine.label} (节点夹具)`
    } else {
      const host =
        this.#config.hosts[this.#execHostCursor++ % this.#config.hosts.length]
      if (host === undefined) throw new Error('舰队配置里一台机器都没有')
      ssh = host.ssh
      occPath = host.occPath
      describe = `${host.ssh} (${host.node})`
    }

    const root = await this.#scratch(ctx, ssh)
    return this.#execHostOn(ssh, occPath, `${root}/config`, `${root}/work`, {
      describe,
    })
  }

  /** 把「在某台机器的某个配置根下跑 `qm`」包成一个 {@link ExecHost}。 */
  #execHostOn(
    ssh: string,
    occPath: string,
    configDir: string,
    workdir: string,
    meta: { readonly describe: string },
  ): ExecHost {
    return {
      describe: meta.describe,
      configDir,
      workdir,
      exec: async (argv, opts) => {
        const env = Object.entries(opts?.env ?? {})
          .map(([k, v]) => `${k}='${shellQuote(v)}' `)
          .join('')
        const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
        // 一条命令换一个配置根：一条签发链要同时用到工具根、对端身份根与
        // 将来那个节点自己的根，而它们本来就该在同一台机器的同一棵树里。
        const dir = opts?.configDir ?? configDir
        // **不重试**：`qm ca` / `qm cert` / `qm task sign` 都从这里走，重发一次
        // 会在那棵树上多造一份材料。只判「有没有走到远端」。
        return await this.#once(
          ssh,
          [
            `PATH="$HOME/.bun/bin:$PATH" OCC_IDENTITY=qianmo OCC_CONFIG_DIR='${shellQuote(dir)}' ` +
              `${env}bun '${shellQuote(occPath)}' ${quoted}`,
          ],
          `在 ${ssh} 上跑 qm ${argv[0] ?? ''}`,
          { timeoutMs: opts?.timeoutMs },
        )
      },
      run: async (argv, opts) => {
        const env = Object.entries(opts?.env ?? {})
          .map(([k, v]) => `${k}='${shellQuote(v)}' `)
          .join('')
        const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
        // **不重试**：argv 由场景给（`openssl` 签发那条链就在这儿跑），
        // 幂等性不由这一层判断得了。
        return await this.#once(
          ssh,
          [`PATH="$HOME/.bun/bin:$PATH" ${env}${quoted}`],
          `在 ${ssh} 上跑 ${argv[0] ?? ''}`,
          { timeoutMs: opts?.timeoutMs },
        )
      },
      writeFile: async (relPath, content) => {
        const abs = `${workdir}/${relPath}`
        // **不重试**（写文件）。内容经 stdin 进去，不进命令行：链文件带引号与
        // 换行，拼进 argv 迟早出事。
        const written = await this.#once(
          ssh,
          [
            `mkdir -p -- "$(dirname -- '${shellQuote(abs)}')"`,
            `cat > '${shellQuote(abs)}'`,
          ],
          `在 ${ssh} 上写 ${relPath}`,
          { stdin: content },
        )
        if (written.code !== 0) {
          throw new Error(
            `在 ${ssh} 上写 ${relPath} 失败 (${written.code}): ${written.stderr.slice(0, 300)}`,
          )
        }
        return abs
      },
      mkdir: async relPath => {
        const abs = `${workdir}/${relPath}`
        // `mkdir -p` 幂等，接重试。返回码此前整个丢掉 —— 目录没建成时，
        // 后面往里写的那一步才炸，而那条错误看起来像别的毛病。
        const made = await this.#read(
          ssh,
          [`mkdir -p -- '${shellQuote(abs)}'`],
          `在 ${ssh} 上建目录 ${relPath}`,
        )
        if (made.code !== 0) {
          throw new Error(
            `在 ${ssh} 上建目录 ${relPath} 失败 (${made.code}): ${made.stderr.trim().slice(0, 300)}`,
          )
        }
        return abs
      },
      readFile: async pathOrRelPath => {
        const abs = pathOrRelPath.startsWith('/')
          ? pathOrRelPath
          : `${workdir}/${pathOrRelPath}`
        // 纯读；`undefined` 的含义是「文件不在或是空的」，链路失败不许伪装成它。
        // `cat --` 而不是 `cat`：路径里的前导 `-` 否则会被当成参数。
        const probe = await this.#read(
          ssh,
          [`cat -- '${shellQuote(abs)}' 2>/dev/null || true`],
          `在 ${ssh} 上读 ${pathOrRelPath}`,
        )
        return probe.stdout === '' ? undefined : probe.stdout
      },
      freePort: async () => await this.#freePortOn(ssh),
    }
  }

  /**
   * 一次性注册中心 —— **跑在 runner 进程里**，靠一条**反向**隧道让远端的控制台
   * 够得着。
   *
   * ## 为什么不在目标机上起一个
   *
   * 产品里**没有** `qm registry` 这条子命令；注册中心只经
   * `demo/lib/p81-registry.ts` 暴露，而那个脚本对本维度差两件事：`--register`
   * 至少要一条（于是名册里永远多一条会被周期性续租的登记，`租约到期即消失`
   * 那条当场证伪），以及没有 `--ttl`（那条场景要 3 s 的 TTL，默认 90 s 两轮
   * 等下来超过它自己的超时）。改那个脚本没用 —— 部署机上是**旧的那一份**。
   *
   * ## 那么真机腿的 `console/*` 到底测的是什么（不要含糊过去）
   *
   * 测的是**部署机上那个 `dist/cli-node.js console`**：它的命令行、banner、
   * token 三个入口、鉴权矩阵、`/v0/limits` 报的常量、唤醒白名单与签名唤醒的
   * 整条链路，全部在真机的内核与架构上跑。注册中心那一半仍是套件进程里的
   * `@qianmo/registry`（与本地腿同一份代码，同一个提交），只是隔着一条隧道。
   * 于是 `console/registry-lease-*` 两条在真机腿上**多验的是控制台那半边的
   * 代理**，租约语义那半边与本地腿等价 —— 这一点写在这里，免得报告把它读成
   * 「注册中心也在真机上验过了」。
   */
  async startRegistry(
    ctx: ScenarioContext,
    spec: RegistrySpec = {},
  ): Promise<AcceptanceRegistry> {
    const local = await startRegistry(ctx, spec)
    const machine = await this.#machineFor(ctx)
    const localPort = Number.parseInt(new URL(local.url).port, 10)
    const remotePort = await this.#freePortOn(machine.ssh)
    await this.#reverseTunnel(ctx, machine.ssh, remotePort, localPort)
    return {
      url: local.url,
      hostUrl: `http://127.0.0.1:${String(remotePort)}`,
      readState: local.readState,
      // 本地那份在同一个端口上重起，反向隧道指的就是那个端口，所以隧道不用动。
      restart: local.restart,
    }
  }

  /**
   * 一次性控制台位：一次性根 + 一个 `start`，都落在本场景那台机器上。
   *
   * 与节点同机是**承重的**：控制台要按 `--wake-url` 拨到那个节点，而节点听
   * 在它自己的回环上。见 {@link FleetDriver.#machineFor}。
   */
  async consoleSlot(ctx: ScenarioContext): Promise<ConsoleSlot> {
    const machine = await this.#machineFor(ctx)
    const home = await this.#homeOf(machine.ssh)
    const occPath = `${home}/${machine.repoRel}/dist/cli-node.js`
    const root = await this.#scratch(ctx, machine.ssh)
    const configDir = `${root}/config`
    const workdir = `${root}/work`
    const base = this.#execHostOn(machine.ssh, occPath, configDir, workdir, {
      describe: `${machine.label} (一次性控制台)`,
    })
    return {
      ...base,
      start: async spec =>
        await this.#startConsole(ctx, machine, occPath, root, spec),
    }
  }

  async #startConsole(
    ctx: ScenarioContext,
    machine: SpawnMachine,
    occPath: string,
    root: string,
    spec: ConsoleSpec,
  ): Promise<AcceptanceConsole> {
    const configDir = `${root}/config`
    const remotePort = await this.#freePortOn(machine.ssh)
    const { argv, env: extraEnv } = consoleLaunch(spec, remotePort)
    const env: Record<string, string> = {
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: configDir,
      ...extraEnv,
    }
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}='${shellQuote(v)}' `)
      .join('')
    const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
    const outLog = `${root}/console.out.log`
    const errLog = `${root}/console.err.log`
    const pidFile = `${root}/console.pid`

    // 清理**先登记再启动**。反过来的话，启动那一趟 ssh 自己抛出时（网络抖动、
    // 远端 OOM）就会留下一个没人管的控制台进程：它的 argv 里不一定带着一次性
    // 根（`--audit` 那类参数才带），所以 `#scratch` 的兜底清扫也够不着它。
    // 提前登记没有代价 —— pid 文件不存在时 `#killByPidFile` 直接返回。
    ctx.cleanup(async () => {
      await this.#killByPidFile(machine.ssh, pidFile)
    })

    // **不重试**：这一趟起进程（理由同一次性节点那里）。返回码此前连接都没
    // 接 —— 一次 rc=255 之后下面那句会说「控制台没有起来」，而真相是这条
    // 命令一行都没跑到。
    await this.#once(
      machine.ssh,
      [
        `set -e`,
        `: > '${shellQuote(outLog)}'`,
        `: > '${shellQuote(errLog)}'`,
        `PATH="$HOME/.bun/bin:$PATH" ${envPrefix}setsid bun '${shellQuote(occPath)}' ${quoted} ` +
          `>'${shellQuote(outLog)}' 2>'${shellQuote(errLog)}' </dev/null &`,
        `p=$!`,
        `printf '%s\\n' "$p" > '${shellQuote(pidFile)}'`,
        // banner 里带着两枚 token，所以判据是 `admin-token` 那一行落地 ——
        // 与本地腿同一条。轮询放在远端、拍数按倍率算，理由同一次性节点那里。
        `for _ in $(seq 1 ${String(remotePollTicks(ctx.timeoutScale))}); do`,
        `  if grep -q 'admin-token' '${shellQuote(outLog)}'; then break; fi`,
        `  if ! kill -0 "$p" 2>/dev/null; then break; fi`,
        `  sleep ${REMOTE_POLL_SLEEP_SEC}`,
        `done`,
      ],
      `在 ${machine.label} 上起一次性控制台`,
      { timeoutMs: REMOTE_LAUNCH_SSH_BUDGET_MS * ctx.timeoutScale },
    )

    // 两条都是纯读、都接重试。`readOut` 更是承重的：banner 里带着两枚 token，
    // 静默读空会让整条控制台维度以「没起来」的形态红。
    const outLines = [`cat '${shellQuote(outLog)}' 2>/dev/null || true`]
    const errLines = [`cat '${shellQuote(errLog)}' 2>/dev/null || true`]
    const readOut = async (): Promise<string> =>
      (await this.#read(machine.ssh, outLines, '读一次性控制台的 banner'))
        .stdout
    const readErr = async (): Promise<string> =>
      (await this.#read(machine.ssh, errLines, '读一次性控制台的 stderr'))
        .stdout
    // 只进错误文本的那一份：读不到时说「取不到」，不掀掉外面已成立的结论。
    const diagErr = async (): Promise<string> =>
      await this.#diag(machine.ssh, errLines, '一次性控制台的 stderr')

    const banner = await readOut()
    if (!banner.includes('admin-token')) {
      throw new Error(
        `一次性控制台在 ${machine.label} 上没有起来\n` +
          `stdout:\n${banner}\nstderr:\n${(await diagErr()).slice(0, 1_500)}`,
      )
    }

    const tunnel = await this.#tunnel(ctx, machine.ssh, remotePort)
    const localPort = tunnel.localPort
    const url = `http://127.0.0.1:${String(localPort)}`
    // 就绪判据是 `GET /v0/health` 答 200 —— 公开、零鉴权，`systemctl --user
    // is-active` 对这两个单元都不可信（`Type=oneshot` + 只 enable 不 start，
    // 实测进程活着而单元报 inactive）。这里同时也在等隧道预热。
    const deadline = Date.now() + DISPOSABLE_READY_BUDGET_MS * ctx.timeoutScale
    for (;;) {
      if ((await http(`${url}/v0/health`, { timeoutMs: 5_000 })).status === 200)
        break
      // 与一次性节点那条同一个理由：隧道没了，`fetch` 只会报 connection
      // refused，读起来却像「控制台不答 200」。判据同样是「还有没有指望」，
      // 不是「此刻活着没有」。
      if (tunnel.exhausted()) {
        throw new TransportFailure({
          ssh: machine.ssh,
          what: '等一次性控制台答 /v0/health',
          code: tunnel.exitCode() ?? -1,
          stderr: tunnel.diagnose(),
          attempts: 1,
        })
      }
      if (ctx.signal.aborted || Date.now() >= deadline) {
        throw new Error(
          `一次性控制台在 ${machine.label} 上起来了但 /v0/health 不答 200 ` +
            `(${url} → ${machine.ssh}:${String(remotePort)})\n` +
            `stderr:\n${(await diagErr()).slice(0, 1_500)}`,
        )
      }
      await sleep(400)
    }

    const { viewToken, adminToken } = tokensFromBanner(banner, spec)
    return {
      url,
      viewToken,
      adminToken,
      configRoot: configDir,
      banner: readOut,
      stderr: readErr,
      // 与清理同一条路径。同一个控制台位第二次 `start` 会覆写这个 pid 文件，
      // 所以要换一个控制台的场景必须先停掉这一个，否则它就没人管了。
      stop: async () => {
        await this.#killByPidFile(machine.ssh, pidFile)
      },
    }
  }

  async #killByPidFile(ssh: string, pidFile: string): Promise<void> {
    // **不重试**（`kill` 不幂等），但返回码要判：这是控制台那条清理路径，
    // 丢掉它等于让一个一次性控制台静默活在机器上、报告里一个字都没有。
    // 抛出去由 runner 记成一行「cleanup 失败」（issue #98 ②）。
    const killed = await this.#once(
      ssh,
      [
        `p="$(cat '${shellQuote(pidFile)}' 2>/dev/null || echo)"`,
        `[ -n "$p" ] || exit 0`,
        `kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true`,
        `for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done`,
        `kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
      ],
      '停一次性控制台',
    )
    if (killed.code !== 0) {
      throw new Error(
        `在 ${ssh} 上停一次性控制台（${pidFile}）没跑成 (${killed.code}): ` +
          killed.stderr.trim().slice(0, 300),
      )
    }
  }

  /**
   * 真机的启动器位：跑**那台机器上部署好的**那一份脚本。
   *
   * 「用哪份脚本」这个选择与它的代价写在 {@link LauncherHost} 的头注上 ——
   * 那不是实现细节，是这一维在真机腿上到底回答了什么问题。
   *
   * `betaRoot` 与 `workdir` 都在一次性根下，所以脚本写出来的 `run/*.pid`、
   * `logs/*`、`peers.conf` 一律落在那儿，**碰不到 `~/qianmo-beta`**。
   */
  async launcherHost(ctx: ScenarioContext): Promise<LauncherHost> {
    const machine = await this.#machineFor(ctx)
    const home = await this.#homeOf(machine.ssh)
    const root = await this.#scratch(ctx, machine.ssh)
    const betaRoot = `${root}/beta-root`
    const workdir = `${root}/work`
    // `mkdir -p` 幂等，接重试。返回码此前整个丢掉 —— 这两个目录是
    // `beta-up.sh` 写 pid 与日志的地方，没建成时红在脚本里，归因要绕一大圈。
    const made = await this.#read(
      machine.ssh,
      [`mkdir -p '${shellQuote(betaRoot)}/run' '${shellQuote(betaRoot)}/logs'`],
      `在 ${machine.label} 上开启动器位的 run/ 与 logs/`,
    )
    if (made.code !== 0) {
      throw new Error(
        `在 ${machine.ssh} 上开启动器位失败 (${made.code}): ${made.stderr.trim().slice(0, 300)}`,
      )
    }
    const ssh = machine.ssh
    return {
      describe: machine.label,
      repoDir: `${home}/${machine.repoRel}`,
      betaRoot,
      workdir,
      writeFile: async (relPath, content, options) => {
        const abs = `${workdir}/${relPath}`
        // **不重试**（写文件）。
        const written = await this.#once(
          ssh,
          [
            `mkdir -p -- "$(dirname -- '${shellQuote(abs)}')"`,
            `cat > '${shellQuote(abs)}'`,
            ...(options?.mode === undefined
              ? []
              : [`chmod ${options.mode} -- '${shellQuote(abs)}'`]),
          ],
          `在 ${ssh} 上写启动器位的 ${relPath}`,
          { stdin: content },
        )
        if (written.code !== 0) {
          throw new Error(
            `在 ${ssh} 上写 ${relPath} 失败 (${written.code}): ${written.stderr.slice(0, 300)}`,
          )
        }
        return abs
      },
      run: async (argv, options) => {
        const env = Object.entries(options?.env ?? {})
          .map(([k, v]) => `${k}='${shellQuote(v)}' `)
          .join('')
        const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
        // **不重试**：跑的是部署机上那份 `beta-up.sh`，它起进程、写 pid、
        // 改部署树。重发一次就是起第二遍。只判「有没有走到远端」—— 少了这
        // 一判，`{code: 255}` 会被场景读成「启动器脚本失败了」。
        return await this.#once(
          ssh,
          [`${env}${quoted}`],
          `在 ${ssh} 上跑启动器 ${argv[0] ?? ''}`,
          { timeoutMs: options?.timeoutMs },
        )
      },
      // ── issue #98 ①：这两条是全表里最危险的一对 ─────────────────────
      //
      // 它们的返回值**直接就是场景 `expect` 的输入**。`#ssh` 不抛，于是一次
      // rc=255 让 stdout 为空 —— `exists()` 答「文件不存在」、`readFile()` 答
      // 「文件是空的」。断言「这个文件该在」时是假红，断言「该不在」时是
      // **假绿**，而两种都看不出与链路有关。这比 #96 ③ 那个形状更坏：那边
      // 一次链路失败至少还红着、看得见。
      //
      // **口径：抛，不返回三态。**「问不到」本来就不该被当成一次观察，这正是
      // #96 立的规矩。三态（yes/no/unknown）看着更保守，实际是把同一个判断推给
      // 七八个调用方各写一遍 —— 而只要有一个把 `unknown` 当成 `no`，这条缺陷
      // 就原样回来了，且下次更难找。抛出去只有一种下场：一条标着
      // `errorKind='transport'` 的 error，照样把整轮判红。
      exists: async absPath => {
        const probe = await this.#read(
          ssh,
          [`test -e '${shellQuote(absPath)}' && echo yes || echo no`],
          `问 ${ssh} 上 ${absPath} 在不在`,
        )
        const answer = probe.stdout.trim()
        // `test -e … && echo yes || echo no` 永远退出 0 并且必答一个词。
        // 答不上来 = 这一趟没问成，同样不许折成 `false`。
        if (probe.code !== 0 || (answer !== 'yes' && answer !== 'no')) {
          throw new Error(
            `在 ${ssh} 上问不出 ${absPath} 在不在 (${probe.code}): ` +
              `stdout=${JSON.stringify(answer.slice(0, 120))} ` +
              `stderr=${probe.stderr.trim().slice(0, 200)}`,
          )
        }
        return answer === 'yes'
      },
      readFile: async absPath => {
        const probe = await this.#read(
          ssh,
          [`cat -- '${shellQuote(absPath)}' 2>/dev/null || true`],
          `读 ${ssh} 上的 ${absPath}`,
        )
        // 到这里 `undefined` 只剩一个含义：那台机器上这个文件不在或是空的。
        return probe.stdout === '' ? undefined : probe.stdout
      },
    }
  }

  /**
   * 本场景的**落机**：第一次要机器的时候按轮转挑一台，之后同一场景一律用它。
   *
   * 钉在场景上而不是每次现挑，是因为一次性进程之间要互相够得着：控制台按
   * `--wake-url` 拨节点、拨的是节点自己那台机器的回环口。分散到两台机器上，
   * 唤醒维度那几条会以「拨不通」的形态红 —— 而那条红读起来像产品坏了。
   *
   * 轮转仍在（键是场景），所以整轮下来四台机器都覆盖得到。
   */
  async #machineFor(ctx: ScenarioContext): Promise<SpawnMachine> {
    const pinned = this.#machines.get(ctx)
    if (pinned !== undefined) return pinned
    const machines = this.#config.spawnMachines
    const machine = machines[this.#spawnCursor++ % machines.length]
    if (machine === undefined) {
      throw new Error('没有可承载一次性进程的舰队机器')
    }
    this.#machines.set(ctx, machine)
    return machine
  }

  /**
   * 从目标机回到 runner 的一条端口转发（`ssh -R`）。
   *
   * 注册中心跑在 runner 上，而控制台在目标机上 —— 没有它那条 `--registry`
   * 指的就是目标机自己的一个空端口。
   */
  async #reverseTunnel(
    ctx: ScenarioContext,
    ssh: string,
    remotePort: number,
    localPort: number,
  ): Promise<void> {
    const tunnel = this.#longTunnel(
      ctx,
      ssh,
      ['-R', `${String(remotePort)}:127.0.0.1:${String(localPort)}`],
      localPort,
      `到 ${ssh} 的反向隧道（${String(remotePort)} → 本地 ${String(localPort)}）`,
    )
    // 反向隧道要等它真的通：控制台一起来就会去打注册中心，早一步起等于让
    // 它在第一次请求上拿到 ECONNREFUSED。这里用一次远端 curl 确认。
    const deadline =
      Date.now() + REVERSE_TUNNEL_READY_BUDGET_MS * ctx.timeoutScale
    for (;;) {
      // 纯读一次 curl 探测。这里**故意不套 `#sshRetry`** —— 这个 for 循环
      // 自己就是重试（每 500 ms 一轮，直到预算耗尽），再套一层等于把每轮变
      // 成三次往返、把「隧道没通」这个结论推迟到三倍时间之后。要补的只是
      // 最后那一下的分类：打到预算还是 255，说的就是链路，不是隧道没通。
      const probe = await this.#ssh(ssh, [
        `curl -s -o /dev/null -w '%{http_code}' -m 3 ` +
          `http://127.0.0.1:${String(remotePort)}/v0/agents 2>/dev/null || echo 000`,
      ])
      if (/[1-5]\d\d/.test(probe.stdout.trim())) return
      // 与正向那条同一条纪律（#105）：`ssh -R` 起不来了（远端口被占撞上
      // `ExitOnForwardFailure`、网断），远端那次 curl 只会回 `000` —— 读起来
      // 像「隧道还没通，再等等」，于是这里会一直等到预算耗尽。问它一句，
      // 就能当场说出坏的是哪一侧，还省下整个预算。**重建没打完之前不算数**，
      // 所以问的是 `exhausted()`。
      if (tunnel.exhausted()) {
        throw new TransportFailure({
          ssh,
          what: `等到 ${ssh} 的反向隧道 ${String(remotePort)}→${String(localPort)} 通`,
          code: tunnel.exitCode() ?? -1,
          stderr: tunnel.diagnose(),
          attempts: 1,
        })
      }
      if (ctx.signal.aborted || Date.now() >= deadline) {
        if (isTransportFailure(probe)) {
          throw new TransportFailure({
            ssh,
            what: `等到 ${ssh} 的反向隧道 ${String(remotePort)}→${String(localPort)} 通`,
            code: probe.code,
            stderr: probe.stderr,
            attempts: 1,
          })
        }
        throw new Error(
          `到 ${ssh} 的反向隧道 ${String(remotePort)}→${String(localPort)} 没通：${probe.stdout.trim()}`,
        )
      }
      await sleep(500)
    }
  }

  /**
   * 在目标机上开一层一次性目录（`config/` 与 `work/`），跑完 `rm -rf`。
   *
   * `rm -rf` 的路径由 `mktemp -d` 自己回显、且删之前**再确认一次**它带着
   * {@link SCRATCH_PREFIX} —— 拼一个可能为空的变量再 `rm -rf` 是这类脚本最
   * 经典的事故形态。清理挂 `ctx.cleanup`，超时路径也会跑到。
   *
   * ## 清理失败必须留下痕迹（issue #96 ①）
   *
   * 这两条远端命令的返回码此前是整个丢掉的，而 {@link FleetDriver.#ssh} **不抛**
   * —— 于是远端删不掉既不抛异常也不进 `logs`，报告里查不到任何线索。实测后果是
   * 往演示机上静默丢了 107 MB（`run.IrUlmaLK`），而那一轮 `results.ndjson` 里
   * 「cleanup 失败」出现 **0 次**。现在两条都判返回码，外加一次存在性复查。
   *
   * ## 目录名在 runner 这边生成（issue #96 ③）
   *
   * 原先是 `mktemp -d …/run.XXXXXXXX`，名字由远端现取。那样**这一步不可重发**：
   * 一次半路断掉的 ssh 可能已经建好了目录，而我们永远学不到它叫什么 —— 于是每
   * 次重试都可能在机器上多留一个再也没人认领的根。改成 runner 侧生成随机名 +
   * `mkdir -p`（幂等）之后，重发落在**同一条路径**上，重试不制造孤儿。
   *
   * 安全前提一个字没松：路径仍然由远端 `printf` 回显、回来之后仍然再确认一次
   * 它带着 {@link SCRATCH_PREFIX} —— 那一条防的是「拼一个可能为空的变量再
   * `rm -rf`」，与名字谁生成无关。
   */
  async #scratch(ctx: ScenarioContext, ssh: string): Promise<string> {
    // 48 bit 随机（6 字节 → 12 个 hex）；碰撞概率在一轮几百条场景的量级上可以
    // 忽略，而 `run.` 前缀是下面 pgrep 那个把戏的前提（名字里只有这一个 `.`）。
    const name = `run.${randomBytes(6).toString('hex')}`
    let attempts = 1
    const made = await this.#sshRetry(
      ssh,
      [
        `set -e`,
        `d="$HOME/${SCRATCH_PREFIX}/${name}"`,
        `mkdir -p "$d/config" "$d/work"`,
        `chmod 700 "$HOME/${SCRATCH_PREFIX}" "$d"`,
        `printf '%s\n' "$d"`,
      ],
      {
        onRetry: n => {
          attempts = n + 1
        },
      },
    )
    const root = made.stdout.trim()
    if (isTransportFailure(made)) {
      // 打满还是不通。**这一条不是被测系统的回答** —— 远端命令一行都没跑到，
      // `beta-up.sh` 更没有。它仍然把整轮判红（见 `TransportFailure` 的头注），
      // 只是报告上不再和一条产品缺陷长得一样。
      throw new TransportFailure({
        ssh,
        what: '在目标机上开一次性目录',
        code: made.code,
        stderr: made.stderr,
        attempts,
      })
    }
    if (made.code !== 0 || !root.includes(SCRATCH_PREFIX)) {
      throw new Error(
        `在 ${ssh} 上开一次性目录失败 (${made.code}): ${made.stderr.slice(0, 400)}`,
      )
    }
    ctx.cleanup(async () => {
      if (!root.includes(SCRATCH_PREFIX)) return
      // 删之前先兜一次底：把任何 argv 里带着这个一次性根的进程连同它的进程组
      // 收掉。正常路径上 `#launchDisposable` 自己那条清理已经杀过了，这一层
      // 防的是「进程起来了但登记清理之前那一步抛了」——那种漏网进程会一直往
      // 一个刚被 `rm -rf` 的目录里写，把它自己的配置目录重新造出来。
      //
      // `run[.]xxx` 的方括号是那个老把戏：跑这条命令的 shell 自己的命令行里
      // 有 `run[.]xxx` 这串字面量，它**不匹配**这个正则，所以 pkill 不会打到
      // 自己的父进程头上（打到了的话后面的 rm 就不会执行）。
      const id = root.slice(root.lastIndexOf('/') + 1).replace('.', '[.]')
      // **清扫与删除必须是两条独立的远端命令。** 合成一条的话，那条命令行里
      // 同时有 `rm -rf -- '…/run.XXXX'` 这个**没加方括号**的字面量，于是
      // `pgrep -f 'run[.]XXXX'` 把跑着它的那个 shell 自己也匹配上，for 循环
      // 当场把自己的进程组杀掉 —— 结果是进程确实清干净了，而后面那句 rm
      // 一次都没执行过。现场是「每台机器上留着一个只含 config/ 的空目录」，
      // 而 `rm` 那一行看起来完全正确。这个坑踩过一次，别把它合回去。
      const problems: string[] = []
      // 清扫与删除都是幂等的（`kill` 打的是这个根自己的进程、`rm -rf` 重发结果
      // 相同），所以链路抖了值得再打一次 —— 少留一次残留就少一次 107 MB。
      const swept = await this.#sshRetry(ssh, [
        `for p in $(pgrep -f '${id}' 2>/dev/null); do`,
        `  kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true`,
        `done`,
        `sleep 0.5`,
        `for p in $(pgrep -f '${id}' 2>/dev/null); do`,
        `  kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
        `done`,
      ])
      if (swept.code !== 0) {
        problems.push(
          `进程清扫没跑成 (${swept.code}): ${swept.stderr.trim().slice(0, 200)}`,
        )
      }
      // `rm` 的退出码要**自己接住再回显**：后面那个 `[ -e ]` 是一条独立语句，
      // 远端命令的退出码只会是它的，直接看 ssh 的 rc 等于又把 rm 的结果丢了。
      // 存在性复查不是多余的一层 —— 「rm 报 0 但目录还在」在挂载点上真的会
      // 发生（只读挂载下的部分删除），而这一栏问的是「机器上还剩不剩东西」。
      const removed = await this.#sshRetry(ssh, [
        `rc=0`,
        `rm -rf -- '${shellQuote(root)}' || rc=$?`,
        `printf 'rm=%s\n' "$rc"`,
        `if [ -e '${shellQuote(root)}' ]; then`,
        `  printf 'left=%s\n' "$(du -sk -- '${shellQuote(root)}' 2>/dev/null | awk '{print $1}')"`,
        `else`,
        `  printf 'left=no\n'`,
        `fi`,
      ])
      const rc = strField(removed.stdout, 'rm')
      const left = strField(removed.stdout, 'left')
      if (removed.code !== 0 || rc === undefined) {
        problems.push(
          (isTransportFailure(removed)
            ? `SSH 链路失败 (${removed.code}${
                transportSignature(removed.stderr) === undefined
                  ? ''
                  : `，${transportSignature(removed.stderr)}`
              })，删除这一步没跑成`
            : `删除这一步没能确认 (ssh ${removed.code})`) +
            `: ${removed.stderr.trim().slice(0, 200)}`,
        )
      } else if (rc !== '0') {
        problems.push(
          `远端 rm -rf 失败 (${rc}): ${removed.stderr.trim().slice(0, 200)}`,
        )
      }
      if (left !== undefined && left !== 'no') {
        problems.push(`删完目录还在，约 ${left} KB 留在机器上`)
      }
      if (problems.length === 0) return
      // **先把细节写进 logs，再抛。**两件事各有各的去处：`ctx.log` 那几行带着
      // 主机、路径、退出码与 stderr 原文（NDJSON 的 `log` 证据里，`jq` 捞得到）；
      // 抛出的那一句让 runner 记下它自己那行 `cleanup 失败: …` —— 那正是这条
      // 缺陷的判据（那一轮 `results.ndjson` 里它出现 0 次，而机器上躺着 107 MB）。
      //
      // 抛在**两条远端命令都跑完之后**，所以本条清理自己不会漏做任何一步；
      // runner 逐条 `try/catch` 跑 cleanup 栈（见 `runner.ts` 的 `finally`），
      // 所以抛出也不会打断同场景其它清理。
      //
      // **它不改判定**，这是有意的：一次清理失败是套件自己的运维债，不是被测
      // 系统答错了。把它记成 `error` 就等于用套件侧的残留去否掉一条产品结论 ——
      // 与本 issue ③ 要根治的那个混淆是同一个病，方向相反而已。
      for (const p of problems) {
        ctx.log(`[cleanup] ${ssh}:${root} ${p}`)
      }
      throw new Error(
        `清理 ${ssh} 上的一次性目录 ${root} 没做干净：${problems.join('；')}`,
      )
    })
    return root
  }

  /** 目标机的家目录（p12 是 `/root`，其余是 `/home/cornna`）。一台问一次。 */
  async #homeOf(ssh: string): Promise<string> {
    const cached = this.#homes.get(ssh)
    if (cached !== undefined) return await cached
    const pending = (async () => {
      // 纯读一次环境变量，重发绝对安全。
      let attempts = 1
      const probe = await this.#sshRetry(ssh, [`printf '%s\n' "$HOME"`], {
        onRetry: n => {
          attempts = n + 1
        },
      })
      const home = probe.stdout.trim()
      if (isTransportFailure(probe)) {
        throw new TransportFailure({
          ssh,
          what: '问目标机的家目录',
          code: probe.code,
          stderr: probe.stderr,
          attempts,
        })
      }
      if (probe.code !== 0 || !home.startsWith('/')) {
        throw new Error(
          `问不出 ${ssh} 的家目录 (${probe.code}): ${probe.stderr.slice(0, 300)}`,
        )
      }
      return home
    })()
    this.#homes.set(ssh, pending)
    return await pending
  }

  /**
   * 从 runner 到目标机的一条端口转发，生命周期挂在场景上。
   *
   * **返回的是句柄不是端口。** 第一版只返回端口、把 ssh 子进程的句柄丢掉，
   * 于是隧道自己退出之后没有任何人发现：本地口没人听，就绪循环对着它拨满
   * 整个预算，最后写下「节点在 X 上起来了但拨不通」—— 一条关于被测系统的
   * 结论，而坏的是套件自己那条链路。这正是 issue #96 要挡的形态（#105）。
   */
  async #tunnel(
    ctx: ScenarioContext,
    ssh: string,
    remotePort: number,
  ): Promise<TunnelHandle> {
    const localPort = await ctx.allocPort()
    return this.#longTunnel(
      ctx,
      ssh,
      ['-L', `${String(localPort)}:127.0.0.1:${String(remotePort)}`],
      localPort,
      `到 ${ssh} 的转发隧道（本地 ${String(localPort)} → ${String(remotePort)}）`,
    )
  }

  /**
   * 两条长命隧道（`-L` 与 `-R`）共用的那一半。
   *
   * **合并不是为了少写几行**，是为了让它们不可能再分叉：#105 那个缺陷（丢掉
   * 子进程句柄）当初只长在 `-L` 那条上，而 `-R` 那条是逐字抄过去的同一段
   * 代码 —— 只修一条等于留着另一条在原地等下一次。
   *
   * 两条流都要抽干：经 IAP 的那台每次连接都往 stderr 写几行提示，管道写满
   * 之后 ssh 会阻塞在 `write` 上，表现是「隧道建着建着就不转发了」。stderr
   * 那条抽干时**留尾巴**，理由见 {@link drainKeepingTail}。
   */
  #longTunnel(
    ctx: ScenarioContext,
    ssh: string,
    forward: readonly string[],
    localPort: number,
    label: string,
  ): TunnelHandle {
    const spawnOne = (): {
      readonly proc: ReturnType<typeof Bun.spawn>
      readonly tail: () => string
    } => {
      const proc = Bun.spawn(
        [
          this.#config.sshBin ?? 'ssh',
          '-N',
          '-o',
          'BatchMode=yes',
          '-o',
          'ExitOnForwardFailure=yes',
          '-o',
          'ServerAliveInterval=15',
          // 长命隧道**不走复用**：共享 master 会让「杀掉隧道进程」与「转发真的
          // 撤掉」脱钩（issue #100 ②）。见 {@link TUNNEL_NO_MUX_ARGS}。
          ...TUNNEL_NO_MUX_ARGS,
          ...(this.#config.sshArgs ?? []),
          ...forward,
          ssh,
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      )
      void drain(proc.stdout)
      // stderr 留尾巴：这条隧道自己死掉时，临死前那句话是唯一说得清「为什么不
      // 通」的证据。只抽不留等于把它扔了。
      const stderr = drainKeepingTail(proc.stderr)
      return { proc, tail: () => stderr.text().trim() }
    }

    let current = spawnOne()
    let disposed = false
    let exhausted = false
    let attempts = 0
    let lastTail = ''
    let lastCode: number | null = null

    // 看门狗。**重建是幂等的**，所以它该重试 —— `ssh -L` / `ssh -R` 在远端不
    // 留任何痕迹，与 `#read` 同一条判据（见 {@link TUNNEL_REVIVE_ATTEMPTS}）。
    void (async () => {
      for (;;) {
        await current.proc.exited
        if (current.tail() !== '') lastTail = current.tail()
        lastCode = current.proc.exitCode
        if (disposed) return
        if (attempts >= TUNNEL_REVIVE_ATTEMPTS) {
          exhausted = true
          return
        }
        attempts += 1
        // **重建必须留痕。** 静默自愈会造出一种新的假象：隧道在场景跑到一半时
        // 断了又接上，而**那条已经开着的 WebSocket 是接不回来的** —— 场景于是
        // 收不到回执，报出来的却是一条关于被测系统的断言失败（「receipt 应为
        // rejected」）。那正是 issue #96 要挡的形态，只不过挪到了场景执行期，
        // 就绪循环那两处守卫够不着。留下这一行，报告里就看得见「这条腿抖过」。
        ctx.log(
          `[tunnel] ${label}断了，第 ${String(attempts)} 次重建` +
            `${lastTail === '' ? '' : `（上一次退出：${lastTail.slice(-200)}）`}`,
        )
        await sleep(TUNNEL_REVIVE_BACKOFF_MS * attempts)
        if (disposed) return
        current = spawnOne()
      }
    })()

    ctx.cleanup(() => {
      disposed = true
      current.proc.kill('SIGKILL')
    })

    return {
      localPort,
      // `exitCode` 在进程还活着时是 `null`。**这一句不是锦上添花**：隧道死了
      // 之后那个口就没人听，而拨号方看到的只是 `1006 Failed to connect` ——
      // 与「被测进程根本没起来」长得一模一样。不问它，一次套件侧的链路故障
      // 就会被写成一条关于被测系统的结论，那正是 issue #96 立规矩要挡的形态。
      exhausted: () => exhausted,
      exitCode: () => current.proc.exitCode,
      diagnose: () => {
        const now = current.tail()
        const said = now === '' ? lastTail : now
        return (
          `${label}已退出 (${String(current.proc.exitCode ?? lastCode)})` +
          `${attempts === 0 ? '' : `，已重建 ${String(attempts)} 次仍不通`}` +
          `${said === '' ? '' : `：${said.slice(-600)}`}`
        )
      },
    }
  }

  /**
   * 读一次审计镜像搬运的现场（issue #62）。
   *
   * ## 三个「不要写死」
   *
   * ① **镜像路径与滞后上限从跑着的控制台命令行上读**，不是常数。控制台是
   *    `--audit <节点>=<路径>` + `--audit-mirror <节点>=<分钟>` 申报的，那条
   *    命令行才是真源；抄一份进套件，改了部署这边不会红，只会开始说谎。
   * ② **新鲜度用控制台机器自己的钟算**（同一次采集里取 `date +%s`）。拿
   *    runner 的钟去减目标机的 mtime，跨时区或时钟漂移会造出假红/假绿。
   * ③ **权威副本比的是前缀哈希**，不是整份相等。审计链只追加，采样之间源端
   *    完全可能又写了几条 —— 那时整份哈希本来就该不同，而搬运仍然是对的。
   *
   * 采集全程只读：`systemctl show` / `stat` / `md5sum` / `head -c`。
   */
  /**
   * 问舰队上每一个跑着的东西「你是从哪个 commit 构建的」（issue #70 ③）。
   *
   * ## 为什么读的是**启动行**，不是部署树上的 `.source-commit` 戳
   *
   * 两者回答的不是同一个问题。戳文件是**构建的输入**（`bootstrap.sh` 读它、
   * 经 `OCC_SOURCE_COMMIT` 交给 `defines.ts`）；启动行是**此刻跑着的那个进程
   * 自己报出来的**。中间隔着「构建有没有真的重跑」「跑着的是不是新产物」两步，
   * 而真机腿要盖进报告的恰恰是后者 —— 一台戳着新 SHA、跑着旧进程的机器，读戳
   * 会给出一份和之前一样看着权威、实际证明不了的报告。
   *
   * ## 一台一条，不合并
   *
   * 四节点 + 控制台是**一台一台**滚更新的，停在两个 commit 上完全可能，而那
   * 正是最该被看见的事实。合并成一个值的那一刻它就消失了；合并只发生在渲染层
   * （`testedCommitConsensus`），而且只在全体一致时才给出答案。
   *
   * **「有台没答上」不是「大家报的不一样」**（issue #96 ②）：探针因此带重试
   * （纯读一次日志，重发绝对安全），而渲染层用 `testedCommitVerdict` 把这两种
   * 结局分开措辞。从 4/5 编出共识仍然不做 —— 变的只是那句话怎么写。
   *
   * ## `sourceCommit=unknown` 记成「没报上来」
   *
   * 那是产物构建时**就没能确定来源**（部署树没 `.git` 又没戳）。把这个字面量
   * 当成一个 commit 往上传，等于让 `unknown` 参与「一致不一致」的比较，四台
   * 全 unknown 会得出一个「大家一致」的结论 —— 报告于是又变成看着有答案、实际
   * 没有。所以它落在 `detail` 里，`commit` 留空。
   *
   * **这个方法不抛。** 每一种问不到都是一条 `commit` 为空、`detail` 写清原因
   * 的观察；绝不拿 runner 的 HEAD 去填 —— 那个回退正是这条缺陷本身。
   */
  async testedProvenance(): Promise<TestedProvenance> {
    const units: TestedUnitProvenance[] = []
    for (const host of this.#config.hosts) {
      units.push(await this.#nodeProvenance(host))
    }
    const consoleHost = this.#config.consoleHost
    if (consoleHost !== undefined) {
      units.push(await this.#consoleProvenance(consoleHost))
    }
    return { units }
  }

  /** 一台节点：从 `logs/<节点>.out` 里那行 JSON 启动 banner 上读。 */
  async #nodeProvenance(host: FleetHost): Promise<TestedUnitProvenance> {
    // 与 `#tail` 同一条路径推法（`<配置根>/../../../logs/<节点>.out`），但这里
    // **不能**用 `tail -200`：banner 是进程起来时写的第一行，一台跑了几天的
    // 节点后面早堆满了别的行。整份 grep，取最后一次匹配 = 最近一次启动。
    const log = `$(dirname '${shellQuote(host.configRoot)}')/../../logs/${host.node}.out`
    // 纯读一次日志，重发绝对安全 —— 而「问不到」这件事的代价高得离谱：一台没
    // 答上，整份来源结论就降级成「未知」（issue #96 ②）。
    let retries = 0
    const probe = await this.#sshRetry(
      host.ssh,
      [
        `f="${log}"`,
        `printf 'log=%s\n' "$f"`,
        `if [ -r "$f" ]; then`,
        `  printf 'readable=yes\n'`,
        `  printf 'sourceCommit=%s\n' "$(grep -o '"sourceCommit":"[^"]*"' -- "$f" | tail -1 | sed 's/^.*:"//; s/"$//')"`,
        `else`,
        `  printf 'readable=no\n'`,
        `fi`,
      ],
      {
        timeoutMs: PROVENANCE_PROBE_TIMEOUT_MS,
        onRetry: n => {
          retries = n
        },
      },
    )
    return interpretProvenanceProbe(
      host.node,
      probe,
      `${host.ssh} 上的 ${strField(probe.stdout, 'log') ?? '(路径未回显)'}`,
      strField(probe.stdout, 'readable') === 'no'
        ? '读不到该节点的启动日志'
        : '启动日志里没有 sourceCommit 字段（这份产物是 PR #74 之前构建的？）',
      retries,
    )
  }

  /** 控制台：banner 是 `键 值` 形态（`qm console`），不是 JSON。 */
  async #consoleProvenance(consoleHost: string): Promise<TestedUnitProvenance> {
    const override = process.env.QIANMO_ACCEPTANCE_CONSOLE_LOG
    const candidates = [
      ...(override === undefined || override === ''
        ? []
        : [`'${shellQuote(override)}'`]),
      `"${DEFAULT_CONSOLE_LOG}"`,
    ]
    let retries = 0
    const probe = await this.#sshRetry(
      consoleHost,
      [
        // **只在读到时才打 `readable=yes`**，别先打一行 `readable=no` 再在循环
        // 里覆盖：`strField` 取的是**第一条**匹配行，于是它永远读到 `no` ——
        // 「文件在、只是没有这个字段」会被报成「读不到日志」，把一个「产物太旧」
        // 的结论说成「路径配错了」。
        `for f in ${candidates.join(' ')}; do`,
        `  [ -r "$f" ] || continue`,
        `  printf 'log=%s\n' "$f"`,
        `  printf 'readable=yes\n'`,
        // 控制台那面是 `sourceCommit<空格填充><值>`，与常驻的 JSON 不同 ——
        // **键名与值的形态是对齐的，行的形态不是**，两处各解析各的。
        `  printf 'sourceCommit=%s\n' "$(grep -oE '^sourceCommit[[:space:]]+[^[:space:]]+' -- "$f" | tail -1 | awk '{print $2}')"`,
        `  break`,
        `done`,
      ],
      {
        timeoutMs: PROVENANCE_PROBE_TIMEOUT_MS,
        onRetry: n => {
          retries = n
        },
      },
    )
    return interpretProvenanceProbe(
      `console (${consoleHost})`,
      probe,
      `${consoleHost} 上的 ${strField(probe.stdout, 'log') ?? '(路径未回显)'}`,
      strField(probe.stdout, 'readable') === 'yes'
        ? 'banner 里没有 sourceCommit 字段（这份产物是 PR #76 之前构建的？）'
        : `读不到控制台的启动日志（试过 ${candidates.join(' / ')}；改了部署路径就用 QIANMO_ACCEPTANCE_CONSOLE_LOG 指过去）`,
      retries,
    )
  }

  async inspectMirrorTransport(): Promise<MirrorTransportReport> {
    const consoleHost = this.#config.consoleHost
    if (consoleHost === undefined) {
      throw new Error('inspectMirrorTransport 需要 consoleHost')
    }
    // 先取「控制台申报了什么」与目标机的钟；每台节点的单元状态与文件在下面
    // 各自一趟（systemctl 的实例名与镜像路径都要按节点拼，合不成一条）。
    // 采集全程只读（`ps` / `curl` / `systemctl show` / `stat` / `md5sum`），
    // 三趟全部接重试。**这三趟的产物直接进 `expect`** —— 静默读空会让审计镜像
    // 那条以「搬运停了」的形态红（`(取不到)s`），而搬运多半好好地在跑。
    const declared = await this.#read(
      consoleHost,
      [
        // 申报是成对的 `--audit <n>=<路径>` / `--audit-mirror <n>=<分钟>`，从
        // **跑着的控制台**的命令行上读 —— 那条命令行才是真源，抄一份进套件只会
        // 在部署改了之后开始说谎。
        //
        // `|| true` 是必须的：grep 一条都没匹配上时退出 1，而「一条申报都没有」
        // 是这条链路的一种**观察**（下面走 skip 分支），不是采集失败。少了它，
        // 「没部署镜像」会被报成「读不到搬运现场」。
        // `--port` 一起捞：它是下面那次健康检查的地址来源，比写死 38621 稳
        // （改部署这边不会红，只会开始说谎）。
        `ps -eo args | grep -oE -- '--(audit(-mirror)?|port) [^ ]+' | sort -u || true`,
        // 同一趟 ssh 里问一次健康。零额外往返，而它把「一条申报都没有」拆成
        // 「控制台活着但没配镜像」与「控制台没在跑」两件事。
        `p="$(ps -eo args | grep -oE -- 'cli-node.js console .*--port [0-9]+' | grep -oE -- '--port [0-9]+' | head -1 | awk '{print $2}')"`,
        `printf 'console-port=%s\n' "$p"`,
        `if [ -n "$p" ]; then printf 'console-health=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$p/v0/health" 2>/dev/null || echo 000)"; fi`,
      ],
      '读控制台的镜像申报',
    )
    // 这里的 `failure` 只剩「远端命令自己非零」一种含义了 —— 链路失败在
    // `#read` 里就抛掉了。区别是承重的：`failure` 会让那条场景记一条 **fail**
    // （「读不到搬运现场」），而链路失败记成 fail 等于用套件够不着机器去否掉
    // 一条产品结论，方向正好反了。
    if (declared.code !== 0) {
      return {
        consoleHost,
        units: [],
        failure: `读控制台申报失败 (${declared.code}): ${declared.stderr.slice(0, 400)}`,
      }
    }
    const declaredLines = declared.stdout.split('\n')
    const paths = new Map<string, string>()
    const lags = new Map<string, number>()
    for (const line of declaredLines) {
      const mirror = /^--audit-mirror (\S+)=(\d+)$/.exec(line.trim())
      if (mirror !== null && mirror[1] !== undefined) {
        lags.set(mirror[1], Number.parseInt(mirror[2] ?? '', 10))
        continue
      }
      const audit = /^--audit (\S+)=(\S+)$/.exec(line.trim())
      if (audit !== null && audit[1] !== undefined && audit[2] !== undefined) {
        paths.set(audit[1], audit[2])
      }
    }

    const units: MirrorTransportUnit[] = []
    for (const host of this.#config.hosts) {
      const mirrorPath = paths.get(host.node)
      const quotedMirror =
        mirrorPath === undefined ? '' : shellQuote(mirrorPath)
      // 每个值单独一行 `键=值`：`stat -c` 的 `%n` 是**文件名**不是换行，一行
      // 塞两个字段会拼出 `mirror-mtime=…<路径>mirror-bytes=…` 这种读不回来的
      // 东西。时间戳让**目标机自己**把 systemd 那串人话转成 epoch —— 那串正是
      // 它打印的，它一定认得，而在 runner 上 `Date.parse` 一个带时区缩写的
      // systemd 时间串是另一条会静默给出 NaN 的路。
      const unit = `qianmo-mirror@${host.node}`
      const probe = await this.#read(
        consoleHost,
        [
          // 钟**在这一趟里取**，与 systemctl / stat 读到的是同一个时刻。取一次
          // 放在整轮采集开头会让后取的那几台算出负的「距今」—— 负值又恰好能
          // 无条件通过「≤ 上限」，于是这条断言在最需要它的方向上是瞎的。
          `printf 'observed-at=%s\n' "$(date +%s)"`,
          `lt="$(systemctl --user show '${unit}.timer' -p LastTriggerUSec --value 2>/dev/null)"`,
          `printf 'last-trigger-at=%s\n' "$lt"`,
          `printf 'last-trigger-sec=%s\n' "$(date -d "$lt" +%s 2>/dev/null)"`,
          `systemctl --user show '${unit}.service' -p ExecMainStatus -p Result 2>/dev/null || true`,
          ...(mirrorPath === undefined
            ? []
            : [
                `printf 'mirror-mtime=%s\n' "$(stat -c '%Y' -- '${quotedMirror}' 2>/dev/null)"`,
                `printf 'mirror-bytes=%s\n' "$(stat -c '%s' -- '${quotedMirror}' 2>/dev/null)"`,
                `printf 'mirror-md5=%s\n' "$(md5sum -- '${quotedMirror}' 2>/dev/null | cut -d' ' -f1)"`,
              ]),
        ],
        `读 ${host.node} 的镜像搬运现场`,
      )
      const mirrorBytes = intField(probe.stdout, 'mirror-bytes')
      // 权威副本在**节点**上，所以这一段要连到那台机器上去问。
      const authority =
        mirrorBytes === undefined
          ? { code: 0, stdout: '', stderr: '' }
          : await this.#read(
              host.ssh,
              [
                `t='${shellQuote(`${host.configRoot}/${TRAIL_PATH}`)}'`,
                `printf 'authoritative-bytes=%s\n' "$(stat -c '%s' -- "$t" 2>/dev/null)"`,
                `printf 'authoritative-md5=%s\n' "$(md5sum -- "$t" 2>/dev/null | cut -d' ' -f1)"`,
                `printf 'authoritative-prefix-md5=%s\n' "$(head -c ${mirrorBytes} -- "$t" 2>/dev/null | md5sum | cut -d' ' -f1)"`,
              ],
              `读 ${host.node} 上的权威审计链`,
            )
      units.push({
        node: host.node,
        ...(lags.get(host.node) === undefined
          ? {}
          : { maxLagMinutes: lags.get(host.node) }),
        ...(mirrorPath === undefined ? {} : { mirrorPath }),
        ...pick('lastTriggerAt', strField(probe.stdout, 'last-trigger-at')),
        ...pick('lastTriggerSec', intField(probe.stdout, 'last-trigger-sec')),
        ...pick('serviceExitCode', intField(probe.stdout, 'ExecMainStatus')),
        ...pick('serviceResult', strField(probe.stdout, 'Result')),
        ...pick('mirrorMtimeSec', intField(probe.stdout, 'mirror-mtime')),
        ...pick('mirrorBytes', mirrorBytes),
        ...pick('mirrorHash', strField(probe.stdout, 'mirror-md5')),
        ...pick(
          'authoritativeBytes',
          intField(authority.stdout, 'authoritative-bytes'),
        ),
        ...pick(
          'authoritativeHash',
          strField(authority.stdout, 'authoritative-md5'),
        ),
        ...pick(
          'authoritativePrefixHash',
          strField(authority.stdout, 'authoritative-prefix-md5'),
        ),
        ...pick('observedAtSec', intField(probe.stdout, 'observed-at')),
        raw: `${probe.stdout}\n${authority.stdout}`.trim(),
      })
    }
    return {
      consoleHost,
      units,
      ...pick('consolePort', intField(declared.stdout, 'console-port')),
      ...pick(
        'consoleHealthStatus',
        intField(declared.stdout, 'console-health'),
      ),
    }
  }

  /**
   * 目标机上找一个此刻没人在听的高位端口。
   *
   * 用 `ss` 的全量快照做差集而不是逐个口去问：一次 SSH 往返就够，而逐个问是
   * 每个候选一次往返。答不出来是**错误**，不是随便回一个 —— 回一个碰巧被占的
   * 口会让「不可达」那条场景红得毫无道理。
   */
  async #freePortOn(ssh: string): Promise<number> {
    // **这是 issue #98 那条现场实例。**`ss -H -ltn` 纯读一次内核的监听表，
    // 重发绝对安全；而 `3aa7fb81` 那轮真机腿唯一的红就是它撞上一次
    // `Connection closed by`（rc=255），栈停在这里，报告上写着
    // 「audit/full-rewrite-not-detected-locally 炸了」—— 而那条场景问的是
    // 审计链回不回得到 intact，跟 p7 的 SSH 一点关系没有。
    const probe = await this.#read(
      ssh,
      [`ss -H -ltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u`],
      `在 ${ssh} 上取监听端口表`,
    )
    if (probe.code !== 0) {
      throw new Error(
        `在 ${ssh} 上取监听端口表失败 (${probe.code}): ${probe.stderr.slice(0, 300)}`,
      )
    }
    const busy = new Set(probe.stdout.split('\n').map(l => l.trim()))
    for (let i = 0; i < 200; i += 1) {
      const port = 41_000 + Math.floor(Math.random() * 4_000)
      if (!busy.has(String(port))) return port
    }
    throw new Error(`在 ${ssh} 上 200 次都没抽到空闲端口`)
  }

  async #tail(host: FleetHost, stream: 'out' | 'err'): Promise<string> {
    // 纯读一次日志尾巴，重发绝对安全 —— 而它读的是**证据栏的来源**（issue
    // #98 ④）。一次链路失败让它静默返回 ''，读报告的人会以为「日志里什么都
    // 没有」，而那一栏往往正是判断产品对错的那一栏。
    const result = await this.#read(
      host.ssh,
      [
        `tail -200 -- "$(dirname '${host.configRoot}')/../../logs/${host.node}.${stream}" 2>/dev/null || true`,
      ],
      `读 ${host.node} 的 ${stream} 日志`,
    )
    return result.stdout
  }

  /**
   * 跑一条**幂等**远端命令，链路抖了就再打一次。
   *
   * ## 只给幂等命令用
   *
   * 这个包装不判断安全性，调用方负责。起一个一次性常驻、写一个文件、`kill` 一
   * 个 pid —— 这些重发一次的后果是两个进程 / 半截文件 / 打到别人头上，比一条
   * `error` 糟得多。目前的调用点全是「读一次」或「反复做结果相同」：来源探针、
   * 家目录、开一次性目录（路径由远端回显、`mkdir -p` 语义）、清理的 `rm -rf`。
   *
   * ## 为什么值得重试
   *
   * 真机腿一轮两小时、几百次 SSH，其中一台还要经 gcloud IAP 的 ProxyCommand。
   * 那一轮唯一的红就是这么来的：`mktemp -d` 撞上一次隧道 EOF，栈停在开目录那
   * 一步，`beta-up.sh` 一行都没跑到 —— 它不可能是在回答场景那个问题，而同条
   * 重跑就 PASS。**重试成功不是放水**：那说明这一步确实做成了，套件确实问到了
   * 被测系统。重试**失败**仍然一条不少地报上去，一次都不吞。
   */
  async #sshRetry(
    ssh: string,
    lines: readonly string[],
    options?: {
      readonly timeoutMs?: number
      readonly attempts?: number
      /** 每次准备重发时回调一次，参数是「这是第几次重发」与上一次的结果。 */
      readonly onRetry?: (attempt: number, previous: ExecResult) => void
    },
  ): Promise<ExecResult> {
    const attempts = Math.max(1, options?.attempts ?? TRANSPORT_RETRY_ATTEMPTS)
    let result = await this.#ssh(ssh, lines, options?.timeoutMs)
    for (let n = 1; n < attempts; n++) {
      if (!isRetriableTransportFailure(result)) break
      options?.onRetry?.(n, result)
      await sleep(TRANSPORT_RETRY_BACKOFF_MS * n)
      result = await this.#ssh(ssh, lines, options?.timeoutMs)
    }
    return result
  }

  /**
   * 一条**幂等**远端命令：抖了退避重发，打满仍不通抛 {@link TransportFailure}。
   *
   * 这是「读一次」类调用点的**唯一**正确写法。裸 `#ssh` 不抛，于是一次 rc=255
   * 会安静地折成一个空 stdout —— 而空 stdout 在这个文件里到处都有含义：「文件
   * 不存在」「进程死了」「日志是空的」「一条申报都没有」。那些含义每一条都是
   * **关于被测系统的观察**，而这一趟根本没问到。见下面 `#ssh` 头上那张表。
   *
   * 远端命令**自己**的非零返回码原样交回调用方 —— 那是一次真的观察，判不判由
   * 调用方决定。这个包装只回答「有没有走到远端」。
   */
  async #read(
    ssh: string,
    lines: readonly string[],
    what: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<ExecResult> {
    let attempts = 1
    const result = await this.#sshRetry(ssh, lines, {
      timeoutMs: options?.timeoutMs,
      onRetry: n => {
        attempts = n + 1
      },
    })
    if (isTransportFailure(result)) {
      throw new TransportFailure({
        ssh,
        what,
        code: result.code,
        stderr: result.stderr,
        attempts,
      })
    }
    return result
  }

  /**
   * 一条**非幂等**远端命令：只发一次，但仍然判「有没有走到远端」。
   *
   * 起进程、`kill`、写文件、跑任意 `qm` 子命令都走它。**绝不重发** —— 理由写在
   * {@link FleetDriver.#sshRetry} 的头注里：重发一次的后果是两个常驻抢一个端口、
   * 一刀砍到被复用的 pid 上、审计链里多一条记录，每一样都比一条 `error` 糟。
   *
   * 它补的是另一半：`#ssh` 不抛，于是 rc=255 会原样交给调用方，而 255 在
   * `ExecResult` 里长得和「远端命令失败了」一模一样。场景读到的是「这条命令
   * 失败了」，实际上它一行都没执行到。
   */
  async #once(
    ssh: string,
    lines: readonly string[],
    what: string,
    options?: { readonly timeoutMs?: number; readonly stdin?: string },
  ): Promise<ExecResult> {
    const result = await this.#ssh(
      ssh,
      lines,
      options?.timeoutMs,
      options?.stdin,
    )
    if (isTransportFailure(result)) {
      throw new TransportFailure({
        ssh,
        what,
        code: result.code,
        stderr: result.stderr,
        attempts: 1,
      })
    }
    return result
  }

  /**
   * 只为**已经在构造的那条错误消息**读一段文本，**永不抛**。
   *
   * 用它的地方都长一个样：外面已经拿到一条成立的结论（「节点没起来」「拨不
   * 通」），现在补一段远端 stderr 给人看。这时候再抛一个 `TransportFailure`
   * 出去，等于用「日志没读到」把那条**已经观察到**的结论掀掉 —— 报告上会变成
   * 一条链路错误，而真正的现场（进程没起来）一个字都不剩。
   *
   * 所以这一条反过来：读不到就在文本里明说「取不到」，绝不假装日志是空的。
   */
  async #diag(
    ssh: string,
    lines: readonly string[],
    what: string,
  ): Promise<string> {
    const result = await this.#sshRetry(ssh, lines)
    if (isTransportFailure(result)) {
      const signature = transportSignature(result.stderr)
      return (
        `[取不到${what}：到 ${ssh} 的 SSH 链路失败 (${result.code}` +
        `${signature === undefined ? '' : `，${signature}`})]`
      )
    }
    return result.stdout
  }

  /**
   * 跑一条远端命令。
   *
   * `stdin` 给了就不能带 `-n`（那个选项把 stdin 接到 /dev/null），这正是
   * `writeFile` 经管道送内容的那条路径。
   *
   * ## 不要直接用它 —— 先在下面那张表里找到你的调用点（issue #98）
   *
   * **`#ssh` 不抛。**它把 `ssh` 自己的失败（rc=255，远端命令一行都没执行到）
   * 和远端命令的真实回答塞进同一个 `ExecResult`。于是每一个裸调用点都在悄悄
   * 做一次它没资格做的断言：空 stdout 被读成「文件不存在」「进程死了」「日志
   * 是空的」，非零 rc 被读成「这条命令失败了」。
   *
   * 这个病已经花掉两轮真机腿（各约两小时）。第一轮红在 `#scratch`，PR #97 补
   * 上；第二轮红在 `#freePortOn`，而它不在 #97 点名的四条里 —— **逐处点名的
   * 做法本身不成立**。所以下面是全表，三十四条一条不落，包括「本来就对」的。
   *
   * 三条纪律：
   *
   *   · **幂等**（纯读 / 反复做结果相同）→ `#read`：退避重发，打满抛
   *     {@link TransportFailure}；
   *   · **非幂等**（起进程 / `kill` / 写文件 / 任意 `qm` 子命令）→ `#once`：
   *     只发一次，但仍判「有没有走到远端」。**绝不接重试**；
   *   · 只进**已成立的错误消息**的那几段 → `#diag`：永不抛，读不到就明说。
   *
   * 判不准就判成非幂等：重发一个非幂等命令比一条 `error` 糟得多。
   *
   * 表里**不写行号** —— 行号一改就过期，而过期的表比没有表更坏。
   *
   * | # | 调用点 | 远端命令 | 幂等 | 丢了 rc 会怎么骗人 | 改成 |
   * | --- | --- | --- | --- | --- | --- |
   * | 1 | `#attach().alive` | `pgrep resident` | 纯读 | 答「节点死了」 | `#read` |
   * | 2 | `#launchDisposable` 启动 | `setsid bun … resident` | **否**（起进程） | 后面 banner 读空 → 「节点没起来」 | `#once` |
   * | 3 | `#launchDisposable` banner | `cat out.log` | 纯读 | 同上，且这条才是直接原因 | `#read` |
   * | 4 | `#launchDisposable` 诊断 | `cat err.log` | 纯读 | 诊断段静默变空 | `#diag`（外面那条错误已成立） |
   * | 5 | 一次性句柄 `stdout` | `cat out.log` | 纯读 | 证据栏静默变空 | `#read` |
   * | 6 | 一次性句柄 `stderr` | `cat err.log` | 纯读 | 同上 | `#read` |
   * | 7 | 一次性句柄 `alive` | 读 pid + `kill -0` | 纯读（`-0` 不发信号） | 答「节点死了」 | `#read` |
   * | 8 | 就绪超时诊断 | `cat err.log` | 纯读 | 诊断段静默变空 | `#diag` |
   * | 9 | `#killGroup` | `kill -TERM/-KILL` | **否** | 常驻带 ACP 子进程静默存活，报告零线索 | `#once` + 判 rc 抛 |
   * | 10 | `readNodeFile` | `cat -- <配置根>/…` | 纯读 | 答「文件不存在」→ 直接进 `expect` | `#read` |
   * | 11 | `writeNodeFile` | `mkdir -p` + `cat >` | **否**（写） | rc 已判，但 255 说成「写不进去」 | `#once` |
   * | 12 | `setNodePathMode` | `chmod <固定位>` | 是 | 权限位没改成，后面以「产品没拦住」形态红 | `#read` + 判 rc 抛 |
   * | 13 | `listNodeDir` | `ls -1 --` | 纯读 | 答「目录不存在」→ 直接进 `expect` | `#read` |
   * | 14 | `execNode` | 任意 `qm` 子命令 | **否** | `{code:255}` 被读成「这条命令失败了」 | `#once` |
   * | 15 | `execHost.exec` | 任意 `qm` 子命令 | **否** | 同上（签发链走这里） | `#once` |
   * | 16 | `execHost.run` | 场景给的任意 argv | **否** | 同上（`openssl` 走这里） | `#once` |
   * | 17 | `execHost.writeFile` | `mkdir -p` + `cat >` | **否**（写） | rc 已判，255 说成「写不进去」 | `#once` |
   * | 18 | `execHost.mkdir` | `mkdir -p --` | 是 | rc 全丢；目录没建成，红在后面往里写那一步 | `#read` + 判 rc 抛 |
   * | 19 | `execHost.readFile` | `cat -- … \|\| true` | 纯读 | 答「文件不存在」 | `#read` |
   * | 20 | `#startConsole` 启动 | `setsid bun … console` | **否**（起进程） | rc 全丢；后面 banner 读空 → 「控制台没起来」 | `#once` |
   * | 21 | `#startConsole` `readOut` | `cat console.out.log` | 纯读 | banner 读空 → 假的「没起来」，两枚 token 一起丢 | `#read` |
   * | 22 | `#startConsole` `readErr` | `cat console.err.log` | 纯读 | 证据栏静默变空 | `#read`（进错误消息的那份走 `#diag`） |
   * | 23 | `#killByPidFile` | `kill -TERM/-KILL` | **否** | 一次性控制台静默存活，报告零线索 | `#once` + 判 rc 抛 |
   * | 24 | `launcherHost` 开位 | `mkdir -p run/ logs/` | 是 | rc 全丢；`beta-up.sh` 里以别的毛病红 | `#read` + 判 rc 抛 |
   * | 25 | `launcherHost.writeFile` | `mkdir -p` + `cat >` + `chmod` | **否**（写） | rc 已判，255 说成「写不进去」 | `#once` |
   * | 26 | `launcherHost.run` | `beta-up.sh` 等 | **否**（起进程/改部署树） | `{code:255}` 被读成「启动器脚本失败了」 | `#once` |
   * | 27 | `launcherHost.exists` | `test -e … && echo yes \|\| echo no` | 纯读 | **答「文件不存在」并直接进 `expect`** —— 全表最危险，两个方向都能假 | `#read` + 答不上来也抛 |
   * | 28 | `launcherHost.readFile` | `cat -- … \|\| true` | 纯读 | **答「文件是空的」并直接进 `expect`** | `#read` |
   * | 29 | `#reverseTunnel` 就绪探测 | `curl /v0/agents` | 纯读 | 「隧道没通」——归因指向产品 | 循环自己就是重试；打到预算时判 255 抛 |
   * | 30 | `inspectMirrorTransport` 申报 | `ps -eo args` + `curl` | 纯读 | 记成 `failure` → 场景一条 **fail**（比 error 更坏） | `#read` |
   * | 31 | 镜像现场（每节点） | `systemctl show` / `stat` / `md5sum` | 纯读 | rc 全丢；每栏 `(取不到)` → 「搬运停了」假红 | `#read` |
   * | 32 | 权威副本（每节点） | `stat` / `md5sum` / `head -c` | 纯读 | 同上，且前缀哈希那条承重断言直接假红 | `#read` |
   * | 33 | `#freePortOn` | `ss -H -ltn` | 纯读 | **本 issue 的现场实例**：一条无标记的 `error`，写着别的场景名 | `#read` |
   * | 34 | `#tail` | `tail -200` | 纯读 | 证据栏静默变空，读报告的人以为「日志里什么都没有」 | `#read` |
   *
   * 另有两处**本来就对、不用改**，一并写出来以证明它们被看过了：
   *
   * | # | 调用点 | 为什么不用改 |
   * | --- | --- | --- |
   * | A | `#scratch` 开目录 / 清扫 / `rm -rf` | PR #97 已按同一套纪律接了 `#sshRetry` + `TransportFailure`，清理失败另有 `ctx.log` + 抛 |
   * | B | `#homeOf` / `#nodeProvenance` / `#consoleProvenance` | 同上，PR #97 已接 |
   *
   * 表外还有两处 `#ssh` 出现在 {@link FleetDriver.#sshRetry} 自己体内 —— 那是
   * 重发循环的实现，不是调用点。
   *
   * **这张表管的是「远端命令」，不含 SSH 复用自己那两条**（issue #100）：建
   * master 的 `ssh -M -N` 与拆它的 `ssh -O exit` 都在 {@link SshMultiplex} 里，
   * 一条远端命令都不跑（前者 `-N`，后者只跟本地 socket 说话），所以它们不落在
   * 幂等性这条轴上，也就没有第 35 行。
   */
  async #ssh(
    ssh: string,
    lines: readonly string[],
    timeoutMs?: number,
    stdin?: string,
  ): Promise<ExecResult> {
    // 复用 master 先就位：这台机器的第一条命令付一次真握手，之后每条只是在
    // 已建好的会话上开一条 channel（issue #100）。建不起来就**不发这条命令**，
    // 原样回一次 rc=255 —— 静默退回「每次新建」会让复用是否生效无法验证，而
    // 那正是这类改动最难发现的失败形态。见 {@link SshMultiplex} 的头注。
    const mux = await this.#mux.ensure(ssh)
    if (mux.kind === 'failed') {
      return { code: mux.code, stdout: '', stderr: mux.stderr }
    }
    const child = Bun.spawn(
      [
        this.#config.sshBin ?? 'ssh',
        ...(stdin === undefined ? ['-n'] : []),
        '-o',
        'BatchMode=yes',
        ...mux.args,
        ...(this.#config.sshArgs ?? []),
        ssh,
        lines.join('\n'),
      ],
      {
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    // 计时器必须**在等两条流之前**装上：远端挂住时 `.text()` 就已经不返回了，
    // 装在它们后面等于这个超时永远没有机会开始计时。
    let timedOut = false
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, timeoutMs)
    let stdout: string
    let stderr: string
    let code: number
    try {
      ;[stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      code = await child.exited
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    return {
      code,
      stdout,
      stderr: timedOut
        ? `${stderr}\n[acceptance] ssh ${ssh} 超时 ${String(timeoutMs)}ms，已 SIGKILL`
        : stderr,
    }
  }
}

/**
 * 「这个句柄是一次性节点吗」的守门人。
 *
 * 每一个**会改动目标状态**的方法都先过它。附着来的那台是内测在用的节点：
 * 停它会断掉使用者，写它的配置根会在成果边界证据里留下没人解释得清的记录。
 * 抛出的话必须说清是哪一件事被拒绝了 —— 一句「不支持」会让人以为是没实现。
 */
function requireDisposable(node: NodeHandle, what: string): DisposableNode {
  const disposable = (node as FleetNodeHandle).disposable
  if (disposable === undefined) {
    throw new Error(
      `FleetDriver 不${what}附着来的内测节点 ${node.name}：那会打断内测使用者，` +
        `也会在那条节点的审计链上留下一次计划外记录。只有一次性节点（spawn-node）允许这么做`,
    )
  }
  return disposable
}

/**
 * 抽干一条流，但把最后若干字节留下来给错误消息用。
 *
 * `drain` 之所以存在，是因为管道写满之后 ssh 会阻塞在 `write` 上（见 `#tunnel`
 * 的头注）。但**只抽不留**的代价是：隧道自己死掉时，它临死前写的那句话也一起
 * 被扔了 —— 而那句话恰恰是唯一说得清「为什么拨不通」的证据。
 */
function drainKeepingTail(
  stream: ReadableStream<Uint8Array>,
  limit = 2_000,
): { readonly text: () => string } {
  let tail = ''
  void (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) {
          tail = (tail + decoder.decode(value, { stream: true })).slice(-limit)
        }
      }
    } catch {
      // 进程被 kill 时流以异常收场，那不是观察结果。
    }
  })()
  return { text: () => tail }
}

/** 把一条流读干净并丢掉 —— 只为让写它的那一端不被管道憋住。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
  } catch {
    // 进程被 kill 时流以异常收场，那不是观察结果。
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 只在值存在时给出这一项 —— 让 `exactOptionalPropertyTypes` 下的拼装保持干净。 */
function pick<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined
    ? {}
    : ({ [key]: value } as unknown as Record<K, V>)
}

/**
 * 把一次来源探测的输出折成一条 {@link TestedUnitProvenance}。
 *
 * 四种结局各说各的话，**没有一种回退成别的值**：SSH 本身失败 → 带退出码与
 * stderr 原文；读到了一个 40 位 SHA（可带 `-dirty`）→ 那就是答案；读到的是
 * `unknown` → 那是产物构建时就没确定来源，记进 `detail`、`commit` 留空；
 * 什么都没读到 → 用调用方给的那句话（日志不存在 / 没有这个字段）。
 *
 * 形状校验（40 位十六进制）不是洁癖：这一栏的用处全在「能不能钉回一个提交」，
 * 一个形状不对的串钉不回去，却会在报告上冒充一个答案。
 */
function interpretProvenanceProbe(
  unit: string,
  probe: ExecResult,
  where: string,
  emptyReason: string,
  retries = 0,
): TestedUnitProvenance {
  if (probe.code !== 0) {
    // 「链路没通」与「问到了但答不上来」在报告上必须长得不一样：前者说的是套件
    // 够不着这台机器，后者才是关于这台机器的观察（issue #96 ②）。重试次数也带
    // 上 —— 打过三次仍不通和只打过一次，是两种可信度。
    const how = isTransportFailure(probe)
      ? `SSH 链路失败 (${probe.code}${
          transportSignature(probe.stderr) === undefined
            ? ''
            : `，${transportSignature(probe.stderr)}`
        }${retries === 0 ? '' : `，已重发 ${retries} 次`})`
      : `采集失败 (${probe.code})`
    return {
      unit,
      detail: `${how}: ${probe.stderr.trim().slice(0, 300)}`,
    }
  }
  const raw = strField(probe.stdout, 'sourceCommit')
  if (raw === undefined) return { unit, detail: `${emptyReason}；${where}` }
  if (raw === 'unknown') {
    return {
      unit,
      detail: `它自己报的就是 sourceCommit=unknown —— 那份产物构建时没能确定来源（${where}）`,
    }
  }
  if (!/^[0-9a-f]{40}(-dirty)?$/.test(raw)) {
    return {
      unit,
      detail: `读到的 sourceCommit 不是一个 commit 的形状：${raw.slice(0, 80)}（${where}）`,
    }
  }
  return { unit, commit: raw, detail: `读自 ${where}` }
}

/** 从 `key=value` 行里取一个字符串字段；取不到或为空回 undefined。 */
function strField(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${key}=`)) continue
    const value = trimmed.slice(key.length + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** 同上，但要求它是个整数。**解析不出来一律 undefined，不要退回 0** —— 那会
 * 让「没取到」和「真的是 0」在断言里长得一模一样，而这两件事的判定相反。 */
function intField(text: string, key: string): number | undefined {
  const raw = strField(text, key)
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 单引号内的转义 —— 远端命令一律用 `'…'` 包，内部的 `'` 按 POSIX 拼法断开。 */
function shellQuote(value: string): string {
  return value.replaceAll("'", `'\\''`)
}

/** 控制台机器的默认 SSH 目标 —— 审计镜像的搬运那一半全发生在它上面。 */
export const DEFAULT_CONSOLE_HOST = 'workbench-iap'

/** 节点名 → 环境变量后缀（`beta-1` → `BETA_1`）。 */
function envSuffix(node: string): string {
  return node.replaceAll('-', '_').toUpperCase()
}

/**
 * 从环境变量拼一份舰队配置。
 *
 * PSK 按节点取 `QIANMO_ACCEPTANCE_PSK_<节点名大写下划线>`，取不到回退到
 * `QIANMO_TRANSPORT_PSK`。**PSK 只从环境取，不写进仓库**（它是四台机的入站
 * 凭据，进仓库就等于公开）。
 *
 * `occPath` 由各 host 的 `configRoot` 推出来，而不是拼一次再对某台机做字符串
 * 替换 —— p12 那台的家目录是 `/root` 而不是 `/home/cornna`，替换写法在新增第
 * 五台机时会静默给出一条不存在的路径。
 *
 * ## 拨号地址怎么定（issue #61 第 3 条）
 *
 * 原先四台写死同一个 `ws://127.0.0.1:38625` —— 那是**节点自己**的回环地址，
 * 从舰队外拨等于拨 runner 自己的 38625。改成按主机的隧道端口，三级优先：
 *
 *   ① `QIANMO_ACCEPTANCE_ENDPOINT_<节点>`：整条 URL 直接给，最高优先。
 *      直连节点、换了端口、走别的转发，都用这个；
 *   ② `QIANMO_ACCEPTANCE_DIAL_HOST`：只换主机名，端口仍用各自的
 *      `tunnelPort`。**在 H 上跑套件时不用设**（那四个口就在 H 的回环上），
 *      从别处跑就把 `ssh -N -L 3863x:127.0.0.1:3863x <H>` 起起来再跑；
 *   ③ 默认 `ws://127.0.0.1:<tunnelPort>`。
 *
 * 套件不自己去建隧道：建隧道要一个跨整轮运行的进程与它的生命周期，而
 * 「这台 runner 怎么够得着舰队」本来就是运行环境的事，写死在套件里只会在
 * 换一种拓扑时挡路。拨不通是**如实的红**，不是假绿 —— 那正好是这次要修的病。
 *
 * ## 节点搬家了怎么办：`QIANMO_ACCEPTANCE_SSH_<节点>`
 *
 * 与拨号地址同一条理由 —— **哪台机器承载某个节点是部署的事实**。别名被重指或
 * 节点换了机器之后，{@link DEFAULT_FLEET_HOSTS} 里写死的那一栏不会报错，它会
 * 安静地去问另一台机器：`#tail` / `execNode` / `readNodeFile` / 来源探针全部
 * 得到「那台机器上没有这个」，报告上表现为一条读不通的节点，而现场看起来像那
 * 个节点坏了。给一条覆盖，运维不必为此改代码。
 *
 * **只覆盖 SSH 目标，不覆盖配置根** —— 部署形状（`<家目录>/qianmo-beta/…` +
 * `<家目录>/atlas-beta`）是 `beta-up.sh` 定的，跟着机器走；真需要改的那天，
 * 该改的是 {@link DEFAULT_FLEET_HOSTS}，不是再加一条环境变量。
 */
export function fleetConfigFromEnv(repoDirOverride?: string): FleetConfig {
  // 控制台主机可关：`QIANMO_ACCEPTANCE_CONSOLE_HOST=` 置空就等于「这一轮没有
  // 控制台机器」，靠它的场景据此老实 skip 而不是红。
  const consoleHostRaw =
    process.env.QIANMO_ACCEPTANCE_CONSOLE_HOST ?? DEFAULT_CONSOLE_HOST
  const psk: Record<string, string> = {}
  const dialHost = process.env.QIANMO_ACCEPTANCE_DIAL_HOST ?? '127.0.0.1'
  const hosts = DEFAULT_FLEET_HOSTS.map(host => {
    const suffix = envSuffix(host.node)
    psk[host.node] =
      process.env[`QIANMO_ACCEPTANCE_PSK_${suffix}`] ??
      process.env.QIANMO_TRANSPORT_PSK ??
      ''
    // configRoot 形如 `<家目录>/qianmo-beta/nodes/<节点>/config`，仓库检出与它
    // 同在一个家目录下（`<家目录>/atlas-beta`）—— 那是 `beta-up.sh` 的部署形状。
    const home = host.configRoot.replace(/\/qianmo-beta\/.*$/, '')
    const repoDir = repoDirOverride ?? `${home}/atlas-beta`
    const endpoint =
      process.env[`QIANMO_ACCEPTANCE_ENDPOINT_${suffix}`] ??
      `ws://${dialHost}:${host.tunnelPort}`
    // SSH 别名可覆盖，与 `ENDPOINT_<节点>` 同一条理由：**哪台机器承载某个节点
    // 是部署的事实，不是拓扑的常量**。节点搬家（或别名被重指）之后，写死的那
    // 一栏不会报错，它会安静地去问另一台机器 —— 于是 `#tail` / `execNode` /
    // `readNodeFile` / 来源探针全部得到「那台机器上没有这个」，报告上表现为
    // 一条读不通的节点，而现场看起来像那个节点坏了。这条 issue #61 的形状不该
    // 只能靠改代码来绕过。
    const ssh = process.env[`QIANMO_ACCEPTANCE_SSH_${suffix}`] ?? host.ssh
    return { ...host, ssh, endpoint, occPath: `${repoDir}/dist/cli-node.js` }
  })
  // 一次性进程落在哪几台机器上：`QIANMO_ACCEPTANCE_SPAWN_HOSTS` 逗号分隔的
  // SSH 目标；置空 = 这一轮不起任何一次性进程（`spawn-node` 等能力随之消失，
  // 靠它们的场景如实 skip）。不给就用默认表 —— 那张表**刻意不含承载 beta-4 的
  // 那台**，理由见文件头。
  const spawnRaw = process.env.QIANMO_ACCEPTANCE_SPAWN_HOSTS
  const spawnMachines =
    spawnRaw === undefined
      ? DEFAULT_SPAWN_MACHINES
      : spawnRaw
          .split(',')
          .map(name => name.trim())
          .filter(name => name !== '')
          .map(
            name =>
              DEFAULT_SPAWN_MACHINES.find(m => m.ssh === name) ?? {
                ssh: name,
                label: name,
                repoRel: 'atlas-beta',
              },
          )
  // SSH 连接复用（issue #100）。**默认开** —— 一轮两千次握手里出一次抖动是必然
  // 事件，而每轮出在不同的调用点。`QIANMO_ACCEPTANCE_SSH_MULTIPLEX=0`（或
  // `false`）一键退回每条命令自己建一次连接：复用出问题时要的是一条命令换回老
  // 路，不是改代码再发一版。**只认这两个值**，别的（含拼错的）一律当没关。
  const multiplexRaw = process.env.QIANMO_ACCEPTANCE_SSH_MULTIPLEX?.trim()
  const sshMultiplex = multiplexRaw !== '0' && multiplexRaw !== 'false'
  return {
    hosts,
    spawnMachines,
    psk,
    sshMultiplex,
    ...(consoleHostRaw === '' ? {} : { consoleHost: consoleHostRaw }),
  }
}
