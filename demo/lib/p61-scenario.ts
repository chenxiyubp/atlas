// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import {
  generateNodeKeyPair,
  NonceStore,
  StaticPublicKeyDirectory,
  issueCapability,
  verifyCapability,
} from '@qianmo/capability'
import { diagnose } from '@qianmo/diagnosis'
import {
  BorrowerNegotiator,
  LenderNegotiator,
  NegotiationAuditLog,
  NegotiationEventType,
} from '@qianmo/negotiation'
import {
  CapabilityLevel,
  LIMITS,
  MessageType,
  createMessage,
  newId,
  type QianmoMessage,
  type ResourceNeed,
} from '@qianmo/protocol'
import { InboundBudget, NodeRouter, RuntimeThrottle } from '@qianmo/router'
import {
  TransportClient,
  pskFromEnv,
  startTransportServer,
  type InboundContext,
  type TransportChannel,
  type TransportServerHandle,
} from '@qianmo/transport'
import {
  TeardownReason,
  TunnelAuditLog,
  TunnelClient,
  TunnelEventType,
  TunnelHost,
} from '@qianmo/tunnel'
import {
  negotiationTrailSink,
  routerTrailSink,
  transportTrailSink,
  tunnelTrailSink,
} from '../../src/services/qianmo/auditTrail.js'
import { arg, emit, intArg } from './cli-args.js'
import {
  combineChunkResults,
  expectedSolution,
  parseModelDataset,
  type ChunkResult,
} from './p61-dataset.js'
import { injectOom } from './p51-inject.js'
import {
  buildP61Report,
  type P61BeatObservation,
  type P61Mode,
  type P61Observations,
} from './p61-report-core.js'

const BORROWER = 'qianmo://node-a/planner'
const LENDER = 'qianmo://node-b/host'
const ORCHESTRATOR = 'qianmo://node-b/orchestrator'
const NODE_A = 'node-a'
const NODE_B = 'node-b'
const CHUNK_SCHEMA = 'qianmo.p61.chunk.v1'
const BACKGROUND_CADENCE_MS = 1_000
const WORKER_TIMEOUT_MS = 30_000

interface ChunkPayload {
  readonly schema: typeof CHUNK_SCHEMA
  readonly chunk: number
  readonly of: number
  readonly iterations: number
  readonly datasetDigest: string
}

interface StoredChunk {
  readonly result: ChunkResult
  readonly pid: number
  readonly completedAt: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`)
  return value
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function summaryOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function payloadKind(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const kind = (value as Record<string, unknown>)['kind']
  return typeof kind === 'string' ? kind : null
}

function parseChunkPayload(value: unknown): ChunkPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('chunk payload must be an object')
  const record = value as Record<string, unknown>
  if (record['schema'] !== CHUNK_SCHEMA)
    throw new TypeError(`chunk schema must be ${CHUNK_SCHEMA}`)
  const chunk = record['chunk']
  const of = record['of']
  const iterations = record['iterations']
  const datasetDigest = record['datasetDigest']
  if (
    !Number.isInteger(chunk) ||
    !Number.isInteger(of) ||
    !Number.isInteger(iterations) ||
    typeof datasetDigest !== 'string' ||
    datasetDigest.length !== 64
  ) {
    throw new TypeError('chunk payload fields are invalid')
  }
  return {
    schema: CHUNK_SCHEMA,
    chunk: Number(chunk),
    of: Number(of),
    iterations: Number(iterations),
    datasetDigest,
  }
}

function parseChunkResult(text: string): ChunkResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new TypeError('worker output must be JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('worker output must be an object')
  const record = value as Record<string, unknown>
  const fields = [
    'chunk',
    'of',
    'start',
    'end',
    'iterations',
    'bestIndex',
    'bestScore',
    'checksum',
  ] as const
  if (!fields.every(field => Number.isInteger(record[field])))
    throw new TypeError('worker output fields must be integers')
  return {
    chunk: Number(record['chunk']),
    of: Number(record['of']),
    start: Number(record['start']),
    end: Number(record['end']),
    iterations: Number(record['iterations']),
    bestIndex: Number(record['bestIndex']),
    bestScore: Number(record['bestScore']),
    checksum: Number(record['checksum']),
  }
}

function route(router: NodeRouter, message: QianmoMessage): QianmoMessage {
  const verdict = router.outbound(message)
  if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`)
  return verdict.message
}

function requirePersistentChannel(): TransportChannel {
  if (persistentChannel === null)
    throw new Error('node A has no persistent reply channel')
  return persistentChannel
}

async function redialFails(socket: string, psk: string): Promise<boolean> {
  if (!existsSync(socket)) return true
  const probe = new TransportClient({
    endpoint: { unix: socket },
    node: 'p61-probe',
    psk,
    keepAliveIntervalMs: 0,
    backoff: { giveUpAfterMs: 0 },
  })
  try {
    await probe.connect(500)
    return false
  } catch {
    return true
  } finally {
    await probe.close()
  }
}

async function waitForRedialFailure(
  socket: string,
  psk: string,
): Promise<boolean> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await redialFails(socket, psk)) return true
    await delay(25)
  }
  return redialFails(socket, psk)
}

/**
 * PATH 里那个 `node` 的版本——即帧 2 真正用来撑爆 32 MB heap 的那一个。
 *
 * 不能用 `process.version`：runner 跑在 Bun 上，Bun 也会给出一个 node 兼容版本号，
 * 那是本进程的谎话而不是子进程的事实。问不到就留空串。
 */
async function nodeVersion(): Promise<string> {
  try {
    const child = Bun.spawn(['node', '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [exitCode, text] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ])
    return exitCode === 0 ? text.trim() : ''
  } catch {
    return ''
  }
}

const modeValue = arg('mode') ?? 'acceptance'
if (modeValue !== 'smoke' && modeValue !== 'acceptance')
  throw new Error('--mode must be smoke or acceptance')
const mode: P61Mode = modeValue
const minutes = positiveInteger(
  intArg('minutes', mode === 'acceptance' ? 10 : 1),
  'minutes',
)
if (mode === 'acceptance' && minutes < 10)
  throw new Error('acceptance mode requires --minutes of at least 10')
const chunks = positiveInteger(
  intArg('chunks', mode === 'acceptance' ? 20 : 4),
  'chunks',
)
if (chunks < 2) throw new Error('--chunks must be at least 2')
const iterations = positiveInteger(intArg('iterations', 3), 'iterations')
const requiredDurationMs = minutes * 60_000
const datasetPath = resolve(
  arg('dataset') ??
    process.env['QIANMO_P61_DATASET'] ??
    join(import.meta.dir, '..', 'p61-data', 'model-input.json'),
)
if (/\0|\r|\n/.test(datasetPath))
  throw new Error('dataset path must not contain control characters')
const psk = pskFromEnv()
/**
 * 非空即生效：成功也保留运行目录。
 *
 * 默认「成功清理」把正式三轮的现场一起清掉了，事后只剩 stdout 上那行 JSON；
 * 要留证据就靠这个开关，而不是靠把某一轮跑红。
 */
const keepArtifacts = (process.env['QIANMO_P61_KEEP_ARTIFACTS'] ?? '') !== ''

const runDir = mkdtempSync(join(tmpdir(), 'qianmo-p61-'))
const resultDir = join(runDir, 'results')
const taskSocket = join(runDir, 'node-a.sock')
const tunnelSocket = join(runDir, 'tunnel.sock')
const auditPath = join(runDir, 'audit.ndjson')
mkdirSync(resultDir, { recursive: true, mode: 0o700 })

const datasetText = readFileSync(datasetPath, 'utf8')
const dataset = parseModelDataset(JSON.parse(datasetText) as unknown)
if (chunks > dataset.candidates.length)
  throw new Error('--chunks cannot exceed the dataset row count')
const datasetDigest = createHash('sha256').update(datasetText).digest('hex')
const expected = expectedSolution(dataset, chunks, iterations)
const taskId = newId()
const requested: ResourceNeed = {
  durationMs: requiredDurationMs + 60_000,
  cpuCores: 1,
  memoryMb: 512,
}
const zeroNeed: ResourceNeed = { durationMs: 0, cpuCores: 0, memoryMb: 0 }
const trail = new AuditTrail(auditPath)
const beats: P61BeatObservation[] = []
const failures: Array<{
  at: number
  summary: string
  boundary: string | null
}> = []
const stored = new Map<number, StoredChunk>()
let state = 'preparing'
let startedAt = 0
let durationMs = 0
let persistentServer: TransportServerHandle | null = null
let persistentClient: TransportClient | null = null
let persistentChannel: TransportChannel | null = null
let tunnelHost: TunnelHost | null = null
let tunnelClient: TunnelClient | null = null
let backgroundRunning = false
let backgroundPromise: Promise<void> | null = null
let backgroundSequence = 0
let backgroundDelivered = 0
let backgroundDeliveredAfterTeardown = 0
let tunnelTornDown = false
let granted: ResourceNeed = zeroNeed
let offerId = ''
let leased = false
let released = false
let authorized = false
let mintedCapability = ''
let tokenVerified = false
let tokenAct = ''
let diagnosisCause = ''
let diagnosisConfidence = ''
let diagnosisEvidence: readonly string[] = []
let workerOks = 0
let resultDigest = ''
let computeSpanMs = 0
let redialFailed = false
let lenderPending = 0
let openedClosedBalanced = false
let closedReason: string | null = null
let uncaught = 0
let reportWritten = false

/**
 * 计划要发的块，和真正发出去的块。
 *
 * 两个集合的差就是本轮 `skipped`。派发循环中途抛错会把控制权交给外层 catch，
 * 剩下的块一条也发不出去——那正是「计划了没做成」，必须让它自己冒出来。
 */
const plannedChunks: readonly number[] = Array.from(
  { length: chunks },
  (_, index) => index,
)
const dispatchedChunks = new Set<number>()

/**
 * 未捕获异常的真实计数。
 *
 * 判据 `background.uncaught === 0` 只有在处理器真的装上时才是一次观测，所以它
 * 注册在任何 socket、子进程和定时器之前，覆盖整个场景生命周期。装了处理器等于
 * 关掉运行时的默认崩溃，因此每一条都要立刻写 stderr，不能只攒在计数器里。
 */
function noteUncaught(label: string, value: unknown): void {
  uncaught += 1
  process.stderr.write(`p61-scenario: ${label}: ${String(value)}\n`)
  // 报告写完之后再来的一条进不了 observations，只能在这里直接改判退出码——
  // 否则它会被那份「pass=true」的报告盖过去。
  if (reportWritten) process.exitCode = 1
}

process.on('uncaughtException', error => {
  noteUncaught('uncaught exception', error)
})
process.on('unhandledRejection', reason => {
  noteUncaught('unhandled rejection', reason)
})

const keys = generateNodeKeyPair()
const directory = new StaticPublicKeyDirectory([[NODE_B, keys.publicKey]])
const borrowerAudit = new NegotiationAuditLog(
  512,
  negotiationTrailSink(trail, NODE_A),
)
const lenderAudit = new NegotiationAuditLog(
  512,
  negotiationTrailSink(trail, NODE_B),
)
const tunnelAudit = new TunnelAuditLog(512, tunnelTrailSink(trail, NODE_B))
const routerA = new NodeRouter({
  node: NODE_A,
  auditSink: routerTrailSink(trail, NODE_A),
  budget: new InboundBudget({ perMinute: LIMITS.ratePerMinute }),
})
const routerB = new NodeRouter({
  node: NODE_B,
  auditSink: routerTrailSink(trail, NODE_B),
  throttle: new RuntimeThrottle({
    capacity: LIMITS.ratePerMinute,
    windowMs: 60_000,
  }),
})

const borrower = new BorrowerNegotiator({
  address: BORROWER,
  audit: borrowerAudit,
  policy: { minimum: { durationMs: 60_000, cpuCores: 1, memoryMb: 256 } },
  newTaskId: () => taskId,
})
const lender = new LenderNegotiator({
  address: LENDER,
  audit: lenderAudit,
  policy: {
    ceiling: requested,
    offerTtlMs: 30_000,
    maxConcurrentLeases: 1,
  },
  authorize: request => {
    authorized =
      request.borrower === BORROWER &&
      request.need.durationMs <= requested.durationMs &&
      request.need.cpuCores <= requested.cpuCores &&
      request.need.memoryMb <= requested.memoryMb
    trail.append({
      at: Date.now(),
      source: AuditSource.Capability,
      kind: 'p61.user-authorized',
      outcome: authorized ? 'ok' : 'refused',
      taskId,
      node: NODE_B,
      peer: NODE_A,
      detail: { mode: 'scripted-hook' },
    })
    return authorized
  },
  mintCapability: offer => {
    mintedCapability = issueCapability(NODE_B, keys, {
      sub: LENDER,
      aud: NODE_B,
      act: CapabilityLevel.UserConfirmed,
      taskId: offer.taskId,
      nbf: Date.now() - 1_000,
      exp: offer.expiresAt,
    })
    return mintedCapability
  },
})

function recordFailure(error: unknown, boundary: string | null = state): void {
  failures.push({ at: Date.now(), summary: summaryOf(error), boundary })
}

async function sendBackground(): Promise<void> {
  const client = persistentClient
  if (client === null) throw new Error('persistent client is not available')
  backgroundSequence += 1
  const message = createMessage({
    from: ORCHESTRATOR,
    to: BORROWER,
    type: MessageType.TaskRequest,
    taskId: newId(),
    payload: { kind: 'p61-background', sequence: backgroundSequence },
  })
  await client.sendAndWait(route(routerB, message), 5_000)
}

async function runBackground(): Promise<void> {
  while (backgroundRunning) {
    try {
      await sendBackground()
    } catch (error) {
      if (backgroundRunning) recordFailure(error, 'background')
      backgroundRunning = false
      return
    }
    if (backgroundRunning) await delay(BACKGROUND_CADENCE_MS)
  }
}

async function handleNodeA(
  message: QianmoMessage,
  context: InboundContext,
): Promise<void> {
  const verdict = routerA.inbound(message)
  if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`)
  persistentChannel = context.channel
  if (message.type === MessageType.TaskRequest) {
    const kind = payloadKind(message.payload)
    if (kind === 'p61-background') {
      backgroundDelivered += 1
      if (tunnelTornDown) backgroundDeliveredAfterTeardown += 1
      return
    }
    if (kind !== 'p61-model') throw new Error('unknown P6.1 task payload')
    trail.append({
      at: Date.now(),
      source: AuditSource.Resident,
      kind: 'p61.task-submitted',
      outcome: 'ok',
      taskId: message.taskId,
      msgId: message.msgId,
      traceId: message.traceId,
      node: NODE_A,
      peer: NODE_B,
      detail: { seed: dataset.seed, datasetDigest },
    })
    return
  }
  if (message.type === MessageType.ResourceOffer) {
    const handled = borrower.handle(message)
    if (handled.reply !== undefined) {
      await context.channel.sendAndWait(route(routerA, handled.reply), 10_000)
    }
    return
  }
  if (message.type === MessageType.ResourceRelease) {
    borrower.handle(message)
  }
}

async function handleNodeB(
  message: QianmoMessage,
  context: InboundContext,
): Promise<void> {
  const verdict = routerB.inbound(message)
  if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`)
  if (
    message.type !== MessageType.ResourceRequest &&
    message.type !== MessageType.ResourceGrant &&
    message.type !== MessageType.ResourceRelease
  ) {
    throw new Error(
      `node B cannot handle ${message.type} on the persistent link`,
    )
  }
  const handled = lender.handle(message)
  if (handled.reply !== undefined) {
    await context.channel.sendAndWait(route(routerB, handled.reply), 10_000)
  }
}

/**
 * worker 子进程的入口 —— 与本文件**同一种形态**的那一份。
 *
 * 这里不能写死 `p61-worker.ts`。本文件有两种跑法：开发检出上是 `demo/lib/p61-scenario.ts`
 * （旁边确实有 `p61-worker.ts`），而在投出去的机器上跑的是构建产物
 * `dist/demo/p61-scenario.js`（旁边只有 `p61-worker.js`，没有 `.ts`，也没有
 * node_modules 让它解析 `@qianmo/*`）。写死扩展名等于让这个场景只在开发机上跑得通。
 *
 * 规则与 shell 那边的 `demo_entry`（demo/lib/entry.sh）是同一条：先产物，后源文件。
 */
function workerEntry(): string {
  const bundled = join(import.meta.dir, 'p61-worker.js')
  return existsSync(bundled) ? bundled : join(import.meta.dir, 'p61-worker.ts')
}

async function runWorker(message: QianmoMessage): Promise<void> {
  const payload = parseChunkPayload(message.payload)
  if (
    payload.chunk < 0 ||
    payload.chunk >= chunks ||
    payload.of !== chunks ||
    payload.iterations !== iterations ||
    payload.datasetDigest !== datasetDigest
  ) {
    throw new Error(`chunk ${payload.chunk} does not match the run contract`)
  }
  if (stored.has(payload.chunk))
    throw new Error(`chunk ${payload.chunk} was delivered more than once`)

  const child = Bun.spawn(
    [
      process.execPath,
      workerEntry(),
      '--dataset',
      datasetPath,
      '--chunk',
      String(payload.chunk),
      '--of',
      String(payload.of),
      '--iterations',
      String(payload.iterations),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, WORKER_TIMEOUT_MS)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timeout)
  if (timedOut) throw new Error(`worker ${payload.chunk} timed out`)
  if (exitCode !== 0)
    throw new Error(
      `worker ${payload.chunk} exited ${exitCode}: ${stderr.trim()}`,
    )
  const result = parseChunkResult(stdout.trim())
  if (
    result.chunk !== payload.chunk ||
    result.of !== payload.of ||
    result.iterations !== payload.iterations
  ) {
    throw new Error(`worker ${payload.chunk} returned the wrong contract`)
  }
  const completedAt = Date.now()
  const storedChunk: StoredChunk = {
    result,
    pid: child.pid,
    completedAt,
  }
  const temporary = join(resultDir, `.chunk-${payload.chunk}-${child.pid}.tmp`)
  const destination = join(resultDir, `chunk-${payload.chunk}.json`)
  writeFileSync(
    temporary,
    `${JSON.stringify({ taskId, datasetDigest, ...storedChunk })}\n`,
    { mode: 0o600 },
  )
  renameSync(temporary, destination)
  stored.set(payload.chunk, storedChunk)
  workerOks += 1
  trail.append({
    at: completedAt,
    source: AuditSource.Resident,
    kind: 'p61.chunk-completed',
    outcome: 'ok',
    taskId,
    node: NODE_B,
    peer: NODE_A,
    detail: {
      chunk: payload.chunk,
      pid: child.pid,
      start: result.start,
      end: result.end,
    },
  })
}

async function cleanupStep(
  boundary: string,
  cleanup: () => Promise<void> | void,
): Promise<void> {
  try {
    await cleanup()
  } catch (error) {
    recordFailure(error, boundary)
  }
}

// 在计时窗口之外采集：`startedAt` 要等帧 1 的提交被接受才起跳。
const versions = { bun: Bun.version, node: await nodeVersion() }

try {
  persistentServer = startTransportServer({
    psk,
    unix: taskSocket,
    onMessage: handleNodeA,
    events: transportTrailSink(trail, NODE_A),
  })
  persistentClient = new TransportClient({
    endpoint: { unix: taskSocket },
    node: NODE_B,
    peerNode: NODE_A,
    psk,
    onMessage: handleNodeB,
    events: transportTrailSink(trail, NODE_B),
  })
  await persistentClient.connect(5_000)

  backgroundRunning = true
  backgroundPromise = runBackground()
  while (backgroundDelivered === 0 && failures.length === 0) await delay(10)
  if (failures.length > 0) throw new Error('background traffic did not start')

  state = 'submitting'
  startedAt = Date.now()
  const task = createMessage({
    from: ORCHESTRATOR,
    to: BORROWER,
    type: MessageType.TaskRequest,
    taskId,
    taskTtlMs: requested.durationMs,
    payload: {
      kind: 'p61-model',
      seed: dataset.seed,
      datasetDigest,
      rows: dataset.candidates.length,
      features: dataset.target.length,
    },
  })
  await persistentClient.sendAndWait(route(routerB, task), 5_000)
  beats.push({ beat: 1, at: Date.now(), ok: true })

  state = 'diagnosing'
  const injected = await injectOom('node')
  const diagnosis = diagnose(injected.observation, { at: Date.now(), taskId })
  diagnosisCause = diagnosis.cause
  diagnosisConfidence = diagnosis.confidence
  diagnosisEvidence = diagnosis.evidence
  if (diagnosis.cause !== 'oom' || diagnosis.evidence.length === 0)
    throw new Error(`expected OOM diagnosis, got ${diagnosis.cause}`)
  trail.append({
    at: diagnosis.at,
    source: AuditSource.Diagnosis,
    kind: diagnosis.schema,
    outcome: 'ok',
    taskId,
    node: NODE_A,
    detail: {
      cause: diagnosis.cause,
      confidence: diagnosis.confidence,
      evidence: diagnosis.evidence.join('; ').slice(0, 1_024),
      runtime: 'node',
    },
  })
  beats.push({ beat: 2, at: Date.now(), ok: true })

  state = 'negotiating'
  const opened = borrower.request(
    LENDER,
    requested,
    'complete the model after OOM',
  )
  if (opened.taskId !== taskId)
    throw new Error('negotiation changed the task ID')
  const channel = requirePersistentChannel()
  await channel.sendAndWait(route(routerA, opened.message), 10_000)
  const lease = borrower.lease(taskId)
  if (
    lease?.state !== 'held' ||
    lease.offerId === undefined ||
    lease.granted === undefined ||
    lease.capability === undefined
  ) {
    throw new Error('negotiation did not produce a usable lease')
  }
  const reservation = lender.reservation(lease.offerId)
  if (reservation?.state !== 'leased')
    throw new Error('lender did not enter the leased state')
  offerId = lease.offerId
  granted = lease.granted
  leased = true
  beats.push({ beat: 3, at: Date.now(), ok: true })

  const verified = verifyCapability(lease.capability, {
    node: NODE_B,
    handler: LENDER,
    taskId,
    now: Date.now(),
    directory,
    nonces: new NonceStore(),
  })
  tokenVerified = verified.ok
  tokenAct = verified.ok ? verified.claims.act : ''
  if (!verified.ok)
    throw new Error(`capability verification failed: ${verified.reason}`)
  if (lease.capability !== mintedCapability)
    throw new Error('the lease did not carry the lender-minted capability')

  state = 'tunneling'
  tunnelHost = new TunnelHost({
    offerId,
    taskId,
    borrower: BORROWER,
    psk,
    capability: lease.capability,
    leaseMs: granted.durationMs,
    unix: tunnelSocket,
    audit: tunnelAudit,
    onWork: runWorker,
  })
  tunnelHost.start()
  tunnelClient = new TunnelClient({
    address: BORROWER,
    node: NODE_A,
    psk,
    endpoint: { unix: tunnelSocket },
    taskId,
    lender: LENDER,
    capability: lease.capability,
    audit: tunnelAudit,
  })
  await tunnelClient.connect(5_000)
  beats.push({ beat: 4, at: Date.now(), ok: true })

  state = 'computing'
  const firstOffset = Math.floor(requiredDurationMs * 0.05)
  const lastOffset = Math.floor(requiredDurationMs * 0.9)
  for (const chunk of plannedChunks) {
    const target =
      startedAt +
      firstOffset +
      Math.floor(((lastOffset - firstOffset) * chunk) / (chunks - 1))
    await delay(target - Date.now())
    await tunnelClient.send(
      {
        schema: CHUNK_SCHEMA,
        chunk,
        of: chunks,
        iterations,
        datasetDigest,
      } satisfies ChunkPayload,
      WORKER_TIMEOUT_MS + 5_000,
    )
    // 只有 receipt 回来了才算派发过：send 抛出时这一句不执行，这块留在差集里。
    dispatchedChunks.add(chunk)
  }
  const orderedStored = [...stored.values()].sort(
    (left, right) => left.result.chunk - right.result.chunk,
  )
  const combined = combineChunkResults(orderedStored.map(entry => entry.result))
  resultDigest = combined.digest
  const firstCompleted = orderedStored.at(0)?.completedAt ?? 0
  const lastCompleted = orderedStored.at(-1)?.completedAt ?? 0
  computeSpanMs = Math.max(0, lastCompleted - firstCompleted)
  if (
    combined.bestIndex !== expected.bestIndex ||
    combined.bestScore !== expected.bestScore ||
    combined.digest !== expected.digest
  ) {
    throw new Error('borrowed computation differs from the expected solution')
  }
  beats.push({ beat: 5, at: Date.now(), ok: true })

  await delay(startedAt + requiredDurationMs - Date.now())
  state = 'releasing'
  const release = borrower.release(taskId, 'completed')
  if (release === undefined)
    throw new Error('borrower did not produce a release')
  await channel.sendAndWait(route(routerA, release), 10_000)
  released = lender.pending === 0
  tunnelHost.close(TeardownReason.Released)
  await tunnelClient.close()
  redialFailed = await waitForRedialFailure(tunnelSocket, psk)
  tunnelTornDown = true
  await sendBackground()
  lenderPending = lender.pending
  openedClosedBalanced =
    tunnelAudit.count(TunnelEventType.Opened) ===
    tunnelAudit.count(TunnelEventType.Closed)
  closedReason = tunnelHost.closedBecause
  if (!redialFailed) throw new Error('tunnel still answered after release')
  if (!released || lenderPending !== 0)
    throw new Error('lease remained pending after release')
  beats.push({ beat: 6, at: Date.now(), ok: true })
  state = 'done'
} catch (error) {
  recordFailure(error)
  state = 'failed'
} finally {
  if (state !== 'done') lenderPending = lender.pending
  backgroundRunning = false
  if (backgroundPromise !== null)
    await cleanupStep(
      'cleanup.background',
      () => backgroundPromise as Promise<void>,
    )
  await cleanupStep('cleanup.tunnel-host', () => {
    tunnelHost?.close(
      released ? TeardownReason.Released : TeardownReason.Withdrawn,
    )
  })
  await cleanupStep('cleanup.tunnel-client', async () => {
    await tunnelClient?.close()
  })
  await cleanupStep('cleanup.negotiation', () => {
    borrower.close()
    lender.close()
  })
  await cleanupStep('cleanup.persistent-client', async () => {
    await persistentClient?.close()
  })
  await cleanupStep('cleanup.persistent-server', async () => {
    await persistentServer?.stop()
  })
  trail.close()
}

durationMs = startedAt === 0 ? 0 : Date.now() - startedAt
openedClosedBalanced =
  tunnelAudit.count(TunnelEventType.Opened) ===
  tunnelAudit.count(TunnelEventType.Closed)
closedReason = tunnelHost?.closedBecause ?? closedReason
const trailRead = readTrail(auditPath)
const trailCounts: Record<string, number> = {}
for (const record of trailRead.records)
  trailCounts[record.kind] = (trailCounts[record.kind] ?? 0) + 1
// 计划集合减实际派发记录。全绿的一轮里它恒为空，但那是差集算出来的空。
const stoppedAt = failures.at(0)?.boundary ?? state
const skipped = plannedChunks
  .filter(chunk => !dispatchedChunks.has(chunk))
  .map(chunk => ({
    what: `chunk ${chunk} of ${chunks}`,
    reason: `planned but never dispatched; the run stopped at ${stoppedAt}`,
  }))
const observations: P61Observations = {
  mode,
  startedAt,
  durationMs,
  requiredDurationMs,
  seed: dataset.seed,
  taskId,
  versions,
  beats,
  diagnosis: {
    cause: diagnosisCause,
    confidence: diagnosisConfidence,
    evidence: diagnosisEvidence,
    runtime: 'node',
  },
  negotiation: { leased, requested, granted, offerId },
  authorization: {
    mode: 'scripted-hook',
    authorized,
    minted: mintedCapability.length > 0,
    tokenVerified,
    act: tokenAct,
  },
  tunnel: {
    takenWork: tunnelHost?.carried ?? 0,
    closedReason,
  },
  compute: {
    chunks,
    completed: stored.size,
    workerOks,
    spanMs: computeSpanMs,
    resultDigest,
    expectedDigest: expected.digest,
  },
  teardown: {
    redialFailed,
    lenderPending,
    released,
    openedClosedBalanced,
  },
  background: {
    delivered: backgroundDelivered,
    deliveredAfterTeardown: backgroundDeliveredAfterTeardown,
    uncaught,
  },
  trail: { intact: trailRead.intact, counts: trailCounts },
  failures,
  skipped,
}
const report = buildP61Report(observations)
writeFileSync(
  join(runDir, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  {
    mode: 0o600,
  },
)
emit({ ...report })
reportWritten = true
if (!report.pass) {
  process.stderr.write(`p61-scenario: evidence retained at ${runDir}\n`)
} else if (keepArtifacts) {
  process.stdout.write(
    `p61-scenario: QIANMO_P61_KEEP_ARTIFACTS is set, evidence kept at ${runDir}\n`,
  )
} else {
  rmSync(runDir, { recursive: true, force: true })
}
process.exitCode = report.pass ? 0 : 1
