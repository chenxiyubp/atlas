// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 协议限额维度 —— TTL / 跳数 / 体积 / 速率预算。
 *
 * **上限值一个都不许写死在这个文件里。** 全部从 `@qianmo/protocol` 的
 * {@link LIMITS} 取（CLAUDE.md §2.2：协议级数值上限以它为唯一出处）。抄一份
 * 数字进来，改上限的那天套件会以「产品坏了」的形态红给你看，而真相是套件
 * 自己过期了 —— 这类假红比漏测更贵。
 *
 * 四种超限的**观测点不在同一层**，这是读断言之前必须先知道的：
 *
 *   · TTL / 跳数 / 体积 —— 在 `packages/transport/src/receiver.ts` 里由
 *     `validateMessage` 判掉，**早于**节点的任何业务逻辑。所以答复是一条
 *     `receipt`（`status='rejected'` + 真 code + `reason='invalid envelope'`），
 *     **没有 error 信封**：那条是 `resident.ts#receive` 才会补的，而这里
 *     根本走不到那儿。
 *   · 速率预算 —— 在 `packages/router/src/router.ts` 的 `inbound()` 里，
 *     排在能力与环路之后。它走的是另一条路：error 信封带
 *     `E_RATE_LIMITED`，而回执被 `receiver.ts` 统一压成 `E_UNDELIVERABLE`。
 *     **只看回执分辨不出它**，两条都要读。
 *
 * 还有一层在传输层之下：帧比 `maxMessageBytes + 4096` 还大时，Bun 的
 * `maxPayloadLength` 在 `JSON.parse` 之前就把连接掐了 —— 那时连回执都没有。
 * 「拒绝发生在哪一层」本身就是要钉住的东西，所以体积那一维分成两条场景。
 */

import { createMessage, LIMITS, MessageType } from '@qianmo/protocol'
import type { QianmoMessage } from '@qianmo/protocol'
import { FRAME_VERSION, FrameType } from '@qianmo/transport'
import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { rawDial } from '../local/dial.js'
import { sendBurst, sendEnvelope, receiptScene } from '../local/send.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  NODE,
  SENDER,
  SENDER_NODE,
  newParty,
  startNodeTrusting,
} from './fixtures.js'

/** 传输层判掉的三种超限，答复里统一的那句。 */
const WIRE_REJECT_REASON = 'invalid envelope'

/** 一条最普通的唤醒信封，供各条场景在它基础上改坏某一个字段。 */
function wake(overrides: Partial<QianmoMessage> = {}): QianmoMessage {
  const base = createMessage({
    from: SENDER,
    to: ADDRESS,
    type: MessageType.Wake,
    payload: { trigger: 'manual', prompt: 'acceptance limits probe' },
  })
  return { ...base, hops: [SENDER_NODE], ...overrides }
}

/** 序列化后的字节数 —— 与 `validateMessage` 用的是同一个度量。 */
function envelopeBytes(message: QianmoMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8')
}

/**
 * 把一条信封的 prompt 撑到「序列化后恰好 `target` 字节」附近。
 *
 * 二分而不是一次算出来：`prompt` 变长会让 JSON 里的长度数字本身也变长，
 * 而且 `payload` 进了 `fingerprint` 的计算 —— 一次性推算差几个字节，正好
 * 落在体积上限这条 4 KiB 宽的窗口外面。
 */
function inflateTo(target: number): QianmoMessage {
  let pad = target
  let message = wake({
    payload: { trigger: 'manual', prompt: 'x'.repeat(pad) },
  })
  for (let i = 0; i < 40; i += 1) {
    const delta = target - envelopeBytes(message)
    if (delta === 0) break
    pad = Math.max(1, pad + delta)
    message = wake({ payload: { trigger: 'manual', prompt: 'x'.repeat(pad) } })
  }
  return message
}

export const limitsScenarios: readonly Scenario[] = [
  {
    id: 'limits/ttl-expired',
    dimension: 'limits',
    title: `投递 TTL 已过的信封被判 E_TTL_EXPIRED（默认 ${LIMITS.defaultTtlMs}ms）`,
    expected:
      "receipt='rejected' + code='E_TTL_EXPIRED' + reason='invalid envelope'，且没有 error 信封（拒绝发生在节点逻辑之前）",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      const fresh = wake()
      const expired = wake({
        createdAt: Date.now() - LIMITS.defaultTtlMs * 4,
        deliverTtlMs: LIMITS.defaultTtlMs,
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        message: expired,
      })
      return new Checks()
        .eq(
          fresh.deliverTtlMs,
          LIMITS.defaultTtlMs,
          '缺省信封的 deliverTtlMs（证明默认值取自 LIMITS）',
        )
        .note(
          '过期信封',
          `createdAt=${expired.createdAt} ttl=${expired.deliverTtlMs}`,
        )
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.receiptCode, 'E_TTL_EXPIRED', 'receipt 的 code')
        .eq(result.receiptReason, WIRE_REJECT_REASON, 'receipt 的 reason')
        .eq(result.errorCode, undefined, 'error 信封（这一层不该有）')
        .note('frames', result.frames.join('\n'))
        .done('过期投递被传输层判死')
    },
  },

  {
    id: 'limits/ttl-fresh-admitted',
    dimension: 'limits',
    title: 'TTL 还没到的信封照常被接收（证明上一条测的是 TTL 而不是别的）',
    expected: "同样构造、只把 createdAt 改回现在 → receipt='accepted'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        message: wake({
          createdAt: Date.now(),
          deliverTtlMs: LIMITS.defaultTtlMs,
        }),
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'accepted', 'receipt')
        .eq(result.receiptCode, undefined, 'receipt 的 code')
        .done('未过期投递被接收')
    },
  },

  {
    id: 'limits/hop-limit-exceeded',
    dimension: 'limits',
    title: `跳数超过 LIMITS.maxHops（${LIMITS.maxHops}）被判 E_TOO_MANY_HOPS`,
    expected: `hops 有 ${LIMITS.maxHops + 1} 段 → receipt='rejected' + code='E_TOO_MANY_HOPS'`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      // 第一段必须是发起节点（protocol.md §6.3），其余用不会与本节点重名的
      // 中继名 —— 撞上本节点名测到的是 E_LOOP，那是另一条分支。
      const hops = [
        SENDER_NODE,
        ...Array.from({ length: LIMITS.maxHops }, (_, i) => `relay${i + 1}`),
      ]
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        message: wake({ hops }),
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(hops.length, LIMITS.maxHops + 1, '构造出的跳数')
        .expect(
          !hops.includes(NODE),
          '跳数里没有本节点名（免得测成 E_LOOP）',
          hops,
        )
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.receiptCode, 'E_TOO_MANY_HOPS', 'receipt 的 code')
        .eq(result.receiptReason, WIRE_REJECT_REASON, 'receipt 的 reason')
        .done('超跳被传输层判死')
    },
  },

  {
    id: 'limits/hop-limit-boundary-admitted',
    dimension: 'limits',
    title: `跳数恰好等于 LIMITS.maxHops（${LIMITS.maxHops}）仍被接收（边界不是 off-by-one）`,
    expected: `hops 有 ${LIMITS.maxHops} 段 → receipt='accepted'`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      const hops = [
        SENDER_NODE,
        ...Array.from(
          { length: LIMITS.maxHops - 1 },
          (_, i) => `relay${i + 1}`,
        ),
      ]
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        message: wake({ hops }),
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(hops.length, LIMITS.maxHops, '构造出的跳数')
        .eq(result.receipt, 'accepted', 'receipt')
        .eq(result.receiptCode, undefined, 'receipt 的 code')
        .done('恰好到顶的跳数仍然合法')
    },
  },

  {
    id: 'limits/envelope-too-large',
    dimension: 'limits',
    title: `信封超过 LIMITS.maxMessageBytes（${LIMITS.maxMessageBytes}）被判 E_TOO_LARGE`,
    expected:
      "体积落在「超过协议上限、但还没超过 socket 帧上限」的窗口里 → receipt='rejected' + code='E_TOO_LARGE'",
    requires: ['spawn-node', 'raw-dial'],
    timeoutMs: 90_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      // socket 层的上限是 `maxMessageBytes + 4096`（server.ts 的
      // MAX_FRAME_BYTES）。要观测到 E_TOO_LARGE，信封必须落在这 4 KiB 宽的
      // 窗口里：再大一点连接就先被掐了，那是另一条场景。取窗口中点，给帧
      // 外壳（`{"t":..,"v":..,"envelope":…}`）留出余量。
      const target = LIMITS.maxMessageBytes + 2048
      const message = inflateTo(target)
      const bytes = envelopeBytes(message)
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        message,
        timeoutMs: 30_000,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .note('信封字节数', `${bytes}（上限 ${LIMITS.maxMessageBytes}）`)
        .expect(
          bytes > LIMITS.maxMessageBytes &&
            bytes < LIMITS.maxMessageBytes + 4096,
          '构造出的体积落在「超协议上限、未超 socket 上限」的窗口里',
          bytes,
        )
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.receiptCode, 'E_TOO_LARGE', 'receipt 的 code')
        .eq(result.receiptReason, WIRE_REJECT_REASON, 'receipt 的 reason')
        .done('超体积被传输层判死')
    },
  },

  {
    id: 'limits/frame-over-socket-cap',
    dimension: 'limits',
    title:
      '帧超过 socket 上限：连接被掐，连回执都没有（拒绝在 JSON.parse 之前）',
    expected:
      '帧大于 maxMessageBytes + 4096 → 没有任何 receipt 帧，连接被服务端关闭',
    requires: ['spawn-node', 'raw-dial'],
    timeoutMs: 90_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      const message = inflateTo(LIMITS.maxMessageBytes * 2)
      const probe = await rawDial({
        url: node.endpoint,
        node: SENDER_NODE,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        sendAfterReady: [
          { t: FrameType.Envelope, v: FRAME_VERSION, envelope: message },
        ],
        settleMs: 3_000,
        timeoutMs: 30_000,
      })
      const receipts = probe.frames.filter(f =>
        f.includes(`"t":${FrameType.Receipt}`),
      )
      return new Checks()
        .note('信封字节数', envelopeBytes(message))
        .note(
          'close',
          `${probe.closeCode ?? '-'} / ${probe.closeReason ?? '-'}`,
        )
        .note('收到的帧', probe.frames.join('\n').slice(0, 1_500))
        .expect(
          probe.authed,
          '握手先走通了（证明掐的是这一帧不是这条连接）',
          probe.authed,
        )
        .eq(receipts.length, 0, '回执帧数（超帧上限时一条都不该有）')
        .expect(
          probe.closeCode !== undefined,
          '服务端把连接关掉了',
          probe.closeCode,
        )
        .done('超帧上限在解析之前就被挡住')
    },
  },

  {
    id: 'limits/inbound-rate-budget',
    dimension: 'limits',
    title: `单个发送节点的入站预算 LIMITS.ratePerMinute（${LIMITS.ratePerMinute}/分钟）真的封顶`,
    expected: `一口气发 ${LIMITS.ratePerMinute + 120} 条 → 出现 E_RATE_LIMITED，且被放行的条数不少于 ${LIMITS.ratePerMinute}`,
    requires: ['spawn-node', 'raw-dial'],
    timeoutMs: 180_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      // 收件人是一个**不存在的 agent**：预算闸门排在投递之前，所以每一条都
      // 会先过预算、再撞上 E_UNKNOWN_AGENT。用真 agent 的话六百条唤醒会各起
      // 一轮 ACP，测的就变成排队而不是预算了。
      const ghost = `qianmo://${NODE}/ghost`
      const count = LIMITS.ratePerMinute + 120
      const messages = Array.from({ length: count }, (_, i) =>
        wake({
          to: ghost,
          payload: { trigger: 'manual', prompt: `rate probe ${i}` },
        }),
      )
      // taskId 必须条条不同，否则环路闸门（键是 `(收件地址, taskId)`）会在
      // 预算之前先把第二条起全判成 E_LOOP。`createMessage` 默认就每条一个新
      // taskId，这里只做一次自检。
      const distinctTasks = new Set(messages.map(m => m.taskId)).size

      const burst = await sendBurst({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        messages,
        settleMs: 60_000,
        timeoutMs: 150_000,
      })
      const limited = burst.responses.filter(
        r => r.errorCode === 'E_RATE_LIMITED',
      )
      const admittedByBudget = burst.responses.filter(
        r => r.errorCode !== undefined && r.errorCode !== 'E_RATE_LIMITED',
      )
      const firstLimited = burst.responses.findIndex(
        r => r.errorCode === 'E_RATE_LIMITED',
      )
      const answered = burst.responses.filter(r => r.receipt !== undefined)
      return new Checks()
        .eq(distinctTasks, count, '构造出的不同 taskId 数')
        .note(
          '答复分布',
          `收到回执 ${answered.length}/${count}；被预算拒 ${limited.length}；` +
            `过了预算 ${admittedByBudget.length}；第一次被拒是第 ${firstLimited + 1} 条`,
        )
        .expect(limited.length > 0, '出现了 E_RATE_LIMITED', limited.length)
        .expect(
          admittedByBudget.length >= LIMITS.ratePerMinute,
          `被放行的条数不少于 LIMITS.ratePerMinute（${LIMITS.ratePerMinute}）—— 预算不能提前收紧`,
          admittedByBudget.length,
        )
        .eq(
          limited[0]?.errorReason,
          `inbound budget: sender ${SENDER} exceeded this node's per-minute allowance`,
          '拒绝原因原文',
        )
        .done('入站速率预算按 LIMITS 封顶')
    },
  },
]
