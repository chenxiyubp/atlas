// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  CAPABILITY_LEVELS,
  CapabilityLevel,
  MessageType,
  isCapabilityLevel,
  levelAtLeast,
} from '@qianmo/protocol'
import {
  OPEN_POLICY,
  SIGNED_TASK_POLICY,
  capabilityPolicy,
  satisfies,
} from '../src/index.js'
import {
  NODE_A,
  NODE_B,
  REVIEWER,
  gateFor,
  party,
  taskMessage,
  tokenFor,
} from './helpers.js'

describe('the ladder', () => {
  test('levels are ordered, not merely distinct', () => {
    expect([...CAPABILITY_LEVELS]).toEqual([
      CapabilityLevel.Read,
      CapabilityLevel.WriteLimited,
      CapabilityLevel.UserConfirmed,
    ])
    expect(
      levelAtLeast(CapabilityLevel.UserConfirmed, CapabilityLevel.Read),
    ).toBe(true)
    expect(
      levelAtLeast(CapabilityLevel.Read, CapabilityLevel.WriteLimited),
    ).toBe(false)
    expect(levelAtLeast(CapabilityLevel.Read, CapabilityLevel.Read)).toBe(true)
  })

  test('anything outside the three is not a level', () => {
    expect(isCapabilityLevel('admin')).toBe(false)
    expect(isCapabilityLevel(2)).toBe(false)
    expect(isCapabilityLevel(CapabilityLevel.WriteLimited)).toBe(true)
  })
})

describe('policies', () => {
  test('the open policy asks for read and therefore admits unsigned traffic', () => {
    const message = taskMessage()
    expect(OPEN_POLICY.requiredLevel(message)).toBe(CapabilityLevel.Read)
    expect(satisfies(OPEN_POLICY, message, CapabilityLevel.Read)).toBe(true)
  })

  test('the signing policy asks for write-limited on work, read on replies', () => {
    expect(SIGNED_TASK_POLICY.requiredLevel(taskMessage())).toBe(
      CapabilityLevel.WriteLimited,
    )
    expect(
      SIGNED_TASK_POLICY.requiredLevel(taskMessage({ type: MessageType.Wake })),
    ).toBe(CapabilityLevel.WriteLimited)
    // An answer to something this node asked for authorizes nothing.
    expect(
      SIGNED_TASK_POLICY.requiredLevel(taskMessage({ type: MessageType.Ack })),
    ).toBe(CapabilityLevel.Read)
  })

  test('a custom table leaves unlisted types at read', () => {
    const policy = capabilityPolicy({
      [MessageType.Ping]: CapabilityLevel.UserConfirmed,
    })
    expect(policy.requiredLevel(taskMessage({ type: MessageType.Ping }))).toBe(
      CapabilityLevel.UserConfirmed,
    )
    expect(policy.requiredLevel(taskMessage())).toBe(CapabilityLevel.Read)
  })
})

describe('the gate’s two questions stay apart', () => {
  test('no token under an open policy is admitted at read', () => {
    // Named rather than defaulted: since P12.4 the gate's default is
    // `SIGNED_TASK_POLICY`, and the subject of this test is the open one —
    // which is what its title said before the switch too.
    const decision = gateFor(NODE_B, { policy: OPEN_POLICY }).check(
      taskMessage(),
      Date.now(),
    )
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.level).toBe(CapabilityLevel.Read)
  })

  test('no token under a signing policy is refused for its level, not its absence', () => {
    const decision = gateFor(NODE_B, { policy: SIGNED_TASK_POLICY }).check(
      taskMessage(),
      Date.now(),
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toContain('needs write-limited')
    expect(decision.reason).toContain('presented read')
  })

  test('a read token where write-limited is required is refused the same way', () => {
    const issuer = party(NODE_A)
    const gate = gateFor(NODE_B, {
      trusts: [issuer],
      policy: SIGNED_TASK_POLICY,
    })
    const token = tokenFor(issuer, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.Read,
    })
    const decision = gate.check(taskMessage({ cap: token }), Date.now())
    expect(decision.ok).toBe(false)
  })

  test('a node with no signing key can verify but not issue', () => {
    const gate = gateFor(NODE_B)
    expect(() =>
      gate.issue({
        sub: REVIEWER,
        aud: NODE_A,
        act: CapabilityLevel.Read,
        taskId: 't',
        nbf: 1,
        exp: 2,
      }),
    ).toThrow(/no signing key/)
  })
})
