// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P4.1 —— 一轮跨节点任务：发一条 `task.request`，在**同一条连接上**收 ack 与
 * `task.result`。
 *
 *   bun run demo/lib/p41-send.ts --round 3 --ack-timeout-ms 60000
 *
 * 这个进程就是 AC-2 判据里的「节点 A」。它只拨一次 activator，之后不再建任何连接：
 * ack 与 result 必须从**它自己那条已认证通道**回来，否则这一轮判为不完整。
 * 「回程另开一条连接也算数」正是 P4.1 要排除的实现方式，所以脚本这边不给它留口子。
 *
 * 输出**不含正文**：只报字符数与 sha256 前缀。正文来自沙箱内的模型桩，留在沙箱里
 * 就够了，验收报告不需要它，也不该把它抄到宿主的 JSON 里。
 */

import { createHash } from 'node:crypto'
import {
  MessageType,
  createMessage,
  formatAddress,
  isAckPayload,
  isTaskResultPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { arg, emit, intArg } from './cli-args.js'
import { activatorUrl, psk, targetAddress } from './ac2-env.js'

const round = intArg('round', 1)
const ackTimeoutMs = intArg('ack-timeout-ms', 60_000)
const resultTimeoutMs = intArg('result-timeout-ms', 300_000)
const forwardTimeoutMs = intArg('forward-timeout-ms', 90_000)
const fromNode = arg('from-node') ?? 'node-a'
const from = formatAddress({
  node: fromNode,
  agent: arg('from-agent') ?? 'operator',
})
const to = targetAddress()
const prompt = arg('prompt') ?? `P4.1 task round ${round}. Reply with OK.`

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** One awaited reply, with the arrival instant taken at handler entry. */
interface Awaited {
  readonly promise: Promise<{ at: number; message: QianmoMessage }>
  settle: (message: QianmoMessage) => void
}

function awaited(): Awaited {
  let settle!: (message: QianmoMessage) => void
  const promise = new Promise<{ at: number; message: QianmoMessage }>(
    resolve => {
      settle = message => {
        resolve({ at: Date.now(), message })
      }
    },
  )
  return { promise, settle }
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    throw new Error(
      `${what} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 按名解析：AC-2 的链路第一跳。
 *
 * 有 `--registry` 就必须解析成功——解析不了就让这一轮失败，**不回落到 activator
 * 的 URL**。回落会让「注册中心那一跳」在报告里静默消失，而判据要的正是它存在。
 */
async function resolveEndpoint(registry: string): Promise<{
  readonly endpoint: string
  readonly resolveMs: number
}> {
  const startedAt = Date.now()
  const url = `${registry.replace(/\/+$/, '')}/v0/agents/${encodeURIComponent(to)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`registry ${response.status} for ${to}`)
  }
  const body = (await response.json()) as { endpoint?: unknown }
  if (typeof body.endpoint !== 'string' || body.endpoint.length === 0) {
    throw new Error(`registry returned no endpoint for ${to}`)
  }
  return { endpoint: body.endpoint, resolveMs: Date.now() - startedAt }
}

const registryUrl = arg('registry') ?? process.env.QIANMO_P41_REGISTRY_URL
const resolved =
  registryUrl === undefined || registryUrl === ''
    ? null
    : await resolveEndpoint(registryUrl)
const dialUrl = resolved?.endpoint ?? activatorUrl()

const ack = awaited()
const result = awaited()
const unexpected: string[] = []

const message = createMessage({
  from,
  to,
  type: MessageType.TaskRequest,
  payload: { prompt },
  deliverTtlMs: intArg('deliver-ttl-ms', forwardTimeoutMs),
  taskTtlMs: intArg('task-ttl-ms', resultTimeoutMs),
})

const client = new TransportClient({
  endpoint: { url: dialUrl },
  node: fromNode,
  psk: psk(),
  keepAliveIntervalMs: 0,
  onMessage: reply => {
    // Correlation is the envelope's taskId (rule C-1) — never a payload copy.
    if (reply.taskId !== message.taskId) {
      unexpected.push(`${reply.type}:${reply.taskId}`)
      return
    }
    if (reply.type === MessageType.Ack) ack.settle(reply)
    else if (reply.type === MessageType.TaskResult) result.settle(reply)
    else unexpected.push(reply.type)
  },
})

const startedAt = Date.now()
let receipt: string | null = null
let receiptAt: number | null = null
let sendError: string | null = null

let acked: { at: number; message: QianmoMessage } | null = null
let resulted: { at: number; message: QianmoMessage } | null = null
try {
  await client.connect(30_000)
  try {
    receipt = await client.sendAndWait(message, forwardTimeoutMs)
    receiptAt = Date.now()
  } catch (error) {
    sendError = error instanceof Error ? error.message : String(error)
  }

  acked = await within(ack.promise, ackTimeoutMs, 'ack')
  resulted = await within(
    result.promise,
    Math.max(1, resultTimeoutMs - (Date.now() - startedAt)),
    'task.result',
  )
} finally {
  await client.close()
}

{
  const payload = resulted?.message.payload
  const closedResult = isTaskResultPayload(payload) ? payload : null
  const content =
    closedResult?.outcome === 'completed' ? closedResult.content : ''
  const verdict =
    acked !== null && closedResult?.outcome === 'completed'
      ? 'complete'
      : acked === null
        ? 'no-ack'
        : 'no-result'

  emit({
    round,
    msgId: message.msgId,
    taskId: message.taskId,
    verdict,
    receipt,
    resolvedByRegistry: resolved !== null,
    ...(resolved === null
      ? {}
      : { resolveMs: resolved.resolveMs, resolvedEndpoint: resolved.endpoint }),
    ...(sendError === null ? {} : { sendError }),
    sentAt: startedAt,
    ...(receiptAt === null ? {} : { receiptAt }),
    ...(acked === null
      ? {}
      : {
          ackAt: acked.at,
          sendToAckMs: acked.at - startedAt,
          ackClosed: isAckPayload(acked.message.payload),
          ackFrom: acked.message.from,
        }),
    ...(resulted === null
      ? {}
      : {
          resultAt: resulted.at,
          sendToResultMs: resulted.at - startedAt,
          resultClosed: closedResult !== null,
          resultOutcome: closedResult?.outcome ?? 'unparseable',
          ...(closedResult?.outcome === 'failed'
            ? { resultCode: closedResult.code }
            : {}),
          resultFrom: resulted.message.from,
          contentChars: content.length,
          ...(content.length === 0 ? {} : { contentSha256: digest(content) }),
        }),
    // Anything that arrived on this connection but did not belong to this task.
    unexpected,
  })
  process.exit(verdict === 'complete' ? 0 : 1)
}
