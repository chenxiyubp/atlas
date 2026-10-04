// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { isValidSegment } from '@qianmo/protocol'

/**
 * The one and only place a `(agent, contextId)` session key is built or taken
 * apart (design `resident-botization.md` §4.3, hermes C1).
 *
 * Why a single construction point is a hard rule and not a preference: the key
 * decides which ACP transcript a remote request lands in. A second place that
 * spells the key even slightly differently does not fail loudly — it silently
 * routes one requester's turn into another requester's history, which is the
 * exact "cross-user history bleed" this module exists to prevent. A repo-wide
 * scan assertion in `test/session-key.test.ts` keeps it single.
 */

/**
 * Separator between the agent segment and the context segment.
 *
 * Safe because `isValidSegment` forbids `:` in an agent name, so the FIRST
 * colon in a key is always the separator no matter what the context looks
 * like — the split is unambiguous even for a hostile `contextId`.
 */
export const SESSION_KEY_SEPARATOR = ':'

/**
 * Where a request without a `contextId` lands.
 *
 * Not optional and not implicit: hermes C1's finding transfers word for word —
 * if the missing-context case does not fall back to one explicit bucket, every
 * such requester collapses into whatever session happens to be first, which is
 * precisely today's behaviour. Naming the bucket makes that collapse a
 * deliberate, single, inspectable session instead of an accident.
 *
 * A peer that explicitly sends `contextId: "default"` deliberately lands in
 * this same bucket. That is the honest reading of the name, and it is strictly
 * better than the status quo where every peer shares one context regardless.
 */
export const DEFAULT_CONTEXT = 'default'

/**
 * Contexts that may be stored verbatim: bounded, printable, and free of the
 * separator's ambiguity. Anything else is digested (below) rather than
 * rejected — rejecting would push two different contexts back into one bucket.
 */
const SAFE_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/

/**
 * Marks a digested context. Excluded from {@link SAFE_CONTEXT_PATTERN}'s first
 * character on purpose, so a verbatim context can never be mistaken for a
 * digest or vice versa.
 */
const DIGEST_PREFIX = '#'

const DIGEST_LENGTH = 32

const DIGEST_PATTERN = new RegExp(
  `^${DIGEST_PREFIX}[0-9a-f]{${DIGEST_LENGTH}}$`,
)

/**
 * `contextId` arrives from the wire as an arbitrary non-empty string
 * (`@qianmo/protocol` validates nothing beyond that), and it ends up as a key
 * in a durable JSON file. Verbatim storage of an unbounded remote string would
 * let a peer inflate `sessions.json` by megabytes per context. So: keep the
 * readable ones readable, and collapse everything else onto a fixed-width
 * digest that is still injective for practical purposes.
 */
function normalizeContext(contextId: string | undefined): string {
  if (contextId === undefined || contextId.length === 0) return DEFAULT_CONTEXT
  if (SAFE_CONTEXT_PATTERN.test(contextId)) return contextId
  return `${DIGEST_PREFIX}${createHash('sha256')
    .update(contextId, 'utf8')
    .digest('hex')
    .slice(0, DIGEST_LENGTH)}`
}

function isNormalizedContext(value: string): boolean {
  return SAFE_CONTEXT_PATTERN.test(value) || DIGEST_PATTERN.test(value)
}

/** Builds the session key for `(agent, contextId)`. The only such place. */
export function sessionKeyOf(agent: string, contextId?: string): string {
  if (!isValidSegment(agent)) throw new Error('agent is invalid')
  return `${agent}${SESSION_KEY_SEPARATOR}${normalizeContext(contextId)}`
}

/** True when `value` could have been produced by {@link sessionKeyOf}. */
export function isSessionKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const separator = value.indexOf(SESSION_KEY_SEPARATOR)
  if (separator < 0) return false
  return (
    isValidSegment(value.slice(0, separator)) &&
    isNormalizedContext(value.slice(separator + SESSION_KEY_SEPARATOR.length))
  )
}

/** The agent half of a session key, or `undefined` if it is not one. */
export function agentOfSessionKey(key: string): string | undefined {
  if (!isSessionKey(key)) return undefined
  return key.slice(0, key.indexOf(SESSION_KEY_SEPARATOR))
}

/** The context half of a session key, or `undefined` if it is not one. */
export function contextOfSessionKey(key: string): string | undefined {
  if (!isSessionKey(key)) return undefined
  return key.slice(key.indexOf(SESSION_KEY_SEPARATOR) + 1)
}
