// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The message strings of an SDK or adapter error and of the envelopes it
 * wraps (`error`, `cause`, `response`, `data`), for the wording tables in this
 * directory. Bounded and cycle-safe; reads only `message`, so a request body
 * echoed in some other field is never matched.
 */
export function errorMessageTexts(error: unknown): string[] {
  const texts: string[] = []
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  while (pending.length > 0 && texts.length < 16) {
    const current = pending.shift()
    if (typeof current === 'string') {
      texts.push(current)
      continue
    }
    if (typeof current !== 'object' || current === null) continue
    if (seen.has(current)) continue
    seen.add(current)
    const record = current as Record<string, unknown>
    if (typeof record.message === 'string') texts.push(record.message)
    for (const key of ['error', 'cause', 'response', 'data']) {
      if (record[key] !== undefined) pending.push(record[key])
    }
  }
  return texts
}
