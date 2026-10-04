// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P8.1 —— 演示拓扑的注册中心：把**多个**智能体地址登记到各自节点的入口上。
 *
 *   bun run demo/lib/p81-registry.ts --ready <file> --port 38610 \
 *     --register 'qianmo://node-a/planner=ws://127.0.0.1:38611' \
 *     --register 'qianmo://node-b/reviewer=ws://127.0.0.1:38612' \
 *     --public-key 'node-a=<43 位 base64url 公钥>'
 *
 * `--public-key <节点>=<公钥>` 可选、可给多次，按**节点**给一次（公钥是节点的事实，
 * protocol.md §10.1），挂到该节点的每一条 `--register` 上，随每一次登记 / 重登记一并
 * 发布。控制台带 `--anchors` 时只从名册取节点公钥——不给它，审计页对该节点报「名册没有
 * 节点的公钥」（2026-09-26 D9b）。不给的节点与加这个参数之前完全一样。
 *
 * 与 `p41-registry.ts` 的分工：那个是 AC-2 跑批用的，地址从 `ac2-env.ts` 读、**只登记
 * 一个**（沙箱里的那个目标节点）。演示环境要的是「两个节点互相能按名找到对方」，
 * 于是需要 N 条登记；把 p41 那个改成可变条数会动到 AC-2 的复现路径，所以这里另起一个
 * 文件，两个都只做自己那件事。**注册中心本体仍是 `@qianmo/registry`，没有第二张表。**
 *
 * 租约会过期（`DEFAULT_TTL_MS` = 90 s），所以本进程按周期续租——真实部署里该做的
 * 就是这件事；把 TTL 调大而不续租，测的就不是同一件事了（同 `p41-registry.ts`）。
 * 周期默认 `DEFAULT_RENEW_INTERVAL_MS`（20 s）。本进程只续 `--register` 这批；控制台
 * 页面上注册的条目由控制台自己续租（`docs/dev/console.md` §7.3），不经过这里。
 *
 * `--state` 打开落盘（`FileRegistryStore`，原子写），用来演示 P2.1 的「重启后表还在」。
 * 不给就是纯内存表——持久化是 opt-in，构造一个注册中心不该顺手写别人的配置根。
 * 同一个开关也落吊销清单：旁边一个文件（`revocationListStatePathFor`，`registry-agents.json`
 * 旁边是 `registry-revocation-list.json`），重启后照样对外发布。这个文件**读不出来就不启动**：
 * 吊销清单没有人会替它续租，悄悄从空清单起，节点看到的就是「从没发布过」。
 *
 * `--write-token-file <绝对路径>` 打开写鉴权（tenancy-m1.md P15.8）：`POST` / `DELETE` /
 * 心跳 / 发布吊销清单都要带 `Authorization: Bearer <token>`，不带就 401、表不变；读不受影响。
 * 文件必须只有属主可读（0600 或更严），否则拒绝启动。本进程自己替 `--register` 续租是进程内
 * 调用，不经 HTTP，不需要 token。不给这个参数 = 与加它之前完全一样（零鉴权）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { parseAddress } from '@qianmo/protocol'
import {
  DEFAULT_RENEW_INTERVAL_MS,
  FileRegistryStore,
  FileRevocationListStore,
  InMemoryRegistry,
  isValidPublicKey,
  readRegistryWriteTokenFile,
  revocationListStatePathFor,
  startRegistryServer,
} from '@qianmo/registry'
import { arg, intArg } from './cli-args.js'
import {
  announceRegistrations,
  type Registration,
} from './p81-announce-core.js'

/**
 * 收集重复出现的 `--register <address>=<endpoint>`。
 *
 * `cli-args.ts` 的 `arg()` 只取第一个同名参数——多节点拓扑正好需要多条，所以这里
 * 自己扫一遍 argv，而不是把 `arg()` 改成会返回数组（那会改到所有 demo 的取参语义）。
 */
function collectRegistrations(argv: readonly string[]): Registration[] {
  const out: Registration[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--register') continue
    const raw = argv[i + 1]
    if (raw === undefined) throw new Error('--register 缺少取值')
    const separator = raw.indexOf('=')
    if (separator <= 0) {
      throw new Error(`--register 必须是 <address>=<endpoint>，收到 ${raw}`)
    }
    out.push({
      address: raw.slice(0, separator),
      endpoint: raw.slice(separator + 1),
    })
    i++
  }
  return out
}

/**
 * 收集 `--public-key <节点>=<公钥>` 并挂到对应节点的每一条登记上。
 *
 * 三种写错当场拒绝，而不是悄悄少发一把：形状不对（注册中心会逐条 400）、同一节点给了
 * 两把不同的、给了一个没有任何 `--register` 的节点（多半是节点名笔误——静默忽略的
 * 结果就是审计页照旧报缺公钥，而命令行看起来是对的）。
 */
function attachPublicKeys(
  argv: readonly string[],
  registrations: readonly Registration[],
): Registration[] {
  const keys = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--public-key') continue
    const raw = argv[i + 1]
    if (raw === undefined) throw new Error('--public-key 缺少取值')
    const separator = raw.indexOf('=')
    if (separator <= 0) {
      throw new Error(`--public-key 必须是 <节点>=<公钥>，收到 ${raw}`)
    }
    const node = raw.slice(0, separator)
    const key = raw.slice(separator + 1)
    if (!isValidPublicKey(key)) {
      throw new Error(
        `--public-key ${node} 的值不是 base64url 的 Ed25519 公钥：${key}`,
      )
    }
    const earlier = keys.get(node)
    if (earlier !== undefined && earlier !== key) {
      throw new Error(`--public-key 给了节点 ${node} 两把不同的公钥`)
    }
    keys.set(node, key)
    i++
  }
  const nodes = new Set<string>()
  const out = registrations.map(registration => {
    const node = parseAddress(registration.address)?.node
    if (node === undefined) return registration
    nodes.add(node)
    const publicKey = keys.get(node)
    return publicKey === undefined
      ? registration
      : { ...registration, publicKey }
  })
  for (const node of keys.keys()) {
    if (!nodes.has(node)) {
      throw new Error(
        `--public-key 给了节点 ${node}，但没有任何 --register 属于它`,
      )
    }
  }
  return out
}

const readyFile = arg('ready')
if (readyFile === undefined || !isAbsolute(readyFile)) {
  throw new Error(
    '用法：--ready <绝对路径> --port <port> --register <a>=<ep> ...',
  )
}
const registrations = attachPublicKeys(
  process.argv,
  collectRegistrations(process.argv),
)
if (registrations.length === 0) {
  throw new Error('至少要有一条 --register <address>=<endpoint>')
}

const statePath = arg('state')
if (statePath !== undefined && !isAbsolute(statePath)) {
  throw new Error('--state 必须是绝对路径')
}
const writeTokenFile = arg('write-token-file')
if (writeTokenFile !== undefined && !isAbsolute(writeTokenFile)) {
  throw new Error('--write-token-file 必须是绝对路径')
}
// 在绑端口、写 ready 之前读：权限不对的 token 文件是配置错，起不来就该什么都没做过。
const writeToken =
  writeTokenFile === undefined
    ? undefined
    : readRegistryWriteTokenFile(writeTokenFile, '--write-token-file')

const revocationListPath =
  statePath === undefined ? undefined : revocationListStatePathFor(statePath)
let registry: InMemoryRegistry
try {
  registry = new InMemoryRegistry({
    ...(statePath === undefined
      ? {}
      : { store: new FileRegistryStore(statePath) }),
    ...(revocationListPath === undefined
      ? {}
      : {
          revocationListStore: new FileRevocationListStore(revocationListPath),
        }),
    onPersistError: error => {
      // 落盘失败不失败请求（表在内存里仍然权威），但**必须可见**。吊销清单例外：
      // 它落盘失败时那次发布本身被拒（HTTP 500），这里照样出声。
      process.stderr.write(`registry 持久化失败：${String(error)}\n`)
    },
  })
} catch (error) {
  // 只有吊销清单会走到这里（表读不动时照旧从空表起）。
  process.stderr.write(
    `registry 不启动：吊销清单的落盘文件不可用：${
      error instanceof Error ? error.message : String(error)
    }\n` +
      `不会以空清单启动。用 CA 目录里最新的 revocation-list.json 覆盖 ${String(
        revocationListPath,
      )}；或确认要丢弃它，把它移开后再启动，然后重新发布。\n`,
  )
  process.exit(1)
}

const server = startRegistryServer(intArg('port', 0), {
  registry,
  hostname: arg('host') ?? '127.0.0.1',
  ...(writeToken === undefined ? {} : { writeToken }),
})

const announce = (): void => {
  for (const outcome of announceRegistrations(registry, registrations)) {
    // 端点搬家必须出声：命令行说的和名册答的曾经不一致过整整一轮部署，
    // 而那次没有任何一行输出（见 p81-announce-core.ts 的头注）。
    if (outcome.kind === 'moved') {
      process.stderr.write(
        `registry 端点已更新：${outcome.address} ${outcome.from} → ${outcome.to}\n`,
      )
    }
    // 公钥同理。每一轮都出现这一行，说明有别的登记方在不带公钥地整条重登记同一个
    // 地址（比如控制台页面上又注册了一遍），两边在来回覆盖。
    if (outcome.kind === 'rekeyed') {
      process.stderr.write(
        `registry 公钥已更新：${outcome.address} ${outcome.from ?? '（无）'} → ${outcome.to}\n`,
      )
    }
  }
}

try {
  announce()
} catch (error) {
  await server.stop()
  throw error
}

const heartbeat = setInterval(
  () => {
    try {
      announce()
    } catch (error) {
      process.stderr.write(`registry 续租失败：${String(error)}\n`)
    }
  },
  intArg('heartbeat-ms', DEFAULT_RENEW_INTERVAL_MS),
)
heartbeat.unref?.()

mkdirSync(dirname(readyFile), { recursive: true })
writeFileSync(
  readyFile,
  `${JSON.stringify({
    url: server.url,
    port: server.port,
    pid: process.pid,
    agents: registrations,
    ...(statePath === undefined ? {} : { state: statePath }),
    ...(revocationListPath === undefined
      ? {}
      : { revocationListState: revocationListPath }),
    writeAuth: writeToken !== undefined,
  })}\n`,
  { mode: 0o600 },
)
process.stdout.write(
  `registry 就绪：${server.url}（${registrations.length} 条登记；写操作${
    writeToken === undefined ? '不鉴权' : '要 token'
  }）\n`,
)
for (const { address, endpoint, publicKey } of registrations) {
  process.stdout.write(
    `  ${address} → ${endpoint}${publicKey === undefined ? '' : `（公钥 ${publicKey}）`}\n`,
  )
}

let stopping = false
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return
  stopping = true
  process.stdout.write(`收到 ${signal}，停止 registry\n`)
  clearInterval(heartbeat)
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
