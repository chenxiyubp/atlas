// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 AC-6(b)(c) 一键复现 —— 删库之后能不能原样回来，以及智能体能不能删备份。
 *
 *   bun run demo/lib/ac6b-restore.ts
 *
 * 流程：造一个真 git 工作区（有已提交、已暂存、未暂存、未跟踪与可执行位五种状态）
 * → 以**只写凭据**经 HTTP 面存一份快照 → `rm -rf` 整个工作区 → 用宿主侧凭据取回
 * 并解包 → 比对 `git status --porcelain` 与 `HEAD`。随后以只写凭据尝试各种删除与
 * 读取动作，逐一记录被拒。
 *
 * **只删自己造的目录**：工作区一律由本脚本在临时目录里新建，不接受外部路径。一个
 * 会对操作员给的路径执行 `rm -rf` 的演示脚本，本身就是事故。
 *
 * 判据由 `ac6b-report-core.ts` 合成，退出码即结论；报告里没有凭据、没有正文。
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackupEventType,
  FileSnapshotStore,
  archiveDirectory,
  remoteSnapshotWriter,
  restoreWorkspace,
  startBackupService,
  tarAvailable,
} from '@qianmo/backup'
import { emit } from './cli-args.js'
import { buildAc6bReport } from './ac6b-report-core.js'

const WRITE_TOKEN = process.env['QIANMO_BACKUP_WRITE_TOKEN'] ?? ''
const ARCHIVE_TOKEN = process.env['QIANMO_BACKUP_ARCHIVE_TOKEN'] ?? ''
if (WRITE_TOKEN.length < 16 || ARCHIVE_TOKEN.length < 16) {
  throw new Error(
    'ac6b-restore 需要 QIANMO_BACKUP_WRITE_TOKEN 与 QIANMO_BACKUP_ARCHIVE_TOKEN（各 ≥ 16 字符）',
  )
}

function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const out: string[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()))
    child.on('close', code => resolve({ code, stdout: out.join('') }))
  })
}

const git = (args: readonly string[], cwd: string) =>
  run(
    'git',
    [
      '-c',
      'user.email=ac6b@qianmo.invalid',
      '-c',
      'user.name=Qianmo AC-6 Demo',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    cwd,
  )

const root = mkdtempSync(join(tmpdir(), 'qianmo-ac6b-'))
const workspace = join(root, 'workspace')
const store = new FileSnapshotStore({ root: join(root, 'backups') })
const service = startBackupService({
  store,
  writeToken: WRITE_TOKEN,
  archiveToken: ARCHIVE_TOKEN,
})
const base = service.url as string

try {
  if (!(await tarAvailable())) throw new Error('tar 不在 PATH 上')

  // 1. 一个有五种状态的真工作区。
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
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 2\n')
  writeFileSync(join(workspace, 'staged.txt'), 'staged\n')
  await git(['add', 'staged.txt'], workspace)
  writeFileSync(join(workspace, 'untracked.txt'), 'untracked\n')

  const statusBefore = (await git(['status', '--porcelain=v1'], workspace))
    .stdout
  const headBefore = (await git(['rev-parse', 'HEAD'], workspace)).stdout.trim()

  // 2. 沙箱侧：只写凭据 + HTTP 面。
  const writer = remoteSnapshotWriter({ url: base, token: WRITE_TOKEN })
  const meta = await writer.create({
    workspace,
    reason: 'pre-task',
    archive: await archiveDirectory(workspace),
    label: 'ac6b',
  })

  // 3. 智能体干最坏的事。
  rmSync(workspace, { recursive: true, force: true })
  const deleted = !existsSync(workspace)

  // 4. 宿主侧取回并解包。
  const bytes = await store.read(meta.id)
  const restored =
    bytes === null
      ? null
      : await restoreWorkspace({
          directory: workspace,
          archive: bytes,
          meta,
          audit: store.audit,
        })
  const statusAfter = (await git(['status', '--porcelain=v1'], workspace))
    .stdout
  const headAfter = (await git(['rev-parse', 'HEAD'], workspace)).stdout.trim()

  // 5. AC-6(c)：拿只写凭据去删、去改、去读。
  const removalAttempts = [
    { method: 'DELETE', path: `/snapshot/${meta.id}` },
    { method: 'DELETE', path: '/snapshots' },
    { method: 'PUT', path: `/snapshot/${meta.id}` },
    { method: 'PATCH', path: `/snapshot/${meta.id}` },
  ]
  const removalStatuses: number[] = []
  for (const attempt of removalAttempts) {
    const response = await fetch(`${base}${attempt.path}`, {
      method: attempt.method,
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
    removalStatuses.push(response.status)
  }
  const listStatus = (
    await fetch(`${base}/snapshots`, {
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
  ).status
  const readStatus = (
    await fetch(`${base}/snapshot/${meta.id}`, {
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
  ).status
  const survives = (await store.read(meta.id)) !== null

  const report = buildAc6bReport({
    restore: {
      deleted,
      restoredAt: restored !== null,
      elapsedMs: restored?.elapsedMs ?? -1,
      budgetMs: 10 * 60_000,
      statusIdentical: statusAfter === statusBefore,
      statusLines: statusBefore.trim().split('\n').length,
      headIdentical: headAfter === headBefore && headBefore.length > 0,
      // 可执行位没回来的话 git 会把 run.sh 报成 modified，所以「status 一致」
      // 已经把它覆盖住了；这里单列一条是为了让报告读起来不必推理。
      execBitPreserved: !statusAfter.includes('run.sh'),
    },
    protection: {
      removalStatuses,
      listStatus,
      readStatus,
      mutationDenied: store.audit.count(BackupEventType.MutationDenied),
      readDenied: store.audit.count(BackupEventType.ReadDenied),
      snapshotSurvives: survives,
    },
  })
  emit({ ...report })
  process.exitCode = report.pass ? 0 : 1
} finally {
  await service.stop()
  rmSync(root, { recursive: true, force: true })
}
