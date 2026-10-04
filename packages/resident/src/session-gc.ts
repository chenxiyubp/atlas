// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { agentOfSessionKey } from './session-key.js'
import type { ResidentSessionRecord } from './session-store.js'

/**
 * Session garbage collection (design `resident-botization.md` §4.3, hermes C5
 * exemption list; C6 discipline).
 *
 * **What this does not do**: it never derives a budget from machine memory.
 * hermes C6 is in the design as a rule, not as code — `memory_high_mb: auto`
 * computed 1278 MB on a 1.9 GB box, and three of the four Qianmo nodes are
 * small VPSes. Every number here is an explicit constant.
 *
 * **What eviction means**: drop the `(agent, contextId) -> sessionId` mapping
 * and stop resuming it. The ACP-side transcript is NOT deleted — that data
 * belongs to the base runtime and `--resume` still wants it.
 */
export interface ResidentSessionGcPolicy {
  /** Hard ceiling on live sessions per agent. Beyond it, LRU is evicted. */
  readonly maxSessionsPerAgent: number
  /** A session untouched for this long is evictable. */
  readonly idleTtlMs: number
  /**
   * The N most recently used sessions of an agent are never evicted, even
   * past the idle TTL: the prefix cache behind a warm session is the single
   * most valuable thing a resident node holds (hermes C5 ②).
   */
  readonly keepRecentPerAgent: number
}

export const DEFAULT_RESIDENT_SESSION_GC_POLICY: ResidentSessionGcPolicy = {
  maxSessionsPerAgent: 16,
  idleTtlMs: 24 * 60 * 60 * 1000,
  keepRecentPerAgent: 4,
}

export interface ResidentSessionGcInput {
  readonly entries: Readonly<Record<string, ResidentSessionRecord>>
  readonly now: number
  readonly policy: ResidentSessionGcPolicy
  /** ① sessions with a turn running right now. */
  readonly inFlightSessionIds: ReadonlySet<string>
  /** ③ sessions the admission ledger still has a pending record for. */
  readonly pendingSessionIds: ReadonlySet<string>
}

export function assertGcPolicy(policy: ResidentSessionGcPolicy): void {
  if (
    !Number.isInteger(policy.maxSessionsPerAgent) ||
    policy.maxSessionsPerAgent < 1
  ) {
    throw new Error('maxSessionsPerAgent must be a positive integer')
  }
  if (
    !Number.isInteger(policy.keepRecentPerAgent) ||
    policy.keepRecentPerAgent < 0
  ) {
    throw new Error('keepRecentPerAgent must be a non-negative integer')
  }
  if (policy.keepRecentPerAgent >= policy.maxSessionsPerAgent) {
    // Otherwise the cap can never be honoured: every session over the ceiling
    // is also inside the protected window, and the node wedges at capacity.
    throw new Error('keepRecentPerAgent must be below maxSessionsPerAgent')
  }
  if (!Number.isFinite(policy.idleTtlMs) || policy.idleTtlMs <= 0) {
    throw new Error('idleTtlMs must be a positive number')
  }
}

/**
 * Picks the session keys to evict. Pure: it decides, the caller deletes.
 *
 * Three classes are never returned, in the order the design states them:
 * ① a session with a turn in flight, ② the `keepRecentPerAgent` most recently
 * used sessions of that agent, ③ a session the admission ledger still holds a
 * pending record for. ③ is the Qianmo-specific one and the easiest to forget:
 * dropping such a mapping strands a message that has already been promised
 * durable handling.
 */
export function selectEvictableSessions(
  input: ResidentSessionGcInput,
): readonly string[] {
  const byAgent = new Map<
    string,
    { key: string; record: ResidentSessionRecord }[]
  >()
  for (const [key, record] of Object.entries(input.entries)) {
    const agent = agentOfSessionKey(key) ?? key
    const bucket = byAgent.get(agent)
    if (bucket === undefined) byAgent.set(agent, [{ key, record }])
    else bucket.push({ key, record })
  }

  const evicted: string[] = []
  for (const bucket of byAgent.values()) {
    // Most recently used first, so the protected window is a prefix.
    bucket.sort(
      (left, right) => right.record.lastUsedAt - left.record.lastUsedAt,
    )
    const candidates = bucket
      .slice(input.policy.keepRecentPerAgent)
      .filter(
        entry =>
          !input.inFlightSessionIds.has(entry.record.sessionId) &&
          !input.pendingSessionIds.has(entry.record.sessionId),
      )
      // Least recently used first: the cheapest thing to lose goes first.
      .reverse()

    const idle = new Set(
      candidates
        .filter(
          entry =>
            input.now - entry.record.lastUsedAt >= input.policy.idleTtlMs,
        )
        .map(entry => entry.key),
    )
    let overflow = bucket.length - idle.size - input.policy.maxSessionsPerAgent
    for (const entry of candidates) {
      if (idle.has(entry.key)) continue
      if (overflow <= 0) break
      idle.add(entry.key)
      overflow--
    }
    evicted.push(...idle)
  }
  return evicted
}
