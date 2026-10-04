// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ProtocolErrorCode } from '@qianmo/protocol'
import type { TeammateMessage } from 'src/utils/agents/teammateMailbox.js'
import {
  compactMailboxMessages,
  getInboxPath,
  markMessageAsReadByIdentity,
  readMailbox,
} from 'src/utils/agents/teammateMailbox.js'

import { BlobStore } from '../src/blob.js'
import { InboundAdapter } from '../src/inbound.js'
import type { MailboxEntryIdentity } from '../src/observer.js'
import {
  BASE_INPROCESS_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  classifyMailboxEntry,
  observeReadFlip,
} from '../src/observer.js'
import type { TempConfig } from './helpers.js'
import { NODE_B, TEAM, makeEnvelope, useTempConfig } from './helpers.js'

let config: TempConfig
let counter = 0

beforeAll(() => {
  config = useTempConfig('qianmo-adapter-observer-')
})

afterAll(() => {
  config.restore()
})

/** Deliver one message for real, and hand back what the observer needs. */
async function deliverOne(): Promise<{
  agent: string
  team: string
  identity: MailboxEntryIdentity
}> {
  counter++
  const team = `${TEAM}-${counter}`
  const adapter = new InboundAdapter({
    node: NODE_B,
    team,
    blobs: new BlobStore({ dir: join(config.root, `blobs-${counter}`) }),
  })
  const result = await adapter.deliver(makeEnvelope())
  if (result.status !== 'delivered') {
    throw new Error(`fixture delivery failed: ${result.reason}`)
  }
  return { agent: result.recipient, team, identity: result.identity }
}

/** Flip `read` the way the base's own delivery paths do. */
async function flipRead(
  agent: string,
  team: string,
  identity: MailboxEntryIdentity,
): Promise<void> {
  const flipped = await markMessageAsReadByIdentity(agent, team, {
    ...identity,
    read: false,
  })
  if (!flipped) throw new Error('fixture could not flip the read flag')
}

/**
 * Evict everything from a mailbox using the base's own compaction function,
 * then persist the result — exactly what `writeCompactedMailbox` does when the
 * retained-bytes budget is exhausted.
 */
async function evictAll(agent: string, team: string): Promise<void> {
  const messages = await readMailbox(agent, team)
  const kept = compactMailboxMessages(messages, { maxRetainedBytes: 10 })
  if (kept.length !== 0) throw new Error('fixture failed to evict')
  await writeFile(
    getInboxPath(agent, team),
    JSON.stringify(kept, null, 2),
    'utf-8',
  )
}

const IDENTITY: MailboxEntryIdentity = {
  from: 'qianmo://node-a/planner',
  timestamp: '2026-08-12T00:00:00.000Z',
  text: '{"type":"qianmo.envelope"}',
}

function entry(overrides: Partial<TeammateMessage> = {}): TeammateMessage {
  return { ...IDENTITY, read: false, ...overrides }
}

describe('classifyMailboxEntry', () => {
  test('finds the entry by the base identity triple', () => {
    expect(classifyMailboxEntry([entry()], IDENTITY)).toBe('unread')
    expect(classifyMailboxEntry([entry({ read: true })], IDENTITY)).toBe('read')
    expect(classifyMailboxEntry([], IDENTITY)).toBe('absent')
  })

  test('a different from / timestamp / text is a different entry', () => {
    expect(classifyMailboxEntry([entry({ from: 'other' })], IDENTITY)).toBe(
      'absent',
    )
    expect(classifyMailboxEntry([entry({ timestamp: 'x' })], IDENTITY)).toBe(
      'absent',
    )
    expect(classifyMailboxEntry([entry({ text: 'x' })], IDENTITY)).toBe(
      'absent',
    )
  })

  test('a byte-identical duplicate counts as read once either copy is read', () => {
    expect(
      classifyMailboxEntry([entry(), entry({ read: true })], IDENTITY),
    ).toBe('read')
  })
})

describe('the observation period may not exceed the base poll period', () => {
  test('a slower period is refused outright', async () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBeLessThanOrEqual(
      BASE_INPROCESS_POLL_INTERVAL_MS,
    )
    await expect(
      observeReadFlip({
        agent: 'reviewer',
        team: 'nest',
        identity: IDENTITY,
        deadlineAt: Date.now() + 1_000,
        pollIntervalMs: BASE_INPROCESS_POLL_INTERVAL_MS + 1,
      }),
    ).rejects.toThrow(RangeError)
  })
})

describe('the three terminal states, and there is no fourth (§4.5)', () => {
  test('read flips → acked, timed at the observation that saw it', async () => {
    const { agent, team, identity } = await deliverOne()
    const start = 1_700_000_000_000
    let clock = start
    let ticks = 0

    const outcome = await observeReadFlip({
      agent,
      team,
      identity,
      deadlineAt: start + 30_000,
      pollIntervalMs: 250,
      now: () => clock,
      sleep: async ms => {
        clock += ms
        ticks++
        if (ticks === 3) await flipRead(agent, team, identity)
      },
    })

    expect(outcome.state).toBe('acked')
    // Three sleeps happened before the poll that saw the flip.
    expect(outcome).toMatchObject({ ackAt: start + 750 })
  })

  test('the entry vanishes → dropped, E_EVICTED', async () => {
    const { agent, team, identity } = await deliverOne()
    const start = 1_700_000_000_000
    let clock = start

    const outcome = await observeReadFlip({
      agent,
      team,
      identity,
      deadlineAt: start + 30_000,
      pollIntervalMs: 250,
      now: () => clock,
      sleep: async ms => {
        clock += ms
        await evictAll(agent, team)
      },
    })

    expect(outcome).toMatchObject({
      state: 'dropped',
      code: ProtocolErrorCode.E_EVICTED,
    })
  })

  test('the deadline passes unread → expired, E_TTL_EXPIRED', async () => {
    const { agent, team, identity } = await deliverOne()
    const start = 1_700_000_000_000
    let clock = start

    const outcome = await observeReadFlip({
      agent,
      team,
      identity,
      deadlineAt: start + 1_000,
      pollIntervalMs: 250,
      now: () => clock,
      sleep: async ms => {
        clock += ms
      },
    })

    expect(outcome).toMatchObject({
      state: 'expired',
      code: ProtocolErrorCode.E_TTL_EXPIRED,
    })
    // Still sitting there unread — expiry is a deadline, not a deletion.
    expect(await readMailbox(agent, team)).toHaveLength(1)
  })

  test('an abort resolves as expired rather than hanging', async () => {
    const { agent, team, identity } = await deliverOne()
    const controller = new AbortController()
    controller.abort()

    const outcome = await observeReadFlip({
      agent,
      team,
      identity,
      deadlineAt: Date.now() + 30_000,
      pollIntervalMs: 250,
      signal: controller.signal,
    })
    expect(outcome).toMatchObject({ state: 'expired' })
  })
})

describe('rule T-2: a thawed node does not judge everything dead at once', () => {
  // E4 measured CLOCK_MONOTONIC advancing while frozen and setInterval not
  // catching up, so every deadline crosses at the same instant on wake.
  test('a gap larger than 2x the period is added back to the deadline', async () => {
    const { agent, team, identity } = await deliverOne()
    const start = 1_700_000_000_000
    let clock = start
    let ticks = 0

    const outcome = await observeReadFlip({
      agent,
      team,
      identity,
      // Without the gate the freeze below blows straight past this.
      deadlineAt: start + 1_000,
      pollIntervalMs: 250,
      now: () => clock,
      sleep: async ms => {
        ticks++
        if (ticks === 1) {
          clock += 40_000 // frozen
        } else {
          clock += ms
          if (ticks === 2) await flipRead(agent, team, identity)
        }
      },
    })

    expect(outcome.state).toBe('acked')
  })

  test('an ordinary gap is still charged to the deadline', async () => {
    const { agent, team, identity } = await deliverOne()
    const start = 1_700_000_000_000
    let clock = start
    let ticks = 0

    // Same 40s of wall clock, but arriving as ordinary-sized steps: no freeze
    // is inferred, so the deadline stands and the message expires.
    const outcome = await observeReadFlip({
      agent,
      team,
      identity,
      deadlineAt: start + 1_000,
      pollIntervalMs: 250,
      now: () => clock,
      sleep: async ms => {
        ticks++
        clock += ms
        if (ticks > 200) throw new Error('observer failed to expire')
      },
    })

    expect(outcome).toMatchObject({
      state: 'expired',
      code: ProtocolErrorCode.E_TTL_EXPIRED,
    })
  })
})
