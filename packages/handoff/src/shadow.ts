// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type SecretMatch,
  scanForSecrets,
} from '@open-claude-code/tool-runtime/secretScanner.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandoffGitError, gitLine, runGit, splitNul } from './git.js'

/**
 * Shadow commits: the user's work tree as a commit, taken without touching
 * the user's HEAD, index, stash, refs or files.
 *
 * Everything runs against a private index (`GIT_INDEX_FILE` in a temporary
 * directory that is removed afterwards) and plumbing commands only:
 *
 * 1. `read-tree <HEAD>` into the private index — the empty tree when HEAD is
 *    unborn;
 * 2. `add -A -- . ':(exclude…)'` — tracked, modified and untracked-but-not-
 *    ignored files, minus {@link SECRET_PATH_PATTERNS};
 * 3. every file that differs from HEAD is read back **from the object just
 *    written** (not from disk, which may have changed since) and run through
 *    `scanForSecrets`; one hit aborts with the file and rule ids;
 * 4. `write-tree`, then `commit-tree -p <HEAD>` with a fixed identity.
 *
 * The only thing written into the repository is objects. No ref is created —
 * the caller pushes `<sha>:refs/qianmo/wip/…` straight from the object id.
 *
 * Hooks: plumbing runs no commit hooks, but writing an index runs
 * `post-index-change` and refreshing one consults `core.fsmonitor`. Both are
 * switched off with `-c` for every command here (an empty directory as
 * `core.hooksPath`), so a user's hook never sees a shadow index.
 */

/**
 * Author and committer of every shadow and session commit, passed as
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` so neither the user's git config nor its
 * absence (`user.useConfigOnly`) has a say.
 */
export const HANDOFF_GIT_IDENTITY = {
  name: 'Qianmo Handoff',
  email: 'handoff@qianmo.invalid',
} as const

/**
 * File-name patterns that are never put into a shadow commit, at any depth,
 * case-insensitively — on top of `.gitignore`.
 *
 * Deliberately narrower than "anything that looks like a key": a pattern here
 * silently drops a file from what the cloud sees, so each one names a file
 * that is a credential by convention, not by guess. In particular this is
 * `id_rsa*`/`id_ed25519*`… and not `id_*`, which would also take
 * `id_generator.ts`. Content that merely contains a secret is the scanner's
 * job, and the scanner refuses instead of dropping.
 *
 * A **tracked** file matching a pattern keeps its HEAD content in the shadow
 * (it is already in history; the shadow neither re-uploads its current
 * contents nor pretends it was deleted).
 */
export const SECRET_PATH_PATTERNS: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  '*.tfstate',
  '*.tfstate.*',
]

/**
 * A changed file bigger than this aborts the shadow commit instead of being
 * scanned or carried. Refusing is the simple safe answer: dropping it would
 * hand the cloud a tree that silently lacks a file, and carrying it unscanned
 * would be the one gap in the secret check. The user's fix is `.gitignore`.
 */
export const MAX_CHANGED_FILE_BYTES = 10 * 1024 * 1024

/** Bytes read back from git per `cat-file --batch` call while scanning. */
const SCAN_CHUNK_BYTES = 32 * 1024 * 1024

const GITLINK_MODE = '160000'

export interface SecretFinding {
  readonly path: string
  readonly matches: readonly SecretMatch[]
}

/** The scan found something; nothing was committed. */
export class SecretFoundError extends Error {
  readonly findings: readonly SecretFinding[]

  constructor(findings: readonly SecretFinding[]) {
    const listed = findings
      .map(f => `${f.path} (${f.matches.map(m => m.ruleId).join(', ')})`)
      .join('; ')
    super(`possible secrets in changed files, shadow commit refused: ${listed}`)
    this.name = 'SecretFoundError'
    this.findings = findings
  }
}

/** Changed files over {@link MAX_CHANGED_FILE_BYTES}; nothing was committed. */
export class OversizedFileError extends Error {
  readonly files: readonly { readonly path: string; readonly bytes: number }[]

  constructor(
    files: readonly { readonly path: string; readonly bytes: number }[],
    limit: number,
  ) {
    super(
      `changed files over ${limit} bytes, shadow commit refused: ${files
        .map(f => `${f.path} (${f.bytes})`)
        .join('; ')}`,
    )
    this.name = 'OversizedFileError'
    this.files = files
  }
}

export interface ShadowOptions {
  /** Any directory inside the work tree. */
  readonly cwd: string
}

export interface ShadowCommitOptions extends ShadowOptions {
  readonly message?: string
  /** Defaults to {@link MAX_CHANGED_FILE_BYTES}. */
  readonly maxFileBytes?: number
}

export interface ShadowTree {
  /** Work-tree top level. */
  readonly root: string
  /** HEAD commit, or `null` when the branch is unborn. */
  readonly head: string | null
  /** Current branch (short name), or `null` when HEAD is detached. */
  readonly branch: string | null
  /** Tree of the work tree as a shadow commit would record it. */
  readonly tree: string
  /**
   * Untracked, not-ignored paths left out by {@link SECRET_PATH_PATTERNS} —
   * what the cloud will not see. Worth showing to the user.
   */
  readonly excluded: readonly string[]
}

export interface ShadowCommit extends ShadowTree {
  readonly commit: string
  /** Paths that differ from HEAD (added, modified, type-changed). */
  readonly changed: readonly string[]
  /**
   * Changed submodule pointers. Only the pointer is carried; the submodule's
   * own uncommitted work is not.
   */
  readonly submodules: readonly string[]
}

/** Pathspecs selecting {@link SECRET_PATH_PATTERNS} at any depth. */
function secretPathspecs(exclude: boolean): string[] {
  const magic = exclude ? 'exclude,glob,icase' : 'glob,icase'
  return SECRET_PATH_PATTERNS.map(pattern => `:(${magic})**/${pattern}`)
}

interface ShadowIndex {
  readonly root: string
  readonly head: string | null
  readonly branch: string | null
  readonly excluded: readonly string[]
  /** Tree to diff against: HEAD, or the empty tree. */
  readonly base: string
  readonly git: (
    args: readonly string[],
    extra?: { readonly input?: string; readonly env?: Record<string, string> },
  ) => ReturnType<typeof runGit>
}

/**
 * Build the private index and hand it to `use`; the temporary directory is
 * removed whatever `use` does.
 */
async function withShadowIndex<T>(
  cwd: string,
  use: (index: ShadowIndex) => Promise<T>,
): Promise<T> {
  const root = await gitLine(['rev-parse', '--show-toplevel'], { cwd })
  if (root === '') {
    throw new HandoffGitError(['rev-parse'], 0, 'not inside a work tree')
  }
  const sparse = await runGit(
    ['config', '--type=bool', '--get', 'core.sparseCheckout'],
    { cwd: root, okExitCodes: [1] },
  )
  if (sparse.stdout.toString('utf8').trim() === 'true') {
    // A HEAD tree read into a fresh index has no skip-worktree bits, so every
    // file outside the sparse cone would be recorded as deleted.
    throw new HandoffGitError(
      ['config'],
      0,
      'sparse checkout is not supported by shadow commits',
    )
  }

  const scratch = mkdtempSync(join(tmpdir(), 'qianmo-handoff-'))
  try {
    const hooks = join(scratch, 'hooks')
    mkdirSync(hooks)
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }
    const prefix = [
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'core.fsmonitor=false',
    ]
    const git: ShadowIndex['git'] = (args, extra = {}) =>
      runGit([...prefix, ...args], {
        cwd: root,
        env: { ...env, ...extra.env },
        ...(extra.input === undefined ? {} : { input: extra.input }),
      })

    // Exit 1 with no output is the unborn branch.
    const headProbe = await runGit(
      ['rev-parse', '-q', '--verify', 'HEAD^{commit}'],
      { cwd: root, okExitCodes: [1] },
    )
    const headSha = headProbe.stdout.toString('utf8').trim()
    const head = headProbe.exitCode === 0 && headSha !== '' ? headSha : null
    const branchProbe = await runGit(
      ['symbolic-ref', '-q', '--short', 'HEAD'],
      {
        cwd: root,
        okExitCodes: [1],
      },
    )
    const branchName = branchProbe.stdout.toString('utf8').trim()
    const branch =
      branchProbe.exitCode === 0 && branchName !== '' ? branchName : null

    let base: string
    if (head === null) {
      await git(['read-tree', '--empty'])
      base = (await git(['write-tree'])).stdout.toString('utf8').trim()
    } else {
      // The resolved id, not the name `HEAD`: a commit landing mid-way must
      // not make the tree and the parent disagree.
      await git(['read-tree', head])
      base = head
    }

    const excluded = splitNul(
      (
        await git([
          'ls-files',
          '-z',
          '--others',
          '--exclude-standard',
          '--',
          ...secretPathspecs(false),
        ])
      ).stdout,
    )
    await git(['add', '-A', '--', '.', ...secretPathspecs(true)])

    return await use({ root, head, branch, excluded, base, git })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The tree a shadow commit of the work tree would have, without committing
 * and without scanning — for `qm handoff now` to compare against the tree of
 * the shadow commit the hub holds (AC-H1).
 */
export async function shadowTree(options: ShadowOptions): Promise<ShadowTree> {
  return withShadowIndex(options.cwd, async index => {
    const tree = (await index.git(['write-tree'])).stdout
      .toString('utf8')
      .trim()
    return {
      root: index.root,
      head: index.head,
      branch: index.branch,
      tree,
      excluded: index.excluded,
    }
  })
}

interface ChangedEntry {
  readonly path: string
  readonly mode: string
  readonly sha: string
}

/** `diff-index --cached --raw -z` → added / modified / type-changed entries. */
async function changedEntries(index: ShadowIndex): Promise<ChangedEntry[]> {
  const fields = splitNul(
    (
      await index.git([
        'diff-index',
        '--cached',
        '--raw',
        '-z',
        '--no-renames',
        '--diff-filter=d',
        index.base,
      ])
    ).stdout,
  )
  const entries: ChangedEntry[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // ":<old mode> <new mode> <old sha> <new sha> <status>", then the path.
    const meta = (fields[i] ?? '').slice(1).split(' ')
    entries.push({
      path: fields[i + 1] ?? '',
      mode: meta[1] ?? '',
      sha: meta[3] ?? '',
    })
  }
  return entries
}

/** Object sizes for `shas`, via one `cat-file --batch-check`. */
async function objectSizes(
  index: ShadowIndex,
  shas: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  if (shas.length === 0) return sizes
  const output = await index.git(
    ['cat-file', '--batch-check=%(objectname) %(objectsize)'],
    { input: `${shas.join('\n')}\n` },
  )
  for (const line of output.stdout.toString('utf8').split('\n')) {
    const [sha, size] = line.split(' ')
    const bytes = Number(size)
    if (sha !== undefined && Number.isSafeInteger(bytes)) sizes.set(sha, bytes)
  }
  assertComplete(shas, sizes, 'cat-file --batch-check')
  return sizes
}

/**
 * Fail closed when git did not answer for every object: a blob the scan never
 * saw must not be committed as if it had passed.
 */
function assertComplete(
  shas: readonly string[],
  answered: ReadonlyMap<string, unknown>,
  what: string,
): void {
  const missing = shas.filter(sha => !answered.has(sha))
  if (missing.length > 0) {
    throw new HandoffGitError(
      what.split(' '),
      0,
      `no answer for ${missing.length} object(s), first ${missing[0]}`,
    )
  }
}

/** Blob contents for `shas`, via one `cat-file --batch`. */
async function readBlobs(
  index: ShadowIndex,
  shas: readonly string[],
): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>()
  if (shas.length === 0) return blobs
  const { stdout } = await index.git(['cat-file', '--batch'], {
    input: `${shas.join('\n')}\n`,
  })
  let offset = 0
  while (offset < stdout.length) {
    const newline = stdout.indexOf(0x0a, offset)
    if (newline === -1) break
    // "<sha> <type> <size>\n<content>\n"
    const [sha, , size] = stdout.toString('utf8', offset, newline).split(' ')
    const length = Number(size)
    if (sha === undefined || !Number.isSafeInteger(length)) break
    blobs.set(sha, stdout.subarray(newline + 1, newline + 1 + length))
    offset = newline + 1 + length + 1
  }
  assertComplete(shas, blobs, 'cat-file --batch')
  return blobs
}

/** Scan every changed blob; throws before anything is committed. */
async function scanChanged(
  index: ShadowIndex,
  entries: readonly ChangedEntry[],
  maxFileBytes: number,
): Promise<void> {
  const files = entries.filter(entry => entry.mode !== GITLINK_MODE)
  const unique = [...new Set(files.map(entry => entry.sha))]
  const sizes = await objectSizes(index, unique)

  const oversized = files
    .map(entry => ({ path: entry.path, bytes: sizes.get(entry.sha) ?? 0 }))
    .filter(file => file.bytes > maxFileBytes)
  if (oversized.length > 0)
    throw new OversizedFileError(oversized, maxFileBytes)

  const hits = new Map<string, SecretMatch[]>()
  let chunk: string[] = []
  let chunkBytes = 0
  const flush = async (): Promise<void> => {
    const blobs = await readBlobs(index, chunk)
    for (const [sha, content] of blobs) {
      const matches = scanForSecrets(content.toString('utf8'))
      if (matches.length > 0) hits.set(sha, matches)
    }
    chunk = []
    chunkBytes = 0
  }
  for (const sha of unique) {
    const size = sizes.get(sha) ?? 0
    if (chunk.length > 0 && chunkBytes + size > SCAN_CHUNK_BYTES) await flush()
    chunk.push(sha)
    chunkBytes += size
  }
  if (chunk.length > 0) await flush()

  const findings = files.flatMap(entry => {
    const matches = hits.get(entry.sha)
    return matches === undefined ? [] : [{ path: entry.path, matches }]
  })
  if (findings.length > 0) throw new SecretFoundError(findings)
}

/** Identity environment for `commit-tree`. */
export function handoffIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: HANDOFF_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: HANDOFF_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: HANDOFF_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: HANDOFF_GIT_IDENTITY.email,
  }
}

/**
 * Take a shadow commit of the work tree. Throws {@link SecretFoundError} or
 * {@link OversizedFileError} before committing anything.
 */
export async function shadowCommit(
  options: ShadowCommitOptions,
): Promise<ShadowCommit> {
  const maxFileBytes = options.maxFileBytes ?? MAX_CHANGED_FILE_BYTES
  return withShadowIndex(options.cwd, async index => {
    const entries = await changedEntries(index)
    await scanChanged(index, entries, maxFileBytes)
    const tree = (await index.git(['write-tree'])).stdout
      .toString('utf8')
      .trim()
    const message =
      options.message ??
      `qianmo handoff: shadow of ${index.branch ?? index.head ?? 'unborn HEAD'}`
    const commit = (
      await index.git(
        [
          'commit-tree',
          '--no-gpg-sign',
          ...(index.head === null ? [] : ['-p', index.head]),
          '-m',
          message,
          tree,
        ],
        { env: handoffIdentityEnv() },
      )
    ).stdout
      .toString('utf8')
      .trim()
    return {
      root: index.root,
      head: index.head,
      branch: index.branch,
      tree,
      excluded: index.excluded,
      commit,
      changed: entries.map(entry => entry.path),
      submodules: entries
        .filter(entry => entry.mode === GITLINK_MODE)
        .map(entry => entry.path),
    }
  })
}
