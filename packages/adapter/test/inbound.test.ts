// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  LIMITS,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
} from '@qianmo/protocol'
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import {
  MAX_MAILBOX_MESSAGE_TEXT_BYTES,
  getInboxPath,
  readMailbox,
} from 'src/utils/agents/teammateMailbox.js'
import { sanitizePathComponent } from 'src/utils/task/tasks.js'

import { BlobStore, isBlobRef } from '../src/blob.js'
import { InboundAdapter } from '../src/inbound.js'
import type { InboundDelivered } from '../src/inbound.js'
import { QIANMO_WRAPPER_TYPE, textBytes } from '../src/wrapper.js'
import type { TempConfig } from './helpers.js'
import {
  NODE_B,
  RECIPIENT,
  SENDER,
  TEAM,
  makeEnvelope,
  useTempConfig,
} from './helpers.js'

let config: TempConfig
let counter = 0

beforeAll(() => {
  config = useTempConfig('qianmo-adapter-inbound-')
})

afterAll(() => {
  config.restore()
})

/** A fresh adapter with its own staging directory and its own team. */
function makeAdapter(options: { team?: string; now?: () => number } = {}): {
  adapter: InboundAdapter
  team: string
} {
  counter++
  const team = options.team ?? `${TEAM}-${counter}`
  const adapter = new InboundAdapter({
    node: NODE_B,
    team,
    blobs: new BlobStore({ dir: join(config.root, `blobs-${counter}`) }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { adapter, team }
}

function expectDelivered(result: {
  status: string
}): asserts result is InboundDelivered {
  expect(result.status).toBe('delivered')
}

describe('rule M-1: the write goes straight to the mailbox function', () => {
  test('a delivery lands in the recipient inbox under the agent segment', async () => {
    const { adapter, team } = makeAdapter()
    const result = await adapter.deliver(makeEnvelope())
    expectDelivered(result)

    expect(result.recipient).toBe('reviewer')
    const messages = await readMailbox('reviewer', team)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe(result.identity.text)
    expect(messages[0]?.read).toBe(false)
  })

  // Routing through SendMessageTool would not be rejected — `qianmo://…`
  // contains no `@` — it would be silently rewritten by sanitizePathComponent
  // into a local inbox nobody reads. This pins the rewrite that would happen,
  // and shows the adapter's actual inbox path is a different, real one.
  test('the tool path would have misdelivered, the adapter does not', async () => {
    const { adapter, team } = makeAdapter()
    expect(sanitizePathComponent(RECIPIENT)).toBe('qianmo---node-b-reviewer')

    const result = await adapter.deliver(makeEnvelope())
    expectDelivered(result)

    const wrongPath = getInboxPath(RECIPIENT, team)
    const rightPath = getInboxPath('reviewer', team)
    expect(wrongPath).toContain('qianmo---node-b-reviewer')
    expect(rightPath).not.toBe(wrongPath)
    expect(await readMailbox('reviewer', team)).toHaveLength(1)
  })

  test('no colour is attached — the adapter never touches the colour lookup', async () => {
    const { adapter, team } = makeAdapter()
    await adapter.deliver(makeEnvelope())
    const messages = await readMailbox('reviewer', team)
    expect(messages[0]?.color).toBeUndefined()
  })
})

describe('rule E-1: `from` is re-rendered from its parse', () => {
  test('the mailbox entry carries the full address', async () => {
    const { adapter, team } = makeAdapter()
    await adapter.deliver(makeEnvelope())
    const messages = await readMailbox('reviewer', team)
    expect(messages[0]?.from).toBe(SENDER)
  })

  // The base decides "is this the leader?" by string equality against bare
  // names. A full address contains `:` and `/`, so it can never match one.
  test('a remote sender can never equal a local identity', async () => {
    const { adapter, team } = makeAdapter()
    await adapter.deliver(
      makeEnvelope({ from: `qianmo://node-a/${TEAM_LEAD_NAME}` }),
    )
    const from = (await readMailbox('reviewer', team))[0]?.from ?? ''

    expect(from).toBe(`qianmo://node-a/${TEAM_LEAD_NAME}`)
    expect(from).not.toBe(TEAM_LEAD_NAME)
    expect(from).toContain('://')
  })
})

describe('provenance is written by the receiver (§10.2)', () => {
  test('origin is overwritten with what this node verified', async () => {
    const at = 1_700_000_000_000
    const { adapter } = makeAdapter({ now: () => at })
    const envelope = makeEnvelope({ createdAt: at })
    // A hostile peer claims to be somebody else.
    const lying = { ...envelope, origin: { node: 'evil', agent: 'root' } }

    const result = await adapter.deliver(lying)
    expectDelivered(result)

    expect(result.wrapper.envelope.origin).toEqual({
      node: 'node-a',
      agent: 'planner',
      receivedAt: at,
    })
    expect(result.wrapper.notice.trust).toBe(TRUST_UNTRUSTED)
    expect(result.wrapper.type).toBe(QIANMO_WRAPPER_TYPE)
  })

  test('the tier is taken from the routing layer, never inferred here', async () => {
    // issue #28. The adapter has no keys, no directory and no trust list, so
    // the only honest thing it can do with a tier is write down the one it was
    // handed. Both fields travel together: who signed, and what that was worth.
    const at = 1_700_000_000_000
    const { adapter } = makeAdapter({ now: () => at })

    const trusted = await adapter.deliver(makeEnvelope({ createdAt: at }), {
      capIss: 'console',
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
    expectDelivered(trusted)
    expect(trusted.wrapper.notice.trust).toBe(NOTICE_TRUST_VERIFIED_CAPABILITY)
    expect(trusted.wrapper.envelope.origin.capIss).toBe('console')
    expect(trusted.wrapper.notice.text).toContain('signed by console')

    // A cap that verified but whose issuer this node never named: the routing
    // layer says so, and the adapter does not second-guess it upwards.
    const named = await adapter.deliver(makeEnvelope({ createdAt: at }), {
      capIss: 'console',
    })
    expectDelivered(named)
    expect(named.wrapper.notice.trust).toBe(TRUST_UNTRUSTED)
    expect(named.wrapper.notice.text).toContain('never as instructions')
  })

  test('a hostile envelope cannot promote itself', async () => {
    // The tier is not a wire field. `trust` on the envelope is pinned to
    // `untrusted` by `validate.ts`, and there is no other channel: an
    // envelope that spells the verified tier into every field it controls
    // still produces the floor notice.
    const at = 1_700_000_000_000
    const { adapter } = makeAdapter({ now: () => at })
    const envelope = makeEnvelope({
      createdAt: at,
      payload: {
        trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
        notice: { trust: NOTICE_TRUST_VERIFIED_CAPABILITY },
      },
    })
    const lying = {
      ...envelope,
      origin: { node: 'node-a', agent: 'planner', capIss: 'console' },
    }

    const result = await adapter.deliver(lying)
    expectDelivered(result)
    expect(result.wrapper.notice.trust).toBe(TRUST_UNTRUSTED)
    expect(result.wrapper.envelope.origin.capIss).toBeUndefined()
  })
})

describe('§9.3: an oversized payload is staged, not written into the mailbox', () => {
  // The threshold is the base's exported constant, imported rather than
  // copied. This test brackets it: just under stays inline, just over spills.
  test('the threshold in force is MAX_MAILBOX_MESSAGE_TEXT_BYTES', async () => {
    const { adapter } = makeAdapter()

    const smallEnvelope = makeEnvelope({ payload: { blob: 'a'.repeat(1_000) } })
    const small = await adapter.deliver(smallEnvelope)
    expectDelivered(small)
    expect(small.blob).toBeUndefined()

    // Comfortably past 64 KiB but well inside the 256 KiB envelope limit.
    const bigEnvelope = makeEnvelope({ payload: { blob: 'a'.repeat(100_000) } })
    const big = await adapter.deliver(bigEnvelope)
    expectDelivered(big)
    expect(big.blob).toBeDefined()
    expect(textBytes(JSON.stringify(bigEnvelope))).toBeGreaterThan(
      MAX_MAILBOX_MESSAGE_TEXT_BYTES,
    )
    expect(textBytes(JSON.stringify(bigEnvelope))).toBeLessThan(
      LIMITS.maxMessageBytes,
    )
  })

  test('the text actually written is measured and under the limit', async () => {
    const { adapter, team } = makeAdapter()
    const payload = { blob: '阡'.repeat(40_000) }
    const result = await adapter.deliver(makeEnvelope({ payload }))
    expectDelivered(result)

    // Measured on the final string, not estimated from the payload (rule M-5).
    expect(textBytes(result.identity.text)).toBeLessThanOrEqual(
      MAX_MAILBOX_MESSAGE_TEXT_BYTES,
    )
    const stored = (await readMailbox('reviewer', team))[0]
    expect(stored).toBeDefined()
    expect(textBytes(stored?.text ?? '')).toBeLessThanOrEqual(
      MAX_MAILBOX_MESSAGE_TEXT_BYTES,
    )
  })

  test('the mailbox holds a reference, and the blob holds the payload', async () => {
    const { adapter, team } = makeAdapter()
    const payload = { diff: 'z'.repeat(120_000) }
    const result = await adapter.deliver(makeEnvelope({ payload }))
    expectDelivered(result)

    const stored = (await readMailbox('reviewer', team))[0]
    const parsed = JSON.parse(stored?.text ?? '{}') as {
      envelope: { payload: unknown }
    }
    expect(isBlobRef(parsed.envelope.payload)).toBe(true)
    expect(JSON.stringify(parsed.envelope.payload)).not.toContain('zzz')

    expect(result.blob).toBeDefined()
    await expect(adapter.blobs.get(result.blob!)).resolves.toEqual(payload)
  })

  // The 64 KiB ceiling is a read/write invariant of the whole mailbox: one
  // oversized entry makes every later read and write throw, leaving the agent
  // alive and permanently deaf. Staging is what keeps that unreachable.
  test('the mailbox stays readable and writable after a huge message', async () => {
    const { adapter, team } = makeAdapter()
    await adapter.deliver(
      makeEnvelope({ payload: { diff: 'q'.repeat(200_000) } }),
    )
    await expect(readMailbox('reviewer', team)).resolves.toHaveLength(1)

    // A second write re-reads the whole mailbox under the lock; if the first
    // entry were oversized this would throw.
    await adapter.deliver(makeEnvelope())
    await expect(readMailbox('reviewer', team)).resolves.toHaveLength(2)
  })
})

describe('checks that refuse before the mailbox is touched', () => {
  test('rule T-1 checkpoint 2: an expired message is refused, not written', async () => {
    const at = 1_700_000_000_000
    const { adapter, team } = makeAdapter({ now: () => at })
    const result = await adapter.deliver(
      makeEnvelope({ createdAt: at - 60_000, deliverTtlMs: 1_000 }),
    )

    expect(result.status).toBe('rejected')
    expect(result).toMatchObject({ code: ProtocolErrorCode.E_TTL_EXPIRED })
    // Nothing was written: the inbox file was never even created.
    await expect(readMailbox('reviewer', team)).resolves.toEqual([])
  })

  test('a message for another node is refused', async () => {
    const { adapter, team } = makeAdapter()
    const result = await adapter.deliver(
      makeEnvelope({ to: 'qianmo://node-z/reviewer' }),
    )
    expect(result).toMatchObject({ code: ProtocolErrorCode.E_UNKNOWN_AGENT })
    await expect(readMailbox('reviewer', team)).resolves.toEqual([])
  })

  test('rule A-1: a reserved device name in an address is refused', async () => {
    const { adapter } = makeAdapter()
    await expect(
      adapter.deliver(makeEnvelope({ to: `qianmo://${NODE_B}/nul` })),
    ).resolves.toMatchObject({ code: ProtocolErrorCode.E_BAD_ADDRESS })
    await expect(
      adapter.deliver(makeEnvelope({ from: 'qianmo://con/planner' })),
    ).resolves.toMatchObject({ code: ProtocolErrorCode.E_BAD_ADDRESS })
  })

  test('a malformed envelope is refused with the protocol code', async () => {
    const { adapter } = makeAdapter()
    const envelope = makeEnvelope()
    await expect(
      adapter.deliver({ ...envelope, trust: 'trusted' } as never),
    ).resolves.toMatchObject({ status: 'rejected' })
    await expect(
      adapter.deliver({ ...envelope, costLimit: 5 }),
    ).resolves.toMatchObject({ code: ProtocolErrorCode.E_BUDGET_EXHAUSTED })
  })

  test('the adapter refuses to be built on an illegal team name', () => {
    expect(() => new InboundAdapter({ node: NODE_B, team: 'con' })).toThrow()
    expect(
      () => new InboundAdapter({ node: NODE_B, team: 'Nest_Alpha' }),
    ).toThrow()
    expect(() => new InboundAdapter({ node: 'nul', team: 'nest' })).toThrow()
  })
})
