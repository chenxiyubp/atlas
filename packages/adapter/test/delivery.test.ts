// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { QianmoMessage } from '@qianmo/protocol'
import { MessageType, ProtocolErrorCode, isAckPayload } from '@qianmo/protocol'
import {
  compactMailboxMessages,
  getInboxPath,
  markMessageAsReadByIdentity,
  readMailbox,
} from 'src/utils/agents/teammateMailbox.js'

import { BlobStore } from '../src/blob.js'
import type { DeliveryReply } from '../src/delivery.js'
import { deliverAndAck } from '../src/delivery.js'
import { InboundAdapter } from '../src/inbound.js'
import type { TempConfig } from './helpers.js'
import { NODE_B, SENDER, TEAM, makeEnvelope, useTempConfig } from './helpers.js'

let config: TempConfig
let counter = 0

beforeAll(() => {
  config = useTempConfig('qianmo-adapter-delivery-')
})

afterAll(() => {
  config.restore()
})

function makeAdapter(now?: () => number): {
  adapter: InboundAdapter
  team: string
} {
  counter++
  const team = `${TEAM}-${counter}`
  return {
    team,
    adapter: new InboundAdapter({
      node: NODE_B,
      team,
      blobs: new BlobStore({ dir: join(config.root, `blobs-${counter}`) }),
      ...(now === undefined ? {} : { now }),
    }),
  }
}

/**
 * Flip the pending entry the way the base's own delivery paths do.
 *
 * The identity triple is read back out of the mailbox rather than handed in:
 * `deliverAndAck` owns the write, so this mirrors how the base finds a message
 * it is about to hand to the agent.
 */
async function flipRead(team: string): Promise<void> {
  const target = (await readMailbox('reviewer', team)).find(m => !m.read)
  if (!target) throw new Error('fixture: no unread entry to flip')
  const ok = await markMessageAsReadByIdentity('reviewer', team, target)
  if (!ok) throw new Error('fixture could not flip the read flag')
}

async function evictAll(team: string): Promise<void> {
  const messages = await readMailbox('reviewer', team)
  const kept = compactMailboxMessages(messages, { maxRetainedBytes: 10 })
  await writeFile(
    getInboxPath('reviewer', team),
    JSON.stringify(kept, null, 2),
    'utf-8',
  )
}

const START = 1_700_000_000_000

/** Drive one delivery with a controlled clock; `onTick` runs inside a sleep. */
async function run(
  message: QianmoMessage,
  onTick: (tick: number, team: string) => Promise<void> = async () => undefined,
): Promise<{ reply: DeliveryReply; team: string }> {
  let clock = START
  let ticks = 0
  // One clock for the whole delivery: the adapter stamps the entry with it and
  // the observer ticks on it, so the ack time is comparable to the write time.
  const { adapter, team } = makeAdapter(() => clock)
  const reply = await deliverAndAck(adapter, message, {
    pollIntervalMs: 250,
    now: () => clock,
    sleep: async ms => {
      clock += ms
      ticks++
      await onTick(ticks, team)
    },
  })
  return { reply, team }
}

/**
 * The point of the whole design (protocol.md §4.5).
 *
 * All three cases below perform the *same* successful mailbox write. An ack
 * emitted when that write returned would therefore be identical in all three
 * — and in two of them it would be a lie: the base's quota enforcement drops
 * unread messages without telling the sender anything, so an evicted message
 * would show up as "ack arrived, result never came", which is exactly what
 * costs AC-2 its 10/10.
 */
describe('the ack is end-to-end, never write-time', () => {
  test('the mailbox entry is unread the moment the write returns', async () => {
    const { adapter, team } = makeAdapter()
    const result = await adapter.deliver(makeEnvelope())
    expect(result.status).toBe('delivered')

    // The write is done and durable — and nothing has been acknowledged.
    const stored = await readMailbox('reviewer', team)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.read).toBe(false)
  })

  test('read flips → ack, and only then', async () => {
    const message = makeEnvelope({ createdAt: START })
    const { reply, team } = await run(message, async (tick, currentTeam) => {
      if (tick === 2) await flipRead(currentTeam)
    })

    expect(reply.outcome).toBe('acked')
    expect(reply.reply.type).toBe(MessageType.Ack)
    // The ack is timed at the observation that saw the flip, not at the write.
    expect((reply.reply.payload as { ackAt: number }).ackAt).toBe(START + 500)
    expect((await readMailbox('reviewer', team))[0]?.read).toBe(true)
  })

  test('evicted → E_EVICTED, and no ack is produced at all', async () => {
    const message = makeEnvelope({ createdAt: START })
    const { reply } = await run(message, async (_tick, currentTeam) => {
      await evictAll(currentTeam)
    })

    expect(reply.outcome).toBe('dropped')
    expect(reply.reply.type).toBe(MessageType.Error)
    expect(reply.reply.payload).toMatchObject({
      code: ProtocolErrorCode.E_EVICTED,
    })
    expect(isAckPayload(reply.reply.payload)).toBe(false)
  })

  test('never read before the deadline → E_TTL_EXPIRED, and no ack', async () => {
    const message = makeEnvelope({ createdAt: START, deliverTtlMs: 1_000 })
    const { reply } = await run(message)

    expect(reply.outcome).toBe('expired')
    expect(reply.reply.type).toBe(MessageType.Error)
    expect(reply.reply.payload).toMatchObject({
      code: ProtocolErrorCode.E_TTL_EXPIRED,
    })
    expect(isAckPayload(reply.reply.payload)).toBe(false)
  })

  // The discrimination itself: identical writes, three different outcomes.
  // A write-time ack has no way to express this — it would report all three
  // as delivered.
  test('one identical write reaches three different terminal states', async () => {
    const outcomes: string[] = []

    for (const scenario of ['flip', 'evict', 'wait'] as const) {
      const message = makeEnvelope({ createdAt: START, deliverTtlMs: 1_000 })
      const { reply } = await run(message, async (tick, currentTeam) => {
        if (scenario === 'flip' && tick === 1) {
          await flipRead(currentTeam)
        }
        if (scenario === 'evict' && tick === 1) await evictAll(currentTeam)
      })
      // Every scenario got past the write — the difference is all downstream.
      expect(reply).toHaveProperty('delivered')
      outcomes.push(reply.outcome)
    }

    expect(outcomes).toEqual(['acked', 'dropped', 'expired'])
    expect(new Set(outcomes).size).toBe(3)
  })
})

describe('rule K-1: the ack payload is field-closed', () => {
  test('exactly { handler, ackAt }, nothing more', async () => {
    const message = makeEnvelope({ createdAt: START })
    const { reply } = await run(message, async (tick, currentTeam) => {
      if (tick === 1) await flipRead(currentTeam)
    })

    expect(reply.outcome).toBe('acked')
    const payload = reply.reply.payload
    expect(isAckPayload(payload)).toBe(true)
    expect(Object.keys(payload as object).sort()).toEqual(['ackAt', 'handler'])
    expect(payload).toMatchObject({ handler: 'qianmo://node-b/reviewer' })
    // Correlation lives in the envelope alone — the payload may not restate it.
    expect(payload).not.toHaveProperty('ofMsgId')
    expect(payload).not.toHaveProperty('taskId')
    expect(reply.reply.taskId).toBe(message.taskId)
  })

  test('the ack is correlated by taskId and addressed back to the sender', async () => {
    const message = makeEnvelope({ createdAt: START })
    const { reply } = await run(message, async (tick, currentTeam) => {
      if (tick === 1) await flipRead(currentTeam)
    })

    expect(reply.reply.taskId).toBe(message.taskId)
    expect(reply.reply.to).toBe(SENDER)
    expect(reply.reply.from).toBe('qianmo://node-b/reviewer')
  })
})

describe('a refused message never reaches the observer', () => {
  test('a pre-write rejection replies with the protocol error', async () => {
    const { adapter } = makeAdapter()
    const reply = await deliverAndAck(
      adapter,
      makeEnvelope({ to: 'qianmo://node-z/reviewer' }),
      { pollIntervalMs: 250 },
    )

    expect(reply.outcome).toBe('rejected')
    expect(reply.reply.type).toBe(MessageType.Error)
    expect(reply.reply.payload).toMatchObject({
      code: ProtocolErrorCode.E_UNKNOWN_AGENT,
    })
  })
})
