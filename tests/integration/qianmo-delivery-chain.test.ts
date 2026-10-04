// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The seam between `@qianmo/registry` and `@qianmo/adapter`.
 *
 * Each package is well covered on its own, but until this file existed nothing
 * ran them together — and AC-2 is exactly their composition: resolve an address
 * through the registry, hand the envelope to the receiving node's adapter, and
 * only then let an ack come back. A mismatch at that seam (address rendering,
 * key shape, endpoint form) passes both packages' own suites and fails the
 * acceptance run, which is the worst place to find it.
 *
 * Transport is deliberately absent: it is P2.2 and does not exist yet. What is
 * under test is everything on either side of it, wired directly.
 *
 * Nothing is mocked — a real temp config root, the base's real mailbox, real
 * envelopes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InboundAdapter, deliverAndAck } from '@qianmo/adapter'
import { MessageType, createMessage } from '@qianmo/protocol'
import { InMemoryRegistry, ManualClock } from '@qianmo/registry'
import {
  markMessagesAsRead,
  readMailbox,
} from 'src/utils/agents/teammateMailbox.js'

const NODE_A = 'node-a'
const NODE_B = 'node-b'
const SENDER = `qianmo://${NODE_A}/planner`
const REVIEWER_B = `qianmo://${NODE_B}/reviewer`
/** Same agent name, different node — the collision the composite key fixes. */
const REVIEWER_A = `qianmo://${NODE_A}/reviewer`
const ENDPOINT_B = 'wss://node-b.invalid/reviewer'
const ENDPOINT_A = 'wss://node-a.invalid/reviewer'
const TEAM = 'nest'
const START = 1_800_000_000_000

let root: string
let previousConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-chain-'))
  // `CLAUDE_CONFIG_DIR`, not `OCC_CONFIG_DIR`: tests/preload.ts deletes the
  // latter, and occConfigDir() memoizes on both.
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

function envelope(to: string) {
  return createMessage({
    from: SENDER,
    to,
    type: MessageType.TaskRequest,
    payload: { ask: 'review the diff' },
    createdAt: START,
  })
}

/** Mark every entry in an inbox read — what a live agent's poll loop does. */
async function drainInbox(agent: string): Promise<void> {
  await markMessagesAsRead(agent, TEAM)
}

describe('registry → adapter: the AC-2 chain minus transport', () => {
  test('an address resolved through the registry is deliverable and acks', async () => {
    const registry = new InMemoryRegistry({ clock: new ManualClock(START) })
    const registered = registry.register(REVIEWER_B, ENDPOINT_B, {
      capabilities: ['review'],
    })
    expect(registered.ok).toBe(true)

    // The sender resolves, and gets back the address it must put on the wire.
    const resolved = registry.resolve(REVIEWER_B)
    expect(resolved?.endpoint).toBe(ENDPOINT_B)
    expect(resolved?.address).toBe(REVIEWER_B)

    // Transport would carry it here. The receiving node adapts it in.
    const adapter = new InboundAdapter({
      node: NODE_B,
      team: TEAM,
      now: () => START,
    })
    const message = envelope(resolved?.address ?? '')

    // No `maxWaitMs` knob exists — the observation deadline comes from the
    // envelope's own delivery TTL. Passing one was silently ignored until
    // `tests/` entered typecheck.
    const settled = deliverAndAck(adapter, message, {
      now: () => START,
      pollIntervalMs: 5,
    })
    // The agent picks the message up only after the write has landed — an ack
    // emitted at write time could not tell this apart from the eviction case.
    await Bun.sleep(20)
    await drainInbox('reviewer')

    const reply = await settled
    expect(reply.outcome).toBe('acked')
  })

  test('the same agent name on two nodes stays two separate deliveries', async () => {
    const registry = new InMemoryRegistry({ clock: new ManualClock(START) })
    expect(registry.register(REVIEWER_A, ENDPOINT_A).ok).toBe(true)
    expect(registry.register(REVIEWER_B, ENDPOINT_B).ok).toBe(true)
    expect(registry.size).toBe(2)

    // Node B's adapter accepts its own agent and refuses node A's namesake,
    // even though the two share the bare name the base mailbox keys on.
    const adapter = new InboundAdapter({
      node: NODE_B,
      team: TEAM,
      now: () => START,
    })

    const mine = await adapter.deliver(envelope(REVIEWER_B))
    expect(mine.status).toBe('delivered')

    const theirs = await adapter.deliver(envelope(REVIEWER_A))
    expect(theirs.status).toBe('rejected')

    // Only the message actually addressed to this node reached the inbox.
    const inbox = await readMailbox('reviewer', TEAM)
    expect(inbox).toHaveLength(1)
  })

  test('an expired registration resolves to nothing, so nothing is delivered', async () => {
    const clock = new ManualClock(START)
    const registry = new InMemoryRegistry({ clock, ttlMs: 1_000 })
    registry.register(REVIEWER_B, ENDPOINT_B)

    clock.set(START + 5_000)
    expect(registry.resolve(REVIEWER_B)).toBeNull()

    // Nothing was written, because there was no address to deliver to.
    const inbox = await readMailbox('reviewer', TEAM)
    expect(inbox).toHaveLength(0)
  })
})
