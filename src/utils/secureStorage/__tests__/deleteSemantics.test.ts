import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFallbackStorage } from '../fallbackStorage.js'
import { macOsKeychainStorage } from '../macOsKeychainStorage.js'
import type { SecureStorageData } from '../types.js'

const originalPath = process.env.PATH
let tempDir: string
let argsLog: string

// The stub `security` is written ONCE for the whole file, not per test.
//
// macOS runs a syspolicyd code assessment on the first exec of a newly created
// executable. Measured on this repo: ~78ms to spawn a freshly written script
// versus ~3ms to spawn the same file again. Re-creating the script in
// beforeEach made every test in this describe pay that assessment, and the
// assessment is a system-daemon round-trip whose tail is unbounded under load
// — 3.1s was observed for a single spawn while the full suite was running.
//
// That is what turned these tests into 5s flakes: Bun 1.3.13 does not read
// bunfig's [test] timeout, so the per-test budget is the built-in 5s, and
// execa's execaSync IS interruptible by that timer (unlike a raw spawnSync,
// which reports its true elapsed time) — so one stalled spawn surfaces as a
// clean "timed out after 5000ms" rather than as an obviously slow test.
beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-security-delete-'))
  argsLog = join(tempDir, 'args.log')
  const securityPath = join(tempDir, 'security')
  writeFileSync(
    securityPath,
    '#!/bin/sh\nfor arg in "$@"; do\n  printf "%s\\n" "$arg"\ndone > "$SECURITY_ARGS_LOG"\nexit "$SECURITY_TEST_EXIT"\n',
  )
  chmodSync(securityPath, 0o755)
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  // A stale log from a previous test must never be what an assertion reads.
  rmSync(argsLog, { force: true })
  process.env.PATH = `${tempDir}:${originalPath ?? ''}`
  process.env.SECURITY_ARGS_LOG = argsLog
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  delete process.env.SECURITY_ARGS_LOG
  delete process.env.SECURITY_TEST_EXIT
})

// Headroom for the residual spawn stall described above: ~10x the worst single
// spawn (3.1s) measured on a loaded machine. Only the tests that actually exec
// the stub need it — the createFallbackStorage suites below are pure in-memory
// stubs with no subprocess, so they stay on the default budget.
const SPAWN_TIMEOUT_MS = 30_000

describe('macOsKeychainStorage.delete', () => {
  test.each([0, 44])(
    'treats security exit %d as success',
    exitCode => {
      process.env.SECURITY_TEST_EXIT = String(exitCode)

      expect(macOsKeychainStorage.delete()).toBe(true)
      const args = readFileSync(argsLog, 'utf8').trim().split('\n')
      expect(args[0]).toBe('delete-generic-password')
      expect(args[1]).toBe('-a')
      expect(args[3]).toBe('-s')
      expect(args).toHaveLength(5)
    },
    SPAWN_TIMEOUT_MS,
  )

  test(
    'returns false for other security failures',
    () => {
      process.env.SECURITY_TEST_EXIT = '1'

      expect(macOsKeychainStorage.delete()).toBe(false)
    },
    SPAWN_TIMEOUT_MS,
  )
})

describe('createFallbackStorage.update', () => {
  test('fails when a stale primary entry would shadow a successful fallback write', () => {
    const primary = {
      name: 'primary',
      read: () => ({ claudeAiOauth: { accessToken: 'stale' } }),
      readAsync: async () => ({ claudeAiOauth: { accessToken: 'stale' } }),
      update: () => ({ success: false }),
      delete: () => false,
    }
    const secondary = {
      name: 'secondary',
      read: () => null,
      readAsync: async () => null,
      update: () => ({ success: true }),
      delete: () => true,
    }

    expect(
      createFallbackStorage(primary, secondary).update({
        claudeAiOauth: { accessToken: 'fresh' },
      }),
    ).toEqual({ success: false })
  })

  test('does not trust a transient null primary read before fallback', () => {
    let reads = 0
    let secondaryData: SecureStorageData | null = null
    const primary = {
      name: 'primary',
      read: () =>
        reads++ === 0 ? null : { claudeAiOauth: { accessToken: 'stale' } },
      readAsync: async () => null,
      update: () => ({ success: false }),
      delete: () => false,
    }
    const secondary = {
      name: 'secondary',
      read: () => secondaryData,
      readAsync: async () => secondaryData,
      update: (data: SecureStorageData) => {
        secondaryData = data
        return { success: true }
      },
      delete: () => true,
    }
    const storage = createFallbackStorage(primary, secondary)

    expect(storage.update({ claudeAiOauth: { accessToken: 'fresh' } })).toEqual(
      { success: false },
    )
    expect(storage.read()).toEqual({
      claudeAiOauth: { accessToken: 'stale' },
    })
  })
})

describe('createFallbackStorage.delete', () => {
  test.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])('combines primary=%s and secondary=%s with AND', (primaryResult, secondaryResult, expected) => {
    let primaryDeletes = 0
    let secondaryDeletes = 0
    const primary = {
      name: 'primary',
      read: () => null,
      readAsync: async () => null,
      update: () => ({ success: true }),
      delete: () => {
        primaryDeletes++
        return primaryResult
      },
    }
    const secondary = {
      name: 'secondary',
      read: () => null,
      readAsync: async () => null,
      update: () => ({ success: true }),
      delete: () => {
        secondaryDeletes++
        return secondaryResult
      },
    }

    expect(createFallbackStorage(primary, secondary).delete()).toBe(expected)
    expect(primaryDeletes).toBe(1)
    expect(secondaryDeletes).toBe(1)
  })
})
