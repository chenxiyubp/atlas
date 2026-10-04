// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/backup` — workspace snapshots an agent can make but cannot reach
 * (P4.4, charter AC-6(b)(c)).
 *
 * The whole package exists to hold one asymmetry that a filesystem cannot
 * express: **create yes, remove no**. On POSIX the right to unlink a file comes
 * from write permission on its directory — the same bit that lets you create
 * one — so "the agent may add backups but not delete them" is not a mode you
 * can chmod. It is a boundary you have to put a process behind.
 *
 * So: the store lives on the host (`store.ts`), the sandbox reaches it only
 * through an allowlisted socket surface with no removal verb (`service.ts`),
 * snapshots are taken on a period and before each task (`schedule.ts`), and a
 * restore puts a deleted workspace back into an empty directory after checking
 * the archive against the digest recorded when it was stored (`restore.ts`).
 *
 * **Not** used: the sandbox platform's own archive feature. Charter §3.2 R-4
 * settled that — its archive *moves* the object rather than copying it, so the
 * source is gone once a restore succeeds and there is never a second copy.
 * That is zero coverage for AC-6(b), which is a question about surviving a
 * deletion.
 */

export {
  archiveDirectory,
  digestOf,
  restoreArchive,
  tarAvailable,
} from './archive.js'

export {
  BackupEventType,
  type SnapshotArchive,
  type SnapshotMeta,
  type SnapshotReason,
  type SnapshotRequest,
  type SnapshotWriter,
} from './contracts.js'

export {
  restoreWorkspace,
  type RestoreOutcome,
  type RestoreRequest,
} from './restore.js'

export {
  BackupScheduler,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  timerScheduler,
  type BackupSchedulerOptions,
  type CancelTimer,
  type Scheduler,
} from './schedule.js'

export {
  ALLOWED_METHODS,
  BACKUP_SURFACE,
  BackupOp,
  DESTRUCTIVE_WORDS,
  assertBackupSurfaceIsSafe,
  remoteSnapshotWriter,
  startBackupService,
  type BackupAudience,
  type BackupRoute,
  type BackupServiceHandle,
  type BackupServiceOptions,
  type RemoteWriterOptions,
} from './service.js'

export {
  BackupAuditLog,
  DEFAULT_MAX_ARCHIVE_BYTES,
  FileSnapshotStore,
  isSnapshotId,
  type BackupAuditEvent,
  type BackupAuditSink,
  type FileSnapshotStoreOptions,
} from './store.js'
