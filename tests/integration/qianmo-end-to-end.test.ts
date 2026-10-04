// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AC-2, all five `@qianmo/*` packages composed into one chain (roadmap P4.1).
 *
 * Each package has a thorough suite of its own, and `qianmo-delivery-chain.ts`
 * already covers registry → adapter. What had never run before this file is the
 * whole thing at once:
 *
 * ```
 * sender → registry.resolve → transport client → [unix socket] → transport
 *   server → activator (catch, wake a frozen node, wait for ready, forward)
 *   → adapter → base mailbox → the agent reads → ack back over a return hop
 * ```
 *
 * The reason to build it is that the seams are where the acceptance run breaks:
 * address rendering, envelope fields, who owns the ack, which key dedup uses,
 * what the daemon's states are called. Every one of those can be wrong while
 * all five packages stay green on their own.
 *
 * ## What is real here and what is not
 *
 * **Real**: a real `TransportClient` and `startTransportServer` over a real unix
 * domain socket with a real PSK handshake; a real `InMemoryRegistry`; a real
 * `Activator` with its real journal, audit log and stage timings; a real
 * `InboundAdapter` writing through the base's own `writeToMailbox`; the base's
 * real `readMailbox` / `markMessagesAsRead`; real `deliverAndAck`, which is the
 * only thing in the tree that may mint an ack. No `mock.module` anywhere, and
 * no stand-in for any of our own code.
 *
 * **Not real — one thing, named**: the Dormice sandbox daemon. It is an
 * external system and not the unit under test, so it is represented by
 * `packages/activator/test/stub-daemon.ts`, a real HTTP server on loopback that
 * speaks the wire shape verified on the host on 2026-08-12. What is under test
 * is the composition of our five packages; nothing here is evidence about how
 * Dormice actually behaves. In particular **the `frozen → active` transition
 * below is simulated**: the stub flips a string in a `Map`. A real dormancy run
 * needs P3.1 and a real sandbox on the Linux host — see the note at the bottom
 * of this file for exactly what that requires.
 *
 * ## Unix domain sockets, not TCP
 *
 * Roadmap P2.2's own test rule for single-machine integration. Two Bun servers
 * can bind the same TCP port without either erroring and the kernel then splits
 * arriving connections between them non-deterministically; a socket path inside
 * a private temp directory has no such failure mode. Cross-machine TCP is e2e
 * and deliberately out of scope here.
 *
 * ## Latency
 *
 * Per decision D-3, stage timings are *produced*, not asserted: the numbers go
 * to stderr as input to the P3.1 / P4.1 baseline report. The only time-based
 * assertion is a coarse "it finished at all" backstop.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Activator,
  ActivatorEventType,
  AuditLog,
  HttpSandboxDaemon,
  MemoryRequestJournal,
  TimingRecorder,
  durationsOf,
  type FailureSink,
  type ForwardTarget,
  type ReadyProbe,
} from '@qianmo/activator'
import {
  InboundAdapter,
  deliverAndAck,
  type DeliveryReply,
} from '@qianmo/adapter'
import {
  MessageType,
  ProtocolErrorCode,
  createMessage,
  isAckPayload,
  nodeOf,
  withHop,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  AgentStatus,
  InMemoryRegistry,
  isValidEndpoint,
} from '@qianmo/registry'
import {
  TransportClient,
  TransportEventType,
  dialUrl,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import {
  markMessagesAsRead,
  readMailbox,
} from 'src/utils/agents/teammateMailbox.js'

import {
  STUB_TOKEN,
  startStubDaemon,
  type StubDaemon,
} from '../../packages/activator/test/stub-daemon.js'

/** Fixed, obviously fake, long enough to clear `PSK_MIN_LENGTH`. */
const TEST_PSK = 'e2e-psk-not-a-real-secret-000000'

const SENDER_NODE = 'node-a'
const SENDER = `qianmo://${SENDER_NODE}/planner`
const AGENT = 'reviewer'

/**
 * One team name per receiving node.
 *
 * A node is a machine with its own config root, so in production two nodes'
 * `reviewer` inboxes are two files on two disks. Collapsed into one process
 * they would share `$CONFIG/teams/<team>/inboxes/reviewer.json`, which would
 * make "no cross-talk" untestable for the wrong reason. The team name is what
 * keys that path in the base (`teammateMailbox.ts:285-295`), so giving each
 * node its own is the smallest faithful stand-in for two config roots.
 */
const TEAM_OF: Readonly<Record<string, string>> = {
  'node-b': 'nest-b',
  'node-c': 'nest-c',
}

/** Fast enough that a whole round trip fits well inside the test timeout. */
const READY_POLL_MS = 10
const OBSERVE_POLL_MS = 10
const AGENT_READ_PERIOD_MS = 5

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Per-test budget for the socket round trips below.
 *
 * Bun's default is 5 s, and several cases here spend up to that on
 * `waitForDrain` alone before they start waiting for a reply — so their own
 * budgets summed past the harness's, and under a loaded full-suite run the
 * slowest path tripped it intermittently. These are I/O tests against real
 * sockets, not unit tests; the generous ceiling costs nothing on a passing run
 * and removes a failure mode that had nothing to do with the behaviour asserted.
 */
const IO_TIMEOUT_MS = 30_000

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(stepMs)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

/** True once the target's inbox holds at least `count` entries. */
function inboxHolds(
  agent: string,
  team: string,
  count: number,
): () => Promise<boolean> {
  return async () => (await readMailbox(agent, team)).length >= count
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The sender's half: a listening socket for replies plus the outbound client.
 *
 * The reply hop is a second, real transport connection rather than a callback,
 * because "the ack came back" is a claim about the network and an in-process
 * callback cannot make it. It also means the ack is validated and deduped by
 * the same server code as any other envelope.
 */
interface SenderSide {
  readonly node: string
  readonly socketPath: string
  readonly server: TransportServerHandle
  /** Every envelope that arrived back: acks and errors alike, in order. */
  readonly inbox: QianmoMessage[]
  /** Dial one receiving node and keep the client for teardown. */
  dial(socketPath: string): Promise<TransportClient>
}

interface ReceivingNode {
  readonly node: string
  readonly team: string
  readonly sandboxName: string
  readonly socketPath: string
  readonly server: TransportServerHandle
  readonly adapter: InboundAdapter
  readonly activator: Activator
  readonly stub: StubDaemon
  readonly audit: AuditLog
  readonly timings: TimingRecorder
  /** What `deliverAndAck` concluded, per delivery, in order. */
  readonly settled: DeliveryReply[]
}

/** Everything a test spun up, torn down in reverse. */
const teardown: Array<() => Promise<void> | void> = []

let root: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-e2e-'))
  // `CLAUDE_CONFIG_DIR`, not `OCC_CONFIG_DIR`: tests/preload.ts deletes the
  // latter, and `occConfigDir()` memoizes on the pair of them.
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterEach(async () => {
  for (const stop of teardown.splice(0).reverse()) await stop()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

function socketFor(name: string): string {
  return join(root, `${name}.sock`)
}

function startSender(): SenderSide {
  const socketPath = socketFor(SENDER_NODE)
  const inbox: QianmoMessage[] = []
  const server = startTransportServer({
    unix: socketPath,
    psk: TEST_PSK,
    onMessage: message => {
      inbox.push(message)
    },
  })
  teardown.push(() => server.stop())

  return {
    node: SENDER_NODE,
    socketPath,
    server,
    inbox,
    async dial(target: string): Promise<TransportClient> {
      const client = new TransportClient({
        endpoint: { unix: target },
        node: SENDER_NODE,
        psk: TEST_PSK,
        keepAliveIntervalMs: 0,
      })
      teardown.push(() => client.close())
      await client.connect(3_000)
      return client
    },
  }
}

interface ReceivingNodeOptions {
  readonly node: string
  /** Sandbox rows the stub daemon starts with. Defaults to `[sandboxName]`. */
  readonly sandboxes?: readonly string[]
  /** How many readiness probes answer "not ready" after the wake (E2's shape). */
  readonly readyAfterProbes?: number
  /** Where this node sends acks and errors. */
  readonly replyTo: string
}

/**
 * Stand up one receiving node: transport server → activator → adapter → mailbox.
 *
 * The wiring order matters and mirrors a real boot: the return hop is dialled
 * first (a node that cannot answer must not accept work), then the activator,
 * then finally the listening socket.
 */
async function startReceivingNode(
  options: ReceivingNodeOptions,
): Promise<ReceivingNode> {
  const { node } = options
  const team = TEAM_OF[node] ?? 'nest'
  const sandboxName = `sandbox-${node}`
  const socketPath = socketFor(node)
  const settled: DeliveryReply[] = []

  // --- the return hop, dialled back at the sender ---------------------------
  const back = new TransportClient({
    endpoint: { unix: options.replyTo },
    node,
    psk: TEST_PSK,
    keepAliveIntervalMs: 0,
  })
  teardown.push(() => back.close())
  await back.connect(3_000)

  // --- the sandbox daemon: the one stand-in in this file --------------------
  const stub = startStubDaemon({
    initialState: 'frozen',
    sandboxes: options.sandboxes ?? [sandboxName],
    ...(options.readyAfterProbes === undefined
      ? {}
      : { readyAfterProbes: options.readyAfterProbes }),
  })
  teardown.push(() => stub.stop())

  const audit = new AuditLog()
  const timings = new TimingRecorder()
  const daemon = new HttpSandboxDaemon({
    baseUrl: stub.url,
    token: () => STUB_TOKEN,
    audit,
  })

  // Readiness is asked of the daemon stand-in, not of the agent: a real probe
  // would speak to the process inside the sandbox, which does not exist here.
  // This is the simulated half of the wake — see the file header.
  const readyProbe: ReadyProbe = {
    isReady: async (name: string): Promise<boolean> => {
      await Promise.resolve()
      return stub.isReady(name)
    },
  }

  const adapter = new InboundAdapter({ node, team })

  /**
   * The last hop.
   *
   * `deliverAndAck` is used whole and unmodified, so the decision to emit an
   * ack stays inside `@qianmo/adapter` — the point of the "ack is end-to-end"
   * property is that no caller can shortcut it, and a test that re-implemented
   * the read-flip watch would be asserting against its own copy of the rule.
   *
   * A rejection (wrong node, bad envelope, oversized shell) means nothing was
   * written, so it is thrown: the activator then fails the request explicitly
   * through its own `FailureSink`, and the sender hears exactly one error
   * rather than two. Every other outcome — acked, evicted, expired — did reach
   * the mailbox, so the activator's "forwarded" is accurate and the adapter's
   * own reply is what travels back.
   *
   * **Observed while wiring this, worth knowing before P4.2 wires it for
   * real.** Because the server's `onMessage` awaits the activator, and the
   * activator awaits this function, the transport *receipt* is withheld for
   * the whole end-to-end observation: the "expired" case below holds the
   * sender's outbox entry for the full delivery TTL. Here that is an artefact
   * of collapsing host and sandbox into one process — in a real deployment
   * `forward()` is one more hop and returns immediately. A production wiring
   * that keeps this shape would couple the at-least-once retry clock to the
   * ack budget, which is not what either was sized for.
   */
  const forward: ForwardTarget = {
    forward: async (envelope: QianmoMessage): Promise<void> => {
      const reply = await deliverAndAck(adapter, envelope, {
        pollIntervalMs: OBSERVE_POLL_MS,
      })
      settled.push(reply)
      if (reply.outcome === 'rejected') {
        throw new Error(
          `last hop refused the envelope: ${reply.rejection.code} — ${reply.rejection.reason}`,
        )
      }
      back.send(reply.reply)
    },
  }

  const failures: FailureSink = {
    fail: (reply: QianmoMessage): void => {
      back.send(reply)
    },
  }

  const activator = new Activator({
    daemon,
    readyProbe,
    forward,
    failures,
    journal: new MemoryRequestJournal(),
    audit,
    timings,
    readyPollIntervalMs: READY_POLL_MS,
    readyTimeoutMs: 5_000,
  })

  const server = startTransportServer({
    unix: socketPath,
    psk: TEST_PSK,
    // Deliberately never throws. The activator resolves for every terminal
    // state and has already told the sender what happened, at the protocol
    // level; throwing here would additionally make the transport un-remember
    // the envelope and answer `rejected`, so one failure would be reported
    // twice and then retried. "Taken in" is true either way — which is all a
    // receipt claims (`server.ts:47-53`).
    onMessage: async (message: QianmoMessage): Promise<void> => {
      await activator.handle({ envelope: message, sandboxName })
    },
  })
  teardown.push(() => server.stop())

  return {
    node,
    team,
    sandboxName,
    socketPath,
    server,
    adapter,
    activator,
    stub,
    audit,
    timings,
    settled,
  }
}

/**
 * A live agent's poll loop: read the inbox, take everything in.
 *
 * This is the *only* thing that can produce an ack, because the base flips
 * `read` exactly where an agent takes a message into its input
 * (`inProcessRunner.ts:854-865`). Tests that want to prove no ack appears
 * simply do not start one.
 */
function startAgentReadLoop(agent: string, team: string): () => Promise<void> {
  let running = true
  const finished = (async (): Promise<void> => {
    while (running) {
      try {
        await markMessagesAsRead(agent, team)
      } catch {
        // The temp config root is removed at teardown; a poll that loses that
        // race is an artefact of collapsing a node into this process, not a
        // finding. Swallowing it here keeps a stray rejection from being
        // attributed to whatever test happens to be running next.
      }
      await sleep(AGENT_READ_PERIOD_MS)
    }
  })()
  // Awaited, not merely flagged: the loop has to be off the config root before
  // `afterEach` deletes it.
  const stop = async (): Promise<void> => {
    running = false
    await finished
  }
  teardown.push(stop)
  return stop
}

/** Register `address` and hand back the record the sender would resolve. */
function announce(
  registry: InMemoryRegistry,
  address: string,
  endpoint: string,
): void {
  const result = registry.register(address, endpoint, {
    capabilities: ['review'],
    // A frozen node is exactly what `dormant` means: leased, but wake it
    // before dispatch.
    status: AgentStatus.Dormant,
  })
  expect(result.ok).toBe(true)
}

/**
 * The endpoint a node publishes.
 *
 * See the SEAM note in the `registry ⇄ transport` describe block: the registry
 * cannot express a unix socket, so what is published is the `ws://` URL a node
 * would publish anyway, and the socket path is selected from the *node segment
 * of the resolved address*. Resolution therefore still decides both "does this
 * agent exist" and "which node hosts it"; only the last mile is substituted.
 */
function publishedEndpoint(node: string): string {
  return `ws://${node}.invalid/`
}

function envelopeTo(
  to: string,
  overrides: Partial<{
    payload: unknown
    taskId: string
    msgId: string
    deliverTtlMs: number
  }> = {},
): QianmoMessage {
  const message = createMessage({
    from: SENDER,
    to,
    type: MessageType.TaskRequest,
    payload: overrides.payload ?? { ask: 'review the diff' },
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    ...(overrides.msgId === undefined ? {} : { msgId: overrides.msgId }),
    ...(overrides.deliverTtlMs === undefined
      ? {}
      : { deliverTtlMs: overrides.deliverTtlMs }),
  })
  // protocol.md §6.3 call site 1: seed the hop list with the originating node
  // before the envelope is handed to the transport.
  return withHop(message, SENDER_NODE)
}

/** Envelopes of one type that came back to the sender. */
function repliesOfType(
  inbox: readonly QianmoMessage[],
  type: MessageType,
): readonly QianmoMessage[] {
  return inbox.filter(message => message.type === type)
}

function errorCodeOf(message: QianmoMessage): string {
  const payload = message.payload as { code?: string }
  return payload.code ?? ''
}

/** Print the four stages for the P3.1 / P4.1 baseline. Never asserted (D-3). */
function reportTimings(label: string, node: ReceivingNode): void {
  const report = node.timings.report()
  const rows = node.timings.samples().map(durationsOf)
  console.error(
    `\n[P4.1 timings] ${label} — samples=${report.samples} forwarded=${report.forwarded} failed=${report.failed} wakes=${report.wakes}`,
  )
  console.error(
    `  accept→wake   ms  ${JSON.stringify(report.acceptToWake)}\n` +
      `  wake→ready    ms  ${JSON.stringify(report.wakeToReady)}   (SIMULATED: stub daemon)\n` +
      `  ready→forward ms  ${JSON.stringify(report.readyToForward)}\n` +
      `  total         ms  ${JSON.stringify(report.total)}`,
  )
  console.error(`  per-request: ${JSON.stringify(rows)}`)
}

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

describe('AC-2 happy path: resolve → send → wake → forward → read → ack', () => {
  test(
    'a frozen target is woken, delivered to, read, and acks end to end',
    async () => {
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
        // The shape E2 measured: unpause returns long before the working set is
        // warm, so the first probes after the wake say "not yet".
        readyAfterProbes: 2,
      })

      // The node really is asleep before anything is sent.
      expect(nodeB.stub.stateOf(nodeB.sandboxName)).toBe('frozen')
      expect(registry.statusOf(target)).toBe(AgentStatus.Dormant)

      // --- the sender resolves and dials ------------------------------------
      const resolved = registry.resolve(target)
      expect(resolved).not.toBeNull()
      expect(resolved?.address).toBe(target)
      // The node segment comes out of the resolved record through the protocol's
      // own parser, not off a string the test kept — that is the seam this line
      // is here to exercise.
      const hostingNode = nodeOf(resolved?.address) ?? ''
      expect(hostingNode).toBe('node-b')

      const client = await sender.dial(socketFor(hostingNode))

      // The agent is alive and polling its inbox, as one would be in a session.
      startAgentReadLoop(AGENT, nodeB.team)

      const message = envelopeTo(target)
      client.send(message)
      await client.waitForDrain(5_000)

      // --- the ack comes back over the return hop ---------------------------
      await waitUntil(() => sender.inbox.length > 0)
      const acks = repliesOfType(sender.inbox, MessageType.Ack)
      expect(repliesOfType(sender.inbox, MessageType.Error)).toHaveLength(0)
      expect(acks).toHaveLength(1)

      const ack = acks[0]
      expect(ack).toBeDefined()
      if (ack === undefined) throw new Error('unreachable')
      expect(ack.to).toBe(SENDER)
      expect(ack.taskId).toBe(message.taskId)
      expect(isAckPayload(ack.payload)).toBe(true)
      const payload = ack.payload as { handler: string; ackAt: number }
      // Rule K-1: correlation is the envelope's `taskId`, asserted above; the
      // payload names the handler and the read instant, and nothing else.
      expect(Object.keys(payload).sort()).toEqual(['ackAt', 'handler'])
      expect(payload.handler).toBe(target)

      // --- the wake really happened, and stayed inside the capability surface -
      expect(nodeB.stub.hits.acquireSandbox).toBe(1)
      expect(nodeB.stub.hits.destroySandbox).toBe(0)
      expect(nodeB.stub.stateOf(nodeB.sandboxName)).toBe('active')
      expect(nodeB.audit.count(ActivatorEventType.WakeStarted)).toBe(1)
      expect(nodeB.audit.count(ActivatorEventType.RequestForwarded)).toBe(1)
      expect(nodeB.audit.count(ActivatorEventType.RequestFailed)).toBe(0)

      // --- and the message really is in the target's mailbox -----------------
      const inbox = await readMailbox(AGENT, nodeB.team)
      expect(inbox).toHaveLength(1)
      expect(inbox[0]?.from).toBe(SENDER)
      expect(inbox[0]?.read).toBe(true)
      expect(nodeB.settled.map(reply => reply.outcome)).toEqual(['acked'])

      reportTimings('happy path (frozen → active → forward)', nodeB)
    },
    IO_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 1b. Stage timings, ten round trips
// ---------------------------------------------------------------------------

describe('stage timings for the P3.1 / P4.1 baseline', () => {
  /**
   * Ten consecutive catch → wake → ready → forward round trips, each against a
   * target that was re-frozen first.
   *
   * **This is not P2.5 DoD ①.** DoD ① asks for the same shape against a
   * *genuinely dormant* node, and the wake here is the stub flipping a string.
   * What this run does produce is the other thing DoD ① asks for and that
   * nothing else in the tree produces: the four-stage distribution across a
   * repeated chain, so P3.1 has a floor to compare a real freeze against. The
   * `wake→ready` column is the one that will move; the other three are ours.
   *
   * No latency assertion (D-3) — a percentile gate on a shared runner measures
   * the runner. The only bound is the test timeout itself.
   */
  test(
    'ten round trips produce a four-stage distribution',
    async () => {
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
        readyAfterProbes: 2,
      })
      const client = await sender.dial(socketFor('node-b'))
      startAgentReadLoop(AGENT, nodeB.team)

      const rounds = 10
      for (let round = 0; round < rounds; round += 1) {
        // Put the node back to sleep between round trips, so every one of them
        // pays the wake path rather than finding the target already up.
        nodeB.stub.setState(nodeB.sandboxName, 'frozen')
        client.send(envelopeTo(target, { payload: { round } }))
        await waitUntil(() => sender.inbox.length === round + 1)
      }

      const acks = repliesOfType(sender.inbox, MessageType.Ack)
      expect(acks).toHaveLength(rounds)
      expect(repliesOfType(sender.inbox, MessageType.Error)).toHaveLength(0)
      expect(nodeB.stub.hits.acquireSandbox).toBe(rounds)
      expect(nodeB.stub.hits.destroySandbox).toBe(0)
      expect(nodeB.audit.count(ActivatorEventType.WakeStarted)).toBe(rounds)

      const report = nodeB.timings.report()
      expect(report.samples).toBe(rounds)
      expect(report.forwarded).toBe(rounds)
      expect(report.wakes).toBe(rounds)

      reportTimings(`${rounds} round trips (wake path, stubbed daemon)`, nodeB)
    },
    IO_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 2. The ack is end to end, not write-time
// ---------------------------------------------------------------------------

describe('the ack belongs to the agent, not to the file write', () => {
  test(
    'no ack is emitted while the target never reads; an explicit expiry is',
    async () => {
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
      })

      const client = await sender.dial(socketFor('node-b'))

      // No agent read loop is started. This is the whole experiment: everything
      // else is identical to the happy path, including the mailbox write, which
      // is exactly the state a write-time ack cannot tell apart from delivery.
      const message = envelopeTo(target, { deliverTtlMs: 700 })
      client.send(message)
      await client.waitForDrain(5_000)

      // The write landed — so an implementation that acked here would ack.
      await waitUntil(inboxHolds(AGENT, nodeB.team, 1))
      const beforeRead = await readMailbox(AGENT, nodeB.team)
      expect(beforeRead).toHaveLength(1)
      expect(beforeRead[0]?.read).toBe(false)

      // What comes back instead is an explicit expiry, once the delivery
      // deadline passes with the entry still unread.
      await waitUntil(() => sender.inbox.length > 0, 5_000)
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(0)
      const errors = repliesOfType(sender.inbox, MessageType.Error)
      expect(errors).toHaveLength(1)
      expect(errorCodeOf(errors[0] as QianmoMessage)).toBe(
        ProtocolErrorCode.E_TTL_EXPIRED,
      )
      expect(nodeB.settled.map(reply => reply.outcome)).toEqual(['expired'])

      // And the entry is still sitting there unread: nothing consumed it, the
      // ack was withheld for the one reason it may be withheld.
      const after = await readMailbox(AGENT, nodeB.team)
      expect(after).toHaveLength(1)
      expect(after[0]?.read).toBe(false)

      // Belt and braces on "no ack": give the chain another beat and re-check.
      await sleep(200)
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(0)
    },
    IO_TIMEOUT_MS,
  )

  test(
    'the same run acks as soon as an agent does read it',
    async () => {
      // The control for the test above: same wiring, same envelope, one
      // difference — somebody takes the message in.
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
      })
      const client = await sender.dial(socketFor('node-b'))

      const message = envelopeTo(target, { deliverTtlMs: 5_000 })
      client.send(message)

      // Let the write land and the observer see it unread at least once, then
      // read it — so the flip, not the write, is what the ack follows.
      await waitUntil(inboxHolds(AGENT, nodeB.team, 1))
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(0)
      await markMessagesAsRead(AGENT, nodeB.team)

      await waitUntil(() => sender.inbox.length > 0)
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(1)
      expect(nodeB.settled.map(reply => reply.outcome)).toEqual(['acked'])
    },
    IO_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 3. Dedup across layers
// ---------------------------------------------------------------------------

describe('dedup holds across the transport / activator / adapter boundary', () => {
  test(
    'the same envelope delivered three times is processed once',
    async () => {
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
      })
      const client = await sender.dial(socketFor('node-b'))
      startAgentReadLoop(AGENT, nodeB.team)

      const message = envelopeTo(target)
      // Three transmissions of one envelope — what an at-least-once sender does
      // when receipts are slow. Same `msgId` each time, by definition.
      client.send(message)
      client.send(message)
      client.send(message)
      await client.waitForDrain(5_000)
      await waitUntil(() => sender.inbox.length > 0)
      await sleep(150)

      // Level 1 (msgId) caught two of the three at the socket, so the layers
      // above never saw them: one wake, one mailbox entry, one ack.
      const duplicates = nodeB.server.events.byType(
        TransportEventType.MessageDuplicate,
      )
      expect(duplicates.length).toBe(2)
      expect(nodeB.audit.count(ActivatorEventType.RequestAccepted)).toBe(1)
      expect(nodeB.stub.hits.acquireSandbox).toBe(1)
      expect(await readMailbox(AGENT, nodeB.team)).toHaveLength(1)
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(1)
      expect(nodeB.settled).toHaveLength(1)
    },
    IO_TIMEOUT_MS,
  )

  test(
    'a sender that rebuilt the same work item is caught by the fingerprint',
    async () => {
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
      })
      const client = await sender.dial(socketFor('node-b'))
      startAgentReadLoop(AGENT, nodeB.team)

      const taskId = 'task-fingerprint-e2e'
      const payload = { ask: 'review the diff' }
      const first = envelopeTo(target, { taskId, payload })
      // A restarted sender rebuilds the work item: new transmission id, same
      // (from, to, type, taskId, payload) — hence the same fingerprint.
      const rebuilt = envelopeTo(target, { taskId, payload })
      expect(rebuilt.msgId).not.toBe(first.msgId)
      expect(rebuilt.fingerprint).toBe(first.fingerprint)

      client.send(first)
      await client.waitForDrain(5_000)
      client.send(rebuilt)
      await client.waitForDrain(5_000)
      await waitUntil(() => sender.inbox.length > 0)
      await sleep(150)

      const duplicates = nodeB.server.events.byType(
        TransportEventType.MessageDuplicate,
      )
      expect(duplicates).toHaveLength(1)
      expect(duplicates[0]?.detail['level']).toBe('duplicate-fingerprint')
      expect(await readMailbox(AGENT, nodeB.team)).toHaveLength(1)
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(1)
    },
    IO_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 4. Address consistency across two nodes
// ---------------------------------------------------------------------------

describe('two nodes, one agent name, no cross-talk', () => {
  test(
    'each node receives only what is addressed to it',
    async () => {
      const registry = new InMemoryRegistry()
      const toB = 'qianmo://node-b/reviewer'
      const toC = 'qianmo://node-c/reviewer'
      announce(registry, toB, publishedEndpoint('node-b'))
      announce(registry, toC, publishedEndpoint('node-c'))
      expect(registry.size).toBe(2)
      expect(registry.resolve(toB)?.endpoint).not.toBe(
        registry.resolve(toC)?.endpoint,
      )

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
      })
      const nodeC = await startReceivingNode({
        node: 'node-c',
        replyTo: sender.socketPath,
      })
      startAgentReadLoop(AGENT, nodeB.team)
      startAgentReadLoop(AGENT, nodeC.team)

      const clientB = await sender.dial(socketFor('node-b'))
      const clientC = await sender.dial(socketFor('node-c'))

      const forB = envelopeTo(toB, { payload: { ask: 'for b' } })
      const forC = envelopeTo(toC, { payload: { ask: 'for c' } })
      clientB.send(forB)
      clientC.send(forC)
      await clientB.waitForDrain(5_000)
      await clientC.waitForDrain(5_000)
      await waitUntil(() => sender.inbox.length >= 2)

      // Each landed on its own node — the composite `<node>/<agent>` key on the
      // registry side, the adapter's `to.node !== this.node` check on the other.
      const inboxB = await readMailbox(AGENT, nodeB.team)
      const inboxC = await readMailbox(AGENT, nodeC.team)
      expect(inboxB).toHaveLength(1)
      expect(inboxC).toHaveLength(1)
      expect(inboxB[0]?.text).toContain('for b')
      expect(inboxC[0]?.text).toContain('for c')

      // Two acks, each from the right handler, each carrying the right taskId —
      // the correlation key is the envelope's, never a copy in the payload.
      const acks = repliesOfType(sender.inbox, MessageType.Ack)
      expect(acks).toHaveLength(2)
      const byHandler = new Map(
        acks.map(ack => {
          const payload = ack.payload as { handler: string }
          return [payload.handler, ack.taskId]
        }),
      )
      expect(byHandler.get(toB)).toBe(forB.taskId)
      expect(byHandler.get(toC)).toBe(forC.taskId)
    },
    IO_TIMEOUT_MS,
  )

  test(
    'a misrouted envelope is refused by the node it lands on, not absorbed',
    async () => {
      const registry = new InMemoryRegistry()
      const toB = 'qianmo://node-b/reviewer'
      announce(registry, toB, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeC = await startReceivingNode({
        node: 'node-c',
        replyTo: sender.socketPath,
      })
      const clientC = await sender.dial(socketFor('node-c'))

      // Addressed to node-b, delivered down node-c's socket: the failure mode a
      // stale registry entry or a routing bug produces.
      clientC.send(envelopeTo(toB))
      await clientC.waitForDrain(5_000)
      await waitUntil(() => sender.inbox.length > 0)

      const errors = repliesOfType(sender.inbox, MessageType.Error)
      expect(errors).toHaveLength(1)
      // The adapter's `E_UNKNOWN_AGENT` reaches the sender wrapped in the
      // activator's `E_UNDELIVERABLE`, with the original code in the reason —
      // the request failed explicitly at exactly one layer.
      expect(errorCodeOf(errors[0] as QianmoMessage)).toBe(
        ProtocolErrorCode.E_UNDELIVERABLE,
      )
      const reason = (errors[0]?.payload as { reason: string }).reason
      expect(reason).toContain(ProtocolErrorCode.E_UNKNOWN_AGENT)
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(0)
      expect(await readMailbox(AGENT, nodeC.team)).toHaveLength(0)
      expect(nodeC.audit.count(ActivatorEventType.RequestFailed)).toBe(1)
    },
    IO_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 5. Failures are visible, never silent
// ---------------------------------------------------------------------------

describe('a delivery that cannot happen says so', () => {
  test('an unregistered address resolves to nothing and nothing is dialled', () => {
    const registry = new InMemoryRegistry()
    announce(registry, 'qianmo://node-b/reviewer', publishedEndpoint('node-b'))

    expect(registry.resolve('qianmo://node-z/ghost')).toBeNull()
    expect(registry.statusOf('qianmo://node-z/ghost')).toBe(AgentStatus.Offline)
    // Same answer for a malformed address — the caller is never left guessing
    // whether the lookup succeeded.
    expect(registry.resolve('not-an-address')).toBeNull()
  })

  test(
    'an unreachable node fails the dial and keeps the envelope queued',
    async () => {
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))
      // Registered, but nothing is listening on its socket — a node that died
      // without deregistering, which its lease has not yet caught up with.
      expect(registry.resolve(target)).not.toBeNull()

      const client = new TransportClient({
        endpoint: { unix: socketFor('node-b') },
        node: SENDER_NODE,
        psk: TEST_PSK,
        keepAliveIntervalMs: 0,
        backoff: { baseDelayMs: 20, maxDelayMs: 40, jitterRatio: 0 },
      })
      teardown.push(() => client.close())

      await expect(client.connect(400)).rejects.toThrow(/did not become ready/)

      // The envelope is not thrown away: `send` still accepts it and it stays in
      // the outbox for the reconnect. Silence would be the failure this asserts
      // against — an at-least-once sender must still be holding the message.
      client.send(envelopeTo(target))
      expect(client.pending).toBe(1)
    },
    IO_TIMEOUT_MS,
  )

  test(
    'a target the daemon has never heard of fails explicitly and creates nothing',
    async () => {
      const registry = new InMemoryRegistry()
      const target = 'qianmo://node-b/reviewer'
      announce(registry, target, publishedEndpoint('node-b'))

      const sender = startSender()
      const nodeB = await startReceivingNode({
        node: 'node-b',
        replyTo: sender.socketPath,
        // The daemon lists no sandbox by that name at all.
        sandboxes: [],
      })
      const client = await sender.dial(socketFor('node-b'))

      client.send(envelopeTo(target))
      await client.waitForDrain(5_000)
      await waitUntil(() => sender.inbox.length > 0)

      const errors = repliesOfType(sender.inbox, MessageType.Error)
      expect(errors).toHaveLength(1)
      expect(errorCodeOf(errors[0] as QianmoMessage)).toBe(
        ProtocolErrorCode.E_UNDELIVERABLE,
      )
      expect(repliesOfType(sender.inbox, MessageType.Ack)).toHaveLength(0)

      // The crucial half: an unknown name is *not* acquired. `acquireSandbox`
      // creates on an unknown name, so guessing here would stand up a second
      // sandbox instead of reporting the fault.
      expect(nodeB.stub.hits.acquireSandbox).toBe(0)
      expect(nodeB.stub.hits.destroySandbox).toBe(0)
      expect(nodeB.audit.count(ActivatorEventType.RequestFailed)).toBe(1)
      expect(await readMailbox(AGENT, nodeB.team)).toHaveLength(0)

      reportTimings('failure path (sandbox not found)', nodeB)
    },
    IO_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// 6. A seam this run found
// ---------------------------------------------------------------------------

describe('the registry publishes the endpoint the transport actually dials', () => {
  /**
   * This started life as a pinned seam: `dialUrl({unix})` emits
   * `ws+unix://<path>:/`, and `isValidEndpoint` accepted only `qianmo://` or
   * http(s)/ws(s) — so a single-machine node could not announce where it
   * listens, and this file had to publish a placeholder `ws://` URL and derive
   * the socket from the resolved address instead.
   *
   * That workaround was the reason to fix it rather than write the limitation
   * down: it left `endpoint` out of the dial path, so the resolve→dial seam
   * this file exists to cover was not actually being covered. `isValidEndpoint`
   * now accepts `ws+unix:` (see its comment for why that is the same rationale
   * already admitted for `ws:`), and this case guards the round trip.
   */
  test('a unix dial URL survives register → resolve unchanged', () => {
    const dial = dialUrl({ unix: '/tmp/qianmo-e2e/node-b.sock' })
    expect(dial).toBe('ws+unix:///tmp/qianmo-e2e/node-b.sock:/')
    expect(isValidEndpoint(dial)).toBe(true)

    const registry = new InMemoryRegistry()
    const result = registry.register('qianmo://node-b/reviewer', dial)
    expect(result.ok).toBe(true)
    // The exact string the transport would dial comes back out.
    expect(registry.resolve('qianmo://node-b/reviewer')?.endpoint).toBe(dial)

    // Still not a free-for-all: a bare path is not a dial URL.
    expect(isValidEndpoint('/tmp/qianmo-e2e/node-b.sock')).toBe(false)
    expect(isValidEndpoint('ftp://node-b.example/agent')).toBe(false)
  })
})

/**
 * ## What a real-machine version of this needs
 *
 * Two halves of this file are simulated, and both are simulated in the same
 * place — the sandbox daemon:
 *
 * 1. **Dormancy.** `frozen → active` here is `states.set(name, 'active')` in
 *    the stub. A real run needs P3.1 plus a sandbox on the Linux host that has
 *    genuinely been frozen by Dormice, so the wake pays the real cost E2
 *    measured (unpause 46.6–55.5 ms, then 9.0–10.2 s before a 400 MiB working
 *    set runs at speed). Nothing here can produce that number and nothing here
 *    claims to.
 * 2. **Readiness.** `ReadyProbe` asks the stub whether its probe budget is
 *    spent. A real probe has to reach the agent process *inside* the sandbox
 *    and get an answer from it — the distinction the probe exists for is
 *    exactly "unpaused" versus "able to act", which no host-side view can see.
 *
 * Everything else is the shipping code: the socket, the handshake, the receipt
 * loop, dedup, the journal, the wake coalescing, the mailbox write, the read
 * flip, the ack. Cross-machine delivery over real TCP between two hosts is e2e
 * and out of scope for P4.1 by the roadmap's own split.
 */
