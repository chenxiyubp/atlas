// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  CapabilityLevel,
  LIMITS,
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  createAck,
  createTaskResult,
  type NoticeTrust,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  E_RUNTIME_THROTTLED,
  InboundBudget,
  NodeRouter,
  RUNTIME_RATE,
  RouterEventType,
  type CapabilityDecision,
  type CapabilityGate,
  type RouterAuditEvent,
} from '../src/index.js'
import {
  ARCHIVIST,
  NODE_A,
  NODE_B,
  PLANNER,
  REVIEWER,
  makeMessage,
} from './helpers.js'

const CLOCK = 1_000_000

function routerAt(node: string, now: () => number): NodeRouter {
  return new NodeRouter({ node, now })
}

describe('outbound — hop seeding', () => {
  test('the origin writes itself into hops[0]', () => {
    const router = routerAt(NODE_A, () => CLOCK)
    const verdict = router.outbound(makeMessage({ createdAt: CLOCK }))
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.message.hops).toEqual([NODE_A])
  })

  test('a relay appends rather than replacing', () => {
    const relay = routerAt(NODE_B, () => CLOCK)
    const verdict = relay.outbound(
      makeMessage({ createdAt: CLOCK, hops: [NODE_A] }),
    )
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.message.hops).toEqual([NODE_A, NODE_B])
  })

  test('a send that would overflow the hop limit is refused, not truncated', () => {
    const router = routerAt('node-z', () => CLOCK)
    const hops = Array.from({ length: LIMITS.maxHops }, (_, i) => `n-${i}`)
    const verdict = router.outbound(makeMessage({ createdAt: CLOCK, hops }))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.code).toBe(ProtocolErrorCode.E_TOO_MANY_HOPS)
  })
})

describe('A -> B -> A, the AC-3 construction', () => {
  test('the first return to the originating handler is cut with a full chain', () => {
    let clock = CLOCK
    const nodeA = routerAt(NODE_A, () => clock)
    const nodeB = routerAt(NODE_B, () => clock)

    // A sends the task out. This is the seeding half.
    const request = makeMessage({ createdAt: clock, taskId: 'loop-task' })
    const sent = nodeA.outbound(request)
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    // B takes it in and, being the buggy half of the loop, sends it back at
    // the very handler it came from under the same task id.
    clock += 20
    expect(nodeB.inbound(sent.message).ok).toBe(true)
    const bounced = makeMessage({
      createdAt: clock,
      taskId: 'loop-task',
      traceId: sent.message.traceId,
      from: REVIEWER,
      to: PLANNER,
      hops: sent.message.hops,
    })
    const relayed = nodeB.outbound(bounced)
    expect(relayed.ok).toBe(true)
    if (!relayed.ok) return

    // A cuts it on arrival — first revisit, not second, and not by hop count:
    // the message has travelled two hops, well inside `maxHops`.
    clock += 20
    const verdict = nodeA.inbound(relayed.message)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.code).toBe(ProtocolErrorCode.E_LOOP)
    expect(relayed.message.hops.length).toBeLessThan(LIMITS.maxHops)

    const events = nodeA.audit.of(RouterEventType.LoopDetected)
    expect(events).toHaveLength(1)
    const detail = (events[0] as RouterAuditEvent).detail
    // The chain is reconstructable: same trace-id segment as the request A
    // sent, with the relay's own parent-id on top (§7.1).
    const traceIdSegment = (value: string): string =>
      value.split('-')[1] ?? value
    expect(traceIdSegment(String(detail['traceId']))).toBe(
      traceIdSegment(request.traceId),
    )
    expect(detail['traceId']).not.toBe(request.traceId)
    expect(detail['taskId']).toBe('loop-task')
    expect(detail['to']).toBe(PLANNER)
    expect(detail['from']).toBe(REVIEWER)
    expect(detail['hops']).toBe(`${NODE_A} -> ${NODE_B}`)
    expect(detail['code']).toBe(ProtocolErrorCode.E_LOOP)
  })

  test('the same node reached for a second handler is not cut', () => {
    // The reverse case D-2 exists for: node A is traversed twice, but the
    // second visit is for `archivist`, which has not seen this task.
    let clock = CLOCK
    const nodeA = routerAt(NODE_A, () => clock)
    const nodeB = routerAt(NODE_B, () => clock)

    const sent = nodeA.outbound(
      makeMessage({ createdAt: clock, taskId: 'spiral-task' }),
    )
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    clock += 20
    nodeB.inbound(sent.message)

    const onward = nodeB.outbound(
      makeMessage({
        createdAt: clock,
        taskId: 'spiral-task',
        from: REVIEWER,
        to: ARCHIVIST,
        hops: sent.message.hops,
      }),
    )
    expect(onward.ok).toBe(true)
    if (!onward.ok) return

    clock += 20
    expect(nodeA.inbound(onward.message).ok).toBe(true)
    expect(nodeA.audit.count(RouterEventType.LoopDetected)).toBe(0)
  })

  test('the reply path survives the seeding — ack and result are not loops', () => {
    let clock = CLOCK
    const nodeA = routerAt(NODE_A, () => clock)
    const request = makeMessage({ createdAt: clock, taskId: 'reply-task' })
    expect(nodeA.outbound(request).ok).toBe(true)

    clock += 30
    // Both come back to `planner` under the same task id — the exact shape the
    // loop key describes, which is why replies are excluded from it.
    expect(nodeA.inbound(createAck(request, REVIEWER, clock)).ok).toBe(true)
    expect(
      nodeA.inbound(
        createTaskResult(
          request,
          REVIEWER,
          { outcome: 'completed', content: 'done' },
          clock,
        ),
      ).ok,
    ).toBe(true)
    expect(nodeA.audit.count(RouterEventType.LoopDetected)).toBe(0)
  })
})

describe('inbound — the hop backstop', () => {
  test('a runaway hop list is cut as a loop with the backstop code', () => {
    const router = routerAt(NODE_B, () => CLOCK)
    const hops = Array.from({ length: LIMITS.maxHops + 1 }, (_, i) => `n-${i}`)
    const verdict = router.inbound(
      makeMessage({ createdAt: CLOCK, taskId: 'runaway', hops }),
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.code).toBe(ProtocolErrorCode.E_TOO_MANY_HOPS)
    const events = router.audit.of(RouterEventType.LoopDetected)
    expect(events).toHaveLength(1)
    expect((events[0] as RouterAuditEvent).detail['hopCount']).toBe(
      LIMITS.maxHops + 1,
    )
  })
})

describe('the two rate layers, through the router', () => {
  test('the runtime bucket refuses the 21st outbound message to one target', () => {
    const router = routerAt(NODE_A, () => CLOCK)
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      const verdict = router.outbound(
        makeMessage({ createdAt: CLOCK, taskId: `t-${index}` }),
      )
      expect(verdict.ok).toBe(true)
    }
    const refused = router.outbound(
      makeMessage({ createdAt: CLOCK, taskId: 't-overflow' }),
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe(E_RUNTIME_THROTTLED)
    expect(router.audit.count(RouterEventType.RuntimeThrottled)).toBe(1)
    // The runtime layer is not a protocol state: it must not have produced the
    // protocol layer's event.
    expect(router.audit.count(RouterEventType.RateLimited)).toBe(0)
  })

  test('a throttled send never reaches the loop table', () => {
    const router = routerAt(NODE_A, () => CLOCK)
    for (let index = 0; index < RUNTIME_RATE.capacity; index += 1) {
      router.outbound(makeMessage({ createdAt: CLOCK, taskId: `t-${index}` }))
    }
    const before = router.loop.size
    router.outbound(makeMessage({ createdAt: CLOCK, taskId: 'never-sent' }))
    expect(router.loop.size).toBe(before)
  })

  test('the protocol budget refuses inbound past LIMITS.ratePerMinute', () => {
    // A small ceiling keeps this test about the router's wiring; that the
    // default ceiling is `LIMITS.ratePerMinute` is asserted in rate.test.ts.
    const router = new NodeRouter({
      node: NODE_B,
      now: () => CLOCK,
      budget: new InboundBudget({ perMinute: 3 }),
    })
    for (let index = 0; index < 3; index += 1) {
      expect(
        router.inbound(makeMessage({ createdAt: CLOCK, taskId: `b-${index}` }))
          .ok,
      ).toBe(true)
    }
    const verdict = router.inbound(
      makeMessage({ createdAt: CLOCK, taskId: 'b-over' }),
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.code).toBe(ProtocolErrorCode.E_RATE_LIMITED)
    expect(router.audit.count(RouterEventType.RateLimited)).toBe(1)
    expect(router.audit.count(RouterEventType.RuntimeThrottled)).toBe(0)
  })

  test('a loop is reported as a loop even while the sender is flooding', () => {
    const router = new NodeRouter({ node: NODE_B, now: () => CLOCK })
    const first = makeMessage({ createdAt: CLOCK, taskId: 'flood' })
    expect(router.inbound(first).ok).toBe(true)
    const verdict = router.inbound(
      makeMessage({ createdAt: CLOCK, taskId: 'flood' }),
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.code).toBe(ProtocolErrorCode.E_LOOP)
  })
})

describe('ping-pong — the case the loop key cannot see', () => {
  test('fresh task ids every lap defeat loop detection and are stopped by the throttle', () => {
    // D-2's third finding: an auto-reply exchange builds a new task id each
    // lap, so every individual message is legal and the loop key never fires.
    // This test states that honestly — and then shows what does stop it.
    const router = routerAt(NODE_A, () => CLOCK)
    let allowed = 0
    let refused = 0
    for (let lap = 0; lap < 40; lap += 1) {
      const verdict = router.outbound(
        makeMessage({
          createdAt: CLOCK,
          taskId: `pong-${lap}`,
          type: MessageType.TaskRequest,
        }),
      )
      if (verdict.ok) allowed += 1
      else refused += 1
    }
    expect(router.audit.count(RouterEventType.LoopDetected)).toBe(0)
    expect(allowed).toBe(RUNTIME_RATE.capacity)
    expect(refused).toBe(40 - RUNTIME_RATE.capacity)
  })
})

describe('release', () => {
  test('a terminal result frees the task’s loop keys', () => {
    const router = routerAt(NODE_B, () => CLOCK)
    expect(router.inbound(makeMessage({ createdAt: CLOCK, taskId: 'r-1' })).ok) //
      .toBe(true)
    router.release('r-1')
    expect(router.inbound(makeMessage({ createdAt: CLOCK, taskId: 'r-1' })).ok) //
      .toBe(true)
  })
})

describe('inbound — the capability tier travels, it is not re-derived', () => {
  /** A gate that answers with whatever the test wants to see forwarded. */
  function gateAnswering(decision: CapabilityDecision): CapabilityGate {
    return {
      check(_message: QianmoMessage, _now: number): CapabilityDecision {
        return decision
      },
    }
  }

  function tierSeenBy(decision: CapabilityDecision): NoticeTrust | undefined {
    const router = new NodeRouter({
      node: NODE_B,
      now: () => CLOCK,
      capability: gateAnswering(decision),
    })
    const verdict = router.inbound(makeMessage({ createdAt: CLOCK }))
    return verdict.ok ? verdict.trust : undefined
  }

  test('whatever the gate decided is what the verdict carries', () => {
    // issue #28: the routing layer is a wire between the one layer that may
    // decide the tier and the one layer that renders it. Both values have to
    // survive the trip, and neither may be recomputed on the way.
    expect(
      tierSeenBy({
        ok: true,
        level: CapabilityLevel.WriteLimited,
        issuer: 'console',
        trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
      }),
    ).toBe(NOTICE_TRUST_VERIFIED_CAPABILITY)

    // An issuer is present and the level clears the bar, and the tier is still
    // the floor because the gate said so. The router does not have an opinion.
    expect(
      tierSeenBy({
        ok: true,
        level: CapabilityLevel.WriteLimited,
        issuer: 'console',
        trust: TRUST_UNTRUSTED,
      }),
    ).toBe(TRUST_UNTRUSTED)
  })

  test('a node with no capability gate learns nothing, so it trusts nothing', () => {
    const router = routerAt(NODE_B, () => CLOCK)
    const verdict = router.inbound(makeMessage({ createdAt: CLOCK }))
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.trust).toBe(TRUST_UNTRUSTED)
    expect(verdict.level).toBe(CapabilityLevel.Read)
  })
})
