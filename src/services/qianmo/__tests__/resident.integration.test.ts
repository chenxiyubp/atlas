// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CapabilityLevel,
  LIMITS,
  MESSAGE_TYPES,
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  createMessage,
  isAckPayload,
  isNotifyPayload,
  isTaskResultPayload,
  newId,
  type NotifyPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import {
  NodeCapabilities,
  OPEN_POLICY,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  issueCapability,
} from '@qianmo/capability'
import {
  ReceiptStatus,
  TransportClient,
  TransportReceiptError,
} from '@qianmo/transport'
import {
  AuditWitnessScheduler,
  remoteWitnessAnchorWriter,
} from '@qianmo/witness'
import { readMailbox } from '../../../utils/agents/teammateMailbox.js'
import { createWakePort } from '../../../cli/handlers/consolePorts.js'
import {
  WakeRefusedError,
  executeResidentWake,
} from '../../../cli/handlers/residentWake.js'
import {
  residentRecallScope,
  type ResidentLifecycleRecord,
  type ResidentPriorLife,
  type ResidentTimingEvent,
} from '@qianmo/resident'
import { FileMemoryStore } from '@qianmo/memory'
import {
  macroDefineArgs,
  resolveBuildFeatures,
} from '../../../../scripts/defines.js'
import { QianmoResident } from '../resident.js'
import { openAuditTrail, residentNotifyTrailSink } from '../auditTrail.js'

const PSK = 'resident-integration-not-a-real-secret'
const TEAM = 'nest'
const AGENT = 'reviewer'
/** Same budget `resident.ts` gives one receipt — and the sender's default. */
const RECEIPT_BUDGET_MS = 5_000
const ACP_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'resident-acp-agent.runner.ts',
)
const CLI_ENTRYPOINT = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'entrypoints',
  'cli.tsx',
)

const children: ChildProcess[] = []
const clients: TransportClient[] = []
let root: string | undefined
let previousConfigDir: string | undefined
let activeResident: QianmoResident | undefined
let activeRun: Promise<void> | undefined

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

function spawnFixture(env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(process.execPath, [ACP_FIXTURE], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  })
  children.push(child)
  return child
}

/**
 * The shipped `qm resident`, run from source the way `scripts/dev.ts` runs it:
 * `MACRO.*` defines and the default feature list from `scripts/defines.ts`, and
 * `NODE_ENV` pinned to what the bundle substitutes — `bun test` exports `test`,
 * which a deployed node never sees (see
 * `tests/integration/qianmo-resident-startup-probe.test.ts`).
 *
 * The environment is built rather than inherited: no model credential from the
 * developer's shell may reach it, or its startup probe would dial a real
 * provider from a unit test.
 */
function spawnResidentCli(
  configDir: string,
  args: readonly string[],
): {
  readonly child: ChildProcess
  /** stdout and stderr interleaved, for failure messages. */
  readonly output: () => string
  /** stdout alone: the banner and whatever else the node prints there. */
  readonly stdout: () => string
} {
  const child = spawn(
    process.execPath,
    [
      'run',
      ...macroDefineArgs(),
      '-d',
      `process.env.NODE_ENV:${JSON.stringify('production')}`,
      ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
      CLI_ENTRYPOINT,
      'resident',
      ...args,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: tmpdir(),
        NODE_ENV: 'production',
        NO_COLOR: '1',
        OCC_IDENTITY: 'qianmo',
        OCC_CONFIG_DIR: configDir,
        QIANMO_TRANSPORT_PSK: PSK,
      },
    },
  )
  children.push(child)
  let output = ''
  let stdout = ''
  child.stdout?.on('data', chunk => {
    output += String(chunk)
    stdout += String(chunk)
  })
  child.stderr?.on('data', chunk => {
    output += String(chunk)
  })
  return { child, output: () => output, stdout: () => stdout }
}

async function unreadCount(): Promise<number> {
  const mailbox = await readMailbox(AGENT, TEAM)
  return mailbox.filter(message => !message.read).length
}

afterEach(async () => {
  activeResident?.stop()
  await activeRun
  activeResident = undefined
  activeRun = undefined
  for (const client of clients.splice(0)) await client.close()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('resident product integration', () => {
  test('transport delivery survives ACP restart and resumes the same session', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-integration-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const workspace = join(root, 'workspace')
    const ready: string[] = []
    const errors: unknown[] = []
    const timings: ResidentTimingEvent[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: workspace }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
      onTiming: event => timings.push(event),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const firstMessage = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 1 },
    })
    client.send(firstMessage)
    await client.waitForDrain()
    await waitUntil(async () => (await unreadCount()) === 0)
    const sessionPath = join(root, 'config', 'resident', 'sessions.json')
    const firstSession = readFileSync(sessionPath, 'utf8')

    children[0]?.kill('SIGKILL')

    // **The link stays up.** Killing the agent used to drop the listener with
    // it, so this test used to wait for the peer to notice the disconnect and
    // queue behind it. It no longer does, and that is the fix this asserts:
    // the listener belongs to the node, not to the ACP child, so an agent
    // restart is invisible at the transport. A peer arriving mid-restart finds
    // the node rather than a refused connection — and a node whose agent never
    // comes back stays addressable instead of vanishing from the network.
    expect(client.isReady()).toBe(true)

    const secondMessage = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 2 },
    })
    client.send(secondMessage)

    // A second child is what marks the restarted ACP generation now; `onReady`
    // no longer does, because the listener does not come back up per
    // generation. The delivery above waits for that new runtime rather than
    // being refused (see `#runtimeForDelivery`).
    await waitUntil(() => children.length === 2)
    await client.waitForDrain()
    await waitUntil(async () => (await unreadCount()) === 0)
    expect(readFileSync(sessionPath, 'utf8')).toBe(firstSession)
    const mailbox = await readMailbox(AGENT, TEAM)
    expect(mailbox).toHaveLength(2)
    expect(mailbox.every(message => message.read)).toBe(true)
    await waitUntil(
      () =>
        timings.filter(event => event.stage === 'turn_completed').length === 2,
    )
    for (const message of [firstMessage, secondMessage]) {
      const events = timings.filter(
        event => event.networkMsgId === message.msgId,
      )
      // Still exact, including for round 2, which now arrives while the agent
      // is dead. No `turn_failed`: `child.kill()` sets `killed` synchronously,
      // so `#runtimeIsLive` is already false when the delivery looks, and the
      // turn is held for the next generation instead of being run against a
      // corpse. See `#failActiveTasks` for the other half — the dying
      // generation must not settle a task it was never handed.
      expect(new Set(events.map(event => event.stage))).toEqual(
        new Set([
          'detected',
          'queued',
          'admitted',
          'read',
          'first_content',
          'turn_completed',
        ]),
      )
      const at = (stage: ResidentTimingEvent['stage']): number =>
        events.find(event => event.stage === stage)?.at ?? -1
      expect(at('detected')).toBeLessThanOrEqual(at('queued'))
      expect(at('queued')).toBeLessThanOrEqual(at('admitted'))
      // Depth is observation, not a decision: one agent submits one turn at a
      // time, so the only honest number here is "this one".
      expect(events.find(event => event.stage === 'queued')?.queueDepth).toBe(1)
      expect(at('detected')).toBeLessThanOrEqual(at('admitted'))
      expect(at('admitted')).toBeLessThanOrEqual(at('first_content'))
      expect(at('first_content')).toBeLessThanOrEqual(at('turn_completed'))
      expect(at('detected')).toBeLessThanOrEqual(at('read'))
      expect(at('read')).toBeLessThanOrEqual(at('turn_completed'))
      expect(new Set(events.map(event => event.inputMessageId)).size).toBe(1)
    }

    // Both rounds are answered on the sender's own channel, across the
    // restart that happened between them.
    await waitUntil(
      () => replies.filter(item => item.type === MessageType.Ack).length === 2,
    )
    expect(new Set(replies.map(item => item.taskId))).toEqual(
      new Set([firstMessage.taskId, secondMessage.taskId]),
    )

    resident.stop()
    await running
    // Exactly one error, and it is the SIGKILL this test asked for.
    //
    // The list is asserted whole on purpose, and it only holds still because
    // teardown drains reply receipts first. Both rounds settle by writing a
    // `task.result` and awaiting the sender's receipt, and both settles are in
    // flight at a teardown: round 1's when the killed ACP child brings the
    // generation down, round 2's when `stop()` below runs — `turn_completed` is
    // recorded before `onTurnResult` even starts, so waiting on that timing
    // above does not wait for the receipt. Tearing the transport down under
    // either of them would reject the wait with `transport server closed before
    // receipt` and add a second entry here. See `#drainReplyReceipts` in
    // `resident.ts` for why that wait is now honoured instead.
    expect(errors.map(String)).toEqual([
      'Error: resident ACP child exited code=null signal=SIGKILL',
    ])
  }, 15_000)

  test('a node whose agent never starts degrades instead of disappearing', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-degraded-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // Every generation dies on the spot. This is the shape of an expired
      // credential, a missing binary or a broken build: not a crash mid-turn,
      // but an agent that cannot come up at all, ever.
      spawnAcp: () => {
        const child = spawn(process.execPath, ['-e', 'process.exit(3)'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        })
        children.push(child)
        return child
      },
      // The production ladder is 2s/4s/8s/16s before the fifth failure parks.
      // Nothing here depends on the wait itself, only on what parking does.
      acpRestart: { initialBackoffMs: 10, maxRapidFailures: 2 },
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    // Bound before the agent, and never on the agent's behalf: no generation
    // ever succeeded here, so under the old ownership this address would not
    // exist at all.
    await waitUntil(() => ready.length === 1)
    await waitUntil(() =>
      errors.some(error => String(error).includes('resident is degraded')),
    )
    expect(ready).toEqual([socket])
    // `run()` has not returned. Parking used to end it, taking the listener,
    // the ledger and the audit chain down with it.
    let settled = false
    void running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    // The peer reaches the node. "Agent unavailable" and "node gone" are
    // different facts, and this connection is what lets a peer tell them apart.
    await client.connect()

    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 1 },
    })
    // Refused, not dropped and not left to time out: the receipt says the
    // envelope was rejected, and it comes back inside the sender's budget
    // rather than after `deliverTtlMs` of silence.
    const startedAt = Date.now()
    const receipt = await client.sendAndWait(request, RECEIPT_BUDGET_MS).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(receipt).toBeInstanceOf(TransportReceiptError)
    expect((receipt as TransportReceiptError).receiptCode).toBe(
      ProtocolErrorCode.E_UNDELIVERABLE,
    )
    expect(Date.now() - startedAt).toBeLessThan(RECEIPT_BUDGET_MS)

    // And the reason travels with it, so the operator reads "this node's agent
    // is unavailable" instead of a bare `E_UNDELIVERABLE`.
    await waitUntil(() => replies.some(item => item.type === MessageType.Error))
    const refusal = replies.find(item => item.type === MessageType.Error)
    expect(String((refusal?.payload as { reason?: string })?.reason)).toContain(
      'resident agent is unavailable',
    )
    // Nothing was written: a turn that cannot run must not leave an inbox slot
    // spent behind it.
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(0)

    // It is still a node, on purpose. `stop()` is the only thing that ends it.
    expect(client.isReady()).toBe(true)
    resident.stop()
    await running
  }, 15_000)

  test('a never-settling witness tick does not block mailbox admission', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-witness-poll-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    let ticks = 0
    let failuresRemaining = 0
    const witness = {
      tick: (): Promise<void> => {
        ticks += 1
        if (failuresRemaining > 0) {
          failuresRemaining -= 1
          return Promise.reject(new Error('witness tick rejected'))
        }
        return new Promise(() => {})
      },
      close: (): void => {},
    } as unknown as AuditWitnessScheduler
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      witness,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)
    await waitUntil(() => ticks > 0)

    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
    })
    clients.push(client)
    await client.connect()
    client.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { round: 'witness-pending' },
      }),
    )
    await client.waitForDrain()
    await waitUntil(async () => (await unreadCount()) === 0)
    failuresRemaining = 1
    await waitUntil(() =>
      errors.some(error => String(error).includes('rejected')),
    )
  }, 10_000)

  test('stop aborts in-flight witness IO and settles even when fetch ignores the signal', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-witness-stop-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const trailPath = join(root, 'audit.ndjson')
    const trail = new AuditTrail(trailPath)
    trail.append({
      at: 1,
      source: AuditSource.Resident,
      kind: 'resident_started',
      outcome: 'ok',
      node: 'node-b',
    })
    trail.close()
    const errors: unknown[] = []
    let fetches = 0
    let aborted = false
    const witness = new AuditWitnessScheduler({
      node: 'node-b',
      trailPath,
      keys: generateNodeKeyPair(),
      writer: remoteWitnessAnchorWriter({
        url: 'http://witness.test',
        token: 'resident-witness-write-token',
        timeoutMs: 60_000,
        fetchImpl: ((_input, init) => {
          fetches += 1
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true
            },
            { once: true },
          )
          return new Promise<Response>(() => {})
        }) as typeof fetch,
      }),
      now: () => 10_000,
      onError: error => errors.push(error),
    })
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      witness,
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => fetches === 1)

    resident.stop()
    await expect(
      Promise.race([
        running.then(() => 'settled'),
        Bun.sleep(1_000).then(() => 'timed-out'),
      ]),
    ).resolves.toBe('settled')
    expect(aborted).toBe(true)
    expect(errors).toEqual([])

    await witness.tick()
    expect(fetches).toBe(1)
    activeResident = undefined
    activeRun = undefined
  }, 10_000)

  test('acks at the read flip and returns task.result over the same channel', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-task-result-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    // The dialling side of the hop: it never listens, so anything that arrives
    // here arrived over the very connection the request went out on.
    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'summarise' },
    })
    client.send(request)
    await client.waitForDrain()
    await waitUntil(() => replies.length >= 2)

    const [ack, result] = replies
    expect(ack?.type).toBe(MessageType.Ack)
    expect(ack?.taskId).toBe(request.taskId)
    expect(ack?.from).toBe('qianmo://node-b/reviewer')
    expect(ack?.to).toBe('qianmo://node-a/planner')
    expect(isAckPayload(ack?.payload)).toBe(true)
    expect(Object.keys(ack?.payload as object).sort()).toEqual([
      'ackAt',
      'handler',
    ])
    // Rule K-1: the ack asserts the read flip and nothing else.
    expect((await readMailbox(AGENT, TEAM)).every(item => item.read)).toBe(true)

    expect(result?.type).toBe(MessageType.TaskResult)
    expect(result?.taskId).toBe(request.taskId)
    expect(isTaskResultPayload(result?.payload)).toBe(true)
    expect(result?.payload).toMatchObject({
      outcome: 'completed',
      content: 'fixture response',
    })
    expect(replies).toHaveLength(2)
    expect(errors).toEqual([])
  }, 15_000)

  test('a second request is receipted inside the budget while a turn holds the gate', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-receipt-decoupling-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The first turn is admitted and then never ends, so the node turn gate
      // is held for the rest of the test.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const first = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'holds the gate' },
    })
    await client.sendAndWait(first, RECEIPT_BUDGET_MS)
    await waitUntil(() => replies.some(item => item.type === MessageType.Ack))

    // The whole of H-3: queueing behind a running turn must not be paid for
    // out of the sender's transport receipt budget.
    const second = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'queued behind it' },
    })
    const startedAt = Date.now()
    await expect(client.sendAndWait(second, RECEIPT_BUDGET_MS)).resolves.toBe(
      ReceiptStatus.Accepted,
    )
    expect(Date.now() - startedAt).toBeLessThan(RECEIPT_BUDGET_MS)

    // And the receipt says exactly what it is allowed to say: the envelope is
    // durable. It is not an ack — that one still waits for the read flip, which
    // cannot happen while the first turn holds the gate.
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(2)
    expect(
      replies.filter(
        item => item.type === MessageType.Ack && item.taskId === second.taskId,
      ),
    ).toHaveLength(0)
  }, 20_000)

  test('an ACP crash while busy comes back as a failed task.result', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-task-failed-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'never finishes' },
    })
    // The receipt says "kept", and that is all it ever says now. Everything
    // that goes wrong after this point has to reach the sender through the
    // task channel instead — which is the assertion at the end of this test.
    await expect(client.sendAndWait(request, RECEIPT_BUDGET_MS)).resolves.toBe(
      ReceiptStatus.Accepted,
    )
    // The turn is admitted and read — the sender has its ack — but the ACP
    // child hangs before the turn ever terminates.
    await waitUntil(() => replies.some(item => item.type === MessageType.Ack))

    children[0]?.kill('SIGKILL')

    await waitUntil(() =>
      replies.some(item => item.type === MessageType.TaskResult),
    )
    const result = replies.find(item => item.type === MessageType.TaskResult)
    expect(result?.taskId).toBe(request.taskId)
    expect(isTaskResultPayload(result?.payload)).toBe(true)
    expect(result?.payload).toMatchObject({
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
    })
    // Two paths race to report the same thing — the ACP SDK rejecting the
    // in-flight prompt, and the supervisor sweeping active tasks before it
    // tears the transport down. Both are E_TASK_FAILED; telling the two
    // apart is cause-level diagnosis, which belongs to P5.1.
    expect(
      (result?.payload as { reason: string }).reason.length,
    ).toBeGreaterThan(0)
  }, 15_000)

  test('a full turn queue refuses before the mailbox write, downgrading for old peers', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-queue-full-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      // Slow, because the admission loop's own polls are refused too once the
      // queue is full and there is nothing to learn from that noise.
      pollIntervalMs: 10_000,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    // Filled from the inside: one agent submits one turn at a time, so no
    // amount of inbound traffic will ever fill a 32-deep queue by itself.
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const occupied = Array.from({ length: LIMITS.maxQueuedTurns + 1 }, () =>
      resident.gate.run(async () => await held),
    )
    expect(resident.gate.saturated).toBe(true)

    // A peer that declared a post-legacy type gets the precise code…
    const modern: QianmoMessage[] = []
    const modernClient = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        modern.push(message)
      },
    })
    clients.push(modernClient)
    await modernClient.connect()
    await expect(
      modernClient.sendAndWait(
        createMessage({
          from: 'qianmo://node-a/planner',
          to: 'qianmo://node-b/reviewer',
          type: MessageType.TaskRequest,
          payload: { ask: 'while full' },
        }),
        RECEIPT_BUDGET_MS,
      ),
    ).rejects.toThrow()
    expect(modern.at(-1)?.type).toBe(MessageType.Error)
    expect((modern.at(-1)?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_BUSY,
    )

    // …and one that declared nothing gets the nearest legacy stand-in, because
    // a code it cannot parse would make it refuse the whole reply (rule N-1).
    const legacy: QianmoMessage[] = []
    const legacyClient = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-c',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        legacy.push(message)
      },
    })
    clients.push(legacyClient)
    await legacyClient.connect()
    await expect(
      legacyClient.sendAndWait(
        createMessage({
          from: 'qianmo://node-c/planner',
          to: 'qianmo://node-b/reviewer',
          type: MessageType.TaskRequest,
          payload: { ask: 'while full, older peer' },
        }),
        RECEIPT_BUDGET_MS,
      ),
    ).rejects.toThrow()
    expect((legacy.at(-1)?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_RATE_LIMITED,
    )

    // Rule L-1, the whole reason the check sits where it does: a refusal does
    // not spend the recipient's inbox quota.
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(0)

    release()
    await Promise.all(occupied)
  }, 20_000)

  test('reports idle before restarting an ACP generation that crashes while busy', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-activity-crash-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const activity: boolean[] = []
    const ready: string[] = []
    let generation = 0
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () => {
        generation++
        return spawnFixture(
          generation === 1
            ? { ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }
            : process.env,
        )
      },
      onActivity: active => {
        activity.push(active)
      },
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
    })
    clients.push(client)
    await client.connect()
    await client.sendAndWait(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { crash: 'while-busy' },
      }),
    )
    await waitUntil(() => activity.includes(true))

    children[0]?.kill('SIGKILL')

    await waitUntil(() => activity.at(-1) === false)
    expect(activity).toEqual([true, false])
    // Second ACP child, not a second `onReady` — see the note above.
    await waitUntil(() => children.length === 2)
  }, 15_000)
})

describe('authorization at the terminal node (P4.3)', () => {
  test('an unsigned task is refused before the mailbox, a signed one carries its issuer', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-capability-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []

    const peer = generateNodeKeyPair()
    const own = generateNodeKeyPair()
    const directory = new StaticPublicKeyDirectory([
      ['node-a', peer.publicKey],
      ['node-b', own.publicKey],
    ])
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      capability: new NodeCapabilities({
        node: 'node-b',
        directory,
        keys: own,
        policy: SIGNED_TASK_POLICY,
      }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    // 1. Unsigned work under a signing policy: refused ahead of the write, so
    //    the recipient's inbox is untouched (rule L-1 + S-2).
    const unsigned = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'unsigned' },
    })
    await expect(client.sendAndWait(unsigned, 5_000)).rejects.toThrow()
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(0)
    const refusal = replies.at(-1)
    expect(refusal?.type).toBe(MessageType.Error)
    expect((refusal?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_CAP_INSUFFICIENT,
    )

    // 2. The same work, authorized by the peer's own key. The task id is
    //    minted first because the token is bound to it: there are no
    //    general-purpose capabilities.
    const taskId = newId()
    const bound = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { round: 'signed' },
      taskId,
      cap: issueCapability('node-a', peer, {
        sub: 'qianmo://node-b/reviewer',
        aud: 'node-b',
        act: CapabilityLevel.WriteLimited,
        taskId,
        nbf: Date.now() - 1_000,
        exp: Date.now() + 60_000,
      }),
    })
    client.send(bound)
    await client.waitForDrain()
    await waitUntil(async () => (await readMailbox(AGENT, TEAM)).length === 1)

    // The provenance the receiver wrote names who signed for it — and it is
    // the receiver's own finding, not a field copied off the envelope.
    const entry = (await readMailbox(AGENT, TEAM))[0]
    const wrapper = JSON.parse(entry?.text ?? '{}') as {
      envelope?: { origin?: { capIss?: string; node?: string } }
    }
    expect(wrapper.envelope?.origin?.capIss).toBe('node-a')
    expect(wrapper.envelope?.origin?.node).toBe('node-a')

    resident.stop()
    await running
  }, 20_000)
})

describe('the reliability kit (P13.5)', () => {
  /** Kinds of every record in the delivery ledger, oldest first. */
  function deliveryRecords(): { kind: string; taskId?: string }[] {
    const path = join(root ?? '', 'config', 'resident', 'deliveries.ndjson')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { kind: string; taskId?: string })
  }

  test('an unreceipted task.result is redelivered after a restart, marked as a repeat', async () => {
    // The traceless loss, end to end. Before this batch, a reply whose receipt
    // never came back reached `onError` and then existed nowhere: the peer
    // waited forever for something no part of this node remembered owing it.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-redelivery-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')

    // ---- first life --------------------------------------------------
    const firstReady: string[] = []
    const firstErrors: unknown[] = []
    const first = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The turn is admitted — so the peer gets its ack — and then never ends.
      // That is what makes the loss deterministic: the reply is not produced
      // until teardown, by which time the peer is already gone.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) firstReady.push(address.unix)
      },
      onError: error => firstErrors.push(error),
    })
    const firstRun = first.run()
    activeResident = first
    activeRun = firstRun
    await waitUntil(() => firstReady.length === 1)

    const seen: QianmoMessage[] = []
    const doomed = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        seen.push(message)
      },
    })
    await doomed.connect()
    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'answer me, then lose the receipt' },
    })
    doomed.send(request)
    await waitUntil(() =>
      seen.some(
        item => item.type === MessageType.Ack && item.taskId === request.taskId,
      ),
    )
    // The peer vanishes while its turn is still running.
    await doomed.close()

    // Teardown fails the in-flight task, which is where the reply is produced
    // — written to the ledger first, then sent to a peer that is not there.
    first.stop()
    await firstRun
    activeResident = undefined
    activeRun = undefined

    const owed = deliveryRecords()
    // The obligation is written down *before* the reply goes on the wire, so
    // it exists even for a crash between the two.
    expect(owed.some(item => item.kind === 'pending')).toBe(true)
    expect(owed.some(item => item.kind === 'attempting')).toBe(true)
    // Not retired: that is the whole point.
    expect(owed.some(item => item.kind === 'delivered')).toBe(false)
    expect(firstErrors.length).toBeGreaterThan(0)

    // ---- second life -------------------------------------------------
    const secondReady: string[] = []
    const second = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) secondReady.push(address.unix)
      },
      onError: () => {},
    })
    const secondRun = second.run()
    activeResident = second
    activeRun = secondRun
    await waitUntil(() => secondReady.length === 1)

    const replies: QianmoMessage[] = []
    const returning = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(returning)
    await returning.connect()
    // Contact from the peer is the trigger, and it has to be: rule H-2 says a
    // node never dials, so the moment this peer's channel exists is the only
    // moment an owed reply can leave.
    returning.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { ask: 'the new one' },
      }),
    )

    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const redelivered = replies.find(
      item =>
        item.type === MessageType.TaskResult && item.taskId === request.taskId,
    )
    // A **new envelope** carrying the same correlation key, never a
    // retransmission: the original's `deliverTtlMs` expired long before the
    // restart finished, so re-sending it verbatim would earn an
    // `E_TTL_EXPIRED` and nothing else (protocol.md §14.4③).
    expect(redelivered?.msgId).not.toBe(request.msgId)
    expect(isTaskResultPayload(redelivered?.payload)).toBe(true)
    // The marker the peer deduplicates by. Honest at-least-once: a repeat is
    // visible, never silent.
    expect(redelivered?.payload).toMatchObject({
      outcome: 'failed',
      redelivered: true,
    })

    // And it retires once it is finally receipted, so a third life is quiet.
    await waitUntil(() =>
      deliveryRecords().some(item => item.kind === 'delivered'),
    )
  }, 45_000)

  test('a peer too old for the marker still gets its answer, without the field', async () => {
    // Rule N-1's discipline applied to a field rather than to a code. A peer
    // that predates `redelivered` validates `task.result` by an exact key set,
    // so sending it the flag would not degrade to "an unfamiliar marker" — it
    // would degrade to the whole reply being refused as malformed, which is
    // the one outcome a redelivery must not produce.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-redelivery-legacy-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')

    const firstReady: string[] = []
    const firstErrors: unknown[] = []
    const first = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The turn is admitted — so the peer gets its ack — and then never ends.
      // That is what makes the loss deterministic: the reply is not produced
      // until teardown, by which time the peer is already gone.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) firstReady.push(address.unix)
      },
      onError: error => firstErrors.push(error),
    })
    const firstRun = first.run()
    activeResident = first
    activeRun = firstRun
    await waitUntil(() => firstReady.length === 1)

    // Declares nothing, which reads as the legacy floor.
    const seen: QianmoMessage[] = []
    const doomed = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        seen.push(message)
      },
    })
    await doomed.connect()
    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'older peer' },
    })
    doomed.send(request)
    await waitUntil(() =>
      seen.some(
        item => item.type === MessageType.Ack && item.taskId === request.taskId,
      ),
    )
    await doomed.close()
    first.stop()
    await firstRun
    expect(deliveryRecords().some(item => item.kind === 'delivered')).toBe(
      false,
    )
    expect(firstErrors.length).toBeGreaterThan(0)

    const secondReady: string[] = []
    const second = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) secondReady.push(address.unix)
      },
      onError: () => {},
    })
    const secondRun = second.run()
    activeResident = second
    activeRun = secondRun
    await waitUntil(() => secondReady.length === 1)

    const replies: QianmoMessage[] = []
    const returning = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(returning)
    await returning.connect()
    returning.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { ask: 'the new one' },
      }),
    )

    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const redelivered = replies.find(
      item =>
        item.type === MessageType.TaskResult && item.taskId === request.taskId,
    )
    // The answer still arrives, and it still validates on an older build…
    expect(isTaskResultPayload(redelivered?.payload)).toBe(true)
    // …because the marker was withheld. The peer still has `taskId` to notice
    // the duplicate by, which is the correlation key it already had (C-1).
    expect(redelivered?.payload).not.toHaveProperty('redelivered')
  }, 45_000)

  test('ESTOP refuses new work with E_BUSY, never touches a running turn, and an empty file counts', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-estop-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // The first turn is admitted and then never ends, so there is a real
      // in-flight turn for the brake to fail to kill.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [MessageType.Notify],
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const inFlight = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'runs across the stop' },
    })
    client.send(inFlight)
    await waitUntil(() => replies.some(item => item.type === MessageType.Ack))

    // `touch ESTOP` — the most obvious way a human pulls the brake, and the
    // one an implementation that parsed contents would read as "carry on".
    const sentinel = join(root, 'config', 'resident', 'ESTOP')
    writeFileSync(sentinel, '')

    const refused = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'arrives after the stop' },
    })
    await expect(
      client.sendAndWait(refused, RECEIPT_BUDGET_MS),
    ).rejects.toThrow()
    const refusal = replies.at(-1)
    expect(refusal?.type).toBe(MessageType.Error)
    expect((refusal?.payload as { code: string }).code).toBe(
      ProtocolErrorCode.E_BUSY,
    )

    // Rule L-1: the refusal is ahead of the mailbox write, so it does not
    // spend the recipient's inbox quota. Only the first request is on disk.
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(1)

    // Pause-new-work, not abort-running-work. The turn admitted before the
    // brake is still alive — nothing failed it, and its ack still stands.
    expect(
      replies.filter(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === inFlight.taskId,
      ),
    ).toHaveLength(0)
    expect(
      replies.some(
        item =>
          item.type === MessageType.Ack && item.taskId === inFlight.taskId,
      ),
    ).toBe(true)
  }, 25_000)

  test('a turn whose ACP side goes silent fails early, and says it was inactivity', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-inactivity-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      // Admits the turn, sends one chunk, then never speaks again.
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_HOLD_BUSY: '1' }),
      inactivityMs: 400,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const request = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      // Five minutes of task budget: without the watchdog this sender waits
      // all of it and then learns nothing.
      payload: { ask: 'goes quiet' },
    })
    client.send(request)

    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const result = replies.find(item => item.type === MessageType.TaskResult)
    expect(result?.payload).toMatchObject({
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
    })
    const reason = (result?.payload as { reason: string }).reason
    // Not a bare timeout: the sender has to be able to tell inactivity apart
    // from a refusal or a crash, and to know that the retry which would help
    // is one carrying a longer `taskTtlMs` — a decision only it may make.
    expect(reason).toContain('inactivity')
    expect(reason).toContain('taskTtlMs')
  }, 25_000)

  test('a SIGKILLed `qm resident` is read as killed by the next life', async () => {
    // Validation report 2026-09-08, B-1. `run()` used to start the sentinel
    // only as the argument of `onPriorLife?.(…)`, and an optional call skips
    // its arguments when there is no callee. The shipped CLI passes no
    // observer, so a real node never stamped `running` and a `kill -9` left
    // nothing behind — while every test that constructs the resident itself
    // passes whatever it likes and never saw it. So the life that gets killed
    // here is the real entrypoint: its wiring *is* the thing under test.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-hardkill-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = join(root, 'config')
    process.env.CLAUDE_CONFIG_DIR = configDir
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const lifecycle = join(configDir, 'resident', 'lifecycle.json')
    const readRecord = (): ResidentLifecycleRecord | undefined =>
      existsSync(lifecycle)
        ? (JSON.parse(
            readFileSync(lifecycle, 'utf8'),
          ) as ResidentLifecycleRecord)
        : undefined

    const firstSocket = join(root, 'first.sock')
    const launchedAt = Date.now()
    const first = spawnResidentCli(configDir, [
      '--node',
      'node-b',
      '--team',
      TEAM,
      '--agent',
      `${AGENT}=${workspace}`,
      '--unix',
      firstSocket,
      '--open-policy',
    ])
    // Listening is the readiness mark, and it is also the ordering guarantee:
    // `run()` claims the sentinel before it binds. The banner is not — it is
    // printed before `run()` is even called.
    await waitUntil(
      () => existsSync(firstSocket) || first.child.exitCode !== null,
      60_000,
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${first.output()}`)
    })
    if (!existsSync(firstSocket)) {
      throw new Error(
        `qm resident exited before listening (code ${String(
          first.child.exitCode,
        )}):\n${first.output()}`,
      )
    }
    const atReady = readRecord()
    expect(atReady).toMatchObject({
      phase: 'running',
      pid: first.child.pid,
      node: 'node-b',
    })
    // Claimed by `start()`, not by the first heartbeat: that one only fires
    // once the agent is up, and before the fix it was the sole writer, with
    // `startedAt: 0`.
    expect(atReady?.startedAt).toBeGreaterThanOrEqual(launchedAt)

    first.child.kill('SIGKILL')
    if (first.child.exitCode === null && first.child.signalCode === null) {
      await once(first.child, 'exit')
    }
    expect(first.child.signalCode).toBe('SIGKILL')
    // Nothing ran on the way out, so the evidence is exactly what was there.
    expect(readRecord()).toEqual(atReady)

    // The restart, on the same config root, through the existing observer.
    const priors: ResidentPriorLife[] = []
    const errors: unknown[] = []
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: workspace }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: join(root, 'second.sock') },
      spawnAcp: spawnFixture,
      onPriorLife: prior => priors.push(prior),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    expect(priors).toEqual([{ outcome: 'killed', record: atReady }])
    expect(readRecord()).toMatchObject({ phase: 'running', pid: process.pid })

    resident.stop()
    await running
    const stopped = readRecord()
    expect(stopped).toMatchObject({ phase: 'stopped', pid: process.pid })
    expect(stopped?.startedAt).toBeGreaterThanOrEqual(atReady?.startedAt ?? 0)
    expect(errors.map(String)).toEqual([])
  }, 90_000)

  test('`qm resident` prints how the previous life ended: unknown, killed, clean', async () => {
    // The verdict above reached only an observer the CLI never passed, so on
    // a real node it was computed and shown nowhere. Three real lives on one
    // config root, each read the way an operator reads it: off its stdout.
    const base = mkdtempSync(join(tmpdir(), 'qianmo-resident-priorlife-'))
    root = base
    const configDir = join(base, 'config')
    const workspace = join(base, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const lifecycle = join(configDir, 'resident', 'lifecycle.json')
    const readRecord = (): ResidentLifecycleRecord | undefined =>
      existsSync(lifecycle)
        ? (JSON.parse(
            readFileSync(lifecycle, 'utf8'),
          ) as ResidentLifecycleRecord)
        : undefined
    // Complete lines only: the last segment is empty or still arriving.
    const stdoutLines = (stdout: string): Record<string, unknown>[] =>
      stdout
        .split('\n')
        .slice(0, -1)
        .map(line => JSON.parse(line) as Record<string, unknown>)
    const priorLifeOf = (stdout: string): Record<string, unknown> | undefined =>
      stdoutLines(stdout).find(line => 'priorLife' in line)
    const launch = async (
      name: string,
    ): Promise<ReturnType<typeof spawnResidentCli>> => {
      const socket = join(base, `${name}.sock`)
      const life = spawnResidentCli(configDir, [
        '--node',
        'node-b',
        '--team',
        TEAM,
        '--agent',
        `${AGENT}=${workspace}`,
        '--unix',
        socket,
        '--open-policy',
      ])
      const failed = (what: string) => (error: unknown) => {
        throw new Error(
          `qm resident (${name}, pid ${String(life.child.pid)}) ${what}: ${String(
            error,
          )}\n${life.output()}`,
        )
      }
      await waitUntil(
        () => existsSync(socket) || life.child.exitCode !== null,
        60_000,
      ).catch(failed('never listened'))
      if (life.child.exitCode !== null) {
        failed('exited before listening')(life.child.exitCode)
      }
      // Printed before the listener is bound, so by now the line can only be
      // in the pipe: the short wait absorbs delivery lag, nothing more.
      await waitUntil(() => priorLifeOf(life.stdout()) !== undefined).catch(
        failed('listened without saying how its previous life ended'),
      )
      // The banner keeps the first line, unchanged; the verdict follows it.
      const [banner] = stdoutLines(life.stdout())
      expect(banner).toMatchObject({
        node: 'node-b',
        requireSignedTasks: false,
      })
      expect(banner).not.toHaveProperty('priorLife')
      return life
    }
    const exited = async (child: ChildProcess): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit')
      }
    }

    // A config root nothing has run on: no evidence either way.
    const first = await launch('first')
    expect(priorLifeOf(first.stdout())).toEqual({
      node: 'node-b',
      priorLife: 'unknown',
    })

    first.child.kill('SIGKILL')
    await exited(first.child)
    const leftBehind = readRecord()
    expect(leftBehind).toMatchObject({ phase: 'running', pid: first.child.pid })

    // Killed, with the dead life's own record — nothing more, nothing derived.
    const second = await launch('second')
    expect(priorLifeOf(second.stdout())).toEqual({
      node: 'node-b',
      priorLife: 'killed',
      prior: {
        pid: first.child.pid,
        startedAt: leftBehind?.startedAt,
        updatedAt: leftBehind?.updatedAt,
      },
    })

    // The shutdown path an operator's `beta-down.sh` takes.
    second.child.kill('SIGTERM')
    await exited(second.child)
    expect(readRecord()).toMatchObject({
      phase: 'stopped',
      pid: second.child.pid,
    })

    const third = await launch('third')
    expect(priorLifeOf(third.stdout())).toEqual({
      node: 'node-b',
      priorLife: 'clean',
    })
  }, 120_000)
})

/**
 * T11 blind spot ③, and the determination it was opened to make.
 *
 * `protocol.md` §3.4 says `wake` **needs an ack**; the resident produces none,
 * because `#registerTask` fires only for `task.request`. P13.5 was handed the
 * job of deciding which half is wrong. These tests are the evidence, and the
 * answer is that the **document** is: see the assertions below and the note
 * rewritten in `protocol.md` §3.4 / §14.8.
 */
describe('wake, end to end on the resident side (T11 blind spot ③)', () => {
  test('the production sender is answered by a transport receipt, and the wake still opens a turn', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-wake-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const ready: { url?: string }[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      // TCP rather than a unix socket: `executeResidentWake` takes a ws URL,
      // and running the real sender is the point of this test.
      listen: { port: 0, hostname: '127.0.0.1' },
      spawnAcp: spawnFixture,
      onReady: address => ready.push(address),
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)
    const url = ready[0]?.url
    expect(url).toBeDefined()

    const result = await executeResidentWake(
      {
        url: url as string,
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        prompt: 'wake up and look at the queue',
        afterMs: 0,
        timeoutMs: 10_000,
        deliverTtlMs: 90_000,
      },
      PSK,
    )

    // What the only production wake sender actually waits for — and it closes
    // its client the moment this lands, so an ack sent afterwards would have
    // nowhere to arrive. It also passes no `onMessage` sink, so it could not
    // read one if it did.
    expect(result.receipt).toBe(ReceiptStatus.Accepted)
    expect(result.taskId.length).toBeGreaterThan(0)

    // The wake does everything §14.8 says it does: it lands in the mailbox and
    // opens a turn, which is what "wake the node" means here.
    await waitUntil(async () => (await readMailbox(AGENT, TEAM)).length === 1)
    await waitUntil(async () =>
      (await readMailbox(AGENT, TEAM)).every(item => item.read),
    )
  }, 25_000)

  test('a wake produces no protocol ack, while a task.request on the same channel does', async () => {
    // The determination, stated as a comparison so it cannot be read as "the
    // ack machinery was broken that day": the same node, the same channel, the
    // same connected listener — one type is acked and the other is not.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-wake-ack-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    // Unlike the production sender, this peer stays connected and listens —
    // so "no ack arrived" is a fact about the node rather than about a socket
    // that had already gone away.
    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const wake = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.Wake,
      payload: { trigger: 'manual', prompt: 'wake up' },
    })
    await expect(client.sendAndWait(wake, RECEIPT_BUDGET_MS)).resolves.toBe(
      ReceiptStatus.Accepted,
    )
    // The wake's own turn runs to completion — the read flip happens, which is
    // exactly the event an A-class ack would assert.
    await waitUntil(async () => {
      const mailbox = await readMailbox(AGENT, TEAM)
      return mailbox.length === 1 && mailbox.every(item => item.read)
    })

    // The control: a `task.request` behind it, on this same channel.
    const task = createMessage({
      from: 'qianmo://node-a/planner',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'and now some work' },
    })
    client.send(task)
    await waitUntil(() =>
      replies.some(
        item => item.type === MessageType.Ack && item.taskId === task.taskId,
      ),
    )
    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult && item.taskId === task.taskId,
      ),
    )

    // Nothing at all came back for the wake — no ack, and no `task.result`
    // either, because no task was ever registered for it.
    expect(replies.filter(item => item.taskId === wake.taskId)).toEqual([])
  }, 25_000)

  test('a wake the delivery layer refuses answers with its real code, not with silence (issue #34)', async () => {
    // issue #34。投递层拒绝（这里是 `E_UNKNOWN_AGENT`：这台节点上没有这个
    // agent，`assertDeliverable` 在写盘之前就拒了）以前**一个字都不回** ——
    // `#receive` 只为 `task.request` 备了答复，而 wake 没有 task。发起方于是
    // 只剩一个被 `receiver.ts` 压平成 `E_UNDELIVERABLE` 的回执，操作者要登机
    // 读 `trail.ndjson` 才知道为什么。
    //
    // 这条用例不测「代码里多发了一条信封」，它从**真节点**一路量到**操作面上
    // 那一行字**：真 `QianmoResident`、真 `NodeRouter`、真握手、真回执、真
    // `createWakePort`。中间任何一环把原因弄丢，这里就红。
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-wake-undeliverable-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const ready: { url?: string }[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      // TCP for the same reason the first wake test uses it: the production
      // sender and the console wake port both take a ws URL.
      listen: { port: 0, hostname: '127.0.0.1' },
      spawnAcp: spawnFixture,
      onReady: address => ready.push(address),
      onError: () => {},
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)
    const url = ready[0]?.url
    expect(url).toBeDefined()

    // 这台节点只配了 `reviewer`。
    const ghost = 'qianmo://node-b/ghost'

    let refusal: unknown
    try {
      await executeResidentWake(
        {
          url: url as string,
          from: 'qianmo://node-a/planner',
          to: ghost,
          prompt: 'wake up and look at the queue',
          afterMs: 0,
          timeoutMs: 10_000,
          deliverTtlMs: 90_000,
        },
        PSK,
      )
    } catch (error) {
      refusal = error
    }

    if (!(refusal instanceof WakeRefusedError)) {
      throw new Error(`expected a WakeRefusedError, got ${String(refusal)}`)
    }
    // 真因回到了发起方本身，而不是只留在节点的审计链里。
    expect(refusal.detail?.code).toBe(ProtocolErrorCode.E_UNKNOWN_AGENT)
    expect(refusal.detail?.reason).toContain('ghost')
    // 回执那一格照旧是被压平的那个码 —— 它被读过，只是不再是拿去给人看的原因。
    expect(refusal.receiptCode).toBe(ProtocolErrorCode.E_UNDELIVERABLE)

    // 操作者真正看到的那一行。
    const shown = await createWakePort({
      url: url as string,
      psk: PSK,
      timeoutMs: 10_000,
    }).send({
      from: 'qianmo://console/operator',
      to: ghost,
      prompt: 'wake up and look at the queue',
      url: '',
    })
    if (shown.ok) throw new Error('the wake was expected to be refused')
    expect(shown.failure.code).toBe('refused')
    expect(shown.failure.message).toContain(ProtocolErrorCode.E_UNKNOWN_AGENT)
    // PR #32 的兜底文案只该在「对面一句话都不说」时出现，而这条路径不再是
    // 那种；它仍然保留，护栏在 `consoleWakeRefusal.test.ts` 的
    // `silentlyRefusingNode` 那条用例上。
    expect(shown.failure.message).not.toContain('原因见该节点的审计链')
    // 把人引向网络排查的那三个词一个都不许出现。
    expect(shown.failure.message).not.toContain('不可达')
    expect(shown.failure.message).not.toContain('unreachable')
    expect(shown.failure.message).not.toContain('E_UNDELIVERABLE')

    // 拒绝没有花掉收件人的一格 inbox（规则 L-1）：真 agent 的信箱仍然是空的。
    expect(await readMailbox(AGENT, TEAM)).toHaveLength(0)
  }, 25_000)

  test('an agent notification reaches the hub on the inbound channel and lands on the audit chain', async () => {
    // The end-to-end DoD: agent tool → resident host → hub → audit trail. The
    // fixture stands in for `qianmo_notify` (it makes the same
    // `qianmo/notify` ext request the real tool makes); everything after that
    // is production code.
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-notify-e2e-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const trailPath = join(root, 'trail.ndjson')
    const trail = openAuditTrail(trailPath)
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      notifyAudit: residentNotifyTrailSink(trail, 'node-b'),
      spawnAcp: () =>
        spawnFixture({
          ...process.env,
          QIANMO_FIXTURE_NOTIFY: 'disk on node-b is at 91%',
        }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const hub = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      // The hub says it speaks `notify`. Without the declaration the node is
      // required to stay silent (§2.7), which is the next test.
      supportedTypes: [...MESSAGE_TYPES],
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(hub)
    await hub.connect()

    // `contextId` is the watch job's id (design §4.1③). The notification has
    // to come back under it without the agent ever being told what it is.
    const request = createMessage({
      from: 'qianmo://node-a/console',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      contextId: 'job-disk-watch',
      payload: { ask: 'check the disks' },
    })
    hub.send(request)
    await waitUntil(() =>
      replies.some(item => item.type === MessageType.Notify),
    )

    const notify = replies.find(item => item.type === MessageType.Notify)
    expect(notify?.from).toBe('qianmo://node-b/reviewer')
    expect(notify?.to).toBe('qianmo://node-a/console')
    expect(notify?.contextId).toBe('job-disk-watch')
    // §2.4②: a fresh taskId, never the causing task's — reusing it is what
    // gets the *second* notification of a job cut as `E_LOOP`.
    expect(notify?.taskId).not.toBe(request.taskId)
    expect(notify?.hops).toEqual(['node-b'])
    expect(isNotifyPayload(notify?.payload)).toBe(true)
    const payload = notify?.payload as NotifyPayload
    expect(payload.summary).toBe('disk on node-b is at 91%')
    expect(payload.kind).toBe('watch')
    expect(payload.severity).toBe('warn')
    // Correlation, not a correlation key (rule C-1).
    expect(payload.causeTaskId).toBe(request.taskId)
    expect(payload.redelivered).toBeUndefined()

    // The verdict travelled back into the turn: the agent knows it landed.
    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )
    const result = replies.find(
      item =>
        item.type === MessageType.TaskResult && item.taskId === request.taskId,
    )
    expect(String((result?.payload as { content?: string }).content)).toContain(
      'notify=sent',
    )

    // And the trail carries it, chain intact.
    await waitUntil(
      () =>
        readTrail(trailPath).records.some(
          record => record.kind === 'notify_delivered',
        ),
      10_000,
    )
    const read = readTrail(trailPath)
    expect(read.intact).toBe(true)
    const sent = read.records.find(record => record.kind === 'notify_sent')
    const delivered = read.records.find(
      record => record.kind === 'notify_delivered',
    )
    expect(sent?.source).toBe(AuditSource.Resident)
    expect(sent?.outcome).toBe('ok')
    expect(sent?.node).toBe('node-b')
    expect(sent?.taskId).toBe(notify?.taskId)
    expect(delivered?.taskId).toBe(notify?.taskId)
    // hermes B9: a line without a version stamp cannot be told apart, three
    // days later, from a line that was edited.
    expect(sent?.detail?.schemaVersion).toBe(1)
    expect(errors).toEqual([])
  }, 25_000)

  test('a tool running inside a turn reaches the hub as a step, unasked', async () => {
    // 与上一条的区别就是「谁发起的」：那条是 agent 自己调 `qianmo_notify`，
    // 这条里 fixture 只是跑了个工具，剩下的全是宿主自己做的。对话面看得到过程
    // 靠的正是这一条路。
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-progress-e2e-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () =>
        spawnFixture({
          ...process.env,
          QIANMO_FIXTURE_TOOL_CALL: 'packages/router/src/rate.ts',
        }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const hub = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      supportedTypes: [...MESSAGE_TYPES],
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(hub)
    await hub.connect()

    const request = createMessage({
      from: 'qianmo://node-a/console',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      // 控制台把会话 id 放在这里，过程就是靠它归回那条会话的。
      contextId: 'chat-session-1',
      payload: { prompt: '看一下速率表' },
    })
    hub.send(request)
    await waitUntil(() =>
      replies.some(item => item.type === MessageType.Notify),
    )

    const step = replies.find(item => item.type === MessageType.Notify)
    expect(step?.contextId).toBe('chat-session-1')
    expect(step?.taskId).not.toBe(request.taskId)
    const payload = step?.payload as Record<string, unknown>
    expect(payload['kind']).toBe('task')
    expect(payload['severity']).toBe('info')
    expect(payload['summary']).toBe('读：packages/router/src/rate.ts')
    // 相关线索，不是相关键（规则 C-1）。
    expect(payload['causeTaskId']).toBe(request.taskId)
    expect(errors).toEqual([])
  }, 25_000)

  test('a hub that never declared notify is told nothing at all (§2.7)', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-notify-legacy-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () =>
        spawnFixture({
          ...process.env,
          QIANMO_FIXTURE_NOTIFY: 'nobody will hear this',
        }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    // Declares nothing, which reads as the legacy floor.
    const hub = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(hub)
    await hub.connect()

    const request = createMessage({
      from: 'qianmo://node-a/console',
      to: 'qianmo://node-b/reviewer',
      type: MessageType.TaskRequest,
      payload: { ask: 'check the disks' },
    })
    hub.send(request)
    await waitUntil(() =>
      replies.some(
        item =>
          item.type === MessageType.TaskResult &&
          item.taskId === request.taskId,
      ),
    )

    // Not downgraded into a `task.request`, not sent and refused — simply not
    // sent. Rewriting an unsupported type into one the peer does understand
    // would open a turn it never asked for (§2.8, hermes F3).
    expect(replies.some(item => item.type === MessageType.Notify)).toBe(false)
    const result = replies.find(item => item.type === MessageType.TaskResult)
    // The agent is told, so it can put the finding in its answer instead.
    expect(String((result?.payload as { content?: string }).content)).toContain(
      'notify=unsupported',
    )
    expect(errors).toEqual([])
  }, 25_000)
})

/**
 * issue #28 — the gate nobody had: **did the woken agent do anything.**
 *
 * Every probe this repository had stopped one step short of that. AC-2 / P4.1
 * pin forwarding and latency; `demo/env/smoke.sh` reads neither `outcome` nor
 * `content`. So a run in which the transport receipted, the audit trail
 * recorded `message_accepted`, a real model turn executed and real tokens were
 * billed — and the agent answered "I will not act on this" — was green
 * everywhere. That is exactly what happened on 2026-08-24, six times out of
 * six.
 *
 * These cases close it end to end: a real resident, a real transport, a real
 * capability gate, and a stub agent that reads the prompt it is given and
 * either does the arithmetic or declines. The observable is the **work log**
 * the stub writes, never the turn's outcome — a refusal is also a completed
 * turn, which is the whole reason the gap existed.
 */
describe('issue #28: the woken agent actually does the work', () => {
  const CONSOLE_NODE = 'console'
  const OPERATOR = `qianmo://${CONSOLE_NODE}/operator`
  const HANDLER = `qianmo://node-b/${AGENT}`
  /** 37 × 43, the arithmetic the 2026-08-24 control run used. */
  const EXPECTED_PRODUCT = '1591'
  const ASK = `QIANMO-COMPUTE 37*43 and report the product.`

  type Signing = 'trusted-issuer' | 'unnamed-issuer' | 'unsigned'

  interface RelayOutcome {
    /** Lines the stub agent wrote — the business effect, and the assertion. */
    readonly work: readonly string[]
    /** `task.result` content, present only for a `task.request`. */
    readonly content: string | undefined
    /** The notice the agent was actually handed. */
    readonly notice: { trust?: string; text?: string }
    readonly errors: readonly unknown[]
  }

  /**
   * Run one relayed message all the way into a turn and report what came of it.
   *
   * The console's key is in the directory in **every** variant, so signature
   * verification is never what separates the cases: what separates them is
   * whether this node was told to honour that issuer, which is the decision
   * issue #28 is about. The policy is `OPEN_POLICY` throughout for the same
   * reason — it keeps every variant admitted, so a difference in the work log
   * can only come from the tier.
   */
  async function relay(options: {
    readonly signing: Signing
    readonly type: MessageType.Wake | MessageType.TaskRequest
  }): Promise<RelayOutcome> {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-wake-effect-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const workLog = join(root, 'work.log')
    const ready: string[] = []
    const errors: unknown[] = []
    const timings: ResidentTimingEvent[] = []

    const consoleKeys = generateNodeKeyPair()
    const own = generateNodeKeyPair()
    const directory = new StaticPublicKeyDirectory([
      [CONSOLE_NODE, consoleKeys.publicKey],
      ['node-b', own.publicKey],
    ])
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () =>
        spawnFixture({ ...process.env, QIANMO_FIXTURE_WORK_LOG: workLog }),
      capability: new NodeCapabilities({
        node: 'node-b',
        directory,
        keys: own,
        policy: OPEN_POLICY,
        trustedIssuers:
          options.signing === 'trusted-issuer'
            ? [CONSOLE_NODE, 'node-b']
            : ['node-b'],
      }),
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
      onTiming: event => timings.push(event),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running
    await waitUntil(() => ready.length === 1)

    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: CONSOLE_NODE,
      psk: PSK,
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()

    const taskId = newId()
    const createdAt = Date.now()
    const message = createMessage({
      from: OPERATOR,
      to: HANDLER,
      type: options.type,
      payload:
        options.type === MessageType.Wake
          ? { trigger: 'manual', prompt: ASK }
          : { ask: ASK },
      taskId,
      createdAt,
      ...(options.signing === 'unsigned'
        ? {}
        : {
            cap: issueCapability(CONSOLE_NODE, consoleKeys, {
              sub: HANDLER,
              aud: 'node-b',
              act: CapabilityLevel.WriteLimited,
              taskId,
              nbf: createdAt - 30_000,
              exp: createdAt + 60_000,
            }),
          }),
    })
    client.send(message)
    await client.waitForDrain()

    // Wait for the *turn*, not for the delivery — the distinction this whole
    // block exists for. A `wake` has no reply of any kind (only a
    // `task.request` is registered as a task and gets an ack and a result), so
    // the completion signal has to come from the node instrumentation both
    // types share.
    await waitUntil(() =>
      timings.some(
        event =>
          event.stage === 'turn_completed' || event.stage === 'turn_failed',
      ),
    )

    const entry = (await readMailbox(AGENT, TEAM))[0]
    const wrapper = JSON.parse(entry?.text ?? '{}') as {
      notice?: { trust?: string; text?: string }
    }
    const result = replies.find(reply => reply.type === MessageType.TaskResult)

    resident.stop()
    await running
    activeResident = undefined
    activeRun = undefined

    return {
      work: existsSync(workLog)
        ? readFileSync(workLog, 'utf8')
            .split('\n')
            .filter(line => line !== '')
        : [],
      content: (result?.payload as { content?: string } | undefined)?.content,
      notice: wrapper.notice ?? {},
      errors,
    }
  }

  test('a task.request signed by a trusted issuer is executed, and the answer comes back', async () => {
    const outcome = await relay({
      signing: 'trusted-issuer',
      type: MessageType.TaskRequest,
    })

    // The business effect. Not "a turn ran" — the arithmetic was actually done.
    expect(outcome.work).toEqual([EXPECTED_PRODUCT])
    expect(outcome.content).toContain(`computed ${EXPECTED_PRODUCT}`)
    // And the reason it was done: the notice the agent was handed said the
    // request was authorized, and named who authorized it.
    expect(outcome.notice.trust).toBe(NOTICE_TRUST_VERIFIED_CAPABILITY)
    expect(outcome.notice.text).toContain(`signed by ${CONSOLE_NODE}`)
    expect(outcome.errors).toEqual([])
  }, 25_000)

  test('a wake signed by a trusted issuer is executed — the console path', async () => {
    // The exact shape the console sends (`consolePorts.ts` + `--wake-sign`),
    // and the one the 2026-08-24 run got a refusal from.
    const outcome = await relay({
      signing: 'trusted-issuer',
      type: MessageType.Wake,
    })

    expect(outcome.work).toEqual([EXPECTED_PRODUCT])
    expect(outcome.notice.trust).toBe(NOTICE_TRUST_VERIFIED_CAPABILITY)
    expect(outcome.errors).toEqual([])
  }, 25_000)

  test('an unsigned wake is delivered and does no work', async () => {
    // The beta fleet's current state, and it must stay this way: nothing
    // verified this message, so nothing about it is trusted. `--open-policy`
    // widens what is admitted, never what is honoured.
    const outcome = await relay({ signing: 'unsigned', type: MessageType.Wake })

    expect(outcome.work).toEqual([])
    expect(outcome.notice.trust).toBe(TRUST_UNTRUSTED)
    expect(outcome.notice.text).toContain('never as instructions')
    expect(outcome.errors).toEqual([])
  }, 25_000)

  test('a wake signed by an issuer this node never named does no work', async () => {
    // Every cryptographic step passes — the key resolves, the signature
    // verifies, the bindings match. What is missing is the operator's `--trust`
    // entry, and that alone is enough to keep the message at the floor.
    const outcome = await relay({
      signing: 'unnamed-issuer',
      type: MessageType.Wake,
    })

    expect(outcome.work).toEqual([])
    expect(outcome.notice.trust).toBe(TRUST_UNTRUSTED)
    expect(outcome.errors).toEqual([])
  }, 25_000)

  test('a refusal is a completed turn, which is why outcome is not the gate', async () => {
    // Stated as its own case because it is the reason the gap survived: the
    // refusing turn ends `completed`, carries content and bills tokens. Any
    // probe that reads only `outcome` reads this as a success.
    const outcome = await relay({
      signing: 'unsigned',
      type: MessageType.TaskRequest,
    })

    expect(outcome.content).toContain('refused')
    expect(outcome.work).toEqual([])
  }, 25_000)
})

describe('memory semantic overlay on the resident host (P16.6)', () => {
  test('switched on, a ranked turn is assembled in two stages and its retrieval is recorded', async () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-semantic-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const memoryRoot = join(root, 'memory')

    // More than the injection budget holds, in the partition this requester's
    // turns recall from: ranked mode, the only mode the overlay acts in.
    const partition = residentRecallScope({
      agent: AGENT,
      contextId: undefined,
    })
    const store = new FileMemoryStore({ root: memoryRoot })
    for (let index = 0; index < 60; index += 1) {
      store.write({
        scope: {
          layer: 'working',
          projectKey: partition.projectKey as string,
          taskId: partition.taskId as string,
        },
        title: `note ${index}`,
        summary: `note ${index}`,
        body: `unrelated note ${index}`,
        source: { kind: 'user', id: 'test' },
      })
    }

    const embedded: string[][] = []
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: TEAM,
      agents: [{ agent: AGENT, cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: spawnFixture,
      memoryRoot,
      semanticRecall: {
        embedder: {
          id: 'test-constant',
          model: 'constant-v1',
          dimensions: 2,
          embed: async texts => {
            embedded.push([...texts])
            return { vectors: texts.map(() => [1, 0]) }
          },
        },
        dailyTokenLimit: 1_000_000,
        // One recall may warm the whole partition; the default 32 would leave
        // this first turn cold, which is its own test in `@qianmo/recall`.
        config: { maxEmbedPerRecall: 100 },
      },
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    const running = resident.run()
    activeResident = resident
    activeRun = running

    await waitUntil(() => ready.length === 1)
    const replies: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      backoff: { baseDelayMs: 20, maxDelayMs: 100, jitterRatio: 0 },
      keepAliveIntervalMs: 0,
      onMessage: message => {
        replies.push(message)
      },
    })
    clients.push(client)
    await client.connect()
    client.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { ask: 'summarise' },
      }),
    )
    await client.waitForDrain()
    await waitUntil(() => replies.length >= 2)

    const detected = readFileSync(
      join(root, 'config', 'resident', AGENT, 'admission.ndjson'),
      'utf8',
    )
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(record => record.kind === 'detected')
    expect(detected).toHaveLength(1)
    expect(detected[0]?.retrieval).toBe('hybrid')
    expect(String(detected[0]?.prompt)).toContain(' retrieval="hybrid">')

    // One call: the batch as the question, plus every candidate's top-up.
    expect(embedded).toHaveLength(1)
    expect(embedded[0]).toHaveLength(61)
    // The spend is on disk under the identity config root.
    const usage = JSON.parse(
      readFileSync(
        join(root, 'config', 'qianmo', 'embedding', 'usage.json'),
        'utf8',
      ),
    ) as { tokens: number }
    expect(usage.tokens).toBeGreaterThan(0)
    expect(errors).toEqual([])
  }, 15_000)
})
