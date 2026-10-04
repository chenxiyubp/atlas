// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the console keeps what an operator wrote about a machine.
 *
 * The same shape as `consoleChatStore.ts`, deliberately and for the same
 * reasons: an append-only NDJSON file, one record per line, replayed on start.
 * A partial write costs the last line rather than the file, and an unreadable
 * byte written during a power cut costs one note rather than the page.
 *
 * ## One kind of record, and it repeats itself
 *
 * `note` is written **again in full** every time a server's note changes, and
 * replay keeps the last record for each server. Not a patch log: a patch log
 * needs a merge function, and there is nothing here to merge — a note is one
 * string that a person replaced with another string.
 *
 * Volume makes this affordable and is worth stating so the next reader does not
 * generalise it: the writer is a person typing into a textarea, once per
 * machine, occasionally. **Compaction is a non-goal.** A fleet of nine machines
 * whose notes are rewritten daily for a year is under 3300 lines.
 *
 * ## What is *not* here
 *
 * The path. It arrives from `consoleArgs.ts`, derived from `occConfigPath()`
 * like every other identity-bearing path in this repository (CLAUDE.md §1.1②).
 * This module never joins a home directory to anything.
 *
 * The allowlist, too. This store writes whatever server id it is handed;
 * deciding that the id is one this console was started with belongs to
 * `http.ts`, next to the wake target check it copies (`ConsoleDeps.nodeServers`).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ServerNote } from '@qianmo/console'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rebuild one note from a line.
 *
 * Returns `null` rather than throwing on anything unexpected, so one bad line
 * costs that note instead of the whole file. `note` is checked with `typeof`
 * rather than for emptiness on purpose: an empty string is how an operator
 * clears a note, and dropping those on replay would resurrect the text they
 * deleted the next time the console restarted.
 */
function toNote(value: unknown): ServerNote | null {
  if (!isRecord(value)) return null
  const server = value['server']
  const note = value['note']
  const updatedAt = value['updatedAt']
  if (typeof server !== 'string' || server === '') return null
  if (typeof note !== 'string') return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  return { server, note, updatedAt }
}

export class ServerNotesStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  /** The file this store writes. Printed in the startup banner, never a secret. */
  get path(): string {
    return this.#path
  }

  /**
   * Replay the file, last write per server winning.
   *
   * A missing file is an empty list, not an error — a console nobody has
   * annotated yet is the ordinary first-run state.
   */
  load(): readonly ServerNote[] {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch {
      return []
    }
    const notes = new Map<string, ServerNote>()
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed) || parsed['kind'] !== 'note') continue
      const note = toNote(parsed['note'])
      // `Map.set` on an existing key keeps the original insertion position, so
      // "last write wins" and "first-seen order" hold at the same time.
      if (note !== null) notes.set(note.server, note)
    }
    return [...notes.values()]
  }

  append(note: ServerNote): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: DIR_MODE })
    appendFileSync(this.#path, `${JSON.stringify({ kind: 'note', note })}\n`, {
      mode: FILE_MODE,
    })
  }
}
