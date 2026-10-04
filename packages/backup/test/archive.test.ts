// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the archive has to preserve, and why each item is on the list.
 *
 * `git status` matching after a restore is AC-6(b)'s judgement, so anything git
 * reports on has to survive the round trip. Each test here is one thing git
 * would otherwise call a modification.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { archiveDirectory, digestOf, restoreArchive } from '../src/index.js'
import { cleanupTemporaries, tempDir } from './helpers.js'

afterEach(cleanupTemporaries)

async function roundTrip(build: (dir: string) => void): Promise<string> {
  const source = join(tempDir(), 'source')
  mkdirSync(source, { recursive: true })
  build(source)
  const archive = await archiveDirectory(source)
  const target = join(tempDir(), 'target')
  mkdirSync(target, { recursive: true })
  await restoreArchive(archive, target)
  return target
}

describe('the round trip', () => {
  test('file contents and nested directories come back', async () => {
    const target = await roundTrip(dir => {
      writeFileSync(join(dir, 'a.txt'), 'hello\n')
      mkdirSync(join(dir, 'nested', 'deep'), { recursive: true })
      writeFileSync(join(dir, 'nested', 'deep', 'b.txt'), 'world\n')
    })
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(target, 'nested', 'deep', 'b.txt'), 'utf8')).toBe(
      'world\n',
    )
  })

  test('the executable bit survives — git tracks it as mode 100755', async () => {
    const target = await roundTrip(dir => {
      writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
      writeFileSync(join(dir, 'plain.txt'), 'x\n', { mode: 0o644 })
    })
    expect(statSync(join(target, 'run.sh')).mode & 0o111).not.toBe(0)
    expect(statSync(join(target, 'plain.txt')).mode & 0o111).toBe(0)
  })

  test('a symlink comes back as a symlink, not as its target', async () => {
    // git stores links as links; restoring the pointed-at bytes instead would
    // show up as a modification and, worse, as a silently different tree.
    const target = await roundTrip(dir => {
      writeFileSync(join(dir, 'real.txt'), 'real\n')
      symlinkSync('real.txt', join(dir, 'link.txt'))
    })
    expect(lstatSync(join(target, 'link.txt')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(target, 'link.txt'))).toBe('real.txt')
  })

  test('dotfiles and dot-directories are included', async () => {
    // `.git` is a dot-directory, so an archive that skips them would back up a
    // workspace with no repository in it.
    const target = await roundTrip(dir => {
      mkdirSync(join(dir, '.git'))
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    })
    expect(readdirSync(target).sort()).toEqual(['.git', '.gitignore'])
    expect(readFileSync(join(target, '.git', 'HEAD'), 'utf8')).toContain('main')
  })

  test('an empty directory is still there afterwards', async () => {
    const target = await roundTrip(dir => {
      mkdirSync(join(dir, 'empty'))
    })
    expect(statSync(join(target, 'empty')).isDirectory()).toBe(true)
  })

  test('archiving a directory that does not exist fails loudly', async () => {
    await expect(archiveDirectory(join(tempDir(), 'absent'))).rejects.toThrow(
      /tar failed/,
    )
  })
})

describe('digests', () => {
  test('the same bytes hash the same, different bytes do not', () => {
    expect(digestOf(new Uint8Array([1, 2, 3]))).toBe(
      digestOf(new Uint8Array([1, 2, 3])),
    )
    expect(digestOf(new Uint8Array([1, 2, 3]))).not.toBe(
      digestOf(new Uint8Array([1, 2, 4])),
    )
    expect(digestOf(new Uint8Array([1]))).toMatch(/^[0-9a-f]{64}$/)
  })
})
