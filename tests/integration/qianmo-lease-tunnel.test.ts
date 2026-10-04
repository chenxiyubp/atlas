// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The seam between P5.2 and P5.3: a lease, then the tunnel that lease pays for.
 *
 * Each package proves its own half. What neither can prove alone is the join —
 * that the token the lender mints during the negotiation is the same string the
 * tunnel admits on, that the tunnel opens only after the grant, and that when
 * the lease ends the tunnel goes with it. That join is AC-7's fourth and sixth
 * beats (隧道建立 … 隧道拆除), and it is what this file runs.
 *
 * Nothing is mocked: real negotiators exchanging real envelopes, a real
 * transport listener on a unix socket, a real dial afterwards to prove the
 * listener is gone.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  type QianmoMessage,
  type ResourceNeed,
} from '@qianmo/protocol'
import {
  BorrowerNegotiator,
  LenderNegotiator,
  NegotiationAuditLog,
  NegotiationEventType,
} from '@qianmo/negotiation'
import { TransportClient } from '@qianmo/transport'
import {
  TeardownReason,
  TunnelAuditLog,
  TunnelClient,
  TunnelEventType,
  TunnelHost,
} from '@qianmo/tunnel'

const PSK = 'lease-tunnel-psk-not-a-real-secret'
const BORROWER = 'qianmo://node-a/planner'
const LENDER = 'qianmo://node-b/host'
const NEED: ResourceNeed = { durationMs: 120_000, cpuCores: 1, memoryMb: 512 }

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-lease-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'tunnel.sock')
}

async function nothingAnswers(socket: string): Promise<boolean> {
  if (!existsSync(socket)) return true
  const probe = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-probe',
    psk: PSK,
    keepAliveIntervalMs: 0,
    backoff: { giveUpAfterMs: 0 },
  })
  try {
    await probe.connect(500)
    return false
  } catch {
    return true
  } finally {
    await probe.close()
  }
}

interface Negotiated {
  readonly taskId: string
  readonly offerId: string
  readonly capability: string
  readonly granted: ResourceNeed
  readonly lender: LenderNegotiator
  readonly borrower: BorrowerNegotiator
  readonly audit: NegotiationAuditLog
}

/** Run the four-message negotiation for real and return what it produced. */
function negotiate(): Negotiated {
  const audit = new NegotiationAuditLog()
  const lender = new LenderNegotiator({
    address: LENDER,
    audit,
    policy: {
      ceiling: { durationMs: 600_000, cpuCores: 2, memoryMb: 2_048 },
      offerTtlMs: 60_000,
    },
    // The lender's own token: the tunnel will admit on this exact string, and
    // rule S-1 is what makes that meaningful — only this node could sign it.
    mintCapability: offer => `lease.${offer.taskId}.${offer.granted.cpuCores}`,
  })
  const borrower = new BorrowerNegotiator({
    address: BORROWER,
    audit,
    policy: { minimum: { durationMs: 60_000, cpuCores: 1, memoryMb: 256 } },
  })
  cleanups.push(() => {
    lender.close()
    borrower.close()
  })

  const opened = borrower.request(LENDER, NEED, 'rerun the suite that OOMed')
  const offer = lender.handle(opened.message).reply as QianmoMessage
  expect(offer.type).toBe(MessageType.ResourceOffer)
  const accepted = borrower.handle(offer)
  const grant = accepted.reply as QianmoMessage
  const leased = lender.handle(grant)
  expect(leased.reservation?.state).toBe('leased')

  const lease = accepted.lease
  if (lease?.offerId === undefined || lease.capability === undefined) {
    throw new Error('the negotiation did not produce a usable lease')
  }
  return {
    taskId: opened.taskId,
    offerId: lease.offerId,
    capability: lease.capability,
    granted: lease.granted as ResourceNeed,
    lender,
    borrower,
    audit,
  }
}

describe('a lease and the tunnel it pays for', () => {
  test('the token from the negotiation is the token the tunnel admits on', async () => {
    const lease = negotiate()
    const socket = socketPath()
    const tunnelAudit = new TunnelAuditLog()
    const carried: unknown[] = []
    const host = new TunnelHost({
      offerId: lease.offerId,
      taskId: lease.taskId,
      borrower: BORROWER,
      psk: PSK,
      capability: lease.capability,
      leaseMs: lease.granted.durationMs,
      unix: socket,
      audit: tunnelAudit,
      onWork: message => {
        carried.push(message.payload)
      },
    })
    cleanups.push(() => host.close(TeardownReason.Withdrawn))
    host.start()

    const client = new TunnelClient({
      address: BORROWER,
      node: 'node-a',
      psk: PSK,
      endpoint: { unix: socket },
      taskId: lease.taskId,
      lender: LENDER,
      capability: lease.capability,
      audit: tunnelAudit,
    })
    cleanups.push(() => client.close())
    await client.connect(3_000)
    await client.send({ run: 'bun test packages/transport' })
    expect(carried).toEqual([{ run: 'bun test packages/transport' }])

    // A second borrower holding the PSK but not the lease gets nowhere: the
    // pre-shared key is the door, the capability is the lease.
    const withoutLease = new TunnelClient({
      address: BORROWER,
      node: 'node-a',
      psk: PSK,
      endpoint: { unix: socket },
      taskId: lease.taskId,
      lender: LENDER,
      audit: tunnelAudit,
    })
    cleanups.push(() => withoutLease.close())
    await withoutLease.connect(3_000)
    await expect(
      withoutLease.send({ run: 'no lease' }, 2_000),
    ).rejects.toThrow()
    expect(carried).toHaveLength(1)
  })

  test('releasing the lease takes the tunnel with it, and the address stops answering', async () => {
    const lease = negotiate()
    const socket = socketPath()
    const tunnelAudit = new TunnelAuditLog()
    const closed: TeardownReason[] = []
    const host = new TunnelHost({
      offerId: lease.offerId,
      taskId: lease.taskId,
      borrower: BORROWER,
      psk: PSK,
      capability: lease.capability,
      leaseMs: lease.granted.durationMs,
      unix: socket,
      audit: tunnelAudit,
      onClosed: reason => closed.push(reason),
    })
    cleanups.push(() => host.close(TeardownReason.Withdrawn))
    host.start()

    const client = new TunnelClient({
      address: BORROWER,
      node: 'node-a',
      psk: PSK,
      endpoint: { unix: socket },
      taskId: lease.taskId,
      lender: LENDER,
      capability: lease.capability,
      audit: tunnelAudit,
    })
    cleanups.push(() => client.close())
    await client.connect(3_000)
    await client.send({ run: 'work' })
    expect(await nothingAnswers(socket)).toBe(false)

    // The borrower is done: it releases on the negotiation channel, and the
    // lender tears the tunnel down as part of handling that.
    const release = lease.borrower.release(lease.taskId, 'completed')
    expect(release).toBeDefined()
    lease.lender.handle(release as QianmoMessage)
    host.close(TeardownReason.Released)
    await client.close()

    expect(closed).toEqual([TeardownReason.Released])
    expect(lease.lender.pending).toBe(0)
    expect(await nothingAnswers(socket)).toBe(true)
    // Both trails record both ends. A log with opens and no closes reads as a
    // system that lends and never takes back.
    expect(tunnelAudit.count(TunnelEventType.Opened)).toBe(
      tunnelAudit.count(TunnelEventType.Closed),
    )
    expect(
      lease.audit.count(NegotiationEventType.Released),
    ).toBeGreaterThanOrEqual(1)
  })

  test('a borrower that dies mid-task loses the tunnel without releasing anything', async () => {
    const lease = negotiate()
    const socket = socketPath()
    const tunnelAudit = new TunnelAuditLog()
    const closed: TeardownReason[] = []
    const host = new TunnelHost({
      offerId: lease.offerId,
      taskId: lease.taskId,
      borrower: BORROWER,
      psk: PSK,
      capability: lease.capability,
      leaseMs: lease.granted.durationMs,
      unix: socket,
      audit: tunnelAudit,
      onClosed: reason => closed.push(reason),
    })
    cleanups.push(() => host.close(TeardownReason.Withdrawn))
    host.start()

    const client = new TunnelClient({
      address: BORROWER,
      node: 'node-a',
      psk: PSK,
      endpoint: { unix: socket },
      taskId: lease.taskId,
      lender: LENDER,
      capability: lease.capability,
      audit: tunnelAudit,
    })
    await client.connect(3_000)
    await client.send({ run: 'work that will not finish' })

    // No release, no goodbye — the borrower is simply gone.
    await client.close()
    const deadline = Date.now() + 3_000
    while (closed.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(closed).toEqual([TeardownReason.PeerLost])
    expect(await nothingAnswers(socket)).toBe(true)
    // The lease itself is still on the lender's books until its own deadline or
    // an explicit release — the tunnel closing is not a release, and conflating
    // the two would let a flaky network return somebody's capacity early.
    expect(lease.lender.pending).toBe(1)
  })
})
