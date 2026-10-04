// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌端到端验收套件 —— 场景与驱动的公共类型。
 *
 * 这套件要回答的是负责人给的那条验收标准：「流程全部跑通，逻辑和所有功能
 * 模块全部正常，无任何 bug，无干预无错误跑完全部可能的场景和模拟」。
 * 一条标准要么被证明，要么被证伪 —— 所以这里的每个类型都为「逐场景独立
 * 判定 + 失败给原文证据」服务，没有任何聚合成一个布尔值的出口。
 *
 * 三条设计约束，改这个文件前先读：
 *
 * ① **场景定义与驱动分离，且只有一套场景。** 本地（起真进程 + 可控假上游）
 *    与真机舰队（四节点 + 控制台）是两个 {@link AcceptanceDriver} 实现，
 *    场景代码对二者一字不改。写第二套场景 = 两边会漂移，那时候「本地绿」
 *    就不再说明任何事。
 *
 * ② **能力不足要 skip，不要假装 pass。** 场景声明自己需要哪些
 *    {@link DriverCapability}，驱动声明自己有哪些，runner 做差集。真机驱动
 *    对「按任意参数起一个新节点」这类能力天然没有，那就如实记 `skip` 并写明
 *    原因 —— 报告里 skip 与 pass 分列两栏，覆盖率据此计算。
 *
 * ③ **判定只由场景自己给，证据必须是原文。** {@link Evidence.value} 存的是
 *    错误串 / HTTP 码 / 日志行 / 帧内容本身，不是「失败了」这种转述。这套
 *    件的价值全在红的那几行上；把证据摘要化等于把价值删掉。
 */

/** 验收目标：本地进程，或真机舰队。 */
export type Target = 'local' | 'fleet'

/**
 * 单场景判定。
 *
 * `fail` 与 `error` 分开：前者是**断言不成立**（系统行为与期望不符，这正是
 * 套件要抓的东西），后者是**套件自己炸了**（驱动起不来、超时、抛异常）。
 * 合并成一个值会让「被测系统有 bug」和「测试有 bug」看起来一样，而这两件事
 * 的处理方式完全相反。
 */
export type Outcome = 'pass' | 'fail' | 'skip' | 'error'

/** 场景维度 —— 与验收矩阵的行一一对应。 */
export type Dimension =
  | 'handshake'
  | 'policy'
  | 'capability'
  | 'trust'
  | 'delivery'
  | 'model-credential'
  | 'abort-attribution'
  | 'multi-agent'
  | 'audit'
  | 'wake'
  | 'recovery'
  | 'launcher'
  | 'limits'
  | 'console'
  | 'certificate'

export const DIMENSIONS: readonly Dimension[] = [
  'handshake',
  'policy',
  'capability',
  'trust',
  'delivery',
  'model-credential',
  'abort-attribution',
  'multi-agent',
  'audit',
  'wake',
  'recovery',
  'launcher',
  'limits',
  'console',
  'certificate',
]

/**
 * 一条原文证据。
 *
 * `value` 不截断也不改写。太长的话由渲染层负责折行，不是由采集层负责裁剪 ——
 * 采集层一裁剪，NDJSON 里就永远拿不回来了。
 */
export interface Evidence {
  readonly label: string
  readonly value: string
}

/** 驱动能力。场景按需声明，驱动按实提供，缺一项就 skip。 */
export type DriverCapability =
  /**
   * 能拿到一个**正在跑的**节点句柄（本地靠现起一个，真机靠附着到部署好的那台）。
   *
   * 与 `spawn-node` 分开是必要的：一大类场景（错 PSK 被拒、发一帧看回什么）
   * 的材料全在**发起方**手里，节点是什么配置根本不影响断言，它们要的只是
   * 「有一台活着的节点可以拨」。把它们一律写成 `spawn-node`，真机腿就会因为
   * 「不能按任意参数起节点」而跳掉本来完全跑得动的东西 —— issue #61 的另一面：
   * 那条腿一条 `raw-dial` 场景都没跑过，数据面零覆盖。
   */
  | 'attach-node'
  /**
   * 能按任意参数起一个全新常驻节点。
   *
   * 真机腿上这**不是**「重起那台内测节点」—— 那件事仍然禁止。它是「在一台
   * 舰队机器上，用那台机器上部署好的二进制，在一次性配置根里起一个属于本场景
   * 的节点，跑完杀掉并 `rm -rf`」。被测对象因此是**部署的产物 + 真机的内核与
   * 架构**，而配置根是场景自己挑的 —— 断言不必去赌部署配置。
   */
  | 'spawn-node'
  /**
   * 能按任意参数起一个全新控制台进程 **并直连它的 HTTP 面**（本地有，真机没有）。
   *
   * 与 `spawn-node` 分开，因为两者在真机腿上不足的理由不同：那边节点是部署好的，
   * 而控制台既是部署好的、又只经隧道可达，「起一个自己的控制台再打它的端口」
   * 在真机上两头都不成立。合并成一个能力会让真机腿的 skip 理由说不清是哪一半。
   */
  | 'spawn-console'
  /**
   * 能重启一个已有节点（配置根原样保留）。
   *
   * 两条腿都只对**自己起的**节点成立。真机腿附着来的那台内测节点永远不许重启：
   * 那会打断内测使用者，并在它的审计链上留下一次计划外中断。
   */
  | 'restart-node'
  /** 能改节点的环境变量 / 凭据文件后重启。 */
  | 'mutate-node-env'
  /** 能读节点上的文件（审计链、transcript、timings、pid）。 */
  | 'read-node-files'
  /** 能在节点侧跑一条 CLI（`qm audit --verify` 之类）。 */
  | 'exec-node-cli'
  /** 能对节点做帧级原始拨号（自带握手材料，两个目标都有）。 */
  | 'raw-dial'
  /** 能跑仓库自带的启动器脚本（`beta-up.sh` 等）。 */
  | 'run-launcher'
  /** 能对着一个可控的假模型上游跑（本地有；真机打真实端点）。 */
  | 'stub-upstream'
  /**
   * 能**在被测 CLI 所在的那台机器上**现造一套离线 CA 夹具：openssl + `qm ca`
   * 签出证书、`qm cert request` 造身份，外加一个注册中心来分发它们。
   *
   * 名字里的 `local` 指的是「与被测 CLI 同机」，**不是**「在 runner 上」——
   * 那正是这一维搬上真机时最容易搞反的一处。夹具必须与节点同机，因为
   * `--trust-ca` / `--cert` 收的是**那台机器上**的路径。
   *
   * 与 `exec-node-cli` 分开，是因为这条比「能在目标机上跑一条 CLI」多要两件
   * 事，缺哪一件都跑不完整条链：
   *
   *   ① **能预留将来那个节点的配置根**（{@link NodeSpec.configRoot}）——
   *      `--cert` 那两条场景的证书绑的是节点自己的 Ed25519，而那把钥匙必须
   *      在起节点**之前**就落在那个根里；
   *   ② **能把目标机上的产物读回 runner**（{@link ExecHost.readFile}）——
   *      拨号与注册中心登记发生在 runner 上，证书 PEM、吊销清单、对端私钥
   *      都得回来。
   */
  | 'local-ca-fixture'
  /**
   * 能观察「审计镜像的**搬运**那一半」：控制台机器上的定时器、拉取服务的
   * 退出码、镜像文件本身，以及源节点上的权威副本。
   *
   * 真机腿有（四条 `qianmo-mirror@<节点>` user-scope 单元 + 隧道 + 两台机器）；
   * 本地腿一台机器、没有隧道、没有单元文件，三个前提一个都不成立 —— 那正是
   * `audit/mirror-pull-not-constructible` 在本地腿 skip 的**正当**理由。
   *
   * 单独成一项能力而不是挂 `read-node-files`：这条要读的是**控制台主机**上的
   * 东西，而驱动此前根本没有「控制台主机」这个概念（issue #62）。
   */
  | 'mirror-transport'
  /**
   * 能读**本仓库源码**（静态断言用，两个目标都有）。
   *
   * 少数场景断言的是「代码里只有一处按 trust 分支」「NoticeTrust 是两值封闭
   * 联合」这类**代码形状**，不需要任何被测进程。它们仍要声明能力而不是留空
   * `requires`：留空会让「忘了写 requires」和「确实不需要能力」在表自检里
   * 长得一模一样。
   */
  | 'read-repo-source'

/** 场景执行结果（写进 NDJSON 的那一行）。 */
export interface ScenarioResult {
  readonly id: string
  readonly dimension: Dimension
  readonly title: string
  readonly target: Target
  readonly outcome: Outcome
  readonly durationMs: number
  /** 期望行为，一句话。红的时候人读的就是这句和 `actual` 的差。 */
  readonly expected: string
  /** 实际观察到的行为。 */
  readonly actual: string
  readonly evidence: readonly Evidence[]
  /**
   * 这条 `error` 是**什么类的** error（issue #96 ③）。
   *
   * `transport` = 套件到目标机的 SSH 链路失败，远端命令一行都没执行到。它和
   * 「被测系统答错了」是两件事：那一轮唯一的红是 `mktemp -d` 撞上一次 gcloud
   * IAP 隧道 EOF，栈停在开一次性目录那一步，`beta-up.sh` 一行都没跑到 ——
   * 它不可能是在回答那条场景的问题。
   *
   * **它不改判定。** `pass` 的算法一个字不动，带这个标记的 `error` 照样把整轮
   * 判红。它存在只是为了让 `jq` 与汇总表把链路噪声和产品结论**分开数** —— 分不
   * 开的后果是这类红被整批当成「套件不稳」而加豁免，那才是套件失去可信度的路径。
   *
   * 只在 `outcome === 'error'` 上出现；缺省不写这个键，本地腿的产物逐字节不变。
   */
  readonly errorKind?: 'transport'
  /** `skip` 时必填：为什么跳过（缺哪个能力 / 被 filter 排除）。 */
  readonly skipReason?: string
  /**
   * 已知缺陷编号（如 `#44`）。
   *
   * **这不是豁免。** 挂了编号的场景照样按 `fail` 计，只是在汇总表里标出来，
   * 让读的人知道这条红是已被记录的缺陷而不是新回归。把已知缺陷改判成 pass
   * 就等于让套件对自己要抓的东西闭眼。
   */
  readonly knownIssue?: string
  /** 场景自己声明的、这次实际用到的能力（便于复盘覆盖面）。 */
  readonly requires: readonly DriverCapability[]
  /**
   * 这条场景实际调用过的驱动方法名，按调用顺序，含重复。
   *
   * **这是「它到底有没有碰过目标」的唯一凭据**，由 runner 用
   * {@link instrumentDriver} 自动采集，场景写不了也改不了它。空数组有两种
   * 合法情形（`read-repo-source` 那类静态断言、以及被 skip 的场景），除此
   * 之外的空数组就是一条声明了能力却绕过驱动的场景 —— issue #61 那次假绿
   * 里 11 条绿全部是这个形态。
   */
  readonly driverCalls: readonly string[]
}

/** 场景返回给 runner 的东西 —— 判定 + 证据，不含 id/耗时这些框架字段。 */
export interface ScenarioOutcome {
  /** 断言是否成立。 */
  readonly ok: boolean
  readonly actual: string
  readonly evidence: readonly Evidence[]
  /**
   * 场景自己要求跳过（例如探测到本目标上这条链路根本没部署）。
   * 置了就覆盖 `ok`，记成 `skip`。
   */
  readonly skip?: string
}

/** 场景定义。 */
export interface Scenario {
  /** 稳定 id，形如 `handshake/psk-ok`。NDJSON 的主键，不要改。 */
  readonly id: string
  readonly dimension: Dimension
  readonly title: string
  readonly expected: string
  readonly requires: readonly DriverCapability[]
  readonly knownIssue?: string
  /** 单场景超时，缺省取 runner 的默认值。超时记 `error` 不记 `fail`。 */
  readonly timeoutMs?: number
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>
}

/** 场景运行上下文。每个场景一份，互不共享。 */
export interface ScenarioContext {
  readonly driver: AcceptanceDriver
  /** 本场景专属的临时目录，runner 负责创建与清理。 */
  readonly workdir: string
  /** 分配一个当前空闲的 TCP 端口。 */
  allocPort(): Promise<number>
  /** 登记一个清理动作，runner 在 `finally` 里逆序执行（超时也会跑）。 */
  cleanup(fn: () => void | Promise<void>): void
  /** 结构化日志，只进 NDJSON 的 `log` 字段，不污染汇总表。 */
  log(line: string): void
  /** 中止信号：超时时 abort，长等待应当监听它。 */
  readonly signal: AbortSignal
  /**
   * 本轮的超时倍率 —— 与 runner 拿去乘场景预算的**是同一个数**。
   *
   * 存在的理由：倍率机制（`FLEET_TIMEOUT_SCALE`、`--timeout-scale`）此前只作用
   * 于场景预算，够不到**驱动内部**那些自己 `Date.now() + X` 的等待。于是在真机
   * 腿或忙 runner 上，驱动的硬等待会先于场景预算炸掉，而那种红记的是 `error`
   * （「套件自己炸了」）而不是那条场景本来要说的话 —— 恰好是会被人当成「套件
   * 不稳」而加豁免的那类噪声（issue #85 ②，与 PR #69 同一条纪律）。
   *
   * **凡是驱动内部按墙钟等的地方都要乘它**，别再引一个自己的常数：`runner` 是
   * 倍率的唯一出处，`--timeout-scale` 压过 `--target fleet` 的默认值这件事只在
   * 那一处决定，多一份就会有一份跟不上。缺省 1。
   */
  readonly timeoutScale: number
}

// ---------------------------------------------------------------------------
// 驱动层
// ---------------------------------------------------------------------------

/** 一个常驻节点的启动参数（驱动无关的那部分）。 */
export interface NodeSpec {
  /** 节点名，落到 `qianmo://<name>/<agent>` 的第一段。 */
  readonly name: string
  /** agent 名 → 工作区绝对路径。至少一项。 */
  readonly agents: Readonly<Record<string, string>>
  /** 握手认证档：`psk` / `signature` / `credential_signature`。 */
  readonly auth: AuthSpec
  /** 任务策略：开放 / 要求签名任务。 */
  readonly policy: 'open' | 'signed-task'
  /**
   * 一个策略开关都不给（测「默认档位是什么」以及那条未选警告）。
   *
   * 单独成字段而不是让 `policy` 多一个取值：`policy` 是**期望的运行档位**，
   * 场景后面的断言都按它写；这一条问的是**命令行给没给**，两件事。
   */
  readonly omitPolicyFlag?: boolean
  /** 信任的签发者公钥（PEM / base64，按 {@link AuthSpec} 的约定）。 */
  readonly trust?: readonly string[]
  /** 是否要求唤醒签名。 */
  readonly wakeSign?: boolean
  /** 额外环境变量（模型端点、假上游地址等）。 */
  readonly env?: Readonly<Record<string, string>>
  /** 额外 CLI 参数，给场景开后门用，慎用。 */
  readonly extraArgs?: readonly string[]
  /**
   * 节点配置根在**目标机上**的绝对路径。不给就由驱动自己开一个一次性的。
   *
   * ## 为什么它必须存在（`local-ca-fixture` 卡在这里）
   *
   * 证书这一维有两条场景要给节点 `--cert` / `--key`，而 K-2 的启动检查要求
   * 那张证书绑的是**本节点自己**配置根里的那把 Ed25519。于是顺序是死的：
   * 先在某个根里 `qm cert request` 造出身份与 CSR、签出证书，**再**用同一个
   * 根把节点起起来。驱动自己现开配置根的话，那个根要等 `startNode` 之后才
   * 存在，而 `--cert` 必须在启动时就给 —— 两件事对不上，这一维就搬不动。
   *
   * 拿到这个路径的正经方式是 {@link AcceptanceDriver.execHost}：那个执行位
   * 的 `configDir` 与 `workdir` 都在目标机上，签发链跑在它上面，签完把
   * `configDir` 交给这里，节点就复用同一个根起来了。
   *
   * **只对驱动自己起的节点有意义。** 真机腿的附着分支拿到的是内测节点的生产
   * 配置根，这个字段在那里一律忽略 —— 换掉它就等于「另起一个节点」，而附着
   * 分支根本不起进程。
   */
  readonly configRoot?: string
  /**
   * 只要**一台活着的节点**，配置怎样都行 —— 与 `attach-node` 能力配对的那个信号。
   *
   * 驱动看不到场景的 `requires`，所以「我需要一台现成的节点」这件事必须由
   * 规格自己说出来。真机驱动据此分岔：置了就**附着到部署好的那台**（错 PSK
   * 被拒这类场景的材料全在发起方手里，节点配置不影响判定，而打生产节点正是
   * 这条腿的意义）；不置就在一台舰队机器上起一个**一次性节点**。
   *
   * 本地驱动一律照常起新节点 —— 那边「现成的节点」和「新起的节点」没有区别。
   *
   * **不要为了让真机腿跑得快而给普通场景置上它**：附着来的节点是内测在用的
   * 那台，它的 policy / trust / 审计链都不是场景挑的，断言会变成在赌部署配置。
   */
  readonly attach?: boolean
}

export type AuthSpec =
  | { readonly mode: 'psk'; readonly psk: string }
  | { readonly mode: 'signature'; readonly keyDir: string }
  | { readonly mode: 'credential_signature'; readonly keyDir: string }

/** 已启动节点的句柄。 */
export interface NodeHandle {
  readonly name: string
  readonly spec: NodeSpec
  /** 传输层监听地址，形如 `ws://127.0.0.1:38625`（真机是隧道后的地址）。 */
  readonly endpoint: string
  /**
   * 从**节点自己那台机器**上拨它的地址。本地腿与 {@link endpoint} 相同。
   *
   * 真机腿上两者不同，而且差别是承重的：`endpoint` 是 runner 这侧隧道口，
   * 只有 runner 拨得通；节点机器上的 `qm resident-wake` 要拨的是它自己的
   * 回环口。把 `endpoint` 交给 {@link AcceptanceDriver.execHost} 上跑的命令，
   * 表现是连不上 —— 而那条红读起来像投递链路坏了。
   */
  readonly hostEndpoint: string
  /** 节点配置根（`.../config/qianmo`），审计链与身份都在它下面。 */
  readonly configRoot: string
  /** 进程 stderr 的累计内容（本地驱动实时收集，真机驱动按需拉取）。 */
  stderr(): Promise<string>
  stdout(): Promise<string>
  /** 进程是否还活着。 */
  alive(): Promise<boolean>
}

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * **目标机上**跑一条一次性 CLI 的位置：一次性配置根 + 一次性工作目录。
 *
 * ## 为什么它必须存在（issue #61 第 1 条）
 *
 * 有 7 条场景做的是同一件事：**拿一组故意写坏的参数起一次 `qm`，看它在解析期
 * 或启动期拒不拒**。它们声明了 `exec-node-cli`，然后调 runner 本地的
 * `runCli()` —— 于是在真机腿上照样在开发机上 spawn，`requires` 纯属装饰。
 * 而 {@link AcceptanceDriver.execNode} 又用不了：它把 `OCC_CONFIG_DIR` 钉在
 * 那条节点的**生产配置根**上。
 *
 * ## 与 {@link AcceptanceDriver.execNode} 的分工是硬的，不要合并
 *
 * | | 配置根 | 给谁用 |
 * | --- | --- | --- |
 * | `execNode` | 节点的**生产根** | `qm audit --verify` 这类**必须读那条节点自己的链**的场景 |
 * | `ExecHost` | 一次性根，跑完删 | 「参数写坏了该拒绝」这类**与配置根内容无关**的场景 |
 *
 * 拿生产根跑第二类是不可以的，三条理由：
 *
 *   ① 那些命令会在配置根下**生成身份密钥**（`qm console --print-wake-identity`
 *      的全部作用就是这个），等于往四台内测节点的身份目录里塞验收产物，其中
 *      一把还是控制面凭据；
 *   ② 生产根下的审计链是**成果边界证据**，任何一次计划外写入都会在链上留下
 *      一条没人解释得清的记录；
 *   ③ 用一次性根**不削弱**这条腿的价值 —— 这些场景断言的是「部署在真机上的
 *      那个 `dist/cli-node.js`、在真机的架构与内核上、对这组参数怎么反应」，
 *      被测对象是那个二进制和那台机器，不是配置根里装了什么。
 */
export interface ExecHost {
  /** 人可读的位置标识（`runner (local)` / `cornna-p12 (beta-4)`），进证据用。 */
  readonly describe: string
  /** 一次性配置根在**目标机上**的绝对路径（喂 `OCC_CONFIG_DIR`）。 */
  readonly configDir: string
  /** 一次性工作目录在**目标机上**的绝对路径（放输入文件、agent 工作区）。 */
  readonly workdir: string
  /**
   * 跑一条**会结束**的 `qm` 子命令。
   *
   * `opts.configDir` 换掉这一条命令的 `OCC_CONFIG_DIR`（缺省是
   * {@link ExecHost.configDir}）。一条离线 CA 的签发链要同时用到**三个**根：
   * 跑 `qm ca` 的工具根、对端的身份根、将来那个节点自己的根 —— 一个执行位
   * 一个固定根的话，这三件事得开三个执行位（真机上就是三层一次性目录 + 三次
   * `rm -rf`），而它们本来就该在同一台机器的同一棵树里。
   */
  exec(
    argv: readonly string[],
    opts?: {
      readonly env?: Readonly<Record<string, string>>
      readonly timeoutMs?: number
      readonly configDir?: string
    },
  ): Promise<ExecResult>
  /**
   * 在目标机上跑一条**不是 `qm`** 的命令。
   *
   * 存在的理由只有一个：`qm ca` 的签发链外挂 openssl，而这一维有两件事
   * `qm` 自己不做 —— 探 openssl 版本，以及签一张**已经过期**的证书
   * （`qm ca issue --days` 走 `positiveInteger`，最短一天，签不出过去的）。
   * 这两件事都必须发生在**被测 CLI 所在的那台机器**上，因为签出来的东西要
   * 喂给那台机器上的节点。
   *
   * 与 {@link LauncherHost.run} 同形（那边跑的是 `bash`），不是新开的口子。
   */
  run(
    argv: readonly string[],
    opts?: {
      readonly env?: Readonly<Record<string, string>>
      readonly timeoutMs?: number
    },
  ): Promise<ExecResult>
  /** 在目标机上写一个文件（相对 {@link workdir}），返回它在目标机上的绝对路径。 */
  writeFile(relPath: string, content: string): Promise<string>
  /** 在目标机上建一个目录（相对 {@link workdir}），返回绝对路径。 */
  mkdir(relPath: string): Promise<string>
  /**
   * 读目标机上的一个文件；绝对路径直接读，相对路径按 {@link workdir} 解析。
   * 不存在返回 undefined（**不要**抛）。
   *
   * 签发链把证书、吊销清单、身份密钥都落在目标机上，而拨号与注册中心登记发生
   * 在 runner 上 —— 没有这一步，材料就永远停在另一台机器上。
   */
  readFile(pathOrRelPath: string): Promise<string | undefined>
  /**
   * 目标机上此刻**没有人在听**的一个 TCP 端口。
   *
   * 注意它保证的只有「现在没人听」，不是「我把它占住了」——
   * 用它的场景要么根本不 bind（解析期就该被拒），要么正好要一个拨不通的口。
   */
  freePort(): Promise<number>
}

/**
 * 跑仓库自带启动器脚本（`common.sh` / `beta-up.sh`）的位置。
 *
 * ## 真机腿跑**哪一份**脚本：部署机上的那一份（issue #65 第 2 块）
 *
 * 两个答案测的是不同的东西，这里选的是前者：
 *
 * | 选哪份 | 那一轮回答的问题 |
 * | --- | --- |
 * | **部署机上的**（本实现） | 「运维此刻手上那份脚本，在那台机器的 bash 上，行为对不对」 |
 * | 本分支推过去的 | 「这次改动在真 Linux bash 上行为对不对」 |
 *
 * 选前者的三条理由：
 *
 * ① **与这条腿其余部分一致。** 真机腿从头到尾验的是**部署产物**（那个
 *    `dist/cli-node.js`、那台机器的内核与架构），启动器换成分支版本，同一份
 *    报告里就会有两种「被测对象」，而读的人分不出哪条是哪种。
 * ② **这一维要抓的差异正好在部署侧。** 它来自 issue #38/#40：`bun` 装在
 *    `~/.bun/bin`、非交互 SSH 解析不到 —— 那是一条**部署环境**的事实，
 *    开发机上的 bash 3.2 复现不出来。
 * ③ **推分支版本在机制上也不成立。** `common.sh` 的 `REPO_DIR` 由
 *    `BASH_SOURCE[0]` 往上三级推出，脚本必须待在一棵完整的仓库树里；往部署
 *    检出里写文件是污染部署，而在别处造一棵树又得把 `demo/` 软链回部署检出
 *    —— 绕一圈跑的还是那一份。
 *
 * **代价要说清**：分支上改了启动器脚本，真机腿在重新部署之前看不见。那不是
 * 盲区，那正是这条腿要报的事实 —— 「部署上去的还是旧的」。分支侧的守护由
 * `demo/env/*.test.ts` 那几个单测负责，它们进 CI。
 */
export interface LauncherHost {
  /** 人可读位置（`runner (local)` / `cornna-p3 (aarch64)`），进证据用。 */
  readonly describe: string
  /**
   * 启动器脚本所在的仓库根**在目标机上**的绝对路径。
   *
   * 保证 `demo/env/beta/*.sh` 是**真脚本**，且 `dist/cli-node.js` 存在
   * （`beta_require_occ` 过得去）—— 本地腿靠一棵软链镜像树满足后半条，
   * 真机腿本来就满足。
   */
  readonly repoDir: string
  /** 一次性 `QIANMO_BETA_ROOT`（`run/` 与 `logs/` 已建好）。 */
  readonly betaRoot: string
  /** 一次性工作目录（放假 `bun`、日志等）。 */
  readonly workdir: string
  /** 写一个文件（相对 {@link workdir}），返回目标机上的绝对路径。 */
  writeFile(
    relPath: string,
    content: string,
    options?: { readonly mode?: string },
  ): Promise<string>
  /** 直接跑一条命令（`argv[0]` 通常是 `/bin/bash`）。 */
  run(
    argv: readonly string[],
    options?: {
      readonly env?: Readonly<Record<string, string>>
      readonly timeoutMs?: number
    },
  ): Promise<ExecResult>
  /** 目标机上这条绝对路径存不存在。 */
  exists(absPath: string): Promise<boolean>
  /** 读目标机上的一个文件；不存在返回 undefined（**不要**抛）。 */
  readFile(absPath: string): Promise<string | undefined>
}

/**
 * 一次性注册中心的启动参数。
 *
 * **注册中心不是可选的门面** —— `console/*` 的每条场景都要它：控制台的
 * `/v0/agents` 是往注册中心的代理，没有它那些断言测的就只是一个 502。
 */
export interface RegistrySpec {
  /** 打开落盘（`FileRegistryStore`）。持久化是 opt-in，与产品一致。 */
  readonly persist?: boolean
  /** 租约 TTL；不给就是 `DEFAULT_TTL_MS`。短 TTL 用来测过期。 */
  readonly ttlMs?: number
  /**
   * 写 token（tenancy-m1.md P15.8）。给了，注册中心的写操作不带它就 401；
   * 不给就是零鉴权，与产品缺省一致。重启沿用同一枚。
   */
  readonly writeToken?: string
}

/** 一个一次性注册中心。 */
export interface AcceptanceRegistry {
  /** **runner 侧**可达的基址 —— 场景自己打它用这个。 */
  readonly url: string
  /**
   * **控制台那台机器上**可达的基址 —— 喂 {@link ConsoleSpec.registryUrl} 用这个。
   *
   * 本地腿两者相同。真机腿上控制台在另一台机器上，它拨的是一条反向隧道的
   * 入口；把 `url` 喂给它等于让那台机器去打它自己的某个端口。
   */
  readonly hostUrl: string
  /**
   * 落盘文件的内容；没开持久化、或还没落盘，就是 undefined（**不要**抛）。
   *
   * 是方法而不是路径，因为「盘在哪台机器上」由驱动决定：场景拿到路径也读不了。
   */
  readState(): Promise<string | undefined>
  /**
   * 停掉，再在**同一个端口**上按同一份 {@link RegistrySpec} 起一张新表。
   *
   * 没开持久化时新表是空的 —— 与「注册中心停机超过一个 TTL 后重启」是同一个
   * 结果（`#restore` 按当下时钟重判租约，过期的一条不留），省掉真等那么久。
   * 端口不变是承重的：控制台的 `--registry` 是启动时定下的，换口就等于换了一个
   * 注册中心，测的不再是「它重启了」。
   */
  restart(): Promise<void>
}

/** 一次性控制台的启动参数（驱动无关的那部分）。 */
export interface ConsoleSpec {
  /** 注册中心地址 —— 传 {@link AcceptanceRegistry.hostUrl}。 */
  readonly registryUrl: string
  /** `--wake-url <node>=<ws url>`，可多条。URL 要用节点的 `hostEndpoint`。 */
  readonly wakeTargets?: readonly {
    readonly node: string
    readonly url: string
  }[]
  readonly signWakes?: boolean
  /** 每个唤醒目标的 PSK；键是节点名。 */
  readonly wakePsk?: Readonly<Record<string, string>>
  /** 显式 token（经环境变量给，与产品的第二优先级入口一致）。 */
  readonly viewToken?: string
  readonly adminToken?: string
  readonly extraArgs?: readonly string[]
}

/** 一个跑着的一次性控制台。 */
export interface AcceptanceConsole {
  /** `http://127.0.0.1:<port>`，**runner 侧**可达，不带 token。 */
  readonly url: string
  readonly viewToken: string
  readonly adminToken: string
  /** 配置根**在目标机上**的绝对路径。 */
  readonly configRoot: string
  /** 启动 banner 原文（stdout）。 */
  banner(): Promise<string>
  stderr(): Promise<string>
  /**
   * 停掉这个控制台进程（先 TERM，宽限后 KILL）。幂等；清理照样会再跑一次。
   *
   * 场景要它，是因为控制台会替自己注册的条目续租：要看「没人续租时租约到期」，
   * 或者「用同一个配置根重起后登记簿把条目带回来」，都得先让这一个停下。
   */
  stop(): Promise<void>
}

/**
 * 一个**还没起**的控制台位：配置根已经开好，进程还没起。
 *
 * 两步分开不是为了对称，是因为 `console/wake-sign-round-trip` 必须这么走：
 * 先用这个配置根跑 `qm console --print-wake-identity` 把公钥印出来（那一步
 * **不起服务器、不读 token**，正是分发公钥的那一刻），把公钥交给目标节点的
 * `--trust`，**然后**才带 `--wake-sign` 把控制台起起来。顺序反了会得到
 * `E_CAP_INVALID: no published public key for issuer console`。
 *
 * 它同时是一个 {@link ExecHost}，于是 `--audit <节点>=<路径>` 要的那些文件
 * 也能落在**控制台那台机器**上 —— 场景 workdir 在 runner 上，真机腿指过去
 * 是一条不存在的路径。
 */
export interface ConsoleSlot extends ExecHost {
  start(spec: ConsoleSpec): Promise<AcceptanceConsole>
}

/**
 * 在哪台机器上开这个一次性执行位置。
 *
 * 不给就由驱动挑（真机驱动在舰队里轮转，本地驱动只有一台机器）。
 */
export interface ExecHostWhere {
  /**
   * 与这个节点句柄**同一台机器**。
   *
   * 给它的场景都是「命令要拨到这个节点」的那一类（`qm resident-wake`）——
   * 那种命令必须和节点落在同一台机器上，然后拨 {@link NodeHandle.hostEndpoint}。
   * 落在别处就得穿隧道，而隧道只在 runner 那一侧存在。
   */
  readonly sameMachineAs?: NodeHandle
  /**
   * 这个执行位要给本场景**还没起**的一次性节点当夹具位（配置根、CA 目录、
   * 证书文件都放在它下面），所以必须落在**本场景起节点的那台机器**上。
   *
   * 与 {@link ExecHostWhere.sameMachineAs} 分开，因为那个要一个已经存在的
   * 句柄，而这里节点还不存在 —— 「先造材料再起节点」正是证书这一维的固定顺序
   * （见 {@link NodeSpec.configRoot}）。
   *
   * 不置的话真机驱动会在四台内测节点之间轮转，于是 `--trust-ca` 指向的是
   * **另一台机器**上的一条路径：节点起来了、证书目录空着，每一次 CA 握手都以
   * `unknown_signer` 收场 —— 而现场看起来像证书签错了。
   */
  readonly forNodeSpawn?: boolean
}

/** 原始拨号的结果 —— 帧级探针要看的全部东西。 */
export interface DialProbe {
  /** 握手是否走完。 */
  readonly authed: boolean
  /** 连接被关闭时的 code（4003 / 4004 / 1000 …），没关就是 undefined。 */
  readonly closeCode?: number
  /** 关闭原因原文。 */
  readonly closeReason?: string
  /** 收到的全部帧（原文 JSON 串，按到达顺序）。 */
  readonly frames: readonly string[]
  /** 拨号过程中的异常原文。 */
  readonly error?: string
}

/** 原始拨号参数。故意允许构造非法材料 —— 这正是要测的东西。 */
export interface DialOptions {
  readonly auth: DialAuth
  /** 拨号方自称的节点名。缺省由驱动给一个探针名。 */
  readonly nodeName?: string
  /** 握手完成后再等多久收帧。缺省走 `rawDial` 的默认值。 */
  readonly settleMs?: number
  /** 握手成功后要发的帧（原样序列化发出，允许违反协议）。 */
  readonly send?: readonly unknown[]
  /** 不等握手完成就发（用来测 4003）。 */
  readonly sendBeforeAuth?: readonly unknown[]
  /** 收到几帧后主动关闭；缺省等服务端关或超时。 */
  readonly expectFrames?: number
  readonly timeoutMs?: number
}

export type DialAuth =
  | { readonly mode: 'psk'; readonly psk: string }
  | {
      readonly mode: 'signature'
      readonly nodeName: string
      readonly privateKeyPem: string
    }
  | {
      readonly mode: 'credential_signature'
      readonly nodeName: string
      readonly privateKeyPem: string
      readonly credential?: string
    }
  /** 完全不握手，直接发业务帧。 */
  | { readonly mode: 'none' }

/**
 * 一个被测端**自己报上来的**来源 commit（issue #70 ③）。
 *
 * 三个字段各有各的不可替代性：
 *
 * · `unit` —— 是谁在说话。舰队上同时有四台节点 + 一台控制台，它们完全可能
 *   停在不同的产物上（滚更新是一台一台滚的），合成一个值就把那件事抹掉了。
 * · `commit` —— **它说的原文**，40 位全 SHA / `<SHA>-dirty` / `unknown`，与
 *   `qm resident` 启动行和 `qm console` banner 里那个 `sourceCommit` 字段逐字
 *   相同。**取不到就是 `undefined`，不许拿 runner 自己的 HEAD 去填** —— 那个
 *   回退正是这条缺陷本身。
 * · `detail` —— 从哪儿读到的，或者为什么没读到。没有它，报告上那个「未知」
 *   分不出「日志被轮转掉了」「产物是 #74 之前构建的」「SSH 不通」。
 */
export interface TestedUnitProvenance {
  /** 被测端标识，如 `beta-1` / `console (workbench-iap)`。 */
  readonly unit: string
  /** 它自报的 `sourceCommit` 原文；拿不到就是 `undefined`。 */
  readonly commit?: string
  /** 读到的位置，或者没读到的原因原文。 */
  readonly detail: string
}

/**
 * 一轮运行里「**被测的**是哪一版」。
 *
 * 与 {@link SuiteRun.commit}（「**跑套件的**是哪一版」）是两件事，报告里两个
 * 都记。`target=local` 上被测对象就是本检出，两者恒等，于是本地驱动**不实现**
 * 这个探针 —— 那条腿的报告一字不变。
 */
export interface TestedProvenance {
  /** 逐个被测端的自报值。一个都问不到时是空表（**不要**抛）。 */
  readonly units: readonly TestedUnitProvenance[]
}

/**
 * 驱动层。本地与真机各一个实现，场景只认这个接口。
 *
 * 方法都可能抛；runner 会把抛出记成 `error` 并带上栈。驱动**不要**吞异常
 * 后返回一个「看起来正常」的值 —— 那会把套件变成永远绿的装饰品。
 */
export interface AcceptanceDriver {
  readonly target: Target
  readonly capabilities: ReadonlySet<DriverCapability>
  /**
   * 每个**没有**的能力为什么没有，一句话。runner 把它拼进 skip 理由。
   *
   * 没有它的时候，报告里那行只有「驱动 fleet 缺少能力: spawn-node」——
   * 读的人无从判断这是「这条腿天然做不到、如实跳过」还是「谁忘了实现」。
   * 两个驱动的头注里本来就写着这些理由，这个字段只是把它们送到报告里。
   */
  readonly capabilityGaps?: ReadonlyMap<DriverCapability, string>
  /** 起一个节点（真机驱动上是「附着到已有节点」，见各实现的注释）。 */
  startNode(ctx: ScenarioContext, spec: NodeSpec): Promise<NodeHandle>
  stopNode(node: NodeHandle): Promise<void>
  /**
   * 停掉再按（可覆盖的）同一份参数起回来。
   *
   * **配置根必须原样保留** —— 身份密钥、审计链、会话表都锚在它上面，换一个
   * 根就不是「重启」而是「另起一个节点」，恢复维度那三条断言全部失去意义。
   */
  restartNode(
    ctx: ScenarioContext,
    node: NodeHandle,
    overrides?: Partial<NodeSpec>,
  ): Promise<NodeHandle>
  /** 帧级原始拨号。 */
  dial(
    ctx: ScenarioContext,
    node: NodeHandle,
    opts: DialOptions,
  ): Promise<DialProbe>
  /** 读节点上的文件，不存在返回 undefined（**不要**抛，「不存在」是一种观察）。 */
  readNodeFile(node: NodeHandle, relPath: string): Promise<string | undefined>
  /**
   * 往节点配置根下写一个文件（整份覆盖），返回它**在目标机上**的绝对路径。
   *
   * 存在的理由是审计维度那三条篡改场景：它们要在盘上改掉一行再让
   * `qm audit --verify` 去发现。此前它们直接 `node:fs` 写 `node.configRoot`，
   * 而那条路径在真机腿上属于另一台机器 —— 于是它们只能靠 `requires` 里的
   * `spawn-node` 把自己挡在真机腿之外。挡不住的那一天就是下一次 issue #61。
   *
   * **写只对自己起的节点开放。** 附着来的内测节点上，驱动必须拒绝 —— 往生产
   * 配置根里写东西没有任何验收价值，只会污染那条链。
   */
  writeNodeFile(
    node: NodeHandle,
    relPath: string,
    content: string,
  ): Promise<string>
  /**
   * 改节点配置根下某个路径的权限位（八进制串，如 `'500'`）。
   *
   * 只有一条场景要它（把信箱目录设成可进不可写，看投递会不会如实报
   * `E_UNDELIVERABLE`）。窄接口是刻意的：一个「在节点机器上跑任意命令」的
   * 出口会让场景绕开能力表，而能力表是这套件唯一的诚实机制。
   */
  setNodePathMode(
    node: NodeHandle,
    relPath: string,
    mode: string,
  ): Promise<void>
  /** 列目录，不存在返回 undefined。 */
  listNodeDir(node: NodeHandle, relPath: string): Promise<string[] | undefined>
  /**
   * SIGKILL 掉一个节点 —— 制造「上一条命是被打断的」那种现场。
   *
   * 在接口上而不是只在本地驱动上，是因为 `recovery/lifecycle-records-hard-kill`
   * 此前把 `ctx.driver` 强转成 `LocalDriver` 去够它：那条转换在真机腿上会变成
   * 一次 `TypeError`，而 `requires` 里没有任何东西拦得住。
   */
  killNode(node: NodeHandle): Promise<void>
  /** 在节点侧跑一条 CLI（**生产配置根**，见 {@link ExecHost} 的对比表）。 */
  execNode(node: NodeHandle, argv: readonly string[]): Promise<ExecResult>
  /**
   * 一轮跑完把驱动**跨场景**占着的东西收干净（issue #100）。
   *
   * 目前只有真机驱动有：SSH 连接复用的 master 是一条**到生产机的活会话**，跑完
   * 还挂着几条不可接受，而它按定义活得比任何单条场景长 —— `ctx.cleanup` 那条
   * 场景级的路子够不着它。
   *
   * 可选：本地驱动没有这类资源，那条腿因此逐字节不变。调用方在入口的
   * `finally` 里跑它，于是场景抛异常、超时、判定失败都会走到。
   */
  dispose?(): Promise<void>
  /**
   * 读一次「审计镜像搬运」的现场。**只有声明了 `mirror-transport` 的驱动才
   * 实现它** —— 场景靠能力差集被 skip，走不到这里。
   */
  inspectMirrorTransport?(): Promise<MirrorTransportReport>
  /**
   * 在目标机上开一个**一次性**的 CLI 执行位置。
   *
   * 清理登记在 `ctx.cleanup` 上，runner 在 `finally` 里跑（超时也会跑）。
   * `where` 只用来在舰队里挑一台机器；本地驱动忽略它。
   */
  execHost(ctx: ScenarioContext, where?: ExecHostWhere): Promise<ExecHost>
  /**
   * 起一个一次性注册中心。清理挂 `ctx.cleanup`。
   *
   * 声明了 `spawn-console` 的场景才走得到这里。
   */
  startRegistry(
    ctx: ScenarioContext,
    spec?: RegistrySpec,
  ): Promise<AcceptanceRegistry>
  /** 开一个一次性控制台位（配置根先有，进程后起）。见 {@link ConsoleSlot}。 */
  consoleSlot(ctx: ScenarioContext): Promise<ConsoleSlot>
  /** 开一个跑启动器脚本的位置。见 {@link LauncherHost}。 */
  launcherHost(ctx: ScenarioContext): Promise<LauncherHost>
  /**
   * 问被测端「你是从哪个 commit 构建的」（issue #70 ③）。
   *
   * **只有被测对象在别处的驱动才实现它。** 本地腿被测的就是这棵检出，报告上
   * 那个 commit 本来就是被测端的 commit，再问一遍只会在同一份报告里印两个
   * 恒等的值；所以 `LocalDriver` 故意不实现，`target=local` 的产物一字不变。
   *
   * 整轮跑一次，在场景循环之外 —— 它回答的是「这一轮测的是哪一版」，不是
   * 任何一条场景的观察，因此**不计入 `targetTouches`**（那一项数的是场景）。
   *
   * **实现不许抛，也不许在拿不到时编一个值。** 问不到就把原因写进
   * {@link TestedUnitProvenance.detail} 并把 `commit` 留空：报告里那一栏写
   * 「未知」是正确答案，回退成 runner 的 HEAD 才是要修的那个缺陷。
   */
  testedProvenance?(): Promise<TestedProvenance>
}

/**
 * 一条节点的审计镜像搬运现场（issue #62）。
 *
 * 全部字段都是**观察**，不是判定 —— 取不到就是 `undefined`，由场景决定
 * 「取不到」意味着红还是跳过。驱动不许在这里替场景下结论。
 */
export interface MirrorTransportUnit {
  readonly node: string
  /** 控制台申报的最大滞后（分钟），从跑着的控制台命令行上读，不是常数。 */
  readonly maxLagMinutes?: number
  /** systemd 定时器上次触发的时间（目标机的表述原文，进证据用）。 */
  readonly lastTriggerAt?: string
  /** 同一个时刻的 Unix 秒，**由目标机自己换算**（见驱动里那段注释）。 */
  readonly lastTriggerSec?: number
  /** 上一次拉取服务的退出码。 */
  readonly serviceExitCode?: number
  /** 上一次拉取服务的 systemd `Result`（`success` / `exit-code` / …）。 */
  readonly serviceResult?: string
  /** 镜像文件在控制台机器上的路径。 */
  readonly mirrorPath?: string
  /** 镜像文件 mtime（Unix 秒，**控制台机器的钟**）。 */
  readonly mirrorMtimeSec?: number
  readonly mirrorBytes?: number
  /** 镜像文件的 md5。 */
  readonly mirrorHash?: string
  /** 源节点上权威副本的字节数。 */
  readonly authoritativeBytes?: number
  /**
   * 权威副本**前 `mirrorBytes` 个字节**的 md5。
   *
   * 比「整份哈希相等」更准：审计链是只追加的，两次采样之间源端完全可能又写
   * 了几条，那时整份哈希本来就该不同。前缀相等才是「搬对了」的不变式。
   */
  readonly authoritativePrefixHash?: string
  /** 权威副本整份的 md5（等号成不成立是留痕，不是承重断言）。 */
  readonly authoritativeHash?: string
  /** 采集时**控制台机器**的 Unix 秒 —— 算新鲜度必须用它，不是 runner 的钟。 */
  readonly observedAtSec?: number
  /** 采集过程的原文（命令输出），红了靠它排查。 */
  readonly raw: string
}

export interface MirrorTransportReport {
  /** 控制台主机的标识，进证据用。 */
  readonly consoleHost: string
  readonly units: readonly MirrorTransportUnit[]
  /** 采集本身失败时的原文（此时 `units` 可能是空的）。 */
  readonly failure?: string
  /**
   * 那台控制台 `GET /v0/health` 的状态码；探不到端口时 undefined。
   *
   * 它把「一条 `--audit` 申报都没有」拆成两件事：health 是 200 就是**控制台
   * 活着、这套部署确实没配镜像**（该 skip），不是 200 就是**控制台没在跑**
   * （该 fail）。此前这两者混在一起，于是一台挂掉的控制台会让镜像场景退化成
   * 一条 skip —— 报告上看起来像「没配」。
   *
   * 端口从**同一条 `ps` 行**上读，不写死 38621。`systemctl --user is-active`
   * 对 console/registry 两个单元都不可信（`Type=oneshot` + 只 enable 不 start，
   * 实测进程活着而单元报 inactive），别拿它当存活判据。
   */
  readonly consoleHealthStatus?: number
  /** 那台控制台申报的端口（从 `ps` 行读）。 */
  readonly consolePort?: number
}

/** 整轮运行的汇总（写进 NDJSON 的最后一行 + 汇总表表头）。 */
export interface SuiteRun {
  readonly target: Target
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly results: readonly ScenarioResult[]
  readonly counts: Readonly<Record<Outcome, number>>
  /**
   * 本轮**真正触达目标**的场景数：已执行（非 skip）且至少调用过一次驱动。
   *
   * 0 意味着这一轮关于被测目标什么都没证明 —— 见 {@link SuiteRun.pass}。
   */
  readonly targetTouches: number
  /**
   * 是否整体通过：无 `fail`、无 `error`，**且 `targetTouches > 0`**。
   * skip 不影响。
   *
   * 最后那一项是 issue #61 的直接产物：真机腿曾经在驱动零调用的情况下报出
   * `pass=11 fail=0 skip=104` 与 exit 0。一轮没碰过目标的运行不是「通过」，
   * 它是「没验」，而这两者对读报告的人必须长得不一样。
   */
  readonly pass: boolean
  /**
   * **跑套件那台机器**上的检出提交，便于把一份结果钉回代码。
   *
   * 注意它回答的是「套件是哪一版」。`target=fleet` 时**被测的是哪一版**是另一
   * 个问题，答案在 {@link SuiteRun.testedProvenance} 里 —— 两者可以完全无关
   * （issue #70）。
   */
  readonly commit?: string
  /**
   * 被测端自报的来源 commit。`target=local` 上是 `undefined`（被测对象就是这
   * 棵检出，`commit` 已经回答了）。见 {@link TestedProvenance}。
   */
  readonly testedProvenance?: TestedProvenance
}
