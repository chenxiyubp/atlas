// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P1.2 —— AC-1 核验脚本的公共部分。
 *
 * 这些脚本只驱动基座**自己的**会话读写函数（`recordTranscript` /
 * `loadConversationForResume` / `getLastSessionLog`），不另写一套持久化实现——
 * 核验型任务测的是基座既有实现，不是我们的替身。
 *
 * 隔离：一律通过 `OCC_CONFIG_DIR` 把配置根指向临时目录，绝不读写用户真实的
 * 配置根（`~/.occ` / `~/.qianmo`），也不触碰任何凭据。
 */
import type { Message } from '../../src/types/message.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../src/utils/messages/constructors.js'

// 命令行与输出工具搬到了 `cli-args.ts`（AC-2 的脚本也要用，而它们不该为了读一个
// `--flag` 把基座的消息构造函数一起加载进来）。这里原样转出，四个既有调用点不动。
export { arg, emit, intArg } from './cli-args.js'

/**
 * 造一段 user/assistant 交替的合成对话。
 *
 * `filler` 把单条消息撑到接近真实体量（真实会话里工具结果动辄几 KB）。
 * `startIndex` 让跨片调用仍保持 user/assistant 交替。
 *
 * **不要在这里设时间戳**：`insertMessageChain` 在 `...message` 展开之后
 * 无条件用 `new Date().toISOString()` 覆盖它（`transcriptWriter.ts:866-879`），
 * 消息自带的时间戳到不了磁盘。想让条目之间的时间戳不并列，唯一的办法是
 * **两次 `recordTranscript` 之间真的隔开一点墙钟时间**（见 `ac1-gen-history.ts`
 * 的片间间隔）。并列会让 `--resume` 丢尾部消息，理由见
 * `docs/dev/session-persistence-review.md` §1.5。
 */
export function synthTurns(
  count: number,
  fillerBytes = 512,
  startIndex = 0,
): Message[] {
  const filler = 'x'.repeat(fillerBytes)
  const out: Message[] = []
  for (let i = 0; i < count; i++) {
    const n = startIndex + i
    out.push(
      n % 2 === 0
        ? createUserMessage({ content: `turn ${n} ${filler}` })
        : createAssistantMessage({ content: `reply ${n} ${filler}` }),
    )
  }
  return out
}

/** 一条带 `tool_use` 的 assistant 消息 —— 用于「工具执行中」崩溃点。 */
export function toolUseTurn(toolUseId: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: { command: 'sleep 30' },
      },
    ],
  })
}
