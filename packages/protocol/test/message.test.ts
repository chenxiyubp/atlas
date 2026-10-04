// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  ENVELOPE_VERSION,
  LEGACY_MESSAGE_TYPES,
  LIMITS,
  MESSAGE_TYPES,
  MessageType,
  ProtocolError,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  advanceTraceparent,
  computeFingerprint,
  createAck,
  createMessage,
  createTaskResult,
  isAckPayload,
  deliveryExpiresAt,
  destinationNode,
  errorReply,
  isDeliveryExpired,
  isMessageType,
  isReplyType,
  isTaskExpired,
  isTaskResultPayload,
  messageBytes,
  newId,
  newTraceparent,
  payloadDigest,
  serializeMessage,
  taskExpiresAt,
  withHop,
} from '../src/index.js'

const FROM = 'qianmo://tokyo-1/planner'
const TO = 'qianmo://osaka-2/worker'

describe('message types', () => {
  test('covers exactly the v0 type set', () => {
    expect([...MESSAGE_TYPES].sort() as string[]).toEqual(
      [
        'ack',
        'error',
        'ping',
        'pong',
        'task.request',
        'task.result',
        'wake',
        // §13, added by P5.2. The four negotiation messages are envelope types
        // rather than a payload discriminator so that routing, dedup and the
        // audit trail treat them like everything else on the wire.
        'resource.request',
        'resource.offer',
        'resource.grant',
        'resource.release',
        // §14, added by P13.2. The only type an agent raises unprompted.
        'notify',
      ].sort(),
    )
    expect(MESSAGE_TYPES).toHaveLength(12)
  })

  test('the legacy floor is the eleven types that predate notify', () => {
    // Capability discovery reads an absent declaration as "this peer speaks the
    // floor". A floor that grew with the enum would say every peer speaks every
    // type, which is the assumption discovery exists to stop making.
    expect(LEGACY_MESSAGE_TYPES).toHaveLength(11)
    expect(LEGACY_MESSAGE_TYPES).not.toContain(MessageType.Notify)
    expect([...LEGACY_MESSAGE_TYPES].sort()).toEqual(
      MESSAGE_TYPES.filter(type => type !== MessageType.Notify).sort(),
    )
  })

  test('isMessageType accepts known types and rejects the rest', () => {
    expect(isMessageType(MessageType.TaskRequest)).toBe(true)
    expect(isMessageType('task.result')).toBe(true)
    expect(isMessageType('task.cancel')).toBe(false)
    expect(isMessageType(7)).toBe(false)
  })
})

describe('limits', () => {
  test('declares the v0 boundaries', () => {
    expect(LIMITS.maxMessageBytes).toBe(262144)
    expect(LIMITS.maxHops).toBe(8)
    expect(LIMITS.defaultTtlMs).toBeGreaterThan(0)
    expect(LIMITS.defaultTaskTtlMs).toBeGreaterThan(0)
    expect(LIMITS.ratePerMinute).toBeGreaterThan(0)
  })

  test('the task deadline outlasts the delivery deadline', () => {
    expect(LIMITS.defaultTaskTtlMs).toBeGreaterThan(LIMITS.defaultTtlMs)
  })
})

describe('createMessage', () => {
  test('fills in defaults', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
    })
    expect(message.v).toBe(ENVELOPE_VERSION)
    expect(message.msgId.length).toBeGreaterThan(0)
    expect(message.traceId.length).toBeGreaterThan(0)
    expect(message.taskId.length).toBeGreaterThan(0)
    expect(message.deliverTtlMs).toBe(LIMITS.defaultTtlMs)
    expect(message.taskTtlMs).toBe(LIMITS.defaultTaskTtlMs)
    expect(message.hops).toEqual([])
    expect(message.createdAt).toBeGreaterThan(0)
    expect(message.trust).toBe(TRUST_UNTRUSTED)
    expect(message.costLimit).toBe(0)
    expect(message.origin).toEqual({ node: 'tokyo-1', agent: 'planner' })
  })

  test('omits the optional fields rather than writing undefined', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
    })
    expect('contextId' in message).toBe(false)
    expect('cap' in message).toBe(false)
    expect(JSON.parse(serializeMessage(message))).not.toHaveProperty(
      'contextId',
    )
  })

  test('honours explicit fields', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.TaskRequest,
      payload: { goal: 'summarise' },
      msgId: 'm-1',
      traceId: 't-1',
      taskId: 'task-1',
      contextId: 'ctx-1',
      createdAt: 1_000,
      deliverTtlMs: 500,
      taskTtlMs: 60_000,
      hops: ['tokyo-1'],
      cap: 'cap-token',
    })
    expect(message.msgId).toBe('m-1')
    expect(message.traceId).toBe('t-1')
    expect(message.taskId).toBe('task-1')
    expect(message.contextId).toBe('ctx-1')
    expect(message.cap).toBe('cap-token')
    expect(message.hops).toEqual(['tokyo-1'])
    expect(deliveryExpiresAt(message)).toBe(1_500)
    expect(taskExpiresAt(message)).toBe(61_000)
  })

  test('defaults traceId to a W3C traceparent', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
    })
    expect(message.traceId).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    )
    expect(newTraceparent()).not.toBe(newTraceparent())
  })

  test('advanceTraceparent keeps the trace-id and moves the parent-id', () => {
    const origin = newTraceparent()
    const next = advanceTraceparent(origin)
    const [version, traceId, parentId, flags] = origin.split('-')
    const [nextVersion, nextTraceId, nextParentId, nextFlags] = next.split('-')
    expect(nextTraceId).toBe(traceId as string)
    expect(nextVersion).toBe(version as string)
    expect(nextFlags).toBe(flags as string)
    expect(nextParentId).not.toBe(parentId as string)
    expect(nextParentId).toMatch(/^[0-9a-f]{16}$/)
  })

  test('advanceTraceparent leaves a malformed header alone', () => {
    // Not a validator: rewriting it would hide the malformation from the
    // envelope check that does reject it.
    expect(advanceTraceparent('not-a-traceparent')).toBe('not-a-traceparent')
  })

  test('isReplyType splits answers from work requests', () => {
    // The line loop detection depends on: a reply legitimately returns to the
    // requester under the request's own taskId (C-1), which is exactly the
    // shape the loop key describes.
    expect(MESSAGE_TYPES.filter(isReplyType)).toEqual([
      MessageType.Ack,
      MessageType.TaskResult,
      MessageType.Pong,
      MessageType.Error,
      // Everything after the opening `resource.request` answers the message
      // before it (§13), so the loop key must not judge them either.
      MessageType.ResourceOffer,
      MessageType.ResourceGrant,
      MessageType.ResourceRelease,
    ])
  })

  test('trust is a closed set — the caller cannot widen it', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
    })
    createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
      // @ts-expect-error `trust` is not part of CreateMessageInput at all.
      trust: 'trusted',
    })
    expect(message.trust).toBe('untrusted')
  })

  test('newId produces distinct identifiers', () => {
    expect(newId()).not.toBe(newId())
  })

  test('destinationNode reads the recipient node', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: 1,
    })
    expect(destinationNode(message)).toBe('osaka-2')
  })
})

describe('withHop', () => {
  const base = createMessage({
    from: FROM,
    to: TO,
    type: MessageType.TaskRequest,
    payload: {},
    createdAt: 1_000,
  })

  test('appends without mutating the original', () => {
    const hopped = withHop(base, 'tokyo-1')
    expect(hopped.hops).toEqual(['tokyo-1'])
    expect(base.hops).toEqual([])
    expect(withHop(hopped, 'osaka-2').hops).toEqual(['tokyo-1', 'osaka-2'])
  })

  // D-2 negative self-test: node granularity used to reject this. A legitimate
  // spiral — same relay traversed twice on the way to two different handlers —
  // must now pass. Loop detection is `(handler address, taskId)` in the router.
  test('does NOT reject a node revisited for a different handler', () => {
    const spiral = withHop(
      withHop(withHop(base, 'relay-1'), 'osaka-2'),
      'relay-1',
    )
    expect(spiral.hops).toEqual(['relay-1', 'osaka-2', 'relay-1'])
  })

  test('a node repeated many times still only trips the maxHops backstop', () => {
    let message = base
    for (let i = 0; i < LIMITS.maxHops; i += 1) {
      message = withHop(message, 'relay-1')
    }
    expect(message.hops).toHaveLength(LIMITS.maxHops)
    expect(new Set(message.hops).size).toBe(1)
    try {
      withHop(message, 'relay-1')
      throw new Error('expected withHop to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(
        ProtocolErrorCode.E_TOO_MANY_HOPS,
      )
    }
  })

  test('throws E_TOO_MANY_HOPS past the limit', () => {
    let message = base
    for (let i = 0; i < LIMITS.maxHops; i += 1) {
      message = withHop(message, `n${i}`)
    }
    expect(message.hops).toHaveLength(LIMITS.maxHops)
    try {
      withHop(message, 'one-too-many')
      throw new Error('expected withHop to throw')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(
        ProtocolErrorCode.E_TOO_MANY_HOPS,
      )
    }
  })
})

describe('the two deadlines', () => {
  const message = createMessage({
    from: FROM,
    to: TO,
    type: MessageType.TaskRequest,
    payload: null,
    createdAt: 10_000,
    deliverTtlMs: 1_000,
    taskTtlMs: 5_000,
  })

  test('isDeliveryExpired follows the injected clock', () => {
    expect(deliveryExpiresAt(message)).toBe(11_000)
    expect(isDeliveryExpired(message, 10_500)).toBe(false)
    expect(isDeliveryExpired(message, 11_000)).toBe(false)
    expect(isDeliveryExpired(message, 11_001)).toBe(true)
  })

  test('isTaskExpired follows its own, longer clock', () => {
    expect(taskExpiresAt(message)).toBe(15_000)
    expect(isTaskExpired(message, 11_001)).toBe(false)
    expect(isTaskExpired(message, 15_000)).toBe(false)
    expect(isTaskExpired(message, 15_001)).toBe(true)
  })

  test('delivery can be long past due while the task is still alive', () => {
    // The whole point of the split: `created → acked` blown does not mean
    // `created → completed` is blown.
    expect(isDeliveryExpired(message, 12_000)).toBe(true)
    expect(isTaskExpired(message, 12_000)).toBe(false)
  })

  test('messageBytes measures the utf-8 serialization', () => {
    expect(messageBytes(message)).toBe(
      new TextEncoder().encode(serializeMessage(message)).length,
    )
    const wide = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: '阡陌',
      createdAt: 10_000,
    })
    expect(messageBytes(wide)).toBeGreaterThan(JSON.stringify(wide).length - 6)
  })
})

describe('fingerprint', () => {
  function withOverrides(
    overrides: Partial<{
      to: string
      taskId: string
      payload: unknown
      msgId: string
      createdAt: number
      hops: readonly string[]
      traceId: string
    }> = {},
  ) {
    return createMessage({
      from: FROM,
      to: TO,
      type: MessageType.TaskRequest,
      payload: { goal: 'summarise' },
      taskId: 'task-1',
      msgId: 'm-1',
      createdAt: 10_000,
      traceId: 't-1',
      ...overrides,
    })
  }

  test('is a sha-256 hex digest of [from, to, type, taskId, payloadDigest]', () => {
    const message = withOverrides()
    expect(message.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(message.fingerprint).toBe(
      computeFingerprint({
        from: FROM,
        to: TO,
        type: MessageType.TaskRequest,
        taskId: 'task-1',
        payload: { goal: 'summarise' },
      }),
    )
  })

  test('survives a rebuild of the same work — that is the second dedup level', () => {
    const first = withOverrides()
    const rebuilt = withOverrides({
      msgId: 'm-2',
      createdAt: 20_000,
      hops: ['tokyo-1'],
      traceId: 't-2',
    })
    expect(rebuilt.msgId).not.toBe(first.msgId)
    expect(rebuilt.fingerprint).toBe(first.fingerprint)
  })

  test('changes with any of its five inputs', () => {
    const base = withOverrides().fingerprint
    expect(
      withOverrides({ to: 'qianmo://osaka-2/other' }).fingerprint,
    ).not.toBe(base)
    expect(withOverrides({ taskId: 'task-2' }).fingerprint).not.toBe(base)
    expect(
      withOverrides({ payload: { goal: 'translate' } }).fingerprint,
    ).not.toBe(base)
    expect(
      computeFingerprint({
        from: FROM,
        to: TO,
        type: MessageType.TaskResult,
        taskId: 'task-1',
        payload: { goal: 'summarise' },
      }),
    ).not.toBe(base)
  })

  test('payloadDigest handles a payload JSON cannot encode', () => {
    expect(payloadDigest(undefined)).toMatch(/^[0-9a-f]{64}$/)
    expect(payloadDigest(null)).not.toBe(payloadDigest(undefined))
  })

  test('an explicit fingerprint wins, for re-senders', () => {
    const forced = 'a'.repeat(64)
    expect(withOverrides().fingerprint).not.toBe(forced)
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.TaskRequest,
      payload: {},
      fingerprint: forced,
    })
    expect(message.fingerprint).toBe(forced)
  })
})

describe('origin', () => {
  test('is seeded from the sender address', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
    })
    expect(message.origin.node).toBe('tokyo-1')
    expect(message.origin.agent).toBe('planner')
    expect(message.origin.capIss).toBeUndefined()
    expect(message.origin.receivedAt).toBeUndefined()
  })

  test('a receiver may overwrite it wholesale', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
      origin: {
        node: 'tokyo-1',
        agent: 'planner',
        capIss: 'qianmo://tokyo-1/planner',
        receivedAt: 42_000,
      },
    })
    expect(message.origin.capIss).toBe('qianmo://tokyo-1/planner')
    expect(message.origin.receivedAt).toBe(42_000)
  })

  test('a malformed sender address yields an origin that cannot validate', () => {
    const message = createMessage({
      from: 'not-an-address',
      to: TO,
      type: MessageType.Ping,
      payload: null,
    })
    expect(message.origin).toEqual({ node: '', agent: '' })
  })
})

describe('ack', () => {
  const request = createMessage({
    from: FROM,
    to: TO,
    type: MessageType.TaskRequest,
    payload: { goal: 'summarise' },
    msgId: 'm-1',
    taskId: 'task-1',
    contextId: 'ctx-1',
    traceId: 't-1',
    createdAt: 1_000,
  })

  test('createAck keeps correlation in the envelope only', () => {
    const ack = createAck(request, TO, 2_000)
    expect(ack.type).toBe(MessageType.Ack)
    expect(ack.from).toBe(TO)
    expect(ack.to).toBe(FROM)
    expect(ack.taskId).toBe('task-1')
    expect(ack.contextId).toBe('ctx-1')
    expect(ack.traceId).toBe('t-1')
    expect(ack.msgId).not.toBe(request.msgId)
    expect(ack.payload).toEqual({ handler: TO, ackAt: 2_000 })
    expect(Object.keys(ack.payload).sort()).toEqual(['ackAt', 'handler'])
  })

  test('the payload type is closed — no room for IDs, status or ETA', () => {
    const ack = createAck(request, TO, 2_000)
    const widened: typeof ack.payload = {
      handler: TO,
      ackAt: 2_000,
      // @ts-expect-error K-1: identifiers belong to the envelope.
      taskId: 'task-1',
    }
    expect(isAckPayload(widened)).toBe(false)
  })

  test('isAckPayload rejects extras, gaps and wrong types', () => {
    const good = { handler: TO, ackAt: 2_000 }
    expect(isAckPayload(good)).toBe(true)
    expect(isAckPayload({ ...good, eta: 5 })).toBe(false)
    expect(isAckPayload({ ...good, handler: 'worker' })).toBe(false)
    expect(isAckPayload({ ...good, ackAt: '2000' })).toBe(false)
    const { handler: _missing, ...gap } = good
    expect(isAckPayload(gap)).toBe(false)
    expect(isAckPayload(null)).toBe(false)
    expect(isAckPayload([good])).toBe(false)
  })
})

describe('task result', () => {
  const request = createMessage({
    from: FROM,
    to: TO,
    type: MessageType.TaskRequest,
    payload: { goal: 'summarise' },
    msgId: 'm-1',
    taskId: 'task-1',
    contextId: 'ctx-1',
    traceId: 't-1',
    createdAt: 1_000,
  })

  test('builds a completed result with IDs only in the envelope', () => {
    const result = createTaskResult(
      request,
      TO,
      { outcome: 'completed', content: 'done' },
      3_000,
    )
    expect(result.type).toBe(MessageType.TaskResult)
    expect(result.from).toBe(TO)
    expect(result.to).toBe(FROM)
    expect(result.taskId).toBe('task-1')
    expect(result.contextId).toBe('ctx-1')
    expect(result.traceId).toBe('t-1')
    expect(result.msgId).not.toBe(request.msgId)
    expect(result.payload).toEqual({
      outcome: 'completed',
      content: 'done',
      completedAt: 3_000,
    })
    expect(isTaskResultPayload(result.payload)).toBe(true)
  })

  test('builds a failed result with a stable protocol code', () => {
    const result = createTaskResult(
      request,
      TO,
      {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason: 'model stopped',
      },
      3_000,
    )
    expect(result.payload).toEqual({
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
      reason: 'model stopped',
      completedAt: 3_000,
    })
    expect(isTaskResultPayload(result.payload)).toBe(true)
  })

  test('rejects hybrid branches, unknown codes, extras and identifiers', () => {
    expect(
      isTaskResultPayload({
        outcome: 'completed',
        content: 'done',
        completedAt: 3_000,
        reason: 'not allowed',
      }),
    ).toBe(false)
    expect(
      isTaskResultPayload({
        outcome: 'failed',
        code: 'E_MADE_UP',
        reason: 'nope',
        completedAt: 3_000,
      }),
    ).toBe(false)
    expect(
      isTaskResultPayload({
        outcome: 'completed',
        content: 'done',
        completedAt: 3_000,
        taskId: 'task-1',
      }),
    ).toBe(false)
  })

  describe('the redelivery marker (P13.5)', () => {
    test('is accepted on both branches, and is optional', () => {
      expect(
        isTaskResultPayload({
          outcome: 'completed',
          content: 'done',
          completedAt: 3_000,
          redelivered: true,
        }),
      ).toBe(true)
      expect(
        isTaskResultPayload({
          outcome: 'failed',
          code: ProtocolErrorCode.E_TASK_FAILED,
          reason: 'model stopped',
          completedAt: 3_000,
          redelivered: true,
        }),
      ).toBe(true)
    })

    test('is true or absent, never false', () => {
      // `false` and "absent" are the same fact, and one fact with two
      // encodings fingerprints as two different messages — which defeats the
      // honesty the marker exists for. Same rule `notify` already follows.
      for (const value of [false, 1, 'true', null]) {
        expect(
          isTaskResultPayload({
            outcome: 'completed',
            content: 'done',
            completedAt: 3_000,
            redelivered: value,
          }),
        ).toBe(false)
      }
    })

    test('is the only extra key the payload will take', () => {
      // Widening by one field must not turn a closed payload into an open
      // one: a peer still cannot smuggle business fields into a terminal
      // result.
      expect(
        isTaskResultPayload({
          outcome: 'completed',
          content: 'done',
          completedAt: 3_000,
          redelivered: true,
          attempt: 2,
        }),
      ).toBe(false)
    })

    test('carries through the factory when asked for', () => {
      const result = createTaskResult(
        request,
        TO,
        { outcome: 'completed', content: 'done', redelivered: true },
        3_000,
      )
      expect(result.payload).toEqual({
        outcome: 'completed',
        content: 'done',
        completedAt: 3_000,
        redelivered: true,
      })
      expect(isTaskResultPayload(result.payload)).toBe(true)
    })
  })
})

describe('errorReply', () => {
  const original = createMessage({
    from: FROM,
    to: TO,
    type: MessageType.TaskRequest,
    payload: {},
    traceId: 'trace-9',
    taskId: 'task-9',
    contextId: 'ctx-9',
  })

  test('addresses the reply back to the sender and keeps the trace', () => {
    const reply = errorReply(
      original,
      ProtocolErrorCode.E_UNKNOWN_AGENT,
      'no such agent',
      5_000,
    )
    expect(reply.type).toBe(MessageType.Error)
    expect(reply.from).toBe(TO)
    expect(reply.to).toBe(FROM)
    expect(reply.traceId).toBe('trace-9')
    expect(reply.payload).toEqual({
      code: ProtocolErrorCode.E_UNKNOWN_AGENT,
      reason: 'no such agent',
    })
    expect(reply.msgId).not.toBe(original.msgId)
  })

  test('carries the taskId back — that, not traceId, is the correlation key', () => {
    const reply = errorReply(
      original,
      ProtocolErrorCode.E_TTL_EXPIRED,
      'too late',
      5_000,
    )
    expect(reply.taskId).toBe('task-9')
    expect(reply.contextId).toBe('ctx-9')
    // A fresh taskId would leave the requester unable to match the failure to
    // the request it belongs to — the bug this fixes.
    expect(reply.taskId).not.toBe(reply.msgId)
  })

  test('a reply to a message without a contextId does not invent one', () => {
    const bare = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.TaskRequest,
      payload: {},
      taskId: 'task-10',
    })
    const reply = errorReply(bare, ProtocolErrorCode.E_LOOP, 'looped', 5_000)
    expect(reply.taskId).toBe('task-10')
    expect('contextId' in reply).toBe(false)
  })
})
