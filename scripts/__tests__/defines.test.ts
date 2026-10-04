import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BUILD_FEATURES,
  getMacroDefines,
  resolveBuildFeatures,
  resolveSourceCommit,
} from '../defines.ts'

const DEFAULT_FEATURE = DEFAULT_BUILD_FEATURES[0]
const NON_DEFAULT_FEATURE = 'TEST_ONLY_FEATURE'

describe('resolveBuildFeatures', () => {
  test('includes reactive compact by default', () => {
    expect(DEFAULT_BUILD_FEATURES).toContain('REACTIVE_COMPACT')
    expect(resolveBuildFeatures({}).has('REACTIVE_COMPACT')).toBe(true)
  })

  test.each(['0', 'false', ''])('%s disables a default feature', value => {
    const features = resolveBuildFeatures({
      [`FEATURE_${DEFAULT_FEATURE}`]: value,
    })

    expect(features.has(DEFAULT_FEATURE)).toBe(false)
  })

  test('FEATURE_REACTIVE_COMPACT=0 disables reactive compact', () => {
    const features = resolveBuildFeatures({ FEATURE_REACTIVE_COMPACT: '0' })

    expect(features.has('REACTIVE_COMPACT')).toBe(false)
  })

  test.each(['1', 'true'])('%s enables a non-default feature', value => {
    const features = resolveBuildFeatures({
      [`FEATURE_${NON_DEFAULT_FEATURE}`]: value,
    })

    expect(features.has(NON_DEFAULT_FEATURE)).toBe(true)
  })

  test.each([
    '0',
    'false',
    '',
    'yes',
  ])('%s does not enable a non-default feature', value => {
    const features = resolveBuildFeatures({
      [`FEATURE_${NON_DEFAULT_FEATURE}`]: value,
    })

    expect(features.has(NON_DEFAULT_FEATURE)).toBe(false)
  })

  test('ignores an empty feature name', () => {
    const features = resolveBuildFeatures({ FEATURE_: '1' })

    expect(features.has('')).toBe(false)
    expect(features).toEqual(new Set(DEFAULT_BUILD_FEATURES))
  })
})

/**
 * Throwaway trees for the provenance probe.
 *
 * Real `git init` rather than a stub: what is under test is precisely what
 * git answers in each of the three states, and a stubbed `spawnSync` would
 * only assert that the code calls the arguments the test already assumed.
 * Under `tmpdir()` so no ancestor is a repository — the ".git-less" case has
 * to actually have no repository above it, or `rev-parse` walks up and finds
 * one.
 */
const scratchDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-provenance-'))
  scratchDirs.push(dir)
  return dir
}

function git(dir: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function committedRepo(): string {
  const dir = scratch()
  git(dir, 'init', '--quiet')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '--quiet', '-m', 'one')
  return dir
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe('resolveSourceCommit', () => {
  test('a clean tree reports the bare 40-char HEAD', () => {
    const commit = resolveSourceCommit(committedRepo())

    expect(commit).toMatch(/^[0-9a-f]{40}$/)
  })

  test('a modified tracked file makes it -dirty', () => {
    const dir = committedRepo()
    writeFileSync(join(dir, 'a.txt'), 'two\n')

    expect(resolveSourceCommit(dir)).toMatch(/^[0-9a-f]{40}-dirty$/)
  })

  test('an untracked file makes it -dirty too', () => {
    // Untracked is not cosmetic: a new .ts under src/ that has not been
    // `git add`ed is bundled exactly like a tracked one, so a bare SHA there
    // would name a commit that does not contain the shipped code.
    const dir = committedRepo()
    writeFileSync(join(dir, 'b.txt'), 'new\n')

    expect(resolveSourceCommit(dir)).toMatch(/^[0-9a-f]{40}-dirty$/)
  })

  test('a directory with no repository reports unknown, without throwing', () => {
    expect(resolveSourceCommit(scratch())).toBe('unknown')
  })

  test('a repository with no commits reports unknown', () => {
    const dir = scratch()
    git(dir, 'init', '--quiet')

    expect(resolveSourceCommit(dir)).toBe('unknown')
  })

  test('a tree nested inside an unrelated repository is not stamped with it', () => {
    // `git rev-parse` walks up. A deployment tree unpacked into a home
    // directory that happens to be a dotfiles repo would otherwise be labelled
    // with that repo's HEAD — confidently, and wrongly.
    const outer = committedRepo()
    const inner = join(outer, 'unpacked')
    mkdirSync(inner)

    expect(resolveSourceCommit(inner)).toBe('unknown')
  })
})

describe('resolveSourceCommit and OCC_SOURCE_COMMIT', () => {
  afterEach(() => {
    delete process.env.OCC_SOURCE_COMMIT
  })

  test('supplies the answer when there is no repository', () => {
    process.env.OCC_SOURCE_COMMIT = 'c'.repeat(40)

    expect(resolveSourceCommit(scratch())).toBe('c'.repeat(40))
  })

  test('does not override a repository that can answer for itself', () => {
    process.env.OCC_SOURCE_COMMIT = 'c'.repeat(40)

    expect(resolveSourceCommit(committedRepo())).not.toBe('c'.repeat(40))
  })

  test('blank is not an answer', () => {
    process.env.OCC_SOURCE_COMMIT = '   '

    expect(resolveSourceCommit(scratch())).toBe('unknown')
  })
})

describe('getMacroDefines', () => {
  test('ships SOURCE_COMMIT as a JSON string literal', () => {
    const value = getMacroDefines()['MACRO.SOURCE_COMMIT']

    expect(value).toBeDefined()
    // JSON-stringified, like every other entry: the map is fed to Vite's
    // `define`, which substitutes the text verbatim.
    expect(JSON.parse(value as string)).toMatch(
      /^([0-9a-f]{40}(-dirty)?|unknown)$/,
    )
  })
})
