// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P4.1 —— 把每轮的发送记录与 activator 的阶段耗时合成一份判据报告。
 *
 * 判据来自 AC-2 与 roadmap P4.1 DoD，三条同时成立才算通过：
 *   ① 成功率：期望轮数全部为 `complete`（既收到 ack，又收到成功的 `task.result`）；
 *   ② ack 的 **P95 ≤ 上限**（默认 60 s）；
 *   ③ result 的 **最大值 ≤ 上限**（默认 5 min）——这条判的是「每一轮」，
 *      所以取 max 而不是 P95，宽松一点点都会让一轮超时的样本躲过去。
 *
 * 另有三条结构性判据，它们不看时间，只看这条链路是不是**按设计**走的：
 *   ④ 每轮投递前沙箱确认为 `frozen`（否则测的是「给醒着的节点发消息」）；
 *   ⑤ ack 与 result 都从发送方自己那条连接回来，且 payload 通过字段封闭校验；
 *   ⑥ 每轮的目标地址都是**经注册中心按名解析**拿到的，不是照着 URL 拨过去的。
 */

import type { StageStats } from '@qianmo/activator'
import { statsOf } from '@qianmo/activator'

/** 一轮的原始记录：`p41-send.ts` 的输出，加上 shell 侧记下的冻结前置。 */
export interface P41Round {
  readonly round: number
  readonly msgId: string
  readonly taskId: string
  readonly verdict: 'complete' | 'no-ack' | 'no-result' | string
  readonly receipt?: string | null
  readonly sendError?: string
  readonly sentAt: number
  readonly receiptAt?: number
  readonly ackAt?: number
  readonly sendToAckMs?: number
  readonly ackClosed?: boolean
  readonly ackFrom?: string
  readonly resultAt?: number
  readonly sendToResultMs?: number
  readonly resultClosed?: boolean
  readonly resultOutcome?: string
  readonly resultCode?: string
  readonly resultFrom?: string
  readonly contentChars?: number
  readonly unexpected?: readonly string[]
  /** 投递前沙箱状态，由 shell 侧从 `ac2-state.ts` 抄进来。 */
  readonly frozenBefore?: boolean
  readonly resolvedByRegistry?: boolean
  readonly resolveMs?: number
  readonly resolvedEndpoint?: string
}

export interface P41Report {
  readonly expectedRounds: number
  readonly rounds: number
  readonly complete: number
  readonly ackLimitMs: number
  readonly resultLimitMs: number
  readonly sendToAck: StageStats
  readonly sendToResult: StageStats
  /** 五条判据逐条留痕，不合并——合并之后没人知道是哪条没过。 */
  readonly checks: {
    readonly rounds: boolean
    readonly successRate: boolean
    readonly ackP95: boolean
    readonly resultMax: boolean
    readonly frozenBefore: boolean
    readonly closedReplies: boolean
    readonly noStrayReplies: boolean
    readonly resolvedByRegistry: boolean
  }
  readonly pass: boolean
  readonly entries: readonly P41Round[]
}

export interface P41ReportOptions {
  readonly expectedRounds: number
  readonly ackLimitMs: number
  readonly resultLimitMs: number
}

export function buildP41Report(
  rounds: readonly P41Round[],
  options: P41ReportOptions,
): P41Report {
  const complete = rounds.filter(
    entry =>
      entry.verdict === 'complete' && entry.resultOutcome === 'completed',
  )
  const sendToAck = statsOf(
    rounds.flatMap(entry =>
      typeof entry.sendToAckMs === 'number' ? [entry.sendToAckMs] : [],
    ),
  )
  const sendToResult = statsOf(
    rounds.flatMap(entry =>
      typeof entry.sendToResultMs === 'number' ? [entry.sendToResultMs] : [],
    ),
  )

  const checks = {
    rounds: rounds.length === options.expectedRounds,
    successRate: complete.length === options.expectedRounds,
    ackP95:
      sendToAck.count === options.expectedRounds &&
      sendToAck.p95Ms <= options.ackLimitMs,
    resultMax:
      sendToResult.count === options.expectedRounds &&
      sendToResult.maxMs <= options.resultLimitMs,
    frozenBefore:
      rounds.length > 0 && rounds.every(entry => entry.frozenBefore === true),
    closedReplies:
      rounds.length > 0 &&
      rounds.every(
        entry => entry.ackClosed === true && entry.resultClosed === true,
      ),
    noStrayReplies: rounds.every(
      entry => (entry.unexpected ?? []).length === 0,
    ),
    resolvedByRegistry:
      rounds.length > 0 &&
      rounds.every(entry => entry.resolvedByRegistry === true),
  }

  return {
    expectedRounds: options.expectedRounds,
    rounds: rounds.length,
    complete: complete.length,
    ackLimitMs: options.ackLimitMs,
    resultLimitMs: options.resultLimitMs,
    sendToAck,
    sendToResult,
    checks,
    pass: Object.values(checks).every(Boolean),
    entries: rounds,
  }
}
