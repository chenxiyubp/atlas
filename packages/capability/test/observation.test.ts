// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Observation mode — key-distribution.md §9.2 phase ①.
 *
 * The phase exists so that "how much would enforcing cost" is a number before
 * it is an outage. Its whole contract is one sentence — **no message's fate
 * changes** — and that sentence is what the first test here asserts, in the
 * only way worth asserting it: by running the identical message through a gate
 * with observation on and a gate with it off, and comparing the verdicts, not
 * merely checking that one of them said `ok`.
 */

import { describe, expect, test } from 'bun:test'
import {
  CapabilityLevel,
  MessageType,
  ProtocolErrorCode,
} from '@qianmo/protocol'
import {
  NodeCapabilities,
  OPEN_POLICY,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  type ShadowRefusal,
} from '../src/index.js'
import {
  NODE_A,
  NODE_B,
  NOW,
  REVIEWER,
  party,
  taskMessage,
  tokenFor,
} from './helpers.js'

function observing(
  options: {
    readonly policy?: typeof OPEN_POLICY
    readonly shadow?: typeof OPEN_POLICY
    readonly trusts?: readonly ReturnType<typeof party>[]
  } = {},
): { gate: NodeCapabilities; seen: ShadowRefusal[] } {
  const seen: ShadowRefusal[] = []
  const gate = new NodeCapabilities({
    node: NODE_B,
    directory: new StaticPublicKeyDirectory(
      (options.trusts ?? []).map(peer => [peer.node, peer.keys.publicKey]),
    ),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.shadow === undefined
      ? {}
      : {
          shadowPolicy: options.shadow,
          onShadowRefusal: (refusal: ShadowRefusal) => seen.push(refusal),
        }),
  })
  return { gate, seen }
}

describe('observation mode changes no message’s fate (§9.2 ①)', () => {
  test('an unsigned task admitted by the open policy is still admitted, and recorded', () => {
    const message = taskMessage()
    const plain = observing({ policy: OPEN_POLICY })
    const observed = observing({
      policy: OPEN_POLICY,
      shadow: SIGNED_TASK_POLICY,
    })

    const before = plain.gate.check(message, NOW)
    const after = observed.gate.check(message, NOW)

    // Identical verdicts, field for field: this is the contract.
    expect(after).toEqual(before)
    expect(after.ok).toBe(true)

    // And one record saying exactly what the switch would have cost.
    expect(plain.seen).toHaveLength(0)
    expect(observed.seen).toHaveLength(1)
    const refusal = observed.seen[0] as ShadowRefusal
    expect(refusal.type).toBe(MessageType.TaskRequest)
    expect(refusal.from).toBe(message.from)
    expect(refusal.msgId).toBe(message.msgId)
    expect(refusal.taskId).toBe(message.taskId)
    expect(refusal.required).toBe(CapabilityLevel.WriteLimited)
    expect(refusal.presented).toBe(CapabilityLevel.Read)
    expect(refusal.code).toBe(ProtocolErrorCode.E_CAP_INSUFFICIENT)
  })

  test('the recorded reason is word for word the refusal the switch would give', () => {
    // The claim observation mode makes is "this is what you would have seen".
    // Two independently worded versions of it stop being that the first time
    // one is edited, so the two share one builder — asserted here rather than
    // trusted.
    const message = taskMessage()
    const observed = observing({
      policy: OPEN_POLICY,
      shadow: SIGNED_TASK_POLICY,
    })
    observed.gate.check(message, NOW)

    const enforcing = observing({ policy: SIGNED_TASK_POLICY })
    const real = enforcing.gate.check(message, NOW)
    expect(real.ok).toBe(false)
    if (real.ok) return
    expect((observed.seen[0] as ShadowRefusal).reason).toBe(real.reason)
  })

  test('a reply is not work: nothing is recorded for it', () => {
    const observed = observing({
      policy: OPEN_POLICY,
      shadow: SIGNED_TASK_POLICY,
    })
    const verdict = observed.gate.check(
      taskMessage({ type: MessageType.Ack }),
      NOW,
    )
    expect(verdict.ok).toBe(true)
    expect(observed.seen).toHaveLength(0)
  })

  test('a message that already satisfies the shadow policy records nothing', () => {
    const issuer = party(NODE_A)
    const observed = observing({
      policy: OPEN_POLICY,
      shadow: SIGNED_TASK_POLICY,
      trusts: [issuer],
    })
    const token = tokenFor(issuer, {
      sub: REVIEWER,
      aud: NODE_B,
      act: CapabilityLevel.WriteLimited,
    })
    const verdict = observed.gate.check(taskMessage({ cap: token }), NOW)
    expect(verdict.ok).toBe(true)
    expect(observed.seen).toHaveLength(0)
  })

  test('a message the real policy already refused is not counted twice', () => {
    // It is refused either way, so the switch would not change it — counting
    // it here would inflate the one number the phase exists to produce.
    const observed = observing({
      policy: SIGNED_TASK_POLICY,
      shadow: SIGNED_TASK_POLICY,
    })
    const verdict = observed.gate.check(taskMessage(), NOW)
    expect(verdict.ok).toBe(false)
    expect(observed.seen).toHaveLength(0)
  })

  test('a throwing sink cannot refuse traffic', () => {
    // The property this mode is defined by not having.
    const gate = new NodeCapabilities({
      node: NODE_B,
      directory: new StaticPublicKeyDirectory(),
      policy: OPEN_POLICY,
      shadowPolicy: SIGNED_TASK_POLICY,
      onShadowRefusal: () => {
        throw new Error('the trail is full')
      },
    })
    expect(gate.check(taskMessage(), NOW).ok).toBe(true)
  })

  test('half a configuration observes nothing rather than looking configured', () => {
    const policyOnly = new NodeCapabilities({
      node: NODE_B,
      directory: new StaticPublicKeyDirectory(),
      policy: OPEN_POLICY,
      shadowPolicy: SIGNED_TASK_POLICY,
    })
    expect(policyOnly.check(taskMessage(), NOW).ok).toBe(true)

    const seen: ShadowRefusal[] = []
    const sinkOnly = new NodeCapabilities({
      node: NODE_B,
      directory: new StaticPublicKeyDirectory(),
      policy: OPEN_POLICY,
      onShadowRefusal: refusal => seen.push(refusal),
    })
    expect(sinkOnly.check(taskMessage(), NOW).ok).toBe(true)
    expect(seen).toHaveLength(0)
  })
})
