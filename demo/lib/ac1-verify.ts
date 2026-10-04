// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 崩溃后一致性核验：把会话按 `--resume <id>` 的真实路径读回来，报告事实。
 *
 *   bun run demo/lib/ac1-verify.ts --session <uuid>
 *
 * 输出 JSON：
 *   sessionId        —— 读回来的 session_id（AC-1 第一条判据）
 *   messageCount     —— 反序列化后的消息条数
 *   rawLines         —— 磁盘 JSONL 的物理行数
 *   malformedLines   —— 其中 `JSON.parse` 失败的行数（半写行走的就是这条）
 *   danglingToolUse  —— 反序列化后仍无配对 `tool_result` 的 `tool_use` 数
 *                       （必须为 0：未配对的 tool_use 会被 API 拒绝）
 *   rawToolUse / rawToolResult —— 磁盘上的原始计数，用来证明确实制造出了
 *                       「有 tool_use 没有 tool_result」的现场
 */
import { readFileSync } from 'fs'
import { getOriginalCwd } from '../../src/bootstrap/state.js'
import type { Message } from '../../src/types/message.js'
import { loadConversationForResume } from '../../src/utils/session/conversationRecovery.js'
import { getProjectDir } from '../../src/utils/sessionStorage/paths.js'
import { arg, emit } from './ac1-common.js'

type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown }

function blocks(message: Message): Block[] {
  const inner: unknown = (message as { message?: unknown }).message
  if (typeof inner !== 'object' || inner === null) return []
  const content: unknown = (inner as { content?: unknown }).content
  return Array.isArray(content) ? (content as Block[]) : []
}

const session = arg('session')
if (!session) throw new Error('需要 --session <uuid>')

const file = `${getProjectDir(getOriginalCwd())}/${session}.jsonl`
let raw = ''
try {
  raw = readFileSync(file, 'utf8')
} catch {
  raw = ''
}
const physicalLines = raw.split('\n').filter(l => l.length > 0)
let malformedLines = 0
let rawToolUse = 0
let rawToolResult = 0
for (const line of physicalLines) {
  try {
    JSON.parse(line)
  } catch {
    malformedLines++
    continue
  }
  // 原始计数按字符串扫，避免为此写一套 entry 类型
  if (line.includes('"type":"tool_use"')) rawToolUse++
  if (line.includes('"type":"tool_result"')) rawToolResult++
}

const result = await loadConversationForResume(session, undefined)
const messages: Message[] = result?.messages ?? []

const toolUseIds = new Set<string>()
const toolResultIds = new Set<string>()
for (const m of messages) {
  for (const b of blocks(m)) {
    if (b.type === 'tool_use' && typeof b.id === 'string') toolUseIds.add(b.id)
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      toolResultIds.add(b.tool_use_id)
    }
  }
}
let danglingToolUse = 0
for (const id of toolUseIds) {
  if (!toolResultIds.has(id)) danglingToolUse++
}

emit({
  sessionId: result?.sessionId ?? null,
  found: result !== null,
  messageCount: messages.length,
  rawLines: physicalLines.length,
  rawBytes: raw.length,
  malformedLines,
  rawToolUse,
  rawToolResult,
  loadedToolUse: toolUseIds.size,
  danglingToolUse,
})
