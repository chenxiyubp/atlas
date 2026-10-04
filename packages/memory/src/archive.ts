// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 沉淀归档 — the working → project half of the two motions charter §1.5 puts
 * across the layers ("沉淀归档" downward-to-upward, "检索唤醒" back down).
 *
 * A task ends, and its working memory has to stop existing as working memory:
 * charter §1.5 gives that layer a task-level lifetime and exactly two exits,
 * 沉淀 or 丢弃. This function performs both, and it performs them as *marks* —
 * every working entry it touches is still on disk afterwards, retired with a
 * kind and a reason, because "the task is over" is not a licence to destroy the
 * record of what happened during it.
 *
 * The dual time axis does the real work in the promotion step. A promoted entry
 * is a new record in the project table, so its ingest axis starts now:
 * `createdAt` is the moment project memory learned it. Its event axis is
 * inherited untouched: `validAt` still points at the moment the fact became
 * true, back during the task. Cite the promoted entry and you get an honest
 * write time for the project record *and* an honest age for the fact. With one
 * timestamp you would have to lie about one of them.
 */

import type { MemoryEntry } from './entry.js'
import { FileMemoryStore } from './store.js'

/** What to do with one live working entry when its task ends. */
export type ArchiveDecision = 'promote' | 'discard'

export type ArchiveOptions = {
  readonly projectKey: string
  readonly taskId: string
  /** Recorded as the actor on every retirement this run performs. */
  readonly by: string
  /**
   * Per-entry judgement. Defaults to promoting everything, which is the safe
   * default for a store that cannot delete: an over-promoted entry can still be
   * revoked later, whereas a discarded one has already left recall.
   */
  readonly decide?: (entry: MemoryEntry) => ArchiveDecision
}

export type ArchiveResult = {
  /** The new project-layer entries. */
  readonly promoted: readonly MemoryEntry[]
  /** The working entries sealed by promotion (`archived`). */
  readonly sealed: readonly MemoryEntry[]
  /** The working entries dropped without promotion (`revoked`). */
  readonly discarded: readonly MemoryEntry[]
}

export function archiveWorkingMemory(
  store: FileMemoryStore,
  options: ArchiveOptions,
): ArchiveResult {
  const live = store.query({
    layers: ['working'],
    projectKey: options.projectKey,
    taskId: options.taskId,
  })

  const promoted: MemoryEntry[] = []
  const sealed: MemoryEntry[] = []
  const discarded: MemoryEntry[] = []

  for (const entry of live) {
    const decision = options.decide?.(entry) ?? 'promote'
    if (decision === 'discard') {
      discarded.push(
        store.retire(entry.id, {
          kind: 'revoked',
          reason: `discarded at end of task ${options.taskId}`,
          by: options.by,
        }),
      )
      continue
    }

    const projectEntry = store.write({
      scope: { layer: 'project', projectKey: options.projectKey },
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      // Provenance is preserved, not replaced. AC-4 asks the agent to cite
      // where a decision came from; answering "the archiver" for every
      // sedimented memory would erase the session that actually produced it.
      source: entry.source,
      tags: entry.tags,
      // Event axis inherited: sedimentation moves the record, not the fact.
      validAt: new Date(entry.validAt),
      invalidAt: entry.invalidAt === null ? null : new Date(entry.invalidAt),
      derivedFrom: [entry.id],
    })
    promoted.push(projectEntry)

    // Sealed only after the project record exists. A crash between the two
    // leaves a duplicate in working memory, which the next run promotes again;
    // the opposite order would lose the content outright.
    sealed.push(
      store.retire(entry.id, {
        kind: 'archived',
        reason: `sedimented into project memory as ${projectEntry.id}`,
        by: options.by,
      }),
    )
  }

  return { promoted, sealed, discarded }
}
