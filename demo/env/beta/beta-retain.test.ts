// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
/**
 * 这个文件的单测预算（issue #102 的第二半）。
 *
 * **issue #102 把这个文件和 `bootstrap-preconditions.test.ts` 归成了同一个病根，
 * 而那一条对这里不成立。**那边是「每条用例现写一个可执行文件、macOS 对每个新
 * inode 收一次没有上限的首次执行策略扫描」；这个文件一个可执行文件都不写 ——
 * 它跑的是 `bash <仓库里那份 beta-retain.sh>`，永远是同一个 inode，而脚本本身
 * 是被 bash 当数据读的，压根不走 exec 策略那条路。本机实测（空闲）：55 条用例
 * 13.7 s，除了那条**故意**等满锁超时的以外，最慢一条 0.28 s。
 *
 * 「机器忙着扫描所以这里也慢」这个说法也直接测了，不成立 —— 那笔钱**只在新
 * inode 上收**，热二进制不受影响：
 *
 *   一个热 inode（`/bin/echo`）spawn 100 次
 *     空闲                                  146 / 132 ms
 *     8 路「写新可执行文件 + 执行一次」压力  138 / 140 / 141 ms  ← 没有影响
 *     8 路纯计算压力                        205 / 204 ms        ← 1.5×
 *
 * 所以扫描压力解释不了一个只跑热二进制的用例变慢。**下次遇到 demo/env 里的
 * 偶发超时，先分清它写不写新可执行文件**：写，那是 #56/#102 那条，治法是模块
 * 作用域预建 + 预热；不写，就得另找真因，别照抄。
 *
 * 真正撑不住的是两处**结构性**的东西，与机器忙不忙无关：
 *
 * ① `runPaused` 自己等检查点等 5 s —— 恰好**等于**整条用例的预算。于是它那句
 *    有名有姓的 `child did not reach checkpoint <名字>` 永远轮不到抛出来，用例
 *    先一步死在 Bun 那条不含信息的 TimeoutError 上。诊断被自己的预算吃掉了。
 * ② `beta-retain.ts` 的 apply 锁**自己定了 10 s 的等待上限**（那条「另一个保留
 *    工具 apply 10 秒内未完成」）。凡是可能撞上这把锁的用例，它的合法最坏情况
 *    就是 10 s 出头 —— 用 5 s 的预算去装一件实现说要 10 s 的事，是预算写错了，
 *    不是被测代码慢。旁边那条 `times out without removing a stale lock` 早就为此
 *    单独写着 15_000，只是没人把这条推广到整个文件。
 *
 * 所以这里的 20 s 不是「调大超时盖住偶发红」，是**照着实现自己给出的上限**把
 * 预算算对。两个下界，取大的那个：
 *
 *   · 锁上限 10 s —— 撞上锁的用例的合法最坏情况；
 *   · 2 × 检查点等待 —— `does not delete a replacement file or replacement
 *     parent after validation` 那条 `runPaused` 了**两次**，所以一条用例里可以
 *     排两次检查点等待。
 *
 * 取 {@link CHECKPOINT_WAIT_MS} = 6 s，则第二个下界是 12 s；20 s 在两者之上，
 * 还留出 spawn 与断言的余量。6 s 本身是实测 250 ms 的 24 倍 —— 够宽到不会误报，
 * 又严格小于用例预算，于是 `runPaused` 那句点名的诊断先于 Bun 的匿名超时抛出。
 */
const TEST_BUDGET_MS = 20_000
const CHECKPOINT_WAIT_MS = 6_000
setDefaultTimeout(TEST_BUDGET_MS)

const RETAIN = join(REPOSITORY_ROOT, 'demo/env/beta/beta-retain.sh')
const RETAIN_IMPLEMENTATION = join(
  REPOSITORY_ROOT,
  'demo/env/beta/beta-retain.ts',
)
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)
const HOUR = 60 * 60 * 1_000
const DAY = 24 * HOUR
const roots: string[] = []

interface Result {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-retain-'))
  roots.push(value)
  mkdirSync(join(value, 'run'), { recursive: true })
  mkdirSync(join(value, 'logs'), { recursive: true })
  mkdirSync(join(value, 'state', 'snapshots'), { recursive: true })
  mkdirSync(join(value, 'backups'), { recursive: true })
  mkdirSync(join(value, 'nodes'), { recursive: true })
  writeFileSync(join(value, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  return value
}

function chmodSeededDescendants(value: string, mode: number): void {
  for (const relative of [
    'run',
    'logs',
    'state',
    'state/snapshots',
    'backups',
    'nodes',
  ]) {
    chmodSync(join(value, relative), mode)
  }
}

function run(
  value: string,
  args: readonly string[] = [],
  now = NOW,
  extraEnv: Readonly<Record<string, string>> = {},
): Result {
  const child = Bun.spawnSync(['bash', RETAIN, ...args], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      QIANMO_BETA_ROOT: value,
      QIANMO_BETA_RETAIN_NOW_EPOCH_MS: String(now),
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

async function runTogether(
  value: string,
  args: readonly string[] = [],
  now = NOW,
): Promise<readonly Result[]> {
  const children = [0, 1].map(() =>
    Bun.spawn(['bash', RETAIN, ...args], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        QIANMO_BETA_ROOT: value,
        QIANMO_BETA_RETAIN_NOW_EPOCH_MS: String(now),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
  return Promise.all(
    children.map(async child => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    }),
  )
}

async function runPaused(
  value: string,
  pauseAt: string,
  mutate: () => void,
  args: readonly string[] = ['--apply'],
  now = NOW,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<Result> {
  const hook = join(value, 'run', '.retain-test-hook')
  mkdirSync(hook)
  const child = Bun.spawn(['bash', RETAIN, ...args], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      QIANMO_BETA_ROOT: value,
      QIANMO_BETA_RETAIN_NOW_EPOCH_MS: String(now),
      QIANMO_BETA_RETAIN_TEST_PAUSE_AT: pauseAt,
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // 严格小于 TEST_BUDGET_MS，且**两次也装得下**：这条等待的产出是下面那句点名
  // 检查点的诊断，而预算和用例一样大就等于把它交给 Bun 的匿名超时。
  const deadline = Date.now() + CHECKPOINT_WAIT_MS
  while (!existsSync(join(hook, 'ready'))) {
    if (Date.now() >= deadline) {
      writeFileSync(join(hook, 'release'), 'timeout\n')
      await child.exited
      throw new Error(`child did not reach checkpoint ${pauseAt}`)
    }
    await Bun.sleep(5)
  }
  try {
    mutate()
  } finally {
    writeFileSync(join(hook, 'release'), 'release\n')
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  rmSync(hook, { recursive: true })
  return { exitCode, stdout, stderr }
}

function compensationPayloads(value: string): readonly string[] {
  const runDirectory = join(value, 'run')
  return readdirSync(runDirectory)
    .filter(
      name =>
        name.startsWith('.retain-') &&
        name !== '.retain-apply-lock' &&
        name !== '.retain-test-hook',
    )
    .map(name => join(runDirectory, name, 'payload'))
    .filter(path => existsSync(path))
}

function snapshot(
  value: string,
  id: string,
  createdAt: number,
  options: { archive?: boolean; meta?: boolean } = {},
): void {
  const store = join(value, 'backups')
  if (options.archive !== false) writeFileSync(join(store, `${id}.tar.gz`), id)
  if (options.meta !== false) {
    writeFileSync(
      join(store, `${id}.json`),
      `${JSON.stringify({
        version: 1,
        id,
        workspace: '/workspace',
        reason: 'scheduled',
        createdAt,
        bytes: id.length,
        sha256: 'a'.repeat(64),
      })}\n`,
    )
  }
}

function log(value: string, name: string, ageMs: number): string {
  const path = join(value, 'logs', name)
  writeFileSync(path, name)
  const at = new Date(NOW - ageMs)
  utimesSync(path, at, at)
  return path
}

function audit(value: string, node: string, contents: string): string {
  const path = join(value, 'nodes', node, 'config/qianmo/audit/trail.ndjson')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

function ledger(
  value: string,
  node: string,
  agent: string,
  bytes: number,
): string {
  const path = join(
    value,
    'nodes',
    node,
    'config/resident',
    agent,
    'admission.ndjson',
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 97))
  return path
}

function treeState(value: string, relative = '.'): readonly string[] {
  const path = relative === '.' ? value : join(value, relative)
  const stat = lstatSync(path)
  const state = [`${relative}:${stat.mode}:${stat.size}:${stat.mtimeMs}`]
  if (!stat.isDirectory() || stat.isSymbolicLink()) return state
  for (const name of readdirSync(path).sort()) {
    state.push(
      ...treeState(value, relative === '.' ? name : join(relative, name)),
    )
  }
  return state
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true })
  }
})

describe('beta-retain host retention tool', () => {
  test('keeps every snapshot inside 72 hours and one deterministic UTC representative per older day', () => {
    const value = root()
    snapshot(value, '01770000000000-0001', NOW - HOUR)
    snapshot(value, '01770000000005-0001', NOW - 72 * HOUR)
    snapshot(value, '01770000000001-0001', NOW - 72 * HOUR - 1)
    snapshot(value, '01770000000002-0001', NOW - 5 * DAY)
    snapshot(value, '01770000000003-0001', NOW - 5 * DAY)
    snapshot(value, '01770000000004-0001', NOW - 15 * DAY)

    const before = treeState(value)
    const dry = run(value)
    expect(dry.exitCode).toBe(0)
    expect(dry.stdout).toContain('备份')
    expect(treeState(value)).toEqual(before)
    expect(readdirSync(join(value, 'backups')).sort()).toHaveLength(12)

    const applied = run(value, ['--apply'])
    expect(applied.exitCode).toBe(0)
    expect(readdirSync(join(value, 'backups')).sort()).toEqual([
      '01770000000000-0001.json',
      '01770000000000-0001.tar.gz',
      '01770000000001-0001.json',
      '01770000000001-0001.tar.gz',
      '01770000000003-0001.json',
      '01770000000003-0001.tar.gz',
      '01770000000005-0001.json',
      '01770000000005-0001.tar.gz',
    ])
    expect(run(value, ['--apply']).exitCode).toBe(0)
  })

  test('never lets the 72 hour policy remove its UTC daily representative at a boundary', () => {
    const value = root()
    // 2026-08-17 00:00:00 UTC is outside 72 hours but inside the 14-day window.
    snapshot(value, '01770000000010-0001', Date.UTC(2026, 7, 17, 0, 0, 0))
    snapshot(value, '01770000000011-0001', Date.UTC(2026, 7, 17, 1, 0, 0))

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(join(value, 'backups')).sort()).toEqual([
      '01770000000011-0001.json',
      '01770000000011-0001.tar.gz',
    ])
  })

  test('compresses completed logs once, preserves current logs, and only removes expired gzip logs', () => {
    const value = root()
    const current = log(value, 'registry.out', 20 * DAY)
    writeFileSync(join(value, 'run', 'registry.pid'), String(process.pid))
    const fresh = log(value, 'console.err', DAY)
    const old = log(value, 'retired.out', 15 * DAY)
    const gzip = log(value, 'already.err.gz', 15 * DAY)

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readFileSync(current, 'utf8')).toBe('registry.out')
    expect(readdirSync(join(value, 'logs')).sort()).toEqual([
      'console.err.2026-08-22.gz',
      'registry.out',
      'retired.out.2026-08-08.gz',
    ])
    expect(() => lstatSync(old)).toThrow()
    expect(() => lstatSync(gzip)).toThrow()
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(join(value, 'logs')).sort()).toEqual([
      'console.err.2026-08-22.gz',
      'registry.out',
    ])
  })

  test('concurrent applies publish equivalent logs, audit seals, and registry snapshots once', async () => {
    const value = root()
    const source = audit(value, 'beta-1', '{"seq":1}\n')
    const registry = join(value, 'state', 'registry-agents.json')
    writeFileSync(registry, '{"version":1}\n')
    log(value, 'console.err', DAY)

    const results = await runTogether(value, ['--apply', '--snapshot-registry'])

    expect(
      results.map(result => ({
        exitCode: result.exitCode,
        stderr: result.stderr,
      })),
    ).toEqual([
      { exitCode: 0, stderr: '' },
      { exitCode: 0, stderr: '' },
    ])
    expect(readFileSync(source, 'utf8')).toBe('{"seq":1}\n')
    expect(readdirSync(join(dirname(source), 'archive'))).toEqual([
      'trail-2026-W34.ndjson',
    ])
    expect(readdirSync(join(value, 'logs'))).toEqual([
      'console.err.2026-08-22.gz',
    ])
    expect(readdirSync(join(value, 'state', 'snapshots'))).toEqual([
      'registry-20260823T120000Z.json',
    ])
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
  })

  test('times out without removing a stale lock and rejects a symlink lock immediately', () => {
    const stale = root()
    const staleLock = join(stale, 'run', '.retain-apply-lock')
    mkdirSync(staleLock)

    const staleResult = run(stale, ['--apply'])

    expect(staleResult.exitCode).not.toBe(0)
    expect(staleResult.stderr).toContain('10 秒内未完成')
    expect(lstatSync(staleLock).isDirectory()).toBe(true)

    const malicious = root()
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-retain-lock-'))
    roots.push(outside)
    const maliciousLock = join(malicious, 'run', '.retain-apply-lock')
    symlinkSync(outside, maliciousLock)

    const maliciousResult = run(malicious, ['--apply'])

    expect(maliciousResult.exitCode).not.toBe(0)
    expect(lstatSync(maliciousLock).isSymbolicLink()).toBe(true)
    expect(readdirSync(outside)).toEqual([])
    // 预算不再单写：文件默认已经是 TEST_BUDGET_MS（20 s），而它就是照着这条
    // 用例暴露的那个 10 s 锁上限定的 —— 这里曾经是全文件唯一一处写对了的地方。
  })

  test('fails closed for append, truncate, rename, and swap while compressing a log, then recovers', async () => {
    const cases: readonly {
      readonly name: string
      readonly mutate: (source: string) => void
      readonly expectedSource: string
      readonly moved?: string
    }[] = [
      {
        name: 'append',
        mutate: source => appendFileSync(source, '-appended'),
        expectedSource: 'console.err-appended',
      },
      {
        name: 'truncate',
        mutate: source => truncateSync(source, 3),
        expectedSource: 'con',
      },
      {
        name: 'rename-swap',
        mutate: source => {
          renameSync(source, `${source}.moved`)
          writeFileSync(source, 'replacement')
        },
        expectedSource: 'replacement',
        moved: 'console.err',
      },
    ]

    for (const item of cases) {
      const value = root()
      const source = log(value, 'console.err', DAY)
      const destination = `${source}.2026-08-22.gz`
      const result = await runPaused(value, 'log-after-capture', () =>
        item.mutate(source),
      )

      expect(result.exitCode, item.name).not.toBe(0)
      expect(readFileSync(source, 'utf8'), item.name).toBe(item.expectedSource)
      expect(existsSync(destination), item.name).toBe(false)
      if (item.moved !== undefined)
        expect(readFileSync(`${source}.moved`, 'utf8')).toBe(item.moved)
      expect(treeState(value).some(state => state.includes('.retain-'))).toBe(
        false,
      )

      const recovered = run(value, ['--apply'])
      expect(recovered.exitCode, `${item.name}: ${recovered.stderr}`).toBe(0)
      expect(existsSync(source), item.name).toBe(false)
      if (item.moved !== undefined)
        expect(readFileSync(`${source}.moved`, 'utf8')).toBe(item.moved)
    }
  })

  test('does not publish an incomplete audit seal when the source appends during copying', async () => {
    const value = root()
    const source = audit(value, 'beta-1', '{"seq":1}\n')
    const destination = join(
      dirname(source),
      'archive',
      'trail-2026-W34.ndjson',
    )

    const result = await runPaused(value, 'audit-after-capture', () =>
      appendFileSync(source, '{"seq":2}\n'),
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(source, 'utf8')).toBe('{"seq":1}\n{"seq":2}\n')
    expect(existsSync(destination)).toBe(false)
    expect(treeState(value).some(state => state.includes('.retain-'))).toBe(
      false,
    )
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readFileSync(destination)).toEqual(readFileSync(source))
  })

  test('removes a stale registry publication when the source changes, then recovers', async () => {
    const value = root()
    const source = join(value, 'state', 'registry-agents.json')
    const destination = join(
      value,
      'state',
      'snapshots',
      'registry-20260823T120000Z.json',
    )
    writeFileSync(source, '{"version":1}\n')

    const result = await runPaused(
      value,
      'registry-after-capture',
      () => writeFileSync(source, '{"version":2}\n'),
      ['--apply', '--snapshot-registry'],
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(source, 'utf8')).toBe('{"version":2}\n')
    expect(existsSync(destination)).toBe(false)
    expect(treeState(value).some(state => state.includes('.retain-'))).toBe(
      false,
    )
    expect(run(value, ['--apply', '--snapshot-registry']).exitCode).toBe(0)
    expect(readFileSync(destination)).toEqual(readFileSync(source))
  })

  test('does not delete a replacement of its just-published destination', async () => {
    const value = root()
    const source = join(value, 'state', 'registry-agents.json')
    const destination = join(
      value,
      'state',
      'snapshots',
      'registry-20260823T120000Z.json',
    )
    writeFileSync(source, '{"version":1}\n')

    const result = await runPaused(
      value,
      'publication-after-staging-unlink',
      () => {
        unlinkSync(destination)
        writeFileSync(destination, 'replacement publication\n')
      },
      ['--apply', '--snapshot-registry'],
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(destination, 'utf8')).toBe('replacement publication\n')
    expect(readFileSync(source, 'utf8')).toBe('{"version":1}\n')
    expect(existsSync(join(value, 'run', '.retain-apply-lock'))).toBe(false)
    expect(treeState(value).some(state => state.includes('.retain-'))).toBe(
      false,
    )
  })

  test('settles concurrent backup deletion and compensates metadata if archive identity changes', async () => {
    const concurrent = root()
    snapshot(concurrent, '01770000000001-0001', NOW - 20 * DAY)
    const concurrentResults = await runTogether(concurrent, ['--apply'])
    expect(
      concurrentResults.map(result => ({
        exitCode: result.exitCode,
        stderr: result.stderr,
      })),
    ).toEqual([
      { exitCode: 0, stderr: '' },
      { exitCode: 0, stderr: '' },
    ])
    expect(readdirSync(join(concurrent, 'backups'))).toEqual([])
    expect(
      treeState(concurrent).some(state => state.includes('.retain-')),
    ).toBe(false)

    const conflict = root()
    const id = '01770000000002-0001'
    snapshot(conflict, id, NOW - 20 * DAY)
    const archive = join(conflict, 'backups', `${id}.tar.gz`)
    const originalArchive = `${archive}.original`
    const meta = join(conflict, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(meta)

    const conflictResult = await runPaused(
      conflict,
      'backup-after-meta-delete',
      () => {
        renameSync(archive, originalArchive)
        writeFileSync(archive, 'replacement archive')
      },
    )

    expect(conflictResult.exitCode).not.toBe(0)
    expect(readFileSync(meta)).toEqual(metadataBefore)
    expect(readFileSync(archive, 'utf8')).toBe('replacement archive')
    expect(readFileSync(originalArchive, 'utf8')).toBe(id)
    expect(treeState(conflict).some(state => state.includes('.retain-'))).toBe(
      false,
    )
  })

  test('retains compensation staging when destination directory fsync fails', () => {
    const value = root()
    const id = '01770000000003-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = run(value, ['--apply'], NOW, {
      NODE_ENV: 'test',
      QIANMO_BETA_RETAIN_TEST_FAIL_AT:
        'backup-after-meta-delete,backup-compensation-destination-fsync',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('backup-compensation-destination-fsync')
    expect(readFileSync(archive, 'utf8')).toBe(id)
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(payloads[0].startsWith(join(value, 'run'))).toBe(true)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
    expect(readFileSync(metadata)).toEqual(metadataBefore)
  })

  test('preserves a replacement and compensation staging after the restore link is replaced', async () => {
    const value = root()
    const id = '01770000000004-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(
      value,
      'backup-compensation-after-link',
      () => {
        unlinkSync(metadata)
        writeFileSync(metadata, 'replacement metadata')
      },
      ['--apply'],
      NOW,
      {
        QIANMO_BETA_RETAIN_TEST_FAIL_AT: 'backup-after-meta-delete',
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(archive, 'utf8')).toBe(id)
    expect(readFileSync(metadata, 'utf8')).toBe('replacement metadata')
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(payloads[0].startsWith(join(value, 'run'))).toBe(true)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
  })

  test('preserves moved original metadata and compensation staging after the restore link moves', async () => {
    const value = root()
    const id = '01770000000005-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const metadata = join(value, 'backups', `${id}.json`)
    const movedMetadata = `${metadata}.moved`
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(
      value,
      'backup-compensation-after-link',
      () => renameSync(metadata, movedMetadata),
      ['--apply'],
      NOW,
      {
        QIANMO_BETA_RETAIN_TEST_FAIL_AT: 'backup-after-meta-delete',
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(archive, 'utf8')).toBe(id)
    expect(existsSync(metadata)).toBe(false)
    expect(readFileSync(movedMetadata)).toEqual(metadataBefore)
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(payloads[0].startsWith(join(value, 'run'))).toBe(true)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
  })

  test('restores or retains original metadata when it disappears before an archive conflict', async () => {
    const value = root()
    const id = '01770000000006-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const movedArchive = `${archive}.original`
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(value, 'backup-before-delete', () => {
      unlinkSync(metadata)
      renameSync(archive, movedArchive)
      writeFileSync(archive, 'replacement archive')
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('从 staging 无覆盖恢复并完整验证')
    expect(readFileSync(archive, 'utf8')).toBe('replacement archive')
    expect(readFileSync(movedArchive, 'utf8')).toBe(id)
    const payloads = compensationPayloads(value)
    const recoverable = existsSync(metadata)
      ? readFileSync(metadata)
      : readFileSync(payloads[0])
    expect(recoverable).toEqual(metadataBefore)
  })

  test('retains staging without clobbering replacement metadata after an archive conflict', async () => {
    const value = root()
    const id = '01770000000007-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const movedArchive = `${archive}.original`
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(value, 'backup-before-delete', () => {
      unlinkSync(metadata)
      writeFileSync(metadata, 'replacement metadata')
      renameSync(archive, movedArchive)
      writeFileSync(archive, 'replacement archive')
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('保留 staging')
    expect(readFileSync(metadata, 'utf8')).toBe('replacement metadata')
    expect(readFileSync(archive, 'utf8')).toBe('replacement archive')
    expect(readFileSync(movedArchive, 'utf8')).toBe(id)
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
  })

  test('does not treat a moved archive as a verified deletion commit', async () => {
    const value = root()
    const id = '01770000000008-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const movedArchive = `${archive}.original`
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(value, 'backup-before-delete', () => {
      unlinkSync(metadata)
      renameSync(archive, movedArchive)
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('不能确认归档提交完成')
    expect(readFileSync(movedArchive, 'utf8')).toBe(id)
    const payloads = compensationPayloads(value)
    const recoverable = existsSync(metadata)
      ? readFileSync(metadata)
      : readFileSync(payloads[0])
    expect(recoverable).toEqual(metadataBefore)
  })

  test('restores metadata durably when the paired backups directory fsync fails', () => {
    const value = root()
    const id = '01770000000009-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = run(value, ['--apply'], NOW, {
      NODE_ENV: 'test',
      QIANMO_BETA_RETAIN_TEST_FAIL_AT: 'backup-deletion-directory-fsync',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('backup-deletion-directory-fsync')
    expect(result.stderr).toContain('恢复成功且目录项已持久化')
    expect(readFileSync(metadata)).toEqual(metadataBefore)
    expect(existsSync(archive)).toBe(false)
    expect(compensationPayloads(value)).toEqual([])
  })

  test('keeps a metadata replacement and staging after archive unlink commit verification fails', async () => {
    const value = root()
    const id = '01770000000010-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(value, 'backup-after-archive-delete', () =>
      writeFileSync(metadata, 'replacement after archive unlink'),
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('元数据恢复也未持久化提交')
    expect(readFileSync(metadata, 'utf8')).toBe(
      'replacement after archive unlink',
    )
    expect(existsSync(archive)).toBe(false)
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
  })

  test('does not commit after backups fsync when a pathname reappears before final verification', async () => {
    const value = root()
    const id = '01770000000013-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(
      value,
      'backup-after-deletion-directory-fsync',
      () => writeFileSync(metadata, 'replacement after backups fsync'),
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('paired phase=directory-synced')
    expect(result.stderr).toContain('元数据恢复也未持久化提交')
    expect(readFileSync(metadata, 'utf8')).toBe(
      'replacement after backups fsync',
    )
    expect(existsSync(archive)).toBe(false)
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
  })

  test('reports durable metadata recovery separately when a blocker prevents staging directory cleanup', async () => {
    const value = root()
    const id = '01770000000011-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)
    let blocker = ''
    let payload = ''

    const result = await runPaused(
      value,
      'backup-compensation-after-commit',
      () => {
        const payloads = compensationPayloads(value)
        if (payloads.length !== 1)
          throw new Error(`expected one compensation payload, got ${payloads}`)
        payload = payloads[0]
        blocker = join(dirname(payload), 'operator-blocker')
        writeFileSync(blocker, 'do not remove')
      },
      ['--apply'],
      NOW,
      { QIANMO_BETA_RETAIN_TEST_FAIL_AT: 'backup-after-meta-delete' },
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('恢复成功但 cleanup 不完整')
    expect(result.stderr).toContain('payload=缺失')
    expect(result.stderr).toContain('临时目录=存在')
    expect(readFileSync(metadata)).toEqual(metadataBefore)
    expect(readFileSync(archive, 'utf8')).toBe(id)
    expect(existsSync(payload)).toBe(false)
    expect(readFileSync(blocker, 'utf8')).toBe('do not remove')
  })

  test('does not clear staging when metadata is replaced after durable recovery commits', async () => {
    const value = root()
    const id = '01770000000012-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(
      value,
      'backup-compensation-after-commit',
      () => {
        unlinkSync(metadata)
        writeFileSync(metadata, 'replacement after durable recovery')
      },
      ['--apply'],
      NOW,
      { QIANMO_BETA_RETAIN_TEST_FAIL_AT: 'backup-after-meta-delete' },
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('恢复成功但 cleanup 不完整')
    expect(readFileSync(metadata, 'utf8')).toBe(
      'replacement after durable recovery',
    )
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
  })

  test('reports disk facts at every durable recovery cleanup failure point', () => {
    const cases = [
      {
        failure: 'backup-cleanup-payload-unlink',
        phase: 'not-started',
        payload: '存在',
        directory: '存在',
      },
      {
        failure: 'backup-cleanup-temp-dir-fsync',
        phase: 'payload-unlinked',
        payload: '缺失',
        directory: '存在',
      },
      {
        failure: 'backup-cleanup-temp-dir-rmdir',
        phase: 'payload-unlink-durable',
        payload: '缺失',
        directory: '存在',
      },
      {
        failure: 'backup-cleanup-run-dir-fsync',
        phase: 'directory-removed',
        payload: '缺失',
        directory: '缺失',
      },
    ] as const

    for (const item of cases) {
      const value = root()
      const id = `0177000000002${roots.length}-0001`
      snapshot(value, id, NOW - 20 * DAY)
      const metadata = join(value, 'backups', `${id}.json`)
      const metadataBefore = readFileSync(metadata)

      const result = run(value, ['--apply'], NOW, {
        NODE_ENV: 'test',
        QIANMO_BETA_RETAIN_TEST_FAIL_AT: `backup-after-meta-delete,${item.failure}`,
      })

      expect(result.exitCode, item.failure).not.toBe(0)
      expect(result.stderr, item.failure).toContain(item.failure)
      expect(result.stderr, item.failure).toContain('恢复成功但 cleanup 不完整')
      expect(result.stderr, item.failure).toContain(
        `cleanup phase=${item.phase}`,
      )
      expect(result.stderr, item.failure).toContain(`payload=${item.payload}`)
      expect(result.stderr, item.failure).toContain(
        `临时目录=${item.directory}`,
      )
      expect(readFileSync(metadata), item.failure).toEqual(metadataBefore)
    }
  })

  test('does not start paired deletion when either staging directory fsync fails', () => {
    for (const failure of [
      'backup-staging-temp-dir-fsync',
      'backup-staging-run-dir-fsync',
    ]) {
      const value = root()
      const id = `0177000000001${roots.length}-0001`
      snapshot(value, id, NOW - 20 * DAY)
      const archive = join(value, 'backups', `${id}.tar.gz`)
      const metadata = join(value, 'backups', `${id}.json`)
      const metadataBefore = readFileSync(metadata)

      const result = run(value, ['--apply'], NOW, {
        NODE_ENV: 'test',
        QIANMO_BETA_RETAIN_TEST_FAIL_AT: failure,
      })

      expect(result.exitCode, failure).not.toBe(0)
      expect(result.stderr, failure).toContain(failure)
      expect(result.stderr, failure).toContain('成对删除尚未开始')
      expect(readFileSync(metadata), failure).toEqual(metadataBefore)
      expect(readFileSync(archive, 'utf8'), failure).toBe(id)
      expect(compensationPayloads(value), failure).toEqual([])
    }
  })

  test('does not unlink a generic replacement inserted at the deletion syscall boundary', async () => {
    const value = root()
    const target = log(value, 'expired.err.gz', 20 * DAY)
    const planned = `${target}.planned`

    const result = await runPaused(
      value,
      'generic-delete-before-quarantine-rename',
      () => {
        renameSync(target, planned)
        writeFileSync(target, 'generic boundary replacement')
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('generic boundary replacement')
    expect(readFileSync(planned, 'utf8')).toBe('expired.err.gz')
    const quarantine = join(
      value,
      'logs',
      readdirSync(join(value, 'logs')).find(name =>
        name.startsWith('.retain-delete-'),
      ) ?? '',
      'payload',
    )
    expect(readFileSync(quarantine, 'utf8')).toBe(
      'generic boundary replacement',
    )
    expect(lstatSync(quarantine).ino).toBe(lstatSync(target).ino)
    expect(lstatSync(quarantine).nlink).toBe(2)
    expect(result.stderr).toContain(quarantine)
  })

  test('does not unlink an archive replacement inserted at the deletion syscall boundary', async () => {
    const value = root()
    const id = '01770000000014-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const archive = join(value, 'backups', `${id}.tar.gz`)
    const plannedArchive = `${archive}.planned`
    const metadata = join(value, 'backups', `${id}.json`)
    const metadataBefore = readFileSync(metadata)

    const result = await runPaused(
      value,
      'backup-archive-before-quarantine-rename',
      () => {
        renameSync(archive, plannedArchive)
        writeFileSync(archive, 'archive boundary replacement')
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(archive, 'utf8')).toBe('archive boundary replacement')
    expect(readFileSync(plannedArchive, 'utf8')).toBe(id)
    const quarantine = join(
      value,
      'backups',
      readdirSync(join(value, 'backups')).find(name =>
        name.startsWith('.retain-delete-'),
      ) ?? '',
      'archive',
    )
    expect(readFileSync(quarantine, 'utf8')).toBe(
      'archive boundary replacement',
    )
    expect(lstatSync(quarantine).ino).toBe(lstatSync(archive).ino)
    expect(lstatSync(quarantine).nlink).toBe(2)
    expect(result.stderr).toContain(quarantine)
    const payloads = compensationPayloads(value)
    const recoverable = existsSync(metadata)
      ? readFileSync(metadata)
      : readFileSync(payloads[0])
    expect(recoverable).toEqual(metadataBefore)
  })

  test('fails the global plan for an active raw log with a divergent gzip peer', () => {
    const value = root()
    const id = '01770000000015-0001'
    snapshot(value, id, NOW - 20 * DAY)
    writeFileSync(join(value, 'run', 'console.pid'), `${process.pid}\n`)
    const raw = log(value, 'console.out', DAY)
    const gzip = `${raw}.2026-08-22.gz`
    writeFileSync(gzip, 'divergent active gzip')
    const rawBefore = readFileSync(raw)
    const gzipBefore = readFileSync(gzip)

    const result = run(value, ['--apply'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(gzip)
    expect(readFileSync(raw)).toEqual(rawBefore)
    expect(readFileSync(gzip)).toEqual(gzipBefore)
    expect(readdirSync(join(value, 'backups')).sort()).toEqual([
      `${id}.json`,
      `${id}.tar.gz`,
    ])
  })

  test('aggregates every listed registry, pid, node, and ledger issue before writing', () => {
    const value = root()
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-retain-issues-'))
    roots.push(outside)
    const outsideFile = join(outside, 'sentinel')
    const outsideDirectory = join(outside, 'directory')
    writeFileSync(outsideFile, 'outside')
    mkdirSync(outsideDirectory)

    const registryIssues = [
      'registry-20260801T000000Z-a.json',
      'registry-20260802T000000Z-b.json',
    ].map(name => join(value, 'state', 'snapshots', name))
    for (const path of registryIssues) symlinkSync(outsideFile, path)

    const pidIssues = ['alpha.pid', 'beta.pid'].map(name =>
      join(value, 'run', name),
    )
    for (const path of pidIssues) symlinkSync(outsideFile, path)

    const nodeIssues = ['bad-node-a', 'bad-node-b'].map(name =>
      join(value, 'nodes', name),
    )
    for (const path of nodeIssues) symlinkSync(outsideDirectory, path)
    const residentIssue = join(value, 'nodes/resident-bad/config/resident')
    mkdirSync(dirname(residentIssue), { recursive: true })
    symlinkSync(outsideDirectory, residentIssue)
    const ledgerIssues = ['bad-agent-a', 'bad-agent-b'].map(agent =>
      join(value, `nodes/good-node/config/resident/${agent}/admission.ndjson`),
    )
    for (const path of ledgerIssues) {
      mkdirSync(dirname(path), { recursive: true })
      symlinkSync(outsideFile, path)
    }

    const backupId = '01770000000016-0001'
    snapshot(value, backupId, NOW - 20 * DAY)
    const raw = log(value, 'candidate.err', DAY)
    const rawDestination = `${raw}.2026-08-22.gz`
    writeFileSync(join(value, 'state', 'registry-agents.json'), '{"v":1}\n')
    const registryDestination = join(
      value,
      'state/snapshots/registry-20260823T120000Z.json',
    )

    const result = run(value, ['--apply', '--snapshot-registry'])

    expect(result.exitCode).not.toBe(0)
    for (const path of [
      ...registryIssues,
      ...pidIssues,
      ...nodeIssues,
      residentIssue,
      ...ledgerIssues,
    ]) {
      expect(result.stderr).toContain(path)
    }
    expect(existsSync(raw)).toBe(true)
    expect(existsSync(rawDestination)).toBe(false)
    expect(existsSync(registryDestination)).toBe(false)
    expect(readdirSync(join(value, 'backups')).sort()).toEqual([
      `${backupId}.json`,
      `${backupId}.tar.gz`,
    ])
  })

  test('treats an equivalent gzip publication as idempotent and leaves a divergent one untouched', () => {
    const equivalent = root()
    const source = log(equivalent, 'console.err', DAY)
    const destination = `${source}.2026-08-22.gz`

    expect(run(equivalent, ['--apply']).exitCode).toBe(0)
    log(equivalent, 'console.err', DAY)
    expect(run(equivalent, ['--apply']).exitCode).toBe(0)
    expect(existsSync(source)).toBe(false)
    expect(readdirSync(join(equivalent, 'logs'))).toEqual([
      'console.err.2026-08-22.gz',
    ])
    expect(treeState(equivalent).some(state => state.includes('.tmp-'))).toBe(
      false,
    )

    const divergent = root()
    const divergentSource = log(divergent, 'console.err', DAY)
    const divergentDestination = `${divergentSource}.2026-08-22.gz`
    writeFileSync(divergentDestination, 'not this log')
    const sourceBefore = readFileSync(divergentSource, 'utf8')
    const destinationBefore = readFileSync(divergentDestination, 'utf8')

    expect(run(divergent, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(divergentSource, 'utf8')).toBe(sourceBefore)
    expect(readFileSync(divergentDestination, 'utf8')).toBe(destinationBefore)
    expect(treeState(divergent).some(state => state.includes('.tmp-'))).toBe(
      false,
    )
  })

  test('archives each audit source atomically without changing or deleting that source', () => {
    const value = root()
    const source = audit(value, 'beta-1', '{"seq":1}\n')
    const before = readFileSync(source)

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readFileSync(source)).toEqual(before)
    const archiveDir = join(dirname(source), 'archive')
    expect(readdirSync(archiveDir)).toEqual(['trail-2026-W34.ndjson'])
    expect(readFileSync(join(archiveDir, 'trail-2026-W34.ndjson'))).toEqual(
      before,
    )
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(archiveDir)).toEqual(['trail-2026-W34.ndjson'])
  })

  test('does not overwrite a divergent audit seal or leave a temporary artifact', () => {
    const value = root()
    const source = audit(value, 'beta-1', '{"seq":1}\n')
    const archive = join(dirname(source), 'archive')
    mkdirSync(archive)
    const destination = join(archive, 'trail-2026-W34.ndjson')
    writeFileSync(destination, '{"seq":0}\n')

    const sourceBefore = readFileSync(source, 'utf8')
    const destinationBefore = readFileSync(destination, 'utf8')

    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(source, 'utf8')).toBe(sourceBefore)
    expect(readFileSync(destination, 'utf8')).toBe(destinationBefore)
    expect(readdirSync(archive).sort()).toEqual(['trail-2026-W34.ndjson'])
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
    expect(existsSync(join(value, 'run', '.retain-apply-lock'))).toBe(false)
  })

  test('uses ISO weeks across a year boundary and only seals on Sunday', () => {
    const sunday = root()
    const sundaySource = audit(sunday, 'beta-1', '{"seq":1}\n')
    expect(run(sunday, ['--apply'], Date.UTC(2027, 0, 3, 12)).exitCode).toBe(0)
    expect(readdirSync(join(dirname(sundaySource), 'archive'))).toEqual([
      'trail-2026-W53.ndjson',
    ])

    const monday = root()
    const mondaySource = audit(monday, 'beta-1', '{"seq":1}\n')
    expect(run(monday, ['--apply'], Date.UTC(2027, 0, 4, 12)).exitCode).toBe(0)
    expect(existsSync(join(dirname(mondaySource), 'archive'))).toBe(false)
  })

  test('creates an upgrade registry snapshot atomically and retains the latest four with a stable tie break', () => {
    const value = root()
    const source = join(value, 'state', 'registry-agents.json')
    writeFileSync(source, '{"version":1}\n')
    for (const name of [
      'registry-20260801T000000Z-a.json',
      'registry-20260802T000000Z-b.json',
      'registry-20260803T000000Z-c.json',
      'registry-20260804T000000Z-d.json',
      'registry-20260804T000000Z-e.json',
    ]) {
      writeFileSync(join(value, 'state', 'snapshots', name), name)
    }

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(readdirSync(join(value, 'state', 'snapshots')).sort()).toEqual([
      'registry-20260802T000000Z-b.json',
      'registry-20260803T000000Z-c.json',
      'registry-20260804T000000Z-d.json',
      'registry-20260804T000000Z-e.json',
    ])
    expect(run(value, ['--apply', '--snapshot-registry']).exitCode).toBe(0)
    expect(
      readdirSync(join(value, 'state', 'snapshots')).filter(name =>
        name.endsWith('.json'),
      ),
    ).toHaveLength(4)
    expect(run(value, ['--apply', '--snapshot-registry']).exitCode).toBe(0)
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
  })

  test('does not overwrite a divergent registry snapshot or leave a temporary artifact', () => {
    const value = root()
    const source = join(value, 'state', 'registry-agents.json')
    const destination = join(
      value,
      'state',
      'snapshots',
      'registry-20260823T120000Z.json',
    )
    writeFileSync(source, '{"version":1}\n')
    writeFileSync(destination, '{"version":0}\n')
    const sourceBefore = readFileSync(source, 'utf8')
    const destinationBefore = readFileSync(destination, 'utf8')

    expect(run(value, ['--apply', '--snapshot-registry']).exitCode).not.toBe(0)
    expect(readFileSync(source, 'utf8')).toBe(sourceBefore)
    expect(readFileSync(destination, 'utf8')).toBe(destinationBefore)
    expect(treeState(value).some(state => state.includes('.tmp-'))).toBe(false)
  })

  test('fails closed when a racing directory creator leaves an unsafe archive path', () => {
    const symlinkRoot = root()
    const symlinkSource = audit(symlinkRoot, 'beta-1', '{"seq":1}\n')
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-beta-retain-outside-'))
    roots.push(outside)
    const symlinkArchive = join(dirname(symlinkSource), 'archive')
    symlinkSync(outside, symlinkArchive)

    expect(run(symlinkRoot, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(symlinkSource, 'utf8')).toBe('{"seq":1}\n')
    expect(readdirSync(outside)).toEqual([])
    expect(treeState(symlinkRoot).some(state => state.includes('.tmp-'))).toBe(
      false,
    )

    const fileRoot = root()
    const fileSource = audit(fileRoot, 'beta-1', '{"seq":1}\n')
    const fileArchive = join(dirname(fileSource), 'archive')
    writeFileSync(fileArchive, 'not a directory')

    expect(run(fileRoot, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(fileSource, 'utf8')).toBe('{"seq":1}\n')
    expect(readFileSync(fileArchive, 'utf8')).toBe('not a directory')
    expect(treeState(fileRoot).some(state => state.includes('.tmp-'))).toBe(
      false,
    )
  })

  test('does not delete a replacement file or replacement parent after validation', async () => {
    const fileSwap = root()
    const fileId = '01770000000020-0001'
    snapshot(fileSwap, fileId, NOW - 20 * DAY)
    const fileArchive = join(fileSwap, 'backups', `${fileId}.tar.gz`)
    const movedArchive = `${fileArchive}.moved`
    const fileMeta = join(fileSwap, 'backups', `${fileId}.json`)
    const fileMetaBefore = readFileSync(fileMeta)

    const fileResult = await runPaused(fileSwap, 'backup-before-delete', () => {
      renameSync(fileArchive, movedArchive)
      writeFileSync(fileArchive, 'replacement')
    })
    expect(fileResult.exitCode).not.toBe(0)
    expect(readFileSync(fileArchive, 'utf8')).toBe('replacement')
    expect(readFileSync(movedArchive, 'utf8')).toBe(fileId)
    expect(readFileSync(fileMeta)).toEqual(fileMetaBefore)
    expect(treeState(fileSwap).some(state => state.includes('.retain-'))).toBe(
      false,
    )

    const parentSwap = root()
    const parentId = '01770000000021-0001'
    snapshot(parentSwap, parentId, NOW - 20 * DAY)
    const backups = join(parentSwap, 'backups')
    const movedBackups = join(parentSwap, 'backups-original')
    const replacementArchive = join(backups, `${parentId}.tar.gz`)
    const replacementMeta = join(backups, `${parentId}.json`)
    const parentResult = await runPaused(
      parentSwap,
      'backup-before-delete',
      () => {
        renameSync(backups, movedBackups)
        mkdirSync(backups)
        writeFileSync(replacementArchive, 'replacement archive')
        writeFileSync(replacementMeta, 'replacement metadata')
      },
    )
    expect(parentResult.exitCode).not.toBe(0)
    expect(readFileSync(replacementArchive, 'utf8')).toBe('replacement archive')
    expect(readFileSync(replacementMeta, 'utf8')).toBe('replacement metadata')
    expect(
      readdirSync(movedBackups)
        .sort()
        .filter(name => name.includes(parentId)),
    ).toEqual([`${parentId}.json`, `${parentId}.tar.gz`])
    const parentPayloads = compensationPayloads(parentSwap)
    expect(parentPayloads).toHaveLength(1)
    expect(readFileSync(parentPayloads[0])).toEqual(
      readFileSync(join(movedBackups, `${parentId}.json`)),
    )
  })

  test('only warns for an oversized admission ledger without changing either side of the threshold', () => {
    const value = root()
    const small = ledger(value, 'beta-1', 'planner', 10 * 1024 * 1024)
    const large = ledger(value, 'beta-1', 'reviewer', 10 * 1024 * 1024 + 1)
    const before = [readFileSync(small), readFileSync(large)]

    const result = run(value, ['--apply'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('WARN')
    expect(readFileSync(small)).toEqual(before[0])
    expect(readFileSync(large)).toEqual(before[1])
  })

  test('rejects unsafe roots, marker failures, unsupported arguments, and symlink escape attempts before writing', () => {
    const value = root()
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-beta-retain-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'sentinel'), 'safe')

    expect(run(value, ['--unknown']).exitCode).not.toBe(0)
    expect(run(value, ['--apply', '--apply']).exitCode).not.toBe(0)
    expect(run(value, ['--apply', '--dry-run']).exitCode).not.toBe(0)
    expect(run(value, ['--apply']).exitCode).toBe(0)

    const unsafe = run('/', ['--apply'])
    expect(unsafe.exitCode).not.toBe(0)

    rmSync(join(value, '.qianmo-beta-env'))
    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    writeFileSync(join(value, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')

    rmSync(join(value, 'backups'), { recursive: true })
    symlinkSync(outside, join(value, 'backups'))
    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('safe')

    const dangling = root()
    symlinkSync(
      join(outside, 'missing'),
      join(dangling, 'logs', 'dangling.err'),
    )
    expect(run(dangling, ['--apply']).exitCode).not.toBe(0)
    expect(existsSync(join(outside, 'missing'))).toBe(false)

    rmSync(join(value, 'backups'))
    mkdirSync(join(value, 'backups'))
    symlinkSync(
      join(outside, 'sentinel'),
      join(value, 'backups', '01770000000099-0001.tar.gz'),
    )
    writeFileSync(
      join(value, 'backups', '01770000000099-0001.json'),
      JSON.stringify({ id: '01770000000099-0001', createdAt: NOW - 20 * DAY }),
    )
    expect(run(value, ['--apply']).exitCode).not.toBe(0)
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('safe')
  })

  test('requires an exact 0700 root before any data write', () => {
    for (const mode of [0o770, 0o777]) {
      const value = root()
      const id = `0177000000002${mode === 0o770 ? '8' : '9'}-0001`
      snapshot(value, id, NOW - 20 * DAY)
      const source = log(value, 'console.err', DAY)
      chmodSync(value, mode)
      try {
        const result = run(value, ['--apply'])
        expect(result.exitCode, mode.toString(8)).not.toBe(0)
        expect(result.stderr, mode.toString(8)).toContain('严格为 0700')
        expect(readdirSync(join(value, 'backups')).sort()).toEqual([
          `${id}.json`,
          `${id}.tar.gz`,
        ])
        expect(existsSync(source)).toBe(true)
        expect(existsSync(`${source}.2026-08-22.gz`)).toBe(false)
      } finally {
        chmodSync(value, 0o700)
      }
    }
  })

  test('uses bigint filesystem identities and accepts 0775 descendants from a cooperative umask in dry-run and apply', () => {
    const dryRunRoot = root()
    snapshot(dryRunRoot, '01770000000029-0001', NOW - 20 * DAY)
    log(dryRunRoot, 'console.err', DAY)
    chmodSeededDescendants(dryRunRoot, 0o775)
    const before = treeState(dryRunRoot)

    const dryRun = run(dryRunRoot)

    expect(dryRun.exitCode, dryRun.stderr).toBe(0)
    expect(treeState(dryRunRoot)).toEqual(before)

    const applyRoot = root()
    const id = '01770000000030-0001'
    snapshot(applyRoot, id, NOW - 20 * DAY)
    const source = log(applyRoot, 'console.err', DAY)
    chmodSeededDescendants(applyRoot, 0o775)
    const exact = lstatSync(join(applyRoot, 'backups'), { bigint: true })
    expect(typeof exact.dev).toBe('bigint')
    expect(typeof exact.ino).toBe('bigint')

    const applied = run(applyRoot, ['--apply'])

    expect(applied.exitCode, applied.stderr).toBe(0)
    expect(readdirSync(join(applyRoot, 'backups'))).toEqual([])
    expect(existsSync(source)).toBe(false)
    expect(existsSync(`${source}.2026-08-22.gz`)).toBe(true)
  })

  test('builds each filesystem identity from one bigint stat result', () => {
    const value = root()
    const source = log(value, 'mixed-stat.out', DAY)
    const destination = `${source}.2026-08-22.gz`
    const decoy = join(value, 'logs', 'different-inode.keep')
    writeFileSync(decoy, 'different inode and metadata')
    const decoyTime = new Date(NOW - 3 * DAY)
    utimesSync(decoy, decoyTime, decoyTime)
    expect(lstatSync(source, { bigint: true }).ino).not.toBe(
      lstatSync(decoy, { bigint: true }).ino,
    )

    const preload = join(value, 'run', 'mixed-stat-preload.ts')
    writeFileSync(
      preload,
      [
        "import { mock } from 'bun:test'",
        "import * as actual from 'node:fs'",
        'const originalLstatSync = actual.lstatSync',
        "const target = process.env.QIANMO_RETAIN_MIXED_STAT_TARGET ?? ''",
        "const decoy = process.env.QIANMO_RETAIN_MIXED_STAT_DECOY ?? ''",
        "mock.module('node:fs', () => ({",
        '  ...actual,',
        '  lstatSync(path, options) {',
        '    const bigint =',
        "      typeof options === 'object' &&",
        '      options !== null &&',
        "      'bigint' in options &&",
        '      options.bigint === true',
        '    if (path === target && !bigint)',
        '      return originalLstatSync(decoy, options)',
        '    return originalLstatSync(path, options)',
        '  },',
        '}))',
      ].join('\n'),
    )
    const child = Bun.spawnSync(
      ['bun', `--preload=${preload}`, RETAIN_IMPLEMENTATION],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          BETA_RETAIN_ROOT: value,
          BETA_RETAIN_RUN_DIR: join(value, 'run'),
          BETA_RETAIN_LOG_DIR: join(value, 'logs'),
          BETA_RETAIN_BACKUP_STORE: join(value, 'backups'),
          BETA_RETAIN_REGISTRY_STATE: join(value, 'state/registry-agents.json'),
          BETA_RETAIN_REGISTRY_SNAPSHOT_DIR: join(value, 'state/snapshots'),
          BETA_RETAIN_NODES_DIR: join(value, 'nodes'),
          QIANMO_BETA_RETAIN_NOW_EPOCH_MS: String(NOW),
          QIANMO_RETAIN_MIXED_STAT_TARGET: source,
          QIANMO_RETAIN_MIXED_STAT_DECOY: decoy,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(existsSync(source)).toBe(true)
    expect(existsSync(destination)).toBe(false)
    expect(readFileSync(decoy, 'utf8')).toBe('different inode and metadata')
  })

  test('rejects a descendant chmod after capture without deleting planned data', async () => {
    const value = root()
    const id = '01770000000031-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const backups = join(value, 'backups')
    const metadata = join(backups, `${id}.json`)
    const archive = join(backups, `${id}.tar.gz`)
    const metadataBefore = readFileSync(metadata)
    chmodSync(backups, 0o775)

    const result = await runPaused(value, 'backup-before-delete', () =>
      chmodSync(backups, 0o755),
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('父目录在验证后被替换')
    expect(readFileSync(metadata)).toEqual(metadataBefore)
    expect(readFileSync(archive, 'utf8')).toBe(id)
    const payloads = compensationPayloads(value)
    expect(payloads).toHaveLength(1)
    expect(readFileSync(payloads[0])).toEqual(metadataBefore)
  })

  test('keeps a same-owner guard for every descendant directory', () => {
    const implementation = readFileSync(RETAIN_IMPLEMENTATION, 'utf8')
    expect(implementation).toMatch(
      /function assertOwnedDirectoryMetadata[\s\S]*?stat\.uid !== paths\.ownerUid/,
    )

    const uid =
      typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== 0) return

    const value = root()
    const id = '01770000000032-0001'
    snapshot(value, id, NOW - 20 * DAY)
    const backups = join(value, 'backups')
    const original = lstatSync(backups)
    chownSync(backups, 1, original.gid)
    try {
      const result = run(value, ['--apply'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('目录所有者与内测根不同')
      expect(readdirSync(backups).sort()).toEqual([
        `${id}.json`,
        `${id}.tar.gz`,
      ])
    } finally {
      chownSync(backups, original.uid, original.gid)
    }
  })

  test('uses native no-clobber quarantine moves and fails closed on unsupported platforms', () => {
    const implementation = readFileSync(RETAIN_IMPLEMENTATION, 'utf8')
    expect(implementation).toContain('renamex_np')
    expect(implementation).toContain('renameat2')
    expect(implementation).toContain('RENAME_EXCL')
    expect(implementation).toContain('RENAME_NOREPLACE')
    expect(implementation).toContain(
      '当前平台不支持原子 no-clobber quarantine move',
    )
    expect(implementation).not.toContain('renameSync')
  })

  test('does not report a permission-denied lstat as a missing path', () => {
    const value = root()
    const snapshots = join(value, 'state', 'snapshots')
    writeFileSync(
      join(snapshots, 'registry-20260801T000000Z-a.json'),
      '{"version":1}\n',
    )
    chmodSync(snapshots, 0o400)
    try {
      const result = run(value)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).not.toContain('缺失')
    } finally {
      chmodSync(snapshots, 0o700)
    }
  })

  test('does not allow attack-shaped file names to escape or execute anything', () => {
    const value = root()
    const attack = '$(touch SHOULD_NOT_EXIST) *.out'
    const path = log(value, attack, 20 * DAY)
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(() => lstatSync(path)).toThrow()
    expect(() => lstatSync(join(value, 'SHOULD_NOT_EXIST'))).toThrow()
  })

  test('rejects a hardlinked log without changing either link', () => {
    const value = root()
    const outside = mkdtempSync(join(tmpdir(), 'qianmo-retain-hardlink-'))
    roots.push(outside)
    const sentinel = join(outside, 'sentinel')
    writeFileSync(sentinel, 'outside sentinel')
    const linked = join(value, 'logs', 'completed.out')
    linkSync(sentinel, linked)
    const before = [readFileSync(sentinel), readFileSync(linked)]

    const result = run(value, ['--apply'])

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(sentinel)).toEqual(before[0])
    expect(readFileSync(linked)).toEqual(before[1])
    expect(lstatSync(sentinel).size).toBe(before[0].byteLength)
    expect(lstatSync(linked).size).toBe(before[1].byteLength)
  })

  test('rejects hardlinked backup, audit, registry, and published gzip inputs', () => {
    const cases: readonly {
      readonly name: string
      readonly prepare: (value: string, outside: string) => readonly string[]
      readonly args?: readonly string[]
    }[] = [
      {
        name: 'backup archive',
        prepare: (value, outside) => {
          const id = '01770000000030-0001'
          const sentinel = join(outside, 'backup-archive')
          writeFileSync(sentinel, id)
          linkSync(sentinel, join(value, 'backups', `${id}.tar.gz`))
          snapshot(value, id, NOW - 20 * DAY, { archive: false })
          return [sentinel, join(value, 'backups', `${id}.tar.gz`)]
        },
      },
      {
        name: 'backup metadata',
        prepare: (value, outside) => {
          const id = '01770000000031-0001'
          snapshot(value, id, NOW - 20 * DAY, { meta: false })
          const sentinel = join(outside, 'backup-meta')
          writeFileSync(
            sentinel,
            JSON.stringify({ id, createdAt: NOW - 20 * DAY }),
          )
          linkSync(sentinel, join(value, 'backups', `${id}.json`))
          return [sentinel, join(value, 'backups', `${id}.json`)]
        },
      },
      {
        name: 'audit source',
        prepare: (value, outside) => {
          const sentinel = join(outside, 'audit')
          writeFileSync(sentinel, '{"seq":1}\n')
          const path = join(
            value,
            'nodes/beta-1/config/qianmo/audit/trail.ndjson',
          )
          mkdirSync(dirname(path), { recursive: true })
          linkSync(sentinel, path)
          return [sentinel, path]
        },
      },
      {
        name: 'registry source',
        args: ['--apply', '--snapshot-registry'],
        prepare: (value, outside) => {
          const sentinel = join(outside, 'registry')
          writeFileSync(sentinel, '{"version":1}\n')
          const path = join(value, 'state', 'registry-agents.json')
          linkSync(sentinel, path)
          return [sentinel, path]
        },
      },
      {
        name: 'published gzip',
        prepare: (value, outside) => {
          const sentinel = join(outside, 'published.gz')
          writeFileSync(sentinel, 'not gzip')
          const path = join(value, 'logs', 'old.err.gz')
          linkSync(sentinel, path)
          const at = new Date(NOW - 20 * DAY)
          utimesSync(path, at, at)
          return [sentinel, path]
        },
      },
    ]

    for (const item of cases) {
      const value = root()
      const outside = mkdtempSync(join(tmpdir(), 'qianmo-hardlink-input-'))
      roots.push(outside)
      const links = item.prepare(value, outside)
      const before = links.map(path => readFileSync(path))
      const result = run(value, item.args ?? ['--apply'])
      expect(result.exitCode, item.name).not.toBe(0)
      expect(
        links.map(path => readFileSync(path)),
        item.name,
      ).toEqual(before)
      expect(
        links.map(path => lstatSync(path).nlink),
        item.name,
      ).toEqual([2, 2])
    }
  })

  test('dry-run with every surface requested performs zero writes', () => {
    const value = root()
    snapshot(value, '01770000000040-0001', NOW - 20 * DAY)
    log(value, 'console.err', DAY)
    const current = log(value, 'registry.out', 20 * DAY)
    writeFileSync(join(value, 'run', 'registry.pid'), String(process.pid))
    audit(value, 'beta-1', '{"seq":1}\n')
    ledger(value, 'beta-1', 'planner', 10 * 1024 * 1024 + 1)
    writeFileSync(join(value, 'state', 'registry-agents.json'), '{"v":1}\n')
    const before = treeState(value)

    const result = run(value, ['--dry-run', '--snapshot-registry'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('WARN')
    expect(treeState(value)).toEqual(before)
    expect(readFileSync(current, 'utf8')).toBe('registry.out')
  })

  test('fails closed and reports remaining orphan backup artifacts', () => {
    const value = root()
    writeFileSync(
      join(value, 'backups', '01770000000999-0001.tar.gz'),
      'orphan',
    )

    const result = run(value)

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('剩余=1')
    expect(result.stderr).toContain('缺少元数据')
    expect(readdirSync(join(value, 'backups'))).toEqual([
      '01770000000999-0001.tar.gz',
    ])
  })

  test('compresses an expired raw log before deleting the verified gzip later', () => {
    const value = root()
    const source = log(value, 'retired.out', 15 * DAY)
    const destination = `${source}.2026-08-08.gz`

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(existsSync(source)).toBe(false)
    expect(existsSync(destination)).toBe(true)
    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(existsSync(destination)).toBe(false)
  })

  test('defers an old verified gzip for a full scan when its raw peer still exists', () => {
    const value = root()
    const source = log(value, 'retired.out', 15 * DAY)
    const destination = `${source}.2026-08-08.gz`

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(existsSync(destination)).toBe(true)
    log(value, 'retired.out', 15 * DAY)

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(existsSync(source)).toBe(false)
    expect(existsSync(destination)).toBe(true)

    expect(run(value, ['--apply']).exitCode).toBe(0)
    expect(existsSync(destination)).toBe(false)
  })

  test('preserves both sides of an expired raw and divergent gzip conflict', () => {
    const value = root()
    const backupId = '01770000000049-0001'
    snapshot(value, backupId, NOW - 20 * DAY)
    const source = log(value, 'retired.out', 15 * DAY)
    const destination = `${source}.2026-08-08.gz`
    writeFileSync(destination, 'divergent gzip')
    const old = new Date(NOW - 15 * DAY)
    utimesSync(destination, old, old)

    const result = run(value, ['--apply'])

    expect(result.exitCode).not.toBe(0)
    expect(readFileSync(source, 'utf8')).toBe('retired.out')
    expect(readFileSync(destination, 'utf8')).toBe('divergent gzip')
    expect(
      readdirSync(join(value, 'backups'))
        .sort()
        .filter(name => name.includes(backupId)),
    ).toEqual([`${backupId}.json`, `${backupId}.tar.gz`])
    expect(existsSync(join(value, 'run', '.retain-apply-lock'))).toBe(false)
  })

  test('rejects metadata timestamps outside Date range or in the future', () => {
    for (const createdAt of [Number.MAX_SAFE_INTEGER, NOW + 1]) {
      const value = root()
      snapshot(value, `0177000000099${roots.length}-0001`, createdAt)
      const result = run(value)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('剩余=1')
      expect(result.stderr).toContain('时间戳无效')
    }
  })

  test('reports every missing or malformed backup record as remaining', () => {
    const cases: readonly string[] = [
      '{',
      JSON.stringify({ id: 'wrong', createdAt: NOW - DAY }),
      JSON.stringify({ id: '01770000000050-0001' }),
      JSON.stringify({ id: '01770000000050-0001', createdAt: null }),
      JSON.stringify({ id: '01770000000050-0001', createdAt: 'yesterday' }),
      JSON.stringify({ id: '01770000000050-0001', createdAt: 1.5 }),
      '{"id":"01770000000050-0001","createdAt":NaN}',
      JSON.stringify({
        id: '01770000000050-0001',
        createdAt: 8_640_000_000_000_001,
      }),
    ]
    for (const metadata of cases) {
      const value = root()
      const id = '01770000000050-0001'
      snapshot(value, id, NOW - DAY)
      writeFileSync(join(value, 'backups', `${id}.json`), metadata)
      const result = run(value)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('剩余=1')
      expect(readdirSync(join(value, 'backups')).sort()).toEqual([
        `${id}.json`,
        `${id}.tar.gz`,
      ])
    }

    const missingArchive = root()
    snapshot(missingArchive, '01770000000051-0001', NOW - DAY, {
      archive: false,
    })
    const result = run(missingArchive)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('剩余=1')
    expect(readdirSync(join(missingArchive, 'backups'))).toEqual([
      '01770000000051-0001.json',
    ])
  })

  test('aggregates malformed backup records and performs no planned data operation', () => {
    const value = root()
    const malformed = '01770000000060-0001'
    const missingArchive = '01770000000061-0001'
    snapshot(value, malformed, NOW - 20 * DAY)
    writeFileSync(join(value, 'backups', `${malformed}.json`), '{')
    snapshot(value, missingArchive, NOW - 20 * DAY, { archive: false })
    const source = log(value, 'console.err', DAY)
    const destination = `${source}.2026-08-22.gz`
    const auditSource = audit(value, 'beta-1', '{"seq":1}\n')
    const auditDestination = join(
      dirname(auditSource),
      'archive',
      'trail-2026-W34.ndjson',
    )
    mkdirSync(dirname(auditDestination))
    writeFileSync(auditDestination, '{"seq":0}\n')

    const result = run(value, ['--apply'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.match(/^FAIL :/gm)).toHaveLength(3)
    expect(result.stderr).toContain(`${malformed}.json`)
    expect(result.stderr).toContain(`${missingArchive}.tar.gz`)
    expect(result.stderr).toContain('封存目标已存在且内容不同')
    expect(existsSync(source)).toBe(true)
    expect(existsSync(destination)).toBe(false)
    expect(readFileSync(auditSource, 'utf8')).toBe('{"seq":1}\n')
    expect(readFileSync(auditDestination, 'utf8')).toBe('{"seq":0}\n')
    expect(existsSync(join(value, 'run', '.retain-apply-lock'))).toBe(false)
  })
})
