// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turning a workspace into bytes, and bytes back into a workspace.
 *
 * ## Why `tar` and not a hand-rolled walker
 *
 * AC-6(b)'s judgement is `git status` matching what it said before the deletion.
 * That makes the archive format's job larger than "the file contents came
 * back": it has to preserve the executable bit (git tracks mode 100755 and will
 * report a modification if it changes), symlinks (git stores them as links, not
 * as their targets), and empty-but-present directories inside `.git`. A walker
 * written for this file would be a re-implementation of tar with those three
 * bugs still to be found. `tar` is POSIX, ships on both the acceptance host and
 * every developer machine here, and has had forty years to get them right.
 *
 * The cost is an external process and therefore a real dependency, so it is
 * checked rather than assumed: {@link tarAvailable} exists so a caller can fail
 * with "tar is not installed" instead of with a confusing exit code.
 *
 * ## What is deliberately *not* here
 *
 * No compression tuning, no incremental snapshots, no deduplication. Charter
 * N-12 keeps optimization out of M0, and each of those trades a simple property
 * ("the archive is one self-contained object") for speed nobody has measured a
 * need for yet.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Result of running one archive command. */
interface CommandResult {
  readonly ok: boolean
  readonly stdout: Uint8Array
  readonly stderr: string
  readonly code: number | null
}

function run(
  command: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    child.on('error', error => {
      resolve({
        ok: false,
        stdout: new Uint8Array(),
        stderr: error.message,
        code: null,
      })
    })
    child.on('close', code => {
      resolve({
        ok: code === 0,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: stderr.join(''),
        code,
      })
    })
    if (input !== undefined && child.stdin !== null) {
      child.stdin.end(Buffer.from(input))
    }
  })
}

/** True when `tar` can be executed at all. */
export async function tarAvailable(): Promise<boolean> {
  const result = await run('tar', ['--version'])
  return result.ok
}

/**
 * Archive `directory` into a gzipped tar, contents only — no leading path.
 *
 * `-C <dir> .` rather than archiving the parent: a snapshot that carries the
 * absolute path it came from can only be restored to that same path, and the
 * restore in AC-6(b) happens after the directory has been deleted, possibly
 * into a fresh one.
 */
export async function archiveDirectory(directory: string): Promise<Uint8Array> {
  const result = await run('tar', ['-czf', '-', '-C', directory, '.'])
  if (!result.ok) {
    throw new Error(
      `tar failed to archive ${directory} (exit ${String(result.code)}): ${result.stderr.trim()}`,
    )
  }
  return result.stdout
}

/** Unpack an archive into `directory`, which must already exist. */
export async function restoreArchive(
  archive: Uint8Array,
  directory: string,
): Promise<void> {
  const result = await run('tar', ['-xzf', '-', '-C', directory], archive)
  if (!result.ok) {
    throw new Error(
      `tar failed to restore into ${directory} (exit ${String(result.code)}): ${result.stderr.trim()}`,
    )
  }
}

/** sha-256 of an archive, hex — the store's own record of what it holds. */
export function digestOf(archive: Uint8Array): string {
  return createHash('sha256').update(archive).digest('hex')
}
