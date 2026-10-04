// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BackupEventType,
  FileSnapshotStore,
  digestOf,
  isSnapshotId,
} from '../src/index.js'
import { cleanupTemporaries, tempDir } from './helpers.js'

afterEach(cleanupTemporaries)

const ARCHIVE = new Uint8Array([1, 2, 3, 4, 5])

function storeAt(now: () => number = () => 1_800_000_000_000): {
  store: FileSnapshotStore
  root: string
} {
  const root = join(tempDir(), 'snapshots')
  return { store: new FileSnapshotStore({ root, now }), root }
}

describe('creating snapshots', () => {
  test('records what it stored, not what the caller claimed', async () => {
    const { store } = storeAt()
    const meta = await store.writer().create({
      workspace: '/workspace',
      reason: 'pre-task',
      archive: ARCHIVE,
      label: 'task-7',
    })
    expect(meta.workspace).toBe('/workspace')
    expect(meta.reason).toBe('pre-task')
    expect(meta.bytes).toBe(ARCHIVE.byteLength)
    // The digest is the store's own, computed from the bytes it wrote.
    expect(meta.sha256).toBe(digestOf(ARCHIVE))
    expect(isSnapshotId(meta.id)).toBe(true)
    expect(meta.label).toBe('task-7')
  })

  test('two snapshots in the same millisecond are still two snapshots', async () => {
    const { store } = storeAt(() => 1_800_000_000_000)
    const first = await store.writer().create({
      workspace: '/w',
      reason: 'scheduled',
      archive: ARCHIVE,
    })
    const second = await store.writer().create({
      workspace: '/w',
      reason: 'scheduled',
      archive: ARCHIVE,
    })
    expect(second.id).not.toBe(first.id)
    expect(await store.list('/w')).toHaveLength(2)
  })

  test('the writer face has exactly one method', () => {
    // The type says so; this says so about the object that is actually handed
    // over, which is what survives a cast.
    const { store } = storeAt()
    const writer = store.writer()
    expect(Object.keys(writer)).toEqual(['create'])
    expect(
      Object.getOwnPropertyNames(writer).filter(name =>
        /delete|remove|destroy|purge/i.test(name),
      ),
    ).toEqual([])
  })

  test('the store class offers no removal method either', () => {
    const names = [
      ...Object.getOwnPropertyNames(FileSnapshotStore.prototype),
      ...Object.getOwnPropertyNames(storeAt().store),
    ]
    expect(
      names.filter(name =>
        /delete|remove|destroy|purge|prune|unlink/i.test(name),
      ),
    ).toEqual([])
  })

  test('an empty or oversized archive is refused', async () => {
    const { store } = storeAt()
    await expect(
      store.writer().create({
        workspace: '/w',
        reason: 'manual',
        archive: new Uint8Array(),
      }),
    ).rejects.toThrow(/empty/)
    const small = new FileSnapshotStore({
      root: join(tempDir(), 'small'),
      maxBytes: 3,
    })
    await expect(
      small
        .writer()
        .create({ workspace: '/w', reason: 'manual', archive: ARCHIVE }),
    ).rejects.toThrow(/ceiling/)
  })

  test('files land 0600 in a 0700 directory', async () => {
    const { store, root } = storeAt()
    const meta = await store
      .writer()
      .create({ workspace: '/w', reason: 'manual', archive: ARCHIVE })
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, `${meta.id}.tar.gz`)).mode & 0o777).toBe(0o600)
  })

  test('an existing object is never overwritten', async () => {
    // The counter makes a collision a bug rather than a scenario, so this
    // reaches past it: the `wx` flag is the last line of defence and it must
    // actually be there.
    const { store, root } = storeAt()
    const meta = await store
      .writer()
      .create({ workspace: '/w', reason: 'manual', archive: ARCHIVE })
    const path = join(root, `${meta.id}.tar.gz`)
    expect(() =>
      writeFileSync(path, new Uint8Array([9]), { flag: 'wx' }),
    ).toThrow()
    expect(readdirSync(root).sort()).toEqual(
      [`${meta.id}.json`, `${meta.id}.tar.gz`].sort(),
    )
  })
})

describe('reading them back', () => {
  test.each([
    '9999',
    '10000',
    '100000',
  ])('reads an existing snapshot with sequence %s', async sequence => {
    const { store, root } = storeAt()
    const id = `01800000000000-${sequence}`
    mkdirSync(root)
    writeFileSync(join(root, `${id}.tar.gz`), ARCHIVE)
    expect(await store.read(id)).toEqual(ARCHIVE)
    expect(store.audit.count(BackupEventType.SnapshotRead)).toBe(1)
  })

  test('read returns the bytes and audits the read', async () => {
    const { store } = storeAt()
    const meta = await store
      .writer()
      .create({ workspace: '/w', reason: 'manual', archive: ARCHIVE })
    expect(await store.read(meta.id)).toEqual(ARCHIVE)
    expect(store.audit.count(BackupEventType.SnapshotRead)).toBe(1)
    expect(store.audit.count(BackupEventType.SnapshotCreated)).toBe(1)
  })

  test('an id that could traverse the filesystem is refused before any read', async () => {
    const { store } = storeAt()
    expect(isSnapshotId('../../etc/passwd')).toBe(false)
    expect(await store.read('../../etc/passwd')).toBeNull()
  })

  test('latest is the newest for that workspace only', async () => {
    let clock = 1_800_000_000_000
    const { store } = storeAt(() => clock)
    await store
      .writer()
      .create({ workspace: '/a', reason: 'scheduled', archive: ARCHIVE })
    clock += 1_000
    const newest = await store
      .writer()
      .create({ workspace: '/a', reason: 'scheduled', archive: ARCHIVE })
    clock += 1_000
    await store
      .writer()
      .create({ workspace: '/b', reason: 'scheduled', archive: ARCHIVE })
    expect((await store.latest('/a'))?.id).toBe(newest.id)
    expect(await store.list('/b')).toHaveLength(1)
  })

  test('one torn sidecar hides one snapshot, not the rest', async () => {
    const { store, root } = storeAt()
    const first = await store
      .writer()
      .create({ workspace: '/w', reason: 'manual', archive: ARCHIVE })
    await store
      .writer()
      .create({ workspace: '/w', reason: 'manual', archive: ARCHIVE })
    writeFileSync(join(root, `${first.id}.json`), '{ truncated')
    const listed = await store.list('/w')
    expect(listed).toHaveLength(1)
    // And the archive is still on disk, still readable by id.
    expect(await store.read(first.id)).toEqual(ARCHIVE)
  })

  test('listing a store that was never written is empty, not an error', async () => {
    const store = new FileSnapshotStore({ root: join(tempDir(), 'absent') })
    expect(await store.list()).toEqual([])
  })
})
