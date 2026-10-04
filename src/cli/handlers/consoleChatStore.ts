// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the control console keeps its conversations.
 *
 * An append-only NDJSON file, one record per line, replayed on start. Same
 * shape as the two other durable logs in this codebase (`@qianmo/audit`'s
 * trail, the resident's admission ledger) and for the same reasons: a partial
 * write costs the last line rather than the file, and a crash mid-turn cannot
 * leave a half-rewritten transcript behind.
 *
 * ## Two record kinds, and the second one repeats itself
 *
 * `session` is written once. `turn` is written **again in full** every time the
 * turn changes — sent, receipted, read, answered — and replay keeps the last
 * record for each id. That is deliberately not a patch log: a patch log needs a
 * merge function, the merge function needs to agree with the writer, and the
 * whole point of a four-state turn is that the states arrive out of order when
 * the network misbehaves. Four copies of a small object are cheaper than one
 * merge rule nobody re-reads.
 *
 * Volume makes this affordable and is worth stating so the next reader does not
 * generalise it: the writer here is a person typing. Compaction is a non-goal.
 *
 * **That sentence stopped being the whole truth when progress rows arrived**
 * (`variant: 'notice'`): those are written by the node, not by a person, up to
 * a couple of dozen per turn. What keeps the assumption standing is a ceiling
 * on the other side rather than compaction on this one — `MAX_NOTICES_PER_SESSION`
 * in `consoleChat.ts`, whose note carries the arithmetic. Raising that number
 * without revisiting this paragraph is how a log with no compaction becomes a
 * log with no bound.
 *
 * ## What is *not* here
 *
 * The path. It arrives from `consoleArgs.ts`, derived from `occConfigPath()`
 * like every other identity-bearing path in this repository (CLAUDE.md §1.1②).
 * This module never joins a home directory to anything.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatTurn } from '@qianmo/console'

/** The half of a session that never changes. The rest is derived from turns. */
export interface StoredChatSession {
  readonly id: string
  /** `qianmo://<node>/<agent>`. */
  readonly target: string
  readonly node: string
  readonly agent: string
  readonly createdAt: number
}

/** Everything a replay yields, in write order. */
interface ChatStoreSnapshot {
  readonly sessions: readonly StoredChatSession[]
  /** One entry per turn id, last write wins, first-seen order preserved. */
  readonly turns: readonly ChatTurn[]
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const TURN_STATES: ReadonlySet<string> = new Set([
  'pending',
  'delivered',
  'read',
  'done',
  'failed',
])

/** `notify` 的三档（协议 §14.2）。视图只拿它选颜色，不拿它过滤。 */
const NOTICE_SEVERITIES: ReadonlySet<string> = new Set([
  'info',
  'warn',
  'error',
])

/**
 * Rebuild one turn from a line.
 *
 * Returns `null` rather than throwing on anything unexpected: a transcript with
 * one unreadable line is still a transcript, and the alternative — a console
 * that refuses to open its chat page because of a byte written during a power
 * cut — is strictly worse than losing that turn.
 */
function toTurn(value: unknown): ChatTurn | null {
  if (!isRecord(value)) return null
  const id = str(value['id'])
  const sessionId = str(value['sessionId'])
  const author = value['author']
  const at = num(value['at'])
  const text = value['text']
  const state = value['state']
  if (id === undefined || sessionId === undefined || at === undefined) {
    return null
  }
  if (author !== 'operator' && author !== 'agent') return null
  if (typeof text !== 'string') return null
  if (typeof state !== 'string' || !TURN_STATES.has(state)) return null
  return {
    id,
    sessionId,
    author,
    at,
    text,
    state: state as ChatTurn['state'],
    ...(str(value['taskId']) === undefined
      ? {}
      : { taskId: str(value['taskId']) as string }),
    ...(str(value['traceId']) === undefined
      ? {}
      : { traceId: str(value['traceId']) as string }),
    ...(str(value['receipt']) === undefined
      ? {}
      : { receipt: str(value['receipt']) as string }),
    ...(num(value['receiptMs']) === undefined
      ? {}
      : { receiptMs: num(value['receiptMs']) as number }),
    ...(num(value['readMs']) === undefined
      ? {}
      : { readMs: num(value['readMs']) as number }),
    ...(num(value['elapsedMs']) === undefined
      ? {}
      : { elapsedMs: num(value['elapsedMs']) as number }),
    ...(str(value['code']) === undefined
      ? {}
      : { code: str(value['code']) as string }),
    // 三个过程行字段。**缺省即 `message`**：这个文件里绝大多数行是在它们存在
    // 之前写的，一条读不出 variant 的旧行必须原样回到今天的样子，而不是变成
    // 一条分量不明的过程。同理，variant 认不出来的值按 `message` 处理——那多半
    // 是一个更新的版本写的，把它降级成一句话，好过整行丢掉。
    ...(value['variant'] === 'notice' ? { variant: 'notice' as const } : {}),
    ...(typeof value['severity'] === 'string' &&
    NOTICE_SEVERITIES.has(value['severity'])
      ? { severity: value['severity'] as ChatTurn['severity'] }
      : {}),
    ...(str(value['detail']) === undefined
      ? {}
      : { detail: str(value['detail']) as string }),
    ...(value['redelivered'] === true ? { redelivered: true as const } : {}),
  }
}

function toSession(value: unknown): StoredChatSession | null {
  if (!isRecord(value)) return null
  const id = str(value['id'])
  const target = str(value['target'])
  const node = str(value['node'])
  const agent = str(value['agent'])
  const createdAt = num(value['createdAt'])
  if (
    id === undefined ||
    target === undefined ||
    node === undefined ||
    agent === undefined ||
    createdAt === undefined
  ) {
    return null
  }
  return { id, target, node, agent, createdAt }
}

export class ChatStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  /** The file this store writes. Printed in the startup banner, never a secret. */
  get path(): string {
    return this.#path
  }

  /**
   * Replay the file.
   *
   * A missing file is an empty snapshot, not an error — a console that has
   * never been chatted through is the ordinary first-run state.
   */
  load(): ChatStoreSnapshot {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch {
      return { sessions: [], turns: [] }
    }
    const sessions: StoredChatSession[] = []
    const turns = new Map<string, ChatTurn>()
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed)) continue
      if (parsed['kind'] === 'session') {
        const session = toSession(parsed['session'])
        if (session !== null) sessions.push(session)
      } else if (parsed['kind'] === 'turn') {
        const turn = toTurn(parsed['turn'])
        // `Map.set` on an existing key keeps the original insertion position,
        // so "last write wins" and "first-seen order" hold at the same time.
        if (turn !== null) turns.set(turn.id, turn)
      }
    }
    return { sessions, turns: [...turns.values()] }
  }

  appendSession(session: StoredChatSession): void {
    this.#append({ kind: 'session', session })
  }

  appendTurn(turn: ChatTurn): void {
    this.#append({ kind: 'turn', turn })
  }

  #append(record: unknown): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: DIR_MODE })
    appendFileSync(this.#path, `${JSON.stringify(record)}\n`, {
      mode: FILE_MODE,
    })
  }
}
