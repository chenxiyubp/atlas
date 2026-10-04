// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Failure backoff for `POST /login`.
 *
 * A console token is a 32-character random string, so this is not defending a
 * human-chosen password — it is defending against the thing a login *form*
 * newly makes possible. Before the form existed, guessing meant driving the
 * JSON API with a script, which is a thing an operator would have to build; a
 * text box on a page that answers 200 or 401 is a guessing oracle that anyone
 * who finds the port can drive from a browser tab. An input box on a public
 * address with no backoff behind it is an online brute-force target, whatever
 * the entropy of the secret behind it.
 *
 * **The reverse proxy in front of this cannot stand in for it.** `limit_req`
 * there is per-location and this console's live surfaces (the SSE stream, the
 * five-second poller) are exactly the ones such a rule is usually written to
 * skip; a defence that lives in a config file this repository does not own is a
 * defence nobody can test.
 *
 * In-memory on purpose: the console holds no state that survives a restart —
 * its tokens do not either, when they are generated — and persisting attacker
 * counters would mean inventing a file for them. A restart honestly forgets.
 *
 * Keyed by whatever the caller passes, which in `http.ts` is the peer address
 * of the socket and **never** `X-Forwarded-For`: that header is written by the
 * client on a directly-reached console, so trusting it would let one attacker
 * mint a fresh bucket per attempt and delete this file's reason to exist.
 * Behind a single reverse proxy the consequence is that every client shares
 * `127.0.0.1` and this collapses into one global throttle. That is accepted,
 * and for a console with exactly two tokens it is arguably the right shape:
 * what is being guessed at is the *console*, not the caller. It does mean one
 * clumsy operator can lock out the rest for up to {@link MAX_DELAY_SECONDS} —
 * five minutes of waiting is the price, and the alternative was an unbounded
 * guessing rate.
 */

/** Free attempts before delays start: typos are not attacks. */
const FREE_FAILURES = 5

/** Delay doubles per failure past the free ones, capped here. */
const MAX_DELAY_SECONDS = 300

/** Counters idle this long are forgotten (also the sweep horizon). */
const FORGET_AFTER_MS = 60 * 60 * 1000

interface Entry {
  failures: number
  /** Epoch ms before which further attempts are refused. */
  blockedUntil: number
  lastFailureAt: number
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>()
  private nextExpiry = Number.POSITIVE_INFINITY

  /** Seconds the caller must still wait, or 0 when an attempt is allowed. */
  retryAfterSeconds(key: string, nowMs: number): number {
    const entry = this.entries.get(key)
    if (entry === undefined) return 0
    if (nowMs - entry.lastFailureAt > FORGET_AFTER_MS) {
      this.entries.delete(key)
      return 0
    }
    return Math.max(0, Math.ceil((entry.blockedUntil - nowMs) / 1000))
  }

  recordFailure(key: string, nowMs: number): void {
    this.sweep(nowMs)
    const entry = this.entries.get(key) ?? {
      failures: 0,
      blockedUntil: 0,
      lastFailureAt: 0,
    }
    entry.failures += 1
    entry.lastFailureAt = nowMs
    const past = entry.failures - FREE_FAILURES
    if (past > 0) {
      const delay = Math.min(2 ** (past - 1), MAX_DELAY_SECONDS)
      entry.blockedUntil = nowMs + delay * 1000
    }
    this.entries.set(key, entry)
    this.nextExpiry = Math.min(this.nextExpiry, nowMs + FORGET_AFTER_MS)
  }

  /** Called on a successful login: a right answer erases the wrong ones. */
  clear(key: string): void {
    this.entries.delete(key)
  }

  /**
   * Drop idle counters on the write path — no timer to manage, and the map
   * stays bounded by "distinct keys that failed within the last hour", which a
   * console this size can always afford.
   */
  private sweep(nowMs: number): void {
    // A burst of new sources cannot expire any entry yet. Scanning the whole
    // map for every failed login would make that burst quadratic.
    if (nowMs <= this.nextExpiry) return
    this.nextExpiry = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.lastFailureAt > FORGET_AFTER_MS) {
        this.entries.delete(key)
      } else {
        this.nextExpiry = Math.min(
          this.nextExpiry,
          entry.lastFailureAt + FORGET_AFTER_MS,
        )
      }
    }
  }
}
