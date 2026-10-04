// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Numbers and instants, turned into the words an operator reads.
 *
 * Everything here is a pure function of its arguments — no `Date.now()`, no
 * ambient state — which is what lets the whole view layer be tested with plain
 * numbers instead of a browser. `now` is threaded in from the caller for the
 * same reason the rest of the packages take a clock port.
 *
 * ## Local time, deliberately
 *
 * Clock strings are rendered in the machine's local zone. An operator reading
 * "12:03:41" wants their own wall clock, not UTC; the absolute instant is still
 * recoverable from the `datetime` attribute the page writes alongside. The cost
 * is that the exact digits depend on `TZ`, so the tests assert the *shape* of
 * the clock and the exact text of the relative part.
 */

import { createHash } from 'node:crypto'
import type { ConsoleAgent } from '../deps.js'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** What we print when a timestamp is missing, zero, or not a number. */
const NO_VALUE = '—'

function usableInstant(at: number): boolean {
  return Number.isFinite(at) && at > 0
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * `HH:MM:SS` in the machine's local zone.
 *
 * Exported alongside {@link formatInstant} because the tables want the two
 * halves *separately*: the clock is the value, the relative gap is a footnote,
 * and rendering them at the same weight — as one `12:03:41（3 分钟前）`
 * string — makes a column of times unscannable.
 */
export function formatClock(at: number): string {
  if (!usableInstant(at)) return NO_VALUE
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds(),
  )}`
}

function clockOf(at: number): string {
  return formatClock(at)
}

/**
 * `YYYY-MM-DD HH:MM:SS`, local zone.
 *
 * The audit table uses this rather than {@link formatInstant}: `renderAudit`
 * is not given a `now`, and a relative time is meaningless in a table whose
 * rows can be weeks apart anyway.
 */
export function formatDateTime(at: number): string {
  if (!usableInstant(at)) return NO_VALUE
  const date = new Date(at)
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}`
  return `${day} ${clockOf(at)}`
}

/**
 * The value a `<input type="datetime-local">` wants: `YYYY-MM-DDTHH:MM`, local.
 *
 * Note for the HTTP side: what comes back on submit is that same local string,
 * and `Date.parse` reads it as local time — which is what the operator meant.
 */
export function toDatetimeLocal(at: number): string {
  if (!usableInstant(at)) return ''
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** How long ago (or ahead) `at` is, in words. Coarse on purpose. */
export function formatRelative(at: number, now: number): string {
  if (!usableInstant(at)) return NO_VALUE
  const delta = now - at
  const magnitude = Math.abs(delta)
  if (magnitude < SECOND) return '刚刚'
  // A future timestamp is not a bug to hide: two nodes' clocks disagree, and
  // "3 秒后" on a heartbeat is the operator's first clue that they do.
  const suffix = delta >= 0 ? '前' : '后'
  if (magnitude < MINUTE) {
    return `${Math.floor(magnitude / SECOND)} 秒${suffix}`
  }
  if (magnitude < HOUR) {
    return `${Math.floor(magnitude / MINUTE)} 分钟${suffix}`
  }
  if (magnitude < DAY) {
    return `${Math.floor(magnitude / HOUR)} 小时${suffix}`
  }
  return `${Math.floor(magnitude / DAY)} 天${suffix}`
}

/**
 * `12:03:41（3 分钟前）` — clock plus gap, in one string.
 *
 * Kept because it is part of the agreed export surface, and it is the right
 * shape for a single value in prose. The tables use {@link formatClock} and
 * {@link formatRelative} separately so they can style the two halves apart.
 */
export function formatInstant(at: number, now: number): string {
  if (!usableInstant(at)) return NO_VALUE
  return `${clockOf(at)}（${formatRelative(at, now)}）`
}

/**
 * A span of time in words: `1 分 30 秒`, `90 天`.
 *
 * Two units at most. Three is a wall of digits nobody reads, and the third unit
 * is never what decides anything here — a lease with 2 days left is a lease
 * with 2 days left whether or not it also has 7 minutes.
 *
 * Negative input clamps to zero rather than printing `-3 秒`: the callers that
 * can go negative (a lease that already lapsed) have a better word for it and
 * check the sign themselves.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return NO_VALUE
  const total = Math.max(0, Math.floor(ms))
  if (total < SECOND) return `${total} 毫秒`

  const seconds = Math.floor(total / SECOND)
  if (seconds < 60) return `${seconds} 秒`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
  }

  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days} 天` : `${days} 天 ${rest} 小时`
}

/**
 * `4m50s` — the compact spelling the lease column needs.
 *
 * {@link formatDuration} is the right shape for prose (`1 分 30 秒`) and the
 * wrong shape for a column that has to sit under a 3px bar in every row: the
 * spaces and the CJK units make it three times as wide and stop it lining up
 * digit-for-digit with the row above. Two units at most, no spaces, minutes and
 * hours zero-padded so the strings are the same width as they count down.
 */
export function formatShortDuration(ms: number): string {
  if (!Number.isFinite(ms)) return NO_VALUE
  const total = Math.max(0, Math.floor(ms))
  const seconds = Math.floor(total / SECOND)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m${pad2(rest)}s`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h${pad2(rest)}m`
  }

  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days}d` : `${days}d${rest}h`
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

/**
 * Binary units, because that is what the protocol ceiling is written in:
 * `LIMITS.maxMessageBytes` is `256 * 1024`, and printing it as "262 kB" would
 * make the page disagree with the constant it is quoting.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return NO_VALUE
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} ${BYTE_UNITS[unit]}`
}

export type AgentHealth = 'live' | 'stale' | 'expired'

/**
 * The lease the registry actually granted this record, or `null`.
 *
 * The registry stamps both instants in one step — `expiresAt` is
 * `lastHeartbeatAt + ttl` for the TTL *it* runs with, on register, on heartbeat
 * and on restore (where the deadline is recomputed from the TTL in force) — so
 * their difference is that TTL, read off the wire rather than assumed. The
 * console used to judge every row against its own compiled-in default instead,
 * and a registry started with an hour-long lease then showed a node two minutes
 * past its last heartbeat as 过期 while the registry still routed to it
 * (validation report 2026-09-08, C-1).
 *
 * A time-jump rebase moves `expiresAt` without touching `lastHeartbeatAt`; the
 * span then includes the jump, and so does the registry's own verdict.
 */
function grantedLease(agent: ConsoleAgent): number | null {
  const beat = agent.lastHeartbeatAt
  const expires = agent.expiresAt
  if (!(usableInstant(beat) && usableInstant(expires))) return null
  return expires > beat ? expires - beat : null
}

/**
 * The scale one row is judged against: the registry's own lease for it, and
 * `fallbackMs` only when the record does not carry both instants.
 */
function leaseOf(agent: ConsoleAgent, fallbackMs: number): number {
  return grantedLease(agent) ?? fallbackMs
}

/**
 * The lease the registry is granting now, for the one number the page prints.
 *
 * Read off the most recently renewed record: every register and heartbeat
 * stamps its deadline from the TTL in force at that moment, so the newest stamp
 * is the newest statement of it. `fallbackMs` when no record carries a readable
 * lease — an empty roster has nothing to read it from.
 */
export function rosterLease(
  agents: readonly ConsoleAgent[],
  fallbackMs: number,
): number {
  let newest: { readonly beat: number; readonly lease: number } | null = null
  for (const one of agents) {
    const lease = grantedLease(one)
    if (lease === null) continue
    if (newest === null || one.lastHeartbeatAt > newest.beat) {
      newest = { beat: one.lastHeartbeatAt, lease }
    }
  }
  return newest === null ? fallbackMs : newest.lease
}

/**
 * Half a lease. Past this point a well-behaved node is *late*, not merely idle.
 *
 * A node renews by heartbeat, so `expiresAt` is `lastHeartbeatAt + ttl` and
 * "heartbeat older than the TTL" and "lease lapsed" are the same event —
 * without a second threshold the middle state would be unreachable and the
 * amber light would never once come on. Half is the point at which the next
 * renewal is already overdue, which is the earliest moment an operator can act
 * on rather than be surprised by.
 */
const STALE_FRACTION = 0.5

/**
 * Three-valued on purpose. `live`/`expired` alone would put a node that stopped
 * heartbeating four minutes into a five-minute lease in the same bucket as one
 * that answered a second ago — and that node is precisely the one worth looking
 * at, because it is about to drop off the roster.
 *
 * The scale is the record's own lease ({@link leaseOf}); `fallbackTtlMs` only
 * stands in for a record that does not carry one.
 */
export function agentHealth(
  agent: ConsoleAgent,
  now: number,
  fallbackTtlMs: number,
): AgentHealth {
  // The lease is the registry's own verdict; it wins whenever it has spoken.
  if (usableInstant(agent.expiresAt) && agent.expiresAt <= now) {
    return 'expired'
  }

  const beat = agent.lastHeartbeatAt
  // Registered, lease still open, never once heard from. Not `live`: nothing
  // has confirmed this node exists beyond the request that created the row.
  if (!usableInstant(beat)) return 'stale'

  const lease = leaseOf(agent, fallbackTtlMs)
  // No scale to judge against — the lease check above is all we have.
  if (!(Number.isFinite(lease) && lease > 0)) return 'live'

  // Clock skew (a heartbeat stamped in the future) reads as "just now" rather
  // than as a negative age that would sort backwards through the thresholds.
  const age = Math.max(0, now - beat)
  if (age >= lease) return 'expired'
  if (age >= lease * STALE_FRACTION) return 'stale'
  return 'live'
}

/**
 * How much of the lease this node has burned through, for the bar in the table.
 *
 * The ratio is *heartbeat age over lease TTL*, which is the one thing on this
 * page that cannot be read off any of the other columns: an absolute clock says
 * when the node last spoke, and only the ratio says how close that is to being
 * too long ago.
 *
 * Three decisions worth stating:
 *
 * - **The tone is taken from {@link agentHealth}, not recomputed.** If the bar
 *   and the status word could disagree the operator would have to work out
 *   which one is lying; passing the verdict in makes that impossible.
 * - **An expired lease locks the bar at full width.** A node 3× past its TTL
 *   does not get a 300%-wide bar, and — more usefully — a node whose registry
 *   record lapsed while its heartbeat is fresh still reads as dead, because the
 *   registry's verdict is the one that decides whether messages get routed.
 * - **Never heard from falls back to the lease.** With no heartbeat there is no
 *   age to divide, so the elapsed part is derived from `expiresAt` instead;
 *   `expiresAt` is `lastHeartbeatAt + ttl` for a node that ever spoke, so the
 *   two definitions agree everywhere they overlap.
 *
 * Returns `null` when there is no scale to draw against — no TTL, and no lease
 * to borrow one from. A missing bar is honest; a full-width one would not be.
 * The scale is the same one {@link agentHealth} judged by ({@link leaseOf}).
 */
export function leaseView(
  agent: ConsoleAgent,
  now: number,
  fallbackTtlMs: number,
  health: AgentHealth,
): {
  readonly ratio: number
  readonly tone: 'ink' | 'stale' | 'dead'
  readonly remainingMs: number
} | null {
  const lease = leaseOf(agent, fallbackTtlMs)
  if (!(Number.isFinite(lease) && lease > 0)) return null
  if (health === 'expired') return { ratio: 1, tone: 'dead', remainingMs: 0 }

  let elapsed: number
  if (usableInstant(agent.lastHeartbeatAt)) {
    elapsed = Math.max(0, now - agent.lastHeartbeatAt)
  } else if (usableInstant(agent.expiresAt)) {
    elapsed = Math.max(0, lease - (agent.expiresAt - now))
  } else {
    return null
  }

  const ratio = Math.min(1, elapsed / lease)
  return {
    ratio,
    tone: health === 'stale' ? 'stale' : 'ink',
    remainingMs: Math.max(0, lease - elapsed),
  }
}

/**
 * First 8 hex of the sha-256 of a published key.
 *
 * A *hash*, not a prefix of the key itself. Both would be 8 characters on
 * screen, but only one of them stays 8 characters' worth of information if
 * somebody copies the page: a prefix leaks key bytes, and "it is only the
 * public key" is an argument that stops being true the day this column is
 * reused for something else.
 */
export function publicKeyFingerprint(publicKey: string): string {
  return createHash('sha256')
    .update(String(publicKey), 'utf8')
    .digest('hex')
    .slice(0, 8)
}
