// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process'

/**
 * The one way this package runs `git`.
 *
 * Plumbing only, argument vectors only (no shell), and an environment that
 * cannot point git somewhere other than the repository the caller named. That
 * last part matters because `qm handoff sync` is started from other tools'
 * hooks: a parent that exported `GIT_DIR` or `GIT_INDEX_FILE` — any git hook
 * does — would otherwise silently redirect the shadow commit into a different
 * repository, or into the user's real index.
 */

/**
 * Variables that redirect repository discovery or the index. Stripped from
 * the inherited environment; callers that need one (the shadow index) pass it
 * explicitly through {@link GitRunOptions.env}.
 */
const REDIRECTING_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const

/** A `git` invocation that exited non-zero (or could not start). */
export class HandoffGitError extends Error {
  readonly args: readonly string[]
  /** `null` when the process could not be started at all. */
  readonly exitCode: number | null
  readonly stderr: string

  constructor(
    args: readonly string[],
    exitCode: number | null,
    stderr: string,
  ) {
    const detail = stderr.trim().split('\n').slice(-3).join(' | ')
    super(
      `git ${args[0] ?? ''} failed (exit ${String(exitCode)})${detail === '' ? '' : `: ${detail}`}`,
    )
    this.name = 'HandoffGitError'
    this.args = args
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

interface GitRunOptions {
  readonly cwd: string
  /** Added on top of the sanitised inherited environment. */
  readonly env?: Readonly<Record<string, string>>
  readonly input?: string | Buffer
  /**
   * Exit codes that are answers rather than failures (`rev-parse --verify -q`
   * exits 1 for "no such object"). The caller reads `exitCode` itself.
   */
  readonly okExitCodes?: readonly number[]
}

interface GitRunResult {
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: string
}

function gitEnvironment(
  extra: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of REDIRECTING_VARIABLES) delete env[name]
  return { ...env, ...extra }
}

/** Run `git <args>` in `options.cwd`; throws {@link HandoffGitError}. */
export function runGit(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: gitEnvironment(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', error =>
      reject(new HandoffGitError(args, null, error.message)),
    )
    child.on('close', code => {
      const result = {
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (
        code === 0 ||
        (code !== null && options.okExitCodes?.includes(code))
      ) {
        resolve(result)
      } else {
        reject(new HandoffGitError(args, code, result.stderr))
      }
    })
    // A child that exits before reading its input raises EPIPE here; the
    // exit code is the real verdict, so the write error is not.
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

/** `stdout` of a one-line answer, trailing newline removed. */
export async function gitLine(
  args: readonly string[],
  options: GitRunOptions,
): Promise<string> {
  const { stdout } = await runGit(args, options)
  return stdout.toString('utf8').trim()
}

/** Split `-z` output into its fields, dropping the trailing terminator. */
export function splitNul(output: Buffer): string[] {
  const text = output.toString('utf8')
  if (text === '') return []
  const fields = text.split('\0')
  if (fields.at(-1) === '') fields.pop()
  return fields
}
