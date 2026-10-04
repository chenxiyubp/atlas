// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two processes changing the same entries at the same time.
 *
 * `revoke` and `invalidate` are read-modify-write on one file: read the record,
 * add a mark, rename a new copy over it. Two writers that both read before
 * either renames each write back a copy missing the other's mark, and the one
 * that renames last wins. For `revoke` that is the worst kind of loss — the
 * operator was told the entry is withdrawn, and it is still being injected.
 *
 * The writers here are real processes, because the race is between processes:
 * inside one process every store call is synchronous and cannot interleave.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStoreError } from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

const RUNNER = join(import.meta.dir, 'concurrent-mutator.runner.ts')
const ENTRIES = 40

type Outcome = { id: string; ok: boolean; error?: string }

let sandbox: Sandbox

beforeEach(() => {
  sandbox = createSandbox()
})

afterEach(() => {
  sandbox.dispose()
})

function seed(count: number): string[] {
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    ids.push(
      sandbox.store.write({
        scope: { layer: 'working', projectKey: 'v-reviewer', taskId: 'v-a' },
        title: `decision ${index}`,
        summary: `decision ${index}`,
        body: 'x'.repeat(2_000),
        source: { kind: 'user', id: 'qm-cli:test' },
      }).id,
    )
  }
  return ids
}

/** Start both writers, release them together, collect what each reported. */
async function race(
  writers: readonly (readonly [operation: string, by: string])[],
  ids: readonly string[],
): Promise<Outcome[][]> {
  const goFile = join(sandbox.root, '..', 'go')
  const runs = writers.map(([operation, by]) => {
    const child = spawn(
      process.execPath,
      [RUNNER, sandbox.root, goFile, operation, by, ...ids],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    const ready = new Promise<void>(resolve => {
      child.stdout.on('data', chunk => {
        stdout += String(chunk)
        if (stdout.startsWith('ready\n')) resolve()
      })
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const done = new Promise<Outcome[]>((resolve, reject) => {
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`writer exited ${code}: ${stderr}`))
          return
        }
        resolve(JSON.parse(stdout.slice('ready\n'.length)) as Outcome[])
      })
    })
    return { ready, done }
  })
  await Promise.all(runs.map(run => run.ready))
  writeFileSync(goFile, '')
  return await Promise.all(runs.map(run => run.done))
}

describe('concurrent changes to the same entry', () => {
  test('a revoke and an invalidate racing each other both land', async () => {
    const ids = seed(ENTRIES)
    const [revokes, invalidates] = await race(
      [
        ['revoke', 'writer-a'],
        ['invalidate', 'writer-b'],
      ],
      ids,
    )

    // The two operations touch different fields, so neither refuses the
    // other: both report success for every entry, and both marks must be on
    // disk afterwards.
    expect(revokes?.filter(outcome => !outcome.ok)).toEqual([])
    expect(invalidates?.filter(outcome => !outcome.ok)).toEqual([])
    const reopened = sandbox.reopen()
    const lost = ids.filter(id => {
      const entry = reopened.getEntry(id)
      return entry?.expiredAt === null || entry?.invalidAt === null
    })
    expect(lost).toEqual([])
  }, 30_000)

  test('two revokes of the same entry: exactly one succeeds, and its reason is the one kept', async () => {
    const ids = seed(ENTRIES)
    const [first, second] = await race(
      [
        ['revoke', 'writer-a'],
        ['revoke', 'writer-b'],
      ],
      ids,
    )

    const reopened = sandbox.reopen()
    const wrong: string[] = []
    for (const [index, id] of ids.entries()) {
      const a = first?.[index]
      const b = second?.[index]
      const winners = [
        a?.ok ? 'writer-a' : null,
        b?.ok ? 'writer-b' : null,
      ].filter(winner => winner !== null)
      const kept = reopened.getEntry(id)?.retirement?.by
      if (winners.length !== 1 || winners[0] !== kept) {
        wrong.push(`${id}: succeeded=${winners.join('+')} kept=${kept}`)
      }
      // The loser was refused for the documented reason, not a lock failure.
      const loser = a?.ok ? b : a
      if (loser !== undefined && !loser.ok) {
        expect(loser.error).toContain('already retired')
      }
    }
    expect(wrong).toEqual([])
  }, 30_000)

  test('a writer that cannot get the lock is refused, and changes nothing', () => {
    const [id] = seed(1)
    const entryFile = join(
      sandbox.root,
      'working',
      'v-reviewer',
      'v-a',
      `${id}.md`,
    )
    // Somebody else is mid-change: a fresh lock beside the entry.
    writeFileSync(`${entryFile}.lock`, '4242\n')

    const started = Date.now()
    let refusal: unknown
    try {
      sandbox.store.revoke(id as string, { reason: 'r', by: 'writer-a' })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(MemoryStoreError)
    expect(String(refusal)).toContain('being changed by another writer')
    // It waited for the holder before giving up, rather than failing at once.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(sandbox.reopen().getEntry(id as string)?.expiredAt).toBeNull()
    // And it did not take the other writer's lock away with it.
    expect(existsSync(`${entryFile}.lock`)).toBe(true)
  }, 10_000)

  test('a lock left behind by a writer that died is cleared after 30 s', () => {
    const [id] = seed(1)
    const entryFile = join(
      sandbox.root,
      'working',
      'v-reviewer',
      'v-a',
      `${id}.md`,
    )
    writeFileSync(`${entryFile}.lock`, '4242\n')
    const minuteAgo = new Date(Date.now() - 60_000)
    utimesSync(`${entryFile}.lock`, minuteAgo, minuteAgo)

    const revoked = sandbox.store.revoke(id as string, {
      reason: 'stale lock was cleared',
      by: 'writer-a',
    })
    expect(revoked.retirement?.by).toBe('writer-a')
    expect(existsSync(`${entryFile}.lock`)).toBe(false)
  })

  test('no lock or temporary file is left behind', async () => {
    const ids = seed(8)
    await race(
      [
        ['revoke', 'writer-a'],
        ['invalidate', 'writer-b'],
      ],
      ids,
    )
    const scopeDir = join(sandbox.root, 'working', 'v-reviewer', 'v-a')
    expect(readdirSync(scopeDir).filter(name => !name.endsWith('.md'))).toEqual(
      [],
    )
  }, 30_000)
})
