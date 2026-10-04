// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { basename } from 'node:path'
import { runGit } from './git.js'
import { isSha } from './manifest.js'
import { handoffIdentityEnv } from './shadow.js'

/**
 * A session transcript as a commit: one blob, a tree holding just that blob,
 * and a commit whose parent is the previous sync of the same session — so
 * `refs/qianmo/sessions/<device>/<id>` is a history of the transcript and the
 * landing check is a commit-hash comparison (design v1.1 §5).
 *
 * Plumbing only (`hash-object -w` → `mktree` → `commit-tree`); objects are
 * written into the repository at `cwd` and no ref is touched. The caller
 * pushes `<commit>:<sessionRef>`.
 *
 * The file is hashed byte for byte (`--no-filters`): a transcript lives
 * outside the work tree and must not pick up the project's
 * `.gitattributes` conversions on the way in.
 */

export interface SessionCommitOptions {
  /** Any directory inside the repository the objects go into. */
  readonly cwd: string
  /**
   * The transcript file (qmcode rollout JSONL or Claude Code JSONL). A
   * relative path is resolved against `cwd`.
   */
  readonly file: string
  /** Entry name inside the tree; defaults to the file's base name. */
  readonly name?: string
  /** The previous session commit, if this session was synced before. */
  readonly parent?: string
  readonly message?: string
}

export interface SessionCommit {
  readonly commit: string
  readonly tree: string
  readonly blob: string
  /** The single entry name in `tree`. */
  readonly name: string
}

/** Same bound git puts on a path component on every platform it supports. */
const MAX_NAME_BYTES = 255

function assertEntryName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.toLowerCase() === '.git' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.includes('\n') ||
    Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES
  ) {
    throw new TypeError(`unusable session entry name: ${JSON.stringify(name)}`)
  }
}

/** Write `file` as a single-file tree and commit it. Returns the commit. */
export async function sessionCommit(
  options: SessionCommitOptions,
): Promise<SessionCommit> {
  const name = options.name ?? basename(options.file)
  assertEntryName(name)
  if (options.parent !== undefined && !isSha(options.parent)) {
    throw new TypeError(`parent is not a full object id: ${options.parent}`)
  }
  const git = (args: readonly string[], input?: string) =>
    runGit(args, {
      cwd: options.cwd,
      env: handoffIdentityEnv(),
      ...(input === undefined ? {} : { input }),
    }).then(result => result.stdout.toString('utf8').trim())

  const blob = await git([
    'hash-object',
    '-w',
    '--no-filters',
    '--',
    options.file,
  ])
  // NUL-terminated, so no name is ever read as a C-quoted string.
  const tree = await git(['mktree', '-z'], `100644 blob ${blob}\t${name}\0`)
  const commit = await git([
    'commit-tree',
    '--no-gpg-sign',
    ...(options.parent === undefined ? [] : ['-p', options.parent]),
    '-m',
    options.message ?? `qianmo handoff: session ${name}`,
    tree,
  ])
  return { commit, tree, blob, name }
}
