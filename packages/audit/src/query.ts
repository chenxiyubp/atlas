// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading the trail back: by trace, by agent, by time window.
 *
 * The DoD's sentence is the specification: *"任取一次跨节点任务，用 trace_id 能
 * 还原完整消息链（含被丢弃、被限流、被去重的消息）"*. Two words in it do the
 * work:
 *
 * - **完整** — the reconstruction must include the refusals. A chain that shows
 *   only what succeeded is a chain that answers "what happened?" with "the
 *   parts that worked", which is the opposite of what an investigation needs.
 *   {@link reconstructChain} therefore never filters on outcome, and reports the
 *   refused and dropped counts as first-class numbers.
 * - **trace_id** — matching is on the **trace-id segment**, not the whole
 *   traceparent, because the parent-id changes at every hop by design (§7.1).
 *   Matching the full header would return exactly one hop of the chain and look
 *   like it worked.
 */

import { traceIdSegment, type AuditRecord, type AuditSource } from './record.js'

export interface TrailQuery {
  /** Full traceparent or bare trace-id segment; both match the same chain. */
  readonly traceId?: string
  readonly taskId?: string
  readonly msgId?: string
  /** Matches `node`, `peer`, or an address inside the detail. */
  readonly agent?: string
  readonly source?: AuditSource
  /** Inclusive lower bound, epoch ms. */
  readonly from?: number
  /** Inclusive upper bound, epoch ms. */
  readonly to?: number
  readonly outcome?: AuditRecord['outcome']
}

function mentionsAgent(record: AuditRecord, agent: string): boolean {
  if (record.node === agent || record.peer === agent) return true
  for (const value of Object.values(record.detail ?? {})) {
    if (typeof value === 'string' && value === agent) return true
  }
  return false
}

/** Filter the trail. Every criterion is an AND; absent criteria match all. */
export function queryTrail(
  records: readonly AuditRecord[],
  query: TrailQuery,
): readonly AuditRecord[] {
  const wantedTrace = traceIdSegment(query.traceId)
  return records.filter(record => {
    if (
      wantedTrace !== null &&
      traceIdSegment(record.traceId) !== wantedTrace
    ) {
      return false
    }
    if (query.taskId !== undefined && record.taskId !== query.taskId) {
      return false
    }
    if (query.msgId !== undefined && record.msgId !== query.msgId) return false
    if (query.source !== undefined && record.source !== query.source) {
      return false
    }
    if (query.outcome !== undefined && record.outcome !== query.outcome) {
      return false
    }
    if (query.from !== undefined && record.at < query.from) return false
    if (query.to !== undefined && record.at > query.to) return false
    if (query.agent !== undefined && !mentionsAgent(record, query.agent)) {
      return false
    }
    return true
  })
}

/** One reconstructed chain. */
export interface MessageChain {
  /** The trace-id segment this chain is keyed on. */
  readonly traceId: string
  readonly records: readonly AuditRecord[]
  /** Distinct `taskId`s seen, in first-appearance order. */
  readonly taskIds: readonly string[]
  /** Distinct `msgId`s seen — one per transmission, retries included. */
  readonly msgIds: readonly string[]
  readonly sources: readonly AuditSource[]
  readonly refused: number
  readonly dropped: number
  readonly firstAt: number
  readonly lastAt: number
}

/**
 * Rebuild one message chain from the trail.
 *
 * Ordered by `seq` rather than by `at`: two nodes' clocks disagree, and a
 * reconstruction sorted by timestamp can put an ack before the message it
 * answers. `seq` is this file's own order, which is the only total order that
 * exists here.
 */
export function reconstructChain(
  records: readonly AuditRecord[],
  traceId: string,
): MessageChain | null {
  const wanted = traceIdSegment(traceId)
  if (wanted === null) return null
  const matched = [...queryTrail(records, { traceId })].sort(
    (a, b) => a.seq - b.seq,
  )
  if (matched.length === 0) return null

  const taskIds: string[] = []
  const msgIds: string[] = []
  const sources: AuditSource[] = []
  let refused = 0
  let dropped = 0
  for (const record of matched) {
    if (record.taskId !== undefined && !taskIds.includes(record.taskId)) {
      taskIds.push(record.taskId)
    }
    if (record.msgId !== undefined && !msgIds.includes(record.msgId)) {
      msgIds.push(record.msgId)
    }
    if (!sources.includes(record.source)) sources.push(record.source)
    if (record.outcome === 'refused') refused += 1
    if (record.outcome === 'dropped') dropped += 1
  }

  return {
    traceId: wanted,
    records: matched,
    taskIds,
    msgIds,
    sources,
    refused,
    dropped,
    firstAt: matched[0]?.at ?? 0,
    lastAt: matched.at(-1)?.at ?? 0,
  }
}

/** One line per record, for a terminal. Never prints payload content. */
export function formatChain(chain: MessageChain): string {
  const lines = [
    `trace ${chain.traceId} — ${chain.records.length} records, ` +
      `${chain.refused} refused, ${chain.dropped} dropped, ` +
      `${chain.lastAt - chain.firstAt}ms end to end`,
  ]
  for (const record of chain.records) {
    const mark =
      record.outcome === 'ok' ? ' ' : record.outcome === 'refused' ? '✗' : '·'
    lines.push(
      `${mark} #${String(record.seq).padStart(4, '0')} ${record.source}/${record.kind}` +
        `${record.code === undefined ? '' : ` [${record.code}]`}` +
        `${record.msgId === undefined ? '' : ` msg=${record.msgId.slice(0, 8)}`}` +
        `${record.peer === undefined ? '' : ` peer=${record.peer}`}`,
    )
  }
  return lines.join('\n')
}
