// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P2.5 —— **沙箱内**那个节点（AC-2 链路的最后一跳落点）。
 *
 * 在沙箱里跑：
 *   bun run demo/lib/ac2-target.ts --inbox /tmp/ac2-inbox.jsonl [--port 38622]
 *
 * 它只做一件事：监听、收信封、落盘、回执。回执是宿主侧 activator 判定
 * 「转发成功」的唯一依据——`TransportClient.send` 只把信封放进发件箱就返回，
 * 只有回执能证明它真的到了这里（见 `packages/activator/src/link.ts` 的说明）。
 *
 * **它刻意不接 `@qianmo/adapter`。** 把消息写进基座信箱、观察 `read` 翻转、
 * 发 A 类 ack，那是最后一跳的事，P2.1 已经交付并自带判据；P2.5 DoD ① 要证的是
 * 「休眠 → 被唤醒 → 消息完整转发且不丢」，多接一层只会把两件事的失败混在一起。
 * 真要连成完整的 AC-2 演示，把这里的 `onMessage` 换成 `deliverAndAck` 即可。
 *
 * 监听地址：默认绑全部网卡（`--bind`），因为宿主要从容器外连进来。
 * 这与「daemon 必须只绑回环」不冲突也不矛盾——那条约束管的是宿主上的
 * 沙箱 daemon（P0.7），管的是**凭据**够不够得着，跟沙箱内的业务端口无关。
 */

import { appendFileSync } from 'node:fs'
import type { QianmoMessage } from '@qianmo/protocol'
import { startTransportServer } from '@qianmo/transport'
import { arg, intArg } from './cli-args.js'
import { psk } from './ac2-env.js'

const inbox = arg('inbox')
if (inbox === undefined) throw new Error('用法：--inbox <file> [--port 38622]')

let count = 0
const server = startTransportServer({
  psk: psk(),
  port: intArg('port', 38_622),
  hostname: arg('bind') ?? '0.0.0.0',
  onMessage: (message: QianmoMessage): void => {
    count += 1
    // 先落盘再返回：处理函数一返回，传输层就发 Accepted 回执，而回执一旦发出
    // 就是「收到了」的承诺。顺序反过来，崩在中间就变成了一次说了谎的回执。
    appendFileSync(
      inbox,
      `${JSON.stringify({
        seq: count,
        at: new Date().toISOString(),
        msgId: message.msgId,
        taskId: message.taskId,
        from: message.from,
        to: message.to,
        type: message.type,
      })}\n`,
    )
    process.stdout.write(
      `[${count}] 收到 ${message.msgId}（${message.from}）\n`,
    )
  },
})

process.stdout.write(
  `目标节点就绪：${server.url ?? '(unix)'}  收件箱=${inbox}\n`,
)

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`收到 ${signal}，共收到 ${count} 条\n`)
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
