// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HANDOFF_GIT_IDENTITY,
  OversizedFileError,
  SecretFoundError,
  shadowCommit,
  shadowTree,
} from '../src/shadow.js'
import {
  FAKE_GITHUB_PAT,
  blobAt,
  cleanupTemporaries,
  commitAll,
  git,
  initRepo,
  treePaths,
  userState,
  write,
} from './helpers.js'

afterAll(cleanupTemporaries)

/** A repository with history, staged-but-uncommitted work and a stash. */
function busyRepo(): string {
  const repo = initRepo()
  write(repo, '.gitignore', 'build/\n*.log\n')
  write(repo, 'src/a.ts', 'export const a = 1\n')
  write(repo, 'src/b.ts', 'export const b = 1\n')
  write(repo, 'README.md', '# fixture\n')
  commitAll(repo)
  // A stash entry, so "stash unchanged" is checked against a non-empty list.
  write(repo, 'src/a.ts', 'export const a = 2 // stashed\n')
  git(repo, 'stash', 'push', '-q')
  // Staged change, then a further unstaged edit of the same file: the user's
  // index and work tree disagree, which is the state most easily clobbered.
  write(repo, 'src/a.ts', 'export const a = 3\n')
  git(repo, 'add', 'src/a.ts')
  write(repo, 'src/a.ts', 'export const a = 4\n')
  git(repo, 'rm', '-q', '--cached', 'README.md')
  write(repo, 'src/new.ts', 'export const fresh = true\n')
  write(repo, 'build/out.js', 'ignored\n')
  write(repo, 'debug.log', 'ignored\n')
  write(repo, '.env', 'API_URL=http://localhost\n')
  write(repo, 'pkg/.env.local', 'X=1\n')
  write(repo, 'pkg/.ENV.production', 'X=2\n')
  write(repo, 'keys/id_ed25519', 'not really a key\n')
  write(repo, 'certs/server.pem', 'not really a cert\n')
  write(repo, 'src/id_generator.ts', 'export const id = 0\n')
  return repo
}

function scratchDirs(): string[] {
  return readdirSync(tmpdir()).filter(name =>
    name.startsWith('qianmo-handoff-'),
  )
}

describe('shadowCommit', () => {
  test('captures the work tree: tracked edits and untracked files, minus ignored and secret-named files', async () => {
    const repo = busyRepo()
    const head = git(repo, 'rev-parse', 'HEAD')
    const shadow = await shadowCommit({ cwd: repo })

    expect(shadow.head).toBe(head)
    expect(shadow.branch).toBe('main')
    expect(git(repo, 'rev-parse', `${shadow.commit}^`)).toBe(head)
    expect(git(repo, 'rev-parse', `${shadow.commit}^{tree}`)).toBe(shadow.tree)

    const paths = treePaths(repo, shadow.commit).sort()
    expect(paths).toEqual(
      [
        '.gitignore',
        'README.md',
        'src/a.ts',
        'src/b.ts',
        'src/id_generator.ts',
        'src/new.ts',
      ].sort(),
    )
    // The work-tree version, not the staged one nor HEAD's.
    expect(blobAt(repo, shadow.commit, 'src/a.ts')).toBe('export const a = 4')
    expect(shadow.excluded.slice().sort()).toEqual(
      [
        '.env',
        'certs/server.pem',
        'keys/id_ed25519',
        'pkg/.ENV.production',
        'pkg/.env.local',
      ].sort(),
    )
    expect(shadow.changed.slice().sort()).toEqual(
      ['src/a.ts', 'src/id_generator.ts', 'src/new.ts'].sort(),
    )
  })

  test("leaves the user's index, HEAD, refs, stash and files byte-for-byte unchanged", async () => {
    const repo = busyRepo()
    const before = userState(repo)
    const scratchBefore = scratchDirs()
    await shadowCommit({ cwd: repo })
    await shadowTree({ cwd: repo })
    expect(userState(repo)).toEqual(before)
    // The private index directory is gone again.
    expect(scratchDirs()).toEqual(scratchBefore)
  })

  test('uses the fixed identity, no parent-less surprises, no signing', async () => {
    const repo = busyRepo()
    git(repo, 'config', 'user.useConfigOnly', 'true')
    git(repo, 'config', 'commit.gpgSign', 'true')
    git(repo, 'config', 'user.signingkey', 'does-not-exist')
    const shadow = await shadowCommit({ cwd: repo, message: 'm' })
    expect(
      git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', shadow.commit),
    ).toBe(
      `${HANDOFF_GIT_IDENTITY.name} <${HANDOFF_GIT_IDENTITY.email}>|${HANDOFF_GIT_IDENTITY.name} <${HANDOFF_GIT_IDENTITY.email}>`,
    )
    expect(git(repo, 'log', '-1', '--format=%B', shadow.commit)).toBe('m')
  })

  test('refuses when a changed file contains a secret, naming file and rule', async () => {
    const repo = busyRepo()
    write(repo, 'src/config.ts', `export const token = '${FAKE_GITHUB_PAT}'\n`)
    // The same secret in an ignored file is not part of the shadow at all.
    write(repo, 'build/leak.js', FAKE_GITHUB_PAT)
    const before = userState(repo)
    const error = await shadowCommit({ cwd: repo }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SecretFoundError)
    const findings = (error as SecretFoundError).findings
    expect(findings.map(f => f.path)).toEqual(['src/config.ts'])
    expect(findings[0]?.matches.map(m => m.ruleId)).toEqual(['github-pat'])
    expect((error as Error).message).not.toContain(FAKE_GITHUB_PAT)
    expect(userState(repo)).toEqual(before)
  })

  test('a secret added to a tracked file is caught too', async () => {
    const repo = busyRepo()
    write(repo, 'src/b.ts', `const t = '${FAKE_GITHUB_PAT}'\n`)
    const error = await shadowCommit({ cwd: repo }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SecretFoundError)
    expect((error as SecretFoundError).findings.map(f => f.path)).toEqual([
      'src/b.ts',
    ])
  })

  test('refuses changed files over the size cap', async () => {
    const repo = busyRepo()
    write(repo, 'data/big.bin', 'x'.repeat(2048))
    const error = await shadowCommit({ cwd: repo, maxFileBytes: 1024 }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(OversizedFileError)
    expect((error as OversizedFileError).files).toEqual([
      { path: 'data/big.bin', bytes: 2048 },
    ])
  })

  test('unborn repository: empty base tree, commit without parent', async () => {
    const repo = initRepo()
    write(repo, 'a.txt', 'first\n')
    write(repo, 'dir/b.txt', 'second\n')
    write(repo, '.env', 'SECRET=1\n')
    const before = userState(repo)
    const shadow = await shadowCommit({ cwd: repo })
    expect(shadow.head).toBeNull()
    expect(shadow.branch).toBe('main')
    expect(git(repo, 'rev-list', '--parents', '-n', '1', shadow.commit)).toBe(
      shadow.commit,
    )
    expect(treePaths(repo, shadow.commit).sort()).toEqual([
      'a.txt',
      'dir/b.txt',
    ])
    expect(shadow.changed.slice().sort()).toEqual(['a.txt', 'dir/b.txt'])
    expect(shadow.excluded).toEqual(['.env'])
    expect(userState(repo)).toEqual(before)
    expect(existsSync(join(repo, '.git', 'index'))).toBe(false)
  })

  test('works from a subdirectory and still covers the whole work tree', async () => {
    const repo = busyRepo()
    const fromRoot = await shadowTree({ cwd: repo })
    const fromSub = await shadowCommit({ cwd: join(repo, 'src') })
    expect(fromSub.root).toBe(fromRoot.root)
    expect(fromSub.tree).toBe(fromRoot.tree)
  })

  test('shadowTree matches the committed tree until the work tree changes (AC-H1)', async () => {
    const repo = busyRepo()
    const shadow = await shadowCommit({ cwd: repo })
    expect((await shadowTree({ cwd: repo })).tree).toBe(shadow.tree)
    write(repo, 'src/b.ts', 'export const b = 2\n')
    expect((await shadowTree({ cwd: repo })).tree).not.toBe(shadow.tree)
  })

  test("never runs the user's hooks", async () => {
    const repo = busyRepo()
    const hooks = join(repo, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    const marker = join(repo, '.git', 'hook-ran')
    for (const name of [
      'post-index-change',
      'pre-commit',
      'post-commit',
      'reference-transaction',
    ]) {
      const hook = join(hooks, name)
      writeFileSync(hook, `#!/bin/sh\necho ${name} >> "${marker}"\n`)
      chmodSync(hook, 0o755)
    }
    // Positive control: the same repository does run them for a plain add.
    write(repo, 'probe.txt', 'p\n')
    git(repo, 'add', 'probe.txt')
    expect(existsSync(marker)).toBe(true)
    git(repo, 'reset', '-q', 'probe.txt')
    rmSync(marker)

    await shadowCommit({ cwd: repo })
    expect(existsSync(marker)).toBe(false)
  })

  test('a nested repository is carried as a pointer and reported', async () => {
    const repo = busyRepo()
    const nested = join(repo, 'vendor', 'lib')
    mkdirSync(nested, { recursive: true })
    git(nested, 'init', '-q', '-b', 'main')
    write(nested, 'x.txt', `${FAKE_GITHUB_PAT}\n`)
    commitAll(nested)
    const shadow = await shadowCommit({ cwd: repo })
    expect(shadow.submodules).toEqual(['vendor/lib'])
    expect(
      git(repo, 'ls-tree', shadow.commit, 'vendor/lib').split(/\s/)[0],
    ).toBe('160000')
  })

  test('ignores GIT_DIR / GIT_INDEX_FILE inherited from a parent git process', async () => {
    const repo = busyRepo()
    const decoy = initRepo()
    write(decoy, 'decoy.txt', 'd\n')
    commitAll(decoy)
    const decoyBefore = userState(decoy)
    const before = userState(repo)
    const saved = {
      dir: process.env.GIT_DIR,
      index: process.env.GIT_INDEX_FILE,
    }
    process.env.GIT_DIR = join(decoy, '.git')
    process.env.GIT_INDEX_FILE = join(repo, '.git', 'index')
    let shadow: Awaited<ReturnType<typeof shadowCommit>>
    try {
      shadow = await shadowCommit({ cwd: repo })
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved.dir
      if (saved.index === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = saved.index
    }
    // Fixture git inherits process.env, so these run after the restore.
    expect(shadow.root).toBe(git(repo, 'rev-parse', '--show-toplevel'))
    expect(treePaths(repo, shadow.commit)).toContain('src/new.ts')
    expect(userState(repo)).toEqual(before)
    expect(userState(decoy)).toEqual(decoyBefore)
  })

  test('refuses a sparse checkout instead of recording deletions', async () => {
    const repo = busyRepo()
    git(repo, 'config', 'core.sparseCheckout', 'true')
    await expect(shadowCommit({ cwd: repo })).rejects.toThrow('sparse checkout')
  })
})
