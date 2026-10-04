// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { statSync } from 'node:fs'

/**
 * The global emergency stop sentinel (design §3.B6, hermes B5).
 *
 * One file, and its **existence is the entire test**. Create it and the node
 * stops taking new work; delete it and the node resumes. Nothing is parsed,
 * so nothing about the contents can make the answer wrong.
 *
 * ## What this mechanism deliberately does not do
 *
 * - **It never kills anything in flight.** ESTOP is pause-new-work, not
 *   abort-running-work: a turn that has already been admitted has a `task.result`
 *   owed to a peer, and killing it converts a slow answer into a lost one. An
 *   operator who needs the running turn gone has `stop()` and a signal.
 * - **It never reads the file to decide.** Empty, truncated, binary, a
 *   half-written JSON body — all of them are still an engaged stop. Reading
 *   would introduce a way for the sentinel to *fail open* on a file the
 *   operator did create, and the one direction this check must not fail in is
 *   "the operator hit the brake and the node kept going".
 * - **It never clears itself on startup.** A pause is meant to survive a
 *   restart; that is most of why it is a file. Note the contrast with drain-type
 *   markers, which hermes NS-570 says *must* carry an instance epoch so a
 *   restart voids them — an orphaned drain flag refused service for 52 minutes.
 *   ESTOP is the opposite case on purpose, and the difference is the point:
 *   "paused until a human says otherwise" vs "draining this instance".
 * - **It is not authorization.** Anyone who can write the file can pause the
 *   node. That is the same trust boundary as the config directory it lives in.
 *
 * ## Fail-open, and where the line is
 *
 * Roadmap P13.5 requires the reliability kit to fail **open**: its own faults
 * must never stop the node. That applies to `stat` *failing* — EACCES, EIO, a
 * directory that vanished — and those are reported and read as "not engaged".
 * It does not apply to `stat` *succeeding* on a file with unusable contents,
 * which is the fail-safe half above. The two rules do not overlap: one is about
 * the syscall erroring, the other about the bytes behind it.
 */
export interface ResidentEstopStatus {
  readonly engaged: boolean
  /**
   * When the brake was pulled, best-effort and **display only**.
   *
   * Taken from the file's mtime rather than its contents, so it is available
   * for the empty file too. Never consulted by {@link ResidentEstop.engaged}.
   */
  readonly engagedAt?: number
}

export interface ResidentEstopOptions {
  readonly path: string
  /**
   * Where a failed `stat` is reported. The failure is swallowed either way —
   * this is the record of it, not a chance to veto.
   */
  readonly onError?: (error: unknown) => void
}

export class ResidentEstop {
  readonly #path: string
  readonly #onError: ((error: unknown) => void) | undefined

  constructor(options: ResidentEstopOptions) {
    if (options.path.trim() === '') {
      throw new Error('resident ESTOP path must not be empty')
    }
    this.#path = options.path
    this.#onError = options.onError
  }

  get path(): string {
    return this.#path
  }

  /** One `stat`. See the class comment for why nothing is read. */
  engaged(): boolean {
    return this.status().engaged
  }

  status(): ResidentEstopStatus {
    try {
      const stats = statSync(this.#path)
      return { engaged: true, engagedAt: Math.floor(stats.mtimeMs) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { engaged: false }
      }
      // Fail-open: a sentinel that cannot be read must not be able to stop a
      // node that is otherwise healthy.
      this.#onError?.(error)
      return { engaged: false }
    }
  }
}
