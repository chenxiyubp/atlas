// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 在三个指定崩溃点上被 `kill -9` 的写入进程。
 *
 *   bun run demo/lib/ac1-crash-writer.ts --point write|snapshot|tool \
 *        --session <uuid> --out <file>
 *
 * 三个崩溃点（roadmap P1.2 交付物明列）：
 *
 * - `write`    —— **写事件中**：前若干轮已落盘，随后一批消息**已入写队列、
 *                 尚未 drain**（`FLUSH_INTERVAL_MS = 100`，
 *                 `transcriptWriter.ts:307`）时进程死亡。这是真正的「丢失窗口」。
 * - `snapshot` —— **快照中**：`recordFileHistorySnapshot` 已入队未落盘时死亡。
 * - `tool`     —— **工具执行中**：带 `tool_use` 的 assistant 消息已落盘、
 *                 对应 `tool_result` 永远不会写出，进程停在这里等外部 `kill -9`。
 *
 * SIGKILL 的投递方式：
 * - `write` / `snapshot` 由进程**自杀**（`process.kill(pid,'SIGKILL')`）——
 *   崩溃点必须落在「已入队、未 drain」这个 100 ms 窗口内，从 shell 发信号
 *   赢不了这个竞态。自杀与外部 kill -9 语义完全一致：不可捕获、不跑任何
 *   清理钩子（基座把 flush 注册成退出清理钩子，`transcriptWriter.ts:186-195`，
 *   SIGKILL 一律绕过）。
 * - `tool` 由 shell 发**真正的外部 `kill -9`**：该点的状态是静止的，没有竞态。
 *
 * `--out` 里同步落一份现场记录（stdout 在 SIGKILL 下可能连管道都没冲出去）。
 */
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { switchSession } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import {
  flushSessionStorage,
  recordFileHistorySnapshot,
  recordTranscript,
  resetSessionFilePointer,
} from '../../src/utils/sessionStorage/transcriptWriter.js'
import { arg, synthTurns, toolUseTurn } from './ac1-common.js'

const point = arg('point') ?? 'write'
const sessionId = arg('session') ?? randomUUID()
const out = arg('out')

function note(payload: Record<string, unknown>): void {
  const line = `${JSON.stringify({ point, sessionId, ...payload })}\n`
  if (out) writeFileSync(out, line)
  process.stdout.write(line)
}

switchSession(asSessionId(sessionId), null)
await resetSessionFilePointer()

// 崩溃前的稳定前缀：4 轮，逐片写 + 落盘（片间留 1 ms，理由见 ac1-gen-history.ts）。
let parent = (await recordTranscript(synthTurns(2, 64, 0))) ?? undefined
await flushSessionStorage()
await new Promise(resolve => setTimeout(resolve, 2))
parent =
  (await recordTranscript(synthTurns(2, 64, 2), undefined, parent)) ?? undefined
await flushSessionStorage()
await new Promise(resolve => setTimeout(resolve, 2))

if (point === 'tool') {
  const toolUseId = 'toolu_ac1_crash_probe'
  parent =
    (await recordTranscript([toolUseTurn(toolUseId)], undefined, parent)) ??
    undefined
  await flushSessionStorage()
  note({ stage: 'tool-use-persisted', toolUseId, pid: process.pid })
  // 工具「正在执行」：tool_result 永远不会写出。停在这里等外部 kill -9。
  await new Promise(() => {})
} else if (point === 'snapshot') {
  const snapshotMessageId = randomUUID()
  note({ stage: 'about-to-lose-snapshot', snapshotMessageId, pid: process.pid })
  void recordFileHistorySnapshot(
    snapshotMessageId,
    {
      messageId: snapshotMessageId,
      trackedFileBackups: {},
      timestamp: new Date(),
    },
    false,
  )
  // 下一个宏任务即杀：快照条目已入队，100 ms 的 drain 定时器还没到点。
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 0)
} else {
  const lost = synthTurns(2, 64, 4)
  note({
    stage: 'about-to-lose-writes',
    lostUuids: lost.map(m => m.uuid),
    pid: process.pid,
  })
  void recordTranscript(lost, undefined, parent)
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 0)
}
