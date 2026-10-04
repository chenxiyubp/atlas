// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P2.5 —— 宿主侧 activator 进程（AC-2 唤醒转发链路的中间那一跳）。
 *
 *   bun run demo/lib/ac2-activator.ts --ready <file> --timings <file> [--port 0]
 *
 * 它做的就是 `@qianmo/activator` 那一件事：接住来自别的节点的消息 → 发现目标
 * 沙箱不在 active → 调 `acquireSandbox` 唤醒 → 反复握手探测直到沙箱内的节点真的
 * 应答 → 转发并等回执。四个阶段的时间戳按条写进 `--timings` 指定的 JSONL。
 *
 * 关于能力面：本进程握着 daemon 的 bearer，而那把 bearer **没有权限分级**——
 * 能唤醒就能销毁，只差一个路径段。所以它只经 `@qianmo/activator` 的白名单出网，
 * 全进程没有第二个 fetch 出口（`packages/activator/test/surface-invariant.test.ts`
 * 把这条钉在 CI 里）。这个脚本不要自己去 fetch daemon，一行都不要。
 *
 * 启动完成后往 `--ready` 写一行 JSON（含入站 URL），shell 侧据此往下走；
 * 收到 SIGINT / SIGTERM 时停监听、关链接、正常退出。
 */

import { createWriteStream, writeFileSync, type WriteStream } from 'node:fs'
import {
  AuditLog,
  DEFAULT_RESIDENT_KEEPALIVE_TIME_JUMP_FACTOR,
  HttpSandboxDaemon,
  KeepaliveLoop,
  MemoryRequestJournal,
  ResidentActivityController,
  StaticTargetDirectory,
  startActivatorNode,
  startResidentActivityServer,
} from '@qianmo/activator'
import { arg, intArg } from './cli-args.js'
import {
  daemonToken,
  daemonUrl,
  psk,
  sandboxName,
  targetNode,
  targetUrl,
} from './ac2-env.js'

const readyFile = arg('ready')
const timingsFile = arg('timings')
const auditFile = arg('audit')
if (readyFile === undefined || timingsFile === undefined) {
  throw new Error('用法：--ready <file> --timings <file> [--audit <file>]')
}

function jsonlStream(path: string | undefined): WriteStream | null {
  return path === undefined ? null : createWriteStream(path, { flags: 'a' })
}

async function closeStream(stream: WriteStream | null): Promise<void> {
  if (stream === null) return
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

const sandbox = sandboxName()
const auditOutput = jsonlStream(auditFile)
const timingOutput = jsonlStream(timingsFile)
const audit = new AuditLog(4_096, event => {
  auditOutput?.write(`${JSON.stringify(event)}\n`)
})
const daemon = new HttpSandboxDaemon({
  baseUrl: daemonUrl(),
  token: daemonToken,
  audit,
})
const activityPort = arg('activity-port')
const freezeAfterSeconds = arg('freeze-after-seconds')
const stopAfterSeconds = arg('stop-after-seconds')
if (
  [activityPort, freezeAfterSeconds, stopAfterSeconds].some(
    value => value !== undefined,
  ) &&
  [activityPort, freezeAfterSeconds, stopAfterSeconds].some(
    value => value === undefined,
  )
) {
  throw new Error(
    '--activity-port, --freeze-after-seconds and --stop-after-seconds must be provided together',
  )
}

const node = await startActivatorNode({
  // 宿主自己的段名。它不是被唤醒的那个节点——两跳的两端不能同名，否则审计里
  // 分不清「谁把消息交给了谁」。
  node: `${targetNode()}-host`,
  psk: psk(),
  listen: {
    port: intArg('port', 0),
    // 入站监听地址。默认回环：发送方与 activator 同机时够用，要跨机就把
    // --host 显式设成对外网卡地址（那是部署决定，不写进仓库）。
    hostname: arg('host') ?? '127.0.0.1',
  },
  daemon,
  directory: new StaticTargetDirectory([
    {
      node: targetNode(),
      sandboxName: sandbox,
      endpoint: { url: targetUrl() },
    },
  ]),
  // 内存 journal：这是个一次性的核验进程，不该往用户的配置根里写东西。
  // 崩溃恢复那条判据（DoD ④）由 `crash-recovery.test.ts` 用文件 journal 覆盖。
  journal: new MemoryRequestJournal(),
  audit,
  // 唤醒预算 55 s：AC-2 给 ack 的线是 60 s，留 5 s 给两跳传输本身。
  readyTimeoutMs: intArg('ready-timeout-ms', 55_000),
  // 探测周期 500 ms：每次探测是一次真握手（见 link.ts 为什么不能用缓存标志），
  // 500 ms 既不会把冷启动的头几百毫秒糊掉，也不会把目标的连接日志刷爆。
  readyPollIntervalMs: intArg('poll-ms', 500),
  connectTimeoutMs: intArg('connect-timeout-ms', 2_000),
  forwardTimeoutMs: intArg('forward-timeout-ms', 15_000),
  onOutcome: outcome => {
    timingOutput?.write(`${JSON.stringify(outcome)}\n`)
  },
})

const keepaliveTimeJumpFactor = Number(
  arg('keepalive-time-jump-factor') ??
    DEFAULT_RESIDENT_KEEPALIVE_TIME_JUMP_FACTOR,
)
if (!(keepaliveTimeJumpFactor > 1)) {
  await node.stop()
  throw new Error('--keepalive-time-jump-factor must be greater than 1')
}
let activity: ReturnType<typeof startResidentActivityServer> | null = null
try {
  activity =
    activityPort === undefined
      ? null
      : startResidentActivityServer({
          node: targetNode(),
          psk: psk(),
          listen: {
            port: intArg('activity-port', 0),
            hostname: arg('activity-host') ?? '0.0.0.0',
          },
          controller: new ResidentActivityController(
            new KeepaliveLoop({
              sandboxName: sandbox,
              daemon,
              policy: {
                freezeAfterSeconds: intArg('freeze-after-seconds', 0),
                stopAfterSeconds: intArg('stop-after-seconds', 0),
              },
              audit,
              timeJumpFactor: keepaliveTimeJumpFactor,
            }),
          ),
        })
} catch (error) {
  await node.stop()
  throw error
}

writeFileSync(
  readyFile,
  `${JSON.stringify({
    url: node.url ?? '',
    activityPort: activity?.port ?? null,
    keepaliveTimeJumpFactor: activity === null ? null : keepaliveTimeJumpFactor,
    sandbox,
    node: targetNode(),
    recovered: node.recovery,
    pid: process.pid,
  })}\n`,
)

process.stdout.write(
  `activator 就绪：${node.url ?? '(unix)'}  目标沙箱=${sandbox}\n`,
)

let stopping = false
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return
  stopping = true
  process.stdout.write(`收到 ${signal}，停止 activator\n`)
  await activity?.stop()
  await node.stop()
  await Promise.all([closeStream(auditOutput), closeStream(timingOutput)])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
