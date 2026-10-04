// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P8.1 —— 演示环境自检：注册中心解析得到、节点端口拨得通、（可选）任务能被收下。
 *
 *   bun run demo/lib/p81-probe.ts --registry http://127.0.0.1:38610 \
 *     --expect qianmo://node-a/planner --expect qianmo://node-b/reviewer
 *
 *   # 再加一条真消息，只等 ack（不等 task.result，理由见下）
 *   bun run demo/lib/p81-probe.ts --registry ... --expect ... \
 *     --task qianmo://node-b/reviewer --ack-timeout-ms 60000
 *
 * 三步各自证什么：
 *   ① `GET /v0/health`      —— 注册中心进程活着；
 *   ② `GET /v0/agents/<地址>` + 用拿到的端点**真拨一次** PSK 握手
 *                            —— 「按名解析」这一跳真的成立，且节点在监听、PSK 对得上。
 *                               只查表不拨号会把「表里有一条陈旧记录」当成拓扑就绪；
 *   ③ `--task`（可选）      —— 目标节点把消息收进了自己的输入并回了 ack。
 *
 * **为什么 `--task` 只等 ack**：`task.result` 要目标节点跑完一个真 ACP turn，那需要
 * 模型凭据；演示环境的自检不该把「没配凭据」报成「拓扑坏了」。要端到端的结果，跑
 * `demo/p41-task-result.sh`（真机腿）或带凭据的 AC-7 链路。
 *
 * 凭据只从环境变量取（`QIANMO_TRANSPORT_PSK`），本文件没有任何凭据字面量。
 * 输出是一行 JSON，退出码即结论。
 */

import {
  MessageType,
  createMessage,
  isAckPayload,
  isTaskResultPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient, pskFromEnv } from '@qianmo/transport'
import { arg, emit, intArg } from './cli-args.js'

/** 收集重复出现的 `--expect <address>`。理由同 `p81-registry.ts`。 */
function collectExpected(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--expect') continue
    const raw = argv[i + 1]
    if (raw === undefined) throw new Error('--expect 缺少取值')
    out.push(raw)
    i++
  }
  return out
}

/** 一个地址的解析 + 拨号结果。 */
interface ProbeResult {
  readonly address: string
  readonly resolved: boolean
  readonly endpoint?: string
  readonly resolveMs?: number
  readonly dialed: boolean
  readonly dialMs?: number
  readonly error?: string
}

const registryUrl = (arg('registry') ?? '').replace(/\/+$/, '')
if (registryUrl === '')
  throw new Error('用法：--registry <base url> --expect <address> ...')
const expected = collectExpected(process.argv)
if (expected.length === 0) throw new Error('至少要有一条 --expect <address>')

const connectTimeoutMs = intArg('connect-timeout-ms', 10_000)
const psk = pskFromEnv()

function summary(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从 `error` 消息里取错误码。
 *
 * 协议包导出的是 `ErrorPayload` 类型而非运行时守卫，这里只想在报告里多说一句
 * 「对端拒的理由是什么」，够用就行——判定 pass 的是「有没有 ack」，不是这个码。
 */
function errorCode(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const code = (payload as Record<string, unknown>)['code']
  return typeof code === 'string' ? code : undefined
}

async function health(): Promise<{
  ok: boolean
  agents?: number
  error?: string
}> {
  try {
    const response = await fetch(`${registryUrl}/v0/health`)
    if (!response.ok) return { ok: false, error: `health ${response.status}` }
    const body = (await response.json()) as { agents?: unknown }
    return {
      ok: true,
      ...(typeof body.agents === 'number' ? { agents: body.agents } : {}),
    }
  } catch (error) {
    return { ok: false, error: summary(error) }
  }
}

/** 按名解析：拿到端点，或者如实说没拿到。 */
async function resolve(address: string): Promise<{
  endpoint?: string
  resolveMs: number
  error?: string
}> {
  const startedAt = Date.now()
  try {
    const response = await fetch(
      `${registryUrl}/v0/agents/${encodeURIComponent(address)}`,
    )
    if (!response.ok) {
      return {
        resolveMs: Date.now() - startedAt,
        error: `registry ${response.status}`,
      }
    }
    const body = (await response.json()) as { endpoint?: unknown }
    if (typeof body.endpoint !== 'string' || body.endpoint.length === 0) {
      return {
        resolveMs: Date.now() - startedAt,
        error: 'registry 未给出 endpoint',
      }
    }
    return { endpoint: body.endpoint, resolveMs: Date.now() - startedAt }
  } catch (error) {
    return { resolveMs: Date.now() - startedAt, error: summary(error) }
  }
}

/** 拨一次并立刻收线：证明在监听且 PSK 对得上，不留下任何消息。 */
async function dial(
  endpoint: string,
  node: string,
): Promise<{ ms: number } | { error: string }> {
  const startedAt = Date.now()
  const client = new TransportClient({
    endpoint: { url: endpoint },
    node,
    psk,
    keepAliveIntervalMs: 0,
  })
  try {
    await client.connect(connectTimeoutMs)
    return { ms: Date.now() - startedAt }
  } catch (error) {
    return { error: summary(error) }
  } finally {
    await client.close()
  }
}

const fromNode = arg('from-node') ?? 'node-a'
const fromAgent = arg('from-agent') ?? 'planner'

const results: ProbeResult[] = []
for (const address of expected) {
  const resolved = await resolve(address)
  if (resolved.endpoint === undefined) {
    results.push({
      address,
      resolved: false,
      resolveMs: resolved.resolveMs,
      dialed: false,
      ...(resolved.error === undefined ? {} : { error: resolved.error }),
    })
    continue
  }
  const dialResult = await dial(resolved.endpoint, fromNode)
  results.push({
    address,
    resolved: true,
    endpoint: resolved.endpoint,
    resolveMs: resolved.resolveMs,
    dialed: !('error' in dialResult),
    ...('error' in dialResult
      ? { error: dialResult.error }
      : { dialMs: dialResult.ms }),
  })
}

/** `--task` 那一步：发一条真 `task.request`，只等 ack。 */
async function taskAck(target: string): Promise<Record<string, unknown>> {
  const entry = results.find(result => result.address === target)
  if (entry?.endpoint === undefined) {
    return {
      attempted: true,
      acked: false,
      error: `${target} 未解析成功，跳过发送`,
    }
  }
  const ackTimeoutMs = intArg('ack-timeout-ms', 60_000)
  const message = createMessage({
    from: `qianmo://${fromNode}/${fromAgent}`,
    to: target,
    type: MessageType.TaskRequest,
    payload: { prompt: arg('prompt') ?? '演示环境自检：收到请回 ack。' },
    deliverTtlMs: ackTimeoutMs,
    taskTtlMs: intArg('task-ttl-ms', 300_000),
  })
  let settle!: (reply: QianmoMessage) => void
  const arrived = new Promise<QianmoMessage | null>(resolve => {
    settle = reply => resolve(reply)
  })
  // 结果只作观测（见文件头）：它可能是 `failed`（本机没有模型凭据时就是这样），
  // 那不影响拓扑判定。但**要等一小会儿再收线**——ack 一到就挂断，对端那条已经在
  // 路上的 task.result 会等不到回执，于是节点日志里凭空多一条 5 s 超时报错，
  // 而它其实是探测器自己造成的。
  const resultBox: { value: QianmoMessage | null } = { value: null }
  const client = new TransportClient({
    endpoint: { url: entry.endpoint },
    node: fromNode,
    psk,
    keepAliveIntervalMs: 0,
    onMessage: reply => {
      if (reply.taskId !== message.taskId) return
      if (reply.type === MessageType.TaskResult) resultBox.value = reply
      if (reply.type === MessageType.Ack || reply.type === MessageType.Error) {
        settle(reply)
      }
    },
  })
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await client.connect(connectTimeoutMs)
    await client.sendAndWait(message, ackTimeoutMs)
    const reply = await Promise.race([
      arrived,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), ackTimeoutMs)
      }),
    ])
    if (reply === null) {
      return {
        attempted: true,
        acked: false,
        error: `${ackTimeoutMs}ms 内没有 ack`,
      }
    }
    if (reply.type === MessageType.Error) {
      const code = errorCode(reply.payload)
      return {
        attempted: true,
        acked: false,
        error: `对端回了 error${code === undefined ? '' : `：${code}`}`,
      }
    }
    const graceMs = intArg('result-grace-ms', 3_000)
    const deadline = Date.now() + graceMs
    while (resultBox.value === null && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
    const settled = resultBox.value
    const payload = settled?.payload
    return {
      attempted: true,
      acked: true,
      ackMs: Date.now() - startedAt,
      ackClosed: isAckPayload(reply.payload),
      ackFrom: reply.from,
      // 观测项，不参与判定。
      resultSeen: settled !== null,
      ...(isTaskResultPayload(payload)
        ? { resultOutcome: payload.outcome }
        : {}),
    }
  } catch (error) {
    return { attempted: true, acked: false, error: summary(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    await client.close()
  }
}

const registryHealth = await health()
const taskTarget = arg('task')
const task =
  taskTarget === undefined ? { attempted: false } : await taskAck(taskTarget)

const pass =
  registryHealth.ok &&
  results.every(result => result.resolved && result.dialed) &&
  (task['attempted'] !== true || task['acked'] === true)

emit({
  schema: 'qianmo.p81.probe.v1',
  registry: registryUrl,
  health: registryHealth,
  agents: results,
  task,
  pass,
})
process.exit(pass ? 0 : 1)
