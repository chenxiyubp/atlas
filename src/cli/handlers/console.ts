// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `occ console` —— 阡陌控制面板的启动面（P11）。
 *
 *   OCC_IDENTITY=qianmo occ console
 *   OCC_IDENTITY=qianmo occ console --registry http://127.0.0.1:38610 \
 *     --wake-url ws://127.0.0.1:38611
 *
 * 这个文件只做三件事：解析参数（委给 `consoleArgs.ts`）、把五个端口的生产实现
 * 注进 `ConsoleDeps`（委给 `consolePorts.ts`）、把服务起起来并把人需要的几行
 * 字打到 stdout。**面板的行为一点都不在这里**——路由、鉴权、渲染全在
 * `@qianmo/console` 包里，那是它能被单测的原因。
 *
 * 范围依据：roadmap M1「注册发现产品化」——「最小 Web 控制台（智能体列表、
 * 状态、消息链查看）」，出口判据「内测用户无需接触 CLI 即可完成注册与查看」。
 * 文档见 `docs/dev/console.md`。
 */

import { randomBytes } from 'node:crypto'
import { invokedBinName } from '../../constants/brand.js'
import { sourceCommit } from '../../constants/buildProvenance.js'
import {
  AccountBook,
  resolveTokens,
  startConsoleServer,
  tokenFingerprint,
  type ConsoleAccounts,
  type ConsoleAuditSource,
  type ConsoleDeps,
  type RegistryPort,
  type WakeTarget,
  type WakePort,
} from '@qianmo/console'
import { readRegistryWriteTokenFile } from '@qianmo/registry'
import { pskFromEnv } from '@qianmo/transport'
import {
  createConsoleChatPort,
  type ConsoleChatEndpoint,
  type ConsoleChatHub,
} from './consoleChat.js'
import {
  CONSOLE_HELP_TEXT,
  assertConsoleRuntime,
  consoleRegistrationsPath,
  isConsoleHelpRequest,
  parseConsoleArgs,
  transportPskEnvVarForNode,
  type ConsoleCliConfig,
} from './consoleArgs.js'
import {
  consoleLimits,
  createCertificatePort,
  createRegistryPort,
  createServerNotesPort,
  createWakePort,
} from './consolePorts.js'
import { ConsoleRegistrations } from './consoleRegistrations.js'
import { ServerNotesStore } from './consoleServerNotes.js'
import { consoleAuditSources } from './consoleAuditSources.js'
import { readTrustAnchors } from '../../services/qianmo/trustAnchors.js'
import {
  loadConsoleWakeIdentity,
  type ConsoleWakeIdentity,
} from './consoleWakeIdentity.js'
import { resolveConsoleTokenSource } from './consoleTokenSources.js'
import { FileLedger } from './consoleAccountsStore.js'

/**
 * 32 个 base64url 字符，远在 `MIN_TOKEN_LENGTH`（16）之上。
 *
 * 导出是为了让 `consoleTokens.test.ts` 能把「CLI 生成的 token 满足包这一侧的
 * 下限」钉住——`resolveTokens` 对生成出来的 token 一视同仁地校验长度，所以一个
 * 太短的 generator 会变成启动失败，而那种失败只在真起控制台时才看得见。
 */
export function newConsoleToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * 个人账号的接线（`tenancy-m1.md` §3，P15.3 / P15.5）：配置根里的两本账——账号库
 * 与会话表。
 *
 * 账坏了**不让控制台起不来**：两枚旧 token 还得能进来看是怎么回事，所以账本
 * 自己转为不可用（个人账号一律 503），告警写到 stderr，横幅上照直写出原因。
 */
function wireConsoleAccounts(config: {
  readonly accountsStorePath: string
  readonly sessionsStorePath: string
  readonly legacyViewToken: boolean
  readonly breakGlass: boolean
}): ConsoleAccounts {
  const book = new AccountBook({
    accounts: new FileLedger(config.accountsStorePath),
    sessions: new FileLedger(config.sessionsStorePath),
    onAlarm: line => {
      process.stderr.write(`${line}\n`)
    },
  })
  return {
    book,
    legacyView: config.legacyViewToken,
    breakGlass: config.breakGlass,
  }
}

/** IPv6 字面量要加方括号才能进 URL。 */
function httpOrigin(hostname: string, port: number): string {
  const bracketed =
    hostname.includes(':') && !hostname.startsWith('[')
      ? `[${hostname}]`
      : hostname
  return `http://${bracketed}:${port}`
}

/** 唤醒面的接线结果：端口本身，外加一句给人看的原因。 */
interface ConsoleWakeWiring {
  readonly legacy?: { readonly port: WakePort; readonly url: string }
  readonly targets?: readonly WakeTarget[]
  readonly status: string
  /** 只有 `--wake-sign` 打开时才有；横幅要把公钥打出来。 */
  readonly identity?: ConsoleWakeIdentity
}

/** Narrow production seam for proving named target PSK selection. */
interface ConsoleWakeDependencies {
  readonly pskFromEnv: (variable?: string) => string
  readonly createWakePort: (options: {
    readonly url: string
    readonly psk: string
    readonly capability?: ConsoleWakeIdentity['issue']
  }) => WakePort
  /**
   * 可注入，只为让接线用例不去碰真实配置根——**默认实现会在磁盘上创建一把私钥**，
   * 而那正是它只在 `--wake-sign` 打开时才被调用的原因。
   */
  readonly loadIdentity?: (chatFrom: string) => ConsoleWakeIdentity
}

/**
 * 唤醒面要**两个**条件同时成立：给了 `--wake-url`，且环境里有一把可用的 PSK。
 *
 * 缺任何一个都不注入这个端口，而不是注入一个必定失败的：`ConsoleDeps.wake`
 * 留空时页面把唤醒表单渲染成禁用并说明原因（`deps.ts` 的注释），那比一个按下去
 * 永远报错的按钮诚实。PSK 只从环境变量取，不给命令行选项——命令行上的密钥就是
 * 这台机器每一份进程列表里的密钥，和 `--backup-url` 那条同一个理由。
 */
export function wireConsoleWake(
  config: Pick<ConsoleCliConfig, 'wakeTargets' | 'signWakes' | 'chatFrom'>,
  dependencies: ConsoleWakeDependencies = { pskFromEnv, createWakePort },
): ConsoleWakeWiring {
  if (config.wakeTargets.length === 0) {
    return { status: 'disabled (no --wake-url)' }
  }

  // 身份只在真要签名时读出来（首次运行会创建）。一个从不签名的控制台不该在配置根
  // 里留下一把没人用的私钥，`--print-wake-identity` 才是「我只想看看公钥」那条路。
  const identity =
    config.signWakes === true
      ? (dependencies.loadIdentity ?? loadConsoleWakeIdentity)(config.chatFrom)
      : undefined

  const targets: WakeTarget[] = config.wakeTargets.map(target => {
    const variable = target.legacy
      ? undefined
      : transportPskEnvVarForNode(target.node)
    try {
      const psk =
        variable === undefined
          ? dependencies.pskFromEnv()
          : dependencies.pskFromEnv(variable)
      return {
        node: target.node,
        url: target.url,
        wake: dependencies.createWakePort({
          url: target.url,
          psk,
          ...(identity === undefined ? {} : { capability: identity.issue }),
        }),
      }
    } catch {
      return {
        node: target.node,
        url: target.url,
        // `error.message` belongs to a secret boundary. Keep it out of the
        // startup banner and page even when a custom transport reports a key.
        unavailableReason: 'PSK unavailable',
      }
    }
  })

  const enabled = targets.filter(target => target.wake !== undefined)
  const status = targets
    .map(target =>
      target.wake === undefined
        ? `${target.node} disabled (${target.unavailableReason})`
        : `${target.node} -> ${target.url}`,
    )
    .join(', ')

  const legacy = config.wakeTargets[0]
  if (legacy?.legacy && targets[0]?.wake !== undefined) {
    return {
      legacy: { port: targets[0].wake, url: legacy.url },
      status: `enabled -> ${legacy.url}`,
      ...(identity === undefined ? {} : { identity }),
    }
  }

  return {
    ...(targets.length === 0 ? {} : { targets }),
    status:
      enabled.length === 0 ? `disabled (${status})` : `enabled -> ${status}`,
    ...(identity === undefined ? {} : { identity }),
  }
}

/** 聊天面的接线结果，形状与 {@link WakeWiring} 一致。 */
interface ConsoleChatWiring {
  readonly hub?: ConsoleChatHub
  readonly status: string
}

/** 生产接线的窄缝，用途与 {@link ConsoleWakeDependencies} 完全一样：让用例证明
 * 「哪个节点读哪个变量」，而不用往进程环境里塞真钥匙。 */
interface ConsoleChatDependencies {
  readonly pskFromEnv: (variable?: string) => string
  readonly createChatPort: typeof createConsoleChatPort
  readonly loadIdentity?: typeof loadConsoleWakeIdentity
}

/**
 * 聊天面要**两个**条件同时成立：至少给了一个 `--chat-url`，且它指的节点在环境里
 * 有一把可用的 PSK。
 *
 * 缺任何一个都不注入这个端口。和唤醒面不同的是，这里的后果是**整个 `/chat` 页面
 * 不存在**（侧栏也不显示入口），而不是渲染一个禁用的表单——理由见 `deps.ts` 里
 * `ChatPort` 的注释：一个打开就说「这里什么都没有」的页面不如不给入口。
 *
 * **PSK 按节点取，和唤醒面同一个变量**（`transportPskEnvVarForNode`）：同一个节点
 * 的两张面拨的是同一个入站端点、握的是同一把手，各配一把只会让运维在两个地方
 * 维护同一个秘密。旧式裸 URL 条目仍读共享的那一个变量。
 *
 * **一个节点没钥匙不拖垮其余的**：那一条不进允许名单（页面上它就是「不可拨」），
 * 其余照常。全都没钥匙才等于没有聊天面——那时禁用的原因逐节点写在 banner 上，
 * 而不是一句笼统的「没有 PSK」。
 *
 * PSK 只从环境变量取，与唤醒面同一条纪律：命令行上的密钥就是这台机器每一份进程
 * 列表里的密钥。
 */
export function wireConsoleChat(
  config: ConsoleCliConfig,
  registry: RegistryPort,
  dependencies: ConsoleChatDependencies = {
    pskFromEnv,
    createChatPort: createConsoleChatPort,
  },
): ConsoleChatWiring {
  if (config.chatTargets.length === 0) {
    return { status: 'disabled (no --chat-url)' }
  }
  const endpoints: ConsoleChatEndpoint[] = []
  const notes: string[] = []
  for (const target of config.chatTargets) {
    try {
      const psk = target.legacy
        ? dependencies.pskFromEnv()
        : dependencies.pskFromEnv(
            transportPskEnvVarForNode(target.node, '--chat-url'),
          )
      endpoints.push({
        url: target.url,
        psk,
        ...(target.legacy ? {} : { node: target.node }),
      })
      notes.push(target.legacy ? target.url : `${target.node} -> ${target.url}`)
    } catch {
      // `error.message` 属于秘密边界，与唤醒面同一条纪律：不进 banner，也不进页面。
      notes.push(
        target.legacy
          ? `${target.url} disabled (PSK unavailable)`
          : `${target.node} disabled (PSK unavailable)`,
      )
    }
  }
  if (endpoints.length === 0) {
    return { status: `disabled (${notes.join(', ')})` }
  }
  // 身份只在真要签名时读出来（首次运行会创建），而且排在「有没有一条拨得通的
  // 端点」之后：一个最终没有对话面的控制台，不该在配置根里留下一把没人用的私钥。
  // 两张面共用这一把——控制台在对面的审计链里只该有一个身份
  // （`consoleWakeIdentity.ts` 的模块注释）。
  //
  // **读不出来就让启动失败，不在这里 catch。**下面那个 try 只兜 `--chat-from`
  // 写坏了那一类；密钥读不出来是另一回事：操作者明确要求了签名，而「照常起来但
  // 悄悄不签」正是这条路径上最坏的失败形状——消息照送、回复照来，只有对面知道
  // 它没被授权。
  const identity =
    config.signChats === true
      ? (dependencies.loadIdentity ?? loadConsoleWakeIdentity)(config.chatFrom)
      : undefined
  try {
    const hub = dependencies.createChatPort({
      from: config.chatFrom,
      endpoints,
      storePath: config.chatStorePath,
      registry,
      ...(identity === undefined ? {} : { issueCapability: identity.issue }),
      onError: error => {
        // The console has no logger and its stdout is the banner. A chat-side
        // failure that nobody can see is worse than one line of noise.
        process.stderr.write(
          `console chat: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      },
    })
    return {
      hub,
      // 签没签名进 banner，因为它是这张面「是问答还是控制」的那条界线，而两者
      // 在别处长得一模一样：不签名的会话照样投递、照样回执、照样拿到回复，只是
      // agent 会拒绝执行。运维只有在这里能一眼看出自己开的是哪一种。
      status: `enabled as ${config.chatFrom}${
        identity === undefined ? '' : ' (signed)'
      } -> ${notes.join(', ')}`,
    }
  } catch (error) {
    // A malformed `--chat-from` lands here: the address rules live in
    // `assertAddress`, so the check happens where the address is used rather
    // than being copied into the argument parser.
    const reason = error instanceof Error ? error.message : String(error)
    return { status: `disabled (${reason})` }
  }
}

const FIELD_WIDTH = 13

function field(name: string, value: string): string {
  return `${name.padEnd(FIELD_WIDTH)}${value}\n`
}

export async function runConsole(args: readonly string[]): Promise<void> {
  // 帮助排在最前面，**在身份校验与运行时断言之前**：问「这个命令怎么用」的人
  // 恰恰是还没把 `OCC_IDENTITY=qianmo` 配对的那个人，让他先撞一条错误再去查文档
  // 是把唯一的自助入口挡在门外。
  if (isConsoleHelpRequest(args)) {
    process.stdout.write(CONSOLE_HELP_TEXT)
    return
  }
  assertConsoleRuntime()
  const config = parseConsoleArgs(args)

  // 在 token 解析**之前**：这条路径不起服务器、不拨端点、不读任何凭据，它唯一的
  // 作用是回答「该往每个节点的 --trust 里粘什么」。让它先于凭据一步，是为了在
  // 一台还没配好 token 的机器上也答得出来——那正是分发公钥的那一刻的状态。
  if (config.printWakeIdentity === true) {
    const identity = loadConsoleWakeIdentity(config.chatFrom)
    process.stdout.write(`${identity.node}=${identity.publicKey}\n`)
    return
  }

  // 凭据在**接线之前**就要定下来。放在后面的代价很具体：`wireConsoleChat` 会真的向
  // `--chat-url` 拨出去，于是一个权限过宽的 token 文件会在「拒绝启动」之前先把
  // 链路建起来、把会话文件写出去。起不来的那一次就该什么都没做过。
  //
  // 每枚 token 从三个入口里挑一个（文件 > 环境变量 > 命令行，取舍写在
  // `consoleTokenSources.ts` 的模块注释里）。这一步会读磁盘，所以它不在
  // `parseConsoleArgs` 里——那个函数是纯的。
  const viewSource = resolveConsoleTokenSource('view', config)
  const adminSource = resolveConsoleTokenSource('admin', config)

  // 「什么时候允许没有密码地跑一个控制台」只有一个答案，住在
  // `packages/console/src/auth.ts`。这里只负责把参数递过去，以及提供一个真随机
  // 的 `generate`——非环回缺 token 时它会抛，那正是我们要的：起不来比悄悄起来
  // 好，`--hostname 0.0.0.0` 正是控制台被挂上公网的那条路。
  const tokens = resolveTokens({
    ...(viewSource === undefined ? {} : { view: viewSource.value }),
    ...(adminSource === undefined ? {} : { admin: adminSource.value }),
    hostname: config.hostname,
    generate: newConsoleToken,
  })

  // Before anything dials out, for the same reason as the tokens above: a
  // console whose account ledger path is wrong should say so before it has
  // opened a single link.
  const accounts =
    config.accounts === true &&
    config.accountsStorePath !== undefined &&
    config.sessionsStorePath !== undefined
      ? wireConsoleAccounts({
          accountsStorePath: config.accountsStorePath,
          sessionsStorePath: config.sessionsStorePath,
          legacyViewToken: config.legacyViewToken !== false,
          breakGlass: config.breakGlass === true,
        })
      : undefined

  // The registry write token (P15.8), read with the other credentials and for
  // the same reason: a file anyone on the machine can read is a startup
  // error, not something to discover on the first renewal.
  const registryWriteToken =
    config.registryTokenFile === undefined
      ? undefined
      : readRegistryWriteTokenFile(
          config.registryTokenFile,
          '--registry-token-file',
        )

  const wake = wireConsoleWake(config)
  // Registrations made on the page are renewed by this process until they are
  // deregistered on the page; the ledger that remembers them across restarts
  // lives in this console's config root (`consoleRegistrations.ts`, console.md
  // §7.3). Its port wraps the HTTP one, so every renewal carries the write
  // token when there is one.
  const registrations = new ConsoleRegistrations({
    path: consoleRegistrationsPath(),
    registry: createRegistryPort({
      baseUrl: config.registryUrl,
      ...(registryWriteToken === undefined
        ? {}
        : { writeToken: registryWriteToken }),
    }),
    log: line => {
      process.stderr.write(`${line}\n`)
    },
  })
  // One registry port, shared: the chat face's target list and the roster are
  // the same question, and two ports would be two answers that can disagree.
  const registry = registrations.port
  const chat = wireConsoleChat(config, registry)
  // The certificate column, or nothing at all (§10.1). Read at startup rather
  // than per request: the CA root is the one file this console needs and a
  // missing one is a configuration error the operator should hear about now,
  // not as an empty column later. It is public material — §10.3's rule that no
  // private key of any kind is reachable from this process holds structurally,
  // because there is no option here that could point at one.
  const caCertificatePem =
    config.trustCa === undefined
      ? undefined
      : readTrustAnchors(config.trustCa).pem
  const certificates =
    caCertificatePem === undefined
      ? undefined
      : createCertificatePort({
          baseUrl: config.registryUrl,
          caCertificatePem,
        })

  // Witness keys come from this side only — `--trust`, or a certificate the
  // CA root verifies — never from a registry row (K-11 F-3). `parseConsoleArgs`
  // already refused `--anchors` with neither.
  const audits: ConsoleAuditSource[] = consoleAuditSources(
    config,
    caCertificatePem,
  )
  const firstAudit = audits[0]
  if (firstAudit === undefined) {
    throw new Error('console requires at least one audit source')
  }

  // 归属面是一件事，不是两件：没给 `--node-server` 就既没有名册上的归属，也没有
  // 服务器区块可以写备注——所以备注端口跟着白名单一起接，而不是无条件接一个
  // 永远没有合法目标的 store。它也因此不会在一个没配归属的部署上创建那个文件。
  const serverNotes =
    config.nodeServers.length === 0
      ? undefined
      : createServerNotesPort({
          store: new ServerNotesStore(config.serverNotesPath),
        })

  const deps: ConsoleDeps = {
    registry,
    // `audit` remains the legacy facade for direct package callers. The page
    // and HTTP routes consume `audits`, so every configured source is isolated.
    audit: firstAudit.audit,
    audits,
    limits: consoleLimits(),
    label: config.label,
    // Display only. The wake form used to carry a 回调 text box that could hold
    // exactly one value — `createWakePort` pins it — so the field is gone and
    // the page states the pinned URL as read-only small print instead. Passed
    // only when the wake face is actually wired: printing a receipt endpoint
    // beside a disabled form would be stating a fact about a thing that cannot
    // happen.
    ...(wake.legacy === undefined ? {} : { wakeUrl: wake.legacy.url }),
    // Prefills the wake form's 发起方. The chat face already speaks as this
    // address (§6.3), and a console that introduces itself as one thing when
    // chatting and another when waking is a console whose audit trail has two
    // identities in it.
    identity: config.chatFrom,
    ...(wake.legacy === undefined ? {} : { wake: wake.legacy.port }),
    ...(wake.targets === undefined ? {} : { wakeTargets: wake.targets }),
    ...(chat.hub === undefined ? {} : { chat: chat.hub }),
    ...(certificates === undefined ? {} : { certificates }),
    // 启动参数说了算的一张白名单：名册据它显示归属，备注只许写进它里面的服务器
    // （`packages/console/src/http.ts` 的 handleServerNote）。
    ...(config.nodeServers.length === 0
      ? {}
      : { nodeServers: config.nodeServers }),
    ...(serverNotes === undefined ? {} : { serverNotes }),
    // Spelled once, in the identity roster — never as a literal here
    // (CLAUDE.md §2.3).
    binName: invokedBinName(),
  }

  const handle = startConsoleServer(deps, config.port, {
    hostname: config.hostname,
    tokens,
    ...(accounts === undefined ? {} : { accounts }),
  })
  // After the port is bound: a console that failed to start must not have
  // re-announced anything on its way down.
  registrations.start()

  const origin = httpOrigin(config.hostname, handle.port)
  // token 是自己生成的才回显：显式提供的那一个已经在操作者手里，把它再打进
  // 终端记录和 CI 日志里只是白白多一份泄露面。**出处**则总是打——三个入口里
  // 高优先级的那个静默盖掉低的，是事后没人查得清的那类配置事故，而「这一枚
  // 来自命令行」同时就是「它此刻躺在 ps 里」的告警。
  const viewGenerated = viewSource === undefined

  let banner = field('console', origin)
  banner += field(
    'open',
    // view token 关掉以后，带它的链接只会被拒；门就是登录页。
    accounts?.legacyView === false
      ? `${origin}/login`
      : viewGenerated
        ? `${origin}/?token=${tokens.view}`
        : `${origin}/?token=<your view token>`,
  )
  banner += field(
    'view-token',
    viewSource === undefined ? tokens.view : `from ${viewSource.detail}`,
  )
  banner += field(
    'admin-token',
    adminSource === undefined ? tokens.admin : `from ${adminSource.detail}`,
  )
  banner += field('registry', config.registryUrl)
  if (config.registryTokenFile !== undefined) {
    // `FIELD_WIDTH` is 13: a 13-character name would run into its value.
    banner += field(
      'write-token',
      `registry writes carry the token from ${config.registryTokenFile}`,
    )
  }
  banner += field(
    'ledger',
    `${registrations.path} (${String(registrations.addresses.length)} renewed by this console)`,
  )
  banner += field(
    'audit-trails',
    config.auditTargets
      .map(target => `${target.node}=${target.path}`)
      .join(', '),
  )
  if (config.anchors !== undefined) {
    banner += field('anchors', config.anchors.value)
    banner += field(
      'witness-keys',
      [
        ...(config.trusted ?? []).map(([node]) => `--trust ${node}`),
        ...(config.trustCa === undefined ? [] : ['CA-verified certificates']),
      ].join(', '),
    )
  }
  banner += field('wake', wake.status)
  if (wake.identity !== undefined) {
    // 打的就是 `--trust` 后面那一整段，一字不差：运维要做的事是复制粘贴，不是
    // 照着两个字段自己拼一个 `<node>=<publicKey>` 出来。公开材料，可以进终端记录。
    banner += field(
      'wake-signing',
      `${wake.identity.node}=${wake.identity.publicKey}`,
    )
  }
  banner += field('chat', chat.status)
  if (chat.hub !== undefined) {
    banner += field('chat-store', config.chatStorePath)
  }
  banner += field(
    'servers',
    config.nodeServers.length === 0
      ? 'disabled (no --node-server)'
      : config.nodeServers
          .map(entry => `${entry.node}=${entry.server}`)
          .join(', '),
  )
  if (serverNotes !== undefined) {
    banner += field('server-notes', config.serverNotesPath)
  }
  if (accounts !== undefined && config.accountsStorePath !== undefined) {
    const problem = accounts.book.problem
    banner += field(
      'accounts',
      problem === null
        ? `enabled -> ${config.accountsStorePath}`
        : `UNAVAILABLE (${problem})`,
    )
    banner += field('sessions', config.sessionsStorePath ?? '')
    banner += field(
      'legacy-view',
      accounts.legacyView === false ? 'off' : 'on (migration)',
    )
    // 处理器构造时已经比对过指纹、记下了轮换；这里读到的是「现在这枚 admin
    // token 用作 break-glass 之后还没换」。
    const glass = accounts.book.breakGlassStatus(tokenFingerprint(tokens.admin))
    banner += field(
      'break-glass',
      (accounts.breakGlass === true ? 'on (admin token: Bearer only)' : 'off') +
        (glass.rotationDue
          ? ` · ROTATE the admin token, last used ${new Date(
              glass.lastUsedAt ?? 0,
            ).toISOString()}`
          : ''),
    )
  }
  banner += field('label', config.label)
  // 这份产物是从哪个 commit 构建的（issue #70）。控制台和常驻节点一样是**部署到
  // 舰队上的产物**：那棵树没有 `.git`，`dist/` 的几百个 chunk 里找不到 SHA，入口
  // 里唯一的版本串是基座的发布线——本 fork 每个提交上都一模一样。所以在这一行
  // 之前，一台机器上跑着的控制台答不出自己是哪一版。构建拿不到时是 `'unknown'`，
  // 那是要照直打出来的事实，不是留给读者拿自己的 HEAD 去填的空。
  //
  // 键名 `sourceCommit` 与值的形态（全 40 位 SHA / `-dirty` / `'unknown'`）跟
  // 常驻侧启动行**逐字对齐**，尽管这一面其他字段是 kebab-case：两处拼写一旦分叉，
  // 读 banner 的那一侧就得为同一个事实写两套解析。对齐的是常驻侧，不是本地风格。
  //
  // 排在 `label` 之后：banner 头上那几行（origin / open / token）是运维要复制粘贴
  // 的动作面，而「哪个部署、哪个构建」是同一类身份事实，放一起读。
  banner += field('sourceCommit', sourceCommit())
  process.stdout.write(banner)

  const stop = (): void => {
    // Leases already granted run out on their own; the ledger stays, so the
    // next start picks the same entries up again.
    registrations.stop()
    void handle.stop()
    // Closing the hub drops the outbound links and the pending-task timers. A
    // console that exits without it leaves a WebSocket the far node keeps a
    // channel record for until its own idle timeout.
    void chat.hub?.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
