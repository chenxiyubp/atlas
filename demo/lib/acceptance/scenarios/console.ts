// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台维度 —— HTTP 面、token、注册中心租约，以及签名唤醒的整条真链路。
 *
 * 四条读断言之前要先知道的事实：
 *
 * ① **在守卫路由上，角色判定排在「方法对不对」之前。**
 *    匿名的 `POST /v0/audit` 拿到的是 401 而不是 405；同一条请求换成 admin
 *    token 才是 405。这样一枚没有凭据的请求探不出这台控制台支持哪些方法。
 *    **公开路径不受这条约束** —— `DELETE /v0/health` 匿名就是 405，因为
 *    `/v0/health` 本来就人人可读，那里没有可泄露的东西。这两条差别真实存在，
 *    写断言时别把它们并成一句（本套件写这条时先按「一律 401」写过一版，红了）。
 *
 * ② **公开路径只有五条**：`GET /v0/health`、两个 `/assets/*`、`GET|POST /login`、
 *    `POST /logout`。其余一律要 token，只读 token 够不到任何 admin 路由。
 *
 * ③ **生成的 token 才回显，显式给的只打出处。**这不是排版偏好，是泄露面：
 *    显式 token 已经在操作者手里，再打进终端记录与 CI 日志只是多一份副本。
 *    两条场景分别钉正反两面。
 *
 * ④ **签名唤醒有严格的三步顺序**（console.md §4.6）：先 `--print-wake-identity`
 *    拿公钥 → 每个目标节点 `--trust console=<公钥>` 重启 → 控制台再开
 *    `--wake-sign`。顺序反了会得到 `E_CAP_INVALID: no published public key for
 *    issuer console`，而那条错读起来像「签名坏了」。本维度把正序走通的那条与
 *    「不签名」「不在白名单」两条拒绝各测一遍。
 *
 * 注册中心那半边：**缺省**它仍零鉴权（console.md §8.2），控制台的 admin token
 * 保护的只是控制台，所以注册动作一律经控制台的代理路由发，测的是那层门。
 * `console/registry-registration-*` 两条让注册中心带上**写 token**（tenancy-m1.md
 * P15.8）、控制台带上 `--registry-token-file`：续租者真的带着 token 在跑，而绕过
 * 控制台直接写注册中心的那一枪如实吃 401、表不变——这是注册中心那扇门本身，
 * 只在它存在时才测。**只读的例外**：控制台已经停了、或注册中心刚重启，要确认
 * 「此刻表上有没有这条」这个前提时，经 `registry.url` 读一次名册。
 *
 * **控制台替自己注册的条目续租**（console.md §7.3）。所以凡是要看「租约到期」
 * 的场景，必须先把续租方 —— 控制台进程 —— 停下；控制台还活着时名册里那条不会
 * 过期，那正是本维度要钉住的修复。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LIMITS } from '@qianmo/protocol'
import { DEFAULT_TTL_MS, REGISTRY_SNAPSHOT_VERSION } from '@qianmo/registry'
import { RUNTIME_RATE } from '@qianmo/router'
import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { http, type HttpProbe } from '../local/console.js'
import { sleep } from '../local/spawn.js'
import { delay, waitForMailbox } from '../observe.js'
import type { ConsoleSlot, Scenario, ScenarioContext } from '../types.js'
import {
  ADDRESS,
  AGENT,
  NODE,
  TEAM,
  newParty,
  startNodeTrusting,
} from './fixtures.js'

/** 控制台自己的地址，`--chat-from` 的出厂默认。 */
const CONSOLE_FROM = 'qianmo://console/operator'
/** 那个地址的节点段 —— 唤醒身份就以它命名。 */
const CONSOLE_NODE = 'console'

const AGENT_ADDRESS = 'qianmo://node-a/planner'
const AGENT_ENDPOINT = 'ws://127.0.0.1:38611'

/** 生成的 token：`randomBytes(24).toString('base64url')` = 32 个 base64url 字符。 */
const GENERATED_TOKEN = /^[A-Za-z0-9_-]{32}$/

function agentsOf(
  json: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const agents = json?.agents
  return Array.isArray(agents) ? (agents as Record<string, unknown>[]) : []
}

function rowOf(
  probe: HttpProbe,
  address: string,
): Record<string, unknown> | undefined {
  return agentsOf(probe.json).find(a => a.address === address)
}

/**
 * 在 `budgetMs` 内反复读一张名册，直到 `address` 出现（或一直读到预算用完）。
 *
 * 返回**最后一次**读到的原文与用时，不抛：「没等到」是要进报告的观察，不是
 * 场景自己的错误。`url` 是一张名册的完整地址（控制台的 `/v0/agents`，或注册
 * 中心的 `/v0/agents`），`token` 只有控制台那一张需要。
 */
async function rosterUntilListed(
  url: string,
  token: string | undefined,
  address: string,
  budgetMs: number,
): Promise<{ readonly probe: HttpProbe; readonly elapsedMs: number }> {
  const started = Date.now()
  for (;;) {
    const probe = await http(url, token === undefined ? {} : { token })
    const elapsedMs = Date.now() - started
    if (rowOf(probe, address) !== undefined || elapsedMs >= budgetMs) {
      return { probe, elapsedMs }
    }
    await sleep(100)
  }
}

/**
 * 跑一次 `qm console --print-wake-identity`，把 `<node>=<公钥>` 拆开。
 *
 * 经**控制台位**跑而不是本地 `runCli`：这条命令会在配置根里生成一把唤醒身份
 * （那是控制面凭据），而后面 `--wake-sign` 的控制台必须复用**同一个**配置根，
 * 否则它签名用的是另一把私钥、目标节点 `--trust` 的又是这一把公钥。
 */
async function printWakeIdentity(
  ctx: ScenarioContext,
  slot: ConsoleSlot,
): Promise<{
  readonly line: string
  readonly node?: string
  readonly publicKey?: string
}> {
  const result = await slot.exec(['console', '--print-wake-identity'], {
    timeoutMs: 40_000,
  })
  const line = result.stdout.trim()
  ctx.log(`print-wake-identity: code=${result.code} stdout=${line}`)
  const separator = line.indexOf('=')
  if (result.code !== 0 || separator <= 0) return { line }
  return {
    line,
    node: line.slice(0, separator),
    publicKey: line.slice(separator + 1),
  }
}

/**
 * 注册中心写 token（P15.8）：一枚随机 token，文件落在**控制台那台机器上**、0600。
 *
 * 权限要在写完之后单独改：`ExecHost.writeFile` 不带 mode，而控制台对权限宽于
 * 0600 的 token 文件拒绝启动——那正是它该做的事。
 */
async function registryWriteToken(
  slot: ConsoleSlot,
): Promise<{ readonly token: string; readonly file: string }> {
  const token = randomBytes(24).toString('base64url')
  const file = await slot.writeFile('registry-write-token', `${token}\n`)
  const chmod = await slot.run(['chmod', '600', file])
  if (chmod.code !== 0) {
    throw new Error(`chmod 600 ${file} 失败：${chmod.stderr}`)
  }
  return { token, file }
}

/** 不带 token、绕过控制台直接写注册中心——那扇门本身。 */
async function unauthenticatedWrites(
  registryUrl: string,
  address: string,
): Promise<{ readonly post: HttpProbe; readonly remove: HttpProbe }> {
  return {
    post: await http(`${registryUrl}/v0/agents`, {
      method: 'POST',
      body: {
        address: 'qianmo://node-z/intruder',
        endpoint: 'ws://127.0.0.1:1',
      },
    }),
    remove: await http(
      `${registryUrl}/v0/agents/${encodeURIComponent(address)}`,
      { method: 'DELETE' },
    ),
  }
}

export const consoleScenarios: readonly Scenario[] = [
  {
    id: 'console/health-public-agents-guarded',
    dimension: 'console',
    title: '/v0/health 公开、/v0/agents 要 token，守卫路由上角色先于方法',
    expected:
      "无 token 的 GET /v0/health → 200 {status:'ok'}；无 token 的 GET /v0/agents → 401 unauthorized；无 token 的 POST /v0/audit → 401，同一条带 admin token 才是 405",
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })

      const health = await http(`${console_.url}/v0/health`)
      const anonymousAgents = await http(`${console_.url}/v0/agents`)
      const withView = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })
      // 守卫路由上角色排在方法之前：`/v0/audit` 只支持 GET，但匿名的 POST
      // 拿到的是 401 而不是 405 —— 没有凭据就问不出这条路径支持什么方法。
      const anonymousWrongMethod = await http(`${console_.url}/v0/audit`, {
        method: 'POST',
      })
      const viewWrongMethod = await http(`${console_.url}/v0/audit`, {
        method: 'POST',
        token: console_.viewToken,
      })

      return new Checks()
        .note('health', `${health.status} ${health.body}`)
        .note(
          'anonymous /v0/agents',
          `${anonymousAgents.status} ${anonymousAgents.body}`,
        )
        .note('view /v0/agents', `${withView.status} ${withView.body}`)
        .eq(health.status, 200, 'GET /v0/health 的状态码')
        .eq(health.json?.status, 'ok', 'GET /v0/health 的 status 字段')
        .eq(anonymousAgents.status, 401, '无 token 的 GET /v0/agents 状态码')
        .eq(
          (anonymousAgents.json?.error as Record<string, unknown> | undefined)
            ?.code,
          'unauthorized',
          '401 的 error.code',
        )
        .eq(withView.status, 200, '带 view token 的 GET /v0/agents 状态码')
        .expect(
          Array.isArray(withView.json?.agents),
          '带 token 时拿到 agents 数组',
          withView.body,
        )
        .eq(
          anonymousWrongMethod.status,
          401,
          '匿名 POST /v0/audit 的状态码（守卫路由上角色先于方法）',
        )
        .eq(
          viewWrongMethod.status,
          405,
          '带 view token 的 POST /v0/audit 状态码（有凭据才答得出方法不对）',
        )
        .note(
          '公开路径不适用这条',
          `匿名 DELETE /v0/health = ${(await http(`${console_.url}/v0/health`, { method: 'DELETE' })).status}（405，因为 /v0/health 本来就人人可读）`,
        )
        .done('公开面与守卫面各自成立')
    },
  },

  {
    id: 'console/view-token-cannot-admin',
    dimension: 'console',
    title: '只读 token 够不到 admin 路由，admin token 够得到',
    expected:
      'POST /v0/agents 带 view token → 403 forbidden；带 admin token → 200 且注册真的落到注册中心',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const body = { address: AGENT_ADDRESS, endpoint: AGENT_ENDPOINT }

      const asView = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.viewToken,
        body,
      })
      const asAdmin = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.adminToken,
        body,
      })
      const listed = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })

      return (
        new Checks()
          .note('view POST', `${asView.status} ${asView.body}`)
          .note('admin POST', `${asAdmin.status} ${asAdmin.body}`)
          .eq(asView.status, 403, 'view token 打 admin 路由的状态码')
          .eq(
            (asView.json?.error as Record<string, unknown> | undefined)?.code,
            'forbidden',
            '403 的 error.code',
          )
          // 200 而不是 201 是刻意的：控制台的代理端口答不出「这个地址是不是新的」。
          .eq(
            asAdmin.status,
            200,
            'admin token 注册的状态码（是 200 不是 201）',
          )
          .eq(asAdmin.json?.address, AGENT_ADDRESS, '回执里的 address')
          .eq(
            agentsOf(listed.json).filter(a => a.address === AGENT_ADDRESS)
              .length,
            1,
            '名册里这条登记的条数',
          )
          .done('两枚 token 的权限边界成立')
      )
    },
  },

  {
    id: 'console/generated-token-echoed-in-banner',
    dimension: 'console',
    title:
      '回环上自动生成的 token 会回显在 banner 里，且形状是 32 位 base64url',
    expected:
      'banner 的 open 行带 ?token=<view>，view/admin 两枚互不相同、都能用',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const banner = await console_.banner()
      const withView = await http(`${console_.url}/v0/limits`, {
        token: console_.viewToken,
      })
      const withAdmin = await http(`${console_.url}/v0/limits`, {
        token: console_.adminToken,
      })

      return new Checks()
        .note('banner', banner)
        .expect(
          GENERATED_TOKEN.test(console_.viewToken),
          'view token 是 32 位 base64url',
          console_.viewToken,
        )
        .expect(
          GENERATED_TOKEN.test(console_.adminToken),
          'admin token 是 32 位 base64url',
          console_.adminToken,
        )
        .expect(
          console_.viewToken !== console_.adminToken,
          '两枚 token 不相同',
          `${console_.viewToken} / ${console_.adminToken}`,
        )
        .contains(banner, `?token=${console_.viewToken}`, 'banner 的 open 行')
        .eq(withView.status, 200, 'view token 打 /v0/limits')
        .eq(withAdmin.status, 200, 'admin token 打 /v0/limits')
        .done('生成的 token 可用且被回显')
    },
  },

  {
    id: 'console/supplied-token-not-echoed',
    dimension: 'console',
    title: '显式给的 token 只打出处、不打值（少一份泄露面）',
    expected:
      "经环境变量给 token 时，banner 里出现 'from $QIANMO_CONSOLE_VIEW_TOKEN'，且全文不含 token 值",
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const viewToken = 'acceptance-view-token-0001'
      const adminToken = 'acceptance-admin-token-0001'
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
        viewToken,
        adminToken,
      })
      const banner = await console_.banner()
      const probe = await http(`${console_.url}/v0/limits`, {
        token: viewToken,
      })

      return (
        new Checks()
          .note('banner', banner)
          .contains(
            banner,
            'from $QIANMO_CONSOLE_VIEW_TOKEN',
            'banner 的 view-token 行',
          )
          .contains(
            banner,
            'from $QIANMO_CONSOLE_ADMIN_TOKEN',
            'banner 的 admin-token 行',
          )
          .notContains(banner, viewToken, 'banner 全文')
          .notContains(banner, adminToken, 'banner 全文')
          .contains(banner, '?token=<your view token>', 'banner 的 open 行')
          // 不回显不等于没生效 —— 行为面单独验一次。
          .eq(probe.status, 200, '环境变量里的那枚 token 真的能用')
          .done('显式 token 不进终端记录')
      )
    },
  },

  {
    id: 'console/limits-mirror-package-constants',
    dimension: 'console',
    title: '/v0/limits 报的三组数字与三个包的常量逐个相等（没有第二份抄写）',
    expected:
      'protocol 段 === LIMITS、runtime 段 === RUNTIME_RATE、registryTtlMs === DEFAULT_TTL_MS',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const probe = await http(`${console_.url}/v0/limits`, {
        token: console_.viewToken,
      })
      const protocol = probe.json?.protocol as
        | Record<string, unknown>
        | undefined
      const runtime = probe.json?.runtime as Record<string, unknown> | undefined

      return new Checks()
        .note('/v0/limits', probe.body)
        .eq(probe.status, 200, '状态码')
        .eq(
          protocol?.maxMessageBytes,
          LIMITS.maxMessageBytes,
          'protocol.maxMessageBytes',
        )
        .eq(protocol?.maxHops, LIMITS.maxHops, 'protocol.maxHops')
        .eq(
          protocol?.defaultTtlMs,
          LIMITS.defaultTtlMs,
          'protocol.defaultTtlMs',
        )
        .eq(
          protocol?.defaultTaskTtlMs,
          LIMITS.defaultTaskTtlMs,
          'protocol.defaultTaskTtlMs',
        )
        .eq(
          protocol?.ratePerMinute,
          LIMITS.ratePerMinute,
          'protocol.ratePerMinute',
        )
        .eq(runtime?.capacity, RUNTIME_RATE.capacity, 'runtime.capacity')
        .eq(runtime?.windowMs, RUNTIME_RATE.windowMs, 'runtime.windowMs')
        .eq(probe.json?.registryTtlMs, DEFAULT_TTL_MS, 'registryTtlMs')
        .done('控制台报的上限就是各包的常量')
    },
  },

  {
    id: 'console/registry-lease-persisted',
    dimension: 'console',
    title: '注册中心租约：线上带 expiresAt，盘上不带（重启时按 TTL 重算）',
    expected:
      'expiresAt === lastHeartbeatAt + DEFAULT_TTL_MS；agents.json 是 version 1 且条目里没有 expiresAt',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx, { persist: true })
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })

      const registered = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          address: AGENT_ADDRESS,
          endpoint: AGENT_ENDPOINT,
          capabilities: ['task.request'],
        },
      })
      // 落盘是同步的（原子写），但读之前给一拍，免得撞上 rename 的窗口。
      await delay(200)
      let disk: Record<string, unknown> | undefined
      // 盘在哪台机器上由驱动决定，所以经 `readState()` 而不是 `node:fs`。
      let diskRaw = (await registry.readState()) ?? ''
      try {
        disk = JSON.parse(diskRaw) as Record<string, unknown>
      } catch (error) {
        diskRaw = `读不回注册中心的落盘内容: ${String(error)}\n${diskRaw}`
      }
      const persisted = agentsOf(disk).find(a => a.address === AGENT_ADDRESS)
      const lastHeartbeatAt = registered.json?.lastHeartbeatAt
      const expiresAt = registered.json?.expiresAt

      return (
        new Checks()
          .note('注册回执', registered.body)
          .note('盘上的 agents.json', diskRaw)
          .eq(registered.status, 200, '注册状态码')
          .expect(
            typeof lastHeartbeatAt === 'number' &&
              typeof expiresAt === 'number',
            '回执带 lastHeartbeatAt 与 expiresAt',
            `${String(lastHeartbeatAt)} / ${String(expiresAt)}`,
          )
          .eq(
            typeof expiresAt === 'number' && typeof lastHeartbeatAt === 'number'
              ? expiresAt - lastHeartbeatAt
              : undefined,
            DEFAULT_TTL_MS,
            '线上的 expiresAt - lastHeartbeatAt',
          )
          .eq(disk?.version, 1, '盘上的 version')
          .expect(persisted !== undefined, '盘上有这条登记', diskRaw)
          .eq(persisted?.endpoint, AGENT_ENDPOINT, '盘上的 endpoint')
          .eq(persisted?.status, 'online', '盘上的 status')
          // 盘上不存 expiresAt 是设计：恢复时按 lastHeartbeatAt + ttl 重算，
          // 于是改 TTL 立刻对存量生效，而不是让老记录带着旧 TTL 复活。
          .expect(
            persisted !== undefined && persisted.expiresAt === undefined,
            '盘上的条目里没有 expiresAt（恢复时重算）',
            persisted,
          )
          .done('租约的线上形状与落盘形状各自正确')
      )
    },
  },

  {
    id: 'console/registry-lease-expires-and-renews',
    dimension: 'console',
    title: '租约到期即从名册消失，心跳能把它续回来',
    expected:
      '短 TTL 下：心跳后仍在名册；续租方（控制台进程）停下后等过 TTL，注册中心的名册为空（读时按租约判，过期行由 10 s 时钟脉冲清出表）',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      // **TTL 要吃倍率**，理由与 issue #91 那几处硬预算是同一条，只是这里更隐蔽：
      // 流逝的不只是下面那几次 `sleep`，还有**每一次 HTTP 往返**。本地腿的往返
      // 约 1 ms，相对 3 s 的 TTL 可以当成零；真机腿的每一次都要从 runner 经
      // SSH 隧道到控制台那台机器，几百毫秒起步。于是「注册 → 睡 0.6×TTL →
      // 心跳」这条本来留了 40% 余量的路径会被往返吃穿，租约**真的**过期，
      // 心跳如实回 404 —— 那是产品的正确回答，红的是这条场景自己的算术。
      //
      // 实测：真机腿上这条以「心跳 404」收场，而三次 sleep 合计 8.1 s、场景总
      // 耗时 42.4 s —— 三十多秒全花在启动与往返上。
      //
      // 乘上 `timeoutScale` 之后本地腿（倍率 1）逐字节不变，真机腿（默认 4）
      // 拿到 12 s，往返重新变得可以忽略。
      const ttlMs = Math.round(3_000 * ctx.timeoutScale)
      const expiryGraceMs = Math.round(1_500 * ctx.timeoutScale)
      const registry = await ctx.driver.startRegistry(ctx, { ttlMs })
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const encoded = encodeURIComponent(AGENT_ADDRESS)

      const registered = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.adminToken,
        body: { address: AGENT_ADDRESS, endpoint: AGENT_ENDPOINT },
      })
      await sleep(Math.floor(ttlMs * 0.6))
      const beat = await http(
        `${console_.url}/v0/agents/${encoded}/heartbeat`,
        { method: 'POST', token: console_.adminToken },
      )
      await sleep(Math.floor(ttlMs * 0.6))
      // 续过一次，此刻距首次注册已超过一个 TTL，距心跳还没到。
      const afterBeat = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })
      // 控制台替自己注册的条目续租，它活着这条就不会过期。要看租约到期，
      // 先停掉唯一的续租方；控制台停了，名册只能在注册中心那一侧读（只读）。
      await console_.stop()
      await sleep(ttlMs + expiryGraceMs)
      const afterExpiry = await http(`${registry.url}/v0/agents`)

      return new Checks()
        .note('注册', `${registered.status} ${registered.body}`)
        .note('心跳', `${beat.status} ${beat.body}`)
        .note('心跳之后的名册', `${afterBeat.status} ${afterBeat.body}`)
        .note('过期之后的名册', `${afterExpiry.status} ${afterExpiry.body}`)
        .eq(registered.status, 200, '注册状态码')
        .eq(beat.status, 200, '心跳状态码')
        .expect(
          typeof beat.json?.expiresAt === 'number' &&
            typeof registered.json?.expiresAt === 'number' &&
            (beat.json.expiresAt as number) >
              (registered.json.expiresAt as number),
          '心跳把 expiresAt 往后推了',
          `${String(registered.json?.expiresAt)} → ${String(beat.json?.expiresAt)}`,
        )
        .eq(
          agentsOf(afterBeat.json).length,
          1,
          '心跳续过一个 TTL 之后名册里的条数',
        )
        .eq(afterExpiry.status, 200, '注册中心名册的状态码')
        .eq(
          agentsOf(afterExpiry.json).length,
          0,
          '续租方停下、过了 TTL 之后的条数',
        )
        .done('租约按 TTL 过期、按心跳续期')
    },
  },

  {
    id: 'console/registry-registration-outlives-lease',
    dimension: 'console',
    title:
      '控制台上注册的条目由控制台续租（带写 token）：过了两个租约仍在名册，注销后不再续；不带 token 直接写注册中心被拒',
    expected:
      '注册中心带写 token、控制台带 --registry-token-file；短 TTL 下注册后不发任何手动心跳，等过两个 TTL 名册里仍有这条且 lastHeartbeatAt 前移；绕过控制台的 POST 与 DELETE 各 401、名册不变；DELETE 204 之后再等一个 TTL，名册里没有它',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      // `tenancy-m1.md` §0.4（P15.2）那条缺陷的原样复现：控制台只有按需心跳，
      // 注册中心宿主只替 `--register` 续租，节点从不拨号 —— 于是页面上的「注册」
      // 一个 TTL 后就从名册消失。TTL 取短的并吃倍率，理由见上一条场景的注释。
      // P15.8 起续租者要带写 token：这一条让注册中心真的要求它。
      const ttlMs = Math.round(3_000 * ctx.timeoutScale)
      const graceMs = Math.round(1_500 * ctx.timeoutScale)
      const slot = await ctx.driver.consoleSlot(ctx)
      const writeToken = await registryWriteToken(slot)
      const registry = await ctx.driver.startRegistry(ctx, {
        ttlMs,
        writeToken: writeToken.token,
      })
      const console_ = await slot.start({
        registryUrl: registry.hostUrl,
        extraArgs: ['--registry-token-file', writeToken.file],
      })
      const encoded = encodeURIComponent(AGENT_ADDRESS)

      const registered = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          address: AGENT_ADDRESS,
          endpoint: AGENT_ENDPOINT,
          capabilities: ['task.request'],
        },
      })
      // 两个整租约再加余量：没有续租方的条目在这段时间里早已过期两回。
      await sleep(2 * ttlMs + graceMs)
      const held = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })
      const row = rowOf(held, AGENT_ADDRESS)

      const bypass = await unauthenticatedWrites(registry.url, AGENT_ADDRESS)
      const afterBypass = await http(`${registry.url}/v0/agents`)

      const removed = await http(`${console_.url}/v0/agents/${encoded}`, {
        method: 'DELETE',
        token: console_.adminToken,
      })
      // 续租周期是租约的 2/9（`renewIntervalFor`），一个 TTL 里续租方会醒好几回；
      // 它若还惦记着这条，这段时间足够把它续回来。
      await sleep(ttlMs + graceMs)
      const afterRemoval = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })

      return new Checks()
        .note('注册', `${registered.status} ${registered.body}`)
        .note('两个租约之后的名册', `${held.status} ${held.body}`)
        .note('绕过控制台的 POST', `${bypass.post.status} ${bypass.post.body}`)
        .note(
          '绕过控制台的 DELETE',
          `${bypass.remove.status} ${bypass.remove.body}`,
        )
        .note('注销', `${removed.status} ${removed.body}`)
        .note('注销之后的名册', `${afterRemoval.status} ${afterRemoval.body}`)
        .note('控制台 stderr', (await console_.stderr()).slice(0, 1_500))
        .contains(
          await console_.banner(),
          'write-token  registry writes carry the token from',
          '控制台 banner 报出写 token 的出处',
        )
        .eq(registered.status, 200, '注册状态码')
        .eq(bypass.post.status, 401, '不带 token 直接 POST 注册中心')
        .eq(bypass.remove.status, 401, '不带 token 直接 DELETE 注册中心')
        .expect(
          rowOf(afterBypass, AGENT_ADDRESS) !== undefined &&
            rowOf(afterBypass, 'qianmo://node-z/intruder') === undefined,
          '被拒的两次写没有改动名册',
          afterBypass.body,
        )
        .expect(
          row !== undefined,
          '过了两个租约、没有任何手动心跳，名册里仍有这条',
          held.body,
        )
        .expect(
          typeof row?.lastHeartbeatAt === 'number' &&
            typeof registered.json?.lastHeartbeatAt === 'number' &&
            row.lastHeartbeatAt > registered.json.lastHeartbeatAt,
          '续租来自控制台：lastHeartbeatAt 比注册时前移',
          `${String(registered.json?.lastHeartbeatAt)} → ${String(row?.lastHeartbeatAt)}`,
        )
        .eq(row?.endpoint, AGENT_ENDPOINT, '续租后的 endpoint 未变')
        .eq(removed.status, 204, '注销状态码')
        .expect(
          rowOf(afterRemoval, AGENT_ADDRESS) === undefined,
          '注销后再等一个租约，这条没有被续回来',
          afterRemoval.body,
        )
        .done('控制台注册的条目活过租约，注销即停止续租')
    },
  },

  {
    id: 'console/registry-registration-survives-restarts',
    dimension: 'console',
    title:
      '注册中心重启、控制台重启之后，控制台注册过的条目都会回来（登记簿落在控制台配置根；续租带写 token）',
    expected:
      '注册中心带写 token、控制台带 --registry-token-file；注册中心在同一端口重起为空表后，一个 TTL 内条目回到名册；控制台停下、租约过期、条目消失之后，用同一个配置根重起控制台，条目回来',
    requires: ['spawn-console'],
    timeoutMs: 180_000,
    async run(ctx) {
      const ttlMs = Math.round(3_000 * ctx.timeoutScale)
      const graceMs = Math.round(1_500 * ctx.timeoutScale)
      const slot = await ctx.driver.consoleSlot(ctx)
      const writeToken = await registryWriteToken(slot)
      // 不开持久化：重起后的注册中心是空表，与「停机超过一个 TTL 后重启」同一个
      // 结果（`#restore` 按当下时钟重判，过期的一条不留），而不必真等那么久。
      // 重起沿用同一枚写 token（`RegistrySpec.writeToken`）。
      const registry = await ctx.driver.startRegistry(ctx, {
        ttlMs,
        writeToken: writeToken.token,
      })
      const withToken = {
        registryUrl: registry.hostUrl,
        extraArgs: ['--registry-token-file', writeToken.file],
      }
      const first = await slot.start(withToken)

      const registered = await http(`${first.url}/v0/agents`, {
        method: 'POST',
        token: first.adminToken,
        body: { address: AGENT_ADDRESS, endpoint: AGENT_ENDPOINT },
      })

      // ① 注册中心重启。
      await registry.restart()
      const emptied = await http(`${registry.url}/v0/agents`)
      const back = await rosterUntilListed(
        `${first.url}/v0/agents`,
        first.viewToken,
        AGENT_ADDRESS,
        ttlMs,
      )

      // ② 控制台重启。先停、再等过一个租约，让这条真的从表上消失 —— 否则第二个
      // 控制台起来时看到的可能只是上一个留下的租约，证明不了登记簿。
      await first.stop()
      await sleep(ttlMs + graceMs)
      const lapsed = await http(`${registry.url}/v0/agents`)
      // 同一个控制台位 = 同一个配置根 = 同一本登记簿。
      const second = await slot.start(withToken)
      const replayed = await rosterUntilListed(
        `${second.url}/v0/agents`,
        second.viewToken,
        AGENT_ADDRESS,
        graceMs,
      )

      return new Checks()
        .note('注册', `${registered.status} ${registered.body}`)
        .note('注册中心刚重起时的表', `${emptied.status} ${emptied.body}`)
        .note(
          '注册中心重起后控制台的名册',
          `${back.elapsedMs} ms: ${back.probe.status} ${back.probe.body}`,
        )
        .note('控制台停下一个租约后的表', `${lapsed.status} ${lapsed.body}`)
        .note(
          '控制台重起后的名册',
          `${replayed.elapsedMs} ms: ${replayed.probe.status} ${replayed.probe.body}`,
        )
        .note('第二个控制台的 banner', await second.banner())
        .note('第一个控制台 stderr', (await first.stderr()).slice(0, 1_500))
        .eq(registered.status, 200, '注册状态码')
        .expect(
          emptied.status === 200 && rowOf(emptied, AGENT_ADDRESS) === undefined,
          '前提：注册中心重起后表上没有这条',
          emptied.body,
        )
        .expect(
          rowOf(back.probe, AGENT_ADDRESS) !== undefined,
          '注册中心重起后一个 TTL 之内，这条回到名册',
          back.probe.body,
        )
        .expect(
          lapsed.status === 200 && rowOf(lapsed, AGENT_ADDRESS) === undefined,
          '前提：控制台停下、没人续租，一个租约后这条从表上消失',
          lapsed.body,
        )
        .expect(
          rowOf(replayed.probe, AGENT_ADDRESS) !== undefined,
          '同一个配置根重起控制台后，这条回到名册（登记簿）',
          replayed.probe.body,
        )
        .done('两种重启之后控制台注册的条目都回来了')
    },
  },

  {
    id: 'console/registry-lease-custom-ttl',
    dimension: 'console',
    title:
      '注册中心租约 1 小时、上次心跳已超出默认 90 s：控制台按注册中心的租约判在线',
    expected:
      "该行 data-health='live'；名册抬头与上限区都报「1 小时」（data-ttl-ms=3600000），不报出厂默认",
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      // 验证报告 2026-09-08 C-1 的原样复现：注册中心跑 1 小时租约，控制台曾拿
      // 自己编译进来的 DEFAULT_TTL_MS 当尺子，于是心跳超过 45 s 判「滞后」、超过
      // 90 s 判「过期」，而注册中心照样列出、照样路由。
      //
      // 「上次心跳在 2 分钟前」靠**预置落盘表**得到，不靠等：注册中心恢复时按当下
      // TTL 重算 expiresAt（P2.1），与「注册中心重启后读回旧表」是同一条真实路径。
      // 这个路径与 `local/console.ts` 的 `startRegistry` 在 `persist: true` 时选的
      // 那个是同一个；两边若分叉，下面「名册里有预置的那条」会红，不会假绿。
      // 两条腿的注册中心都跑在 runner 进程里，所以文件写在 runner 本地。
      const leaseMs = 3_600_000
      const beat = Date.now() - (DEFAULT_TTL_MS + 30_000)
      const statePath = join(ctx.workdir, 'registry-state', 'agents.json')
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(
        statePath,
        `${JSON.stringify({
          version: REGISTRY_SNAPSHOT_VERSION,
          agents: [
            {
              address: AGENT_ADDRESS,
              endpoint: AGENT_ENDPOINT,
              capabilities: ['task.request'],
              status: 'online',
              registeredAt: beat,
              lastHeartbeatAt: beat,
            },
          ],
        })}\n`,
      )
      const registry = await ctx.driver.startRegistry(ctx, {
        persist: true,
        ttlMs: leaseMs,
      })
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })

      const listed = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })
      const roster = await http(`${console_.url}/fragments/roster`, {
        token: console_.viewToken,
      })
      const page = await http(`${console_.url}/`, {
        token: console_.viewToken,
      })
      const sinceBeatMs = Date.now() - beat
      const row = agentsOf(listed.json).find(a => a.address === AGENT_ADDRESS)
      const granted =
        typeof row?.expiresAt === 'number' &&
        typeof row.lastHeartbeatAt === 'number'
          ? row.expiresAt - row.lastHeartbeatAt
          : undefined

      return (
        new Checks()
          .note('/v0/agents', `${listed.status} ${listed.body}`)
          .note('/fragments/roster', `${roster.status} ${roster.body}`)
          .eq(listed.status, 200, '/v0/agents 状态码')
          .expect(
            row !== undefined,
            '名册里有预置的那条（注册中心从落盘表恢复）',
            listed.body,
          )
          .eq(
            granted,
            leaseMs,
            '注册中心给这条的租约（expiresAt - lastHeartbeatAt）',
          )
          // 前提：按出厂默认算，这条早该判「过期」了。
          .expect(
            sinceBeatMs >= DEFAULT_TTL_MS,
            '前提：上次心跳已超出出厂默认租约',
            sinceBeatMs,
          )
          .eq(roster.status, 200, '/fragments/roster 状态码')
          .contains(roster.body, 'data-health="live"', '名册该行的健康度')
          .notContains(roster.body, 'data-health="stale"', '名册')
          .notContains(roster.body, 'data-health="expired"', '名册')
          .contains(
            roster.body,
            '<span class="ttl">租约 1 小时</span>',
            '名册抬头的租约',
          )
          .eq(page.status, 200, '首页状态码')
          .contains(page.body, 'data-ttl-ms="3600000"', '上限区（总览卡读它）')
          .contains(
            page.body,
            '<span class="k">注册租约</span><span class="num">1 小时</span>',
            '上限区的注册租约',
          )
          .done('控制台的租约判定与显示都以注册中心为准')
      )
    },
  },

  {
    id: 'console/wake-node-not-in-allowlist',
    dimension: 'console',
    title: '唤醒目标不在启动白名单里 → 403 rejected（客户端给的 URL 一律丢弃）',
    expected:
      "403 + error.code='rejected' + '唤醒节点不在启动时配置的白名单中'",
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      // 白名单里那条的 URL 拨不拨得通无所谓：这条场景问的是**名字不在表里**
      // 时的 403，判定发生在拨号之前。所以这里给一个必然拨不通的口，
      // 而不是去分配一个（分配来的还是 runner 的口，真机腿上更没意义）。
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
        wakeTargets: [{ node: NODE, url: 'ws://127.0.0.1:1' }],
        wakePsk: { [NODE]: ACCEPTANCE_PSK },
      })
      const probe = await http(`${console_.url}/v0/wake`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          node: 'somewhere-else',
          from: CONSOLE_FROM,
          to: 'qianmo://somewhere-else/main',
          prompt: 'acceptance allowlist probe',
        },
      })
      return new Checks()
        .note('响应', `${probe.status} ${probe.body}`)
        .eq(probe.status, 403, '状态码')
        .eq(
          (probe.json?.error as Record<string, unknown> | undefined)?.code,
          'rejected',
          'error.code',
        )
        .contains(probe.body, '唤醒节点不在启动时配置的白名单中', '响应正文')
        .done('白名单之外的节点唤不动')
    },
  },

  {
    id: 'console/wake-unsigned-refused',
    dimension: 'console',
    title: '不开 --wake-sign 打严格档节点：403，且拒绝原因原样透到操作面',
    expected:
      "403 + error.code='refused' + 正文含 'E_CAP_INSUFFICIENT' 与 'needs write-limited'",
    requires: ['spawn-console', 'spawn-node', 'read-node-files'],
    timeoutMs: 180_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      // `hostEndpoint`：拨号方是控制台，它和节点同机（真机腿上由驱动保证），
      // 拨的是节点自己那台机器的回环口。给 `endpoint` 的话真机腿上它会去打
      // **控制台机器**上的一个 runner 侧隧道口 —— 那里没有人在听。
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
        wakeTargets: [{ node: NODE, url: node.hostEndpoint }],
        wakePsk: { [NODE]: ACCEPTANCE_PSK },
      })
      const probe = await http(`${console_.url}/v0/wake`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          node: NODE,
          from: CONSOLE_FROM,
          to: ADDRESS,
          prompt: 'acceptance unsigned wake',
        },
      })
      return (
        new Checks()
          .note('响应', `${probe.status} ${probe.body}`)
          .note('控制台 stderr', (await console_.stderr()).slice(0, 1_500))
          .eq(probe.status, 403, '状态码')
          .eq(
            (probe.json?.error as Record<string, unknown> | undefined)?.code,
            'refused',
            'error.code',
          )
          .contains(probe.body, 'E_CAP_INSUFFICIENT', '响应正文')
          .contains(probe.body, 'needs write-limited', '响应正文')
          // 兜底文案不该出现：拿到了真原因就必须给真原因（issue #34 的判据）。
          .notContains(probe.body, '原因见该节点的审计链', '响应正文')
          .done('未签名唤醒被拒且原因可读')
      )
    },
  },

  {
    id: 'console/wake-sign-round-trip',
    dimension: 'console',
    title:
      '签名唤醒整条链路：--print-wake-identity → --trust → --wake-sign → 投进信箱',
    expected:
      "POST /v0/wake → 200 receipt='accepted'，节点信箱里那条 notice.trust='verified-capability'",
    requires: ['spawn-console', 'spawn-node', 'read-node-files'],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const registry = await ctx.driver.startRegistry(ctx)
      const slot = await ctx.driver.consoleSlot(ctx)

      // 第一步：把控制台的唤醒身份印出来。这一步**不起服务器、不读 token**，
      // 所以它在一台还没配好的机器上也答得出来 —— 那正是分发公钥的那一刻。
      const identity = await printWakeIdentity(ctx, slot)
      checks
        .note('print-wake-identity', identity.line)
        .eq(identity.node, CONSOLE_NODE, '身份节点段')
      if (identity.publicKey === undefined) {
        return checks.skip(`--print-wake-identity 没给出公钥：${identity.line}`)
      }

      // 第二步：目标节点把这枚公钥收进 --trust，并跑在严格档上。
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
        trust: [`${CONSOLE_NODE}=${identity.publicKey}`],
      })

      // 第三步：控制台带 --wake-sign 起来，复用第一步那个配置根（身份文件
      // 就在里面，`loadOrCreateNodeKeys` 是 wx 创建、永不覆盖）。
      const console_ = await slot.start({
        registryUrl: registry.hostUrl,
        wakeTargets: [{ node: NODE, url: node.hostEndpoint }],
        wakePsk: { [NODE]: ACCEPTANCE_PSK },
        signWakes: true,
      })
      const probe = await http(`${console_.url}/v0/wake`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          node: NODE,
          from: CONSOLE_FROM,
          to: ADDRESS,
          prompt: 'acceptance signed wake',
        },
      })
      const inbox = await waitForMailbox(ctx, node, TEAM, AGENT)
      const last = inbox.at(-1)

      const banner = await console_.banner()
      return checks
        .note('banner 的 wake-signing 行', banner)
        .note('响应', `${probe.status} ${probe.body}`)
        .note('信箱原文', last?.raw ?? '(信箱是空的)')
        .contains(banner, 'wake-signing', 'banner 里有签名身份那一行')
        .contains(
          banner,
          `${CONSOLE_NODE}=${identity.publicKey}`,
          'banner 里那一行的取值（可原样粘进 --trust）',
        )
        .eq(probe.status, 200, '状态码')
        .eq(probe.json?.receipt, 'accepted', 'receipt')
        .expect(
          typeof probe.json?.msgId === 'string' &&
            typeof probe.json?.taskId === 'string',
          '回执带 msgId 与 taskId',
          probe.body,
        )
        .expect(inbox.length > 0, '信箱里有一条', inbox.length)
        .eq(last?.trust, 'verified-capability', 'notice.trust')
        .eq(last?.capIss, CONSOLE_NODE, 'origin.capIss')
        .done('控制台签名唤醒走通整条链路')
    },
  },
]
