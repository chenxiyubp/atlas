// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three things P5.2's DoD asks for, and the cases around them.
 *
 * 1. the whole four-message flow works;
 * 2. a request over the hard ceiling is refused (or cut down to it — never
 *    granted as asked);
 * 3. an offer nobody takes expires **and leaves nothing behind**.
 *
 * Both sides are driven by a manual scheduler, so every timeout is exercised
 * rather than waited for. A timeout nobody can trigger in a test is a timeout
 * nobody has seen work.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  MessageType,
  ProtocolErrorCode,
  createMessage,
  type ErrorPayload,
  type QianmoMessage,
  type ResourceNeed,
  validateMessage,
} from '@qianmo/protocol'
import {
  BorrowerNegotiator,
  LenderNegotiator,
  NegotiationAuditLog,
  NegotiationEventType,
  type CancelTimer,
  type LenderPolicy,
  type Scheduler,
} from '../src/index.js'

const BORROWER = 'qianmo://node-a/planner'
const LENDER = 'qianmo://node-b/host'
const NOW = 1_800_000_000_000

class ManualScheduler implements Scheduler {
  #armed: Array<{ at: number; callback: () => void }> = []
  clock = NOW

  after(delayMs: number, callback: () => void): CancelTimer {
    const entry = { at: this.clock + delayMs, callback }
    this.#armed.push(entry)
    return () => {
      this.#armed = this.#armed.filter(item => item !== entry)
    }
  }

  /** Move the clock and fire everything that came due. */
  advance(ms: number): void {
    this.clock += ms
    const due = this.#armed.filter(entry => entry.at <= this.clock)
    this.#armed = this.#armed.filter(entry => entry.at > this.clock)
    for (const entry of due) entry.callback()
  }

  get pending(): number {
    return this.#armed.length
  }
}

const CEILING: ResourceNeed = {
  durationMs: 600_000,
  cpuCores: 2,
  memoryMb: 2_048,
}

const POLICY: LenderPolicy = {
  ceiling: CEILING,
  offerTtlMs: 60_000,
  clampToCeiling: true,
  maxConcurrentLeases: 2,
}

let scheduler: ManualScheduler
let audit: NegotiationAuditLog
let lender: LenderNegotiator
let borrower: BorrowerNegotiator

beforeEach(() => {
  scheduler = new ManualScheduler()
  audit = new NegotiationAuditLog()
  lender = new LenderNegotiator({
    address: LENDER,
    policy: POLICY,
    audit,
    scheduler,
    now: () => scheduler.clock,
    newOfferId: (() => {
      let next = 0
      return () => `offer-${(next += 1)}`
    })(),
  })
  borrower = new BorrowerNegotiator({
    address: BORROWER,
    policy: {
      minimum: { durationMs: 60_000, cpuCores: 1, memoryMb: 512 },
    },
    audit,
    scheduler,
    now: () => scheduler.clock,
    newTaskId: (() => {
      let next = 0
      return () => `task-${(next += 1)}`
    })(),
  })
})

const NEED: ResourceNeed = { durationMs: 300_000, cpuCores: 2, memoryMb: 1_024 }

/** Every envelope the two sides exchange is a real, valid envelope. */
function assertOnTheWire(message: QianmoMessage): QianmoMessage {
  const result = validateMessage(message, { now: scheduler.clock })
  if (!result.ok) {
    throw new Error(
      `envelope failed validation: ${result.issues.map(i => i.message).join('; ')}`,
    )
  }
  return result.message
}

describe('the whole four-message flow', () => {
  test('request → offer → grant → release, with nothing left behind', () => {
    const opened = borrower.request(LENDER, NEED, 'rerun the failing suite')
    assertOnTheWire(opened.message)

    const offered = lender.handle(opened.message)
    const offer = assertOnTheWire(offered.reply as QianmoMessage)
    expect(offer.type).toBe(MessageType.ResourceOffer)
    expect(offer.taskId).toBe(opened.taskId)
    expect(lender.pending).toBe(1)

    const accepted = borrower.handle(offer)
    const grant = assertOnTheWire(accepted.reply as QianmoMessage)
    expect(grant.type).toBe(MessageType.ResourceGrant)
    expect(accepted.lease?.state).toBe('held')
    expect(accepted.lease?.granted).toEqual(NEED)

    const leased = lender.handle(grant)
    expect(leased.reservation?.state).toBe('leased')
    expect(leased.reply).toBeUndefined()

    const release = borrower.release(opened.taskId, 'completed')
    assertOnTheWire(release as QianmoMessage)
    lender.handle(release as QianmoMessage)

    // Both sides are empty, and the timers went with them.
    expect(lender.pending).toBe(0)
    expect(borrower.pending).toBe(0)
    expect(scheduler.pending).toBe(0)
    expect(audit.count(NegotiationEventType.Offered)).toBe(1)
    expect(audit.count(NegotiationEventType.Released)).toBeGreaterThanOrEqual(1)
  })

  test('the trace id survives the whole negotiation', () => {
    // One negotiation, one trace: C-6 asks that a chain be reconstructable, and
    // a four-message exchange under four traces is four chains.
    const opened = borrower.request(LENDER, NEED, 'reason')
    const offer = lender.handle(opened.message).reply as QianmoMessage
    const grant = borrower.handle(offer).reply as QianmoMessage
    const traceOf = (message: QianmoMessage): string =>
      message.traceId.split('-')[1] as string
    expect(traceOf(offer)).toBe(traceOf(opened.message))
    expect(traceOf(grant)).toBe(traceOf(opened.message))
  })
})

describe('the ceiling', () => {
  test('a request over it comes back smaller, never as asked', () => {
    const greedy: ResourceNeed = {
      durationMs: 86_400_000,
      cpuCores: 64,
      memoryMb: 262_144,
    }
    const opened = borrower.request(LENDER, greedy, 'give me the machine')
    const offer = lender.handle(opened.message).reply as QianmoMessage
    expect(offer.type).toBe(MessageType.ResourceOffer)
    const granted = (offer.payload as { granted: ResourceNeed }).granted
    expect(granted).toEqual(CEILING)
  })

  test('with counter-offers off, the same request is refused outright', () => {
    const strict = new LenderNegotiator({
      address: LENDER,
      policy: { ...POLICY, clampToCeiling: false },
      audit,
      scheduler,
      now: () => scheduler.clock,
    })
    const opened = borrower.request(LENDER, { ...NEED, cpuCores: 32 }, 'more')
    const reply = strict.handle(opened.message).reply as QianmoMessage
    expect(reply.type).toBe(MessageType.Error)
    expect((reply.payload as ErrorPayload).code).toBe(
      ProtocolErrorCode.E_RESOURCE_REFUSED,
    )
    expect(strict.pending).toBe(0)
    expect(audit.count(NegotiationEventType.Refused)).toBe(1)
  })

  test('an offer is never larger than the request', () => {
    const modest: ResourceNeed = {
      durationMs: 30_000,
      cpuCores: 1,
      memoryMb: 256,
    }
    const opened = borrower.request(LENDER, modest, 'small job')
    const offer = lender.handle(opened.message).reply as QianmoMessage
    expect((offer.payload as { granted: ResourceNeed }).granted).toEqual(modest)
  })

  test('a non-zero cost ceiling is refused before anything is reserved', () => {
    // Charter N-1: M0 lends nothing that costs money. The envelope check
    // catches this too; a negotiation is exactly where a spend would try to
    // enter, so it is refused here as well.
    const paid = createMessage({
      from: BORROWER,
      to: LENDER,
      type: MessageType.ResourceRequest,
      payload: { need: NEED, purpose: 'I will pay' },
      createdAt: scheduler.clock,
      costLimit: 5,
    })
    const reply = lender.handle(paid).reply as QianmoMessage
    expect((reply.payload as ErrorPayload).code).toBe(
      ProtocolErrorCode.E_RESOURCE_REFUSED,
    )
    expect(lender.pending).toBe(0)
  })

  test('a node already at its lease limit refuses rather than queues', () => {
    for (let index = 0; index < 2; index += 1) {
      const opened = borrower.request(LENDER, NEED, `job ${index}`)
      lender.handle(opened.message)
    }
    expect(lender.pending).toBe(2)
    const extra = borrower.request(LENDER, NEED, 'one more')
    const reply = lender.handle(extra.message).reply as QianmoMessage
    expect(reply.type).toBe(MessageType.Error)
    expect(lender.pending).toBe(2)
  })
})

describe('local authorization', () => {
  test('a lender whose operator says no makes no offer', () => {
    const guarded = new LenderNegotiator({
      address: LENDER,
      policy: POLICY,
      audit,
      scheduler,
      now: () => scheduler.clock,
      authorize: () => false,
    })
    const opened = borrower.request(LENDER, NEED, 'please')
    const reply = guarded.handle(opened.message).reply as QianmoMessage
    expect(reply.type).toBe(MessageType.Error)
    expect(guarded.pending).toBe(0)
  })

  test('the hook sees the clamped need and the purpose, and nothing else', () => {
    const seen: unknown[] = []
    const guarded = new LenderNegotiator({
      address: LENDER,
      policy: POLICY,
      audit,
      scheduler,
      now: () => scheduler.clock,
      authorize: request => {
        seen.push(request)
        return true
      },
    })
    const opened = borrower.request(
      LENDER,
      { durationMs: 900_000, cpuCores: 8, memoryMb: 4_096 },
      'a big one',
    )
    guarded.handle(opened.message)
    expect(seen).toEqual([
      { borrower: BORROWER, need: CEILING, purpose: 'a big one' },
    ])
  })

  test('the offer carries whatever token the lender minted', () => {
    const withToken = new LenderNegotiator({
      address: LENDER,
      policy: POLICY,
      audit,
      scheduler,
      now: () => scheduler.clock,
      mintCapability: () => 'token.signature',
    })
    const opened = borrower.request(LENDER, NEED, 'reason')
    const offer = withToken.handle(opened.message).reply as QianmoMessage
    expect((offer.payload as { capability?: string }).capability).toBe(
      'token.signature',
    )
    const held = borrower.handle(offer)
    expect(held.lease?.capability).toBe('token.signature')
  })
})

describe('nothing is left hanging', () => {
  test('an offer nobody takes expires and frees the reservation', () => {
    const opened = borrower.request(LENDER, NEED, 'reason')
    lender.handle(opened.message)
    expect(lender.pending).toBe(1)

    scheduler.advance(POLICY.offerTtlMs + 1)
    expect(lender.pending).toBe(0)
    expect(audit.count(NegotiationEventType.Released)).toBe(1)
    expect(audit.of(NegotiationEventType.Released)[0]?.detail['reason']).toBe(
      'expired',
    )
  })

  test('a grant that arrives after the offer expired is refused', () => {
    const opened = borrower.request(LENDER, NEED, 'reason')
    const offer = lender.handle(opened.message).reply as QianmoMessage
    const grant = borrower.handle(offer).reply as QianmoMessage

    scheduler.advance(POLICY.offerTtlMs + 1)
    const reply = lender.handle(grant).reply as QianmoMessage
    expect(reply.type).toBe(MessageType.Error)
    expect((reply.payload as ErrorPayload).code).toBe(
      ProtocolErrorCode.E_RESOURCE_REFUSED,
    )
    expect(lender.pending).toBe(0)
  })

  test('a request nobody answers stops being waited on', () => {
    const opened = borrower.request(LENDER, NEED, 'reason')
    expect(borrower.pending).toBe(1)
    scheduler.advance(30_001)
    expect(borrower.pending).toBe(0)
    expect(audit.count(NegotiationEventType.Abandoned)).toBe(1)

    // And an offer that turns up afterwards is not taken.
    const late = lender.handle(opened.message).reply as QianmoMessage
    expect(borrower.handle(late).declined).toContain('no request is open')
  })

  test('the lease itself expires when its duration runs out', () => {
    const opened = borrower.request(LENDER, NEED, 'reason')
    const offer = lender.handle(opened.message).reply as QianmoMessage
    const grant = borrower.handle(offer).reply as QianmoMessage
    lender.handle(grant)
    expect(lender.pending).toBe(1)

    scheduler.advance(NEED.durationMs + 1)
    expect(lender.pending).toBe(0)
  })

  test('the same offer cannot be taken twice', () => {
    const opened = borrower.request(LENDER, NEED, 'reason')
    const offer = lender.handle(opened.message).reply as QianmoMessage
    const grant = borrower.handle(offer).reply as QianmoMessage
    expect(lender.handle(grant).reservation?.state).toBe('leased')
    const second = lender.handle(grant).reply as QianmoMessage
    expect(second.type).toBe(MessageType.Error)
  })

  test('another peer cannot take an offer it was not made', () => {
    const opened = borrower.request(LENDER, NEED, 'reason')
    const offer = lender.handle(opened.message).reply as QianmoMessage
    const offerId = (offer.payload as { offerId: string }).offerId
    const stolen = createMessage({
      from: 'qianmo://node-c/intruder',
      to: LENDER,
      type: MessageType.ResourceGrant,
      taskId: opened.taskId,
      payload: { offerId, acceptedAt: scheduler.clock },
      createdAt: scheduler.clock,
    })
    const reply = lender.handle(stolen).reply as QianmoMessage
    expect(reply.type).toBe(MessageType.Error)
    expect(lender.reservation(offerId)?.state).toBe('offered')
  })

  test('releasing something already gone is not an error', () => {
    // A release that crossed with an expiry is the normal shape of that race.
    const release = createMessage({
      from: BORROWER,
      to: LENDER,
      type: MessageType.ResourceRelease,
      payload: {
        offerId: 'offer-never',
        reason: 'completed',
        releasedAt: scheduler.clock,
      },
      createdAt: scheduler.clock,
    })
    expect(lender.handle(release)).toEqual({})
  })

  test('an offer below what the borrower needs is declined and given back', () => {
    const stingy = new LenderNegotiator({
      address: LENDER,
      policy: {
        ceiling: { durationMs: 1_000, cpuCores: 1, memoryMb: 64 },
        offerTtlMs: 60_000,
      },
      audit,
      scheduler,
      now: () => scheduler.clock,
    })
    const opened = borrower.request(LENDER, NEED, 'reason')
    const offer = stingy.handle(opened.message).reply as QianmoMessage
    const answer = borrower.handle(offer)
    expect(answer.lease).toBeUndefined()
    expect(answer.declined).toContain('below what this task needs')
    // And the lender is told, so its reservation goes back immediately rather
    // than at the end of the offer's life.
    stingy.handle(answer.reply as QianmoMessage)
    expect(stingy.pending).toBe(0)
  })

  test('close drops every timer on both sides', () => {
    borrower.request(LENDER, NEED, 'reason')
    const opened = borrower.request(LENDER, NEED, 'reason')
    lender.handle(opened.message)
    lender.close()
    borrower.close()
    expect(scheduler.pending).toBe(0)
    expect(lender.pending).toBe(0)
    expect(borrower.pending).toBe(0)
  })
})
