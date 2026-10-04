// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Putting a workspace back.
 *
 * AC-6(b) is not "the files exist again" — it is `git status` reporting what it
 * reported before the deletion, within ten minutes. Two consequences shape this
 * file:
 *
 * - **Restore into an empty directory.** Unpacking over a partially surviving
 *   tree leaves whatever the deletion missed, and `git status` would then
 *   report the union of two states. So the target is created if absent and
 *   required to be empty otherwise; a caller that wants to overwrite says so by
 *   emptying it first, deliberately.
 * - **Verify the bytes before trusting them.** The archive's digest is checked
 *   against what the store recorded at creation. A restore from a corrupted
 *   archive that half-succeeds is worse than a restore that refuses: the first
 *   looks like a recovered workspace.
 */

import { mkdir, readdir } from 'node:fs/promises'
import { digestOf, restoreArchive } from './archive.js'
import { BackupEventType, type SnapshotMeta } from './contracts.js'
import type { BackupAuditLog } from './store.js'

export interface RestoreRequest {
  /** Where the workspace goes. Created when missing; must be empty otherwise. */
  readonly directory: string
  readonly archive: Uint8Array
  /** What the store recorded when it accepted the archive. */
  readonly meta: SnapshotMeta
  readonly audit?: BackupAuditLog
  readonly now?: () => number
}

export interface RestoreOutcome {
  readonly id: string
  readonly directory: string
  /** Wall-clock milliseconds the restore took — AC-6(b)'s budget is 10 min. */
  readonly elapsedMs: number
}

/** Unpack one snapshot into a directory, or refuse and explain. */
export async function restoreWorkspace(
  request: RestoreRequest,
): Promise<RestoreOutcome> {
  const now = request.now ?? Date.now
  const startedAt = now()

  const digest = digestOf(request.archive)
  if (digest !== request.meta.sha256) {
    throw new Error(
      `snapshot ${request.meta.id} does not match its recorded digest; refusing to restore`,
    )
  }

  await mkdir(request.directory, { recursive: true, mode: 0o700 })
  const existing = await readdir(request.directory)
  if (existing.length > 0) {
    throw new Error(
      `refusing to restore into ${request.directory}: it still holds ${existing.length} entries`,
    )
  }

  await restoreArchive(request.archive, request.directory)
  const finishedAt = now()
  request.audit?.record(BackupEventType.WorkspaceRestored, finishedAt, {
    id: request.meta.id,
    workspace: request.meta.workspace,
    directory: request.directory,
    elapsedMs: finishedAt - startedAt,
  })
  return {
    id: request.meta.id,
    directory: request.directory,
    elapsedMs: finishedAt - startedAt,
  }
}
