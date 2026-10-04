// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 合成会话历史（走基座真实写入路径 `recordTranscript`，不手写 JSONL）。
 *
 *   bun run demo/lib/ac1-gen-history.ts --sessions 200 --msgs 40 \
 *        --target <uuid> --target-msgs 4000
 *
 * `--sessions`：项目目录下**旁路**会话文件数 —— `--continue` 的成本随它增长。
 * `--target-msgs`：目标会话自身的消息数 —— `--resume <id>` 的成本随它增长。
 *
 * 两个刻意的实现细节：
 *
 * 1. **分片写**。写队列在 1000 条时丢弃最旧条目并 reject
 *    （`transcriptWriter.ts:374-383`），一次塞几千条会真的丢数据。
 * 2. **目标会话分小片 + 片间等 1 ms**。`insertMessageChain` 在
 *    `...message` 展开之后无条件用 `new Date().toISOString()` 覆盖时间戳
 *    （`transcriptWriter.ts:866-879`），同一片里的条目因此共用一个毫秒；
 *    而 `--resume` 的锚点是「时间戳最大者，并列取先出现的」
 *    （`logAssembly.ts:27-42, 487`）。不留间隔就会把整个目标会话压成一个
 *    时间点，锚点落到首条上、链条只剩一条 —— 那是合成数据的假象，会掩盖
 *    真实的加载成本。并列本身是真实边界，单独由 `ac1-tie-check.ts` 验证。
 */
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { getOriginalCwd, switchSession } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import { getProjectDir } from '../../src/utils/sessionStorage/paths.js'
import {
  flushSessionStorage,
  recordTranscript,
  resetSessionFilePointer,
} from '../../src/utils/sessionStorage/transcriptWriter.js'
import { arg, emit, intArg, synthTurns } from './ac1-common.js'

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

async function writeSession(
  sessionId: string,
  msgs: number,
  sliceSize: number,
  gapMs: number,
): Promise<void> {
  switchSession(asSessionId(sessionId), null)
  await resetSessionFilePointer()
  let parent: UUID | undefined
  for (let written = 0; written < msgs; written += sliceSize) {
    const slice = synthTurns(Math.min(sliceSize, msgs - written), 512, written)
    parent = (await recordTranscript(slice, undefined, parent)) ?? undefined
    await flushSessionStorage()
    if (gapMs > 0) await sleep(gapMs)
  }
}

const sessions = intArg('sessions', 5)
const msgs = intArg('msgs', 40)
const targetMsgs = intArg('target-msgs', 40)
const targetSlice = intArg('target-slice', 4)
const targetGap = intArg('target-gap', 1)
const target = arg('target') ?? randomUUID()

const t0 = performance.now()
for (let i = 0; i < sessions; i++) {
  await writeSession(randomUUID(), msgs, 200, 0)
}
await writeSession(target, targetMsgs, targetSlice, targetGap)
const elapsedMs = performance.now() - t0

emit({
  projectDir: getProjectDir(getOriginalCwd()),
  target,
  sessions,
  msgsPerSession: msgs,
  targetMsgs,
  elapsedMs: Math.round(elapsedMs),
})
