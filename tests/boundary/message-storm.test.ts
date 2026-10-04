// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 边界类 ③：消息风暴（`protocol.md` §8.3）。
 *
 * 三行，三种不同的失控，**互不替代**：
 *
 * | §8.3 的行 | 抓它的机制 |
 * |---|---|
 * | 单发送方入站洪水 | 协议层入站预算（`LIMITS.ratePerMinute`） |
 * | 单发送方对单目标高频 | 运行时层令牌桶（不进状态机） |
 * | A→B→A 回环 | 判环键 `(处理者地址, taskId)` |
 *
 * 这里测的是**三者同时装在一个路由器上时各管各的**——包内用例已分别证明每个零件
 * 对；组合起来会不会互相顶掉，是另一个问题。
 */

import { describe, expect, test } from 'bun:test'
import {
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  createMessage,
} from '@qianmo/protocol'
import {
  E_RUNTIME_THROTTLED,
  InboundBudget,
  NodeRouter,
  RUNTIME_RATE,
  RouterEventType,
} from '@qianmo/router'

const NOW = 1_800_000_000_000
const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'
const ARCHIVIST = 'qianmo://node-b/archivist'

function request(taskId: string, to = REVIEWER, from = PLANNER) {
  return createMessage({
    from,
    to,
    type: MessageType.TaskRequest,
    payload: { ask: 'work' },
    taskId,
    createdAt: NOW,
  })
}

describe('③ 消息风暴 —— 单发送方入站洪水', () => {
  test('协议层预算耗尽后拒收，且回的是 E_RATE_LIMITED', () => {
    const router = new NodeRouter({
      node: 'node-b',
      now: () => NOW,
      budget: new InboundBudget({ perMinute: 5 }),
    })
    for (let index = 0; index < 5; index += 1) {
      expect(router.inbound(request(`flood-${index}`)).ok).toBe(true)
    }
    const refused = router.inbound(request('flood-over'))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe(ProtocolErrorCode.E_RATE_LIMITED)
    expect(router.audit.count(RouterEventType.RateLimited)).toBe(1)
  })

  test('预算按发送**节点**计，换个 agent 名字拿不到第二份', () => {
    const router = new NodeRouter({
      node: 'node-b',
      now: () => NOW,
      budget: new InboundBudget({ perMinute: 2 }),
    })
    expect(router.inbound(request('a', REVIEWER, PLANNER)).ok).toBe(true)
    expect(
      router.inbound(request('b', REVIEWER, 'qianmo://node-a/second')).ok,
    ).toBe(true)
    expect(
      router.inbound(request('c', REVIEWER, 'qianmo://node-a/third')).ok,
    ).toBe(false)
  })

  test('默认预算就是协议给的那个数，不是包里另写的一个', () => {
    const router = new NodeRouter({ node: 'node-b', now: () => NOW })
    expect(router.budget.remaining('node-a', NOW)).toBe(LIMITS.ratePerMinute)
  })
})

describe('③ 消息风暴 —— 单发送方对单目标高频', () => {
  test('运行时层第 21 条被本地拒，且不上线', () => {
    const router = new NodeRouter({ node: 'node-a', now: () => NOW })
    let allowed = 0
    for (let index = 0; index < RUNTIME_RATE.capacity + 1; index += 1) {
      const verdict = router.outbound(request(`rt-${index}`))
      if (verdict.ok) allowed += 1
      else expect(verdict.code).toBe(E_RUNTIME_THROTTLED)
    }
    expect(allowed).toBe(RUNTIME_RATE.capacity)
    expect(router.audit.count(RouterEventType.RuntimeThrottled)).toBe(1)
    // 两层不得混写：运行时层不产生协议层的事件。
    expect(router.audit.count(RouterEventType.RateLimited)).toBe(0)
  })

  test('换一个目标地址立刻放行——这一层是「对单目标」', () => {
    const router = new NodeRouter({ node: 'node-a', now: () => NOW })
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      router.outbound(request(`rt-${index}`))
    }
    expect(router.outbound(request('rt-over')).ok).toBe(false)
    expect(router.outbound(request('rt-other', ARCHIVIST)).ok).toBe(true)
  })
})

describe('③ 消息风暴 —— A→B→A 回环', () => {
  test('首次回访同一处理者 + 同一任务即切断，且不是跳数兜底救的场', () => {
    const nodeA = new NodeRouter({ node: 'node-a', now: () => NOW })
    const nodeB = new NodeRouter({ node: 'node-b', now: () => NOW })

    const outbound = nodeA.outbound(request('loop-1'))
    expect(outbound.ok).toBe(true)
    if (!outbound.ok) return
    expect(nodeB.inbound(outbound.message).ok).toBe(true)

    const bounced = createMessage({
      from: REVIEWER,
      to: PLANNER,
      type: MessageType.TaskRequest,
      payload: { ask: 'back at you' },
      taskId: 'loop-1',
      traceId: outbound.message.traceId,
      hops: outbound.message.hops,
      createdAt: NOW,
    })
    const relayed = nodeB.outbound(bounced)
    expect(relayed.ok).toBe(true)
    if (!relayed.ok) return

    const cut = nodeA.inbound(relayed.message)
    expect(cut.ok).toBe(false)
    if (cut.ok) return
    expect(cut.code).toBe(ProtocolErrorCode.E_LOOP)
    // 两跳而已，远不到 maxHops——切断它的是判环键，不是兜底。
    expect(relayed.message.hops.length).toBeLessThan(LIMITS.maxHops)
    const event = nodeA.audit.of(RouterEventType.LoopDetected)[0]
    expect(event?.detail['taskId']).toBe('loop-1')
    expect(event?.detail['traceId']).toBeDefined()
  })

  test('同一节点因不同目标地址被再次经过，不算环', () => {
    // D-2 改动的全部意义。没有这条反向用例，节点粒度的「简化」会悄悄回来。
    const nodeB = new NodeRouter({ node: 'node-b', now: () => NOW })
    expect(nodeB.inbound(request('spiral', REVIEWER)).ok).toBe(true)
    expect(nodeB.inbound(request('spiral', ARCHIVIST)).ok).toBe(true)
    expect(nodeB.audit.count(RouterEventType.LoopDetected)).toBe(0)
  })

  test('风暴之下，回环仍被报成回环而不是被限流顶掉', () => {
    // 顺序上判环在预算之前，理由就是这条：运维要看到的是「流量在打转」，
    // 而不是「某个对端很吵」。
    const router = new NodeRouter({
      node: 'node-b',
      now: () => NOW,
      budget: new InboundBudget({ perMinute: 2 }),
    })
    expect(router.inbound(request('storm')).ok).toBe(true)
    const looped = router.inbound(request('storm'))
    expect(looped.ok).toBe(false)
    if (looped.ok) return
    expect(looped.code).toBe(ProtocolErrorCode.E_LOOP)
  })
})

describe('③ 消息风暴 —— 自动回复乒乓', () => {
  test('每圈换新 taskId 时判环看不见它，抓住它的是令牌桶', () => {
    // D-2 点名的第三个缺陷，如实测出来：判环与跳数都不会响。
    const router = new NodeRouter({ node: 'node-a', now: () => NOW })
    let refused = 0
    for (let lap = 0; lap < RUNTIME_RATE.capacity + 5; lap += 1) {
      if (!router.outbound(request(`pong-${lap}`)).ok) refused += 1
    }
    expect(router.audit.count(RouterEventType.LoopDetected)).toBe(0)
    expect(refused).toBe(5)
  })
})
