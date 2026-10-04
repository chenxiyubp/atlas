// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P5.1 —— 把「注入了什么」与「分类成了什么」合成准确率报告。
 *
 * 判据（roadmap P5.1 DoD）：注入 5 类各 10 次、50 条样本、**准确率 ≥ 80%**，
 * 且输出**明确报出原因类型**而不是「执行失败」。
 *
 * 三条留痕规则：
 * 1. **每类单独算一次准确率**，不只算总数。总体 80% 可以由四类满分 + 一类全错凑
 *    出来，而那正是最该被看见的情况；
 * 2. **被跳过的类别不缩小分母、直接判不通过**：拿不到真实注入条件时报告要说
 *    「这次只测了四类」，而不是拿四类的成绩去代表五类；
 * 3. **`unknown` 一律算错**。它在生产里是诚实的答案，在这份判据里不是——DoD 要的
 *    就是「报出原因类型」。
 */

export interface ClassifiedSample {
  /** 人工标注（注入器知道的真相）。 */
  readonly label: string
  /** 分类器的答案，只看 observation 得到。 */
  readonly predicted: string
  readonly confidence: string
  readonly evidence: readonly string[]
  readonly how: string
}

export interface CategoryAccuracy {
  readonly label: string
  readonly injected: number
  readonly correct: number
  readonly accuracy: number
}

export interface P51Observations {
  readonly expectedCategories: readonly string[]
  readonly perCategory: number
  readonly samples: readonly ClassifiedSample[]
  readonly skipped: readonly {
    readonly label: string
    readonly reason: string
  }[]
  readonly threshold: number
}

export interface P51Report {
  readonly threshold: number
  readonly perCategory: number
  readonly total: number
  readonly correct: number
  readonly accuracy: number
  readonly byCategory: readonly CategoryAccuracy[]
  readonly skipped: readonly {
    readonly label: string
    readonly reason: string
  }[]
  readonly checks: {
    readonly allCategoriesInjected: boolean
    readonly enoughSamplesPerCategory: boolean
    readonly overallAccuracyMet: boolean
    readonly everyCategoryAboveHalf: boolean
    readonly noUnknownVerdicts: boolean
    readonly everyVerdictHasEvidence: boolean
  }
  readonly pass: boolean
}

export function buildP51Report(observations: P51Observations): P51Report {
  const byCategory: CategoryAccuracy[] = observations.expectedCategories.map(
    label => {
      const mine = observations.samples.filter(sample => sample.label === label)
      const correct = mine.filter(
        sample => sample.predicted === sample.label,
      ).length
      return {
        label,
        injected: mine.length,
        correct,
        accuracy: mine.length === 0 ? 0 : correct / mine.length,
      }
    },
  )
  const total = observations.samples.length
  const correct = observations.samples.filter(
    sample => sample.predicted === sample.label,
  ).length
  const accuracy = total === 0 ? 0 : correct / total

  const checks = {
    allCategoriesInjected:
      observations.skipped.length === 0 &&
      byCategory.every(entry => entry.injected > 0),
    enoughSamplesPerCategory: byCategory.every(
      entry => entry.injected >= observations.perCategory,
    ),
    overallAccuracyMet: accuracy >= observations.threshold,
    // 一类全错而总体仍达标，是这份判据最容易被蒙混过去的地方。
    everyCategoryAboveHalf: byCategory.every(entry => entry.accuracy > 0.5),
    noUnknownVerdicts: observations.samples.every(
      sample => sample.predicted !== 'unknown',
    ),
    everyVerdictHasEvidence: observations.samples.every(
      sample => sample.evidence.length > 0,
    ),
  }

  return {
    threshold: observations.threshold,
    perCategory: observations.perCategory,
    total,
    correct,
    accuracy,
    byCategory,
    skipped: observations.skipped,
    checks,
    pass: Object.values(checks).every(Boolean),
  }
}
