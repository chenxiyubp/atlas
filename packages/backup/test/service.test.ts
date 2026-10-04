// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  BACKUP_SURFACE,
  BackupOp,
  DESTRUCTIVE_WORDS,
  FileSnapshotStore,
  assertBackupSurfaceIsSafe,
  remoteSnapshotWriter,
  startBackupService,
  type BackupRoute,
} from '../src/index.js'
import {
  ARCHIVE_TOKEN,
  WRITE_TOKEN,
  cleanupTemporaries,
  tempDir,
} from './helpers.js'

const services: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  cleanupTemporaries()
})

function start(): { base: string; store: FileSnapshotStore } {
  const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
  const service = startBackupService({
    store,
    writeToken: WRITE_TOKEN,
    archiveToken: ARCHIVE_TOKEN,
  })
  services.push(service)
  return { base: service.url as string, store }
}

describe('the surface assertion', () => {
  test('the shipped surface loads — and is only these three ops', () => {
    expect([...BACKUP_SURFACE.keys()].sort()).toEqual(
      [
        BackupOp.CreateSnapshot,
        BackupOp.ListSnapshots,
        BackupOp.ReadSnapshot,
      ].sort(),
    )
    expect(() => assertBackupSurfaceIsSafe(BACKUP_SURFACE)).not.toThrow()
  })

  test('it refuses a removal route, whatever it is called', () => {
    // The red direction. A check that has only ever been handed the good value
    // is a check nobody has watched fail.
    for (const word of DESTRUCTIVE_WORDS) {
      const bad = new Map<string, BackupRoute>([
        [
          `${word}Snapshot`,
          {
            method: 'POST',
            path: '/snapshot',
            audience: 'archive',
            rationale: 'test fixture',
          },
        ],
      ])
      expect(() => assertBackupSurfaceIsSafe(bad)).toThrow(/destructive word/)
    }
  })

  test('it refuses a mutating HTTP method', () => {
    const bad = new Map<string, BackupRoute>([
      [
        'stash',
        {
          method: 'PUT' as BackupRoute['method'],
          path: '/snapshot',
          audience: 'archive',
          rationale: 'test fixture',
        },
      ],
    ])
    expect(() => assertBackupSurfaceIsSafe(bad)).toThrow(/uses method/)
  })

  test('it refuses to widen the writer audience', () => {
    // The property that makes the write credential a write credential.
    const bad = new Map<string, BackupRoute>([
      [
        BackupOp.CreateSnapshot,
        {
          method: 'POST',
          path: '/snapshot',
          audience: 'writer',
          rationale: 'ok',
        },
      ],
      [
        BackupOp.ListSnapshots,
        {
          method: 'GET',
          path: '/snapshots',
          audience: 'writer',
          rationale: 'not ok',
        },
      ],
    ])
    expect(() => assertBackupSurfaceIsSafe(bad)).toThrow(
      /writer audience may only reach/,
    )
  })

  test('it refuses a surface with no writer route at all', () => {
    const bad = new Map<string, BackupRoute>([
      [
        BackupOp.ListSnapshots,
        {
          method: 'GET',
          path: '/snapshots',
          audience: 'archive',
          rationale: 'ok',
        },
      ],
    ])
    expect(() => assertBackupSurfaceIsSafe(bad)).toThrow(/exactly one route/)
  })
})

describe('the service', () => {
  test('refuses to start with weak or identical tokens', () => {
    const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
    expect(() =>
      startBackupService({
        store,
        writeToken: 'short',
        archiveToken: ARCHIVE_TOKEN,
      }),
    ).toThrow(/at least/)
    expect(() =>
      startBackupService({
        store,
        writeToken: WRITE_TOKEN,
        archiveToken: WRITE_TOKEN,
      }),
    ).toThrow(/must differ/)
  })

  test('a create needs a workspace and a known reason', async () => {
    const { base } = start()
    const missing = await fetch(`${base}/snapshot?reason=manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
      body: new Uint8Array([1]) as unknown as BodyInit,
    })
    expect(missing.status).toBe(400)
    const nonsense = await fetch(`${base}/snapshot?workspace=/w&reason=maybe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
      body: new Uint8Array([1]) as unknown as BodyInit,
    })
    expect(nonsense.status).toBe(400)
  })

  test('an unknown route is a 404, not a surprise', async () => {
    const { base } = start()
    const response = await fetch(`${base}/snapshot/../secrets`, {
      headers: { authorization: `Bearer ${ARCHIVE_TOKEN}` },
    })
    expect([400, 404]).toContain(response.status)
  })

  test('the remote writer round-trips through the real service', async () => {
    const { base, store } = start()
    const writer = remoteSnapshotWriter({ url: base, token: WRITE_TOKEN })
    const meta = await writer.create({
      workspace: '/workspace',
      reason: 'scheduled',
      archive: new Uint8Array([7, 7, 7]),
    })
    expect(meta.bytes).toBe(3)
    expect(await store.read(meta.id)).toEqual(new Uint8Array([7, 7, 7]))
  })

  test('the remote writer surfaces a refusal instead of returning silently', async () => {
    const { base } = start()
    const writer = remoteSnapshotWriter({ url: base, token: ARCHIVE_TOKEN })
    await expect(
      writer.create({
        workspace: '/workspace',
        reason: 'scheduled',
        archive: new Uint8Array([7]),
      }),
    ).rejects.toThrow(/refused/)
  })

  test('the writer client has one method and no way to name an existing snapshot', () => {
    const writer = remoteSnapshotWriter({ url: 'http://x', token: WRITE_TOKEN })
    expect(Object.keys(writer)).toEqual(['create'])
  })
})
