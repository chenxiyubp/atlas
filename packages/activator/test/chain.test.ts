// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DoD ① as far as a laptop can take it: the whole chain, assembled, over real
 * sockets.
 *
 * **What this file is evidence of, and what it is not.** Every hop here is a
 * real one — two `@qianmo/transport` connections over unix sockets, a real HTTP
 * supervisor stand-in on loopback, real journalling, the real wait loop. What is
 * *not* real is the dormancy: nothing on a developer machine can freeze a
 * container, so the "sleeping" target is modelled as a node whose listener is
 * not up yet and whose supervisor row says `frozen`. That reproduces the
 * *shape* E2 measured (the wake returns long before the node answers) without
 * claiming any of E2's numbers.
 *
 * So this file proves the chain is wired correctly and fails correctly. The ten
 * consecutive round trips against a genuinely frozen sandbox are a different
 * claim, and they are made — if at all — by `demo/ac2-wake-forward.sh` on the
 * Linux host, not here.
 *
 * Unix sockets rather than TCP throughout, by `@qianmo/transport`'s own test
 * rule: two servers can bind one TCP port without either erroring, and Linux
 * then splits arriving connections between them non-deterministically.
 *
 * No `mock.module` anywhere: every collaborator is either injected at a
 * constructor or is a real process-local server.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  type ErrorPayload,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
  createAck,
  createMessage,
  createTaskResult,
} from '@qianmo/protocol'
import { RouterEventType } from '@qianmo/router'
import {
  TransportClient,
  TransportEventType,
  type InboundContext,
  type InboundHandler,
  type TransportServerHandle,
  startTransportServer,
} from '@qianmo/transport'
import type { ActivationOutcome } from '../src/activator.js'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import { HttpSandboxDaemon } from '../src/daemon.js'
import { MemoryRequestJournal } from '../src/journal.js'
import { StaticTargetDirectory, UnknownTargetError } from '../src/link.js'
import { type ActivatorNodeHandle, startActivatorNode } from '../src/node.js'
import { durationsOf } from '../src/stages.js'
import {
  RECIPIENT,
  SANDBOX,
  SENDER,
  TEST_PSK,
  makeMessage,
  makeSocketDir,
  sleep,
  waitUntil,
} from './helpers.js'
import { STUB_TOKEN, type StubDaemon, startStubDaemon } from './stub-daemon.js'

/** The node segment the sandbox in {@link SANDBOX} hosts. */
const TARGET_NODE = 'node-b'

/** This host's own segment: the activator is not the node it wakes. */
const HOST_NODE = 'node-b-host'

/** Compressed so a real outage fits inside a test. */
const FAST_BACKOFF = {
  baseDelayMs: 20,
  maxDelayMs: 60,
  jitterRatio: 0,
} as const

const stubs: StubDaemon[] = []
const nodes: ActivatorNodeHandle[] = []
const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const client of clients.splice(0)) await client.close()
  for (const node of nodes.splice(0)) await node.stop()
  for (const server of servers.splice(0)) await server.stop()
  for (const stub of stubs.splice(0)) await stub.stop()
})

/** A stand-in for the node inside the sandbox: it takes envelopes and keeps them. */
function startTargetNode(
  path: string,
  received: QianmoMessage[],
  onMessage?: (
    message: QianmoMessage,
    context: InboundContext,
  ) => Promise<void>,
): TransportServerHandle {
  const server = startTransportServer({
    unix: path,
    psk: TEST_PSK,
    onMessage: async (message, context): Promise<void> => {
      await onMessage?.(message, context)
      received.push(message)
    },
  })
  servers.push(server)
  return server
}

interface Chain {
  readonly stub: StubDaemon
  readonly node: ActivatorNodeHandle
  readonly audit: AuditLog
  readonly targetPath: string
  readonly received: QianmoMessage[]
  readonly outcomes: ActivationOutcome[]
  sender(onMessage?: InboundHandler): TransportClient
}

/**
 * Stand up supervisor + activator + sender, with the target's listener left to
 * the test — that absence is what "the node is asleep" means here.
 */
async function startChain(
  options: {
    readonly initialState?: 'frozen' | 'stopped' | 'active'
    readonly readyTimeoutMs?: number
    readonly readyPollIntervalMs?: number
    readonly connectTimeoutMs?: number
    readonly forwardTimeoutMs?: number
    readonly sandboxes?: readonly string[]
    readonly giveUpAfterMs?: number
  } = {},
): Promise<Chain> {
  const dir = makeSocketDir()
  cleanups.push(dir.cleanup)
  const targetPath = dir.socket('target')
  const inboundPath = dir.socket('inbound')

  const stub = startStubDaemon({
    sandboxes: options.sandboxes ?? [SANDBOX],
    initialState: options.initialState ?? 'frozen',
  })
  stubs.push(stub)

  const audit = new AuditLog()
  const received: QianmoMessage[] = []
  const outcomes: ActivationOutcome[] = []
  const node = await startActivatorNode({
    node: HOST_NODE,
    psk: TEST_PSK,
    listen: { unix: inboundPath },
    daemon: new HttpSandboxDaemon({
      baseUrl: stub.url,
      token: () => STUB_TOKEN,
      audit,
    }),
    directory: new StaticTargetDirectory([
      {
        node: TARGET_NODE,
        sandboxName: SANDBOX,
        endpoint: { unix: targetPath },
      },
    ]),
    journal: new MemoryRequestJournal(),
    audit,
    readyTimeoutMs: options.readyTimeoutMs ?? 5_000,
    readyPollIntervalMs: options.readyPollIntervalMs ?? 25,
    connectTimeoutMs: options.connectTimeoutMs ?? 200,
    forwardTimeoutMs: options.forwardTimeoutMs ?? 3_000,
    backoff: {
      ...FAST_BACKOFF,
      ...(options.giveUpAfterMs === undefined
        ? {}
        : { giveUpAfterMs: options.giveUpAfterMs }),
    },
    onOutcome: outcome => outcomes.push(outcome),
  })
  nodes.push(node)

  return {
    stub,
    node,
    audit,
    targetPath,
    received,
    outcomes,
    sender(onMessage?: InboundHandler): TransportClient {
      const client = new TransportClient({
        endpoint: { unix: inboundPath },
        node: 'node-a',
        psk: TEST_PSK,
        backoff: FAST_BACKOFF,
        keepAliveIntervalMs: 0,
        ...(onMessage === undefined ? {} : { onMessage }),
      })
      clients.push(client)
      return client
    },
  }
}

/** The receipt the sender got for one envelope, or `''` if none arrived. */
function verdictOf(client: TransportClient, msgId: string): string {
  for (const event of client.events.all()) {
    if (event.detail.msgId !== msgId) continue
    if (event.type === TransportEventType.MessageAccepted) return 'accepted'
    if (event.type === TransportEventType.MessageRejected) {
      return `rejected:${String(event.detail.code)}`
    }
  }
  return ''
}

describe('catch → wake → probe → forward, assembled', () => {
  test('a message for a sleeping node wakes it and lands inside the sandbox', async () => {
    const chain = await startChain()
    const sender = chain.sender()
    await sender.connect(2_000)

    // The node is asleep: its listener is not up, and the supervisor says
    // `frozen`. It comes back a little later — the shape E2 measured, where the
    // wake call returns long before the node can answer.
    const timer = setTimeout(() => {
      startTargetNode(chain.targetPath, chain.received)
    }, 150)
    cleanups.push(() => clearTimeout(timer))

    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(20_000)

    // It arrived, once, unaltered. The activator is not a rewriter.
    expect(chain.received.map(entry => entry.msgId)).toEqual([message.msgId])
    expect(chain.received[0]).toEqual(message)
    // Exactly one wake, and the supervisor row moved.
    expect(chain.stub.hits.acquireSandbox).toBe(1)
    expect(chain.stub.hits.destroySandbox).toBe(0)
    expect(chain.stub.stateOf(SANDBOX)).toBe('active')
    // And the sender was told, by the receipt, that it got there.
    expect(verdictOf(sender, message.msgId)).toBe('accepted')
  })

  test('ack and result return over C2 then the original C1 channel', async () => {
    const chain = await startChain()
    const replies: QianmoMessage[] = []
    const sender = chain.sender(message => {
      replies.push(message)
    })
    await sender.connect(2_000)

    let target: TransportServerHandle | undefined
    const timer = setTimeout(() => {
      target = startTargetNode(
        chain.targetPath,
        chain.received,
        async (message, context) => {
          context.channel.send(createAck(message, message.to, Date.now()))
          context.channel.send(
            createTaskResult(
              message,
              message.to,
              { outcome: 'completed', content: 'task complete' },
              Date.now(),
            ),
          )
        },
      )
    }, 100)
    cleanups.push(() => clearTimeout(timer))

    const message = makeMessage({ taskId: 'task-return-route' })
    await sender.sendAndWait(message, 20_000)
    await waitUntil(() => replies.length === 2 && chain.node.routes.size === 0)

    expect(replies.map(reply => reply.type)).toEqual([
      MessageType.Ack,
      MessageType.TaskResult,
    ])
    expect(replies.every(reply => reply.taskId === message.taskId)).toBe(true)
    expect(replies[0]?.payload).not.toHaveProperty('taskId')
    expect(replies[1]?.payload).toEqual({
      outcome: 'completed',
      content: 'task complete',
      completedAt: expect.any(Number),
    })
    expect(target?.connections).toBe(1)
    expect(chain.node.links.linkCount).toBe(1)
    expect(chain.audit.count(ActivatorEventType.TaskReplyForwarded)).toBe(2)
  })

  test('every stage of the wake path is timed, in order', async () => {
    const chain = await startChain()
    const sender = chain.sender()
    await sender.connect(2_000)
    const timer = setTimeout(() => {
      startTargetNode(chain.targetPath, chain.received)
    }, 120)
    cleanups.push(() => clearTimeout(timer))

    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(20_000)

    const [timings] = chain.node.samples()
    if (timings === undefined) throw new Error('no timing sample was recorded')
    expect(timings.outcome).toBe('forwarded')
    expect(timings.msgId).toBe(message.msgId)
    // The four instants exist and are ordered. Values, not just presence: a
    // timeline that recorded readiness before the wake would be worse than no
    // timeline at all, because a baseline report would quietly average it in.
    const { acceptedAt, wakeStartedAt, readyAt, forwardedAt } = timings
    expect(wakeStartedAt).toBeDefined()
    expect(readyAt).toBeDefined()
    expect(forwardedAt).toBeDefined()
    expect(wakeStartedAt ?? 0).toBeGreaterThanOrEqual(acceptedAt)
    expect(readyAt ?? 0).toBeGreaterThanOrEqual(wakeStartedAt ?? 0)
    expect(forwardedAt ?? 0).toBeGreaterThanOrEqual(readyAt ?? 0)

    const spans = durationsOf(timings)
    expect(spans.totalMs).toBeGreaterThanOrEqual(0)
    // The listener came back after ~120 ms, so the wait for readiness is the
    // dominant span. This is the shape the P3.1 / P4.1 baselines exist to
    // watch: an end-to-end number alone would hide which stage is paying.
    expect(spans.wakeToReadyMs ?? 0).toBeGreaterThan(0)

    const report = chain.node.report()
    expect(report.samples).toBe(1)
    expect(report.forwarded).toBe(1)
    expect(report.wakes).toBe(1)
    expect(report.total.count).toBe(1)
  })

  test('an already-awake node is forwarded to without being woken', async () => {
    const chain = await startChain({ initialState: 'active' })
    startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)

    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(10_000)

    expect(chain.received).toHaveLength(1)
    expect(chain.stub.hits.acquireSandbox).toBe(0)
    expect(chain.node.samples()[0]?.wakeStartedAt).toBeUndefined()
  })

  test('two messages for one sandbox share one link and one wake', async () => {
    const chain = await startChain()
    startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)

    const first = makeMessage({ payload: { seq: 1 } })
    sender.send(first)
    await sender.waitForDrain(10_000)
    const second = makeMessage({ payload: { seq: 2 } })
    sender.send(second)
    await sender.waitForDrain(10_000)

    expect(chain.received).toHaveLength(2)
    // One wake: the second request found the row already `active`.
    expect(chain.stub.hits.acquireSandbox).toBe(1)
    // One forwarding link, reused. A link per request would throw away the
    // transport's replay buffer on every delivery.
    expect(chain.node.links.linkCount).toBe(1)
  })
})

describe('readiness is fresh evidence, never a cached flag', () => {
  test('a probe against a node that is not answering is not ready, and says so', async () => {
    const chain = await startChain({
      readyTimeoutMs: 400,
      connectTimeoutMs: 120,
      readyPollIntervalMs: 20,
    })
    const sender = chain.sender()
    await sender.connect(2_000)

    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(20_000)

    // Never delivered, never silent: an explicit rejection went back.
    expect(chain.received).toHaveLength(0)
    expect(verdictOf(sender, message.msgId)).toBe('rejected:E_UNDELIVERABLE')
    // The wake still happened — the failure is the target's, not the wake's,
    // and an operator needs to be able to tell those apart.
    expect(chain.stub.hits.acquireSandbox).toBe(1)
    expect(
      chain.audit.count(ActivatorEventType.LinkProbeFailed),
    ).toBeGreaterThanOrEqual(1)
    expect(chain.audit.count(ActivatorEventType.TargetReady)).toBe(0)
    expect(chain.audit.count(ActivatorEventType.RequestFailed)).toBe(1)
  })

  test('a failed probe leaves no link and no reconnect loop behind', async () => {
    const chain = await startChain({
      readyTimeoutMs: 300,
      connectTimeoutMs: 100,
      readyPollIntervalMs: 20,
    })
    const sender = chain.sender()
    await sender.connect(2_000)
    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(20_000)

    // Probes are throwaway connections. One left open would keep dialling a
    // sandbox nobody is waiting on any more.
    expect(chain.node.links.linkCount).toBe(0)
  })

  test('the failure reply carries the stage that failed, not just a code', async () => {
    const chain = await startChain({
      readyTimeoutMs: 300,
      connectTimeoutMs: 100,
      readyPollIntervalMs: 20,
    })
    const sender = chain.sender()
    await sender.connect(2_000)
    sender.send(makeMessage())
    await sender.waitForDrain(20_000)

    const [reply] = chain.node.failures()
    if (reply === undefined) throw new Error('no failure reply was recorded')
    const payload = reply.payload as { code: string; reason: string }
    expect(payload.code).toBe('E_UNDELIVERABLE')
    // "did not become ready" names the stage. Without it the operator cannot
    // tell a wake that never happened from a node that never answered.
    expect(payload.reason).toContain('did not become ready')
    expect(payload.reason).toContain(SANDBOX)
  })
})

describe('a forward is a delivery, not an enqueue', () => {
  test('a target that never receipts fails the request instead of claiming success', async () => {
    const chain = await startChain({ forwardTimeoutMs: 250 })
    let release = (): void => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    // Released in cleanup so the hanging handler cannot outlive the test.
    cleanups.push(() => release())
    startTargetNode(chain.targetPath, chain.received, async () => {
      await held
    })

    const sender = chain.sender()
    await sender.connect(2_000)
    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(20_000)

    // `send` put it in the outbox and returned; only the receipt would have
    // made it a delivery, and none came.
    expect(verdictOf(sender, message.msgId)).toBe('rejected:E_UNDELIVERABLE')
    const [outcome] = chain.outcomes
    expect(outcome?.status).toBe('failed')
    if (outcome?.status === 'failed') {
      expect(outcome.reason).toContain('receipted')
      // The timeline still records where it got to: ready, then no forward.
      expect(outcome.timings.readyAt).toBeDefined()
      expect(outcome.timings.forwardedAt).toBeUndefined()
    }
  })

  test('a target rejection fails the request instead of being mistaken for drain', async () => {
    const chain = await startChain({ forwardTimeoutMs: 2_000 })
    startTargetNode(chain.targetPath, chain.received, async () => {
      throw new Error('target refused delivery')
    })

    const sender = chain.sender()
    await sender.connect(2_000)
    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(20_000)

    expect(verdictOf(sender, message.msgId)).toBe('rejected:E_UNDELIVERABLE')
    expect(chain.received).toHaveLength(0)
    const [outcome] = chain.outcomes
    expect(outcome?.status).toBe('failed')
    if (outcome?.status === 'failed') {
      expect(outcome.reason).toContain('rejected')
      expect(outcome.timings.readyAt).toBeDefined()
      expect(outcome.timings.forwardedAt).toBeUndefined()
    }
    expect(chain.node.report().forwarded).toBe(0)
    expect(chain.node.report().failed).toBe(1)
  })

  test('a node that restarts is reconnected to, and the envelope replayed', async () => {
    const chain = await startChain({ forwardTimeoutMs: 5_000 })
    const first = startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)

    const before = makeMessage({ payload: { seq: 1 } })
    sender.send(before)
    await sender.waitForDrain(10_000)
    expect(chain.received).toHaveLength(1)

    // The node goes away — which is what a freeze eventually does to the link —
    // and the supervisor row goes back to `frozen`.
    servers.splice(servers.indexOf(first), 1)
    await first.stop()
    chain.stub.setState(SANDBOX, 'frozen')
    await waitUntil(() => chain.node.links.linkCount === 1)

    // It comes back a moment later. Nothing clears the socket path by hand:
    // `stop()` unlinks it, so the restarted node takes its own address back.
    const timer = setTimeout(() => {
      startTargetNode(chain.targetPath, chain.received)
    }, 120)
    cleanups.push(() => clearTimeout(timer))

    const after = makeMessage({ payload: { seq: 2 } })
    sender.send(after)
    await sender.waitForDrain(20_000)

    expect(chain.received.map(entry => entry.msgId)).toEqual([
      before.msgId,
      after.msgId,
    ])
    // Two wakes: the row was `frozen` again the second time round.
    expect(chain.stub.hits.acquireSandbox).toBe(2)
    // Still one link — the transport reconnected rather than being replaced.
    expect(chain.node.links.linkCount).toBe(1)
  })

  test('a link that gave up is replaced, not waited on forever', async () => {
    // A sandbox can be frozen for longer than the reconnect budget — ten
    // minutes by default. The client that gave up is closed for good and its
    // `send` throws; a pool that kept handing envelopes to it would fail every
    // future request for that sandbox. Compressed here to a 40 ms budget.
    const chain = await startChain({
      initialState: 'active',
      giveUpAfterMs: 40,
      forwardTimeoutMs: 5_000,
    })
    const first = startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)
    sender.send(makeMessage({ payload: { seq: 1 } }))
    await sender.waitForDrain(10_000)
    expect(chain.node.links.linkCount).toBe(1)

    // The node disappears for longer than the link's whole retry budget.
    servers.splice(servers.indexOf(first), 1)
    await first.stop()
    await waitUntil(
      () => chain.audit.count(ActivatorEventType.LinkOpened) === 1,
    )
    await sleep(200)

    startTargetNode(chain.targetPath, chain.received)
    const after = makeMessage({ payload: { seq: 2 } })
    sender.send(after)
    await sender.waitForDrain(20_000)

    expect(chain.received.map(entry => entry.msgId)).toContain(after.msgId)
    expect(chain.audit.count(ActivatorEventType.LinkGaveUp)).toBe(1)
    // Replaced, not accumulated.
    expect(chain.node.links.linkCount).toBe(1)
    expect(chain.audit.count(ActivatorEventType.LinkOpened)).toBe(2)
  })
})

describe('what this host cannot place, it does not take', () => {
  test('an envelope for an unmapped node is rejected and never journalled', async () => {
    const chain = await startChain()
    const journal = chain.node.journal
    const sender = chain.sender()
    await sender.connect(2_000)

    const stray = makeMessage()
    const misdirected: QianmoMessage = {
      ...stray,
      to: 'qianmo://node-z/reviewer',
    }
    sender.send(misdirected)
    await sender.waitForDrain(10_000)

    // The receipt says "refused" and nothing finer: the transport answers a
    // handler that threw with a fixed `E_UNDELIVERABLE`, whatever the handler
    // decided. That is a known limitation, written down in `node.ts`.
    expect(verdictOf(sender, misdirected.msgId)).toBe(
      'rejected:E_UNDELIVERABLE',
    )
    // The real code is not lost, it is local: audit trail and failure ring.
    const [reply] = chain.node.failures()
    expect((reply?.payload as { code?: string } | undefined)?.code).toBe(
      'E_UNKNOWN_AGENT',
    )
    expect(chain.audit.count(ActivatorEventType.RequestRefused)).toBe(1)
    // Never accepted, so never journalled: the request stayed the sender's.
    expect(journal.pending()).toHaveLength(0)
    expect(chain.node.samples()).toHaveLength(0)
    expect(chain.stub.hits.acquireSandbox).toBe(0)
  })

  test('a message that is addressed to the right node still needs the right sandbox', async () => {
    // The directory is the only place the node → sandbox fact lives, so an
    // entry missing from it has to fail loudly rather than be guessed at.
    const directory = new StaticTargetDirectory([
      { node: TARGET_NODE, sandboxName: SANDBOX, endpoint: { unix: '/x' } },
    ])
    expect(directory.sandboxOf(TARGET_NODE)).toBe(SANDBOX)
    expect(directory.sandboxOf('node-z')).toBeUndefined()
    expect(directory.endpointOf('other-sandbox')).toBeUndefined()
  })

  test('a directory with two rows for one node is refused at construction', () => {
    expect(
      () =>
        new StaticTargetDirectory([
          { node: TARGET_NODE, sandboxName: SANDBOX, endpoint: { unix: '/a' } },
          { node: TARGET_NODE, sandboxName: 'other', endpoint: { unix: '/b' } },
        ]),
    ).toThrow(/duplicate directory entry for node/)
  })

  test('a directory with two rows for one sandbox is refused too', () => {
    expect(
      () =>
        new StaticTargetDirectory([
          { node: 'node-b', sandboxName: SANDBOX, endpoint: { unix: '/a' } },
          { node: 'node-c', sandboxName: SANDBOX, endpoint: { unix: '/b' } },
        ]),
    ).toThrow(/duplicate directory entry for sandbox/)
  })

  test('an unknown sandbox is a configuration error, not a slow wake', async () => {
    // `isReady` reports "not yet" for everything transient. A target with no
    // directory row is not transient: polling it for the whole wake ceiling
    // would bury the one fact worth reporting under a timeout message.
    const chain = await startChain()
    await expect(chain.node.links.isReady('no-such-sandbox')).rejects.toThrow(
      UnknownTargetError,
    )
  })
})

describe('the activator holds requests it has taken', () => {
  test('a message arriving for a node that never answers is refused, not dropped', async () => {
    const chain = await startChain({
      readyTimeoutMs: 300,
      connectTimeoutMs: 100,
      readyPollIntervalMs: 20,
    })
    const sender = chain.sender()
    await sender.connect(2_000)
    sender.send(makeMessage())
    await sender.waitForDrain(20_000)

    // Terminal either way, and nothing left holding a slot.
    expect(chain.node.activator.inFlight).toBe(0)
    expect(chain.node.journal.pending()).toHaveLength(0)
    expect(chain.outcomes).toHaveLength(1)
  })

  test('the recipient address the sender wrote is what the target sees', async () => {
    const chain = await startChain({ initialState: 'active' })
    startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)
    const message = makeMessage()
    sender.send(message)
    await sender.waitForDrain(10_000)

    // Routing at the last hop is by address, and this is the address the
    // sender wrote — the activator adds no hop and rewrites no field.
    expect(chain.received[0]?.to).toBe(RECIPIENT)
    expect(chain.received[0]?.hops).toEqual(message.hops)
  })
})

describe('a slow chain is still a bounded one', () => {
  test('nothing is left running once the node stops', async () => {
    const chain = await startChain({ initialState: 'active' })
    startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)
    sender.send(makeMessage())
    await sender.waitForDrain(10_000)
    expect(chain.node.links.linkCount).toBe(1)

    await chain.node.stop()
    nodes.splice(nodes.indexOf(chain.node), 1)
    expect(chain.node.links.linkCount).toBe(0)
    // A second stop is a no-op rather than a throw: shutdown paths get run
    // twice more often than anyone expects.
    await chain.node.stop()
    await sleep(10)
  })
})

describe('the routing gates in front of the wake (P4.2)', () => {
  test('a second request for the same handler and task is cut, and never wakes anything', async () => {
    const chain = await startChain({ initialState: 'active' })
    startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)

    const first = makeMessage({ taskId: 'gate-1' })
    await sender.sendAndWait(first, 10_000)
    expect(chain.received).toHaveLength(1)

    // Same handler, same task, different envelope — not a retransmission, so
    // dedup has nothing to say about it. Different payload keeps the
    // fingerprint distinct too, which is what makes this a loop rather than a
    // second-level duplicate.
    const again = makeMessage({ taskId: 'gate-1', payload: { do: 'again' } })
    await expect(sender.sendAndWait(again, 10_000)).rejects.toThrow()

    expect(chain.received).toHaveLength(1)
    expect(chain.node.router.audit.count(RouterEventType.LoopDetected)).toBe(1)
    const detail = chain.node.router.audit.of(RouterEventType.LoopDetected)[0]
      ?.detail
    expect(detail?.['taskId']).toBe('gate-1')
    expect(detail?.['code']).toBe(ProtocolErrorCode.E_LOOP)

    // The refusal came before acceptance, so nothing was journalled and the
    // sender was told in an envelope of its own.
    expect(chain.node.journal.pending()).toHaveLength(0)
    const failure = chain.node.failures().at(-1)
    expect(failure?.type).toBe(MessageType.Error)
    expect((failure?.payload as ErrorPayload).code).toBe(
      ProtocolErrorCode.E_LOOP,
    )
  })

  test('a second handler under one live task is not a loop — but the return route still refuses it', async () => {
    // Two things are true here and the test states both, because conflating
    // them is how a limitation turns into a mystery:
    //
    //   1. the routing layer's verdict is "not a loop" — different handler, so
    //      D-2's reverse case holds and no `loop_detected` is written;
    //   2. the request is nevertheless refused, by P4.1's return-route
    //      registry, which is keyed on `taskId` alone. An `ack` coming back
    //      from the sandbox carries only that key, so two live routes under one
    //      task could not be told apart — the refusal is a correlation
    //      constraint, not a loop judgement, and its code says so.
    //
    // Concurrent same-task fan-out to several handlers on one node therefore
    // does not work in M0. Making it work means giving the return route a
    // handler dimension, which is a P4.1 change and not one AC-3 asks for.
    const chain = await startChain({ initialState: 'active' })
    startTargetNode(chain.targetPath, chain.received)
    const sender = chain.sender()
    await sender.connect(2_000)

    await sender.sendAndWait(makeMessage({ taskId: 'gate-2' }), 10_000)
    await expect(
      sender.sendAndWait(
        createMessage({
          from: SENDER,
          to: `qianmo://${TARGET_NODE}/second-agent`,
          type: MessageType.TaskRequest,
          payload: { do: 'review' },
          taskId: 'gate-2',
        }),
        10_000,
      ),
    ).rejects.toThrow()

    expect(chain.received).toHaveLength(1)
    expect(chain.node.router.audit.count(RouterEventType.LoopDetected)).toBe(0)
    expect((chain.node.failures().at(-1)?.payload as ErrorPayload).code).toBe(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
  })
})
