// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AdmissionLedger } from './contracts.js'
import {
  assertGcPolicy,
  DEFAULT_RESIDENT_SESSION_GC_POLICY,
  selectEvictableSessions,
  type ResidentSessionGcPolicy,
} from './session-gc.js'
import { DEFAULT_CONTEXT, sessionKeyOf } from './session-key.js'
import type {
  ResidentSessionRecord,
  ResidentSessionStore,
} from './session-store.js'

export interface ResidentAgentSession {
  readonly agent: string
  readonly cwd: string
}

export interface ResidentSessionConnection {
  initialize(): Promise<void>
  newSession(input: ResidentAgentSession): Promise<string>
  resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void>
}

/**
 * What `ResidentNodeRuntime` needs from a session source, so the runtime does
 * not have to know whether sessions are durable, lazy, or garbage collected.
 */
export interface ResidentSessionResolver {
  /**
   * Resolves — creating or resuming as needed — the session for this
   * `(agent, contextId)` and marks it in flight until {@link release}.
   */
  sessionFor(agent: string, contextId?: string): Promise<string>
  /** Ends the in-flight marking a {@link sessionFor} call started. */
  release(sessionId: string): void
}

/**
 * How stale an in-memory `lastUsedAt` may get before it is written through.
 *
 * Every turn touches its session. Persisting each touch would fsync
 * `sessions.json` once per turn for a value whose only consumer is an LRU
 * measured in hours — pure write amplification. So touches live in memory and
 * only reach the disk when they have drifted this far, which keeps the durable
 * ordering good enough for the GC and leaves a quiet node writing nothing.
 */
const TOUCH_PERSIST_INTERVAL_MS = 60_000

/** The session ids the admission ledgers still hold pending records for. */
export function pendingSessionIds(
  ledgers: Iterable<AdmissionLedger>,
): readonly string[] {
  const ids: string[] = []
  for (const ledger of ledgers) {
    for (const pending of ledger.query().pending) ids.push(pending.sessionId)
  }
  return ids
}

export interface ResidentSessionManagerOptions {
  readonly connection: ResidentSessionConnection
  readonly store: ResidentSessionStore
  readonly agents: readonly ResidentAgentSession[]
  readonly now?: () => number
  readonly policy?: ResidentSessionGcPolicy
  /**
   * Source of GC exemption ③. Left out, nothing is exempt on that ground —
   * which is correct for a host with no durable admission ledger, and wrong
   * for one that has them, so the resident host wires it.
   */
  readonly pendingSessionIds?: () => Iterable<string>
}

/**
 * Maps `(agent, contextId)` onto ACP sessions (design §4.3).
 *
 * `start()` only opens the `DEFAULT_CONTEXT` session of each agent — that is
 * the one every context-less request lands in, and it is the whole of today's
 * behaviour. Every other context is created on first sight, so a node that
 * never sees a `contextId` behaves exactly as it did before this existed.
 */
export class ResidentSessionManager implements ResidentSessionResolver {
  readonly #connection: ResidentSessionConnection
  readonly #store: ResidentSessionStore
  readonly #agents: ReadonlyMap<string, ResidentAgentSession>
  readonly #now: () => number
  readonly #policy: ResidentSessionGcPolicy
  readonly #pendingSessionIds: () => Iterable<string>
  /** Keys whose ACP session this process has already opened or resumed. */
  readonly #live = new Set<string>()
  /** Unpersisted `lastUsedAt` touches; see {@link TOUCH_PERSIST_INTERVAL_MS}. */
  readonly #touched = new Map<string, number>()
  /** GC exemption ①: outstanding {@link sessionFor} leases, by session id. */
  readonly #inFlight = new Map<string, number>()

  constructor(options: ResidentSessionManagerOptions) {
    if (options.agents.length === 0) {
      throw new Error('resident node requires at least one agent')
    }
    const agents = new Map<string, ResidentAgentSession>()
    for (const agent of options.agents) {
      if (agents.has(agent.agent)) {
        throw new Error(`duplicate resident agent ${agent.agent}`)
      }
      agents.set(agent.agent, agent)
    }
    this.#policy = options.policy ?? DEFAULT_RESIDENT_SESSION_GC_POLICY
    assertGcPolicy(this.#policy)
    this.#connection = options.connection
    this.#store = options.store
    this.#agents = agents
    this.#now = options.now ?? Date.now
    this.#pendingSessionIds = options.pendingSessionIds ?? (() => [])
  }

  async start(): Promise<void> {
    await this.#connection.initialize()
    for (const agent of this.#agents.values()) {
      await this.#open(agent, sessionKeyOf(agent.agent, DEFAULT_CONTEXT))
    }
  }

  async sessionFor(agent: string, contextId?: string): Promise<string> {
    const configured = this.#agents.get(agent)
    if (configured === undefined) {
      throw new Error(`resident agent ${agent} is not configured`)
    }
    const key = sessionKeyOf(agent, contextId)
    // Collect before resolving: the room a new context needs has to exist
    // before it is written, never after (G-6).
    this.collect()
    const sessionId = await this.#open(configured, key)
    this.#inFlight.set(sessionId, (this.#inFlight.get(sessionId) ?? 0) + 1)
    return sessionId
  }

  release(sessionId: string): void {
    const outstanding = this.#inFlight.get(sessionId)
    if (outstanding === undefined) return
    if (outstanding <= 1) this.#inFlight.delete(sessionId)
    else this.#inFlight.set(sessionId, outstanding - 1)
  }

  sessionOf(agent: string, contextId?: string): string {
    const key = sessionKeyOf(agent, contextId)
    const stored = this.#store.get(key)
    if (stored === undefined || !this.#live.has(key)) {
      throw new Error(`resident agent ${agent} has no active ACP session`)
    }
    return stored.sessionId
  }

  /** Live `(agent, contextId)` key to session id, for diagnostics. */
  sessions(): Readonly<Record<string, string>> {
    const live: Record<string, string> = {}
    for (const key of this.#live) {
      const stored = this.#store.get(key)
      if (stored !== undefined) live[key] = stored.sessionId
    }
    return live
  }

  /**
   * Runs one GC pass and returns the evicted keys.
   *
   * Fails safe: if the exemption ③ source cannot answer (a damaged ledger
   * throws on `query()`), nothing is evicted this round. Evicting on an
   * unknown pending set is exactly the mistake the exemption exists to
   * prevent.
   */
  collect(): readonly string[] {
    let pending: ReadonlySet<string>
    try {
      pending = new Set(this.#pendingSessionIds())
    } catch {
      return []
    }
    const evicted = selectEvictableSessions({
      entries: this.#entries(),
      now: this.#now(),
      policy: this.#policy,
      inFlightSessionIds: new Set(this.#inFlight.keys()),
      pendingSessionIds: pending,
    })
    for (const key of evicted) {
      // Dropping the mapping is the whole of eviction: the ACP-side transcript
      // stays where it is, because it is the base runtime's data and `--resume`
      // still wants it.
      this.#store.delete(key)
      this.#live.delete(key)
      this.#touched.delete(key)
    }
    return evicted
  }

  #entries(): Readonly<Record<string, ResidentSessionRecord>> {
    const entries = { ...this.#store.entries() }
    for (const [key, lastUsedAt] of this.#touched) {
      const stored = entries[key]
      if (stored !== undefined) entries[key] = { ...stored, lastUsedAt }
    }
    return entries
  }

  async #open(agent: ResidentAgentSession, key: string): Promise<string> {
    const stored = this.#store.get(key)
    if (stored === undefined) {
      const sessionId = await this.#connection.newSession(agent)
      const at = this.#now()
      this.#store.set(key, { sessionId, createdAt: at, lastUsedAt: at })
      this.#live.add(key)
      return sessionId
    }
    if (!this.#live.has(key)) {
      await this.#connection.resumeSession({
        ...agent,
        sessionId: stored.sessionId,
      })
      this.#live.add(key)
    }
    this.#touch(key, stored)
    return stored.sessionId
  }

  #touch(key: string, stored: ResidentSessionRecord): void {
    const at = this.#now()
    if (at - stored.lastUsedAt >= TOUCH_PERSIST_INTERVAL_MS) {
      this.#touched.delete(key)
      this.#store.set(key, { ...stored, lastUsedAt: at })
      return
    }
    if (at > (this.#touched.get(key) ?? stored.lastUsedAt)) {
      this.#touched.set(key, at)
    }
  }
}
