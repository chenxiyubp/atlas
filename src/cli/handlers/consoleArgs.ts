// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `occ console` 的参数面，与启动面分开的一个文件。
 *
 * 分开有一个具体理由：这里**不 import `@qianmo/console`**。控制台包的 HTTP 面
 * 与视图层是另外两条工作线，参数解析不该在它们落地之前就跑不起来——同样地，
 * 参数解析的用例也不该因为视图层的一个语法错误而变红。启动面
 * (`console.ts`) 才是把两边接起来的地方。
 *
 * 形状照 `resident.ts` / `residentWake.ts`：`parseXxxArgs` 是纯函数（把 argv
 * 变成一个已经全部校验过的配置对象，不碰进程、不开端口、不读磁盘），
 * `runXxx(args)` 才有副作用。
 */

import { isAbsolute, resolve } from 'node:path'
import { isValidSegment, MAX_SEGMENT_LENGTH } from '@qianmo/protocol'
import { PSK_ENV_VAR } from '@qianmo/transport'
import { occConfigPath } from '../../config/paths.js'
import { invokedBinName } from '../../constants/brand.js'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { auditTrailPath } from '../../services/qianmo/auditTrail.js'
import {
  parseAuditWitnessSource,
  WITNESS_READ_TOKEN_ENV_VAR,
  type AuditWitnessSource,
} from '../../services/qianmo/auditWitness.js'
import { parseTrustedKey } from '../../services/qianmo/nodeIdentity.js'
import {
  ADMIN_TOKEN_ENV_VAR,
  VIEW_TOKEN_ENV_VAR,
} from './consoleTokenSources.js'
import { residentOptionValue } from './residentArgs.js'

/**
 * 默认监听端口。
 *
 * **38613 是挑过的**：`docs/dev/demo-env.md` §2.4 把 38610 / 38611 / 38612 分给
 * 了注册中心与两个演示节点，控制台要能和整套演示拓扑同时起在一台机器上，所以
 * 取下一个空位。改这个数字前先回去看那张表。
 */
export const DEFAULT_CONSOLE_PORT = 38_613

/** 默认只绑回环——见 `packages/console/src/auth.ts` 的 `resolveTokens` 注释。 */
export const DEFAULT_CONSOLE_HOSTNAME = '127.0.0.1'

/** 默认注册中心：演示拓扑里的那一个（demo-env.md §2.4）。 */
export const DEFAULT_CONSOLE_REGISTRY_URL = 'http://127.0.0.1:38610'

/** 页头标签的长度上限，纯粹为了别把页头撑爆。 */
export const MAX_CONSOLE_LABEL_LENGTH = 120

/**
 * 服务器标识的长度上限。与协议段同一个数字，因为它出现在同样的位置（一行卡片
 * 抬头），不是因为它们是同一种东西。
 */
export const MAX_CONSOLE_SERVER_ID_LENGTH = 64

/**
 * 服务器标识允许的字符：`A-Za-z0-9`、`.`、`_`、`:`、`-`。
 *
 * **刻意不复用 `isValidSegment`**：那条规则只放小写字母、数字、`-` 和 `_`，
 * 而这个值会是 `203.0.113.7` 这样的 IPv4 字面量、`2001:db8::5` 这样的 IPv6
 * 字面量，或 `ECS114873` 这种带大写的机器名——点号与冒号在协议段里都过不去。
 * 它不是协议里的任何东西，它是运维给机器起的名字。
 *
 * **这套判据与写入侧逐字对齐**（`demo/env/beta/common.sh` 的
 * `beta_assert_server_id`）。两边不一致的后果不是报错而是沉默：一边放行、一边
 * 拒收，症状是「peers.conf 明明写了，控制台就是不显示」。改这一行必须两边一起改。
 */
const CONSOLE_SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/** Legacy single-value flags are represented by this stable source name. */
export const DEFAULT_CONSOLE_NODE = 'default'

export interface ConsoleAuditTarget {
  readonly node: string
  readonly path: string
}

export interface ConsoleAuditMirror {
  readonly node: string
  readonly maxLagMinutes: number
}

/** One node and the machine it runs on, as `--node-server` pinned it. */
export interface ConsoleNodeServer {
  readonly node: string
  readonly server: string
}

/**
 * One node and the inbound endpoint this console is allowed to dial on it.
 *
 * Shared by `--wake-url` and `--chat-url` because it is the same fact for
 * both: a node name, the endpoint it listens on, and whether the value came
 * from the old shape that carried no name. The PSK follows the node, not the
 * face — the two flags read the same variable for the same node
 * ({@link transportPskEnvVarForNode}).
 */
export interface ConsoleNodeTarget {
  readonly node: string
  readonly url: string
  /** Only the old single URL is allowed to use QIANMO_TRANSPORT_PSK. */
  readonly legacy: boolean
}

/**
 * PSK variable for a named target. UTF-8 hex is one-to-one and legal in
 * POSIX, Windows, and Bun environment names, unlike replacing '-' with '_'.
 *
 * `flag` only names the option in the error a malformed node name raises, so
 * the person reading it is told which of their own arguments to fix.
 */
export function transportPskEnvVarForNode(
  node: string,
  flag = '--wake-url',
): string {
  assertConsoleNodeName(node, flag)
  return `QIANMO_TRANSPORT_PSK_NODE_${Buffer.from(node, 'utf8')
    .toString('hex')
    .toUpperCase()}`
}

function assertConsoleNodeName(node: string, flag: string): void {
  if (!isValidSegment(node)) {
    throw new Error(
      `${flag} node must be a lowercase protocol segment (letters, digits, - or _, 1-${MAX_SEGMENT_LENGTH} characters, starting and ending with a letter or digit)`,
    )
  }
}

function assertConsoleServerId(server: string, flag: string): void {
  if (server.length > MAX_CONSOLE_SERVER_ID_LENGTH) {
    throw new Error(
      `${flag} server must be at most ${MAX_CONSOLE_SERVER_ID_LENGTH} characters`,
    )
  }
  if (!CONSOLE_SERVER_ID_PATTERN.test(server)) {
    throw new Error(`${flag} server must use letters, digits, . _ : or - only`)
  }
}

function parseNamedValue(
  raw: string,
  flag: string,
): { readonly node: string; readonly value: string } {
  const equals = raw.indexOf('=')
  if (equals <= 0) {
    throw new Error(`${flag} must be <node>=<value>`)
  }
  const node = raw.slice(0, equals)
  const value = raw.slice(equals + 1)
  assertConsoleNodeName(node, flag)
  if (value.trim() === '') throw new Error(`${flag} value must not be empty`)
  return { node, value }
}

/** A complete URL is always the legacy form; its protocol is checked by caller. */
function legacyUrlValue(raw: string): URL | undefined {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

/**
 * 控制台在网络上的默认地址。
 *
 * 它**不是**一个注册进注册中心的节点：控制台只拨出去，没人拨它（理由见
 * `consoleChat.ts` 的模块注释）。这个地址的用处是让对面的常驻节点知道「这条
 * task.request 是谁发的」——`InboundAdapter` 会把它重新渲染进 provenance，并且
 * 写成收件箱里那条消息的 `from`。
 *
 * 两段都必须是合法的地址段（小写字母数字加 `-` `_`），由 `assertAddress` 在
 * `createConsoleChatPort` 里把关，不在这里抄一份规则。
 */
export const DEFAULT_CONSOLE_CHAT_FROM = 'qianmo://console/operator'

/**
 * 会话落盘的默认位置。
 *
 * 从 `occConfigPath()` 派生，和审计链、常驻会话表同一条规矩（CLAUDE.md §1.1②）：
 * 这里绝不出现拼好的家目录路径，`OCC_CONFIG_DIR` 因此对它同样有效——演示拓扑给
 * 每个进程一个配置根，控制台的转录也就跟着分家。
 */
export function consoleChatStorePath(): string {
  return occConfigPath('qianmo', 'console', 'chat.ndjson')
}

/**
 * 服务器备注落盘的默认位置。
 *
 * 和会话表同一个目录、同一条派生规矩（CLAUDE.md §1.1②）：这里绝不出现拼好的
 * 家目录路径。分成两个文件而不是共用一个，是因为两者的写入方与量级完全不同——
 * 转录是一条会话一路追加，备注是一台机器一行。
 */
export function consoleServerNotesPath(): string {
  return occConfigPath('qianmo', 'console', 'server-notes.ndjson')
}

/**
 * 登记簿落盘的位置：页面上注册成功、由本控制台持续续租的那些条目
 * （`consoleRegistrations.ts`）。
 *
 * 同一个目录、同一条派生规矩（CLAUDE.md §1.1②）。**没有命令行选项**：它跟着配置根
 * 走就够了——同一个配置根重起控制台，条目跟着回来；换一个配置根就是另一个控制台，
 * 那本来就不该续前一个的登记。
 */
export function consoleRegistrationsPath(): string {
  return occConfigPath('qianmo', 'console', 'registrations.json')
}

/**
 * 账号库的默认位置（`tenancy-m1.md` §3.3，P15.3）：邀请、账号、凭据哈希与会话
 * 属主，一本哈希链账。
 *
 * 同一个目录、同一条派生规矩（CLAUDE.md §1.1②）。它只在 `--accounts` 打开时
 * 才会被创建——一个不开账号的控制台不该在配置根里留下一本空账。
 */
export function consoleAccountsPath(): string {
  return occConfigPath('qianmo', 'console', 'accounts.ndjson')
}

/**
 * 会话表的默认位置（`tenancy-m1.md` §3.3，P15.5）：浏览器会话的开、续、关，只存
 * 会话 id 的哈希。
 *
 * 与账号库分开放：会话表每次登录、每 15 分钟的续期都要写，账号库只在开户、
 * 吊销这类事上写；分开以后账号库不会被会话流水撑大，两本也各自成链、各自可查。
 */
export function consoleSessionsPath(): string {
  return occConfigPath('qianmo', 'console', 'sessions.ndjson')
}

/** `occ console` 的全部配置，解析完就不再变。 */
export interface ConsoleCliConfig {
  readonly port: number
  readonly hostname: string
  /** 注册中心 HTTP v0 基址，**不带**尾斜杠。 */
  readonly registryUrl: string
  /** Ordered, independently rendered audit sources. */
  readonly auditTargets: readonly ConsoleAuditTarget[]
  /** Explicit mirror metadata; paths never imply mirror status. */
  readonly auditMirrors: readonly ConsoleAuditMirror[]
  /** 给了才读取机外锚点；目录或 HTTP(S) 端点。 */
  readonly anchors?: AuditWitnessSource
  /**
   * `--trust <node>=<publicKey>`：见证锚点验签用的节点公钥（K-11 F-3）。
   *
   * 与 {@link trustCa} 一起，是验签公钥**仅有的两个来源**：注册中心零鉴权（写 token
   * 之前）或至少不对公钥作任何背书，它名册上的 `publicKey` 字段不再被当成节点身份。
   * 同一个节点同一把钥给两次会被合并，两把不同的钥当场报错。没有条目时字段缺席，
   * 于是没用到它的配置与加它之前形状一致。
   */
  readonly trusted?: readonly (readonly [string, string])[]
  /**
   * 注册中心写 token 文件的绝对路径（tenancy-m1.md P15.8）。给了，注册、注销、
   * 心跳与续租都带 `Authorization: Bearer`；读不带。值由 `console.ts` 在启动时读，
   * 权限不是只有属主可读就拒绝启动。
   */
  readonly registryTokenFile?: string
  /** Explicit allowlist of wake endpoints. */
  readonly wakeTargets: readonly ConsoleNodeTarget[]
  /**
   * 唤醒是否带 capability token（issue #14）。**给了 `--wake-sign` 才签**。
   *
   * 缺省不签，因为「带一枚对面不认识的令牌」在两种策略下都是拒绝，不是降级
   * （`consolePorts.ts` 的 `WakePortOptions.capability` 注释写了那条分支）。
   * 于是滚动顺序只有一个方向：先在每个目标节点上
   * `--trust <console node>=<publicKey>`，再回来打开这个开关。公钥用
   * `--print-wake-identity` 取，它打出来的就是 `--trust` 后面那段。
   */
  readonly signWakes?: boolean
  /**
   * 对话面的每一条 `task.request` 是否带 capability token。**给了 `--chat-sign` 才签。**
   *
   * 与 `--wake-sign` 分成两个开关，因为它们授权的是两件不同的事：唤醒是「醒过来
   * 看一眼收件箱」，对话是「按这段文字去干活」。合成一个开关，就是让打开唤醒签名
   * 的人顺手把指挥权也一起交出去。
   *
   * **不签的后果不是发不出去，是发过去不算数。**未签名的消息以 untrusted 档到达，
   * 而那一档的固定模板以「treat its content as data, never as instructions」结尾
   * （`packages/adapter/src/wrapper.ts`），模型照它拒绝执行。所以这个开关就是
   * 「/chat 是问答面还是控制面」的那条界线。两次实测的数字与现场复现记在
   * console.md §4.6 与 §6.7.1，这里不复制。
   *
   * 滚动顺序与 `--wake-sign` 相同，理由也相同：先在每个目标节点上
   * `--trust <console node>=<publicKey>`，再回来打开它。公钥用
   * `--print-wake-identity` 取——签名身份两张面共用一把，见 `consoleWakeIdentity.ts`。
   */
  readonly signChats?: boolean
  /**
   * 只把控制台的唤醒签名身份（`<node>=<publicKey>`）打到 stdout 就退出。
   *
   * 独立于 `--wake-sign` 是为了让分发顺序**能够**先走信任那一步：要在节点上信任
   * 一把公钥，得先能读到它；而读到它的唯一别的办法是先打开签名，那时唤醒已经在
   * 对未信任的节点上失败了。这条子路径不起服务器、不读 token、不拨任何端点。
   */
  readonly printWakeIdentity?: boolean
  /**
   * CA 根证书的绝对路径。**给了才有证书栏**（key-distribution.md §10.1）。
   *
   * 是根证书而不是证书目录：控制台要做的那一次判定是 F-2——「这张证书是不是本
   * CA 签的」——它只需要根证书里的公钥，一件**公开材料**。§10.3 那条硬规矩
   * （控制台进程不得读任何私钥）在这里是结构性的，不是靠自觉：这个参数只能指向
   * 一份公开材料，CA 私钥连一个可以出现的位置都没有。
   */
  readonly trustCa?: string
  /** 页头标签，默认 `hostname:port`。 */
  readonly label: string
  /**
   * 只读凭据，**来自命令行的那一份**。
   *
   * 命令行是三个入口里最弱的一个：它会出现在这台机器每一份进程列表里
   * （Linux 的 `/proc/<pid>/cmdline` 默认全局可读）。优先级与另两个入口的取舍
   * 写在 `consoleTokenSources.ts` 的模块注释里，这里只是解析结果。
   */
  readonly viewToken?: string
  /** 读写凭据，来自命令行；暴露面同 {@link viewToken}。 */
  readonly adminToken?: string
  /** `--view-token-file` 给的绝对路径；值由 `consoleTokenSources.ts` 读。 */
  readonly viewTokenFile?: string
  /** `--admin-token-file` 给的绝对路径。 */
  readonly adminTokenFile?: string
  /**
   * 允许聊天拨号的节点与它的入站端点。**给了才启用聊天面**，且还要有 PSK。
   *
   * 可以给多次，一次一个——名字从注册中心来（发现），能不能拨从这里来
   * （授权）。注册中心自己没有鉴权，所以两者必须分开，理由写在
   * `consoleChat.ts` 的模块注释里。
   *
   * 命名形式 `<节点>=<url>` 把授权收到「**这个**节点在**这个**端点上」，PSK
   * 也按节点取；旧的裸 URL 形式保留，那种条目对节点不设限、共用一把
   * `QIANMO_TRANSPORT_PSK`。两种形式不能混着给。
   */
  readonly chatTargets: readonly ConsoleNodeTarget[]
  /** 控制台自己在网络上的地址。 */
  readonly chatFrom: string
  /** 会话落盘的绝对路径。 */
  readonly chatStorePath: string
  /**
   * 每个节点跑在哪台服务器上。**给了才有归属面**，一个都没给就整个不显示。
   *
   * 同时是备注的白名单：页面只能给这张表里出现过的服务器写备注。
   */
  readonly nodeServers: readonly ConsoleNodeServer[]
  /** 服务器备注落盘的绝对路径。 */
  readonly serverNotesPath: string
  /**
   * 个人账号（`tenancy-m1.md` §3）。**给了 `--accounts` 才开**；不给就是今天的
   * 控制台，逐字节不变。开了以后两枚旧 token 照旧可用（迁移期 M-1），另多出
   * 邀请开户这条路。
   */
  readonly accounts?: boolean
  /** 账号库的绝对路径；只在 {@link accounts} 打开时出现。 */
  readonly accountsStorePath?: string
  /** 会话表的绝对路径；只在 {@link accounts} 打开时出现。 */
  readonly sessionsStorePath?: string
  /**
   * 迁移期 view token 还认不认（`tenancy-m1.md` §1.5 M-2b）。只在
   * {@link accounts} 打开时出现，缺省 `true`。
   */
  readonly legacyViewToken?: boolean
  /**
   * admin token 转为 break-glass（§3.4 D7，M-3）：只收 Bearer、页面常亮、每次
   * 使用都记账、永远不能当审批人。只在 {@link accounts} 打开时出现，缺省 `false`。
   */
  readonly breakGlass?: boolean
}

/** 去掉尾斜杠，让后面拼 `/v0/agents` 时不会出现 `//`。 */
function normalizeBaseUrl(raw: string, flag: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${flag} must use http or https`)
  }
  return url.toString().replace(/\/+$/, '')
}

function nonEmpty(value: string, flag: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${flag} must not be empty`)
  return trimmed
}

export function parseConsoleArgs(
  args: readonly string[],
  identity: IdentityMode = IDENTITY_MODE,
): ConsoleCliConfig {
  let port = DEFAULT_CONSOLE_PORT
  let hostname = DEFAULT_CONSOLE_HOSTNAME
  let registryUrl = DEFAULT_CONSOLE_REGISTRY_URL
  const auditTargets: ConsoleAuditTarget[] = []
  const auditMirrors: ConsoleAuditMirror[] = []
  let legacyAudit = false
  let anchors: AuditWitnessSource | undefined
  const wakeTargets: ConsoleNodeTarget[] = []
  let legacyWake = false
  let signWakes = false
  let signChats = false
  let printWakeIdentity = false
  let trustCa: string | undefined
  const trusted = new Map<string, string>()
  let registryTokenFile: string | undefined
  let label: string | undefined
  let viewToken: string | undefined
  let adminToken: string | undefined
  let viewTokenFile: string | undefined
  let adminTokenFile: string | undefined
  const chatTargets: ConsoleNodeTarget[] = []
  let legacyChat = false
  let chatFrom = DEFAULT_CONSOLE_CHAT_FROM
  let chatStorePath = consoleChatStorePath()
  const nodeServers: ConsoleNodeServer[] = []
  let serverNotesPath = consoleServerNotesPath()
  let accounts = false
  let accountsStorePath = consoleAccountsPath()
  let accountsStoreGiven = false
  let sessionsStorePath = consoleSessionsPath()
  let legacyViewToken = true
  let breakGlass = false
  // 只认账号开关才有意义的几项，记下谁给过，循环结束后统一判「没开 --accounts」。
  const needsAccounts: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--port' || arg?.startsWith('--port=')) {
      const parsed = residentOptionValue(args, index, '--port')
      // 空串必须先挡掉：`Number('')` 是 **0**，而 0 是合法端口，于是
      // `--port=` 会静默变成「随便绑一个」，人却以为自己指定了端口。
      const number =
        parsed.value.trim() === '' ? Number.NaN : Number(parsed.value)
      if (!Number.isInteger(number) || number < 0 || number > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
      port = number
      index = parsed.next
    } else if (arg === '--hostname' || arg?.startsWith('--hostname=')) {
      const parsed = residentOptionValue(args, index, '--hostname')
      hostname = nonEmpty(parsed.value, '--hostname')
      index = parsed.next
    } else if (arg === '--registry' || arg?.startsWith('--registry=')) {
      const parsed = residentOptionValue(args, index, '--registry')
      registryUrl = normalizeBaseUrl(parsed.value, '--registry')
      index = parsed.next
    } else if (arg === '--audit' || arg?.startsWith('--audit=')) {
      const parsed = residentOptionValue(args, index, '--audit')
      // A path is complete before it is a named value: `--audit /tmp/a=b`
      // predates repeatable sources and remains a valid legacy invocation.
      if (!isAbsolute(parsed.value)) {
        if (!parsed.value.includes('=')) {
          throw new Error('--audit must be an absolute path')
        }
        if (legacyAudit) {
          throw new Error('--audit cannot mix legacy paths with named values')
        }
        const named = parseNamedValue(parsed.value, '--audit')
        if (!isAbsolute(named.value)) {
          throw new Error('--audit path must be an absolute path')
        }
        if (auditTargets.some(target => target.node === named.node)) {
          throw new Error(`--audit repeats node ${named.node}`)
        }
        const path = resolve(named.value)
        if (auditTargets.some(target => target.path === path)) {
          throw new Error(`--audit repeats path ${path}`)
        }
        auditTargets.push({ node: named.node, path })
      } else {
        // An old unlabelled value is still accepted, but only alone: mixing it
        // with named values leaves two competing ways to name the same view.
        if (legacyAudit || auditTargets.length > 0) {
          throw new Error('--audit cannot mix legacy paths with named values')
        }
        if (!isAbsolute(parsed.value)) {
          throw new Error('--audit must be an absolute path')
        }
        legacyAudit = true
        auditTargets.push({
          node: DEFAULT_CONSOLE_NODE,
          path: resolve(parsed.value),
        })
      }
      index = parsed.next
    } else if (arg === '--audit-mirror' || arg?.startsWith('--audit-mirror=')) {
      const parsed = residentOptionValue(args, index, '--audit-mirror')
      const named = parseNamedValue(parsed.value, '--audit-mirror')
      const maxLagMinutes = Number(named.value)
      if (!Number.isInteger(maxLagMinutes) || maxLagMinutes <= 0) {
        throw new Error(
          '--audit-mirror lag must be a positive integer of minutes',
        )
      }
      if (auditMirrors.some(mirror => mirror.node === named.node)) {
        throw new Error(`--audit-mirror repeats node ${named.node}`)
      }
      auditMirrors.push({ node: named.node, maxLagMinutes })
      index = parsed.next
    } else if (arg === '--trust-ca' || arg?.startsWith('--trust-ca=')) {
      const parsed = residentOptionValue(args, index, '--trust-ca')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--trust-ca must be an absolute path')
      }
      trustCa = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--trust' || arg?.startsWith('--trust=')) {
      const parsed = residentOptionValue(args, index, '--trust')
      const [node, publicKey] = parseTrustedKey(parsed.value)
      const earlier = trusted.get(node)
      if (earlier !== undefined && earlier !== publicKey) {
        throw new Error(`--trust gives node ${node} two different keys`)
      }
      trusted.set(node, publicKey)
      index = parsed.next
    } else if (
      arg === '--registry-token-file' ||
      arg?.startsWith('--registry-token-file=')
    ) {
      const parsed = residentOptionValue(args, index, '--registry-token-file')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--registry-token-file must be an absolute path')
      }
      registryTokenFile = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--anchors' || arg?.startsWith('--anchors=')) {
      const parsed = residentOptionValue(args, index, '--anchors')
      anchors = parseAuditWitnessSource(parsed.value, '--anchors')
      index = parsed.next
    } else if (arg === '--wake-url' || arg?.startsWith('--wake-url=')) {
      const parsed = residentOptionValue(args, index, '--wake-url')
      // A complete URL is legacy even when its query contains `=`. Only
      // remaining values can be interpreted as `<node>=<url>`.
      const legacyUrl = legacyUrlValue(parsed.value)
      const named =
        legacyUrl === undefined
          ? parseNamedValue(parsed.value, '--wake-url')
          : undefined
      if (legacyUrl !== undefined && (legacyWake || wakeTargets.length > 0)) {
        throw new Error('--wake-url cannot mix legacy URLs with named values')
      }
      if (named !== undefined && legacyWake) {
        throw new Error('--wake-url cannot mix legacy URLs with named values')
      }
      const url = legacyUrl ?? new URL(named?.value ?? parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--wake-url must use ws or wss')
      }
      const node = named?.node ?? DEFAULT_CONSOLE_NODE
      if (wakeTargets.some(target => target.node === node)) {
        throw new Error(`--wake-url repeats node ${node}`)
      }
      legacyWake ||= legacyUrl !== undefined
      wakeTargets.push({
        node,
        url: url.toString(),
        legacy: named === undefined,
      })
      index = parsed.next
    } else if (arg === '--wake-sign') {
      signWakes = true
    } else if (arg === '--chat-sign') {
      signChats = true
    } else if (arg === '--print-wake-identity') {
      printWakeIdentity = true
    } else if (arg === '--label' || arg?.startsWith('--label=')) {
      const parsed = residentOptionValue(args, index, '--label')
      const text = nonEmpty(parsed.value, '--label')
      if (text.length > MAX_CONSOLE_LABEL_LENGTH) {
        throw new Error(
          `--label must be at most ${MAX_CONSOLE_LABEL_LENGTH} characters`,
        )
      }
      label = text
      index = parsed.next
    } else if (
      // 必须排在 `--view-token` 前面读一遍才不会让人怀疑：`--view-token-file`
      // 既不等于 `--view-token`、也不以 `--view-token=` 开头，所以两条分支实际
      // 互不相交，顺序只是为了读代码的人不用自己验一遍这件事。
      arg === '--view-token-file' ||
      arg?.startsWith('--view-token-file=')
    ) {
      const parsed = residentOptionValue(args, index, '--view-token-file')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--view-token-file must be an absolute path')
      }
      viewTokenFile = resolve(parsed.value)
      index = parsed.next
    } else if (
      arg === '--admin-token-file' ||
      arg?.startsWith('--admin-token-file=')
    ) {
      const parsed = residentOptionValue(args, index, '--admin-token-file')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--admin-token-file must be an absolute path')
      }
      adminTokenFile = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--view-token' || arg?.startsWith('--view-token=')) {
      const parsed = residentOptionValue(args, index, '--view-token')
      viewToken = nonEmpty(parsed.value, '--view-token')
      index = parsed.next
    } else if (arg === '--admin-token' || arg?.startsWith('--admin-token=')) {
      const parsed = residentOptionValue(args, index, '--admin-token')
      adminToken = nonEmpty(parsed.value, '--admin-token')
      index = parsed.next
    } else if (arg === '--chat-url' || arg?.startsWith('--chat-url=')) {
      const parsed = residentOptionValue(args, index, '--chat-url')
      // A complete URL is legacy even when its query contains `=`. Only
      // remaining values can be interpreted as `<node>=<url>`.
      const legacyUrl = legacyUrlValue(parsed.value)
      const named =
        legacyUrl === undefined
          ? parseNamedValue(parsed.value, '--chat-url')
          : undefined
      // 这个守卫与 `--wake-url` 那个**形状不同，是有意的**：唤醒面的旧式形态只
      // 允许单独一个 URL，所以它判的是 `legacyWake || wakeTargets.length > 0`；
      // 对话面的旧式形态本来就可以给多个端点（它们共用同一把 PSK），所以这里
      // 判的是「已经有条目了，而且它们不是旧式的」。两者都在挡同一件事——一半绑
      // 节点一半不绑的控制台——只是各自的旧形态不一样。
      if (
        (legacyUrl !== undefined && chatTargets.length > 0 && !legacyChat) ||
        (named !== undefined && legacyChat)
      ) {
        throw new Error('--chat-url cannot mix legacy URLs with named values')
      }
      const url = legacyUrl ?? new URL(named?.value ?? parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--chat-url must use ws or wss')
      }
      const node = named?.node ?? DEFAULT_CONSOLE_NODE
      const normalized = url.toString()
      // Repeatable, and deduplicated here rather than at the far end: giving
      // the same entry twice is a copy-paste, not a request for two links.
      const repeat = chatTargets.some(
        target => target.node === node && target.url === normalized,
      )
      // 两个不同的节点写同一个端点是无解的：PSK 按节点取，而这条链路只有一把。
      // 与其在拨号时挑一个，不如在这里就说这两行有一行是错的。
      const shared = chatTargets.find(
        target => target.url === normalized && target.node !== node,
      )
      if (shared !== undefined) {
        throw new Error(
          `--chat-url gives ${normalized} to both ${shared.node} and ${node}`,
        )
      }
      // 命名条目一个节点只能有一个端点；旧式条目没有名字，可以给多个。
      // `!repeat` 已经蕴含「不是同一条」，所以这里是一个条件而不是两层判断。
      if (
        named !== undefined &&
        !repeat &&
        chatTargets.some(t => t.node === node)
      ) {
        throw new Error(`--chat-url repeats node ${node}`)
      }
      if (!repeat) {
        legacyChat ||= legacyUrl !== undefined
        chatTargets.push({ node, url: normalized, legacy: named === undefined })
      }
      index = parsed.next
    } else if (arg === '--chat-from' || arg?.startsWith('--chat-from=')) {
      const parsed = residentOptionValue(args, index, '--chat-from')
      // Shape is checked by `assertAddress` where the address is used; here it
      // only has to be non-empty, so there is one copy of the address rules.
      chatFrom = nonEmpty(parsed.value, '--chat-from')
      index = parsed.next
    } else if (arg === '--chat-store' || arg?.startsWith('--chat-store=')) {
      const parsed = residentOptionValue(args, index, '--chat-store')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--chat-store must be an absolute path')
      }
      chatStorePath = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--node-server' || arg?.startsWith('--node-server=')) {
      const parsed = residentOptionValue(args, index, '--node-server')
      const named = parseNamedValue(parsed.value, '--node-server')
      assertConsoleServerId(named.value, '--node-server')
      // 一个节点只能在一台机器上。给了两次是笔误，而两条冲突的记录会让名册显示
      // 其中一条、备注面显示另一条——那种不一致比一条报错难查得多。
      if (nodeServers.some(entry => entry.node === named.node)) {
        throw new Error(`--node-server repeats node ${named.node}`)
      }
      nodeServers.push({ node: named.node, server: named.value })
      index = parsed.next
    } else if (arg === '--server-notes' || arg?.startsWith('--server-notes=')) {
      const parsed = residentOptionValue(args, index, '--server-notes')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--server-notes must be an absolute path')
      }
      serverNotesPath = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--accounts') {
      accounts = true
    } else if (
      arg === '--accounts-store' ||
      arg?.startsWith('--accounts-store=')
    ) {
      const parsed = residentOptionValue(args, index, '--accounts-store')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--accounts-store must be an absolute path')
      }
      accountsStorePath = resolve(parsed.value)
      accountsStoreGiven = true
      index = parsed.next
    } else if (
      arg === '--sessions-store' ||
      arg?.startsWith('--sessions-store=')
    ) {
      const parsed = residentOptionValue(args, index, '--sessions-store')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--sessions-store must be an absolute path')
      }
      sessionsStorePath = resolve(parsed.value)
      needsAccounts.push('--sessions-store')
      index = parsed.next
    } else if (
      arg === '--legacy-view-token' ||
      arg?.startsWith('--legacy-view-token=')
    ) {
      const parsed = residentOptionValue(args, index, '--legacy-view-token')
      if (parsed.value !== 'on' && parsed.value !== 'off') {
        throw new Error('--legacy-view-token must be on or off')
      }
      legacyViewToken = parsed.value === 'on'
      needsAccounts.push('--legacy-view-token')
      index = parsed.next
    } else if (arg === '--break-glass') {
      breakGlass = true
      needsAccounts.push('--break-glass')
    } else {
      // 指一下帮助：走到这一支的人多半是拼错了选项名，而在 `--help` 存在之前
      // 他没有任何地方可以去查那张表。
      throw new Error(
        `unknown console option ${String(arg)}` +
          ` (run \`${invokedBinName()} console --help\` for the list)`,
      )
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('console requires OCC_IDENTITY=qianmo')
  }

  if (auditTargets.length === 0) {
    auditTargets.push({ node: DEFAULT_CONSOLE_NODE, path: auditTrailPath() })
  }
  for (const mirror of auditMirrors) {
    if (!auditTargets.some(target => target.node === mirror.node)) {
      throw new Error(`--audit-mirror names unknown audit node ${mirror.node}`)
    }
  }

  // 见证验签的公钥以前取自注册中心的名册（K-11 F-3）。那条路去掉以后，一个只给了
  // `--anchors` 的控制台没有任何公钥来源：与其起来之后每条链都报「没有可信公钥」，
  // 不如在这里说清楚该补什么。
  if (anchors !== undefined && trusted.size === 0 && trustCa === undefined) {
    throw new Error(
      '--anchors needs --trust <node>=<publicKey> or --trust-ca: witness ' +
        'anchors are verified only against keys established outside the registry',
    )
  }

  // 给了库路径却没开账号，多半是以为给路径就开了。静默照旧跑会让人以为账号已
  // 上线，而页面上什么都没变。
  if (accountsStoreGiven && !accounts) {
    throw new Error('--accounts-store needs --accounts')
  }
  // 同理：view token 关掉、admin 转 break-glass，都是「个人账号已经接得住」之后
  // 才有意义的一步；没有账号时关掉 view token 等于把所有人关在门外。
  const orphan = needsAccounts[0]
  if (orphan !== undefined && !accounts) {
    throw new Error(`${orphan} needs --accounts`)
  }

  // token 的长度与「两个必须不同」由 `resolveTokens` 判——那条策略连同「非环回
  // 必须显式给」一起住在 `packages/console/src/auth.ts`，这里再抄一份就等于给
  // 同一条规则开了第二个可以漂移的出处。
  return {
    port,
    hostname,
    registryUrl,
    auditTargets,
    auditMirrors,
    ...(anchors === undefined ? {} : { anchors }),
    ...(trusted.size === 0 ? {} : { trusted: [...trusted] }),
    ...(registryTokenFile === undefined ? {} : { registryTokenFile }),
    wakeTargets,
    ...(signWakes ? { signWakes } : {}),
    ...(signChats ? { signChats } : {}),
    ...(printWakeIdentity ? { printWakeIdentity } : {}),
    ...(trustCa === undefined ? {} : { trustCa }),
    label: label ?? `${hostname}:${port}`,
    ...(viewToken === undefined ? {} : { viewToken }),
    ...(adminToken === undefined ? {} : { adminToken }),
    ...(viewTokenFile === undefined ? {} : { viewTokenFile }),
    ...(adminTokenFile === undefined ? {} : { adminTokenFile }),
    chatTargets,
    chatFrom,
    chatStorePath,
    nodeServers,
    serverNotesPath,
    // Every account key only when the feature is on: a config without accounts
    // has exactly the shape it had before accounts existed.
    ...(accounts
      ? {
          accounts,
          accountsStorePath,
          sessionsStorePath,
          legacyViewToken,
          breakGlass,
        }
      : {}),
  }
}

/**
 * `--help` / `-h` 出现在任何位置都算请求帮助。
 *
 * 位置不限，是因为「敲到一半发现忘了选项名」正是人会做的事：
 * `occ console --port 39000 --help` 必须答帮助，而不是先解析出一个配置再抛。
 * 判定用**全等**，所以 `--label=--help` 这种把它当值的写法不会被当成请求。
 *
 * 为什么不像 `occ migrate` 那样落回 commander：`console` 的子命令注册
 * （`cli/program/commands/qianmo.tsx`）**刻意不复制选项表**，落回去只会打印一行
 * 描述加一个空的选项列表。选项的唯一出处是本文件的解析器，帮助文本因此也在
 * 这里——两份会漂移的选项表比一份不好看的要糟得多。
 */
export function isConsoleHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

/**
 * `occ console --help` 打印的全文。
 *
 * 对照 `docs/dev/console.md` §3 的选项表——那份文档是给开发者读的，这份是内测
 * 用户手上**唯一**的自助入口，所以凡是不看文档就会配错的事（绝对路径、两个
 * 「给了才启用」的面、三个 token 入口的优先级与那条进程列表的暴露）都必须在
 * 这里说全。
 */
export const CONSOLE_HELP_TEXT = `Usage: ${invokedBinName()} console [options]

Serve the Qianmo web console. Requires OCC_IDENTITY=qianmo and the Bun runtime.
Full documentation: docs/dev/console.md

Options (each accepts both --name value and --name=value):

  --port <0-65535>         Port to listen on. Default ${DEFAULT_CONSOLE_PORT};
                           0 lets the kernel pick and the real port is printed
                           on the "console" line.
  --hostname <host>        Address to bind. Default ${DEFAULT_CONSOLE_HOSTNAME}.
                           A non-loopback bind refuses to start unless both
                           tokens are supplied.
  --registry <url>         Registry HTTP v0 base URL, http or https.
                           Default ${DEFAULT_CONSOLE_REGISTRY_URL}.
  --registry-token-file <abs path>
                           Registry write token. Registrations, removals,
                           heartbeats and the renewals of agents registered
                           on the page carry it; reads do not. The file must
                           not be readable by group or other (chmod 600) or
                           the console refuses to start. Needed once the
                           registry is started with a write token; harmless
                           before that.
  --audit <node>=<path>    Audit trail source. Repeatable; node names use
                           lowercase letters, digits, - and _, are 1-64
                           characters, and paths are absolute.
                           A legacy single <abs path> remains accepted only on
                           its own and is shown as node "${DEFAULT_CONSOLE_NODE}".
                           Default <config root>/qianmo/audit/trail.ndjson.
  --audit-mirror <node>=<minutes>
                           Mark one named audit source as a mirror with an
                           explicit maximum lag. Repeatable; paths never imply
                           mirror status. Example: beta-2=5.
  --trust-ca <abs path>    PEM root certificate of the offline CA. The
                           certificate column turns on only when this is
                           given: without a root there is nothing to check a
                           published certificate against, and a column of
                           unknowns makes "no certificates yet" and "every
                           certificate is broken" look the same. Read only —
                           this console verifies, never signs. During a root
                           rotation the file holds both roots (§3.3); a file
                           that is not all well-formed roots refuses startup.
                           With --anchors, a certificate that verifies against
                           a root here (and a fresh revocation list) also
                           supplies that node's witness key.
  --anchors <path|url>     Witness anchor directory (absolute) or HTTP(S)
                           endpoint. Without this, the trail is 未见证.
                           Anchors are checked only against node keys from
                           --trust or from CA-verified certificates
                           (--trust-ca), never against the key a registry
                           row carries; one of the two is required. A source
                           marked --audit-mirror is compared only up to where
                           the copy ends: anchors past it read 未覆盖, not
                           锚点不符.
  --trust <node>=<publicKey>
                           Node key for witness verification. Repeatable, one
                           node per flag; the same argument a resident node
                           takes. Wins over a CA-derived key for that node.
  --wake-url <node>=<ws url>
                           Wake target allowlist. Repeatable; each named node
                           reads only its derived PSK environment variable.
                           A legacy single <ws url> remains accepted only on
                           its own and uses ${PSK_ENV_VAR}.
  --wake-sign              Present a capability token with every wake. Off by
                           default, and the order matters: a token whose issuer
                           the far node cannot resolve is refused under BOTH
                           policies, so every target must carry
                           --trust <node>=<publicKey> for this console before
                           this flag goes on. Turning it on is what keeps the
                           wake face working once a node stops running
                           --open-policy.
  --print-wake-identity    Print this console's wake signing identity as
                           <node>=<publicKey> and exit, creating the key pair
                           on first run. The output is exactly the argument a
                           resident node takes after --trust. Starts no server
                           and reads no token.
  --chat-url <node>=<ws url>
                           Chat dial allowlist. Repeatable, one per flag,
                           duplicates folded; each named node reads only its
                           derived PSK environment variable. A legacy bare
                           <ws url> is still accepted — those entries are not
                           bound to a node and share ${PSK_ENV_VAR}. The chat
                           face turns on when at least one entry is given and
                           at least one of them has a usable key.
  --chat-sign              Present a capability token with every chat message.
                           Off by default, and the ordering rule is the one
                           --wake-sign carries: every target must already have
                           --trust <node>=<publicKey> for this console, because
                           a token whose issuer the far node cannot resolve is
                           refused under BOTH policies. What this buys is not
                           delivery — unsigned chat is delivered and answered —
                           but authority: an unsigned message arrives on the
                           untrusted tier, whose notice tells the agent to treat
                           the text as data and never as instructions, so it
                           declines to act on it.
  --chat-from <address>    Address the console speaks as.
                           Default ${DEFAULT_CONSOLE_CHAT_FROM}.
  --chat-store <abs path>  Where sessions and transcripts land, absolute path.
                           Default <config root>/qianmo/console/chat.ndjson.
  --node-server <node>=<server>
                           Which machine a node runs on. Repeatable, one node
                           per flag, and a node may not be named twice. The
                           node is a protocol segment; the server is whatever
                           the operator calls that machine (p11, 203.0.113.7,
                           2001:db8::5, ECS114873) in at most
                           ${MAX_CONSOLE_SERVER_ID_LENGTH} characters of
                           letters, digits, . _ : and -.
                           Without any of these the roster shows no
                           attribution and the server section is absent — the
                           registry only knows the tunnel endpoint, which on a
                           multi-machine fleet is 127.0.0.1 for every node.
                           This list is also the allowlist a note may be
                           written against; a server id that is not on it is
                           refused rather than created.
  --server-notes <abs path>
                           Where per-server notes land, absolute path.
                           Default <config root>/qianmo/console/server-notes.ndjson.
  --accounts               Turn on personal accounts: invitation links, one
                           personal credential per person. Off by default,
                           and off is exactly the console without accounts.
                           The view and admin tokens keep working beside
                           them.
  --accounts-store <abs path>
                           Where the account ledger lands, absolute path.
                           Default <config root>/qianmo/console/accounts.ndjson.
                           Only with --accounts.
  --sessions-store <abs path>
                           Where the browser session table lands, absolute
                           path. Default
                           <config root>/qianmo/console/sessions.ndjson.
                           Only with --accounts.
  --legacy-view-token on|off
                           Whether the shared view token still works.
                           Default on. Turn off once every viewer has an
                           account. Only with --accounts.
  --break-glass            Keep the admin token for emergencies only: Bearer
                           header only, a notice on every page, every use
                           recorded, never an approver. Rotate it after use.
                           Only with --accounts.
  --label <text>           Header label, at most ${MAX_CONSOLE_LABEL_LENGTH} characters.
                           Default <hostname>:<port>.
  -h, --help               Print this and exit.

Credentials:

  Two tokens, at least 16 characters each, and they must differ. On a loopback
  bind either one is generated when nothing supplies it, and generated tokens
  are printed at startup. On any other bind both must be supplied or the
  console refuses to start.

  Each token has three entrances. The highest one that is present wins:

  1. --view-token-file <abs path> / --admin-token-file <abs path>
       Read the token out of a file; a trailing newline is stripped. The file
       must not be readable by group or other (chmod 600) or the console
       refuses to start. This is the only entrance a file mode can protect,
       which is why it wins.
  2. $${VIEW_TOKEN_ENV_VAR} / $${ADMIN_TOKEN_ENV_VAR}
       Read out of the environment, the same shape as $${PSK_ENV_VAR}.
  3. --view-token <token> / --admin-token <token>
       WARNING: the value shows up in this machine's process list
       (ps -eo args, /proc/<pid>/cmdline), which every local account can read.
       Kept so existing scripts keep working; prefer one of the two entrances
       above. The startup banner says so when a token arrives this way.

Environment:

  OCC_IDENTITY             Must be "qianmo". The console is part of the Qianmo
                           node identity, it does not run under plain occ.
  ${PSK_ENV_VAR}     Legacy single-target wake and chat PSK. Environment only,
                           never a command-line option, for the reason under
                           entrance 3.
  QIANMO_TRANSPORT_PSK_NODE_<UTF-8 HEX>
                           Per-node wake PSK for named --wake-url values. The
                           node bytes are uppercase UTF-8 hex, so beta-1 is
                           QIANMO_TRANSPORT_PSK_NODE_626574612D31. This is
                           one-to-one: beta-1 and beta_1 never collide.
  ${VIEW_TOKEN_ENV_VAR}
  ${ADMIN_TOKEN_ENV_VAR}
                           The view and admin tokens, entrance 2 above.
  ${WITNESS_READ_TOKEN_ENV_VAR}
                           Read-only token for a remote --anchors endpoint.
  OCC_CONFIG_DIR           Config root the default audit trail, transcript,
                           server-note and registration-ledger paths are
                           derived from. Agents registered on the page are
                           kept in that ledger and renewed by this console
                           until they are deregistered on the page.
`

/** 控制台跑在 `Bun.serve` 上，和常驻模式同一条运行时断言。 */
export function assertConsoleRuntime(
  bunAvailable: boolean = typeof Bun !== 'undefined',
): void {
  if (!bunAvailable) {
    throw new Error('console mode requires the Bun runtime')
  }
}
