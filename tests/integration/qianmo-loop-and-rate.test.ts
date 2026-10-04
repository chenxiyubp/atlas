// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AC-3 over a real wire: `@qianmo/router` composed with `@qianmo/transport`.
 *
 * The router's own suite proves the decisions in isolation. What it cannot
 * prove is that a cut message actually stops — that the sender is told, with
 * the right code, and that the handler on the other side never ran. Those are
 * properties of the composition, and the composition is what AC-3 constructs:
 * A sends a task to B, B bounces it back at the handler it came from, and A
 * must cut it on first return rather than let it circle.
 *
 * Two nodes, two servers, two clients, one unix socket each. Nothing mocked:
 * real handshakes, real receipts, real envelopes. Unix sockets rather than TCP
 * by roadmap P2.2's test rule — two servers can bind one port without either
 * erroring, and Linux then splits traffic between them non-deterministically.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ErrorPayload,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
  createMessage,
  errorReply,
} from '@qianmo/protocol'
import {
  InboundBudget,
  NodeRouter,
  RouterEventType,
  type RouterAuditEvent,
} from '@qianmo/router'
import {
  TransportClient,
  TransportReceiptError,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'

const PSK = 'test-psk-not-a-real-secret-0000'
const NODE_A = 'node-a'
const NODE_B = 'node-b'
const PLANNER = `qianmo://${NODE_A}/planner`
const ARCHIVIST = `qianmo://${NODE_A}/archivist`
const REVIEWER = `qianmo://${NODE_B}/reviewer`

interface Node {
  readonly router: NodeRouter
  readonly server: TransportServerHandle
  readonly socket: string
  /** Envelopes that made it past the routing gates, in arrival order. */
  readonly delivered: QianmoMessage[]
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-ac3-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'node.sock')
}

/** A node whose inbound handler is nothing but the routing gates. */
function startNode(name: string, budget?: InboundBudget): Node {
  const router = new NodeRouter({
    node: name,
    ...(budget === undefined ? {} : { budget }),
  })
  const delivered: QianmoMessage[] = []
  const socket = socketPath()
  const server = startTransportServer({
    psk: PSK,
    unix: socket,
    onMessage: (message, context) => {
      const verdict = router.inbound(message)
      if (!verdict.ok) {
        // What the activator and the resident both do on a refusal: tell the
        // sender in an `error` envelope over the same channel, then throw so
        // the transport receipts it as rejected and forgets its dedup entry.
        context.channel.send(errorReply(message, verdict.code, verdict.reason))
        throw new Error(`${verdict.code}: ${verdict.reason}`)
      }
      delivered.push(message)
    },
  })
  cleanups.push(() => server.stop())
  return { router, server, socket, delivered }
}

/** A client dialing `target`, collecting whatever comes back to it. */
async function dial(
  from: string,
  target: Node,
  replies: QianmoMessage[],
): Promise<TransportClient> {
  const client = new TransportClient({
    endpoint: { unix: target.socket },
    node: from,
    psk: PSK,
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  cleanups.push(() => client.close())
  await client.connect(5_000)
  return client
}

function request(overrides: {
  from?: string
  to?: string
  taskId: string
  traceId?: string
  hops?: readonly string[]
}): QianmoMessage {
  return createMessage({
    from: overrides.from ?? PLANNER,
    to: overrides.to ?? REVIEWER,
    type: MessageType.TaskRequest,
    payload: { ask: 'review the diff' },
    taskId: overrides.taskId,
    ...(overrides.traceId === undefined ? {} : { traceId: overrides.traceId }),
    ...(overrides.hops === undefined ? {} : { hops: overrides.hops }),
  })
}

function send(
  router: NodeRouter,
  client: TransportClient,
  message: QianmoMessage,
): Promise<unknown> {
  const routed = router.outbound(message)
  if (!routed.ok) throw new Error(`${routed.code}: ${routed.reason}`)
  return client.sendAndWait(routed.message, 5_000)
}

describe('A -> B -> A is cut on the wire at the first revisit', () => {
  test('the bounce is refused, the sender is told E_LOOP, and B never handles it', async () => {
    const nodeA = startNode(NODE_A)
    const nodeB = startNode(NODE_B)
    const repliesToA: QianmoMessage[] = []
    const repliesToB: QianmoMessage[] = []
    const aToB = await dial(NODE_A, nodeB, repliesToA)
    const bToA = await dial(NODE_B, nodeA, repliesToB)

    const task = request({ taskId: 'ac3-loop' })
    await send(nodeA.router, aToB, task)
    expect(nodeB.delivered).toHaveLength(1)

    // Node B's agent answers the wrong way: a *request* back at the handler
    // that started the task, under the same task id. Same shape as a correct
    // ack, and that is the point — only the type tells them apart.
    const bounce = request({
      from: REVIEWER,
      to: PLANNER,
      taskId: 'ac3-loop',
      traceId: task.traceId,
      hops: nodeB.delivered[0]?.hops ?? [],
    })
    await expect(send(nodeB.router, bToA, bounce)).rejects.toBeInstanceOf(
      TransportReceiptError,
    )

    // The handler on A never ran.
    expect(nodeA.delivered).toHaveLength(0)

    // The sender was told why, in an envelope rather than only in a log.
    expect(repliesToB).toHaveLength(1)
    const reply = repliesToB[0] as QianmoMessage
    expect(reply.type).toBe(MessageType.Error)
    expect((reply.payload as ErrorPayload).code).toBe(ProtocolErrorCode.E_LOOP)
    expect(reply.taskId).toBe('ac3-loop')

    // And one audit event carries the whole chain (AC-3's own words).
    const events = nodeA.router.audit.of(RouterEventType.LoopDetected)
    expect(events).toHaveLength(1)
    const detail = (events[0] as RouterAuditEvent).detail
    expect(String(detail['traceId']).split('-')[1]).toBe(
      task.traceId.split('-')[1] as string,
    )
    expect(detail['taskId']).toBe('ac3-loop')
    expect(detail['to']).toBe(PLANNER)
    expect(detail['hops']).toBe(`${NODE_A} -> ${NODE_B}`)
    expect(detail['code']).toBe(ProtocolErrorCode.E_LOOP)
  })

  test('the same node reached for a second handler is delivered, not cut', async () => {
    // The reverse case: without it, a node-granular "fix" would pass the test
    // above and silently kill legitimate routing (D-2, RFC 3261 Appendix A).
    const nodeA = startNode(NODE_A)
    const nodeB = startNode(NODE_B)
    const aToB = await dial(NODE_A, nodeB, [])
    const bToA = await dial(NODE_B, nodeA, [])

    await send(nodeA.router, aToB, request({ taskId: 'ac3-spiral' }))
    const onward = request({
      from: REVIEWER,
      to: ARCHIVIST,
      taskId: 'ac3-spiral',
      traceId: (nodeB.delivered[0] as QianmoMessage).traceId,
      hops: (nodeB.delivered[0] as QianmoMessage).hops,
    })
    await send(nodeB.router, bToA, onward)

    expect(nodeA.delivered).toHaveLength(1)
    expect((nodeA.delivered[0] as QianmoMessage).to).toBe(ARCHIVIST)
    expect(nodeA.router.audit.count(RouterEventType.LoopDetected)).toBe(0)
  })
})

describe('the protocol layer budget, on the wire', () => {
  test('a sender past the inbound allowance is refused with E_RATE_LIMITED', async () => {
    // A three-message ceiling instead of `LIMITS.ratePerMinute`: the number
    // under test here is the wiring, not the default, and 601 handshake round
    // trips would buy nothing the unit suite does not already assert.
    const nodeB = startNode(NODE_B, new InboundBudget({ perMinute: 3 }))
    const nodeA = new NodeRouter({ node: NODE_A })
    const replies: QianmoMessage[] = []
    const client = await dial(NODE_A, nodeB, replies)

    for (let index = 0; index < 3; index += 1) {
      await send(nodeA, client, request({ taskId: `budget-${index}` }))
    }
    await expect(
      send(nodeA, client, request({ taskId: 'budget-over' })),
    ).rejects.toBeInstanceOf(TransportReceiptError)

    expect(nodeB.delivered).toHaveLength(3)
    expect(nodeB.router.audit.count(RouterEventType.RateLimited)).toBe(1)
    // The runtime layer is a different mechanism and did not fire.
    expect(nodeB.router.audit.count(RouterEventType.RuntimeThrottled)).toBe(0)
    const reply = replies.at(-1) as QianmoMessage
    expect((reply.payload as ErrorPayload).code).toBe(
      ProtocolErrorCode.E_RATE_LIMITED,
    )
  })
})
