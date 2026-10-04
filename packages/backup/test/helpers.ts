// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temporaries: string[] = []

/** A throwaway directory, removed by {@link cleanupTemporaries}. */
export function tempDir(prefix = 'qianmo-backup-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

export function cleanupTemporaries(): void {
  for (const dir of temporaries.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run a command and collect its output. */
export function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    child.on('error', error =>
      resolve({ code: null, stdout: '', stderr: error.message }),
    )
    child.on('close', code =>
      resolve({ code, stdout: stdout.join(''), stderr: stderr.join('') }),
    )
  })
}

/**
 * `git`, with identity and hooks pinned on the command line.
 *
 * `-c` rather than a repo config write: the test must not depend on whatever
 * the developer's global git config says, and must not write to it either.
 */
export function git(args: readonly string[], cwd: string): Promise<RunResult> {
  return run(
    'git',
    [
      '-c',
      'user.email=backup-test@qianmo.invalid',
      '-c',
      'user.name=Qianmo Backup Test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    cwd,
  )
}

/** A tokenful of obviously-fake secret, long enough for the length check. */
export const WRITE_TOKEN = 'backup-write-token-not-a-real-secret'
export const ARCHIVE_TOKEN = 'backup-archive-token-not-a-real-secret'
