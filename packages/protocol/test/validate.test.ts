// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  LIMITS,
  MessageType,
  ProtocolError,
  ProtocolErrorCode,
  assertValidMessage,
  createMessage,
  firstErrorCode,
  validateMessage,
  type QianmoMessage,
} from '../src/index.js'

const NOW = 1_700_000_000_000

const ACK_PAYLOAD = {
  handler: 'qianmo://osaka-2/worker',
  ackAt: NOW,
}

const TASK_RESULT_PAYLOAD = {
  outcome: 'completed',
  content: 'done',
  completedAt: NOW,
}

function sample(
  overrides: Partial<QianmoMessage> = {},
): Record<string, unknown> {
  const base = createMessage({
    from: 'qianmo://tokyo-1/planner',
    to: 'qianmo://osaka-2/worker',
    type: MessageType.TaskRequest,
    payload: { goal: 'summarise' },
    msgId: 'm-1',
    traceId: 't-1',
    taskId: 'task-1',
    createdAt: NOW,
    deliverTtlMs: 10_000,
    taskTtlMs: 300_000,
  })
  return { ...base, ...overrides }
}

function codesOf(input: unknown, node?: string): readonly ProtocolErrorCode[] {
  const result = validateMessage(
    input,
    node === undefined ? { now: NOW } : { now: NOW, node },
  )
  return result.ok ? [] : result.issues.map(i => i.code)
}

describe('validateMessage — accepts', () => {
  test('a freshly created message', () => {
    const result = validateMessage(sample(), { now: NOW })
    expect(result.ok).toBe(true)
    expect(firstErrorCode(result)).toBeNull()
  })

  test('a message that has legitimately travelled', () => {
    expect(
      codesOf(sample({ hops: ['tokyo-1', 'relay-3'] }), 'osaka-2'),
    ).toEqual([])
  })

  test('a message on its very last millisecond', () => {
    const result = validateMessage(sample({ createdAt: NOW - 10_000 }), {
      now: NOW,
    })
    expect(result.ok).toBe(true)
  })

  test('every declared message type', () => {
    // Types whose payload is field-closed carry their own sample; everything
    // else takes an arbitrary object, which is exactly the point of not
    // constraining those.
    const CLOSED_PAYLOADS: Partial<Record<MessageType, unknown>> = {
      [MessageType.Ack]: ACK_PAYLOAD,
      [MessageType.TaskResult]: TASK_RESULT_PAYLOAD,
      [MessageType.ResourceRequest]: {
        need: { durationMs: 60_000, cpuCores: 1, memoryMb: 512 },
        purpose: 'run the failing test suite',
      },
      [MessageType.ResourceOffer]: {
        offerId: 'offer-1',
        granted: { durationMs: 60_000, cpuCores: 1, memoryMb: 512 },
        offerExpiresAt: NOW + 30_000,
      },
      [MessageType.ResourceGrant]: { offerId: 'offer-1', acceptedAt: NOW },
      [MessageType.ResourceRelease]: {
        offerId: 'offer-1',
        reason: 'completed',
        releasedAt: NOW,
      },
      [MessageType.Notify]: {
        kind: 'watch',
        severity: 'info',
        summary: 'disk usage crossed 80%',
        observedAt: NOW,
      },
    }
    for (const type of Object.values(MessageType)) {
      const payload = CLOSED_PAYLOADS[type] ?? { goal: 'summarise' }
      expect(codesOf(sample({ type, payload }))).toEqual([])
    }
  })

  test('a negotiation payload with an extra field is refused', () => {
    // Field-closed for the same reason the ack is: a lease authorizes spending
    // somebody else's machine, and a field this version does not understand is
    // one nobody verified.
    expect(
      codesOf(
        sample({
          type: MessageType.ResourceGrant,
          payload: { offerId: 'offer-1', acceptedAt: NOW, alsoGiveMe: 'gpu' },
        }),
      ),
    ).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE])
  })

  test('a negotiation payload with a non-positive axis is refused', () => {
    expect(
      codesOf(
        sample({
          type: MessageType.ResourceRequest,
          payload: {
            need: { durationMs: 60_000, cpuCores: 0, memoryMb: 512 },
            purpose: 'zero cores is not a request, it is a typo',
          },
        }),
      ),
    ).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE])
  })

  test('narrows the value on success', () => {
    const result = validateMessage(sample(), { now: NOW })
    if (!result.ok) throw new Error('expected ok')
    expect(result.message.type).toBe(MessageType.TaskRequest)
    expect(result.message.msgId).toBe('m-1')
  })
})

describe('validateMessage — structure', () => {
  test.each([
    ['v', ProtocolErrorCode.E_BAD_VERSION],
    ['from', ProtocolErrorCode.E_BAD_ADDRESS],
    ['to', ProtocolErrorCode.E_BAD_ADDRESS],
    ['type', ProtocolErrorCode.E_BAD_TYPE],
  ] as const)('diagnostic formatting cannot throw for an invalid JSON value in %s', (field, code) => {
    const input = JSON.parse(
      JSON.stringify({ ...sample(), [field]: { toString: null } }),
    )
    expect(codesOf(input)).toContain(code)
  })

  test.each([
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
  ])('rejects inherited object key %s as an unknown message type', type => {
    expect(codesOf({ ...sample(), type })).toContain(
      ProtocolErrorCode.E_BAD_TYPE,
    )
  })

  test('rejects non-objects', () => {
    expect(codesOf(null)).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE])
    expect(codesOf('a string')).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE])
    expect(codesOf([])).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE])
  })

  test('rejects an unknown envelope version', () => {
    expect(codesOf({ ...sample(), v: 1 })).toContain(
      ProtocolErrorCode.E_BAD_VERSION,
    )
  })

  test('rejects missing identifiers', () => {
    expect(codesOf({ ...sample(), msgId: '' })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), traceId: 5 })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
  })

  test('rejects bad addresses on either side', () => {
    expect(codesOf({ ...sample(), from: 'tokyo-1/planner' })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    )
    expect(codesOf({ ...sample(), to: 'qianmo://osaka-2' })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    )
  })

  test('rejects an unknown message type', () => {
    expect(codesOf({ ...sample(), type: 'task.cancel' })).toContain(
      ProtocolErrorCode.E_BAD_TYPE,
    )
  })

  test('keeps the ack payload field-closed (K-1)', () => {
    const ack = { type: MessageType.Ack, payload: ACK_PAYLOAD }
    expect(codesOf(sample(ack))).toEqual([])
    expect(
      codesOf(
        sample({
          type: MessageType.Ack,
          payload: { ...ACK_PAYLOAD, taskId: 'task-1' },
        }),
      ),
    ).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
    const { handler: _handler, ...missing } = ACK_PAYLOAD
    expect(
      codesOf(sample({ type: MessageType.Ack, payload: missing })),
    ).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
    expect(
      codesOf(sample({ type: MessageType.Ack, payload: 'acked' })),
    ).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
  })

  test('keeps both task.result branches field-closed', () => {
    expect(
      codesOf(
        sample({
          type: MessageType.TaskResult,
          payload: TASK_RESULT_PAYLOAD,
        }),
      ),
    ).toEqual([])
    expect(
      codesOf(
        sample({
          type: MessageType.TaskResult,
          payload: { ...TASK_RESULT_PAYLOAD, taskId: 'task-1' },
        }),
      ),
    ).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
    expect(
      codesOf(
        sample({
          type: MessageType.TaskResult,
          payload: {
            outcome: 'failed',
            code: ProtocolErrorCode.E_TASK_FAILED,
            reason: 'model stopped',
            completedAt: NOW,
          },
        }),
      ),
    ).toEqual([])
    expect(
      codesOf(
        sample({
          type: MessageType.TaskResult,
          payload: {
            outcome: 'failed',
            code: 'E_MADE_UP',
            reason: 'model stopped',
            completedAt: NOW,
          },
        }),
      ),
    ).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
  })

  test('rejects a missing payload key', () => {
    const { payload: _payload, ...withoutPayload } = sample()
    expect(codesOf(withoutPayload)).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
  })

  test('rejects non-positive timestamps and deadlines', () => {
    expect(codesOf({ ...sample(), createdAt: 0 })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), createdAt: Number.NaN })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), deliverTtlMs: -1 })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), taskTtlMs: -1 })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
  })

  test('requires both deadlines, not just one', () => {
    const { deliverTtlMs: _d, ...noDelivery } = sample()
    expect(codesOf(noDelivery)).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
    const { taskTtlMs: _t, ...noTask } = sample()
    expect(codesOf(noTask)).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
  })

  test('requires a taskId — it is the correlation and loop key', () => {
    expect(codesOf({ ...sample(), taskId: '' })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    const { taskId: _id, ...withoutTask } = sample()
    expect(codesOf(withoutTask)).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
  })

  test('accepts an absent contextId but not a malformed one', () => {
    const { contextId: _ctx, ...withoutContext } = sample()
    expect(codesOf(withoutContext)).toEqual([])
    expect(codesOf({ ...sample(), contextId: 7 })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), contextId: 'ctx-1' })).toEqual([])
  })

  test('requires a sha-256 fingerprint', () => {
    expect(codesOf({ ...sample(), fingerprint: 'nope' })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), fingerprint: 'A'.repeat(64) })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), fingerprint: 'a'.repeat(64) })).toEqual([])
  })

  test('requires a structurally sound origin', () => {
    expect(codesOf({ ...sample(), origin: null })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), origin: { node: 'tokyo-1' } })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(
      codesOf({ ...sample(), origin: { node: 'NOPE', agent: 'planner' } }),
    ).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
    expect(
      codesOf({
        ...sample(),
        origin: {
          node: 'tokyo-1',
          agent: 'planner',
          capIss: 'qianmo://tokyo-1/planner',
          receivedAt: NOW,
        },
      }),
    ).toEqual([])
  })

  test('rejects any trust marker other than "untrusted"', () => {
    expect(codesOf({ ...sample(), trust: 'trusted' })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    const { trust: _trust, ...withoutTrust } = sample()
    expect(codesOf(withoutTrust)).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
  })

  test('accepts an absent cap but not an empty one', () => {
    const { cap: _cap, ...withoutCap } = sample()
    expect(codesOf(withoutCap)).toEqual([])
    expect(codesOf({ ...sample(), cap: '' })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), cap: 'token' })).toEqual([])
  })

  test('rejects a missing or non-numeric costLimit', () => {
    const { costLimit: _cost, ...withoutCost } = sample()
    expect(codesOf(withoutCost)).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
    expect(codesOf({ ...sample(), costLimit: '0' })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), costLimit: -1 })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
  })

  test('rejects a malformed hop list', () => {
    expect(codesOf({ ...sample(), hops: 'tokyo-1' })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    )
    expect(codesOf({ ...sample(), hops: ['tokyo-1', 3] })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    )
    expect(codesOf({ ...sample(), hops: ['NOT A NODE'] })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    )
  })

  test('reports every structural problem at once', () => {
    const codes = codesOf({ ...sample(), v: 3, msgId: '', to: 'nope' })
    expect(codes).toContain(ProtocolErrorCode.E_BAD_VERSION)
    expect(codes).toContain(ProtocolErrorCode.E_BAD_ENVELOPE)
    expect(codes).toContain(ProtocolErrorCode.E_BAD_ADDRESS)
  })
})

describe('validateMessage — boundaries', () => {
  test('rejects a message past its DELIVERY deadline', () => {
    const expired = sample({ createdAt: NOW - 10_001 })
    expect(codesOf(expired)).toEqual([ProtocolErrorCode.E_TTL_EXPIRED])
  })

  test('the task deadline is not an envelope-validity question', () => {
    // `created → completed` is a sender-side timer (§8.2 row 21). A message
    // whose task budget is thin but whose delivery window is open is valid.
    const result = validateMessage(sample({ taskTtlMs: 1 }), { now: NOW })
    expect(result.ok).toBe(true)
  })

  test('rejects a non-zero costLimit with E_BUDGET_EXHAUSTED', () => {
    expect(codesOf(sample({ costLimit: 1 }))).toEqual([
      ProtocolErrorCode.E_BUDGET_EXHAUSTED,
    ])
    expect(codesOf(sample({ costLimit: 0 }))).toEqual([])
  })

  test('rejects an oversized message with E_TOO_LARGE', () => {
    const huge = sample({ payload: 'x'.repeat(LIMITS.maxMessageBytes + 1) })
    expect(codesOf(huge)).toEqual([ProtocolErrorCode.E_TOO_LARGE])
  })

  test('honours an injected size limit', () => {
    const result = validateMessage(sample(), { now: NOW, maxMessageBytes: 10 })
    expect(firstErrorCode(result)).toBe(ProtocolErrorCode.E_TOO_LARGE)
  })

  test('rejects too many hops with E_TOO_MANY_HOPS', () => {
    const hops = Array.from({ length: LIMITS.maxHops + 1 }, (_, i) => `n${i}`)
    expect(codesOf(sample({ hops }))).toEqual([
      ProtocolErrorCode.E_TOO_MANY_HOPS,
    ])
    const atLimit = Array.from({ length: LIMITS.maxHops }, (_, i) => `n${i}`)
    expect(codesOf(sample({ hops: atLimit }))).toEqual([])
  })

  test('options.node still reports E_LOOP — debug hint, never used inbound', () => {
    const codes = codesOf(sample({ hops: ['tokyo-1', 'relay-3'] }), 'relay-3')
    expect(codes).toEqual([ProtocolErrorCode.E_LOOP])
  })

  // D-2 negative self-test: the duplicate-hops assertion is gone. A relay that
  // legitimately carries the same task twice, for two different handlers, is
  // NOT a loop — that verdict belongs to `(handler address, taskId)` in P4.2.
  test('does NOT reject duplicated hops without a node hint', () => {
    expect(codesOf(sample({ hops: ['relay-3', 'relay-3'] }))).toEqual([])
    expect(
      codesOf(sample({ hops: ['tokyo-1', 'relay-3', 'tokyo-1'] }), 'osaka-2'),
    ).toEqual([])
  })

  test('duplicated hops still trip the maxHops backstop', () => {
    const hops = Array.from({ length: LIMITS.maxHops + 1 }, () => 'relay-3')
    expect(codesOf(sample({ hops }))).toEqual([
      ProtocolErrorCode.E_TOO_MANY_HOPS,
    ])
  })

  test('a node absent from hops is not a loop', () => {
    expect(codesOf(sample({ hops: ['tokyo-1'] }), 'osaka-2')).toEqual([])
  })
})

describe('assertValidMessage', () => {
  test('returns the message when valid', () => {
    const message = assertValidMessage(sample(), { now: NOW })
    expect(message.msgId).toBe('m-1')
  })

  test('throws a ProtocolError carrying the first code', () => {
    try {
      assertValidMessage(sample({ createdAt: NOW - 60_000 }), { now: NOW })
      throw new Error('expected assertValidMessage to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(
        ProtocolErrorCode.E_TTL_EXPIRED,
      )
      expect((error as ProtocolError).issues.length).toBeGreaterThan(0)
    }
  })
})
