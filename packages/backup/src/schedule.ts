// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When snapshots are taken: on a period, and before a task starts.
 *
 * Roadmap P4.4 asks for exactly those two triggers, and they answer different
 * questions. The periodic one bounds how much work a deletion can cost in the
 * general case; the pre-task one bounds it in the case that actually worries
 * us, which is an agent about to run something it wrote itself.
 *
 * ## Rescheduled from completion, not on an interval
 *
 * `setInterval` does not replay missed ticks (E4), so an interval-driven
 * snapshot silently loses every beat it slept through — and a frozen node is
 * precisely where "we have not taken a backup in a while" is easy to miss.
 * Rescheduling from the end of each snapshot keeps the *gap* bounded, which is
 * the property that matters, and it also stops two slow snapshots from
 * overlapping.
 *
 * ## A failed snapshot is loud but not fatal
 *
 * A backup that cannot be written is a real problem, and the caller hears about
 * it through `onError`. It is not, however, a reason to stop the node: refusing
 * to work because the backup service is down converts a recoverable outage into
 * an outright one. The failure is reported, the schedule continues, and the
 * next attempt is one period away.
 */

import { archiveDirectory } from './archive.js'
import type { SnapshotMeta, SnapshotWriter } from './contracts.js'

/** Cancels a pending timer. Idempotent. */
export type CancelTimer = () => void

export interface Scheduler {
  after(delayMs: number, callback: () => void): CancelTimer
}

/** `setTimeout`-backed scheduler that never holds the event loop open. */
export const timerScheduler: Scheduler = {
  after(delayMs, callback) {
    const handle = setTimeout(callback, Math.max(0, delayMs))
    handle.unref?.()
    return () => clearTimeout(handle)
  },
}

export interface BackupSchedulerOptions {
  /** Absolute path of the workspace being protected. */
  readonly workspace: string
  readonly writer: SnapshotWriter
  /** Gap between the end of one snapshot and the start of the next. */
  readonly intervalMs?: number
  readonly scheduler?: Scheduler
  /** Injected so a test does not have to shell out to `tar`. */
  readonly archive?: (directory: string) => Promise<Uint8Array>
  readonly onSnapshot?: (meta: SnapshotMeta) => void
  readonly onError?: (error: unknown) => void
}

/** Default gap between scheduled snapshots: 15 minutes. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 15 * 60_000

/** Takes snapshots on a period, and on demand before a task. */
export class BackupScheduler {
  readonly #options: BackupSchedulerOptions
  readonly #scheduler: Scheduler
  readonly #archive: (directory: string) => Promise<Uint8Array>
  readonly #intervalMs: number
  #cancel: CancelTimer | null = null
  #running = false
  #inFlight: Promise<SnapshotMeta | null> | null = null

  constructor(options: BackupSchedulerOptions) {
    this.#options = options
    this.#scheduler = options.scheduler ?? timerScheduler
    this.#archive = options.archive ?? archiveDirectory
    this.#intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS
  }

  get running(): boolean {
    return this.#running
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#arm()
  }

  stop(): void {
    this.#running = false
    this.#cancel?.()
    this.#cancel = null
  }

  /**
   * Snapshot now, because a task is about to start.
   *
   * Returns the metadata so a caller can put the snapshot id on the task's own
   * record — "restore to the state this task began from" is only answerable if
   * something wrote down which snapshot that was.
   */
  async beforeTask(taskId: string): Promise<SnapshotMeta | null> {
    return await this.#snapshot('pre-task', taskId)
  }

  /** Snapshot now, on an operator's say-so. */
  async once(label?: string): Promise<SnapshotMeta | null> {
    return await this.#snapshot('manual', label)
  }

  #arm(): void {
    if (!this.#running) return
    this.#cancel = this.#scheduler.after(this.#intervalMs, () => {
      void this.#snapshot('scheduled').finally(() => {
        this.#arm()
      })
    })
  }

  async #snapshot(
    reason: 'scheduled' | 'pre-task' | 'manual',
    label?: string,
  ): Promise<SnapshotMeta | null> {
    // One at a time: a workspace being archived while a previous archive of the
    // same workspace is still running is a good way to store two half-states.
    if (this.#inFlight !== null) return await this.#inFlight
    const attempt = (async (): Promise<SnapshotMeta | null> => {
      try {
        const archive = await this.#archive(this.#options.workspace)
        const meta = await this.#options.writer.create({
          workspace: this.#options.workspace,
          reason,
          archive,
          ...(label === undefined ? {} : { label }),
        })
        this.#options.onSnapshot?.(meta)
        return meta
      } catch (error) {
        this.#options.onError?.(error)
        return null
      }
    })()
    this.#inFlight = attempt
    try {
      return await attempt
    } finally {
      this.#inFlight = null
    }
  }
}
