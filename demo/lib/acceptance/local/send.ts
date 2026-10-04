// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 往节点发一条**自己完全掌控的**信封，并把节点的回应原样收回来。
 *
 * 为什么不用 `qm resident-wake`：它只会发**没有 cap** 的唤醒（
 * `parseResidentWakeArgs` 返回的 `issueCapability` 恒为 undefined），而能力维度
 * 的十条场景要的正是「带一个过期的 / 换了 aud 的 / 签名坏掉的 token 会怎样」。
 * 只有自己拼信封才表达得了。
 *
 * 回应有两种，都要收：
 *   · `receipt` 帧 —— `accepted` / `duplicate` / `rejected`，传输层的答复；
 *   · `error` 信封 —— 节点侧的拒绝原因（issue #34 / PR #42 之后，投递层拒绝
 *     也会补发这一条）。**它是能力与投递两维全部断言的落点。**
 */

import {
  generateNodeKeyPair,
  issueCapability,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  CapabilityLevel,
  createMessage,
  MessageType,
  withHop,
} from '@qianmo/protocol'
import type { QianmoMessage } from '@qianmo/protocol'
import { FRAME_VERSION, FrameType } from '@qianmo/transport'
import { rawDial, type RawAuth } from './dial.js'

export interface SendResult {
  /** 传输层回执状态；没收到就是 undefined。 */
  readonly receipt?: string
  readonly receiptCode?: string
  readonly receiptReason?: string
  /** 节点回的 error 信封 payload。 */
  readonly errorCode?: string
  readonly errorReason?: string
  /** 收到的全部帧原文 —— 断言不成立时这就是证据。 */
  readonly frames: readonly string[]
  readonly closeCode?: number
  readonly dialError?: string
  readonly message: QianmoMessage
}

export interface SendOptions {
  readonly url: string
  readonly psk: string
  /** 发送方节点段，握手时用。 */
  readonly fromNode: string
  readonly from: string
  readonly to: string
  readonly type?: MessageType
  readonly payload?: unknown
  readonly cap?: string
  readonly taskId?: string
  /** 直接给一条已经拼好的信封（重放场景要一字不改地再发一次）。 */
  readonly message?: QianmoMessage
  readonly settleMs?: number
  readonly timeoutMs?: number
}

export function buildMessage(options: SendOptions): QianmoMessage {
  if (options.message !== undefined) return options.message
  const draft = createMessage({
    from: options.from,
    to: options.to,
    type: options.type ?? MessageType.Wake,
    payload: options.payload ?? {
      trigger: 'manual',
      prompt: 'acceptance ping',
    },
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  })
  // hops[0] 必须是发起节点，否则审计链没有头、跳数少算一跳（protocol.md §6.3）。
  return withHop(draft, options.fromNode)
}

/**
 * 回执缺席时的现场 —— 一行话说清坏的是哪一侧。
 *
 * `SendResult` 一直带着 `closeCode` / `dialError` / `frames`，而断言 receipt 的
 * 15 条场景里有 13 条一个都不 note。回执没来的时候，报告上只剩三行空的 FAILED，
 * 分不出这两件事：
 *
 *   · **socket 半路死了** —— 套件自己的链路，与被测系统无关（issue #96 那一类）；
 *   · **产品收了却不吭声** —— 真的是产品缺陷。
 *
 * 这两件事的处置完全相反，而报告上长得一样。第 8 轮那条
 * `limits/envelope-too-large` 就是这么花掉一小时的（issue #109）。
 *
 * 旁边的 `limits/frame-over-socket-cap` 早就 note 了 close 与收到的帧 ——
 * 那是对的做法，这个 helper 只是让其余 13 条也做得起。
 */
export function receiptScene(result: SendResult): string {
  const parts = [
    `close=${result.closeCode === undefined ? '-' : String(result.closeCode)}`,
    `dialError=${result.dialError ?? '-'}`,
    `帧 ${String(result.frames.length)} 条`,
  ]
  if (result.frames.length > 0) {
    parts.push(result.frames.join(' | ').slice(0, 600))
  }
  return parts.join(' · ')
}

export async function sendEnvelope(options: SendOptions): Promise<SendResult> {
  const message = buildMessage(options)
  const auth: RawAuth = { kind: 'psk', psk: options.psk }
  const probe = await rawDial({
    url: options.url,
    node: options.fromNode,
    auth,
    sendAfterReady: [
      { t: FrameType.Envelope, v: FRAME_VERSION, envelope: message },
    ],
    settleMs: options.settleMs ?? 3_000,
    timeoutMs: options.timeoutMs ?? 15_000,
  })

  let receipt: string | undefined
  let receiptCode: string | undefined
  let receiptReason: string | undefined
  let errorCode: string | undefined
  let errorReason: string | undefined

  for (const raw of probe.frames) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const frame = parsed as Record<string, unknown>
    if (frame.t === FrameType.Receipt && frame.msgId === message.msgId) {
      receipt = typeof frame.status === 'string' ? frame.status : undefined
      receiptCode = typeof frame.code === 'string' ? frame.code : undefined
      receiptReason =
        typeof frame.reason === 'string' ? frame.reason : undefined
      continue
    }
    if (frame.t !== FrameType.Envelope) continue
    const envelope = frame.envelope as Record<string, unknown> | undefined
    if (envelope?.type !== MessageType.Error) continue
    if (envelope.taskId !== message.taskId) continue
    const payload = envelope.payload as Record<string, unknown> | undefined
    if (typeof payload?.code === 'string') errorCode = payload.code
    if (typeof payload?.reason === 'string') errorReason = payload.reason
  }

  return {
    receipt,
    receiptCode,
    receiptReason,
    errorCode,
    errorReason,
    frames: probe.frames,
    closeCode: probe.closeCode,
    dialError: probe.error,
    message,
  }
}

// ---------------------------------------------------------------------------
// 能力 token 工厂 —— 合法的与故意坏掉的
// ---------------------------------------------------------------------------

export interface Issuer {
  readonly node: string
  readonly keys: NodeKeyPair
}

export function newIssuer(node: string): Issuer {
  return { node, keys: generateNodeKeyPair() }
}

/** `--trust <node>=<publicKey>` 的那一行。 */
export function trustArg(issuer: Issuer): string {
  return `${issuer.node}=${issuer.keys.publicKey}`
}

export interface MintOptions {
  /** 授权的 handler，完整地址；缺省取 `aud` 节点的 `main`。 */
  readonly sub: string
  /** 验证方节点段。 */
  readonly aud: string
  readonly taskId: string
  readonly act?: CapabilityLevel
  readonly nbf?: number
  readonly exp?: number
  readonly nonce?: string
}

export function mint(issuer: Issuer, options: MintOptions): string {
  const now = Date.now()
  return issueCapability(issuer.node, issuer.keys, {
    sub: options.sub,
    aud: options.aud,
    act: options.act ?? CapabilityLevel.WriteLimited,
    taskId: options.taskId,
    nbf: options.nbf ?? now - 30_000,
    exp: options.exp ?? now + 60_000,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  })
}

/**
 * 把一个合法 token 的签名换成一串合法形状的垃圾。
 *
 * 用 86 个 `A` 而不是随便截断：`parseCapabilityToken` 先按
 * `/^[A-Za-z0-9_-]{86}$/` 判形状，形状不对会落到 `capability token is malformed`
 * 而不是 `capability signature does not verify` —— 两条断言测的是两件事。
 */
export function withBrokenSignature(token: string): string {
  const dot = token.lastIndexOf('.')
  return `${token.slice(0, dot)}.${'A'.repeat(86)}`
}

export { CapabilityLevel, MessageType }

// ---------------------------------------------------------------------------
// 批量投递 —— 速率预算那一维唯一测得动的形状
// ---------------------------------------------------------------------------

/** 一条信封在批量投递里拿到的答复。 */
export interface BurstResponse {
  readonly receipt?: string
  readonly receiptCode?: string
  readonly errorCode?: string
  readonly errorReason?: string
}

export interface BurstResult {
  /** 与传入 `messages` 同序，一一对应。 */
  readonly responses: readonly BurstResponse[]
  readonly frames: readonly string[]
  readonly closeCode?: number
  readonly dialError?: string
}

/**
 * 在**一条连接上**连发多条信封，把每条的答复各自收回来。
 *
 * 为什么不能用 `sendEnvelope` 循环：速率预算是 `LIMITS.ratePerMinute` 条/分钟
 * 的连续补充令牌桶（`packages/router/src/rate.ts`），每秒补回 1/60 的容量。
 * 一条一条拨号，每次握手加收帧的开销让六百条要跑好几分钟，那时候桶早就补满
 * 了 —— 测不出上限，只测出「补得比发得快」。所以必须一次握手、一口气发完。
 *
 * 回执与 error 信封两条线都收：预算拒绝走的是 `errorReply`（error 信封里带
 * `E_RATE_LIMITED`），而回执被 `receiver.ts` 压成 `E_UNDELIVERABLE` —— 只看
 * 回执分辨不出「被预算拦下」和「投递失败」。
 */
export async function sendBurst(options: {
  readonly url: string
  readonly psk: string
  readonly fromNode: string
  readonly messages: readonly QianmoMessage[]
  readonly settleMs?: number
  readonly timeoutMs?: number
}): Promise<BurstResult> {
  const byMsgId = new Map<string, number>()
  const byTaskId = new Map<string, number>()
  options.messages.forEach((message, index) => {
    byMsgId.set(message.msgId, index)
    // 同一个 taskId 只认第一条：批量里本来就该条条不同，重复说明构造有误，
    // 而静默覆盖会让证据指向错误的那一条。
    if (!byTaskId.has(message.taskId)) byTaskId.set(message.taskId, index)
  })

  const answered = new Set<number>()
  const countAnswered = (frames: readonly string[]): number => {
    // 只在末帧上做增量判断：`until` 每收一帧问一次，全量重扫是 O(n²)。
    const last = frames.at(-1)
    if (last !== undefined) {
      const index = indexOfReceipt(last, byMsgId)
      if (index !== undefined) answered.add(index)
    }
    return answered.size
  }

  const probe = await rawDial({
    url: options.url,
    node: options.fromNode,
    auth: { kind: 'psk', psk: options.psk },
    sendAfterReady: options.messages.map(message => ({
      t: FrameType.Envelope,
      v: FRAME_VERSION,
      envelope: message,
    })),
    settleMs: options.settleMs ?? 30_000,
    timeoutMs: options.timeoutMs ?? 90_000,
    until: frames => countAnswered(frames) >= options.messages.length,
  })

  const responses: BurstResponse[] = options.messages.map(() => ({}))
  for (const raw of probe.frames) {
    const parsed = parseObject(raw)
    if (parsed === undefined) continue
    if (parsed.t === FrameType.Receipt) {
      const index = byMsgId.get(String(parsed.msgId))
      if (index === undefined) continue
      responses[index] = {
        ...responses[index],
        ...(typeof parsed.status === 'string'
          ? { receipt: parsed.status }
          : {}),
        ...(typeof parsed.code === 'string'
          ? { receiptCode: parsed.code }
          : {}),
      }
      continue
    }
    if (parsed.t !== FrameType.Envelope) continue
    const envelope = parsed.envelope as Record<string, unknown> | undefined
    if (envelope?.type !== MessageType.Error) continue
    const index = byTaskId.get(String(envelope.taskId))
    if (index === undefined) continue
    const payload = envelope.payload as Record<string, unknown> | undefined
    responses[index] = {
      ...responses[index],
      ...(typeof payload?.code === 'string' ? { errorCode: payload.code } : {}),
      ...(typeof payload?.reason === 'string'
        ? { errorReason: payload.reason }
        : {}),
    }
  }

  return {
    responses,
    frames: probe.frames,
    ...(probe.closeCode === undefined ? {} : { closeCode: probe.closeCode }),
    ...(probe.error === undefined ? {} : { dialError: probe.error }),
  }
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return parsed as Record<string, unknown>
}

/**
 * 这一帧是第几条信封的**回执**。
 *
 * 只认回执、不认 error 信封，虽然两者都是答复：一条被拒的信封会先收到 error
 * 信封、再收到回执（`#receive` 先 `channel.send(errorReply(...))` 再抛，
 * `receiver.ts` 抛之后才发回执）。按「谁先到就算答完」收工，会在最后一条的
 * 回执到达之前就把 socket 关掉，于是那一条的 `receipt` 字段永远是空的 ——
 * 而回执状态正是速率那条场景要读的东西之一。
 */
function indexOfReceipt(
  raw: string,
  byMsgId: ReadonlyMap<string, number>,
): number | undefined {
  const parsed = parseObject(raw)
  if (parsed === undefined) return undefined
  if (parsed.t !== FrameType.Receipt) return undefined
  return byMsgId.get(String(parsed.msgId))
}
