// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ProtocolError, ProtocolErrorCode } from '@qianmo/protocol'
import { occConfigPath } from 'src/config/paths.js'

import {
  BLOB_DIR_SEGMENTS,
  BlobStore,
  blobStoreDir,
  isBlobRef,
} from '../src/blob.js'
import type { TempConfig } from './helpers.js'
import { useTempConfig } from './helpers.js'

let config: TempConfig

beforeAll(() => {
  config = useTempConfig('qianmo-adapter-blob-')
})

afterAll(() => {
  config.restore()
})

async function expectUnavailable(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ProtocolError)
  expect((thrown as ProtocolError).code).toBe(
    ProtocolErrorCode.E_PAYLOAD_UNAVAILABLE,
  )
}

describe('the staging path is derived, never hand-built', () => {
  // CLAUDE.md §1.1②: every path comes out of src/config/paths.ts. Qianmo layers
  // a second identity on top of the base's isolation, and a literal `.occ`
  // would punch straight through it.
  test('blobStoreDir() is occConfigPath() of the segments', () => {
    expect(blobStoreDir()).toBe(occConfigPath(...BLOB_DIR_SEGMENTS))
  })

  test('it follows the config root the base itself resolves', () => {
    expect(blobStoreDir().startsWith(config.configDir)).toBe(true)
  })

  test('a default-constructed store lands there', () => {
    expect(new BlobStore().dir).toBe(blobStoreDir())
  })
})

describe('put / get round trip', () => {
  test('returns a well-formed reference and restores the payload', async () => {
    const store = new BlobStore({ dir: join(config.root, 'blobs-roundtrip') })
    const payload = { diff: 'x'.repeat(1000), files: ['a.ts', 'b.ts'] }

    const ref = await store.put(payload, {
      taskId: 'task-1',
      expiresAt: Date.now() + 60_000,
    })

    expect(isBlobRef(ref)).toBe(true)
    expect(ref.$blob.bytes).toBe(
      Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    )
    expect(ref.$blob.sha256).toMatch(/^[0-9a-f]{64}$/)
    await expect(store.get(ref)).resolves.toEqual(payload)
  })

  // The record stores the serialized payload as a string, so the checksum
  // covers the exact bytes read back. Nesting it as JSON would let a
  // JSON.parse round trip reorder integer-like keys and fail its own checksum.
  test('survives payloads that a JSON round trip would reorder', async () => {
    const store = new BlobStore({ dir: join(config.root, 'blobs-keys') })
    const payload = {
      '2': 'two',
      '1': 'one',
      z: '阡陌',
      a: [1, { '10': 'ten' }],
    }

    const ref = await store.put(payload, {
      taskId: 'task-2',
      expiresAt: Date.now() + 60_000,
    })
    await expect(store.get(ref)).resolves.toEqual(payload)
  })

  test('handles primitive and null payloads', async () => {
    const store = new BlobStore({ dir: join(config.root, 'blobs-prims') })
    for (const payload of [null, 42, 'plain', true, []]) {
      const ref = await store.put(payload, {
        taskId: 'task-3',
        expiresAt: Date.now() + 60_000,
      })
      await expect(store.get(ref)).resolves.toEqual(payload)
    }
  })
})

describe('§9.3.6: an unavailable blob is reported, never silently downgraded', () => {
  test('a reclaimed blob raises E_PAYLOAD_UNAVAILABLE', async () => {
    const dir = join(config.root, 'blobs-gone')
    const store = new BlobStore({ dir })
    const ref = await store.put(
      { big: true },
      { taskId: 'task-4', expiresAt: Date.now() + 60_000 },
    )
    await rm(join(dir, `${ref.$blob.id}.json`))
    await expectUnavailable(store.get(ref))
  })

  test('a tampered payload fails its checksum', async () => {
    const dir = join(config.root, 'blobs-tamper')
    const store = new BlobStore({ dir })
    const ref = await store.put(
      { secret: 'original' },
      { taskId: 'task-5', expiresAt: Date.now() + 60_000 },
    )

    const path = join(dir, `${ref.$blob.id}.json`)
    const record = JSON.parse(await readFile(path, 'utf-8')) as Record<
      string,
      unknown
    >
    // Same length, so only the digest can catch it.
    record['payloadJson'] = JSON.stringify({ secret: 'tampered' })
    await writeFile(path, JSON.stringify(record), 'utf-8')

    await expectUnavailable(store.get(ref))
  })

  test('a reference that disagrees with the record is rejected', async () => {
    const dir = join(config.root, 'blobs-mismatch')
    const store = new BlobStore({ dir })
    const ref = await store.put(
      { a: 1 },
      { taskId: 'task-6', expiresAt: Date.now() + 60_000 },
    )
    await expectUnavailable(
      store.get({ $blob: { ...ref.$blob, bytes: ref.$blob.bytes + 1 } }),
    )
  })

  test('garbage in the staging directory is rejected, not returned', async () => {
    const dir = join(config.root, 'blobs-garbage')
    const store = new BlobStore({ dir })
    const ref = await store.put(
      { a: 1 },
      { taskId: 'task-7', expiresAt: Date.now() + 60_000 },
    )
    await writeFile(
      join(dir, `${ref.$blob.id}.json`),
      'not json at all',
      'utf-8',
    )
    await expectUnavailable(store.get(ref))
  })
})

describe('§9.3.5: a blob lives exactly as long as its task deadline', () => {
  test('prune reclaims expired blobs and keeps live ones', async () => {
    const dir = join(config.root, 'blobs-prune')
    const store = new BlobStore({ dir })
    const now = 1_700_000_000_000

    const stale = await store.put({ n: 1 }, { taskId: 't', expiresAt: now - 1 })
    const live = await store.put(
      { n: 2 },
      { taskId: 't', expiresAt: now + 60_000 },
    )

    expect(await store.prune(now)).toBe(1)
    expect((await readdir(dir)).sort()).toEqual([`${live.$blob.id}.json`])
    await expectUnavailable(store.get(stale))
    await expect(store.get(live)).resolves.toEqual({ n: 2 })
  })

  test('pruning a directory that was never created is a no-op', async () => {
    const store = new BlobStore({ dir: join(config.root, 'blobs-absent') })
    expect(await store.prune(Date.now())).toBe(0)
  })
})
