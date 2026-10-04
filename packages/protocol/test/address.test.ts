// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  ADDRESS_SCHEME,
  ProtocolError,
  ProtocolErrorCode,
  addressEquals,
  assertAddress,
  formatAddress,
  isValidAddress,
  isValidSegment,
  nodeOf,
  parseAddress,
} from '../src/index.js'

describe('address', () => {
  test('parses a well-formed address', () => {
    const parsed = parseAddress('qianmo://tokyo-1/planner')
    expect(parsed).toEqual({ node: 'tokyo-1', agent: 'planner' })
  })

  test('round-trips through format and parse', () => {
    const address = formatAddress({ node: 'node_a', agent: 'agent-9' })
    expect(address).toBe('qianmo://node_a/agent-9')
    expect(parseAddress(address)).toEqual({ node: 'node_a', agent: 'agent-9' })
  })

  test('exposes the scheme constant', () => {
    expect(ADDRESS_SCHEME).toBe('qianmo://')
  })

  test('rejects malformed addresses', () => {
    const bad = [
      '',
      'tokyo-1/planner',
      'https://tokyo-1/planner',
      'qianmo://tokyo-1',
      'qianmo:///planner',
      'qianmo://tokyo-1/',
      'qianmo://tokyo-1/planner/extra',
      'qianmo://TOKYO/planner',
      'qianmo://tokyo 1/planner',
      'qianmo://-tokyo/planner',
      'qianmo://tokyo-/planner',
      'qianmo://tokyo/planner?x=1',
      'qianmo://tokyo/plan#er',
    ]
    for (const raw of bad) {
      expect(parseAddress(raw)).toBeNull()
      expect(isValidAddress(raw)).toBe(false)
    }
  })

  test('rejects non-string input', () => {
    expect(parseAddress(undefined)).toBeNull()
    expect(parseAddress(42)).toBeNull()
    expect(parseAddress({ node: 'a', agent: 'b' })).toBeNull()
  })

  test('rejects segments longer than 64 characters', () => {
    const long = 'a'.repeat(65)
    expect(isValidSegment(long)).toBe(false)
    expect(isValidSegment('a'.repeat(64))).toBe(true)
    expect(isValidAddress(`qianmo://${long}/planner`)).toBe(false)
  })

  test('formatAddress throws E_BAD_ADDRESS on an invalid segment', () => {
    expect(() => formatAddress({ node: 'Bad Node', agent: 'planner' })).toThrow(
      ProtocolError,
    )
    try {
      formatAddress({ node: 'ok', agent: '' })
      throw new Error('expected formatAddress to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(
        ProtocolErrorCode.E_BAD_ADDRESS,
      )
      expect((error as ProtocolError).field).toBe('agent')
    }
  })

  test('assertAddress returns the parsed value or throws', () => {
    expect(assertAddress('qianmo://n1/a1')).toEqual({ node: 'n1', agent: 'a1' })
    expect(() => assertAddress('nope', 'to')).toThrow(ProtocolError)
  })

  test('addressEquals compares structurally', () => {
    expect(
      addressEquals({ node: 'n', agent: 'a' }, { node: 'n', agent: 'a' }),
    ).toBe(true)
    expect(
      addressEquals({ node: 'n', agent: 'a' }, { node: 'n', agent: 'b' }),
    ).toBe(false)
  })

  test('nodeOf extracts the node segment', () => {
    expect(nodeOf('qianmo://edge-7/writer')).toBe('edge-7')
    expect(nodeOf('garbage')).toBeNull()
  })
})
