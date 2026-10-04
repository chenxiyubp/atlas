// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolError, ProtocolErrorCode, issue } from './errors.js'

/** Scheme prefix of every Qianmo address. */
export const ADDRESS_SCHEME = 'qianmo://'

/** Maximum length of a single node or agent segment. */
export const MAX_SEGMENT_LENGTH = 64

/**
 * Node and agent names: lowercase alphanumeric, `-` and `_` inside, 1..64 chars.
 * Deliberately narrow so addresses stay case-insensitive and URL-safe.
 */
const SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/

/** A parsed `qianmo://<node>/<agent>` address. */
export interface QianmoAddress {
  /** Host node that runs the agent, e.g. `"tokyo-1"`. */
  readonly node: string
  /** Agent name unique within its node, e.g. `"planner"`. */
  readonly agent: string
}

/** True when `value` is a usable node or agent segment. */
export function isValidSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SEGMENT_LENGTH &&
    SEGMENT_PATTERN.test(value)
  )
}

/**
 * Parse `qianmo://<node>/<agent>`.
 * Returns `null` for anything malformed — no exceptions on the hot path.
 */
export function parseAddress(raw: unknown): QianmoAddress | null {
  if (typeof raw !== 'string' || !raw.startsWith(ADDRESS_SCHEME)) return null

  const rest = raw.slice(ADDRESS_SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  if (rest.indexOf('/', slash + 1) >= 0) return null

  const node = rest.slice(0, slash)
  const agent = rest.slice(slash + 1)
  if (!isValidSegment(node) || !isValidSegment(agent)) return null

  return { node, agent }
}

/** True when `raw` is a well-formed address string. */
export function isValidAddress(raw: unknown): raw is string {
  return parseAddress(raw) !== null
}

/** Render an address; throws {@link ProtocolError} when a segment is invalid. */
export function formatAddress(address: QianmoAddress): string {
  if (!isValidSegment(address.node)) {
    throw new ProtocolError([
      issue(
        ProtocolErrorCode.E_BAD_ADDRESS,
        'node',
        `invalid node segment: ${String(address.node)}`,
      ),
    ])
  }
  if (!isValidSegment(address.agent)) {
    throw new ProtocolError([
      issue(
        ProtocolErrorCode.E_BAD_ADDRESS,
        'agent',
        `invalid agent segment: ${String(address.agent)}`,
      ),
    ])
  }
  return `${ADDRESS_SCHEME}${address.node}/${address.agent}`
}

/** Parse or throw. Use at trust boundaries where a malformed address is fatal. */
export function assertAddress(raw: unknown, field = 'address'): QianmoAddress {
  const parsed = parseAddress(raw)
  if (parsed === null) {
    throw new ProtocolError([
      issue(
        ProtocolErrorCode.E_BAD_ADDRESS,
        field,
        `not a ${ADDRESS_SCHEME} address: ${String(raw)}`,
      ),
    ])
  }
  return parsed
}

/** Structural equality of two addresses. */
export function addressEquals(a: QianmoAddress, b: QianmoAddress): boolean {
  return a.node === b.node && a.agent === b.agent
}

/** Node segment of an address string, or `null` when malformed. */
export function nodeOf(raw: unknown): string | null {
  return parseAddress(raw)?.node ?? null
}
