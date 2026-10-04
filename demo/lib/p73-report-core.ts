// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P7.3 —— 性能与稳定性基线的**判读**。
 *
 * ## 这里的 check 是观测，不是门禁（章程 N-12）
 *
 * 别的 report-core（AC-2 / AC-3 / AC-8）的 `pass` 是验收线：红了就说明系统没做到
 * 承诺的事。**这一份不是。**P7.3 的任务是「只测不调优，除非卡验收线」，所以这里
 * 每一条 check 回答的都是同一个问题的一部分——**这份数据能不能拿来当基线读**：
 *
 * - `pass === false` 的处置是**把它写进报告 §7「发现但不修」**，不是去改被测代码。
 * - 一档撞上协议层入站预算（`LIMITS.ratePerMinute`）不是缺陷，那是**设计值**；判读要做
 *   的是把它标出来，免得后面有人拿这个数字当「系统的吞吐上限」到处引用。
 * - 拐点档位同理：去重表全表扫描的 O(N) 成本是**已知的**取舍，报告负责记录它在
 *   哪一档开始显形，M1 决定要不要动它。
 *
 * 换句话说：**红色在这里的意思是「这份数据不该被引用」，不是「代码该改」。**
 *
 * ## 零依赖是故意的
 *
 * 这个文件不 import 任何东西（连 type 都不）。判读逻辑要能脱离一整套传输/路由的
 * 模块图单独跑单测，也要能在只有一份 NDJSON 的机器上重算一遍——真机跑批的产物是
 * 数据文件，判读不该要求那台机器还能把项目装起来。
 */

/** 三种配置，从裸传输一路加到生产形态。 */
export type P73Config = 'T1' | 'T2' | 'T3'

/** 一档的判读结论。 */
export type P73Verdict =
  /** 撞上协议层入站预算（`LIMITS.ratePerMinute`）。设计值，不是缺陷。 */
  | 'budget'
  /** 撞上发送端 outbox 队列上限。 */
  | 'queue'
  /** 两者都撞上了。 */
  | 'budget-and-queue'
  /** 两者全 0，但 p95 涨得比档位快——拐点候选。 */
  | 'knee'
  /** 两者全 0 且 p95 增长不超过档位增长。 */
  | 'linear'
  /** 这一档一条延迟样本都没有，什么都判不了。 */
  | 'unclassified'

/** 一档吞吐阶梯的原始观测。由 `p73-throughput.ts` 逐档写出。 */
export interface P73TierObservation {
  readonly config: P73Config
  /** 目标速率，msg/s。 */
  readonly targetRate: number
  /** 这一档实际跑了多少秒。 */
  readonly seconds: number
  /** 并行的发送节点身份数。T2 用它证明入站预算是**按节点**算的。 */
  readonly senders: number
  /** 发送端一共发起了多少条。 */
  readonly attempted: number
  /** 来源一：发送端收到回执的条数。 */
  readonly deliveredBySender: number
  /**
   * 来源二：盘上审计里数出来的条数。
   *
   * T1 没有审计，如实记 `null` —— 单来源的数字要在报告里标明是单来源，
   * 而不是让读的人以为它也交叉核对过。
   */
  readonly deliveredByAudit: number | null
  /** 传输层判重条数（events sink 自累加，不读 EventRecorder）。 */
  readonly duplicate: number
  /** 被拒条数（含路由层拒绝）。 */
  readonly rejected: number
  /** `OutboxFullError` 条数。 */
  readonly outboxFull: number
  /** 路由层 `RouterEventType.RateLimited` 的增量（无界 `count()`）。 */
  readonly rateLimited: number
  readonly p50Ms: number
  readonly p95Ms: number
  /** 参与分位数计算的样本数。0 表示这一档没有可判读的延迟。 */
  readonly latencySamples: number
}

/** 内存采样的一条（只取判读连续性需要的字段）。 */
export interface P73MemorySample {
  readonly at: number
  readonly role: string
  /** `proc` / `ps` / `in-process`。带 `ps` 的数据集只算仪器校准。 */
  readonly channel: string
}

/** 一段采样断档，**标注出来**而不是无声跳过。 */
export interface P73MemoryGap {
  readonly role: string
  readonly fromAt: number
  readonly toAt: number
  readonly gapMs: number
  readonly expectedMs: number
}

/** writer 队列溢出：出现一条就说明这个数据集缺了不知道多少条。 */
export interface P73WriterOverflow {
  readonly writer: string
  readonly at: number
}

export interface P73Observations {
  readonly tiers: readonly P73TierObservation[]
  readonly memory: {
    readonly intervalMs: number
    readonly samples: readonly P73MemorySample[]
  }
  readonly writerOverflows: readonly P73WriterOverflow[]
}

/** 一档判读之后的样子。 */
export interface P73TierReading extends P73TierObservation {
  readonly verdict: P73Verdict
  /** 实测吞吐，msg/s。 */
  readonly achievedRate: number
  /** 两个来源的差值绝对值；单来源时为 `null`。 */
  readonly sourceDelta: number | null
}

export interface P73Report extends P73Observations {
  readonly tierReadings: readonly P73TierReading[]
  /** 每种配置最低的那个拐点档位速率；没观测到就不出现在表里。 */
  readonly kneeAt: readonly {
    readonly config: P73Config
    readonly rate: number
  }[]
  readonly memoryGaps: readonly P73MemoryGap[]
  readonly degradedChannels: readonly string[]
  readonly checks: Record<string, boolean>
  readonly pass: boolean
}

/**
 * 两个计数来源允许差多少条。
 *
 * 不取 0：发送端的回执与盘上审计不是同一个瞬间落地的，一档结束的那一刻总有几条
 * 正在路上。取 1% 与 2 条里的大者——比抖动宽，比「少数了一整批」窄。
 */
function tolerance(count: number): number {
  return Math.max(2, Math.ceil(count * 0.01))
}

/**
 * 断档阈值：期望间隔的 2 倍。
 *
 * 采样器自己的调度抖动、以及一次慢的 `/proc` 读取，都够让相邻两条差出几百毫秒；
 * 2 倍能放过这些，放不过「漏了一整轮」。
 */
const GAP_FACTOR = 2

/**
 * 能不能拿这一档当拐点比较的**基线**。
 *
 * 只有没撞任何天花板的档位才够格。一个被预算限流的档位，它的 p95 反映的是被节流之后
 * 的负载而不是自然排队——拿它当基线，下一档的延迟涨了多少就说明不了任何事。
 */
function usableAsBaseline(reading: P73TierReading): boolean {
  return reading.verdict === 'linear' || reading.verdict === 'knee'
}

function percentileGrowthIsSuperlinear(
  previous: P73TierReading,
  current: P73TierObservation,
): boolean {
  if (previous.p95Ms <= 0 || previous.targetRate <= 0) return false
  const rateRatio = current.targetRate / previous.targetRate
  if (!(rateRatio > 1)) return false
  // 理想情况下队列稳定、延迟与档位无关，p95 应该基本持平。放宽到「涨得比档位还快」
  // 才算拐点候选：这条线保守，宁可漏报也不要把噪声记成拐点。
  return current.p95Ms > previous.p95Ms * rateRatio
}

export function buildP73Report(observations: P73Observations): P73Report {
  const tierReadings: P73TierReading[] = []
  // 按配置分别推进：拐点是同一条曲线上前后两档的比较，跨配置比没有意义。
  const previousOf = new Map<P73Config, P73TierReading>()

  for (const tier of observations.tiers) {
    const hitBudget = tier.rateLimited > 0
    const hitQueue = tier.outboxFull > 0
    // 顺序要紧：**先认天花板，再谈延迟**。
    //
    // 一档把预算撞穿到一条都没通过（`latencySamples === 0`）时，它是被解释过的——
    // 解释就是「撞上了预算」。反过来先看延迟样本的话，这一档会被判成 `unclassified`
    // 并把整份数据判为不可读，而它其实是这条阶梯上信息量最大的一档。
    // `unclassified` 要留给真正说不清的那种：**没撞任何已知天花板，又一条都没成功。**
    let verdict: P73Verdict
    if (hitBudget && hitQueue) {
      verdict = 'budget-and-queue'
    } else if (hitBudget) {
      verdict = 'budget'
    } else if (hitQueue) {
      verdict = 'queue'
    } else if (tier.latencySamples === 0) {
      verdict = 'unclassified'
    } else {
      const previous = previousOf.get(tier.config)
      verdict =
        previous !== undefined &&
        usableAsBaseline(previous) &&
        percentileGrowthIsSuperlinear(previous, tier)
          ? 'knee'
          : 'linear'
    }

    const reading: P73TierReading = {
      ...tier,
      verdict,
      achievedRate:
        tier.seconds > 0 ? tier.deliveredBySender / tier.seconds : 0,
      sourceDelta:
        tier.deliveredByAudit === null
          ? null
          : Math.abs(tier.deliveredBySender - tier.deliveredByAudit),
    }
    tierReadings.push(reading)
    previousOf.set(tier.config, reading)
  }

  const kneeAt: { config: P73Config; rate: number }[] = []
  for (const reading of tierReadings) {
    if (reading.verdict !== 'knee') continue
    const existing = kneeAt.find(entry => entry.config === reading.config)
    if (existing === undefined) {
      kneeAt.push({ config: reading.config, rate: reading.targetRate })
    } else if (reading.targetRate < existing.rate) {
      existing.rate = reading.targetRate
    }
  }

  // 断档按 role 各算各的：常驻进程一路在采，ACP 子进程重启换 pid 是正常的，
  // 把两条线混在一起会让每一次重启都长得像一次断档。
  const memoryGaps: P73MemoryGap[] = []
  const expectedMs = observations.memory.intervalMs
  const byRole = new Map<string, P73MemorySample[]>()
  for (const sample of observations.memory.samples) {
    const bucket = byRole.get(sample.role)
    if (bucket === undefined) byRole.set(sample.role, [sample])
    else bucket.push(sample)
  }
  for (const [role, samples] of byRole) {
    const ordered = [...samples].sort((a, b) => a.at - b.at)
    for (let index = 1; index < ordered.length; index += 1) {
      const from = ordered[index - 1]
      const to = ordered[index]
      if (from === undefined || to === undefined) continue
      const gapMs = to.at - from.at
      if (gapMs > expectedMs * GAP_FACTOR) {
        memoryGaps.push({
          role,
          fromAt: from.at,
          toAt: to.at,
          gapMs,
          expectedMs,
        })
      }
    }
  }

  const degradedChannels = [
    ...new Set(
      observations.memory.samples
        .filter(sample => sample.channel !== 'proc')
        .map(sample => sample.channel),
    ),
  ].sort()

  const checks: Record<string, boolean> = {
    // ① 有档位可读。空数据集不该长得像通过。
    tiersObserved: tierReadings.length > 0,
    // ② 每一档都判出了结论。`unclassified` 意味着这一档一条延迟样本都没有——
    //    没有样本的「没撞上限」不是观测，是缺数据。
    everyTierClassified: tierReadings.every(
      reading => reading.verdict !== 'unclassified',
    ),
    // ③ 两个计数来源对得上。对不上说明发送端与盘上审计有一边在说谎，
    //    这一档的吞吐数字就不能引用。
    throughputSourcesAgree: tierReadings.every(
      reading =>
        reading.sourceDelta === null ||
        reading.sourceDelta <= tolerance(reading.deliveredBySender),
    ),
    // ④ 内存采样连续。断了就断了，但必须**标注区间**（见 `memoryGaps`），
    //    而不是让曲线上少一段没人发现。
    memorySamplesContinuous: memoryGaps.length === 0,
    // ⑤ 没有通道降级。macOS 的 `ps` 兜底采得到 RSS、采不到 VmHWM 与 cgroup，
    //    这样的数据集只能当仪器校准，不进正式数据表。
    memoryChannelsIntact: degradedChannels.length === 0,
    // ⑥ 没有 writer 溢出警告。一条就够——溢出之后缺了多少条**无从得知**，
    //    整个数据集因此不可用。
    writerOverflowFree: observations.writerOverflows.length === 0,
  }

  return {
    ...observations,
    tierReadings,
    kneeAt,
    memoryGaps,
    degradedChannels,
    checks,
    pass: Object.values(checks).every(Boolean),
  }
}
