// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { HandoffManifest, HandoffResult } from '../src/manifest.js'

const temporaries: string[] = []

/** A throwaway directory, removed by {@link cleanupTemporaries}. */
export function tempDir(prefix = 'qm-handoff-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

export function cleanupTemporaries(): void {
  for (const dir of temporaries.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Synchronous `git` for fixtures, with identity, signing and hooks pinned on
 * the command line so the developer's global config neither leaks in nor gets
 * written to. Throws on a non-zero exit.
 */
export function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Handoff Test',
      '-c',
      'user.email=handoff-test@qianmo.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} → ${proc.exitCode}: ${proc.stderr.toString()}`,
    )
  }
  return proc.stdout.toString().trim()
}

/**
 * A fresh repository on branch `main`, insulated from the global excludes
 * file (a developer's `~/.config/git/ignore` must not decide what a test
 * sees as untracked).
 */
export function initRepo(): string {
  const repo = tempDir('qm-handoff-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.excludesFile', join(repo, '.git', 'no-excludes'))
  git(repo, 'config', 'core.hooksPath', join(repo, '.git', 'hooks'))
  return repo
}

export function write(repo: string, path: string, content: string): void {
  const full = join(repo, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

export function commitAll(repo: string, message = 'fixture'): string {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '--no-verify', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

/** Paths in `tree`, recursively. */
export function treePaths(repo: string, tree: string): string[] {
  const out = git(repo, 'ls-tree', '-r', '-z', '--name-only', tree)
  return out === '' ? [] : out.split('\0').filter(path => path !== '')
}

export function blobAt(repo: string, rev: string, path: string): string {
  return git(repo, 'show', `${rev}:${path}`)
}

function hashWorkTree(repo: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (full === join(repo, '.git')) continue
        walk(full)
      } else {
        files[relative(repo, full)] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex')
      }
    }
  }
  walk(repo)
  return files
}

/**
 * Everything of the user's that a shadow commit promises not to touch:
 * the index file byte for byte, HEAD (symbolic and resolved), every ref, the
 * stash, and every work-tree file's content.
 */
export function userState(repo: string): Record<string, unknown> {
  const index = join(repo, '.git', 'index')
  const head = Bun.spawnSync(['git', 'rev-parse', '-q', '--verify', 'HEAD'], {
    cwd: repo,
  })
  return {
    index: existsSync(index)
      ? createHash('sha256').update(readFileSync(index)).digest('hex')
      : null,
    headFile: readFileSync(join(repo, '.git', 'HEAD'), 'utf8'),
    head: head.stdout.toString().trim(),
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    stash: git(repo, 'stash', 'list'),
    files: hashWorkTree(repo),
  }
}

/** Shaped like a GitHub PAT, assembled at runtime; not a real secret. */
export const FAKE_GITHUB_PAT = `ghp_${'a1B2'.repeat(9)}`

/** A valid manifest for ledger fixtures. */
export function sampleManifest(): HandoffManifest {
  const session = '0199a3b2-7c1d-7e2f-9a3b-4c5d6e7f8a9b'
  return {
    kind: 'handoff',
    project: 'atlas',
    device: 'cornna-mbp',
    branch: 'main',
    wip: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    tool: 'claude-code',
    sessionId: session,
    sessionRef: `refs/qianmo/sessions/cornna-mbp/${session}`,
    sessionCommit: 'c'.repeat(40),
    cwd: '/Users/cornna/project/atlas',
    brief: { goal: '续跑测试', done: '', remaining: '全部' },
    deadline: '2026-11-20T02:00:00Z',
  }
}

/** A valid `task.result` content object for `taskId`. */
export function sampleResult(taskId: string): HandoffResult {
  return {
    status: 'completed',
    branch: `qianmo/${taskId}`,
    head: 'd'.repeat(40),
    threadId: '0199a3b2-7c1d-7e2f-9a3b-4c5d6e7f8a9b',
    summary: 'done',
  }
}
