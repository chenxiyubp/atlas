// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P7.3 —— 消息吞吐阶梯。
 *
 *   QIANMO_TRANSPORT_PSK=... bun run demo/lib/p73-throughput.ts \
 *     --tier T3 --tier-seconds 120 --minutes 45 --out /srv/p73/t3.ndjson
 *
 * ## 三个配置，为的是把「吞吐」这个词拆开
 *
 * 单说「阡陌能跑多少 msg/s」是没有意义的，因为答案取决于问的是哪一层：
 *
 * | 配置 | 组成 | 它回答的问题 |
 * |---|---|---|
 * | T1 | `startTransportServer` + `onMessage`，无路由无审计 | 传输层本身的天花板 |
 * | T2 | T1 + `NodeRouter`（`InboundBudget` 生效） | 协议层预算在哪儿开始起作用 |
 * | T3 | T2 + 审计 trail 落盘 | **对外能承诺的那个数字** |
 *
 * **只有 T3 的数字可以对外说。**T1 与 T2 是用来解释 T3 为什么是那个数字的：一个
 * 拿 T1 数字去宣传的报告，宣传的是一个没有人会真的运行的配置。
 *
 * ## 三道天花板，判读时要分清是撞上了哪一道
 *
 * 1. **协议层入站预算** `LIMITS.ratePerMinute`（数值的唯一出处是
 *    `packages/protocol/src/limits.ts`，这里记作 **B**）。设计值，不是缺陷。注意
 *    桶是**满的**起步，所以一段长 T 秒的档位可持续速率上限是 `B·(1/T + 1/60)`，
 *    **T 越小这条线越高**——短档没触发限流不等于没有限流，只是令牌还没花完。
 * 2. **发送端 outbox 队列**。撞上就是 `OutboxFullError`，说明接收端回执跟不上。
 * 3. **去重表的全表扫描**。`DedupTable.admit` 每次都 `pruneExpired`，而 prune 是
 *    对整张表的一次遍历。表项按 `LIMITS.defaultTtlMs`（记作 D 秒）到期，故表长
 *    ≈ D·R，每秒扫描代价 ≈ R × D·R = **D·R²**。代入当前的 D，拐点预测落在
 *    **R ≈ 333/s** 附近——所以阶梯的最后两档是 200 与 400，把它夹在中间。
 *
 * **N-12：观测到拐点也不修。**记进报告 §7，M1 决定要不要动。
 *
 * ## 两个计数来源，交叉核对
 *
 * 发送端数回执，盘上审计数 `message_accepted`。两个数字对不上，说明有一边在说谎，
 * 这一档的吞吐就不能引用（判据在 `p73-report-core.ts`）。T1 没有审计，如实记单来源。
 *
 * ## 为什么不读 `EventRecorder`
 *
 * `EventRecorder` 是 **256 条的环**（`packages/transport/src/events.ts`）。400 msg/s
 * 跑 120 s 有四万多条事件，`byType(...).length` 读出来的是「环里还剩几条」，不是
 * 总数——而且它长得非常像总数。所以计数**一律**走 events sink 自己累加。
 *
 * ## 档间要静默
 *
 * 去重表的条目按 `LIMITS.defaultTtlMs` 到期。档与档之间静默到超过这个时限，下一档
 * 开跑时表才是空的；不静默的话，第 N 档测到的是第 N-1 档留下的表长，阶梯就不再是阶梯。
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { statsOf } from '@qianmo/activator'
import { AuditTrail, readTrail } from '@qianmo/audit'
import { LIMITS, MessageType, createMessage } from '@qianmo/protocol'
import { NodeRouter, RouterEventType } from '@qianmo/router'
import {
  OutboxFullError,
  TransportClient,
  TransportEventType,
  pskFromEnv,
  startTransportServer,
  type TransportEvent,
  type TransportServerHandle,
} from '@qianmo/transport'
import {
  routerTrailSink,
  transportTrailSink,
} from '../../src/services/qianmo/auditTrail.js'
import { arg, emit, intArg } from './cli-args.js'
import {
  buildP73Report,
  type P73Config,
  type P73MemorySample,
  type P73TierObservation,
  type P73WriterOverflow,
} from './p73-report-core.js'

/** 八档。最后两档夹住 D·R² 预测的 R ≈ 333/s 拐点。 */
const LADDER: readonly number[] = Object.freeze([
  1, 5, 10, 25, 50, 100, 200, 400,
])

const RECEIVER = 'qianmo://node-b/reviewer'

/**
 * `--rates 1,10,50,100` 换掉整条阶梯。
 *
 * 只给校准用：正式数据必须跑完整八档，抽掉几档的阶梯回答不了「拐点在哪一档」——
 * 它只能回答「在我跑的这几档里没看见」。报告里跑批参数原样带出去，就是为了让
 * 「这是一次抽档的校准跑」这件事在数据表上就能看出来。
 */
function ladder(): readonly number[] {
  const raw = arg('rates')
  if (raw === undefined) return LADDER
  const rates = raw
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isInteger(value) && value > 0)
  if (rates.length === 0) throw new Error('--rates must list positive integers')
  return rates
}

function tierName(value: string | undefined): P73Config {
  if (value === 'T1' || value === 'T2' || value === 'T3') return value
  throw new Error('--tier must be one of T1, T2, T3')
}

function absoluteArg(name: string): string | undefined {
  const value = arg(name)
  if (value === undefined) return undefined
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(
      `--${name} must be an absolute path without control characters`,
    )
  }
  return value
}

const config = tierName(arg('tier'))
const tierSeconds = intArg('tier-seconds', 120)
if (tierSeconds <= 0) throw new Error('--tier-seconds must be positive')
/**
 * 档位时长必须**超过**去重表的表项时限，否则第三道天花板根本测不到。
 *
 * 校准跑用 20 s 的档撞出来的：表项按 `LIMITS.defaultTtlMs` 到期，档比它还短的话，
 * 一档跑完**一条都还没过期**——`pruneExpired` 照样每次遍历全表，但表长只到 R×档长，
 * 永远够不到稳态的 D·R。于是这条阶梯**在方法上就无法证伪拐点假设**：跑出一片绿色，
 * 只说明「在没达到稳态表长的情况下没看到拐点」。
 *
 * 不抛错只警告：短档对另外两道天花板仍然有效，抽档校准是合法用法。
 */
if (tierSeconds * 1_000 <= LIMITS.defaultTtlMs) {
  process.stderr.write(
    `p73-throughput: WARNING tier-seconds=${tierSeconds}s does not exceed the dedup entry deadline ` +
      `(${LIMITS.defaultTtlMs}ms); the table never reaches its steady-state length, so this run ` +
      'cannot test the dedup-scan knee. Use --tier-seconds well above it for baseline data.\n',
  )
}
const minutes = intArg('minutes', 60)
if (minutes <= 0) throw new Error('--minutes must be positive')
/**
 * 档间静默。默认 65 s，要同时满足**两个**条件——校准跑发现只满足第一个不够：
 *
 * ① **> `LIMITS.defaultTtlMs`**，让去重表泄空（否则第 N 档测到的是第 N-1 档的表长）；
 * ② **≥ 60 s**，让 `InboundBudget` 的桶**重新填满**。
 *
 * 第二条是本地校准跑当场撞出来的：35 s 的静默只回补 `(B/60)·35` 个令牌，于是 50 msg/s
 * 那一档把桶抽干之后，100 msg/s 那一档是**带着一只半空的桶**开跑的——实测 delivered=550，
 * 正好等于「静默回补的 350 + 本档 20 s 内回补的 200」，而不是满桶推导出的 800。
 *
 * 后果是**档与档之间不再独立**：预算维度上第 N 档的天花板取决于第 N-1 档留下了什么。
 * 桶从空到满恰好是一个窗口（60 s），所以静默取 65 s 就让每一档都从满桶起步，
 * `R_max(T) = B·(1/T + 1/60)` 这条线才对每一档成立。
 */
const cooldownSeconds = intArg('cooldown-seconds', 65)
const senderArg = intArg('senders', 1)
if (senderArg < 1) throw new Error('--senders must be at least 1')
const out = absoluteArg('out')
const memFile = absoluteArg('mem-file')
const residentLog = absoluteArg('resident-log')

const PSK = pskFromEnv()
const root = mkdtempSync(join(tmpdir(), 'qianmo-p73-'))
const socket = join(root, 'node-b.sock')
const trailPath = join(root, 'audit', 'trail.ndjson')

/**
 * events sink 的自累加计数。**不读 `EventRecorder`**——见模块头。
 */
const tally = new Map<TransportEventType, number>()
function tallied(type: TransportEventType): number {
  return tally.get(type) ?? 0
}

const trail = config === 'T3' ? new AuditTrail(trailPath) : null
const trailTransport =
  trail === null ? null : transportTrailSink(trail, 'node-b')

let delivered = 0
const router =
  config === 'T1'
    ? null
    : new NodeRouter({
        node: 'node-b',
        ...(trail === null
          ? {}
          : { auditSink: routerTrailSink(trail, 'node-b') }),
      })

const server: TransportServerHandle = startTransportServer({
  psk: PSK,
  unix: socket,
  events: (event: TransportEvent): void => {
    tally.set(event.type, tallied(event.type) + 1)
    trailTransport?.(event)
  },
  onMessage: message => {
    if (router !== null) {
      const verdict = router.inbound(message)
      // 抛出去让传输层记 `message_rejected` 并回一条带错误码的回执——这正是生产
      // 形态下拒绝走的那条路，自己吞掉的话发送端会以为投递成功了。
      if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`)
    }
    delivered += 1
  },
})

/**
 * 发送端。T2/T3 可以有多个**节点身份**并行。
 *
 * 多身份不是为了压更多流量，是为了证明 `LIMITS.ratePerMinute` 是**按发送节点**算的：
 * `InboundBudget` 的键取自 `from` 的节点段，两个身份各有一只桶，合起来的吞吐
 * 应该接近线性抬升。抬不上去，说明限流的粒度和文档写的不是一回事。
 */
interface Sender {
  readonly from: string
  readonly client: TransportClient
}

const senderCount = config === 'T1' ? 1 : senderArg
const senders: Sender[] = Array.from({ length: senderCount }, (_, index) => ({
  from: `qianmo://node-a${index + 1}/planner`,
  client: new TransportClient({
    endpoint: { unix: socket },
    node: `node-a${index + 1}`,
    psk: PSK,
    keepAliveIntervalMs: 0,
    backoff: { baseDelayMs: 50, maxDelayMs: 500, jitterRatio: 0.1 },
  }),
}))

let sequence = 0
let outboxFull = 0
let latencies: number[] = []

async function sendOne(sender: Sender): Promise<void> {
  sequence += 1
  const startedAt = Date.now()
  try {
    await sender.client.sendAndWait(
      createMessage({
        from: sender.from,
        to: RECEIVER,
        type: MessageType.TaskRequest,
        payload: { seq: sequence },
        // 每条一个新 taskId：`LoopGuard` 的键是 `(目标, taskId)`，复用 taskId
        // 会让第二条起全部被判成环路，测到的就成了防环而不是吞吐。
        taskId: `p73-${config}-${sequence}`,
      }),
      10_000,
    )
    latencies.push(Date.now() - startedAt)
  } catch (error) {
    if (error instanceof OutboxFullError) outboxFull += 1
    // 其余失败（被拒的回执、超时）已经由 events sink 计到 rejected 上，
    // 这里不再重复计数——两处各记一次会让拒绝数翻倍。
  }
}

/** 盘上审计里数出来的投递条数。T1 无审计，返回 null。 */
function auditAccepted(): number | null {
  if (trail === null) return null
  return readTrail(trailPath).records.filter(
    record => record.kind === TransportEventType.MessageAccepted,
  ).length
}

interface TierRaw {
  readonly rate: number
  readonly seconds: number
  readonly observation: P73TierObservation
}

async function runTier(rate: number): Promise<TierRaw> {
  const before = {
    delivered,
    accepted: tallied(TransportEventType.MessageAccepted),
    duplicate: tallied(TransportEventType.MessageDuplicate),
    rejected: tallied(TransportEventType.MessageRejected),
    outboxFull,
    audit: auditAccepted(),
    rateLimited: router?.audit.count(RouterEventType.RateLimited) ?? 0,
  }
  latencies = []

  const startedAt = Date.now()
  const endAt = startedAt + tierSeconds * 1_000
  const target = rate * tierSeconds
  const inflight: Promise<void>[] = []
  let dispatched = 0

  while (Date.now() < endAt && dispatched < target) {
    // 按「到这一刻本该发出多少条」补齐，而不是 setInterval：后者的漂移会在
    // 120 s 里累积成一个说不清的实际速率。
    const due = Math.min(
      target,
      Math.floor(((Date.now() - startedAt) / 1_000) * rate),
    )
    while (dispatched < due) {
      const sender = senders[dispatched % senders.length]
      dispatched += 1
      if (sender !== undefined) inflight.push(sendOne(sender))
    }
    await Bun.sleep(1)
  }
  await Promise.all(inflight)
  const seconds = (Date.now() - startedAt) / 1_000

  const stats = statsOf(latencies)
  const audit = auditAccepted()
  return {
    rate,
    seconds,
    observation: {
      config,
      targetRate: rate,
      seconds,
      senders: senders.length,
      attempted: dispatched,
      deliveredBySender: latencies.length,
      deliveredByAudit:
        audit === null || before.audit === null ? null : audit - before.audit,
      duplicate:
        tallied(TransportEventType.MessageDuplicate) - before.duplicate,
      rejected: tallied(TransportEventType.MessageRejected) - before.rejected,
      outboxFull: outboxFull - before.outboxFull,
      rateLimited:
        (router?.audit.count(RouterEventType.RateLimited) ?? 0) -
        before.rateLimited,
      p50Ms: stats.p50Ms,
      p95Ms: stats.p95Ms,
      latencySamples: stats.count,
    },
  }
}

/** 采样文件里判读连续性需要的那几个字段。坏行跳过，不让一行毁掉一份数据。 */
function memorySamples(path: string): P73MemorySample[] {
  const samples: P73MemorySample[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      const row = parsed as Partial<P73MemorySample>
      if (
        typeof row.at === 'number' &&
        typeof row.role === 'string' &&
        typeof row.channel === 'string'
      ) {
        samples.push({ at: row.at, role: row.role, channel: row.channel })
      }
    } catch {
      // 一行坏了就跳过；断档会由 `p73-report-core.ts` 当作 gap 标出来。
    }
  }
  return samples
}

/** 常驻进程 stderr 里的 writer 溢出警告。有一条，整份数据就不可用。 */
function writerOverflows(path: string): P73WriterOverflow[] {
  const at = statSync(path).mtimeMs
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.includes('writer queue overflow'))
    .map(line => ({
      writer: line.includes('memory') ? 'resident memory' : 'resident timing',
      at,
    }))
}

if (out !== undefined) {
  writeFileSync(out, '', { mode: 0o600 })
  chmodSync(out, 0o600)
}

const rates = ladder()
const deadline = Date.now() + minutes * 60_000
const tiers: P73TierObservation[] = []
const skipped: number[] = []

process.stderr.write(
  `p73-throughput: tier=${config} rates=${rates.join(',')} seconds=${tierSeconds} senders=${senders.length} cooldown=${cooldownSeconds}s socket=${socket}\n`,
)

try {
  for (const sender of senders) await sender.client.connect(5_000)

  for (const [index, rate] of rates.entries()) {
    if (Date.now() + tierSeconds * 1_000 > deadline) {
      skipped.push(...rates.slice(index))
      break
    }
    const raw = await runTier(rate)
    tiers.push(raw.observation)
    if (out !== undefined) {
      appendFileSync(out, `${JSON.stringify(raw.observation)}\n`)
    }
    process.stderr.write(
      `  ${rate} msg/s → delivered=${raw.observation.deliveredBySender} p50=${raw.observation.p50Ms}ms p95=${raw.observation.p95Ms}ms rateLimited=${raw.observation.rateLimited} outboxFull=${raw.observation.outboxFull}\n`,
    )
    // 档间静默，让去重表泄空。最后一档之后不用等。
    if (index < rates.length - 1 && Date.now() < deadline) {
      await Bun.sleep(cooldownSeconds * 1_000)
    }
  }
} finally {
  for (const sender of senders) await sender.client.close()
  await server.stop()
  trail?.close()
}

const report = buildP73Report({
  tiers,
  memory: {
    intervalMs: intArg('mem-interval-ms', 60_000),
    samples: memFile === undefined ? [] : memorySamples(memFile),
  },
  writerOverflows:
    residentLog === undefined ? [] : writerOverflows(residentLog),
})

// 原始数据就是交付物：审计文件保留，路径打在 stderr 上，由 shell 侧决定去留。
if (trail !== null)
  process.stderr.write(`p73-throughput: trail kept at ${trailPath}\n`)
else rmSync(root, { recursive: true, force: true })

emit({
  ...report,
  tierConfig: config,
  tierSeconds,
  cooldownSeconds,
  // 跑批参数原样带出去：抽档的校准跑要在数据表上一眼看得出来。
  rates,
  fullLadder: rates.length === LADDER.length,
  skippedRates: skipped,
  ...(out === undefined ? {} : { out }),
})
