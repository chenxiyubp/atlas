// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 帧级原始拨号探针。
 *
 * 为什么不用 `TransportClient`：**它把 close code 吃掉了。**
 * `client.ts` 的 socket 只订阅 `close(code)`，reason 串根本不传给调用方，而
 * 12 种握手失败在线上又全部塌缩成同一个 `4003 / 'unauthorized'`。用官方客户端
 * 去测「错 PSK 该回什么」，能观察到的只有一个自己合成的
 * `'transport handshake rejected (4003)'` —— 那不是被测系统说的话。
 *
 * 所以这里照着 `packages/transport/test/retained-channel-auth.test.ts` 的
 * `rawHandshake` 自己发帧：challenge 来了就按指定的档位拼 auth 帧，然后把
 * **收到的每一帧原文**和**关闭时的 code/reason** 原样交出去。构造非法材料是
 * 这个探针存在的全部意义，所以它不做任何合法性检查。
 *
 * 一条必须记住的事实（会决定断言怎么写）：
 * **wire 上区分不出 bad_mac / bad_signature / unknown_signer / credential_required
 * / certificate_expired —— 它们都是 4003 + 'unauthorized'。**
 * 要分辨具体是哪一种，只能去读节点侧审计链里 `AuthRejected` 记录的 `rejection`
 * 字段。见 `readRejections()`。
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  authCredentialProofInput,
  authSigningInput,
  computeMac,
  FRAME_VERSION,
  FrameType,
  newChannelId,
  newNonce,
  parseFrame,
} from '@qianmo/transport'
import { signBytes } from '@qianmo/capability'
import type { NodeKeyPair } from '@qianmo/capability'
import type { DialProbe } from '../types.js'

/** 拨号档位。允许拼出服务端一定会拒的组合 —— 那正是要测的。 */
export type RawAuth =
  | { readonly kind: 'psk'; readonly psk: string }
  | {
      readonly kind: 'signature'
      readonly psk: string
      readonly keys: NodeKeyPair
    }
  | {
      readonly kind: 'credential_signature'
      readonly psk: string
      readonly keys: NodeKeyPair
      readonly credential: {
        readonly selector: string
        readonly source: string
        readonly id: string
      }
    }
  /** 带 credential 但**不带** sig —— 服务端应判 bad_signature。 */
  | {
      readonly kind: 'credential_without_sig'
      readonly psk: string
      readonly credential: {
        readonly selector: string
        readonly source: string
        readonly id: string
      }
    }
  /** 只带 credential 不带 credentialProof —— 应判 credential_required。 */
  | {
      readonly kind: 'half_credential'
      readonly psk: string
      readonly keys: NodeKeyPair
      readonly selector: string
    }
  /** 完全不发 auth 帧。 */
  | { readonly kind: 'none' }

export interface RawDialOptions {
  readonly url: string
  readonly node: string
  readonly auth: RawAuth
  readonly channelId?: string
  /** 不等握手完成就发的帧（原样序列化）—— 用来测 4003 / 1002。 */
  readonly sendBeforeAuth?: readonly unknown[]
  /** 握手完成后要发的帧。 */
  readonly sendAfterReady?: readonly unknown[]
  /**
   * 握手完成后再等多久收帧（默认 1500ms）。
   *
   * **写的是倍率为 1 时的值**，实际等待会乘 {@link dialTimeoutScale} —— 别在
   * 调用点自己乘一遍，那会变成平方。
   */
  readonly settleMs?: number
  /** 同上，写倍率为 1 时的值。 */
  readonly timeoutMs?: number
  /**
   * 提前收工判据：握手之后每收到一帧就问一次，答 true 就立刻结束。
   *
   * 只对**握手之后**的帧生效（`authed` 为真才问）—— 在 challenge 还没被应答
   * 之前收工，拿到的是一次自己造成的「没握手」，不是被测系统的答案。
   *
   * 存在的理由是批量场景：一次发七百条信封时，`settleMs` 要按最坏情况给到
   * 几十秒，而正常情况下最后一条回执两秒就到齐了。没有这条判据，那几十秒
   * 每轮都要白等。
   */
  readonly until?: (frames: readonly string[]) => boolean
}

/**
 * 拨一次，把观察到的一切交出来。
 *
 * 永不抛：拨不通也是一种观察，写进 `error` 字段。抛出去会被 runner 记成
 * `error`（套件自己炸了），而「连不上」通常是被测系统的答案。
 */
/**
 * 拨号这一层的墙钟倍率 —— 由 runner 每轮开跑前设一次。
 *
 * ## 为什么是一个环境值，而不是每个调用点自己乘
 *
 * `settleMs` / `timeoutMs` 是**墙钟等待**，跟 `--timeout-scale` 管的是同一件
 * 事（issue #91：慢机器上每一格都要一起放大）。但它们散在 24 个 `rawDial`
 * 调用点、37 处 `settleMs` 字面量上 —— 而 issue #99 已经用两个小时买过这条
 * 教训：**三十多个调用点靠人挑一遍必漏一个，漏掉的那个要到下一次真跑才发现**。
 *
 * 所以乘法只发生在这一处。调用点一个都不用改，也就一个都漏不掉。
 *
 * ## 它修的是什么
 *
 * 第 8 轮真机腿那条 `limits/envelope-too-large`：264 KB 的信封发过去，节点
 * **确实**回了 `E_TOO_LARGE`，但固定 3 s 的收帧窗口在 aarch64 小机器上不够，
 * 回执还没到窗口就关了。报出来是「receipt 应为 rejected」三条断言不成立 ——
 * 一条读起来像产品坏了、实际是套件自己等太短的红。把窗口钉成 200 ms 可以
 * 逐字复现同一条错误，那就是它。
 *
 * 与第 4 轮 `console/registry-lease-expires-and-renews` 是同一个病：**场景侧
 * 的硬编码墙钟不吃倍率**。那次修的是租约 TTL，这次修的是收帧窗口。
 */
let dialTimeoutScale = 1

/** runner 每轮开跑前设一次。见 {@link dialTimeoutScale} 的头注。 */
export function setDialTimeoutScale(scale: number): void {
  dialTimeoutScale = scale > 0 ? scale : 1
}

/** 当前倍率 —— 只给测试与自检看。 */
export function getDialTimeoutScale(): number {
  return dialTimeoutScale
}

export async function rawDial(options: RawDialOptions): Promise<DialProbe> {
  const timeoutMs = (options.timeoutMs ?? 8_000) * dialTimeoutScale
  const settleMs = (options.settleMs ?? 1_500) * dialTimeoutScale
  const channelId = options.channelId ?? newChannelId()
  const frames: string[] = []

  let socket: WebSocket
  try {
    socket = new WebSocket(options.url)
  } catch (err) {
    return { authed: false, frames, error: String(err) }
  }

  return await new Promise<DialProbe>(resolve => {
    let settled = false
    let authed = false
    let closeCode: number | undefined
    let closeReason: string | undefined
    let error: string | undefined
    let settleTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (): void => {
      if (settled) return
      settled = true
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      clearTimeout(hardTimer)
      try {
        socket.close()
      } catch {
        // 已经关了。
      }
      resolve({ authed, closeCode, closeReason, frames, error })
    }

    const hardTimer = setTimeout(() => {
      error = error ?? `拨号在 ${timeoutMs}ms 内既没握手成功也没被关闭`
      finish()
    }, timeoutMs)

    socket.on('error', err => {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    })

    socket.on('close', (code: number, reason: Buffer) => {
      closeCode = code
      closeReason = reason.toString()
      finish()
    })

    socket.on('open', () => {
      for (const frame of options.sendBeforeAuth ?? []) {
        socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
      }
    })

    socket.on('message', raw => {
      const text = raw.toString()
      frames.push(text)
      if (authed && options.until?.(frames) === true) {
        finish()
        return
      }
      const frame = parseFrame(text)
      if (frame === null) return

      if (frame.t === FrameType.Challenge) {
        if (options.auth.kind === 'none') return
        try {
          socket.send(
            JSON.stringify(
              buildAuthFrame(
                frame.nonce,
                options.node,
                channelId,
                options.auth,
              ),
            ),
          )
        } catch (err) {
          error = `拼 auth 帧失败: ${String(err)}`
          finish()
        }
        return
      }

      if (frame.t === FrameType.Ready) {
        authed = true
        for (const out of options.sendAfterReady ?? []) {
          socket.send(typeof out === 'string' ? out : JSON.stringify(out))
        }
        // 握手成功后不立刻收工：要给服务端时间把 receipt / error 信封发回来。
        // 期间若被关闭，`close` 事件会抢先 finish 并带上 code。
        settleTimer = setTimeout(finish, settleMs)
      }
    })
  })
}

/**
 * 故意不用 `AuthFrame` 类型：那个类型表达不了「带 credential 但不带 sig」
 * 这类被测组合，而那正是探针存在的意义。下游直接 `JSON.stringify`（
 * `serializeFrame` 本体就是它），所以不需要向 `TransportFrame` 强转。
 */
type LooseFrame = Record<string, unknown>

function buildAuthFrame(
  serverNonce: string,
  node: string,
  channelId: string,
  auth: RawAuth,
): LooseFrame {
  const clientNonce = newNonce()
  const psk = 'psk' in auth ? auth.psk : ''
  const base: LooseFrame = {
    t: FrameType.Auth,
    v: FRAME_VERSION,
    node,
    nonce: serverNonce,
    clientNonce,
    channelId,
    mac: computeMac(psk, serverNonce, clientNonce, node, channelId),
  }

  if (auth.kind === 'psk' || auth.kind === 'none') return base

  if (auth.kind === 'half_credential') {
    return {
      ...base,
      sig: signBytes(
        auth.keys,
        authSigningInput(serverNonce, clientNonce, node, channelId),
      ),
      // 故意只给一半：credential 有、credentialProof 无。
      credential: auth.selector,
    }
  }

  if (auth.kind === 'credential_without_sig') {
    return {
      ...base,
      credential: auth.credential.selector,
      credentialProof: 'x'.repeat(86),
    }
  }

  const signed = {
    ...base,
    sig: signBytes(
      auth.keys,
      authSigningInput(serverNonce, clientNonce, node, channelId),
    ),
  }
  if (auth.kind === 'signature') return signed

  return {
    ...signed,
    credential: auth.credential.selector,
    credentialProof: signBytes(
      auth.keys,
      authCredentialProofInput(
        serverNonce,
        clientNonce,
        node,
        channelId,
        auth.credential.selector,
        auth.credential.source,
        auth.credential.id,
      ),
    ),
  }
}

/**
 * 拼一个**能通过 `parseFrame`** 的 envelope 帧，用来测「未握手就发业务帧」。
 *
 * 字段名必须是 `envelope`（不是 `msg`）：写错了 `parseFrame` 返回 null，服务端
 * 走的是 `malformed_frame` / **1002**，而不是 `unexpected_frame` / **4003**。
 * 两条都要测，但要分清哪条是哪条 —— 这个坑在写这份套件时真踩过一次。
 */
export function bogusEnvelopeFrame(): Record<string, unknown> {
  return {
    t: FrameType.Envelope,
    v: FRAME_VERSION,
    envelope: {
      v: 0,
      id: randomUUID(),
      from: 'qianmo://intruder/main',
      to: 'qianmo://victim/main',
      type: 'task.request',
      createdAt: Date.now(),
      payload: { instruction: 'ping' },
    },
  }
}

/** 一个 `parseFrame` 必然拒收的帧 —— 用来测 1002 / `malformed_frame`。 */
export function malformedFrame(): Record<string, unknown> {
  // 版本号不对：`parseFrame` 用严格相等比 `v`，v=99 直接 null。
  return { t: FrameType.Envelope, v: 99, envelope: {} }
}
