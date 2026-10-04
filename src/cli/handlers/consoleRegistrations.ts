// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台的登记簿与续租者：页面上的「注册」活过租约（P15.2 的最小内核）。
 *
 * ## 缺陷
 *
 * 注册中心的租约是 `DEFAULT_TTL_MS`（90 s），过期条目从 `list()` / `resolve()`
 * 消失。控制台原先只有按需心跳（人点按钮才续），注册中心宿主
 * （`demo/lib/p81-registry.ts`）只替启动参数里的 `--register` 续租，节点从不拨号。
 * 于是页面上注册成功的条目没有任何续租方，90 s 后就不在名册里了。
 *
 * ## 续租者为什么住在控制台进程里
 *
 * P15 草案（`tenancy-m1.md` §3.6，v0.1-draft）写的是「续租者住在注册中心进程旁」。
 * 这里选了控制台，理由见 `docs/dev/console.md` §7.3，要点：
 *
 * - **意图归控制台。**「这条是页面上注册的、要一直在」是 admin token 背后的一个
 *   决定；注册中心零鉴权（console.md §8.2），把这份意图放到它那边，就是让任何够得着
 *   它端口的人一次 POST 就能造出一条永不过期的登记。
 * - **注册中心 HTTP v0 零改动。**注册中心侧的续租者要知道哪些条目是控制台注册的，
 *   只能加字段 / 加路由，或者两个进程共享一个文件（内测里两者配置根不同）。放在控制台
 *   就只用既有的 `POST /v0/agents`，新控制台配旧注册中心照样全功能。
 * - **控制台是产品面，注册中心宿主不是。**没有 `qm registry` 子命令，宿主只是 demo
 *   脚本；而验收腿的注册中心本来就是进程内的 `startRegistryServer`，续租者在控制台里
 *   才会被真实路径覆盖。
 *
 * 代价：控制台停机超过一个 TTL，它登记的条目按租约消失，直到控制台回来（启动即重新
 * 宣告）。`--register` 那批种子由注册中心宿主续，不受影响。
 *
 * ## 续租用 `POST /v0/agents`，不用心跳
 *
 * 每一轮把登记簿里的整条声明原样再注册一次：
 *
 * - 同一端点 → 200，等于续租，同时把能力 / 状态重新声明一遍；
 * - 注册中心刚重启、表上没有 → 201，条目回来；
 * - 地址被**另一个端点**占着 → 409，注册中心什么都不改。续租者不抢（与
 *   `register()` 防劫持同一条规矩），只出声、下一轮再试。
 *
 * 心跳做不到第三条：它不看端点，会替占着这个地址的别人续租。
 *
 * ## 周期
 *
 * `renewIntervalFor(租约)`（`@qianmo/registry`）：默认租约下 20 s，与
 * `p81-registry.ts` 同一个出处。租约取注册中心回执里的 `expiresAt − lastHeartbeatAt`
 * （`rosterLease`，C-1 那条「以注册中心为准」），没有回执时用 `DEFAULT_TTL_MS`。
 * 租约变短时下一轮提前，不会让新登记的一条在第一次续租之前就过期。
 *
 * ## 落盘
 *
 * 路径由 `consoleArgs.ts` 从 `occConfigPath()` 派生；写入复用 `FileRegistryStore`
 * （同目录临时文件 `wx` 创建 + fsync + rename，P2.1）。文档形状：
 * `{ version: 1, registrations: [{ address, endpoint, capabilities?, publicKey?, status? }] }`。
 * 与注册中心的表不同，这是**意图**而不是软状态：读不动的文件不当空文件覆盖掉，
 * 改名挪开（`.unreadable-<ISO>`）留证，再从空登记簿起。写失败不让请求失败——内存里
 * 那份照样续租，只在控制台重启时丢——但一定出声。
 */

import { existsSync, renameSync } from 'node:fs'
import {
  rosterLease,
  type ConsoleAgent,
  type ConsoleFailure,
  type ConsoleResult,
  type RegisterAgentInput,
  type RegistryPort,
} from '@qianmo/console'
import {
  DEFAULT_TTL_MS,
  FileRegistryStore,
  renewIntervalFor,
} from '@qianmo/registry'

/** 登记簿文档的版本。别的版本整份当作读不动（挪开，不猜）。 */
export const REGISTRATION_LEDGER_VERSION = 1

/** stderr 行的前缀，与 `console chat:` 同一个写法。 */
const LOG_PREFIX = 'console registrations:'

/** 一轮续租里一条地址的结果。 */
type RenewOutcome =
  | { readonly kind: 'renewed'; readonly address: string }
  /** 这一轮在路上时它被注销了；续租那次 POST 可能把它建了回来，已补一次 DELETE。 */
  | { readonly kind: 'withdrawn'; readonly address: string }
  | {
      readonly kind: 'failed'
      readonly address: string
      readonly failure: ConsoleFailure
    }

/** 排一次延时任务，返回取消函数。测试换成手动触发的那一个。 */
export type RenewScheduler = (
  task: () => Promise<void>,
  delayMs: number,
) => () => void

interface ConsoleRegistrationsOptions {
  /** 登记簿的绝对路径（`consoleRegistrationsPath()`）。 */
  readonly path: string
  /** 注册中心 HTTP v0 那个端口（`createRegistryPort`）。 */
  readonly registry: RegistryPort
  readonly schedule?: RenewScheduler
  /** 出声的地方；生产是 stderr。 */
  readonly log?: (line: string) => void
  /** 只用来排「下一轮什么时候」和给挪开的文件起名。 */
  readonly now?: () => number
}

const defaultSchedule: RenewScheduler = (task, delayMs) => {
  const timer = setTimeout(() => void task(), delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 盘上一条 → 一条声明；形状不对返回 null。
 *
 * 只查类型，不查取值：地址、端点、能力条数的规矩住在注册中心，下一轮续租时它会
 * 如实拒绝，在这里再抄一份就是第二个会漂移的出处（`consolePorts.ts` 同一条）。
 */
function toDeclaration(value: unknown): RegisterAgentInput | null {
  if (!isRecord(value)) return null
  const address = value['address']
  const endpoint = value['endpoint']
  const capabilities = value['capabilities']
  const publicKey = value['publicKey']
  const status = value['status']
  if (typeof address !== 'string' || address === '') return null
  if (typeof endpoint !== 'string' || endpoint === '') return null
  if (
    capabilities !== undefined &&
    !(
      Array.isArray(capabilities) &&
      capabilities.every(item => typeof item === 'string')
    )
  ) {
    return null
  }
  if (publicKey !== undefined && typeof publicKey !== 'string') return null
  if (status !== undefined && typeof status !== 'string') return null
  return declarationOf(
    {
      address,
      endpoint,
      ...(capabilities === undefined
        ? {}
        : { capabilities: capabilities as string[] }),
      ...(publicKey === undefined ? {} : { publicKey }),
      ...(status === undefined ? {} : { status }),
    },
    address,
  )
}

/** 页面给的那份输入，地址换成注册中心回执里的规范写法。 */
function declarationOf(
  input: RegisterAgentInput,
  address: string,
): RegisterAgentInput {
  return {
    address,
    endpoint: input.endpoint,
    ...(input.capabilities === undefined
      ? {}
      : { capabilities: [...input.capabilities] }),
    ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
    ...(input.status === undefined ? {} : { status: input.status }),
  }
}

/** 整份文档 → 声明列表；版本或外形不对返回 null。 */
function readLedger(document: unknown): {
  readonly entries: readonly RegisterAgentInput[]
  readonly dropped: number
} | null {
  if (!isRecord(document)) return null
  if (document['version'] !== REGISTRATION_LEDGER_VERSION) return null
  const list = document['registrations']
  if (!Array.isArray(list)) return null
  const entries: RegisterAgentInput[] = []
  let dropped = 0
  for (const item of list as readonly unknown[]) {
    const declaration = toDeclaration(item)
    if (declaration === null) dropped += 1
    else entries.push(declaration)
  }
  return { entries, dropped }
}

/**
 * 登记簿 + 续租者。`port` 交给 `ConsoleDeps.registry`，`start()` 之后开始续租。
 */
export class ConsoleRegistrations {
  /** 包在注册中心端口外的那一层：注册成功入簿，注销先出簿，其余透传。 */
  readonly port: RegistryPort

  readonly #path: string
  readonly #store: FileRegistryStore
  readonly #registry: RegistryPort
  readonly #schedule: RenewScheduler
  readonly #log: (line: string) => void
  readonly #now: () => number
  readonly #entries = new Map<string, RegisterAgentInput>()
  /** 每条地址最近一次失败的原文，只为「状态变了才出声」。 */
  readonly #failing = new Map<string, string>()
  #leaseMs = DEFAULT_TTL_MS
  #running = false
  #cancel: (() => void) | null = null
  /** 已排上的下一轮的时刻；一轮在路上时为 null。 */
  #dueAt: number | null = null

  constructor(options: ConsoleRegistrationsOptions) {
    this.#path = options.path
    this.#store = new FileRegistryStore(options.path)
    this.#registry = options.registry
    this.#schedule = options.schedule ?? defaultSchedule
    this.#log = options.log ?? (() => {})
    this.#now = options.now ?? Date.now
    this.#load()
    this.port = {
      list: async () => await this.#registry.list(),
      register: async input => await this.#register(input),
      deregister: async address => await this.#deregister(address),
      heartbeat: async address => await this.#heartbeat(address),
    }
  }

  /** 登记簿文件。进 banner，不是秘密。 */
  get path(): string {
    return this.#path
  }

  /** 登记簿里的地址，排好序。 */
  get addresses(): readonly string[] {
    return [...this.#entries.keys()].sort()
  }

  /** 现在按哪个租约排续租。 */
  get leaseMs(): number {
    return this.#leaseMs
  }

  /** 立刻续一轮，之后按周期续，直到 {@link stop}。重复调用无副作用。 */
  start(): void {
    if (this.#running) return
    this.#running = true
    void this.#cycle()
  }

  /** 停止续租。已发出的租约照常到期；登记簿不动，下次启动接着续。 */
  stop(): void {
    this.#running = false
    this.#cancel?.()
    this.#cancel = null
    this.#dueAt = null
  }

  /** 对登记簿里每一条各重新声明一次。续租者的一轮；测试直接调它。 */
  async renewNow(): Promise<readonly RenewOutcome[]> {
    const declarations = [...this.#entries.values()]
    return await Promise.all(
      declarations.map(declaration => this.#renewOne(declaration)),
    )
  }

  async #cycle(): Promise<void> {
    if (!this.#running) return
    this.#cancel = null
    this.#dueAt = null
    try {
      await this.renewNow()
    } catch (error) {
      // 端口按约定不抛；真抛了是编程错误，也不能让续租从此停掉。
      this.#log(`${LOG_PREFIX} renewal round failed: ${messageOf(error)}`)
    }
    this.#arm(renewIntervalFor(this.#leaseMs))
  }

  #arm(delayMs: number): void {
    if (!this.#running) return
    this.#cancel?.()
    this.#dueAt = this.#now() + delayMs
    this.#cancel = this.#schedule(async () => await this.#cycle(), delayMs)
  }

  async #renewOne(declaration: RegisterAgentInput): Promise<RenewOutcome> {
    const { address } = declaration
    const result = await this.#registry.register(declaration)
    if (!result.ok) {
      const text = `${result.failure.code}: ${result.failure.message}`
      if (this.#failing.get(address) !== text) {
        this.#failing.set(address, text)
        this.#log(`${LOG_PREFIX} renew ${address} failed (${text})`)
      }
      return { kind: 'failed', address, failure: result.failure }
    }
    this.#observeLease(result.value)
    if (!this.#entries.has(address)) {
      // 注销先出簿再发 DELETE，而这一轮的 POST 可能晚于那个 DELETE 到达注册中心，
      // 把条目又建了回来。这里看得见这件事，就在这里收掉。
      await this.#registry.deregister(address)
      return { kind: 'withdrawn', address }
    }
    if (this.#failing.delete(address)) {
      this.#log(`${LOG_PREFIX} renew ${address} recovered`)
    }
    return { kind: 'renewed', address }
  }

  async #register(
    input: RegisterAgentInput,
  ): Promise<ConsoleResult<ConsoleAgent>> {
    const result = await this.#registry.register(input)
    // 只有注册中心收下的才入簿：被拒的、不可达的，页面上已经如实报错了。
    if (!result.ok) return result
    const address = result.value.address
    this.#entries.set(address, declarationOf(input, address))
    this.#failing.delete(address)
    this.#persist()
    this.#observeLease(result.value)
    return result
  }

  async #deregister(address: string): Promise<ConsoleResult<void>> {
    // 先出簿：从这一刻起续租者不再碰它，哪怕下面的 DELETE 失败，租约也会自然到期。
    const held = this.#entries.delete(address)
    if (held) {
      this.#failing.delete(address)
      this.#persist()
    }
    const result = await this.#registry.deregister(address)
    if (!result.ok && held && result.failure.code === 'not_found') {
      // 簿里有、表上没有（租约刚过期，或注册中心刚重启还没等到下一轮）：
      // 要做的事——不再续租——已经做成了，这不是「没找到」。
      return { ok: true, value: undefined }
    }
    return result
  }

  async #heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>> {
    const result = await this.#registry.heartbeat(address)
    if (result.ok) this.#observeLease(result.value)
    return result
  }

  /** 按注册中心实际给的租约调周期；变短了就把已排上的那一轮提前。 */
  #observeLease(agent: ConsoleAgent): void {
    this.#leaseMs = rosterLease([agent], this.#leaseMs)
    const interval = renewIntervalFor(this.#leaseMs)
    if (this.#dueAt !== null && this.#now() + interval < this.#dueAt) {
      this.#arm(interval)
    }
  }

  #load(): void {
    if (!existsSync(this.#path)) return
    const document = this.#store.read()
    const parsed = document === null ? null : readLedger(document)
    if (parsed === null) {
      const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, '-')
      const aside = `${this.#path}.unreadable-${stamp}`
      try {
        renameSync(this.#path, aside)
        this.#log(
          `${LOG_PREFIX} ${this.#path} is unreadable; moved to ${aside}, starting with an empty ledger`,
        )
      } catch (error) {
        this.#log(
          `${LOG_PREFIX} ${this.#path} is unreadable and could not be moved aside (${messageOf(error)}); starting with an empty ledger`,
        )
      }
      return
    }
    for (const entry of parsed.entries) this.#entries.set(entry.address, entry)
    if (parsed.dropped > 0) {
      this.#log(
        `${LOG_PREFIX} skipped ${String(parsed.dropped)} malformed entries in ${this.#path}`,
      )
    }
  }

  #persist(): void {
    try {
      this.#store.write({
        version: REGISTRATION_LEDGER_VERSION,
        registrations: [...this.#entries.values()],
      })
    } catch (error) {
      this.#log(
        `${LOG_PREFIX} could not write ${this.#path} (${messageOf(error)}); renewals continue from memory until this console restarts`,
      )
    }
  }
}
