// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  LEGACY_MESSAGE_TYPES,
  LIMITS,
  MessageType,
  NOTIFY_KINDS,
  NOTIFY_SEVERITIES,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  createNotify,
  createTaskResult,
  errorCodeForPeer,
  isLegacyErrorCode,
  isNotifyPayload,
  isReplyType,
  isTaskResultPayload,
  peerIsPostLegacy,
  peerSupportsType,
  resolvePeerTypes,
  validateMessage,
  type NotifyPayload,
} from '../src/index.js'

const NODE = 'qianmo://tokyo-1/watcher'
const HUB = 'qianmo://hub-0/console'
const NOW = 1_700_000_000_000
const JOB = 'watch-disk-usage'

function payload(overrides: Partial<NotifyPayload> = {}): NotifyPayload {
  return {
    kind: 'watch',
    severity: 'warn',
    summary: 'disk usage crossed 80%',
    observedAt: NOW - 250,
    ...overrides,
  }
}

function notify(overrides: Partial<NotifyPayload> = {}) {
  return createNotify({
    from: NODE,
    to: HUB,
    contextId: JOB,
    payload: payload(overrides),
    createdAt: NOW,
  })
}

describe('createNotify — the envelope', () => {
  test('is a notify carrying its grouping context', () => {
    const message = notify()
    expect(message.type).toBe(MessageType.Notify)
    expect(message.contextId).toBe(JOB)
    expect(message.from).toBe(NODE)
    expect(message.to).toBe(HUB)
    expect(message.trust).toBe(TRUST_UNTRUSTED)
    expect(message.costLimit).toBe(0)
    expect(message.hops).toEqual([])
  })

  test('every notification gets a fresh taskId, even within one context', () => {
    // §14.3, and the reason the loop guard never sees a revisit. Two
    // notifications from one watch job share the context and nothing else.
    const first = notify()
    const second = notify()
    expect(first.taskId).not.toBe(second.taskId)
    expect(first.contextId).toBe(second.contextId)
  })

  test('a caller cannot supply a taskId — there is no parameter for it', () => {
    // Structural, not documentary: reusing the causing task's id is the one
    // mistake that only surfaces on the *second* notification of a job, so the
    // factory refuses to take one at all rather than warning about it.
    const message = createNotify({
      from: NODE,
      to: HUB,
      contextId: JOB,
      payload: payload(),
      // Deliberately smuggled past the type to prove it is dropped.
      taskId: 'the-causing-task',
    } as unknown as Parameters<typeof createNotify>[0])
    expect(message.taskId).not.toBe('the-causing-task')
  })

  test('both deadlines are the notify delivery window', () => {
    // §14.4: notify never enters the task state machine, but `taskTtlMs` is
    // mandatory. Leaving it at the 5-minute default would report an expired
    // notification as alive for four more minutes.
    const message = notify()
    expect(message.deliverTtlMs).toBe(LIMITS.defaultNotifyTtlMs)
    expect(message.taskTtlMs).toBe(message.deliverTtlMs)
  })

  test('an explicit delivery window is mirrored onto the task window', () => {
    const message = createNotify({
      from: NODE,
      to: HUB,
      contextId: JOB,
      payload: payload(),
      createdAt: NOW,
      deliverTtlMs: 5_000,
    })
    expect(message.deliverTtlMs).toBe(5_000)
    expect(message.taskTtlMs).toBe(5_000)
  })

  test('a notify is not a reply, and is not exempt from loop detection', () => {
    // The exemption exists for types forced to reuse somebody else's taskId.
    // notify reuses none, so it neither needs the exemption nor gets it —
    // taking it would let anything through the loop net by self-declaration.
    expect(isReplyType(MessageType.Notify)).toBe(false)
  })

  test('validation accepts what the factory builds', () => {
    const result = validateMessage(notify(), { now: NOW })
    expect(result.ok).toBe(true)
  })
})

describe('isNotifyPayload — whitelist, not exact key count', () => {
  test('the required four are enough on their own', () => {
    expect(isNotifyPayload(payload())).toBe(true)
  })

  test('each optional field is accepted, alone and together', () => {
    // The regression this guards: "unifying" the check back to `hasExactKeys`
    // would refuse every one of these as malformed.
    expect(isNotifyPayload(payload({ detail: 'df -h says 81%' }))).toBe(true)
    expect(isNotifyPayload(payload({ dedupKey: `${JOB}:80` }))).toBe(true)
    expect(isNotifyPayload(payload({ redelivered: true }))).toBe(true)
    expect(isNotifyPayload(payload({ causeTaskId: 'task-9' }))).toBe(true)
    expect(
      isNotifyPayload(
        payload({
          detail: 'df -h says 81%',
          dedupKey: `${JOB}:80`,
          redelivered: true,
          causeTaskId: 'task-9',
        }),
      ),
    ).toBe(true)
  })

  test('an unlisted key is still a rejection', () => {
    // The property exact counting was bought for — a peer cannot smuggle
    // business fields in — survives the move to a whitelist.
    expect(isNotifyPayload({ ...payload(), escalateTo: 'pagerduty' })).toBe(
      false,
    )
  })

  test('a missing required field is a rejection', () => {
    for (const key of ['kind', 'severity', 'summary', 'observedAt']) {
      const partial: Record<string, unknown> = { ...payload() }
      delete partial[key]
      expect(isNotifyPayload(partial)).toBe(false)
    }
  })

  test('kind and severity are closed sets', () => {
    for (const kind of NOTIFY_KINDS) {
      expect(isNotifyPayload(payload({ kind }))).toBe(true)
    }
    for (const severity of NOTIFY_SEVERITIES) {
      expect(isNotifyPayload(payload({ severity }))).toBe(true)
    }
    expect(isNotifyPayload({ ...payload(), kind: 'gossip' })).toBe(false)
    expect(isNotifyPayload({ ...payload(), severity: 'fatal' })).toBe(false)
  })

  test('summary must actually say something', () => {
    expect(isNotifyPayload(payload({ summary: '' }))).toBe(false)
    expect(isNotifyPayload({ ...payload(), summary: 42 })).toBe(false)
  })

  test('observedAt must be a real instant', () => {
    expect(isNotifyPayload({ ...payload(), observedAt: 0 })).toBe(false)
    expect(isNotifyPayload({ ...payload(), observedAt: -1 })).toBe(false)
    expect(isNotifyPayload({ ...payload(), observedAt: Number.NaN })).toBe(
      false,
    )
    expect(isNotifyPayload({ ...payload(), observedAt: '2026' })).toBe(false)
  })

  test('redelivered is true or absent, never false', () => {
    // Two spellings of one fact would fingerprint as two different messages,
    // which would defeat the dedup the flag exists to stay honest about.
    expect(isNotifyPayload({ ...payload(), redelivered: false })).toBe(false)
    expect(isNotifyPayload({ ...payload(), redelivered: 1 })).toBe(false)
  })

  test('an empty dedupKey or causeTaskId is a rejection', () => {
    expect(isNotifyPayload(payload({ dedupKey: '' }))).toBe(false)
    expect(isNotifyPayload(payload({ causeTaskId: '' }))).toBe(false)
  })

  test('non-objects are rejected', () => {
    for (const value of [null, undefined, 'notify', 7, [payload()]]) {
      expect(isNotifyPayload(value)).toBe(false)
    }
  })

  test('validation refuses a notify whose payload carries an unknown field', () => {
    const message = {
      ...notify(),
      payload: { ...payload(), escalateTo: 'pagerduty' },
    }
    const result = validateMessage(message, { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]?.code).toBe(ProtocolErrorCode.E_BAD_ENVELOPE)
    expect(result.issues[0]?.field).toBe('payload')
  })
})

describe('capability discovery — §14.6', () => {
  test('an absent or empty declaration means the legacy floor', () => {
    // Empty is read as absent on purpose: a peer whose list came up empty has a
    // build problem, and reading it as "speaks nothing" would silence a working
    // link rather than degrade it.
    expect(resolvePeerTypes(undefined)).toEqual(LEGACY_MESSAGE_TYPES)
    expect(resolvePeerTypes([])).toEqual(LEGACY_MESSAGE_TYPES)
  })

  test('notify is only sent to a peer that asked for it', () => {
    expect(peerSupportsType(undefined, MessageType.Notify)).toBe(false)
    expect(peerSupportsType([], MessageType.Notify)).toBe(false)
    expect(
      peerSupportsType([...LEGACY_MESSAGE_TYPES], MessageType.Notify),
    ).toBe(false)
    expect(peerSupportsType([MessageType.Notify], MessageType.Notify)).toBe(
      true,
    )
  })

  test('the floor is still available to a peer that declares a narrow list', () => {
    // A declaration is what the peer implements, not a subtraction from the
    // floor — but it is authoritative, so a peer that omits a legacy type is
    // taken at its word.
    expect(peerSupportsType([MessageType.Notify], MessageType.Ping)).toBe(false)
    expect(peerSupportsType(undefined, MessageType.Ping)).toBe(true)
  })

  test('declaring anything past the floor identifies a post-legacy build', () => {
    expect(peerIsPostLegacy(undefined)).toBe(false)
    expect(peerIsPostLegacy([])).toBe(false)
    expect(peerIsPostLegacy([...LEGACY_MESSAGE_TYPES])).toBe(false)
    expect(
      peerIsPostLegacy([...LEGACY_MESSAGE_TYPES, MessageType.Notify]),
    ).toBe(true)
  })
})

describe('rule N-1 — a new error code is not a free addition', () => {
  test('an unknown code makes a failed result unreadable, not merely unnamed', () => {
    // This is the fact the whole rule rests on. `isTaskResultPayload` gates on
    // membership in the *local* code table, so a peer that predates a code does
    // not receive "an outcome I cannot name" — it refuses the entire payload,
    // and the sender waits out its task deadline for an answer already computed.
    const failed = {
      outcome: 'failed',
      code: 'E_FROM_A_LATER_RELEASE',
      reason: 'queue is full',
      completedAt: NOW,
    }
    expect(isTaskResultPayload(failed)).toBe(false)

    // Same shape, code this build knows: read fine. The difference is the code
    // table, nothing else about the message.
    const known = createTaskResult(
      notify(),
      NODE,
      {
        outcome: 'failed',
        code: ProtocolErrorCode.E_RATE_LIMITED,
        reason: 'queue is full',
      },
      NOW,
    )
    expect(isTaskResultPayload(known.payload)).toBe(true)
  })

  test('E_BUSY is post-legacy and downgrades to E_RATE_LIMITED', () => {
    expect(isLegacyErrorCode(ProtocolErrorCode.E_BUSY)).toBe(false)
    expect(isLegacyErrorCode(ProtocolErrorCode.E_RATE_LIMITED)).toBe(true)

    // Undeclared peer: send the code it can parse.
    expect(errorCodeForPeer(ProtocolErrorCode.E_BUSY, undefined)).toBe(
      ProtocolErrorCode.E_RATE_LIMITED,
    )
    expect(
      errorCodeForPeer(ProtocolErrorCode.E_BUSY, [...LEGACY_MESSAGE_TYPES]),
    ).toBe(ProtocolErrorCode.E_RATE_LIMITED)

    // Peer that proved it is newer than the floor: send the precise code.
    expect(
      errorCodeForPeer(ProtocolErrorCode.E_BUSY, [
        ...LEGACY_MESSAGE_TYPES,
        MessageType.Notify,
      ]),
    ).toBe(ProtocolErrorCode.E_BUSY)
  })

  test('a legacy code is never rewritten for anybody', () => {
    for (const declared of [
      undefined,
      [] as string[],
      [...LEGACY_MESSAGE_TYPES],
      [...LEGACY_MESSAGE_TYPES, MessageType.Notify],
    ]) {
      expect(errorCodeForPeer(ProtocolErrorCode.E_TASK_TIMEOUT, declared)).toBe(
        ProtocolErrorCode.E_TASK_TIMEOUT,
      )
    }
  })
})

describe('LIMITS — the three numbers P13.2 added', () => {
  test('carry the values charter §3.3 C-4 records', () => {
    expect(LIMITS.defaultNotifyTtlMs).toBe(120_000)
    expect(LIMITS.notifyRatePerMinute).toBe(60)
    expect(LIMITS.maxQueuedTurns).toBe(32)
  })

  test('sit between the two existing deadlines, and under the inbound budget', () => {
    // Not arithmetic for its own sake: each relation is the reason the number
    // is what it is (§14.4, §14.7), so a future edit that breaks the relation
    // has to come here and confront it.
    expect(LIMITS.defaultNotifyTtlMs).toBeGreaterThan(LIMITS.defaultTtlMs)
    expect(LIMITS.defaultNotifyTtlMs).toBeLessThan(LIMITS.defaultTaskTtlMs)
    expect(LIMITS.notifyRatePerMinute).toBeLessThan(LIMITS.ratePerMinute)
  })

  test('the five older limits are untouched', () => {
    expect(LIMITS.maxMessageBytes).toBe(256 * 1024)
    expect(LIMITS.maxHops).toBe(8)
    expect(LIMITS.defaultTtlMs).toBe(30_000)
    expect(LIMITS.defaultTaskTtlMs).toBe(300_000)
    expect(LIMITS.ratePerMinute).toBe(600)
  })

  test('there are exactly eight of them', () => {
    // charter §3.3 C-4 enumerates them; a ninth would need a charter amendment,
    // which is why `NotifyPayload.summary` has no ceiling of its own.
    expect(Object.keys(LIMITS)).toHaveLength(8)
  })
})
