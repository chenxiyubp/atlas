// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CA directory's one job beyond naming files: staying out of every
 * identity's config root (§3.3).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getProtectedUserConfigDirectories } from '../../../../config/paths.js'
import {
  CA_DIR_DEFAULT_DISPLAY,
  CA_DIR_ENV_VAR,
  caDirectory,
  isPathInside,
  pathComparisonKey,
} from '../paths.js'

const ORIGINAL_CA_DIR = process.env[CA_DIR_ENV_VAR]
const ORIGINAL_CONFIG_DIR = process.env['OCC_CONFIG_DIR']
const ORIGINAL_DEMO_ROOT = process.env['QIANMO_DEMO_ROOT']
const ORIGINAL_LEGACY_DEMO_ROOT = process.env['DEMO_ROOT']
const ORIGINAL_GITHUB_WORKSPACE = process.env['GITHUB_WORKSPACE']
const ORIGINAL_CWD = process.cwd()
const temporaryDirectories: string[] = []

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  if (ORIGINAL_CA_DIR === undefined) delete process.env[CA_DIR_ENV_VAR]
  else process.env[CA_DIR_ENV_VAR] = ORIGINAL_CA_DIR
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env['OCC_CONFIG_DIR']
  else process.env['OCC_CONFIG_DIR'] = ORIGINAL_CONFIG_DIR
  if (ORIGINAL_DEMO_ROOT === undefined) delete process.env['QIANMO_DEMO_ROOT']
  else process.env['QIANMO_DEMO_ROOT'] = ORIGINAL_DEMO_ROOT
  if (ORIGINAL_LEGACY_DEMO_ROOT === undefined) delete process.env['DEMO_ROOT']
  else process.env['DEMO_ROOT'] = ORIGINAL_LEGACY_DEMO_ROOT
  if (ORIGINAL_GITHUB_WORKSPACE === undefined)
    delete process.env['GITHUB_WORKSPACE']
  else process.env['GITHUB_WORKSPACE'] = ORIGINAL_GITHUB_WORKSPACE
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CA directory (§3.3, §6.1)', () => {
  test('Win32 containment is case-insensitive even for nonexistent tails', () => {
    expect(pathComparisonKey('C:\\DemoRoot', 'win32')).toBe(
      pathComparisonKey('c:\\demoroot', 'win32'),
    )
    expect(
      isPathInside('c:\\demoroot\\missing\\ca', 'C:\\DemoRoot', 'win32'),
    ).toBe(true)
    expect(isPathInside('C:\\DemoRootElsewhere', 'c:\\demoroot', 'win32')).toBe(
      false,
    )
    expect(isPathInside('/Tmp/demo', '/tmp/demo', 'linux')).toBe(false)
  })

  test('defaults to a sibling of the config roots, never a child', () => {
    delete process.env[CA_DIR_ENV_VAR]
    const directory = caDirectory()
    expect(directory).toBe(
      join(homedir(), CA_DIR_DEFAULT_DISPLAY.replace('~/', '')),
    )
    // The bug this guards: `~/.qianmo-ca` starts with `~/.qianmo` as a raw
    // string. A prefix test without the separator would call the default CA
    // directory a config root and refuse to run at all.
    for (const root of getProtectedUserConfigDirectories()) {
      expect(directory).not.toBe(root)
    }
  })

  test('the environment override applies, and --ca-dir beats it', () => {
    process.env[CA_DIR_ENV_VAR] = '/tmp/qianmo-ca-from-env'
    expect(caDirectory()).toBe('/tmp/qianmo-ca-from-env')
    expect(caDirectory('/tmp/qianmo-ca-explicit')).toBe(
      '/tmp/qianmo-ca-explicit',
    )
    // An empty value is not a choice; it falls back rather than resolving to
    // the process's cwd, which is where `resolve('')` would land it.
    process.env[CA_DIR_ENV_VAR] = ''
    expect(caDirectory()).toBe(
      join(homedir(), CA_DIR_DEFAULT_DISPLAY.replace('~/', '')),
    )
  })

  test('refuses a directory inside a config root', () => {
    // The failure §6.1 says must not be possible: a CA private key sitting
    // where a node process, the console, or `occ migrate` walks.
    process.env['OCC_CONFIG_DIR'] = '/tmp/qianmo-config-root'
    expect(() => caDirectory('/tmp/qianmo-config-root/ca')).toThrow(
      /inside a config root/,
    )
    expect(() => caDirectory('/tmp/qianmo-config-root')).toThrow(
      /inside a config root/,
    )
    // A sibling whose name merely starts the same way is fine.
    expect(caDirectory('/tmp/qianmo-config-root-ca')).toBe(
      '/tmp/qianmo-config-root-ca',
    )
  })

  test('refuses the official CLI’s root too, not just ours', () => {
    delete process.env['OCC_CONFIG_DIR']
    for (const root of getProtectedUserConfigDirectories()) {
      expect(() => caDirectory(join(root, 'ca'))).toThrow(
        /inside a config root/,
      )
    }
  })

  test('refuses the repository checkout itself and its descendants', () => {
    expect(() => caDirectory(join(process.cwd(), 'review-ca'))).toThrow(
      /repository, demo, or CI workspace/,
    )
  })

  test('refuses configured demo and CI workspaces while permitting an external root', () => {
    const demoRoot = '/tmp/qianmo-configured-demo'
    const ciWorkspace = '/tmp/qianmo-ci-workspace'
    process.env['QIANMO_DEMO_ROOT'] = demoRoot
    process.env['GITHUB_WORKSPACE'] = ciWorkspace

    expect(() => caDirectory(join(demoRoot, 'review-ca'))).toThrow(
      /repository, demo, or CI workspace/,
    )
    expect(() => caDirectory(join(ciWorkspace, 'review-ca'))).toThrow(
      /repository, demo, or CI workspace/,
    )
    expect(caDirectory('/tmp/qianmo-external-ca')).toBe(
      '/tmp/qianmo-external-ca',
    )
  })

  test('compares a symlinked candidate and protected root physically', () => {
    const root = mkdtempSync(join(tmpdir(), 'qianmo-ca-paths-'))
    temporaryDirectories.push(root)
    const demoRoot = join(root, 'physical-demo')
    const alias = join(root, 'demo-alias')
    mkdirSync(demoRoot)
    symlinkSync(demoRoot, alias, 'dir')
    process.env['QIANMO_DEMO_ROOT'] = demoRoot

    // This is portable evidence for the same class as macOS /tmp ↔
    // /private/tmp: the candidate's non-existent leaf sits below a symlinked
    // existing ancestor, so lexical `resolve` alone cannot see containment.
    expect(() => caDirectory(join(alias, 'ca'))).toThrow(
      /repository, demo, or CI workspace/,
    )
    // An existing symlink leaf is checked too.
    expect(() => caDirectory(alias)).toThrow(
      /repository, demo, or CI workspace/,
    )
    expect(caDirectory(join(root, 'external-ca'))).toBe(
      join(root, 'external-ca'),
    )
  })

  test('finds a repository around the candidate when cwd is outside it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-ca-cwd-'))
    temporaryDirectories.push(outside)
    process.chdir(outside)

    expect(() => caDirectory(join(ORIGINAL_CWD, '.ca-review-probe'))).toThrow(
      /repository, demo, or CI workspace/,
    )
  })
})
