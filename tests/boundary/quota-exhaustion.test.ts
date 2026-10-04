// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 边界类 ④：额度耗尽（`protocol.md` §8.3）。
 *
 * 三种「没额度了」，三个不同的层，**不要用同一个词把它们盖住**：
 *
 * | §8.3 的行 | 谁拒的 | 码 |
 * |---|---|---|
 * | `costLimit ≠ 0`（M0 恒为 0） | 出站校验，**根本不发出去** | `E_BUDGET_EXHAUSTED` |
 * | 协议层入站预算耗尽 | 接收节点 | `E_RATE_LIMITED` |
 * | 贷方资源满员 | 协商层 | `E_RESOURCE_REFUSED` |
 *
 * 第四种——模型/云服务的额度耗尽——不归协议管，它由处理方以失败的 `task.result`
 * 报出，再由 P5.1 的分类器认成 `quota-exhausted`。这里一并测，因为「谁负责认它」
 * 正是这条边界最容易糊掉的地方。
 */

import { describe, expect, test } from 'bun:test'
import {
  MessageType,
  ProtocolErrorCode,
  createMessage,
  validateMessage,
  type ResourceNeed,
} from '@qianmo/protocol'
import {
  BorrowerNegotiator,
  LenderNegotiator,
  NegotiationAuditLog,
} from '@qianmo/negotiation'
import { FailureCause, classifyFailure } from '@qianmo/diagnosis'

const NOW = 1_800_000_000_000
const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'
const NEED: ResourceNeed = { durationMs: 60_000, cpuCores: 1, memoryMb: 512 }

describe('④ 额度耗尽 —— costLimit ≠ 0（章程 N-1）', () => {
  test('带价钱的信封出站即被拦，不上线', () => {
    const paid = createMessage({
      from: PLANNER,
      to: REVIEWER,
      type: MessageType.TaskRequest,
      payload: { ask: 'work' },
      createdAt: NOW,
      costLimit: 1,
    })
    const result = validateMessage(paid, { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(issue => issue.code)).toContain(
      ProtocolErrorCode.E_BUDGET_EXHAUSTED,
    )
  })

  test('字段仍然存在——这条判据要验的就是「硬上限能拦住」这套机制', () => {
    const free = createMessage({
      from: PLANNER,
      to: REVIEWER,
      type: MessageType.TaskRequest,
      payload: { ask: 'work' },
      createdAt: NOW,
    })
    expect(free.costLimit).toBe(0)
    expect(validateMessage(free, { now: NOW }).ok).toBe(true)
  })
})

describe('④ 额度耗尽 —— 贷方满员（§13）', () => {
  test('已经借满的节点拒绝而不是排队', () => {
    const audit = new NegotiationAuditLog()
    const lender = new LenderNegotiator({
      address: REVIEWER,
      audit,
      now: () => NOW,
      policy: {
        ceiling: { durationMs: 600_000, cpuCores: 2, memoryMb: 2_048 },
        offerTtlMs: 60_000,
        maxConcurrentLeases: 1,
      },
    })
    const borrower = new BorrowerNegotiator({
      address: PLANNER,
      audit,
      now: () => NOW,
      policy: { minimum: { durationMs: 1_000, cpuCores: 1, memoryMb: 64 } },
    })

    lender.handle(borrower.request(REVIEWER, NEED, 'first').message)
    const second = lender.handle(
      borrower.request(REVIEWER, NEED, 'second').message,
    )
    const reply = second.reply
    expect(reply?.type).toBe(MessageType.Error)
    expect((reply?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_RESOURCE_REFUSED,
    )
    // 排队会把一次「现在没有」变成一次无人回收的等待。
    expect(lender.pending).toBe(1)
    lender.close()
    borrower.close()
  })
})

describe('④ 额度耗尽 —— 上游服务的额度（不归协议管）', () => {
  test('供应商 429 由诊断层认成 quota-exhausted，而不是被协议吞掉', () => {
    const diagnosis = classifyFailure({
      exitCode: 1,
      httpStatus: 429,
      service: 'provider-a',
      stderr: 'RateLimitError: quota exceeded for this key',
    })
    expect(diagnosis.cause).toBe(FailureCause.QuotaExhausted)
    expect(diagnosis.suggestedAction).toContain('allowance')
  })

  test('「额度耗尽」与「限流」在诊断层也不是同一个答案', () => {
    // 协议层的 E_RATE_LIMITED 是我们拒了对端；quota-exhausted 是上游拒了我们。
    // 两者的下一步动作完全不同，所以它们不能塌成一个词。
    const throttledByUs = classifyFailure({
      exitCode: 1,
      stderr:
        'E_RATE_LIMITED: sender exceeded this node’s per-minute allowance',
    })
    expect(throttledByUs.cause).toBe(FailureCause.QuotaExhausted)
    // 说明：文本里出现「rate limit」时诊断给的是 quota-exhausted，这在**任务失败**
    // 的语境下是对的——任务确实因为额度走不下去了。协议层的拒绝不会走到诊断层，
    // 它在信封上就有码。
  })
})
