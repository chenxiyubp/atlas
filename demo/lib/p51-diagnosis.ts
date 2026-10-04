// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P5.1 / AC-7 环节 2 一键复现 —— 注入五类真实故障，盲分类，报准确率。
 *
 *   bun run demo/lib/p51-diagnosis.ts [--per-category 10]
 *
 * 注入器造的是**真的失败**（怎么造见 `p51-inject.ts` 的表），标注只进报告，
 * 分类器只看 observation。报告里每类单独算准确率，被跳过的类别不缩小分母。
 *
 * 报告里不含捕获正文——失败输出里可能有路径、主机名甚至令牌。留下的是每条样本的
 * 标注、判定、置信度与**分类依据**（依据本身是我们自己生成的短句，不是原始日志）。
 */

import {
  classifyFailure,
  FAILURE_CAUSES,
  FailureCause,
} from '@qianmo/diagnosis'
import { emit, intArg } from './cli-args.js'
import { injectFailures } from './p51-inject.js'
import { buildP51Report, type ClassifiedSample } from './p51-report-core.js'

const perCategory = intArg('per-category', 10)
const threshold = 0.8

const run = await injectFailures(perCategory)
const samples: ClassifiedSample[] = run.samples.map(sample => {
  // 盲分类：这里只传 observation，标注不参与。
  const diagnosis = classifyFailure(sample.observation)
  return {
    label: sample.label,
    predicted: diagnosis.cause,
    confidence: diagnosis.confidence,
    evidence: diagnosis.evidence,
    how: sample.how,
  }
})

const report = buildP51Report({
  expectedCategories: FAILURE_CAUSES.filter(
    cause => cause !== FailureCause.Unknown,
  ),
  perCategory,
  samples,
  skipped: run.skipped.map(entry => ({
    label: entry.label,
    reason: entry.reason,
  })),
  threshold,
})

emit({ ...report, samples })
process.exitCode = report.pass ? 0 : 1
