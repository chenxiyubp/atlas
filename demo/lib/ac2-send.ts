// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P2.5 —— 发送方节点（AC-2 里的「节点 A」），一次跑一条。
 *
 *   bun run demo/lib/ac2-send.ts --round 3 [--timeout-ms 90000]
 *
 * 一次进程一条消息，是刻意的：AC-2 要的是**连续 10 次**独立的唤醒转发，
 * 复用一条长连接连发 10 条只会证明「第一次唤醒之后目标一直醒着」。
 *
 * 判定口径：以 activator 回给发送方的**回执**为准。
 *   - `accepted` —— 信封已经进到沙箱内那个节点的处理函数并被它落盘；
 *   - `rejected` —— 明确失败（唤醒超时、目标不应答、无路由……）；
 *   - `none`     —— 超时内没有任何回执，视为失败。
 *
 * 注意回执**只有一个错误码 `E_UNDELIVERABLE`**：传输层对「处理函数抛了」一律
 * 回这一个码，activator 定的细分码到不了发送方（`packages/activator/src/node.ts`
 * 的「已知限制」一节）。具体是哪一阶段挂的，看 activator 侧的 timings / audit。
 */

import {
  MessageType,
  type QianmoMessage,
  createMessage,
} from '@qianmo/protocol'
import { TransportClient, TransportEventType } from '@qianmo/transport'
import { arg, emit, intArg } from './cli-args.js'
import { activatorUrl, psk, targetAddress } from './ac2-env.js'

const round = intArg('round', 1)
const timeoutMs = intArg('timeout-ms', 90_000)
const senderNode = arg('from-node') ?? 'node-a'
const senderAgent = arg('from-agent') ?? 'planner'

const client = new TransportClient({
  endpoint: { url: activatorUrl() },
  node: senderNode,
  psk: psk(),
  // 15 s 的默认心跳在这里只会给测量掺噪声：一条消息的往返内根本用不到它。
  keepAliveIntervalMs: 0,
})

const message: QianmoMessage = createMessage({
  from: `qianmo://${senderNode}/${senderAgent}`,
  to: targetAddress(),
  type: MessageType.TaskRequest,
  payload: { round, do: 'ac2-wake-forward' },
  // 投递时限要盖得住唤醒：默认 30 s 是给「对端在线」的在线投递用的，
  // 而工作集回暖实测就要 9–10 s（E2），沙箱越大越久。协议本来就允许发送方
  // 按注册中心给出的状态显式声明，这里就是那个显式声明。
  deliverTtlMs: intArg('deliver-ttl-ms', 90_000),
})

const startedAt = performance.now()
let connectMs = -1
try {
  await client.connect(Math.min(timeoutMs, 15_000))
  connectMs = Math.round(performance.now() - startedAt)
  client.send(message)
  await client.waitForDrain(timeoutMs)
} catch (error) {
  // 连不上 / 没排空都不算「成功」，但也不算脚本坏了——照样输出结论，
  // 由 shell 侧统计。抛出去只会让一次失败的轮次看起来像一次运行事故。
  emit({
    round,
    msgId: message.msgId,
    verdict: 'none',
    connectMs,
    wallMs: Math.round(performance.now() - startedAt),
    error: error instanceof Error ? error.message : String(error),
  })
  await client.close()
  process.exit(1)
}

const wallMs = Math.round(performance.now() - startedAt)
let verdict = 'none'
let code = ''
let reason = ''
for (const event of client.events.all()) {
  if (event.detail.msgId !== message.msgId) continue
  if (event.type === TransportEventType.MessageAccepted) verdict = 'accepted'
  if (event.type === TransportEventType.MessageRejected) {
    verdict = 'rejected'
    code = String(event.detail.code ?? '')
    reason = String(event.detail.reason ?? '')
  }
}

await client.close()
emit({ round, msgId: message.msgId, verdict, code, reason, connectMs, wallMs })
process.exit(verdict === 'accepted' ? 0 : 1)
