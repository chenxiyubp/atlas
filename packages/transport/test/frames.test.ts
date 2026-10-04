// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ProtocolErrorCode } from '@qianmo/protocol'
import {
  FRAME_VERSION,
  FrameType,
  ReceiptStatus,
  parseFrame,
  serializeFrame,
} from '../src/index.js'
import { makeMessage } from './helpers.js'

describe('frame round trip', () => {
  test('every frame kind survives serialize → parse', () => {
    const message = makeMessage()
    const frames = [
      { t: FrameType.Challenge, v: FRAME_VERSION, nonce: 'abcd' },
      {
        t: FrameType.Auth,
        v: FRAME_VERSION,
        node: 'node-a',
        nonce: 'abcd',
        clientNonce: 'ef01',
        channelId: 'a'.repeat(32),
        mac: '00ff',
        credential: 'fingerprint-f1',
        credentialProof: 'proof-f1',
      },
      {
        t: FrameType.Ready,
        v: FRAME_VERSION,
        credential: 'fingerprint-listener',
        credentialProof: 'proof-listener',
      },
      { t: FrameType.KeepAlive, v: FRAME_VERSION },
      { t: FrameType.Envelope, v: FRAME_VERSION, envelope: message },
      {
        t: FrameType.Receipt,
        v: FRAME_VERSION,
        msgId: message.msgId,
        status: ReceiptStatus.Accepted,
      },
    ] as const

    for (const frame of frames) {
      expect(parseFrame(serializeFrame(frame))).toEqual(frame)
    }
  })

  test('a rejected receipt keeps its protocol error code', () => {
    const frame = {
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm-1',
      status: ReceiptStatus.Rejected,
      code: ProtocolErrorCode.E_TOO_LARGE,
      reason: 'invalid envelope',
    } as const
    expect(parseFrame(serializeFrame(frame))).toEqual(frame)
  })
})

describe('parseFrame refuses what is not a frame', () => {
  test.each([
    ['not json at all', 'definitely-not-json'],
    ['a bare array', '[1,2,3]'],
    ['a frame of another version', '{"t":"ready","v":0}'],
    ['an unknown frame type', '{"t":"gossip","v":1}'],
    ['a challenge with no nonce', '{"t":"challenge","v":1}'],
    ['an auth frame missing its mac', '{"t":"auth","v":1,"node":"a"}'],
    [
      'a receipt with an invented status',
      '{"t":"receipt","v":1,"msgId":"m","status":"maybe"}',
    ],
  ])('%s → null', (_label, raw) => {
    expect(parseFrame(raw)).toBeNull()
  })

  test('an unknown error code is dropped, the receipt still parses', () => {
    const parsed = parseFrame(
      '{"t":"receipt","v":1,"msgId":"m","status":"rejected","code":"E_MADE_UP"}',
    )
    expect(parsed).toEqual({
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm',
      status: ReceiptStatus.Rejected,
    })
  })

  test('an unparseable signature field is dropped, not fatal', () => {
    // Same additive-field contract `supportedTypes` has: a reader that cannot
    // make sense of an optional field behaves like one that never knew about
    // it. For `sig` that means opportunistic fallback to the MAC; a deployment
    // that pins this peer rejects the resulting unsigned attempt.
    const parsed = parseFrame(
      '{"t":"auth","v":1,"node":"node-a","nonce":"n","clientNonce":"c",' +
        `"channelId":"${'a'.repeat(32)}","mac":"deadbeef","sig":17}`,
    )
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('sig')
  })

  test('a ready frame keeps `node` and `sig` when both are strings', () => {
    expect(
      parseFrame('{"t":"ready","v":1,"node":"node-b","sig":"AAAA"}'),
    ).toEqual({
      t: FrameType.Ready,
      v: FRAME_VERSION,
      node: 'node-b',
      sig: 'AAAA',
    })
    // Half a declaration reads as none of one: `verifyReady` treats a `node`
    // without a `sig` as unsigned, so nothing here has to enforce the pair.
    expect(parseFrame('{"t":"ready","v":1,"node":"node-b"}')).toEqual({
      t: FrameType.Ready,
      v: FRAME_VERSION,
      node: 'node-b',
    })
  })

  test('an envelope frame carries its payload through unvalidated', () => {
    // The transport must not decide what a valid envelope is — it hands the
    // raw value to `validateMessage` on the receiving node.
    const parsed = parseFrame('{"t":"envelope","v":1,"envelope":{"junk":true}}')
    expect(parsed).toEqual({
      t: FrameType.Envelope,
      v: FRAME_VERSION,
      envelope: { junk: true },
    })
  })
})

describe('the version is pinned at 1, and that is load-bearing', () => {
  test('FRAME_VERSION is 1 in the type, the value and the source', () => {
    // P12.3 DoD 1. `parseFrame` compares `v` for strict equality, so raising
    // this number does not stage a migration — it produces two generations
    // that drop each other's frames entirely. Every extension since has
    // landed *inside* v1 as an optional field (`supportedTypes`, then `sig`
    // and the ready frame's `node`), and this assertion is what makes the
    // alternative fail loudly instead of quietly breaking a fleet mid-rollout.
    //
    // Read off disk as well as imported: a constant can be re-exported,
    // shadowed or computed, and what a peer's parser compares against is the
    // literal in this file.
    expect(FRAME_VERSION).toBe(1)
    const source = readFileSync(
      new URL('../src/frames.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('export const FRAME_VERSION = 1')
    expect(source).toContain("if (parsed['v'] !== FRAME_VERSION) return null")
  })

  test('a frame of any other version is dropped whole', () => {
    expect(parseFrame('{"t":"ready","v":2}')).toBeNull()
    expect(parseFrame('{"t":"keep_alive","v":0}')).toBeNull()
  })
})
