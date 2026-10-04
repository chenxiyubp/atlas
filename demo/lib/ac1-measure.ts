// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 测量两个恢复入口的加载成本（冷进程，一次一测）。
 *
 *   bun run demo/lib/ac1-measure.ts --entry resume --session <uuid>
 *   bun run demo/lib/ac1-measure.ts --entry continue
 *
 * 调的是 `--resume` / `--continue` 在 `conversationRecovery.ts:508-550` 里
 * **各自实际走的那一条分支**，参数形态与 CLI 一致：
 *   `--continue`  → loadConversationForResume(undefined, undefined)
 *   `--resume id` → loadConversationForResume(id, undefined)
 *
 * 输出 JSON：loadMs（加载耗时）、sinceProcessStartMs（进程内累计，含模块加载）、
 * sessionId（用于 AC-1 的 session_id 一致性判据）、messageCount。
 */
import { loadConversationForResume } from '../../src/utils/session/conversationRecovery.js'
import { arg, emit } from './ac1-common.js'

const entry = arg('entry') ?? 'resume'
const session = arg('session')

if (entry === 'resume' && !session) {
  throw new Error('--entry resume 需要 --session <uuid>')
}

const t0 = performance.now()
const result = await loadConversationForResume(
  entry === 'continue' ? undefined : session,
  undefined,
)
const loadMs = performance.now() - t0

emit({
  entry,
  requestedSession: session ?? null,
  loadMs: Math.round(loadMs),
  sinceProcessStartMs: Math.round(performance.now()),
  sessionId: result?.sessionId ?? null,
  messageCount: result?.messages.length ?? 0,
  found: result !== null,
})
