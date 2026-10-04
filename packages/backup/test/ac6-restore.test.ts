// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AC-6(b) and (c), end to end on this machine.
 *
 * **(b)** an agent deletes its workspace; the backup it has no power to remove
 * puts the workspace back, and `git status` afterwards says what it said before
 * — within ten minutes.
 *
 * **(c)** the agent tries to delete the backup and cannot.
 *
 * What is real here: a real git repository with a commit, a staged change, an
 * unstaged change, an untracked file and an executable bit; a real `rm -rf`; a
 * real archive through the same socket surface the sandbox uses, with the same
 * write-only credential; a real restore. What is *not* real is the sandbox
 * boundary itself — on this machine both sides are one process. The boundary is
 * modelled the way it is deployed, though: the writing side holds only the
 * write token and reaches the store only over HTTP, so every refusal below is
 * the refusal the real deployment would produce.
 *
 * The ten-minute budget is asserted but is not the interesting number: it is
 * there so that a change that makes restore pathologically slow fails here
 * rather than during an acceptance run.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BackupEventType,
  FileSnapshotStore,
  archiveDirectory,
  remoteSnapshotWriter,
  restoreWorkspace,
  startBackupService,
  tarAvailable,
} from '../src/index.js'
import {
  ARCHIVE_TOKEN,
  WRITE_TOKEN,
  cleanupTemporaries,
  git,
  tempDir,
} from './helpers.js'

const services: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  cleanupTemporaries()
})

/** A repository with something of every kind git reports on. */
async function makeWorkspace(): Promise<string> {
  const workspace = join(tempDir('qianmo-ac6-'), 'workspace')
  mkdirSync(workspace, { recursive: true })
  await git(['init', '--initial-branch=main'], workspace)
  writeFileSync(join(workspace, 'README.md'), '# atlas\n')
  writeFileSync(join(workspace, 'run.sh'), '#!/bin/sh\necho hi\n', {
    mode: 0o755,
  })
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n')
  await git(['add', '.'], workspace)
  await git(['commit', '-m', 'initial'], workspace)

  // Now dirty it, so `git status` has something to say.
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 2\n')
  writeFileSync(join(workspace, 'staged.txt'), 'staged\n')
  await git(['add', 'staged.txt'], workspace)
  writeFileSync(join(workspace, 'untracked.txt'), 'untracked\n')
  return workspace
}

describe('AC-6(b) — a deleted workspace comes back', () => {
  test('rm -rf, restore, and git status says exactly what it said before', async () => {
    expect(await tarAvailable()).toBe(true)
    const workspace = await makeWorkspace()
    const before = await git(['status', '--porcelain=v1'], workspace)
    expect(before.code).toBe(0)
    expect(before.stdout.trim().length).toBeGreaterThan(0)
    const headBefore = await git(['rev-parse', 'HEAD'], workspace)

    // The sandbox side: a write-only credential and an HTTP surface.
    const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
    const service = startBackupService({
      store,
      writeToken: WRITE_TOKEN,
      archiveToken: ARCHIVE_TOKEN,
    })
    services.push(service)
    const writer = remoteSnapshotWriter({
      url: service.url as string,
      token: WRITE_TOKEN,
    })
    const meta = await writer.create({
      workspace,
      reason: 'pre-task',
      archive: await archiveDirectory(workspace),
      label: 'ac6',
    })

    // The agent does the worst thing it can do.
    rmSync(workspace, { recursive: true, force: true })
    expect(existsSync(workspace)).toBe(false)

    // The host side restores. Ten minutes is the budget; this is milliseconds.
    const bytes = await store.read(meta.id)
    expect(bytes).not.toBeNull()
    const outcome = await restoreWorkspace({
      directory: workspace,
      archive: bytes as Uint8Array,
      meta,
      audit: store.audit,
    })
    expect(outcome.elapsedMs).toBeLessThan(10 * 60_000)

    const after = await git(['status', '--porcelain=v1'], workspace)
    expect(after.code).toBe(0)
    expect(after.stdout).toBe(before.stdout)
    expect((await git(['rev-parse', 'HEAD'], workspace)).stdout).toBe(
      headBefore.stdout,
    )
    // The executable bit survived — git would have reported a modification if
    // it had not, which is why `git status` matching is the judgement.
    expect(after.stdout).not.toContain('run.sh')
    expect(store.audit.count(BackupEventType.WorkspaceRestored)).toBe(1)
  }, 60_000)

  test('a restore refuses to run over surviving files', async () => {
    const workspace = await makeWorkspace()
    const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
    const meta = await store.writer().create({
      workspace,
      reason: 'manual',
      archive: await archiveDirectory(workspace),
    })
    const bytes = (await store.read(meta.id)) as Uint8Array
    await expect(
      restoreWorkspace({ directory: workspace, archive: bytes, meta }),
    ).rejects.toThrow(/still holds/)
  }, 60_000)

  test('a corrupted archive is refused rather than half-unpacked', async () => {
    const workspace = await makeWorkspace()
    const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
    const meta = await store.writer().create({
      workspace,
      reason: 'manual',
      archive: await archiveDirectory(workspace),
    })
    const target = join(tempDir(), 'restored')
    await expect(
      restoreWorkspace({
        directory: target,
        archive: new Uint8Array([1, 2, 3]),
        meta,
      }),
    ).rejects.toThrow(/digest/)
  }, 60_000)
})

describe('AC-6(c) — the agent cannot remove its backups', () => {
  test('the write credential creates, and then cannot delete or read', async () => {
    const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
    const service = startBackupService({
      store,
      writeToken: WRITE_TOKEN,
      archiveToken: ARCHIVE_TOKEN,
    })
    services.push(service)
    const base = service.url as string

    // Control group first, exactly as P2.5 did: prove the credential and the
    // route really work, so the refusals below are refusals and not typos.
    const created = await fetch(`${base}/snapshot?workspace=/w&reason=manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
      body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
    })
    expect(created.status).toBe(201)
    const meta = (await created.json()) as { id: string }

    // Now the agent tries every removal shape it can reach by hand.
    for (const attempt of [
      { method: 'DELETE', path: `/snapshot/${meta.id}` },
      { method: 'DELETE', path: '/snapshots' },
      { method: 'PUT', path: `/snapshot/${meta.id}` },
      { method: 'PATCH', path: `/snapshot/${meta.id}` },
    ]) {
      const response = await fetch(`${base}${attempt.path}`, {
        method: attempt.method,
        headers: { authorization: `Bearer ${WRITE_TOKEN}` },
      })
      expect(response.status).toBe(405)
    }
    expect(store.audit.count(BackupEventType.MutationDenied)).toBe(4)

    // Reading is not its business either: an agent that cannot list backups
    // cannot go looking for the one worth attacking.
    const listed = await fetch(`${base}/snapshots`, {
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
    expect(listed.status).toBe(403)
    const read = await fetch(`${base}/snapshot/${meta.id}`, {
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
    expect(read.status).toBe(403)
    expect(store.audit.count(BackupEventType.ReadDenied)).toBe(2)

    // And after all of that, the snapshot is still there.
    expect(await store.read(meta.id)).toEqual(new Uint8Array([1, 2, 3]))
  }, 30_000)

  test('an unknown or absent credential gets nowhere', async () => {
    const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
    const service = startBackupService({
      store,
      writeToken: WRITE_TOKEN,
      archiveToken: ARCHIVE_TOKEN,
    })
    services.push(service)
    const base = service.url as string

    expect((await fetch(`${base}/snapshots`)).status).toBe(401)
    expect(
      (
        await fetch(`${base}/snapshots`, {
          headers: { authorization: 'Bearer wrong-token-entirely-here' },
        })
      ).status,
    ).toBe(401)
    expect(store.audit.count(BackupEventType.AccessDenied)).toBe(2)
  }, 30_000)

  test('the archive credential reads but does not create', async () => {
    const store = new FileSnapshotStore({ root: join(tempDir(), 'backups') })
    const service = startBackupService({
      store,
      writeToken: WRITE_TOKEN,
      archiveToken: ARCHIVE_TOKEN,
    })
    services.push(service)
    const base = service.url as string

    const refused = await fetch(`${base}/snapshot?workspace=/w&reason=manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ARCHIVE_TOKEN}` },
      body: new Uint8Array([1]) as unknown as BodyInit,
    })
    expect(refused.status).toBe(403)
    const listed = await fetch(`${base}/snapshots`, {
      headers: { authorization: `Bearer ${ARCHIVE_TOKEN}` },
    })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([])
  }, 30_000)
})
