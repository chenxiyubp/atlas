// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P7.1 —— 混沌跑批的判据。
 *
 * DoD 的原文是「混沌注入 1 小时无未捕获异常（**有捕获的失败要能对应到已知边界**）」。
 * 后半句才是难的那一半，也是这份报告的重心：
 *
 * - **未捕获异常必须为 0**。这条容易验，也容易骗——什么都不干的一小时同样是 0。
 * - **所以还要验「注入之后系统还在干活」**。每次注入之后必须有新的消息真的被处理；
 *   一次让系统悄悄停摆的注入，在只看异常数的报告里长得跟一次完美恢复一模一样。
 * - **每一条被捕获的失败都要能对上已知边界**。对不上的进 `unmapped`，一条就判不通过：
 *   「我们见到了一个说不出名字的错误，但它没让进程崩」不是通过的理由，是下一个任务包
 *   的输入。
 * - **每一类注入都要真的注入过**。四类里有一类没跑到（例如这台机器造不出 ENOSPC），
 *   报告如实记为 skipped 并判不通过——四类里跑了三类的报告，不是四类的证据。
 */

/** 四类注入，与 `tests/boundary/chaos-recovery.test.ts` 的四组一一对应。 */
export type InjectionKind =
  | 'kill-worker'
  | 'cut-network'
  | 'fill-disk'
  | 'clock-drift'

export const INJECTION_KINDS: readonly InjectionKind[] = Object.freeze([
  'kill-worker',
  'cut-network',
  'fill-disk',
  'clock-drift',
])

/** 一次注入及其后果。 */
export interface InjectionRecord {
  readonly kind: InjectionKind
  readonly at: number
  /** 注入之后系统又处理成功了多少条消息。0 表示它就此停摆。 */
  readonly progressAfter: number
  /** 恢复用了多久（ms），拿不到就是 -1。 */
  readonly recoveredInMs: number
}

/** 一条被捕获的失败。 */
export interface CapturedFailure {
  readonly at: number
  /** 原样保留的错误摘要，用于对照已知边界。 */
  readonly summary: string
  /** 对上了哪条已知边界；对不上就是 null。 */
  readonly boundary: string | null
}

export interface ChaosObservations {
  readonly durationMs: number
  readonly seed: number
  readonly injections: readonly InjectionRecord[]
  readonly skipped: readonly {
    readonly kind: InjectionKind
    readonly reason: string
  }[]
  readonly failures: readonly CapturedFailure[]
  /** 进程级 `uncaughtException` / `unhandledRejection` 的条数。 */
  readonly uncaught: number
  /** 全程成功处理的消息总数。 */
  readonly delivered: number
  /** 审计链在跑批结束时是否完好。 */
  readonly trailIntact: boolean
}

export interface ChaosReport extends ChaosObservations {
  readonly byKind: readonly {
    readonly kind: InjectionKind
    readonly count: number
    readonly stalled: number
  }[]
  readonly unmapped: readonly CapturedFailure[]
  readonly checks: {
    readonly noUncaught: boolean
    readonly everyKindInjected: boolean
    readonly systemKeptWorking: boolean
    readonly everyFailureMapped: boolean
    readonly trailIntact: boolean
  }
  readonly pass: boolean
}

export function buildChaosReport(observations: ChaosObservations): ChaosReport {
  const byKind = INJECTION_KINDS.map(kind => {
    const mine = observations.injections.filter(entry => entry.kind === kind)
    return {
      kind,
      count: mine.length,
      // 「注入之后一条都没再处理成功」——系统停摆了，只是没抛异常。
      stalled: mine.filter(entry => entry.progressAfter === 0).length,
    }
  })
  const unmapped = observations.failures.filter(
    failure => failure.boundary === null,
  )

  const checks = {
    noUncaught: observations.uncaught === 0,
    everyKindInjected:
      observations.skipped.length === 0 &&
      byKind.every(entry => entry.count > 0),
    systemKeptWorking:
      observations.delivered > 0 && byKind.every(entry => entry.stalled === 0),
    everyFailureMapped: unmapped.length === 0,
    trailIntact: observations.trailIntact,
  }

  return {
    ...observations,
    byKind,
    unmapped,
    checks,
    pass: Object.values(checks).every(Boolean),
  }
}
