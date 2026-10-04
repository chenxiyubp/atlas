// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two faces of the backup store, and the asymmetry between them.
 *
 * Charter AC-6 asks for a property that sounds like a permission setting and is
 * not one: an agent must be able to *create* backups and must not be able to
 * remove them. On a POSIX filesystem that combination does not exist — the
 * right to unlink a file comes from write permission on its **directory**, the
 * same bit that lets you create one. The sticky bit narrows it to "delete only
 * your own", which is exactly the case that matters here and therefore no help
 * at all.
 *
 * So the boundary is not a file mode. It is that the store lives on the other
 * side of a socket the sandbox can reach only through a surface with no verb
 * for removal — the same shape P2.5 gave the sandbox supervisor, and for the
 * same reason: a capability that cannot be named cannot be called by a
 * confused, compromised or merely creative agent.
 *
 * | face          | who holds it | verbs                        |
 * |---------------|--------------|------------------------------|
 * | {@link SnapshotWriter} | the sandbox | create, and nothing else |
 * | {@link SnapshotArchive} | the host  | list, read, restore      |
 *
 * There is no `delete` on either. Retention is a host-side decision M0 does not
 * make (charter N-12 keeps tuning out of M0); when it arrives it belongs to the
 * archive face, never to the writer's.
 */

/** Metadata every snapshot carries, written by the store rather than the agent. */
export interface SnapshotMeta {
  /** Store-assigned identifier. Monotonic in creation order. */
  readonly id: string
  /** Which workspace this is a copy of, as the writer named it. */
  readonly workspace: string
  /** Why it was taken — the two triggers roadmap P4.4 asks for. */
  readonly reason: SnapshotReason
  /** Epoch ms at which the store accepted it. */
  readonly createdAt: number
  /** Size of the stored archive in bytes. */
  readonly bytes: number
  /** sha-256 of the archive, hex. The store computes it; the writer cannot set it. */
  readonly sha256: string
  /** Free-form label from the caller, e.g. a task id. Never trusted for routing. */
  readonly label?: string
}

/** What prompted a snapshot. */
export type SnapshotReason = 'scheduled' | 'pre-task' | 'manual'

/** Everything the sandbox side may do: make one more snapshot. */
export interface SnapshotWriter {
  /**
   * Store `archive` as a new snapshot and return what the store recorded.
   *
   * Deliberately not `putIfAbsent`, not `replace`, not `upsert`: every call
   * creates a new object. An interface with no way to name an existing snapshot
   * is an interface with no way to overwrite one.
   */
  create(request: SnapshotRequest): Promise<SnapshotMeta>
}

/** One snapshot, on its way into the store. */
export interface SnapshotRequest {
  readonly workspace: string
  readonly reason: SnapshotReason
  readonly archive: Uint8Array
  readonly label?: string
}

/** The host side: read the snapshots back. */
export interface SnapshotArchive {
  list(workspace?: string): Promise<readonly SnapshotMeta[]>
  /** The stored bytes, or `null` when the id is unknown. */
  read(id: string): Promise<Uint8Array | null>
}

/** Everything worth writing down about the backup path. */
export enum BackupEventType {
  /** A snapshot was accepted and is on disk. */
  SnapshotCreated = 'backup.snapshot-created',
  /** A snapshot was read back for a restore. */
  SnapshotRead = 'backup.snapshot-read',
  /** A workspace was restored from a snapshot. */
  WorkspaceRestored = 'backup.workspace-restored',
  /**
   * Something asked the store to remove or overwrite a snapshot.
   *
   * AC-6(c) does not ask merely that this fail — it asks that it fail *and be
   * on the record*. A denial nobody can see tells an operator nothing was
   * attempted.
   */
  MutationDenied = 'backup.mutation-denied',
  /** A caller reached for a face its credential does not cover. */
  ReadDenied = 'backup.read-denied',
  /** A caller presented no credential, or one this service does not know. */
  AccessDenied = 'backup.access-denied',
}
