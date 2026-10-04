// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P4.1 —— 现场注册中心：把目标智能体的名字登记到它所在节点的入口上。
 *
 *   bun run demo/lib/p41-registry.ts --ready <file> --endpoint ws://127.0.0.1:1234
 *
 * AC-2 的链路第一跳是「按名解析」而不是「照着 URL 拨过去」，所以验收跑批里必须有
 * 一个真的注册中心：`qianmo://node-b/reviewer` → 节点 B 宿主上 activator 的入站地址。
 * 这里用的就是 `@qianmo/registry` 本体，不另写一张表。
 *
 * 租约会过期（`DEFAULT_TTL_MS`），所以本进程按周期续租——这正是节点在真实部署里
 * 该做的事；不续租而把 TTL 调大，测的就不是同一件事了。
 */

import { writeFileSync } from 'node:fs'
import { AgentStatus, startRegistryServer } from '@qianmo/registry'
import { arg, intArg } from './cli-args.js'
import { targetAddress } from './ac2-env.js'

const readyFile = arg('ready')
const endpoint = arg('endpoint')
if (readyFile === undefined || endpoint === undefined) {
  throw new Error('用法：--ready <file> --endpoint <ws url> [--port 0]')
}

const address = targetAddress()
const server = startRegistryServer(intArg('port', 0), {
  hostname: arg('host') ?? '127.0.0.1',
})
const registered = server.registry.register(address, endpoint, {
  capabilities: ['task.request'],
  status: AgentStatus.Online,
})
if (!registered.ok) {
  await server.stop()
  throw new Error(`注册失败：${registered.code} ${registered.message}`)
}

// 续租周期取 TTL 的三分之一量级：一次错过不至于让条目过期。
const heartbeat = setInterval(
  () => {
    if (server.registry.heartbeat(address) === null) {
      server.registry.register(address, endpoint, {
        capabilities: ['task.request'],
        status: AgentStatus.Online,
      })
    }
  },
  intArg('heartbeat-ms', 20_000),
)
heartbeat.unref?.()

writeFileSync(
  readyFile,
  `${JSON.stringify({
    url: server.url,
    port: server.port,
    address,
    endpoint,
    pid: process.pid,
  })}\n`,
)
process.stdout.write(`registry 就绪：${server.url}  ${address} → ${endpoint}\n`)

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
