// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 边界类 ②：超时（`protocol.md` §8.3）。
 *
 * 三条不同的时限，三种不同的失败，**不能混为一谈**：
 *
 * - **投递时限**（`deliverTtlMs`）管 `created → acked`，到期是 `expired`；
 * - **任务时限**（`taskTtlMs`）管 `created → completed/failed`，到期是 `timeout`；
 * - **报价时限**（§13）管一次协商的中段，到期是预留归还。
 *
 * 把它们做成一个字段正是 v2.2 修过的那个根因（30 s 存活的消息等不到 60 s 回执），
 * 所以这里逐条分开测。
 */

import { describe, expect, test } from 'bun:test'
import {
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  createMessage,
  deliveryExpiresAt,
  isDeliveryExpired,
  isTaskExpired,
  taskExpiresAt,
  validateMessage,
  type ResourceNeed,
} from '@qianmo/protocol'
import {
  BorrowerNegotiator,
  LenderNegotiator,
  NegotiationAuditLog,
  type CancelTimer,
  type Scheduler,
} from '@qianmo/negotiation'
import { NodeRouter } from '@qianmo/router'

const SENDER = 'qianmo://node-a/planner'
const TARGET = 'qianmo://node-b/reviewer'
const NOW = 1_800_000_000_000

class ManualScheduler implements Scheduler {
  #armed: Array<{ at: number; callback: () => void }> = []
  clock = NOW

  after(delayMs: number, callback: () => void): CancelTimer {
    const entry = { at: this.clock + delayMs, callback }
    this.#armed.push(entry)
    return () => {
      this.#armed = this.#armed.filter(item => item !== entry)
    }
  }

  advance(ms: number): void {
    this.clock += ms
    const due = this.#armed.filter(entry => entry.at <= this.clock)
    this.#armed = this.#armed.filter(entry => entry.at > this.clock)
    for (const entry of due) entry.callback()
  }
}

function message(
  overrides: { deliverTtlMs?: number; taskTtlMs?: number } = {},
) {
  return createMessage({
    from: SENDER,
    to: TARGET,
    type: MessageType.TaskRequest,
    payload: { ask: 'work' },
    createdAt: NOW,
    ...(overrides.deliverTtlMs === undefined
      ? {}
      : { deliverTtlMs: overrides.deliverTtlMs }),
    ...(overrides.taskTtlMs === undefined
      ? {}
      : { taskTtlMs: overrides.taskTtlMs }),
  })
}

describe('② 超时 —— 投递时限（§8.3 行「投递时限到期（三处判定）」）', () => {
  test('入站校验在时限之后拒收，并给出 E_TTL_EXPIRED', () => {
    const envelope = message({ deliverTtlMs: 1_000 })
    const result = validateMessage(envelope, { now: NOW + 1_001 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.code).toBe(ProtocolErrorCode.E_TTL_EXPIRED)
  })

  test('刚好在时限上不算过期——边界是「大于」，不是「大于等于」', () => {
    const envelope = message({ deliverTtlMs: 1_000 })
    expect(isDeliveryExpired(envelope, deliveryExpiresAt(envelope))).toBe(false)
    expect(isDeliveryExpired(envelope, deliveryExpiresAt(envelope) + 1)).toBe(
      true,
    )
  })

  test('两个时限是两条线，任务线比投递线长', () => {
    // v2.2 修的根因：一个字段身兼两职时，30 s 的默认存活等不到 60 s 的回执线。
    const envelope = message()
    expect(taskExpiresAt(envelope)).toBeGreaterThan(deliveryExpiresAt(envelope))
    expect(LIMITS.defaultTaskTtlMs).toBeGreaterThan(LIMITS.defaultTtlMs)
  })
})

describe('② 超时 —— 任务时限（§8.3 行「任务时限到期」）', () => {
  test('投递早已完成之后，任务线仍能独立到期', () => {
    const envelope = message({ deliverTtlMs: 1_000, taskTtlMs: 10_000 })
    const afterDelivery = NOW + 2_000
    expect(isDeliveryExpired(envelope, afterDelivery)).toBe(true)
    expect(isTaskExpired(envelope, afterDelivery)).toBe(false)
    expect(isTaskExpired(envelope, NOW + 10_001)).toBe(true)
  })
})

describe('② 超时 —— 报价时限（§13.4）', () => {
  test('没人接的报价到点自动归还，贷方不留悬挂预留', () => {
    const scheduler = new ManualScheduler()
    const audit = new NegotiationAuditLog()
    const lender = new LenderNegotiator({
      address: TARGET,
      audit,
      scheduler,
      now: () => scheduler.clock,
      policy: {
        ceiling: { durationMs: 600_000, cpuCores: 2, memoryMb: 2_048 },
        offerTtlMs: 30_000,
      },
    })
    const borrower = new BorrowerNegotiator({
      address: SENDER,
      audit,
      scheduler,
      now: () => scheduler.clock,
      policy: {
        minimum: {
          durationMs: 1_000,
          cpuCores: 1,
          memoryMb: 64,
        } as ResourceNeed,
      },
    })
    const opened = borrower.request(
      TARGET,
      { durationMs: 60_000, cpuCores: 1, memoryMb: 512 },
      'boundary probe',
    )
    lender.handle(opened.message)
    expect(lender.pending).toBe(1)

    scheduler.advance(30_001)
    expect(lender.pending).toBe(0)
    lender.close()
    borrower.close()
  })
})

describe('② 超时 —— 时限判定必须过时间跳跃闸门（§5.3 T-2）', () => {
  test('刚解冻的节点不会把手里的在飞消息一次性判死', () => {
    // 冻结期间单调钟照常前进（E4），所以解冻瞬间「距上次见到 X 多久」会集体越阈。
    // 路由层的判环表用的是**过闸门的时钟**，因此这里用一个把时间往回拨的
    // `deadlineNow` 模拟宽限窗口，断言消息仍被接住。
    const envelope = message({ deliverTtlMs: 1_000 })
    const thawedAt = NOW + 120_000
    const router = new NodeRouter({
      node: 'node-b',
      now: () => thawedAt,
      // 闸门把「冻结那段」从判定里扣掉：对这条消息而言，时间还停在它刚到的时候。
      deadlineNow: () => NOW + 500,
    })
    expect(router.inbound(envelope).ok).toBe(true)
  })
})
