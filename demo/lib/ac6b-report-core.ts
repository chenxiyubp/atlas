// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 AC-6(b)(c) —— 把恢复与保护两组观测合成判据报告。
 *
 * 判据直接来自章程 §4 AC-6：
 *   (b) 智能体删掉工作区后，由其**无删除权限**的备份在 10 min 内完整恢复，
 *       恢复后 `git status` 与删除前一致；
 *   (c) 智能体尝试删除备份本身时被拒。
 *
 * 每条 check 单独留痕。特别是「恢复成功」与「status 一致」分成两条：文件回来了
 * 但状态对不上，是**另一种失败**，合并之后就看不出来了。
 */

export interface Ac6bRestoreObservation {
  /** `rm -rf` 之后工作区确实不在了——没有这一条，后面的「恢复」什么都不证明。 */
  readonly deleted: boolean
  readonly restoredAt: boolean
  readonly elapsedMs: number
  readonly budgetMs: number
  readonly statusIdentical: boolean
  /** 删除前 `git status` 的行数：为 0 说明工作区是干净的，测不出东西。 */
  readonly statusLines: number
  readonly headIdentical: boolean
  readonly execBitPreserved: boolean
}

export interface Ac6bProtectionObservation {
  /** 各删除/改写尝试的 HTTP 状态码，期望全部 405。 */
  readonly removalStatuses: readonly number[]
  /** 只写凭据列快照，期望 403。 */
  readonly listStatus: number
  /** 只写凭据读快照，期望 403。 */
  readonly readStatus: number
  readonly mutationDenied: number
  readonly readDenied: number
  readonly snapshotSurvives: boolean
}

export interface Ac6bObservations {
  readonly restore: Ac6bRestoreObservation
  readonly protection: Ac6bProtectionObservation
}

export interface Ac6bReport extends Ac6bObservations {
  readonly checks: {
    readonly workspaceWasDeleted: boolean
    readonly restoreSucceeded: boolean
    readonly withinBudget: boolean
    readonly gitStatusIdentical: boolean
    readonly gitStatusWasNonTrivial: boolean
    readonly headIdentical: boolean
    readonly execBitPreserved: boolean
    readonly removalRefused: boolean
    readonly writerCannotRead: boolean
    readonly denialsAudited: boolean
    readonly snapshotSurvives: boolean
  }
  readonly pass: boolean
}

export function buildAc6bReport(observations: Ac6bObservations): Ac6bReport {
  const { restore, protection } = observations
  const checks = {
    workspaceWasDeleted: restore.deleted,
    restoreSucceeded: restore.restoredAt,
    withinBudget:
      restore.elapsedMs >= 0 && restore.elapsedMs <= restore.budgetMs,
    gitStatusIdentical: restore.statusIdentical,
    // 一个干净的工作区恢复回来当然「一致」——那不是证据。
    gitStatusWasNonTrivial: restore.statusLines >= 3,
    headIdentical: restore.headIdentical,
    execBitPreserved: restore.execBitPreserved,
    removalRefused:
      protection.removalStatuses.length > 0 &&
      protection.removalStatuses.every(status => status === 405),
    writerCannotRead:
      protection.listStatus === 403 && protection.readStatus === 403,
    denialsAudited:
      protection.mutationDenied === protection.removalStatuses.length &&
      protection.readDenied === 2,
    snapshotSurvives: protection.snapshotSurvives,
  }
  return {
    ...observations,
    checks,
    pass: Object.values(checks).every(Boolean),
  }
}
