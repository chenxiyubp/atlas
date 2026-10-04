// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Replay guard for capability tokens.
 *
 * A signature stays valid for as long as its claims say, so without this a
 * token captured once can be presented again until it expires — the signature
 * proves who wrote it, never how many times it has been used. protocol.md
 * §10.1 gives the nonce the same retention rule as the dedup table (§7.2):
 * remember it until the token expires, and not one moment longer, because past
 * `exp` the expiry check refuses the token anyway and the entry would only be
 * growing the table.
 *
 * Scoped per issuer: two nodes picking the same random nonce is not an event
 * worth turning into a rejection, and the key that matters is "this issuer said
 * this once".
 */

/** Ceiling on retained nonces. Reached only under abuse. */
export const DEFAULT_NONCE_CAPACITY = 10_000

interface Seen {
  readonly key: string
  readonly expiresAt: number
}

export interface NonceStoreOptions {
  readonly capacity?: number
}

/** Remembers `(issuer, nonce)` until the token that carried it expires. */
export class NonceStore {
  readonly #seen = new Map<string, number>()
  readonly #capacity: number

  constructor(options: NonceStoreOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_NONCE_CAPACITY
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `nonce capacity must be a positive integer, got ${capacity}`,
      )
    }
    this.#capacity = capacity
  }

  get size(): number {
    return this.#seen.size
  }

  /**
   * Record a first use, or report a replay.
   *
   * Records *before* the caller acts on the token, for the same reason the
   * dedup table does: two copies arriving back to back must not both find the
   * table empty.
   */
  admit(
    issuer: string,
    nonce: string,
    expiresAt: number,
    now: number,
  ): boolean {
    this.#prune(now)
    const key = `${issuer} ${nonce}`
    const seenUntil = this.#seen.get(key)
    if (seenUntil !== undefined && seenUntil > now) return false
    this.#seen.set(key, expiresAt)
    this.#enforceCap()
    return true
  }

  clear(): void {
    this.#seen.clear()
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(key)
    }
  }

  #enforceCap(): void {
    if (this.#seen.size <= this.#capacity) return
    const ordered: Seen[] = [...this.#seen].map(([key, expiresAt]) => ({
      key,
      expiresAt,
    }))
    ordered.sort((a, b) => a.expiresAt - b.expiresAt)
    const excess = this.#seen.size - this.#capacity
    for (let index = 0; index < excess; index += 1) {
      const entry = ordered[index]
      if (entry === undefined) break
      this.#seen.delete(entry.key)
    }
  }
}
