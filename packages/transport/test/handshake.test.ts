// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  HandshakeRejection,
  PSK_ENV_VAR,
  PSK_MIN_LENGTH,
  WeakSecretError,
  assertUsablePsk,
  computeMac,
  newNonce,
  pskFromEnv,
  verifyAuth,
} from '../src/index.js'
import { TEST_PSK, WRONG_PSK } from './helpers.js'

const CHANNEL_ID = 'a'.repeat(32)

function attempt(
  psk: string,
  serverNonce: string,
  node = 'node-a',
  channelId = CHANNEL_ID,
) {
  const clientNonce = newNonce()
  return {
    node,
    nonce: serverNonce,
    clientNonce,
    channelId,
    mac: computeMac(psk, serverNonce, clientNonce, node, channelId),
  }
}

describe('nonces', () => {
  test('are 32 hex characters and do not repeat', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i += 1) {
      const nonce = newNonce()
      expect(nonce).toMatch(/^[0-9a-f]{32}$/)
      seen.add(nonce)
    }
    expect(seen.size).toBe(100)
  })
})

describe('verifyAuth', () => {
  test('accepts a proof computed with the same key', () => {
    const nonce = newNonce()
    expect(verifyAuth(TEST_PSK, nonce, attempt(TEST_PSK, nonce))).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
      authentication: 'psk',
    })
  })

  test('rejects a proof computed with a different key', () => {
    const nonce = newNonce()
    expect(verifyAuth(TEST_PSK, nonce, attempt(WRONG_PSK, nonce))).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadMac,
    })
  })

  test('rejects a proof for someone else’s nonce — no replay onto a new socket', () => {
    const firstNonce = newNonce()
    const captured = attempt(TEST_PSK, firstNonce)
    const secondNonce = newNonce()
    expect(verifyAuth(TEST_PSK, secondNonce, captured)).toEqual({
      ok: false,
      rejection: HandshakeRejection.NonceMismatch,
    })
  })

  test('rejects a node name that is not a legal address segment', () => {
    const nonce = newNonce()
    expect(
      verifyAuth(TEST_PSK, nonce, attempt(TEST_PSK, nonce, 'NODE_A')),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadNode })
  })

  test('rejects a malformed logical channel id', () => {
    const nonce = newNonce()
    expect(
      verifyAuth(TEST_PSK, nonce, attempt(TEST_PSK, nonce, 'node-a', 'bad')),
    ).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadChannel,
    })
  })

  test('rejects a mac that is not hex, without throwing', () => {
    const nonce = newNonce()
    const forged = { ...attempt(TEST_PSK, nonce), mac: 'zzzz' }
    expect(verifyAuth(TEST_PSK, nonce, forged)).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadMac,
    })
  })

  test('the mac covers the node name and logical channel id', () => {
    const nonce = newNonce()
    const valid = attempt(TEST_PSK, nonce, 'node-a')
    expect(verifyAuth(TEST_PSK, nonce, { ...valid, node: 'node-b' })).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadMac,
    })
    expect(
      verifyAuth(TEST_PSK, nonce, { ...valid, channelId: 'b'.repeat(32) }),
    ).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadMac,
    })
  })
})

describe('secret handling', () => {
  test('a short secret is refused outright', () => {
    expect(() => assertUsablePsk('short')).toThrow(WeakSecretError)
    expect(() => assertUsablePsk('x'.repeat(PSK_MIN_LENGTH))).not.toThrow()
  })

  test('pskFromEnv reads the injected variable', () => {
    expect(pskFromEnv(PSK_ENV_VAR, { [PSK_ENV_VAR]: TEST_PSK })).toBe(TEST_PSK)
  })

  test('pskFromEnv refuses to run without one, rather than defaulting', () => {
    expect(() => pskFromEnv(PSK_ENV_VAR, {})).toThrow(WeakSecretError)
    expect(() => pskFromEnv(PSK_ENV_VAR, { [PSK_ENV_VAR]: 'tiny' })).toThrow(
      WeakSecretError,
    )
  })
})
