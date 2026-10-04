// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台与注册中心的本地驱动。
 *
 * 三件事在这里定下来，改之前先读：
 *
 * ① **控制台是真进程，注册中心是同进程里的真服务器。**
 *    控制台必须 fork —— 要测的正是 `qm console` 这条命令行、它的 banner、
 *    以及它读 token 的三个入口。注册中心不必：它是 `@qianmo/registry` 的
 *    `startRegistryServer`（`demo/lib/p81-registry.ts` 也只是把它包了一层
 *    argv），跑在套件进程里对被测方而言是同一个 HTTP 面，还省下一次进程起停。
 *    **它不是 stub** —— 一行替身代码都没有，只是宿主换了个进程。
 *
 * ② **就绪判据是 `GET /v0/health` 答 200，不是 banner 落地。**
 *    `Bun.serve` 在 `startConsoleServer` 里同步绑口，但 banner 是之后写的，
 *    而 banner 里带着 token —— 只等 banner 会漏掉「口绑上了但还没写完」的窗口，
 *    只等健康检查又拿不到 token。所以两个都等，顺序是先 banner 后健康检查。
 *
 * ③ **token 从 banner 里抠，因为回环上它是生成的。**
 *    这条同时也在测那条产品规则：**自己生成的才回显，显式给的只打出处**
 *    （`console.ts` 的 `viewGenerated` 分支）。`console/supplied-token-not-echoed`
 *    钉住反向。
 */

import { startRegistryServer } from '@qianmo/registry'
import type { RegistryOptions } from '@qianmo/registry'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AcceptanceConsole,
  AcceptanceRegistry,
  ConsoleSpec,
  RegistrySpec,
  ScenarioContext,
} from '../types.js'
import { spawnCli, waitFor, type SpawnedProcess } from './spawn.js'

/** 一次 HTTP 往返的原文 —— 断言不成立时这就是证据。 */
export interface HttpProbe {
  readonly status: number
  readonly body: string
  /** 解析得动就给对象，解析不动是 undefined（**不抛**，「不是 JSON」也是观察）。 */
  readonly json?: Record<string, unknown>
  readonly headers: Readonly<Record<string, string>>
  /** 连接层错误原文（服务端没起来 / 被拒）。 */
  readonly error?: string
}

export interface HttpOptions {
  readonly method?: string
  readonly token?: string
  readonly body?: unknown
  /** 额外请求头；`x-qianmo-console` 默认已带上（见文件头 ③ 的 guarded 规则）。 */
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

/**
 * 打一次控制台的 HTTP 面。
 *
 * 默认带 `x-qianmo-console: 1`：guarded 路由只在**凭据来自 cookie** 时才要求
 * 这个头，而这里全走 `Authorization: Bearer`，带不带都一样 —— 带上是为了让
 * 「换成 cookie 之后仍然通」这件事不必改这个 helper。
 */
export async function http(
  url: string,
  options: HttpOptions = {},
): Promise<HttpProbe> {
  const headers: Record<string, string> = {
    'x-qianmo-console': '1',
    ...options.headers,
  }
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
    const body = await response.text()
    let json: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(body)
      json =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : undefined
    } catch {
      json = undefined
    }
    const outHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      outHeaders[key] = value
    })
    return {
      status: response.status,
      body,
      headers: outHeaders,
      ...(json === undefined ? {} : { json }),
    }
  } catch (error) {
    return {
      status: 0,
      body: '',
      headers: {},
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    }
  }
}

// ---------------------------------------------------------------------------
// 注册中心
// ---------------------------------------------------------------------------

/**
 * 起一个注册中心。
 *
 * **两条腿共用这一个实现。** 真机腿也跑它（在 runner 进程里），只是靠一条
 * 反向隧道让远端的控制台够得着 —— 见 `fleet/driver.ts` 的 `startRegistry`。
 * 那里同时写着「这样一来真机腿的注册中心那一半测的是什么」的诚实说明。
 */
export async function startRegistry(
  ctx: ScenarioContext,
  options: RegistrySpec & { readonly statePath?: string } = {},
): Promise<AcceptanceRegistry> {
  const { FileRegistryStore, InMemoryRegistry: Table } = await import(
    '@qianmo/registry'
  )
  const statePath =
    options.statePath ??
    (options.persist === true
      ? join(ctx.workdir, 'registry-state', 'agents.json')
      : undefined)
  const registryOptions: RegistryOptions = {
    ...(statePath === undefined
      ? {}
      : { store: new FileRegistryStore(statePath) }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  }
  const serverOptions =
    options.writeToken === undefined ? {} : { writeToken: options.writeToken }
  let handle = startRegistryServer(0, {
    registry: new Table(registryOptions),
    ...serverOptions,
  })
  // `restart()` 换掉的是 `handle`，所以清理必须读**当下**那一个，不能在这里
  // 把第一份闭包进去 —— 否则重启过的场景收尾时停的是一个早已停掉的服务器。
  ctx.cleanup(async () => {
    await handle.stop()
  })
  const { port, url } = handle
  return {
    url,
    hostUrl: url,
    readState: async () => {
      if (statePath === undefined) return undefined
      try {
        return readFileSync(statePath, 'utf8')
      } catch {
        return undefined
      }
    },
    restart: async () => {
      await handle.stop()
      // 新表、同一份选项、同一个端口：持久化开着就从盘上恢复，没开就是空表。
      handle = startRegistryServer(port, {
        registry: new Table(registryOptions),
        ...serverOptions,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 控制台
// ---------------------------------------------------------------------------

export interface ConsoleHandle extends AcceptanceConsole {
  readonly port: number
  readonly process: SpawnedProcess
}

/**
 * `qm console` 的 argv 与 env —— **两条腿共用这一段拼装**。
 *
 * 抽出来不是为了少写几行：控制台的命令行有五处按取值分岔（唤醒目标、
 * 签名、两枚 token 的环境变量名、尾参），两边各拼一份就等于两条腿在测
 * 两条不同的命令行，而那正是「本地绿」不再说明任何事的那一刻。
 */
export function consoleLaunch(
  spec: ConsoleSpec,
  port: number,
): { readonly argv: string[]; readonly env: Record<string, string> } {
  const argv = [
    'console',
    '--port',
    String(port),
    '--hostname',
    '127.0.0.1',
    '--registry',
    spec.registryUrl,
  ]
  for (const target of spec.wakeTargets ?? []) {
    argv.push('--wake-url', `${target.node}=${target.url}`)
  }
  if (spec.signWakes === true) argv.push('--wake-sign')
  argv.push(...(spec.extraArgs ?? []))

  const env: Record<string, string> = {}
  for (const [node, psk] of Object.entries(spec.wakePsk ?? {})) {
    env[wakePskEnvVar(node)] = psk
  }
  if (spec.viewToken !== undefined) {
    env.QIANMO_CONSOLE_VIEW_TOKEN = spec.viewToken
  }
  if (spec.adminToken !== undefined) {
    env.QIANMO_CONSOLE_ADMIN_TOKEN = spec.adminToken
  }
  return { argv, env }
}

/** 从 banner 里抠两枚 token；显式给了就用显式的（产品不回显它们）。 */
export function tokensFromBanner(
  banner: string,
  spec: ConsoleSpec,
): { readonly viewToken: string; readonly adminToken: string } {
  return {
    viewToken: spec.viewToken ?? VIEW_TOKEN_LINE.exec(banner)?.[1] ?? '',
    adminToken: spec.adminToken ?? ADMIN_TOKEN_LINE.exec(banner)?.[1] ?? '',
  }
}

/** 命名唤醒目标的 PSK 环境变量名（`consoleArgs.ts` 的 `transportPskEnvVarForNode`）。 */
function wakePskEnvVar(node: string): string {
  return `QIANMO_TRANSPORT_PSK_NODE_${Buffer.from(node, 'utf8')
    .toString('hex')
    .toUpperCase()}`
}

const VIEW_TOKEN_LINE = /^view-token\s+(\S+)/m
const ADMIN_TOKEN_LINE = /^admin-token\s+(\S+)/m

/**
 * 一次性控制台「起来了没有」的等待基准（banner 落地 + `/v0/health` 答 200）。
 *
 * 用它的地方一律乘 `ctx.timeoutScale`，纪律与理由见 `./driver.ts` 顶部
 * `NODE_READY_BUDGET_MS` 上面那段（issue #91 ①）—— 一份倍率、一个出处。
 */
const CONSOLE_READY_BUDGET_MS = 40_000

export async function startConsole(
  ctx: ScenarioContext,
  configRoot: string,
  spec: ConsoleSpec,
): Promise<ConsoleHandle> {
  const port = await ctx.allocPort()
  const { argv, env: extraEnv } = consoleLaunch(spec, port)
  const env: Record<string, string> = {
    OCC_IDENTITY: 'qianmo',
    OCC_CONFIG_DIR: configRoot,
    ...extraEnv,
  }

  const proc = spawnCli({ argv, env })
  ctx.cleanup(() => proc.stop())

  const url = `http://127.0.0.1:${port}`
  await waitFor(() => proc.stdout().includes('admin-token'), {
    timeoutMs: CONSOLE_READY_BUDGET_MS * ctx.timeoutScale,
    what: '控制台的启动 banner',
    diagnose: () => `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`,
    signal: ctx.signal,
  })
  await waitFor(async () => (await http(`${url}/v0/health`)).status === 200, {
    timeoutMs: CONSOLE_READY_BUDGET_MS * ctx.timeoutScale,
    stepMs: 150,
    what: '控制台的 /v0/health',
    diagnose: () => `stderr:\n${proc.stderr()}`,
    signal: ctx.signal,
  })

  const { viewToken, adminToken } = tokensFromBanner(proc.stdout(), spec)

  return {
    url,
    port,
    viewToken,
    adminToken,
    configRoot,
    process: proc,
    banner: async () => proc.stdout(),
    stderr: async () => proc.stderr(),
    stop: async () => {
      await proc.stop()
    },
  }
}
