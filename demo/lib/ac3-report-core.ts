// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 AC-3 —— 把四个场景的观测结果合成一份判据报告。
 *
 * 判据直接来自章程 §4 AC-3 与 roadmap P4.2 DoD，**四组各自独立**：
 *   ① 回环：A→B→A 在**首次回访同一处理者地址 + 同一任务标识**时即被切断，
 *      发送方收到 `error(E_LOOP)`，且目标处理器一次都没跑到；
 *   ② 审计：恰好 1 条 `loop_detected` 事件，且带完整消息链（trace-id 段与
 *      请求一致、跳链可读、判环键在事件里）；
 *   ③ 反向用例：**同一节点因不同目标地址被再次经过不算环**——这条是 D-2 改动
 *      的全部意义，没有它等于没改；
 *   ④ 两层限流各自生效且互不代劳：运行时层第 21 条被本地拒（不上线），
 *      协议层入站预算按 `LIMITS.ratePerMinute` 在**接收节点**拒，且这一层
 *      **按发送节点计**，多开几个 agent 名字不会多拿配额。
 *
 * 每条 check 单独留痕、不合并——合并之后没人知道是哪条没过。
 *
 * ## 协议层预算的判据为什么带着墙钟
 *
 * `InboundBudget` 是**连续补充**的令牌桶（`packages/router/src/rate.ts`，容量
 * `perMinute`、窗口 60 s，即每 `60_000 / perMinute` ms 回一个令牌，注释里写明
 * 是刻意不用固定窗口的）。所以「到顶」不是一个常数：突发用了多久，桶就多回
 * 了几个令牌。早先的判据写死 `accepted === perMinute`，隐含假设整个突发在一个
 * 回补间隔（100 ms）内发完——开发机跑得进，2 vCPU 的机器跑不进，于是在慢机器
 * 上**确定性判红**（`docs/dev/demo-env.md` §7.5）。
 *
 * 现在的判据直接断言令牌桶的契约本身：从第一条到被拒那条，桶最多放行
 * `perMinute + floor(burstElapsedMs / refillIntervalMs)` 条、最少 `perMinute`
 * 条；且被拒之前一条不漏、被拒即停。`burstElapsedMs` 由发送方按 `Date.now()`
 * 计——与桶读的是同一个时钟，且这段区间**包住**桶从建立到拒绝的区间，所以算
 * 出的回补量是桶实际回补量的**上界**，判据不会因为量得比桶宽而误放。判据没有
 * 因此变松：开发机上 `burstElapsedMs < 100`，回补量为 0，判据退化回
 * `accepted === perMinute`，一个数都不差。
 */

/** 场景一 + 二：回环切断与审计事件。 */
export interface Ac3LoopObservation {
  /** 第一跳（A→B）是否正常投递。 */
  readonly firstHopDelivered: boolean
  /** 回环那条是否被接收方拒收（transport receipt = rejected）。 */
  readonly bounceRejected: boolean
  /** 回环那条是否**没有**进到目标处理器。 */
  readonly bounceHandlerSkipped: boolean
  /** 发送方收到的 error 码，期望 `E_LOOP`。 */
  readonly replyCode?: string
  /** 回环时消息实际走过的跳数——用来证明切断不是 maxHops 兜底干的。 */
  readonly hopCountAtCut: number
  readonly maxHops: number
  /** `loop_detected` 事件条数，期望恰好 1。 */
  readonly loopEvents: number
  /** 事件里的 trace-id 段是否与原请求一致。 */
  readonly traceChainMatches: boolean
  /** 事件里的跳链，例如 `node-a -> node-b`。 */
  readonly hopPath?: string
  /** 事件里的判环键。 */
  readonly loopKeyHandler?: string
  readonly loopKeyTaskId?: string
}

/** 场景三：合法 spiral。 */
export interface Ac3SpiralObservation {
  /** 第二次经过节点 A（换了处理者地址）是否被正常投递。 */
  readonly delivered: boolean
  /** 投递到的处理者地址。 */
  readonly handler?: string
  /** 这一轮里 `loop_detected` 的条数，期望 0。 */
  readonly loopEvents: number
}

/** 场景四上半：运行时层令牌桶。 */
export interface Ac3RuntimeObservation {
  readonly capacity: number
  readonly windowMs: number
  /** 实际放行条数，期望等于 capacity。 */
  readonly allowed: number
  /** 第 capacity+1 条的本地拒绝码，期望 `E_RUNTIME_THROTTLED`。 */
  readonly refusedCode?: string
  /** 被拒那条是否**没有**上线（接收方一条都没多收）。 */
  readonly refusedStayedLocal: boolean
  /** 换一个目标地址是否立刻放行——证明这一层是「对单目标」。 */
  readonly otherTargetAllowed: boolean
  /** 运行时层是否**没有**产生协议层的 `rate_limited` 事件。 */
  readonly noProtocolEvent: boolean
}

/** 场景四下半：协议层入站预算。 */
export interface Ac3BudgetObservation {
  readonly perMinute: number
  /** 一条接一条发、发到**第一次被拒为止**，一共发出的条数（含被拒那条）。 */
  readonly sent: number
  /** 接收方实际收下的条数，期望落在 `[perMinute, perMinute + 回补量]`。 */
  readonly accepted: number
  /**
   * 突发的墙钟用时（ms）：从第一条发出之前到被拒那条的回执返回之后，按
   * `Date.now()` 计——与接收方令牌桶读的是同一个时钟。见模块头。
   */
  readonly burstElapsedMs: number
  /** 越界那条的错误码，期望 `E_RATE_LIMITED`。 */
  readonly refusedCode?: string
  /** 参与发送的 agent 名字个数——>1 才能证明「按节点计」。 */
  readonly senderAgents: number
  /** 协议层是否**没有**产生运行时层的 `runtime_throttled` 事件。 */
  readonly noRuntimeEvent: boolean
}

/** 场景四下半的观测，外加报告核心据此算出的两个判据输入。 */
export interface Ac3BudgetJudged extends Ac3BudgetObservation {
  /** 连续补充令牌桶回补一个令牌的间隔 = `60_000 / perMinute`。 */
  readonly refillIntervalMs: number
  /** 突发期间桶最多能补回的令牌数 = `floor(burstElapsedMs / refillIntervalMs)`。 */
  readonly refillAllowance: number
}

export interface Ac3Observations {
  readonly loop: Ac3LoopObservation
  readonly spiral: Ac3SpiralObservation
  readonly runtime: Ac3RuntimeObservation
  readonly budget: Ac3BudgetObservation
}

export interface Ac3Report extends Ac3Observations {
  readonly budget: Ac3BudgetJudged
  readonly checks: {
    readonly loopCutAtFirstRevisit: boolean
    readonly loopReportedToSender: boolean
    readonly loopNotByHopBackstop: boolean
    readonly loopAuditEvent: boolean
    readonly loopAuditCarriesChain: boolean
    readonly spiralNotCut: boolean
    readonly runtimeThrottleAtCapacity: boolean
    readonly runtimeThrottleStaysLocal: boolean
    readonly protocolBudgetAtLimit: boolean
    readonly layersDoNotOverlap: boolean
  }
  readonly pass: boolean
}

/** 「每分钟」里的那一分钟——`perMinute` 的单位，不是可调参数。 */
const MINUTE_MS = 60_000

export function buildAc3Report(observations: Ac3Observations): Ac3Report {
  const { loop, spiral, runtime } = observations

  const refillIntervalMs = MINUTE_MS / observations.budget.perMinute
  const budget: Ac3BudgetJudged = {
    ...observations.budget,
    refillIntervalMs,
    refillAllowance: Math.floor(
      Math.max(0, observations.budget.burstElapsedMs) / refillIntervalMs,
    ),
  }

  const checks = {
    loopCutAtFirstRevisit:
      loop.firstHopDelivered &&
      loop.bounceRejected &&
      loop.bounceHandlerSkipped,
    loopReportedToSender: loop.replyCode === 'E_LOOP',
    // 判环是处理者粒度命中的，不是跳数兜底救的场——两者都会切断，但只有前者
    // 满足「首次回访即切断」。
    loopNotByHopBackstop: loop.hopCountAtCut < loop.maxHops,
    loopAuditEvent: loop.loopEvents === 1,
    loopAuditCarriesChain:
      loop.traceChainMatches &&
      typeof loop.hopPath === 'string' &&
      loop.hopPath.length > 0 &&
      typeof loop.loopKeyHandler === 'string' &&
      typeof loop.loopKeyTaskId === 'string',
    spiralNotCut: spiral.delivered && spiral.loopEvents === 0,
    runtimeThrottleAtCapacity:
      runtime.allowed === runtime.capacity &&
      runtime.refusedCode === 'E_RUNTIME_THROTTLED' &&
      runtime.otherTargetAllowed,
    runtimeThrottleStaysLocal: runtime.refusedStayedLocal,
    protocolBudgetAtLimit:
      // 到顶就拒：被拒的那条码是协议层的。
      budget.refusedCode === 'E_RATE_LIMITED' &&
      // 被拒之前一条不漏、被拒即停——发出的条数恰好比收下的多一条。
      budget.accepted === budget.sent - 1 &&
      // 「顶」是令牌桶的契约：至少放行 perMinute 条（少了是限流器少放），
      // 至多 perMinute + 突发期间连续补充回来的令牌数（多了是限流器多放）。
      budget.accepted >= budget.perMinute &&
      budget.accepted <= budget.perMinute + budget.refillAllowance &&
      // >1 个发送 agent：协议层按**节点**计，多开名字不多拿配额。
      budget.senderAgents > 1,
    layersDoNotOverlap: runtime.noProtocolEvent && budget.noRuntimeEvent,
  }

  return {
    ...observations,
    budget,
    checks,
    pass: Object.values(checks).every(Boolean),
  }
}
