// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/console` 五个端口的生产实现。
 *
 * 控制台包本身是叶子：它不知道注册中心在哪、审计链是哪个文件、唤醒要用哪把
 * PSK（`packages/console/src/deps.ts` 的模块注释）。那些答案全在 host 这一侧，
 * 所以适配层住在这里，和它依赖的 `auditTrailPath()` / `executeResidentWake()`
 * 放在同一层。方向和 tool-runtime 那六个 facade 一致：包声明接口，host 实现。
 *
 * ## 一条贯穿四个端口的规矩：**过得去的失败不抛**
 *
 * `ConsoleResult` 存在的理由就是这个。注册中心挂了，控制台仍然要能打开、仍然
 * 要能看审计链——一个因为下游不可达而 500 的面板，恰好在最需要它的时候没有。
 * 所以这里每一个 `catch` 都落成 `{ ok: false, failure }`，只有**编程错误**
 * （比如注入了一个不是函数的 fetch）才让它继续往上抛。
 *
 * ## 数字一律 import，不抄
 *
 * `LimitsSnapshot` 里的每个数都从拥有它的包取：协议上限归 `@qianmo/protocol`
 * 的 `LIMITS`，运行时速率归 `@qianmo/router` 的 `RUNTIME_RATE`（两者**故意**
 * 分成两列，见 `packages/router/src/rate.ts` 的模块注释），租约 TTL 归
 * `@qianmo/registry`。CLAUDE.md §2.2：协议级数值只允许有一个出处。
 */

import {
  AuditSource,
  queryTrail,
  readTrail,
  reconstructChain,
  type TrailQuery,
  type TrailReadResult,
} from '@qianmo/audit'
import { verifyAuditWitness, type WitnessEvidence } from '@qianmo/witness'
import type {
  AuditChainState,
  AuditFilter,
  AuditPort,
  CertificatePort,
  CertificateSnapshot,
  CertificateStatus,
  ConsoleAgent,
  ConsoleCaRoot,
  ConsoleCertificate,
  ConsoleFailure,
  ConsoleResult,
  LimitsSnapshot,
  RegisterAgentInput,
  RegistryPort,
  ServerNote,
  ServerNotesPort,
  WakeInput,
  WakePort,
} from '@qianmo/console'
import { X509Certificate } from 'node:crypto'
import {
  anchoredValidity,
  parseTrustAnchors,
  verifyRevocationListByAnchors,
} from '../../services/qianmo/trustAnchors.js'
import { LIMITS, assertAddress } from '@qianmo/protocol'
import { DEFAULT_TTL_MS } from '@qianmo/registry'
import { RUNTIME_RATE } from '@qianmo/router'
import {
  readAuditWitnessAnchors,
  witnessNodeOf,
  type AuditWitnessSource,
} from '../../services/qianmo/auditWitness.js'
import {
  WakeRefusedError,
  executeResidentWake,
  type WakeCapabilityIssuer,
} from './residentWake.js'
import { ServerNotesStore } from './consoleServerNotes.js'

function fail<T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// RegistryPort —— 注册中心 HTTP v0
// ---------------------------------------------------------------------------

/**
 * 注册中心的默认请求超时。
 *
 * 有超时这件事本身比这个数字重要：`fetch` 默认永不超时，而控制台的每个页面
 * 加载都要问一次注册中心——一台不回包（不是拒连）的注册中心会让面板永远停在
 * 转圈上，而那正是「注册中心挂了也要能打开」要防的那一种挂法。
 */
const DEFAULT_REGISTRY_TIMEOUT_MS = 5_000

/** 注入点：测试里换成假的，生产是全局 `fetch`。 */
type ConsoleFetch = (input: string, init: RequestInit) => Promise<Response>

interface RegistryPortOptions {
  /** HTTP v0 基址，不带尾斜杠（`consoleArgs.ts` 已经归一过）。 */
  readonly baseUrl: string
  /**
   * 注册中心写 token（tenancy-m1.md P15.8）。给了，注册、注销、心跳三种写请求
   * 带 `Authorization: Bearer`；读请求从不带——名册是公开的，没有理由让这枚
   * 凭据多走一趟。
   */
  readonly writeToken?: string
  readonly fetch?: ConsoleFetch
  readonly timeoutMs?: number
}

/** HTTP 状态码 → 端口失败码。5xx 归 `unreachable`：那是「下游坏了」。 */
function codeForStatus(status: number): ConsoleFailure['code'] {
  if (status === 400) return 'invalid'
  // 注册中心要写 token 而这边没带或带错：是这台控制台的配置问题，不是请求的错。
  if (status === 401) return 'refused'
  if (status === 404) return 'not_found'
  if (status === 405) return 'unsupported'
  if (status === 409) return 'rejected'
  if (status >= 500) return 'unreachable'
  return 'rejected'
}

/** 注册中心的错误体是 `{ error: { code, message } }`。 */
function errorMessageOf(body: unknown): string | null {
  if (!isRecord(body)) return null
  const error = body['error']
  if (!isRecord(error)) return null
  const message = error['message']
  return typeof message === 'string' && message.length > 0 ? message : null
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 一条 `AgentBody` → `ConsoleAgent`，形状不对就返回 null。
 *
 * 宽进而不是照单全收：注册中心和控制台是两个可以分别升级的进程，一个多出来的
 * 字段不该让整张列表打不开；但一条缺 `address` 的记录进了列表，页面上就会出现
 * 一个没法注销的幽灵行，所以那种记录直接丢掉。
 */
function toConsoleAgent(value: unknown): ConsoleAgent | null {
  if (!isRecord(value)) return null
  const address = value['address']
  const endpoint = value['endpoint']
  const status = value['status']
  if (typeof address !== 'string' || address.length === 0) return null
  if (typeof endpoint !== 'string') return null
  if (typeof status !== 'string') return null
  const rawCapabilities = value['capabilities']
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((item): item is string => typeof item === 'string')
    : []
  const publicKey = value['publicKey']
  return {
    address,
    endpoint,
    capabilities,
    ...(typeof publicKey === 'string' && publicKey.length > 0
      ? { publicKey }
      : {}),
    status,
    registeredAt: finiteOr(value['registeredAt'], 0),
    lastHeartbeatAt: finiteOr(value['lastHeartbeatAt'], 0),
    expiresAt: finiteOr(value['expiresAt'], 0),
  }
}

/**
 * 注册中心的 HTTP v0 面。
 *
 * 地址在**单个 path segment** 里百分号编码（`packages/registry/src/http.ts`
 * 第 181 行起的注释）：`qianmo://node-b/reviewer` 编成
 * `qianmo%3A%2F%2Fnode-b%2Freviewer`，`URL` 不会把转义拆开，服务端 split 出来
 * 仍是三段。空地址在本地就挡掉——它会退化成集合路由，删到的不是调用方想删的
 * 那个东西。
 */
export function createRegistryPort(options: RegistryPortOptions): RegistryPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS
  const doFetch: ConsoleFetch =
    options.fetch ?? ((input, init) => fetch(input, init))
  const writeToken = options.writeToken

  async function call(
    path: string,
    init: RequestInit,
  ): Promise<ConsoleResult<unknown>> {
    const headers = new Headers(init.headers)
    if (writeToken !== undefined && (init.method ?? 'GET') !== 'GET') {
      headers.set('authorization', `Bearer ${writeToken}`)
    }
    let response: Response
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return fail(
        'unreachable',
        `注册中心不可达 ${baseUrl}：${messageOf(error)}`,
      )
    }

    if (response.status === 204) return { ok: true, value: null }

    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // 断在半路的响应体和一个空体在这里是同一件事：下面靠状态码判成败。
      body = null
    }

    if (!response.ok) {
      return fail(
        codeForStatus(response.status),
        errorMessageOf(body) ??
          `注册中心返回 HTTP ${response.status}（${baseUrl}${path}）`,
      )
    }
    return { ok: true, value: body }
  }

  function segment(address: string): ConsoleResult<string> {
    if (address.trim() === '') {
      return fail('invalid', '地址不能为空')
    }
    return { ok: true, value: encodeURIComponent(address) }
  }

  function oneAgent(value: unknown): ConsoleResult<ConsoleAgent> {
    const agent = toConsoleAgent(value)
    return agent === null
      ? fail('invalid', '注册中心返回的不是一条 agent 记录')
      : { ok: true, value: agent }
  }

  return {
    async list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
      const result = await call('/v0/agents', { method: 'GET' })
      if (!result.ok) return result
      const raw = isRecord(result.value) ? result.value['agents'] : undefined
      if (!Array.isArray(raw)) {
        return fail('invalid', '注册中心返回的不是 agents 列表')
      }
      const agents: ConsoleAgent[] = []
      for (const entry of raw) {
        const agent = toConsoleAgent(entry)
        if (agent !== null) agents.push(agent)
      }
      return { ok: true, value: agents }
    },

    async register(
      input: RegisterAgentInput,
    ): Promise<ConsoleResult<ConsoleAgent>> {
      // 字段校验全部留给注册中心：它是这些规则的真源（地址形状、endpoint
      // 形状、能力条数上限），在这里再写一遍就等于开了第二个会漂移的出处。
      const result = await call('/v0/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: input.address,
          endpoint: input.endpoint,
          ...(input.capabilities === undefined
            ? {}
            : { capabilities: input.capabilities }),
          ...(input.publicKey === undefined
            ? {}
            : { publicKey: input.publicKey }),
          ...(input.status === undefined ? {} : { status: input.status }),
        }),
      })
      if (!result.ok) return result
      return oneAgent(result.value)
    },

    async deregister(address: string): Promise<ConsoleResult<void>> {
      const encoded = segment(address)
      if (!encoded.ok) return encoded
      const result = await call(`/v0/agents/${encoded.value}`, {
        method: 'DELETE',
      })
      if (!result.ok) return result
      return { ok: true, value: undefined }
    },

    async heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>> {
      const encoded = segment(address)
      if (!encoded.ok) return encoded
      const result = await call(`/v0/agents/${encoded.value}/heartbeat`, {
        method: 'POST',
      })
      if (!result.ok) return result
      return oneAgent(result.value)
    },
  }
}

// ---------------------------------------------------------------------------
// AuditPort —— 本机审计链，只读
// ---------------------------------------------------------------------------

/** 不指定 `limit` 时给的尾部条数，与 `occ audit --limit` 的默认值一致。 */
export const DEFAULT_AUDIT_LIMIT = 200

/**
 * 尾部条数的兜底上限。
 *
 * **不是**生效的那个天花板——查询串上的 `limit` 由 HTTP 面的
 * `MAX_AUDIT_LIMIT`（`packages/console/src/http.ts`，当前 500）夹过一道，所以
 * 从页面来的值永远比这里小，这条永远不触发。它存在是因为 `AuditPort` 是个公开
 * 接口，直接拿着 `limit: 1e9` 调它的调用方（测试、将来的第二个前端）不该把
 * `readTrail` 一次性读进内存的那整个文件都渲染出去。两个数字不会打架：这条严格
 * 更宽松，HTTP 面收紧它是安全的。
 */
const AUDIT_TAIL_BACKSTOP = 10_000

const AUDIT_SOURCES: ReadonlySet<string> = new Set(Object.values(AuditSource))
const AUDIT_OUTCOMES: ReadonlySet<string> = new Set([
  'ok',
  'refused',
  'dropped',
])

type AuditWitnessReader = (node: string) => Promise<readonly WitnessEvidence[]>

interface AuditPortOptions {
  /** 审计链文件的绝对路径。 */
  readonly path: string
  /** Absent until the console is given `--anchors`. */
  readonly witness?: AuditWitnessSource
  /**
   * Node keys established on the console side (`--trust` / `--trust-ca`,
   * `consoleWitnessKeys.ts`). Never a registry row: that is K-11 F-3.
   */
  readonly publicKeyOf?: (node: string) => Promise<ConsoleResult<string>>
  /**
   * The trail is an audit mirror (`--audit-mirror`): a copy of the node's
   * chain as of its last pull. Anchors past its end are reported as not yet
   * covered instead of as a mismatch; see `verifyAuditWitness`'s `prefix`.
   */
  readonly mirror?: boolean
  /** Optional only for direct callers; production reads the environment. */
  readonly witnessReadToken?: string
  /** Direct callers may provide the reader; production uses the parsed source. */
  readonly witnessReader?: AuditWitnessReader
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_AUDIT_LIMIT
  return Math.min(AUDIT_TAIL_BACKSTOP, Math.max(1, Math.floor(raw)))
}

/**
 * 一次读取落在四态里的哪一态（issue #9②）。
 *
 * 顺序不能换：先问「有没有文件」，再问「链验不验得过」，最后才问「有没有
 * 记录」。倒过来问会让**没有文件**这一态被空记录吃掉——而那正是内测环境里
 * 每 5 分钟失败一次的镜像链路在控制台上显示成「链完整」的那条路径。
 */
function chainStateOf(read: TrailReadResult): AuditChainState {
  if (!read.present) return 'absent'
  if (!read.intact) return 'broken'
  return read.records.length === 0 ? 'empty' : 'intact'
}

/**
 * 审计链的只读面。
 *
 * **文件不存在返回空页，不是失败**：一个刚起来、还没产生过任何审计记录的节点
 * 是完全正常的状态，把它渲染成红色的「读取失败」会让第一次用控制台的人以为
 * 自己装坏了。`readTrail` 自己就把 ENOENT 当空文件处理，这里只需要不把别的
 * IO 错误（比如权限）混进同一个桶。
 *
 * **但「不是失败」不等于「完整」**：文件不存在与文件存在且为空是两件事，
 * 由 `chain` 分开表述，`intact` 只对前者收回背书（`AuditChainState`）。
 *
 * **只读**：这个端口没有任何写审计链的路径。审计链的写入口只有节点进程自己
 * （append-only fd），控制台连一个能追加的方法都不该有。
 */
export function createAuditPort(options: AuditPortOptions): AuditPort {
  function load(): ConsoleResult<TrailReadResult> {
    try {
      return { ok: true, value: readTrail(options.path) }
    } catch (error) {
      return fail(
        'unreachable',
        `审计链读不出来 ${options.path}：${messageOf(error)}`,
      )
    }
  }

  return {
    async read(filter: AuditFilter) {
      // 过滤条件先校验：一个拼错的 source 静默匹配到零条，会让人以为「这段
      // 时间什么都没发生」，而实际上是问错了问题。
      const source = filter.source
      if (source !== undefined && source !== '' && !AUDIT_SOURCES.has(source)) {
        return fail('invalid', `未知的审计来源 ${JSON.stringify(source)}`)
      }
      const outcome = filter.outcome
      if (
        outcome !== undefined &&
        outcome !== '' &&
        !AUDIT_OUTCOMES.has(outcome)
      ) {
        return fail('invalid', `未知的结果 ${JSON.stringify(outcome)}`)
      }
      for (const [name, value] of [
        ['from', filter.from],
        ['to', filter.to],
      ] as const) {
        if (value !== undefined && !Number.isFinite(value)) {
          return fail('invalid', `${name} 必须是 epoch 毫秒`)
        }
      }

      const loaded = load()
      if (!loaded.ok) return loaded
      const { records, issues } = loaded.value
      const chain = chainStateOf(loaded.value)

      let witness:
        | {
            readonly tampered: boolean
            readonly stale: boolean
            readonly uncovered?: true
          }
        | undefined
      if (options.witness !== undefined) {
        try {
          const node = witnessNodeOf(records)
          if (node === null) {
            // A new trail cannot have an anchor yet. Keep the configured-but-
            // empty case visibly distinct from the green integrity state.
            witness = { tampered: false, stale: true }
          } else if (options.publicKeyOf === undefined) {
            return fail('invalid', '见证验证没有节点公钥来源')
          } else {
            const publicKey = await options.publicKeyOf(node)
            if (!publicKey.ok) return publicKey
            const anchors = await (
              options.witnessReader ??
              (requestedNode =>
                readAuditWitnessAnchors(
                  options.witness as AuditWitnessSource,
                  requestedNode,
                  options.witnessReadToken,
                ))
            )(node)
            const verification = verifyAuditWitness({
              trailPath: options.path,
              anchors,
              publicKey: publicKey.value,
              ...(options.mirror === true ? { prefix: true } : {}),
            })
            witness = {
              tampered: verification.tampered,
              stale: verification.stale,
              // Present only when true, so an authoritative trail's page keeps
              // exactly the shape it had before mirrors were told apart.
              ...(verification.issues.some(issue => issue.kind === 'uncovered')
                ? { uncovered: true as const }
                : {}),
            }
          }
        } catch (error) {
          return fail('unreachable', `见证端点不可达：${messageOf(error)}`)
        }
      }

      const query: TrailQuery = {
        ...(source === undefined || source === ''
          ? {}
          : { source: source as AuditSource }),
        ...(outcome === undefined || outcome === ''
          ? {}
          : { outcome: outcome as 'ok' | 'refused' | 'dropped' }),
        ...(filter.traceId === undefined || filter.traceId === ''
          ? {}
          : { traceId: filter.traceId }),
        ...(filter.taskId === undefined || filter.taskId === ''
          ? {}
          : { taskId: filter.taskId }),
        ...(filter.agent === undefined || filter.agent === ''
          ? {}
          : { agent: filter.agent }),
        ...(filter.from === undefined ? {} : { from: filter.from }),
        ...(filter.to === undefined ? {} : { to: filter.to }),
      }

      // 取**尾部** limit 条，和 `occ audit --limit` 同一语义
      // （`qianmoAudit.ts` 第 198 行）：一条链上最近发生的事才是被找的那些。
      const matched = queryTrail(records, query).slice(
        -clampLimit(filter.limit),
      )
      return {
        ok: true,
        value: {
          records: matched,
          chain,
          // 只有「有链且没毛病」才算完整——空链算，缺文件不算。
          intact: chain === 'intact' || chain === 'empty',
          issueCount: issues.length,
          // 过滤前的总数，页面据此说「共 M 条中的 N 条」。
          total: records.length,
          ...(witness === undefined ? {} : { witness }),
        },
      }
    },

    async chain(traceId: string) {
      if (traceId.trim() === '') {
        return fail('invalid', 'trace id 不能为空')
      }
      const loaded = load()
      if (!loaded.ok) return loaded
      // `reconstructChain` 从不按 outcome 过滤——被拒、被丢、被去重的都在里面，
      // 那正是 P7.2 判据里「完整」两个字的意思。
      return {
        ok: true,
        value: reconstructChain(loaded.value.records, traceId),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// CertificatePort —— 证书栏（key-distribution.md §10.1）
// ---------------------------------------------------------------------------

/**
 * 到期提醒的两道门限，都只写在这里，节点证书与 CA 根共用。
 *
 * §6.2 的提醒机制原文：剩余 < 21 天黄条、< 7 天红条。门限在这里换成状态
 * （`expiring` / `expiring-urgent`），颜色由视图按状态查 tone 表——门限若在
 * 视图里再写一遍，就是两处可以各自漂移的门限。已过期是第四档，不借用红条那
 * 一档：它的下一步不是「赶在到期前重签」，而是「这个节点现在已经被拒」。
 */
const CERTIFICATE_EXPIRING_MS = 21 * 24 * 60 * 60 * 1000
const CERTIFICATE_URGENT_MS = 7 * 24 * 60 * 60 * 1000

/** 一个 `notAfter` 在 `now` 时落在哪一档。叶证书与根都经这一个函数。 */
function expiryStatusOf(
  notAfter: number,
  now: number,
): ConsoleCaRoot['status'] {
  if (now >= notAfter) return 'expired'
  if (notAfter - now < CERTIFICATE_URGENT_MS) return 'expiring-urgent'
  if (notAfter - now < CERTIFICATE_EXPIRING_MS) return 'expiring'
  return 'valid'
}

interface CertificatePortOptions {
  /** 注册中心 HTTP v0 基址，不带尾斜杠。 */
  readonly baseUrl: string
  /**
   * CA 根证书 PEM——**公开材料**，控制台读它是为了做 F-2 那一次校验。换根
   * 重叠期（§3.3）里可以是新旧两张根，两张都用，与节点侧同一个解析函数。
   */
  readonly caCertificatePem: string
  readonly fetch?: ConsoleFetch
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** 从一条 agent 记录里读出节点段；读不出来就没有这条。 */
function nodeSegmentOf(value: unknown): string | null {
  if (!isRecord(value)) return null
  const address = value['address']
  if (typeof address !== 'string') return null
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)\//i.exec(address)
  return match?.[1] ?? null
}

/**
 * 判定一张证书的处置——§10.1 的取值，`expiring` 按 §6.2 分成两档。
 *
 * **顺序是有讲究的**：先问「有没有」，再问「是不是本 CA 签的」，最后才问时间与
 * 吊销。倒过来问会让一张伪造证书按它自己写的 `notAfter` 显示成「有效」——而
 * 「注册中心零鉴权，谁都能往里塞一张」正是 §5.2 T-B 的原话。
 *
 * 报出的 `notAfter` 是证书与签它的那张根**取早**的那个：根过期了，叶在 TLS 层
 * 同样被拒，页面不该还显示「剩余 60d」。
 */
function certificateStatusOf(
  pem: unknown,
  anchors: ReturnType<typeof parseTrustAnchors>,
  revoked: ReadonlySet<string>,
  now: number,
): { status: CertificateStatus; fingerprint256?: string; notAfter?: number } {
  if (typeof pem !== 'string' || pem.length === 0) return { status: 'absent' }
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(pem)
  } catch {
    // 解析不出来的东西不是「过期」也不是「未发布」，它是别人塞进来的。
    return { status: 'bad-signature' }
  }
  const fingerprint256 = certificate.fingerprint256
  const validity = anchoredValidity(anchors, certificate)
  if (validity === null) {
    return {
      status: 'bad-signature',
      fingerprint256,
      notAfter: Date.parse(certificate.validTo),
    }
  }
  const notAfter = validity.notAfter
  if (revoked.has(fingerprint256)) {
    return { status: 'revoked', fingerprint256, notAfter }
  }
  return { status: expiryStatusOf(notAfter, now), fingerprint256, notAfter }
}

/**
 * 证书栏的数据源：注册中心的 agents 表 + 吊销清单，本地 CA 根做校验。
 *
 * **控制台在这里只读、只校验、不签发**（§10.2/§10.3）。它拿到的三样东西——
 * agents 表、RL、CA 根证书——全是公开材料；任何私钥都没有路径能到这个进程里来。
 *
 * RL 的签名**由这里验**（`verifyRevocationList`），理由与节点侧同一条：注册中心
 * 零鉴权，一份没验签的 RL 等于任何人都能在页面上宣布任意节点被吊销。验不过就当
 * 没有——`revocationList: null` 与「从没发布过」在页面上是同一行，因为对运维来说
 * 下一步动作也是同一个。
 */
export function createCertificatePort(
  options: CertificatePortOptions,
): CertificatePort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS
  const now = options.now ?? Date.now
  const doFetch: ConsoleFetch =
    options.fetch ?? ((input, init) => fetch(input, init))
  // 构造时解析整份根证书文件，坏了就在这里抛——控制台随之起不来，与节点同一
  // 条规矩：少了一张根还照常起的服务，看上去配好了，实际拒掉半个网络。
  const anchors = parseTrustAnchors(options.caCertificatePem, '--trust-ca')

  async function get(path: string): Promise<unknown> {
    const response = await doFetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }

  return {
    roots(): readonly ConsoleCaRoot[] {
      const at = now()
      return anchors.anchors.map(anchor => ({
        // 多个 RDN 的 subject 每项占一行，拼成一行显示。
        subject: anchor.certificate.subject.replace(/\n/g, ', '),
        notAfter: anchor.notAfter,
        status: expiryStatusOf(anchor.notAfter, at),
      }))
    },

    async read(): Promise<ConsoleResult<CertificateSnapshot>> {
      let agentsBody: unknown
      let rlBody: unknown
      try {
        ;[agentsBody, rlBody] = await Promise.all([
          get('/v0/agents'),
          get('/v0/revocation-list'),
        ])
      } catch (error) {
        return fail(
          'unreachable',
          `注册中心不可达 ${baseUrl}：${messageOf(error)}`,
        )
      }
      const agents = isRecord(agentsBody) ? agentsBody['agents'] : undefined
      if (!Array.isArray(agents)) {
        return fail('invalid', '注册中心返回的不是 agents 列表')
      }

      const at = now()
      const verified =
        rlBody === undefined
          ? null
          : verifyRevocationListByAnchors(anchors, rlBody, at)
      const revoked = new Set(
        (verified?.revoked ?? []).map(entry => entry.fingerprint256),
      )

      const certificates: ConsoleCertificate[] = []
      const seen = new Set<string>()
      for (const raw of agents) {
        const node = nodeSegmentOf(raw)
        // 一个节点一张证书，而名册里一个节点可以有多个 agent —— 先到的那条
        // 胜出，因为它们本来就该是同一张（注册中心对不一致的记录整条丢弃，
        // §5.2）。
        if (node === null || seen.has(node)) continue
        seen.add(node)
        certificates.push({
          node,
          ...certificateStatusOf(
            isRecord(raw) ? raw['certificate'] : undefined,
            anchors,
            revoked,
            at,
          ),
        })
      }

      return {
        ok: true,
        value: {
          certificates,
          revocationList:
            verified === null
              ? null
              : {
                  issuedAt: verified.issuedAt,
                  nextUpdate: verified.nextUpdate,
                  revokedCount: verified.revoked.length,
                },
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// LimitsSnapshot —— 三个包各自的数字，一个都不抄
// ---------------------------------------------------------------------------

export function consoleLimits(): LimitsSnapshot {
  return {
    protocol: {
      maxMessageBytes: LIMITS.maxMessageBytes,
      maxHops: LIMITS.maxHops,
      defaultTtlMs: LIMITS.defaultTtlMs,
      defaultTaskTtlMs: LIMITS.defaultTaskTtlMs,
      ratePerMinute: LIMITS.ratePerMinute,
    },
    runtime: {
      capacity: RUNTIME_RATE.capacity,
      windowMs: RUNTIME_RATE.windowMs,
    },
    registryTtlMs: DEFAULT_TTL_MS,
  }
}

// ---------------------------------------------------------------------------
// WakePort —— 复用 `occ resident-wake` 的那一条发送路径
// ---------------------------------------------------------------------------

/**
 * 页面能排的最长延时。
 *
 * `executeResidentWake` 是**先等够 `afterMs` 再发**，而这个端口是在一个 HTTP
 * 请求里被调用的——一个十分钟的定时唤醒等于一个挂十分钟的请求，浏览器早就断了，
 * 而节点这边还在等。真要排长定时器，用 `occ resident-wake --after-ms`，那是个
 * 可以自己活着的进程。
 */
const MAX_CONSOLE_WAKE_AFTER_MS = 60_000

/** 连接 + 等回执的预算。 */
const DEFAULT_CONSOLE_WAKE_TIMEOUT_MS = 30_000

interface WakePortOptions {
  /** 唤醒目标（激活器）的 ws/wss 地址——这个端口只往这一个地方发。 */
  readonly url: string
  /** 传输层 PSK。**只从环境变量来**，不从命令行、更不从页面来。 */
  readonly psk: string
  /**
   * 控制台的唤醒签发器（`consoleWakeIdentity.ts`）。**给了才签**。
   *
   * 默认不签是刻意的，不是省事：一枚对面解析不出签发方公钥的令牌，在
   * `OPEN_POLICY` 和 `SIGNED_TASK_POLICY` 下**同样**被拒成 `E_CAP_INVALID`
   * （`packages/capability/src/token.ts` 的 `publicKeyOf(...) === null` 分支）。
   * 所以「默认签」会立刻打断今天所有还没分发过控制台公钥的部署，而这正是
   * issue #14 要求这条能力是**增量**而不是切换的原因。先分发信任，再打开签名。
   */
  readonly capability?: WakeCapabilityIssuer
  readonly timeoutMs?: number
  readonly deliverTtlMs?: number
}

/**
 * 一次唤醒失败到底属于哪一类，这里只分三类，且**三类互不重叠**。
 *
 * - `refused`：对面拿到了信封，自己决定不做（issue #29）。握手成功、投递成功、
 *   节点主动拒绝——把它说成不可达，等于让人去查隧道和端口，而那条链路是好的。
 * - `rejected`：**本机**这一侧的规则不让发。路由器的本地拒绝长这样：
 *   `E_LOOP: ...`、`E_RUNTIME_THROTTLED: ...`（`packages/router/src/router.ts`
 *   的 `reject()`），此外还有本端口自己对钉死 URL 的拒绝。
 * - `unreachable`：**只**留给真的没到达——拨号失败、重连预算耗尽、回执始终没来。
 */
function classifyWakeError(error: unknown): ConsoleFailure['code'] {
  if (error instanceof WakeRefusedError) return 'refused'
  return /^E_[A-Z_]+:/.test(messageOf(error)) ? 'rejected' : 'unreachable'
}

/**
 * 操作面上的那一句。
 *
 * 两个分支给的东西不同，是刻意的：拿到原因就把原因原样给出去（`E_CAP_INSUFFICIENT`
 * 这个字必须出现在操作面上，issue #10 / #14 的排查文档一直按它写）；没拿到原因就
 * 给 msgId，因为那时它是操作者去节点审计链里捞这条记录的唯一抓手。
 */
function wakeFailureMessage(error: unknown): string {
  if (!(error instanceof WakeRefusedError)) return messageOf(error)
  const detail = error.detail
  return detail === undefined
    ? `节点拒绝了这条唤醒 · 原因见该节点的审计链 · msg ${error.msgId}`
    : `节点拒绝了这条唤醒 · ${detail.code} · ${detail.reason}`
}

/**
 * 唤醒面。
 *
 * **目标地址钉死在启动参数上**，页面传来的 `url` 只被允许等于它（或留空）。
 * 否则这个端口就是一个「任何能打开控制台的人都能让本机往任意 ws 地址发一条
 * 带 PSK 握手的消息」的转发器，而控制台的 admin token 门槛远低于「能改本机
 * systemd 单元」。
 */
export function createWakePort(options: WakePortOptions): WakePort {
  const pinned = new URL(options.url).toString()
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONSOLE_WAKE_TIMEOUT_MS
  const deliverTtlMs = options.deliverTtlMs ?? timeoutMs

  return {
    async send(input: WakeInput) {
      try {
        assertAddress(input.from, 'from')
        assertAddress(input.to, 'to')
      } catch (error) {
        return fail('invalid', messageOf(error))
      }
      if (input.prompt.trim() === '') {
        return fail('invalid', 'prompt 不能为空')
      }

      const requested = input.url.trim()
      if (requested !== '') {
        let normalized: string
        try {
          normalized = new URL(requested).toString()
        } catch (error) {
          return fail('invalid', messageOf(error))
        }
        if (normalized !== pinned) {
          return fail(
            'rejected',
            `控制台只向 ${pinned} 发唤醒；要换目标请重启控制台并改 --wake-url`,
          )
        }
      }

      const afterMs = input.afterMs ?? 0
      if (
        !Number.isInteger(afterMs) ||
        afterMs < 0 ||
        afterMs > MAX_CONSOLE_WAKE_AFTER_MS
      ) {
        return fail(
          'invalid',
          `延时必须是 0 到 ${MAX_CONSOLE_WAKE_AFTER_MS} 之间的整毫秒数；` +
            '更长的定时唤醒请用 occ resident-wake --after-ms',
        )
      }

      try {
        const result = await executeResidentWake(
          {
            url: pinned,
            from: input.from,
            to: input.to,
            prompt: input.prompt,
            afterMs,
            timeoutMs,
            deliverTtlMs,
            ...(options.capability === undefined
              ? {}
              : { issueCapability: options.capability }),
          },
          options.psk,
        )
        return {
          ok: true,
          value: {
            msgId: result.msgId,
            taskId: result.taskId,
            receipt: result.receipt,
          },
        }
      } catch (error) {
        return fail(classifyWakeError(error), wakeFailureMessage(error))
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 服务器备注
// ---------------------------------------------------------------------------

interface ServerNotesPortOptions {
  /** 已经拿到路径的 store。路径的出处只有 `consoleArgs.ts` 一个。 */
  readonly store: ServerNotesStore
  /** 可注入，只为让用例能钉住 `updatedAt`。 */
  readonly now?: () => number
}

/**
 * 备注面。
 *
 * **回放一次，之后读全在内存里。**备注是一份人手写的、以台计的小表，而
 * `list()` 被每一次页面渲染调用；每次渲染重读一遍文件只是把一个不会变的答案
 * 重新算一遍。写入仍然是同步 append，所以「写成功」与「落盘」之间没有窗口。
 *
 * 内存那份**在 append 成功之后**才更新：磁盘满或目录不可写时，页面必须看到
 * 保存失败，而不是看到一条重启后就消失的备注。
 *
 * 这个端口**不判白名单**——「这台服务器是不是启动时钉住的那几台之一」由
 * `http.ts` 拿 `ConsoleDeps.nodeServers` 判定，理由与唤醒目标同一条：允许写的
 * 集合是启动参数定的，不是请求体定的。
 */
export function createServerNotesPort(
  options: ServerNotesPortOptions,
): ServerNotesPort {
  const now = options.now ?? Date.now
  const cache = new Map<string, ServerNote>()
  for (const note of options.store.load()) cache.set(note.server, note)

  return {
    list(): Promise<ConsoleResult<readonly ServerNote[]>> {
      return Promise.resolve({ ok: true, value: [...cache.values()] })
    },
    set(server: string, note: string): Promise<ConsoleResult<ServerNote>> {
      const record: ServerNote = { server, note, updatedAt: now() }
      try {
        options.store.append(record)
      } catch (error) {
        // `unreachable` 而不是 `rejected`：请求本身没有任何问题，是这台机器
        // 上的文件写不进去。它落成 503，而 `rejected` 会落成 400 并让调用方
        // 以为是自己送错了东西（`http.ts` 的 `statusFor`）。
        return Promise.resolve(
          fail('unreachable', `备注写入失败：${messageOf(error)}`),
        )
      }
      cache.set(server, record)
      return Promise.resolve({ ok: true, value: record })
    },
  }
}
