// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 AC-3 一键复现 —— 防循环与两层限流，跑在真 transport 上。
 *
 *   QIANMO_TRANSPORT_PSK=... bun run demo/lib/ac3-loop-rate.ts
 *
 * 四个场景，各起一对**全新节点**（否则前一个场景花掉的入站预算会算到后一个
 * 头上，报告就成了看运气）：
 *
 *   ① A→B→A 回环 —— 期望在**首次回访**同一处理者地址 + 同一任务标识时切断；
 *   ② 合法 spiral —— 同一节点、不同处理者地址，期望正常投递；
 *   ③ 运行时层令牌桶 —— 第 21 条本地被拒，**不上线**；换个目标立刻放行；
 *   ④ 协议层入站预算 —— 按 `LIMITS.ratePerMinute` 在接收节点拒；发送方**换用
 *      多个 agent 名字**，用来证明这一层按**节点**计，多开名字不多拿配额。
 *      一条接一条发到第一次被拒为止，并记下突发用时——桶是连续补充的，判据按
 *      用时算「顶」，不假设机器快到能在一个回补间隔里发完整段突发。
 *
 * 判据由 `ac3-report-core.ts` 合成，退出码即结论。报告里不含 PSK、不含 socket
 * 路径以外的部署信息，正文只留计数与错误码。
 *
 * 走 unix socket 而不是 TCP：两个 server 绑同一端口在 Linux 上不报错、且会
 * 非确定性分流（roadmap P2.2 测试口径）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ErrorPayload,
  LIMITS,
  MessageType,
  type QianmoMessage,
  createMessage,
  errorReply,
} from '@qianmo/protocol'
import {
  E_RUNTIME_THROTTLED,
  NodeRouter,
  RUNTIME_RATE,
  RouterEventType,
} from '@qianmo/router'
import {
  TransportClient,
  TransportReceiptError,
  pskFromEnv,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import { emit } from './cli-args.js'
import { buildAc3Report, type Ac3Observations } from './ac3-report-core.js'

const PSK = pskFromEnv()
const NODE_A = 'node-a'
const NODE_B = 'node-b'
const PLANNER = `qianmo://${NODE_A}/planner`
const ARCHIVIST = `qianmo://${NODE_A}/archivist`
const REVIEWER = `qianmo://${NODE_B}/reviewer`
const AUDITOR = `qianmo://${NODE_B}/auditor`

const root = mkdtempSync(join(tmpdir(), 'qianmo-ac3-'))
const closers: Array<() => Promise<void> | void> = []
let sockets = 0

interface Node {
  readonly name: string
  readonly router: NodeRouter
  readonly server: TransportServerHandle
  readonly socket: string
  readonly delivered: QianmoMessage[]
}

/** 一个节点：transport server + 路由层闸门，处理器只记账不干活。 */
function startNode(name: string): Node {
  const router = new NodeRouter({ node: name })
  const delivered: QianmoMessage[] = []
  const socket = join(root, `${name}-${(sockets += 1)}.sock`)
  const server = startTransportServer({
    psk: PSK,
    unix: socket,
    onMessage: (message, context) => {
      const verdict = router.inbound(message)
      if (!verdict.ok) {
        // 与 activator / resident 生产路径同形：先把 error 信封原路发回，再抛
        // 出去让 transport 回 rejected 回执并撤掉去重项。
        context.channel.send(errorReply(message, verdict.code, verdict.reason))
        throw new Error(`${verdict.code}: ${verdict.reason}`)
      }
      delivered.push(message)
    },
  })
  closers.push(() => server.stop())
  return { name, router, server, socket, delivered }
}

async function dial(
  node: string,
  target: Node,
  replies: QianmoMessage[],
): Promise<TransportClient> {
  const client = new TransportClient({
    endpoint: { unix: target.socket },
    node,
    psk: PSK,
    keepAliveIntervalMs: 0,
    onMessage: message => {
      replies.push(message)
    },
  })
  closers.push(() => client.close())
  await client.connect(5_000)
  return client
}

function taskRequest(input: {
  from: string
  to: string
  taskId: string
  traceId?: string
  hops?: readonly string[]
}): QianmoMessage {
  return createMessage({
    from: input.from,
    to: input.to,
    type: MessageType.TaskRequest,
    payload: { ask: 'ac3 probe' },
    taskId: input.taskId,
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.hops === undefined ? {} : { hops: input.hops }),
  })
}

interface SendOutcome {
  readonly sent: boolean
  /** 本地被路由层拒（没上线）时的码。 */
  readonly localCode?: string
  /** 上线后被接收方拒时的回执码。 */
  readonly receiptCode?: string
}

/** 出站也走闸门：起始播种 hops[0] 与判环键，顺带过运行时令牌桶。 */
async function send(
  router: NodeRouter,
  client: TransportClient,
  message: QianmoMessage,
): Promise<SendOutcome> {
  const routed = router.outbound(message)
  if (!routed.ok) return { sent: false, localCode: String(routed.code) }
  try {
    await client.sendAndWait(routed.message, 10_000)
    return { sent: true }
  } catch (error) {
    if (error instanceof TransportReceiptError) {
      return { sent: true, receiptCode: String(error.receiptCode ?? '') }
    }
    throw error
  }
}

function errorCodeOf(reply: QianmoMessage | undefined): string | undefined {
  if (reply === undefined || reply.type !== MessageType.Error) return undefined
  return (reply.payload as ErrorPayload).code
}

function traceIdSegment(traceparent: string): string {
  return traceparent.split('-')[1] ?? traceparent
}

/** 场景 ① + ②：A→B→A 回环与它的审计事件。 */
async function runLoop(): Promise<Ac3Observations['loop']> {
  const nodeA = startNode(NODE_A)
  const nodeB = startNode(NODE_B)
  const repliesToB: QianmoMessage[] = []
  const aToB = await dial(NODE_A, nodeB, [])
  const bToA = await dial(NODE_B, nodeA, repliesToB)

  const task = taskRequest({ from: PLANNER, to: REVIEWER, taskId: 'ac3-loop' })
  const first = await send(nodeA.router, aToB, task)
  const firstHop = nodeB.delivered[0]

  // B 侧的「坏智能体」：把同一个任务标识原样甩回它的来源处理者。
  const bounce = taskRequest({
    from: REVIEWER,
    to: PLANNER,
    taskId: 'ac3-loop',
    traceId: task.traceId,
    hops: firstHop?.hops ?? [],
  })
  const bounced = await send(nodeB.router, bToA, bounce)
  const events = nodeA.router.audit.of(RouterEventType.LoopDetected)
  const detail = events[0]?.detail ?? {}
  const auditedTrace = String(detail['traceId'] ?? '')

  return {
    firstHopDelivered: first.sent && first.receiptCode === undefined,
    bounceRejected: bounced.receiptCode !== undefined,
    bounceHandlerSkipped: nodeA.delivered.length === 0,
    ...(errorCodeOf(repliesToB.at(-1)) === undefined
      ? {}
      : { replyCode: errorCodeOf(repliesToB.at(-1)) }),
    hopCountAtCut: Number(detail['hopCount'] ?? -1),
    maxHops: LIMITS.maxHops,
    loopEvents: events.length,
    traceChainMatches:
      auditedTrace !== '' &&
      traceIdSegment(auditedTrace) === traceIdSegment(task.traceId),
    ...(typeof detail['hops'] === 'string' ? { hopPath: detail['hops'] } : {}),
    ...(typeof detail['to'] === 'string'
      ? { loopKeyHandler: detail['to'] }
      : {}),
    ...(typeof detail['taskId'] === 'string'
      ? { loopKeyTaskId: detail['taskId'] }
      : {}),
  }
}

/** 场景 ③：同一节点、不同处理者地址 —— 合法 spiral，不该被判环。 */
async function runSpiral(): Promise<Ac3Observations['spiral']> {
  const nodeA = startNode(NODE_A)
  const nodeB = startNode(NODE_B)
  const aToB = await dial(NODE_A, nodeB, [])
  const bToA = await dial(NODE_B, nodeA, [])

  const task = taskRequest({
    from: PLANNER,
    to: REVIEWER,
    taskId: 'ac3-spiral',
  })
  await send(nodeA.router, aToB, task)
  const firstHop = nodeB.delivered[0]
  await send(
    nodeB.router,
    bToA,
    taskRequest({
      from: REVIEWER,
      to: ARCHIVIST,
      taskId: 'ac3-spiral',
      ...(firstHop === undefined ? {} : { traceId: firstHop.traceId }),
      hops: firstHop?.hops ?? [],
    }),
  )

  const delivered = nodeA.delivered[0]
  return {
    delivered: nodeA.delivered.length === 1,
    ...(delivered === undefined ? {} : { handler: delivered.to }),
    loopEvents: nodeA.router.audit.count(RouterEventType.LoopDetected),
  }
}

/** 场景 ④ 上半：运行时层令牌桶（单发送方对单目标）。 */
async function runRuntimeThrottle(): Promise<Ac3Observations['runtime']> {
  const nodeB = startNode(NODE_B)
  const nodeA = new NodeRouter({ node: NODE_A })
  const client = await dial(NODE_A, nodeB, [])

  let allowed = 0
  let refusedCode: string | undefined
  for (let index = 0; index < RUNTIME_RATE.capacity + 1; index += 1) {
    const outcome = await send(
      nodeA,
      client,
      taskRequest({ from: PLANNER, to: REVIEWER, taskId: `rt-${index}` }),
    )
    if (outcome.sent && outcome.receiptCode === undefined) allowed += 1
    else refusedCode = outcome.localCode ?? outcome.receiptCode
  }
  const deliveredAfterRefusal = nodeB.delivered.length

  // 同一个发送方、另一个目标地址：这一层是「对单目标」，所以立刻放行。
  const other = await send(
    nodeA,
    client,
    taskRequest({ from: PLANNER, to: AUDITOR, taskId: 'rt-other' }),
  )

  return {
    capacity: RUNTIME_RATE.capacity,
    windowMs: RUNTIME_RATE.windowMs,
    allowed,
    ...(refusedCode === undefined ? {} : { refusedCode }),
    refusedStayedLocal:
      refusedCode === E_RUNTIME_THROTTLED &&
      deliveredAfterRefusal === RUNTIME_RATE.capacity,
    otherTargetAllowed: other.sent && other.receiptCode === undefined,
    noProtocolEvent: nodeA.audit.count(RouterEventType.RateLimited) === 0,
  }
}

/**
 * 场景 ④ 下半的发送上限：发到两倍配额还没被拒就停手判红。走到这一步只有两种
 * 可能——限流器坏了（比如按 agent 而不是按节点计），或者这台机器每条消息都慢过
 * 一个回补间隔（≥ 100 ms/条，令牌回得比花得快，永远到不了顶）——两种情况都该
 * 判红，报告里的 `sent` / `burstElapsedMs` 足够让人分辨是哪一种。
 */
const BUDGET_BURST_CAP = LIMITS.ratePerMinute * 2

/** 场景 ④ 下半：协议层入站预算（接收节点对单发送节点）。 */
async function runInboundBudget(): Promise<Ac3Observations['budget']> {
  const nodeB = startNode(NODE_B)
  const nodeA = new NodeRouter({ node: NODE_A })
  const replies: QianmoMessage[] = []
  const client = await dial(NODE_A, nodeB, replies)

  // 发送方换着 agent 名字发：每个名字有自己的运行时桶，但接收节点的入站预算
  // 是按**发送节点**记的，所以到顶那条照样被拒——这正是「多开名字不多拿配额」。
  //
  // 一条接一条发到**第一次被拒为止**，而不是写死发 601 条：入站预算是连续补充
  // 的令牌桶，突发用了多久桶就多回几个令牌，「顶」在慢机器上不是 600（demo-env.md
  // §7.5）。判据由 report-core 按突发用时算上界；这里只如实记下用时——按
  // `Date.now()` 计，与桶读的是同一个时钟，区间从第一条发出前到被拒回执返回后，
  // 包住桶从建立到拒绝的整段，所以据此算出的回补量只会偏大不会偏小。
  const perAgent = RUNTIME_RATE.capacity
  let sent = 0
  let refusedCode: string | undefined
  const startedAt = Date.now()
  while (sent < BUDGET_BURST_CAP) {
    const from = `qianmo://${NODE_A}/burst-${Math.floor(sent / perAgent)}`
    const outcome = await send(
      nodeA,
      client,
      taskRequest({ from, to: REVIEWER, taskId: `budget-${sent}` }),
    )
    sent += 1
    if (outcome.receiptCode !== undefined || outcome.localCode !== undefined) {
      refusedCode = errorCodeOf(replies.at(-1)) ?? outcome.localCode
      break
    }
  }
  const burstElapsedMs = Date.now() - startedAt

  return {
    perMinute: LIMITS.ratePerMinute,
    sent,
    accepted: nodeB.delivered.length,
    burstElapsedMs,
    ...(refusedCode === undefined ? {} : { refusedCode }),
    senderAgents: Math.ceil(sent / perAgent),
    noRuntimeEvent:
      nodeB.router.audit.count(RouterEventType.RuntimeThrottled) === 0,
  }
}

try {
  const report = buildAc3Report({
    loop: await runLoop(),
    spiral: await runSpiral(),
    runtime: await runRuntimeThrottle(),
    budget: await runInboundBudget(),
  })
  emit({ ...report })
  process.exitCode = report.pass ? 0 : 1
} finally {
  for (const close of closers.reverse()) await close()
  rmSync(root, { recursive: true, force: true })
}
