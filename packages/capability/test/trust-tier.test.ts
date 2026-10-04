// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The provenance tier a verified capability earns (issue #28).
 *
 * The tier exists because `@qianmo/adapter` used to pin every cross-node
 * message to `untrusted` in its **type**, which made "the operator authorized
 * this" unrepresentable: measured against a real model on 2026-08-24, six wake
 * turns out of six refused to do any work and quoted the untrusted notice
 * back — the signed one included.
 *
 * These tests are the decision half. They live here rather than in the adapter
 * because this is the only layer that may take it: deciding needs a key
 * directory and an operator-supplied trust list, and the adapter has neither.
 */

import { describe, expect, test } from 'bun:test'
import {
  CapabilityLevel,
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
} from '@qianmo/protocol'
import { OPEN_POLICY, SIGNED_TASK_POLICY } from '../src/index.js'
import {
  NODE_A,
  NODE_B,
  NOW,
  REVIEWER,
  gateFor,
  party,
  taskMessage,
  tokenFor,
} from './helpers.js'

/** The two message types `SIGNED_TASK_POLICY` asks `write-limited` of. */
const WORK_TYPES = [MessageType.TaskRequest, MessageType.Wake] as const

describe('the verified tier is earned, never assumed', () => {
  test.each([
    ...WORK_TYPES,
  ])('a %s signed by a trusted issuer, bound to this task, is trusted', (type: MessageType) => {
    const peer = party(NODE_A)
    const gate = gateFor(NODE_B, {
      trusts: [peer],
      policy: SIGNED_TASK_POLICY,
    })
    const message = taskMessage({
      type,
      cap: tokenFor(peer, { sub: REVIEWER, aud: NODE_B }),
    })

    expect(gate.check(message, NOW)).toEqual({
      ok: true,
      level: CapabilityLevel.WriteLimited,
      issuer: NODE_A,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
  })

  test('a node trusts its own signature, which is what rule S-1 needs', () => {
    // `user-confirmed` is accepted only from this node's own key. Leaving the
    // node out of its own trust list would make the strongest level the one
    // level that could never be trusted.
    const self = party(NODE_B)
    const gate = gateFor(NODE_B, {
      trusts: [self],
      policy: SIGNED_TASK_POLICY,
    })
    const message = taskMessage({
      cap: tokenFor(self, {
        sub: REVIEWER,
        aud: NODE_B,
        act: CapabilityLevel.UserConfirmed,
      }),
    })

    expect(gate.check(message, NOW)).toMatchObject({
      ok: true,
      level: CapabilityLevel.UserConfirmed,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
  })
})

describe('everything else stays at the floor', () => {
  test('no token at all — the message nothing vouched for', () => {
    const gate = gateFor(NODE_B, { policy: OPEN_POLICY })

    expect(gate.check(taskMessage(), NOW)).toEqual({
      ok: true,
      level: CapabilityLevel.Read,
      trust: TRUST_UNTRUSTED,
    })
  })

  test('an unsigned wake under --open-policy is admitted, not trusted', () => {
    // The state the beta fleet is actually in. Admitting more is what the
    // escape hatch is for; trusting more is not, and the two must not move
    // together.
    const gate = gateFor(NODE_B, { policy: OPEN_POLICY })

    expect(gate.check(taskMessage({ type: MessageType.Wake }), NOW)).toEqual({
      ok: true,
      level: CapabilityLevel.Read,
      trust: TRUST_UNTRUSTED,
    })
  })

  test('signed and verifiable, but the issuer was never named', () => {
    // The key is in the directory, so the signature checks out and the
    // enforcing policy admits the work. "I can verify you" is not "you may
    // direct me".
    const peer = party(NODE_A)
    const gate = gateFor(NODE_B, {
      trusts: [peer],
      policy: SIGNED_TASK_POLICY,
      trustedIssuers: [],
    })
    const message = taskMessage({
      cap: tokenFor(peer, { sub: REVIEWER, aud: NODE_B }),
    })

    expect(gate.check(message, NOW)).toEqual({
      ok: true,
      level: CapabilityLevel.WriteLimited,
      issuer: NODE_A,
      trust: TRUST_UNTRUSTED,
    })
  })

  test('a read-level token from a trusted issuer authorizes no work', () => {
    // `act` is a ceiling (rule S-3). A `read` token is its holder saying, in
    // the one field that binds them, that this message is not meant to cause
    // work — reading it as "act on it" would contradict the token.
    const peer = party(NODE_A)
    const gate = gateFor(NODE_B, { trusts: [peer], policy: OPEN_POLICY })
    const message = taskMessage({
      cap: tokenFor(peer, {
        sub: REVIEWER,
        aud: NODE_B,
        act: CapabilityLevel.Read,
      }),
    })

    expect(gate.check(message, NOW)).toEqual({
      ok: true,
      level: CapabilityLevel.Read,
      issuer: NODE_A,
      trust: TRUST_UNTRUSTED,
    })
  })
})

describe('a token that does not verify never reaches a tier at all', () => {
  /**
   * The three bindings, each broken on its own. All are refusals rather than
   * downgrades, and the distinction matters: a refused message is answered
   * with an `error` envelope and never written to a mailbox, so there is no
   * notice to mislabel. `check` returning `ok: false` is the assertion that
   * the trusted branch is unreachable from here.
   */
  const peer = party(NODE_A)

  test('expired', () => {
    const gate = gateFor(NODE_B, { trusts: [peer], policy: OPEN_POLICY })
    const message = taskMessage({
      cap: tokenFor(peer, {
        sub: REVIEWER,
        aud: NODE_B,
        exp: NOW + 1_000,
      }),
    })

    expect(gate.check(message, NOW + 1_001)).toEqual({
      ok: false,
      code: ProtocolErrorCode.E_CAP_INVALID,
      reason: 'capability has expired',
    })
  })

  test('aud names a different node', () => {
    const gate = gateFor(NODE_B, { trusts: [peer], policy: OPEN_POLICY })
    const message = taskMessage({
      cap: tokenFor(peer, { sub: REVIEWER, aud: 'node-c' }),
    })

    expect(gate.check(message, NOW)).toEqual({
      ok: false,
      code: ProtocolErrorCode.E_CAP_INVALID,
      reason: `capability audience node-c is not this node ${NODE_B}`,
    })
  })

  test('taskId belongs to another task', () => {
    const gate = gateFor(NODE_B, { trusts: [peer], policy: OPEN_POLICY })
    const message = taskMessage({
      taskId: 'task-1',
      cap: tokenFor(peer, {
        sub: REVIEWER,
        aud: NODE_B,
        taskId: 'task-2',
      }),
    })

    expect(gate.check(message, NOW)).toEqual({
      ok: false,
      code: ProtocolErrorCode.E_CAP_INVALID,
      reason: 'capability is bound to another task',
    })
  })
})

describe('the tier is a property of the message, not of the peer', () => {
  test('the same peer gets no tier on the next message it does not sign', () => {
    // A capability is bound to `sub` / `aud` / `taskId`, so trusting an issuer
    // can never accumulate into trusting a connection. The second message here
    // travels from the same node over the same policy and earns nothing.
    const peer = party(NODE_A)
    const gate = gateFor(NODE_B, { trusts: [peer], policy: OPEN_POLICY })

    const signed = taskMessage({
      taskId: 'task-1',
      cap: tokenFor(peer, { sub: REVIEWER, aud: NODE_B, taskId: 'task-1' }),
    })
    expect(gate.check(signed, NOW)).toMatchObject({
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })

    const bare = taskMessage({ taskId: 'task-2' })
    expect(gate.check(bare, NOW)).toMatchObject({ trust: TRUST_UNTRUSTED })
  })
})
