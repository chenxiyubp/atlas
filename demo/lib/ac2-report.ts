// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P2.5 —— 把 activator 写出的逐条结局翻成分阶段耗时。
 *
 *   bun run demo/lib/ac2-report.ts --timings <file> --msg-id <id>   # 单轮
 *   bun run demo/lib/ac2-report.ts --timings <file>                 # 汇总
 *
 * 四个阶段的切法与 `packages/activator/src/stages.ts` 完全一致，并且**直接调它
 * 的 `durationsOf` / `TimingRecorder`**，不在这里重算一遍：同一个口径存两份，
 * 迟早会出现「报告说 9 秒、代码说 10 秒」而没人知道哪个对。
 *
 * 分位数用最近秩（nearest-rank），报告里的每个数都是真实发生过的一次测量，
 * 不是插值出来的。样本只有 10 个时这一点尤其重要。
 */

import { readFileSync } from 'node:fs'
import {
  type ActivationOutcome,
  type StageTimings,
  TimingRecorder,
  durationsOf,
} from '@qianmo/activator'
import { arg, emit } from './cli-args.js'

const file = arg('timings')
if (file === undefined)
  throw new Error('用法：--timings <file> [--msg-id <id>]')

let raw = ''
try {
  raw = readFileSync(file, 'utf8')
} catch {
  // 一条都还没写出来是可能的（activator 刚起、或者第一轮就没接住）。
  // 报空比报错有用：调用方要的是「几条」，不是一次异常。
  raw = ''
}

const outcomes: ActivationOutcome[] = []
for (const line of raw.split('\n')) {
  if (line.trim() === '') continue
  try {
    outcomes.push(JSON.parse(line) as ActivationOutcome)
  } catch {
    // 半写行：进程正在追加时读到过一次。跳过，别让它带塌整份报告。
  }
}

const timed = outcomes.filter(
  (outcome): outcome is Extract<ActivationOutcome, { timings: StageTimings }> =>
    outcome.status !== 'refused',
)

const wanted = arg('msg-id')
if (wanted !== undefined) {
  const match = timed.find(outcome => outcome.timings.msgId === wanted)
  if (match === undefined) {
    emit({ msgId: wanted, found: false })
    process.exit(1)
  }
  emit({
    msgId: wanted,
    found: true,
    status: match.status,
    ...(match.status === 'failed' ? { reason: match.reason } : {}),
    sandbox: match.timings.sandboxName,
    // 接住 → 发起唤醒 → ready → 首字节转发。缺哪一段就是没走到那一步。
    ...durationsOf(match.timings),
  })
  process.exit(match.status === 'forwarded' ? 0 : 1)
}

const recorder = new TimingRecorder(Math.max(1, timed.length))
for (const outcome of timed) recorder.record(outcome.timings)
emit({
  refused: outcomes.length - timed.length,
  ...recorder.report(),
})
