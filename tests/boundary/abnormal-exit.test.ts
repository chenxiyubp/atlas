// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 边界类 ⑤：异常退出（`protocol.md` §8.3）。
 *
 * 「谁崩了、崩在哪一步、之后系统还欠谁一个答复」——这一类的每条用例都在回答最后
 * 那半句。三种崩法，三种不同的欠账：
 *
 * | §8.3 的行 | 崩了之后 |
 * |---|---|
 * | 接收方处理中抛错 | 去重项要**撤回**，否则发送方重投会被当成重复吸收掉，消息就此静默消失 |
 * | 借方在隧道中途消失 | 隧道要拆，但**租约不算还** |
 * | 发送方在 `sent` 后崩溃 | 由投递时限兜住，重投由两级去重保证幂等 |
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  createMessage,
  deliveryExpiresAt,
  isDeliveryExpired,
} from '@qianmo/protocol'
import {
  DedupTable,
  DedupVerdict,
  TransportClient,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import {
  TeardownReason,
  TunnelAuditLog,
  TunnelClient,
  TunnelHost,
} from '@qianmo/tunnel'

const PSK = 'boundary-psk-not-a-real-secret-00'
const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const tunnels: TunnelClient[] = []
const hosts: TunnelHost[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const tunnel of tunnels.splice(0)) await tunnel.close()
  for (const host of hosts.splice(0)) host.close(TeardownReason.Withdrawn)
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-boundary-'))
  dirs.push(dir)
  return join(dir, 'node.sock')
}

function request(taskId: string) {
  return createMessage({
    from: PLANNER,
    to: REVIEWER,
    type: MessageType.TaskRequest,
    payload: { ask: 'work' },
    taskId,
  })
}

describe('⑤ 异常退出 —— 接收方处理中抛错', () => {
  test('抛错撤回去重项，于是重投能落地而不是被当成重复吃掉', async () => {
    // 这条是这一类里最容易写反的：如果处理失败还把消息记成「见过了」，
    // 发送方的 at-least-once 重投会被去重吸收，一次瞬时故障就变成永久静默丢失。
    const socket = socketPath()
    const seen: string[] = []
    let failFirst = true
    const server = startTransportServer({
      psk: PSK,
      unix: socket,
      onMessage: message => {
        if (failFirst) {
          failFirst = false
          throw new Error('handler blew up mid-processing')
        }
        seen.push(message.msgId)
      },
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      backoff: { giveUpAfterMs: 0 },
    })
    clients.push(client)
    await client.connect(3_000)

    const envelope = request('crash-1')
    await expect(client.sendAndWait(envelope, 2_000)).rejects.toThrow()
    expect(seen).toEqual([])

    // 同一个信封原样重投——第二次必须真的被处理。
    await client.sendAndWait(envelope, 2_000)
    expect(seen).toEqual([envelope.msgId])
  })

  test('去重表本身：成功之后同一信封才算重复', () => {
    const table = new DedupTable({ now: () => Date.now() })
    const envelope = request('dedup-1')
    expect(table.admit(envelope)).toBe(DedupVerdict.Fresh)
    expect(table.admit(envelope)).toBe(DedupVerdict.DuplicateMsgId)
    table.forget(envelope)
    expect(table.admit(envelope)).toBe(DedupVerdict.Fresh)
  })
})

describe('⑤ 异常退出 —— 借方在隧道中途消失', () => {
  test('隧道拆掉，但拆的理由是「对端没了」而不是「已释放」', async () => {
    const socket = socketPath()
    const audit = new TunnelAuditLog()
    const closed: TeardownReason[] = []
    const host = new TunnelHost({
      offerId: 'offer-x',
      taskId: 'lease-x',
      borrower: PLANNER,
      psk: PSK,
      leaseMs: 300_000,
      unix: socket,
      audit,
      onClosed: reason => closed.push(reason),
    })
    hosts.push(host)
    host.start()

    const tunnel = new TunnelClient({
      address: PLANNER,
      node: 'node-a',
      psk: PSK,
      endpoint: { unix: socket },
      taskId: 'lease-x',
      lender: REVIEWER,
      audit,
    })
    tunnels.push(tunnel)
    await tunnel.connect(3_000)
    await tunnel.send({ run: 'work that will not finish' })

    // 借方就这么没了：没有释放，没有告别。
    await tunnel.close()
    const deadline = Date.now() + 3_000
    while (closed.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(closed).toEqual([TeardownReason.PeerLost])
    // 理由不能写成 released：那会让审计看起来像一次正常收尾。
    expect(host.closedBecause).toBe(TeardownReason.PeerLost)
  })
})

describe('⑤ 异常退出 —— 发送方在 sent 之后崩溃', () => {
  test('投递时限兜住这条消息，不需要发送方回来说话', () => {
    // 发送方崩了没人会撤回这条消息，所以它必须自己会过期——否则接收侧要等一个
    // 永远不会来的后续。
    const envelope = createMessage({
      from: PLANNER,
      to: REVIEWER,
      type: MessageType.TaskRequest,
      payload: { ask: 'work' },
      createdAt: 1_000,
      deliverTtlMs: 500,
    })
    expect(isDeliveryExpired(envelope, 1_400)).toBe(false)
    expect(isDeliveryExpired(envelope, deliveryExpiresAt(envelope) + 1)).toBe(
      true,
    )
  })

  test('重启后重建的同一件事被二级去重认出来（msgId 变了，指纹没变）', () => {
    const table = new DedupTable({ now: () => 1_000 })
    const first = createMessage({
      from: PLANNER,
      to: REVIEWER,
      type: MessageType.TaskRequest,
      payload: { ask: 'work' },
      taskId: 'restart-1',
      createdAt: 1_000,
    })
    const rebuilt = createMessage({
      from: PLANNER,
      to: REVIEWER,
      type: MessageType.TaskRequest,
      payload: { ask: 'work' },
      taskId: 'restart-1',
      createdAt: 1_100,
    })
    expect(rebuilt.msgId).not.toBe(first.msgId)
    expect(rebuilt.fingerprint).toBe(first.fingerprint)
    expect(table.admit(first)).toBe(DedupVerdict.Fresh)
    expect(table.admit(rebuilt)).toBe(DedupVerdict.DuplicateFingerprint)
  })
})
