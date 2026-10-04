// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

export type P61Mode = 'smoke' | 'acceptance'
export type P61Beat = 1 | 2 | 3 | 4 | 5 | 6

export interface P61BeatObservation {
  readonly beat: P61Beat
  readonly at: number
  readonly ok: boolean
  readonly note?: string
}

export interface P61Observations {
  readonly mode: P61Mode
  readonly startedAt: number
  readonly durationMs: number
  readonly requiredDurationMs: number
  readonly seed: number
  readonly taskId: string
  /**
   * 两个运行时各自的版本，元数据而非判据。
   *
   * runner 与包组合跑在 Bun 上，帧 2 的 32 MB heap OOM 子进程跑在 PATH 里的
   * node 上——两条都影响这轮跑批还原得出来还原不出来，所以随报告一起留档。
   * 取不到时留空串：没量到就写没量到，不拿本进程的版本冒充子进程的。
   */
  readonly versions: {
    readonly bun: string
    readonly node: string
  }
  readonly beats: readonly P61BeatObservation[]
  readonly diagnosis: {
    readonly cause: string
    readonly confidence: string
    readonly evidence: readonly string[]
    readonly runtime: string
  }
  readonly negotiation: {
    readonly leased: boolean
    readonly requested: {
      readonly durationMs: number
      readonly cpuCores: number
      readonly memoryMb: number
    }
    readonly granted: {
      readonly durationMs: number
      readonly cpuCores: number
      readonly memoryMb: number
    }
    readonly offerId: string
  }
  readonly authorization: {
    readonly mode: 'scripted-hook'
    readonly authorized: boolean
    readonly minted: boolean
    readonly tokenVerified: boolean
    readonly act: string
  }
  readonly tunnel: {
    /**
     * 隧道宿主自己数到的「接下来的工作条数」。
     *
     * 这里只留一个数。`TunnelHost` 内部就是一个计数器，`admitted` 与 `carried`
     * 是它对外的两个名字、不是两个量；早先报告里并排放着这两个字段，看上去像
     * 两处独立观测，实际同源——判据里那条 `carried >= chunks - 1` 于是永远为真，
     * 而 fixture 里 `admitted: 20, carried: 0` 守的是 runner 造不出来的状态。
     * 真正的拆分只在审计侧（`tunnel.admitted` 一条、`tunnel.carried` N-1 条），
     * 那是从磁盘读回来的另一个来源，判据改去核对它。
     */
    readonly takenWork: number
    readonly closedReason: string | null
  }
  readonly compute: {
    readonly chunks: number
    readonly completed: number
    readonly workerOks: number
    readonly spanMs: number
    readonly resultDigest: string
    readonly expectedDigest: string
  }
  readonly teardown: {
    readonly redialFailed: boolean
    readonly lenderPending: number
    readonly released: boolean
    readonly openedClosedBalanced: boolean
  }
  readonly background: {
    readonly delivered: number
    readonly deliveredAfterTeardown: number
    /**
     * 本轮观测到的未捕获异常与未处理拒绝条数。
     *
     * 判据要它为 0，而「为 0」只有在 runner **真的装了**
     * `uncaughtException` / `unhandledRejection` 处理器时才是一次观测；
     * 没装处理器时填 0 等于自证清白，那条 check 就永远不会红。
     */
    readonly uncaught: number
  }
  readonly trail: {
    readonly intact: boolean
    readonly counts: Readonly<Record<string, number>>
  }
  readonly failures: readonly {
    readonly at: number
    readonly summary: string
    readonly boundary: string | null
  }[]
  /**
   * 计划了却没做成的事，同样必须是**算出来的差集**而不是宣称的空数组。
   *
   * runner 侧的来源是「计划块集合 − 实际派发记录」：派发循环中途抛错时后面
   * 那些块一条也不会发出去，它们就是这一轮真正被跳过的部分。
   */
  readonly skipped: readonly {
    readonly what: string
    readonly reason: string
  }[]
}

export interface P61Report extends P61Observations {
  readonly checks: {
    readonly taskSubmitted: boolean
    readonly diagnosisNamesOom: boolean
    readonly leaseNegotiated: boolean
    readonly authorizedAndTokenMinted: boolean
    readonly computedOnBorrowedResource: boolean
    readonly tunnelTornDownClean: boolean
    readonly continuousNoIntervention: boolean
  }
  readonly ac7Eligible: boolean
  readonly pass: boolean
}

function beatPassed(observations: P61Observations, beat: P61Beat): boolean {
  return observations.beats.some(entry => entry.beat === beat && entry.ok)
}

function count(observations: P61Observations, kind: string): number {
  return observations.trail.counts[kind] ?? 0
}

function grantWithinRequest(observations: P61Observations): boolean {
  const { requested, granted } = observations.negotiation
  return (
    granted.durationMs <= requested.durationMs &&
    granted.cpuCores <= requested.cpuCores &&
    granted.memoryMb <= requested.memoryMb
  )
}

export function buildP61Report(observations: P61Observations): P61Report {
  const checks = {
    taskSubmitted:
      beatPassed(observations, 1) &&
      count(observations, 'p61.task-submitted') > 0,
    diagnosisNamesOom:
      beatPassed(observations, 2) &&
      observations.diagnosis.cause === 'oom' &&
      observations.diagnosis.evidence.length > 0 &&
      count(observations, 'qianmo.diagnosis.v1') > 0,
    leaseNegotiated:
      beatPassed(observations, 3) &&
      observations.negotiation.leased &&
      observations.negotiation.offerId.length > 0 &&
      grantWithinRequest(observations) &&
      count(observations, 'negotiation.offered') > 0 &&
      count(observations, 'negotiation.leased') > 0,
    authorizedAndTokenMinted:
      beatPassed(observations, 4) &&
      observations.authorization.mode === 'scripted-hook' &&
      observations.authorization.authorized &&
      observations.authorization.minted &&
      observations.authorization.tokenVerified &&
      observations.authorization.act === 'user-confirmed' &&
      count(observations, 'p61.user-authorized') > 0,
    computedOnBorrowedResource:
      beatPassed(observations, 5) &&
      observations.compute.chunks > 0 &&
      observations.compute.completed === observations.compute.chunks &&
      observations.compute.workerOks === observations.compute.chunks &&
      observations.compute.resultDigest ===
        observations.compute.expectedDigest &&
      observations.compute.spanMs >= observations.requiredDurationMs * 0.7 &&
      observations.tunnel.takenWork === observations.compute.chunks &&
      count(observations, 'tunnel.opened') > 0 &&
      // 审计侧的拆分要自己对上：首条 admitted、其余 carried。宿主的计数器与这
      // 两个数出自不同来源，两边同时成立才说明「工作确实是从隧道进去的」。
      count(observations, 'tunnel.admitted') === 1 &&
      count(observations, 'tunnel.carried') >=
        observations.compute.chunks - 1 &&
      count(observations, 'p61.chunk-completed') >= observations.compute.chunks,
    tunnelTornDownClean:
      beatPassed(observations, 6) &&
      observations.teardown.redialFailed &&
      observations.teardown.lenderPending === 0 &&
      observations.teardown.released &&
      observations.teardown.openedClosedBalanced &&
      observations.tunnel.closedReason === 'released' &&
      count(observations, 'tunnel.closed') > 0 &&
      count(observations, 'negotiation.released') > 0,
    continuousNoIntervention:
      observations.durationMs >= observations.requiredDurationMs &&
      observations.background.delivered > 0 &&
      observations.background.deliveredAfterTeardown > 0 &&
      observations.background.uncaught === 0 &&
      observations.failures.length === 0 &&
      observations.skipped.length === 0 &&
      observations.trail.intact,
  }
  const pass = Object.values(checks).every(Boolean)
  const ac7Eligible =
    observations.mode === 'acceptance' &&
    observations.durationMs >= 600_000 &&
    pass
  return { ...observations, checks, ac7Eligible, pass }
}
