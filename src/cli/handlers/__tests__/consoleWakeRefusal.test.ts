// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 「策略拒绝」与「真的连不上」在操作面上必须是两回事（issue #29）。
 *
 * 这两种处置的**排查动作完全相反**：一个去看节点的策略与审计链，另一个去看隧道、
 * 端口和路由。所以本文件的每条用例都盯着操作者真正看到的那两样东西 ——
 * `ConsoleFailure.code`（决定 HTTP 状态码）和 `failure.message`（决定页面上那一行）
 * —— 而不是内部异常的类名。
 *
 * 拒绝这一侧不写等价物：门是真的 `NodeCapabilities`（默认 `SIGNED_TASK_POLICY`），
 * 判定是真的 `NodeRouter.inbound`，回信是真的 `errorReply`，消息真的走完
 * `createMessage → outbound → 握手 → 投递 → 回执` 整条路。中间任何一环把原因弄丢，
 * 这里就红 —— 而 issue #29 正是「原因在半路被压成 `E_UNDELIVERABLE`」。
 */

import { describe, expect, test } from 'bun:test'
import { NodeCapabilities, StaticPublicKeyDirectory } from '@qianmo/capability'
import { ProtocolErrorCode, errorReply } from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import { startTransportServer } from '@qianmo/transport'
import { createWakePort } from '../consolePorts.js'
import { WakeRefusedError, executeResidentWake } from '../residentWake.js'

const PSK = 'console-wake-refusal-test-not-a-real-secret'
const TARGET_NODE = 'beta-1'
const TARGET = `qianmo://${TARGET_NODE}/beta-1`
const FROM = 'qianmo://console/operator'

type Handle = ReturnType<typeof startTransportServer>

/**
 * 一个按默认策略拒收未签名唤醒的节点。
 *
 * `onMessage` 的两行照抄 `src/services/qianmo/resident.ts` 的 `#receive`：先问
 * `router.inbound`，被拒就**先回一个 `error` 信封、再抛**。抛出去的那一下会被
 * `packages/transport/src/receiver.ts` 统一压成 `E_UNDELIVERABLE` 的回执，
 * 这正是本文件要覆盖的那条缝。
 */
function refusingNode(): Handle {
  const router = new NodeRouter({
    node: TARGET_NODE,
    capability: new NodeCapabilities({
      node: TARGET_NODE,
      directory: new StaticPublicKeyDirectory([]),
    }),
  })
  return startTransportServer({
    psk: PSK,
    port: 0,
    hostname: '127.0.0.1',
    onMessage: (message, context) => {
      const routed = router.inbound(message)
      if (routed.ok) return
      context.channel.send(errorReply(message, routed.code, routed.reason))
      throw new Error(routed.reason)
    },
  })
}

/** 一个收下信封又拒绝、但**什么都不回**的节点（`wake` 走投递层被拒时的形状）。 */
function silentlyRefusingNode(): Handle {
  return startTransportServer({
    psk: PSK,
    port: 0,
    hostname: '127.0.0.1',
    onMessage: () => {
      throw new Error('mailbox write failed')
    },
  })
}

function wakeAgainst(
  url: string,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: { code: string; message: string } }
> {
  return createWakePort({ url, psk: PSK, timeoutMs: 2_000 }).send({
    from: FROM,
    to: TARGET,
    prompt: 'run the nightly check',
    url: '',
  })
}

/** 一个保证没人在听的地址：起一个真的服务器拿到端口，再把它停掉。 */
async function deadUrl(): Promise<string> {
  const server = startTransportServer({
    psk: PSK,
    port: 0,
    hostname: '127.0.0.1',
    onMessage: () => {},
  })
  const url = server.url as string
  await server.stop()
  return url
}

describe('a node that refuses a wake by policy', () => {
  test('reaches the operator as 拒绝 with the real code, never as 不可达', async () => {
    const server = refusingNode()
    let result: Awaited<ReturnType<typeof wakeAgainst>>
    try {
      result = await wakeAgainst(server.url as string)
    } finally {
      await server.stop()
    }

    if (result.ok) throw new Error('the wake was expected to be refused')
    expect(result.failure.code).toBe('refused')
    // 真因必须出现在操作面上：issue #10 / #14 的排查文档一直按这个字写。
    expect(result.failure.message).toContain(
      ProtocolErrorCode.E_CAP_INSUFFICIENT,
    )
    expect(result.failure.message).toContain(
      'wake from console needs write-limited, presented read',
    )
    // 而把人引向网络排查的那两个词一个都不许出现。
    expect(result.failure.message).not.toContain('不可达')
    expect(result.failure.message).not.toContain('unreachable')
    expect(result.failure.message).not.toContain('E_UNDELIVERABLE')
  })

  test('executeResidentWake 把节点自己的说法原样带出来', async () => {
    const server = refusingNode()
    let error: unknown
    try {
      await executeResidentWake(
        {
          url: server.url as string,
          from: FROM,
          to: TARGET,
          prompt: 'run the nightly check',
          afterMs: 0,
          timeoutMs: 2_000,
          deliverTtlMs: 2_000,
        },
        PSK,
      )
    } catch (caught) {
      error = caught
    } finally {
      await server.stop()
    }

    if (!(error instanceof WakeRefusedError)) {
      throw new Error(`expected a WakeRefusedError, got ${String(error)}`)
    }
    expect(error.detail?.code).toBe(ProtocolErrorCode.E_CAP_INSUFFICIENT)
    expect(error.detail?.reason).toBe(
      'wake from console needs write-limited, presented read',
    )
    // 回执那一格照旧是被压平的那个码。留着是为了证明它被读过 —— 它只是不再是
    // 拿去给人看的那个原因。
    expect(error.receiptCode).toBe(ProtocolErrorCode.E_UNDELIVERABLE)
    expect(error.msgId).not.toBe('')
  })

  test('对面一句原因都不给时，仍然说「拒绝」并给出可查的抓手', async () => {
    const server = silentlyRefusingNode()
    let result: Awaited<ReturnType<typeof wakeAgainst>>
    try {
      result = await wakeAgainst(server.url as string)
    } finally {
      await server.stop()
    }

    if (result.ok) throw new Error('the wake was expected to be refused')
    // 拿不到原因不是退回「不可达」的理由：握手成功、信封送达、对面主动拒绝，
    // 这三件事和有没有拿到原因无关。
    expect(result.failure.code).toBe('refused')
    expect(result.failure.message).toContain('节点拒绝了这条唤醒')
    expect(result.failure.message).toContain('原因见该节点的审计链')
    expect(result.failure.message).not.toContain('不可达')
    expect(result.failure.message).not.toContain('unreachable')
  })
})

describe('a node that really is not there', () => {
  test('still reads as 不可达, and does not borrow the refusal wording', async () => {
    const result = await wakeAgainst(await deadUrl())

    if (result.ok) throw new Error('the wake was expected to fail')
    expect(result.failure.code).toBe('unreachable')
    expect(result.failure.message).not.toContain('节点拒绝了这条唤醒')
  })
})
