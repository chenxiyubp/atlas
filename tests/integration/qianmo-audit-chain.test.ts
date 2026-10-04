// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P7.2's DoD, run rather than argued:
 *
 * > 任取一次跨节点任务，用 trace_id 能还原完整消息链（含被丢弃、被限流、被去重的
 * > 消息）；审计日志的修改尝试被拒。
 *
 * So this file drives a real cross-node exchange over a real socket, with the
 * transport and the routing layer both writing into **one** trail, and then asks
 * the trail the question an operator would ask. The three hard words are the
 * three assertions: the chain must contain the message that was **deduplicated**,
 * the one that was **rate-limited**, and the one that was **dropped by the
 * handler** — none of which appear in a naive "what succeeded" view.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  AuditSource,
  AuditTrail,
  readTrail,
  reconstructChain,
} from '@qianmo/audit'
import { InboundBudget, NodeRouter } from '@qianmo/router'
import {
  TransportClient,
  TransportEventType,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import {
  routerTrailSink,
  transportTrailSink,
} from 'src/services/qianmo/auditTrail.js'

const PSK = 'audit-chain-psk-not-a-real-secret'
const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-audit-chain-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function request(taskId: string, traceId: string, payload: unknown) {
  return createMessage({
    from: PLANNER,
    to: REVIEWER,
    type: MessageType.TaskRequest,
    taskId,
    traceId,
    payload,
  })
}

describe('one trace id, the whole story', () => {
  test('the chain holds the deduplicated, the rate-limited and the dropped', async () => {
    const dir = workspace()
    const trailPath = join(dir, 'audit', 'trail.ndjson')
    const trail = new AuditTrail(trailPath)
    cleanups.push(() => trail.close())

    // Node B: transport events and routing refusals both land on this trail.
    const router = new NodeRouter({
      node: 'node-b',
      auditSink: routerTrailSink(trail, 'node-b'),
      // A tiny allowance so the storm case needs three messages, not six
      // hundred. Two, not three: the duplicate never reaches the router — the
      // transport's dedup absorbs it first — so only the messages that got as
      // far as the routing layer spend any of it.
      budget: new InboundBudget({ perMinute: 2 }),
    })
    const delivered: QianmoMessage[] = []
    let refuseNext = false
    const socket = join(dir, 'node-b.sock')
    const server: TransportServerHandle = startTransportServer({
      psk: PSK,
      unix: socket,
      events: transportTrailSink(trail, 'node-b'),
      onMessage: message => {
        const verdict = router.inbound(message)
        if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`)
        if (refuseNext) {
          refuseNext = false
          // The handler itself refuses — the "dropped by the last hop" case.
          throw new Error('handler refused this one')
        }
        delivered.push(message)
      },
    })
    cleanups.push(() => server.stop())

    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      backoff: { giveUpAfterMs: 0 },
    })
    cleanups.push(() => client.close())
    await client.connect(3_000)

    // One task, one trace, four transmissions with four different fates.
    const traceId = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

    // 1. accepted
    const first = request('task-audit', traceId, { step: 1 })
    await client.sendAndWait(first, 3_000)

    // 2. the same envelope again — absorbed by dedup
    await client.sendAndWait(first, 3_000)

    // 3. the handler refuses this one
    refuseNext = true
    const third = request('task-audit-2', traceId, { step: 3 })
    await expect(client.sendAndWait(third, 3_000)).rejects.toThrow()

    // 4. over the inbound budget — the two that reached the router (1 and 3)
    //    spent it, and the duplicate spent nothing because it never got there
    const fourth = request('task-audit-3', traceId, { step: 4 })
    await expect(client.sendAndWait(fourth, 3_000)).rejects.toThrow()

    trail.close()
    const { records, intact } = readTrail(trailPath)
    expect(intact).toBe(true)

    const chain = reconstructChain(records, traceId)
    expect(chain).not.toBeNull()
    if (chain === null) return

    const kinds = chain.records.map(record => record.kind)
    // The four fates, all present.
    // The transport's own names, unchanged — an operator holding one of its log
    // lines should not have to translate it into ours.
    expect(kinds).toContain(TransportEventType.MessageAccepted)
    expect(kinds).toContain(TransportEventType.MessageDuplicate)
    expect(kinds).toContain(TransportEventType.MessageRejected)
    expect(kinds).toContain('rate_limited')

    // And they are labelled in a way somebody can act on.
    const duplicate = chain.records.find(
      record => record.kind === TransportEventType.MessageDuplicate,
    )
    expect(duplicate?.outcome).toBe('dropped')
    expect(duplicate?.msgId).toBe(first.msgId)

    const limited = chain.records.find(record => record.kind === 'rate_limited')
    expect(limited?.outcome).toBe('refused')
    expect(limited?.code).toBe('E_RATE_LIMITED')
    expect(limited?.source).toBe(AuditSource.Router)

    expect(chain.refused).toBeGreaterThanOrEqual(2)
    expect(chain.dropped).toBeGreaterThanOrEqual(1)
    // Exactly one message actually made it to the handler.
    expect(delivered).toHaveLength(1)
  }, 20_000)

  test('an edited trail stops verifying, and the reader says where', async () => {
    const dir = workspace()
    const trailPath = join(dir, 'audit', 'trail.ndjson')
    const trail = new AuditTrail(trailPath)
    for (const step of [1, 2, 3]) {
      trail.append({
        at: 1_800_000_000_000 + step,
        source: AuditSource.Router,
        kind: 'rate_limited',
        outcome: 'refused',
        code: 'E_RATE_LIMITED',
        detail: { step },
      })
    }
    trail.close()
    expect(readTrail(trailPath).intact).toBe(true)

    const lines = readFileSync(trailPath, 'utf8').trimEnd().split('\n')
    const edited = JSON.parse(lines[1] as string) as Record<string, unknown>
    edited['outcome'] = 'ok'
    lines[1] = JSON.stringify(edited)
    writeFileSync(trailPath, `${lines.join('\n')}\n`)

    const result = readTrail(trailPath)
    expect(result.intact).toBe(false)
    expect(result.issues[0]?.kind).toBe('broken_chain')
    expect(result.issues[0]?.seq).toBe(3)
  })
})
