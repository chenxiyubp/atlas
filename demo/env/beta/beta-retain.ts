// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Host-only retention implementation for demo/env/beta/beta-retain.sh.
 *
 * Bash owns the beta environment guard. Bun owns UTC calendar arithmetic and
 * lstat/realpath checks so the result is the same on macOS and Linux without
 * relying on GNU date, GNU stat, or find's platform-specific flags.
 */

import { createHash } from 'node:crypto'
import { dlopen, ptr } from 'bun:ffi'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmdirSync,
  realpathSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path'

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS
const BACKUP_FULL_RETENTION_MS = 72 * HOUR_MS
const LOG_RETENTION_MS = 14 * DAY_MS
const LEDGER_WARNING_BYTES = 10 * 1024 * 1024
const DATE_MAX_MS = 8_640_000_000_000_000
const SNAPSHOT_ID = /^\d{14}-\d{4}$/
const REGISTRY_SNAPSHOT =
  /^registry-(\d{8}T\d{6}Z)(?:-([A-Za-z0-9._-]+))?\.json$/

type Mode = 'dry-run' | 'apply'

interface Paths {
  readonly root: string
  readonly rootReal: string
  readonly rootIdentity: FileIdentity
  readonly ownerUid: number
  readonly run: string
  readonly logs: string
  readonly backups: string
  readonly registryState: string
  readonly registrySnapshots: string
  readonly nodes: string
}

interface Operation {
  execute(): 'applied' | 'settled'
}

interface Plan {
  readonly name: string
  readonly operations: readonly Operation[]
  readonly remaining: number
  readonly warnings: readonly string[]
  readonly errors: readonly PlanIssue[]
}

interface ParsedArgs {
  readonly mode: Mode
  readonly snapshotRegistry: boolean
}

interface Backup {
  readonly id: string
  readonly createdAt: number
  readonly archive: string
  readonly meta: string
  readonly metaBytes: Buffer
  readonly archiveSnapshot: FileSnapshot
  readonly metaSnapshot: FileSnapshot
}

interface RegistrySnapshot {
  readonly path: string
  readonly name: string
  readonly stamp: string
  readonly snapshot?: FileSnapshot
}

interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: number
  readonly nlink: number
  readonly size: number
  readonly mtimeMs: number
  readonly uid: number
}

interface DirectorySnapshot {
  readonly path: string
  readonly realpath: string
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: number
  readonly nlink: number
  readonly size: number
  readonly mtimeMs: number
  readonly uid: number
}

interface FileSnapshot {
  readonly path: string
  readonly realpath: string
  readonly identity: FileIdentity
  readonly parents: readonly DirectorySnapshot[]
}

interface CapturedFile {
  readonly snapshot: FileSnapshot
  readonly bytes: Buffer
  readonly sha256: string
}

type BackupStagingPhase =
  | 'directory-created'
  | 'payload-created'
  | 'payload-synced'
  | 'payload-entry-durable'
  | 'directory-entry-durable'

interface BackupStaging {
  readonly directory: string
  readonly payload: string
  readonly runParents: readonly DirectorySnapshot[]
  readonly directoryParents: readonly DirectorySnapshot[]
  phase: BackupStagingPhase
  payloadIdentity?: FileIdentity
  payloadSnapshot?: FileSnapshot
}

type EntryFact = 'present' | 'missing' | 'unknown'

type StagingCleanupPhase =
  | 'not-started'
  | 'payload-unlinked'
  | 'payload-unlink-durable'
  | 'directory-removed'
  | 'complete'

interface StagingCleanupResult {
  readonly status: 'complete' | 'incomplete'
  readonly phase: StagingCleanupPhase
  readonly payload: EntryFact
  readonly directory: EntryFact
  readonly runDirectoryDurable: boolean
  readonly failure?: unknown
}

type CompensationPublicationPhase =
  | 'not-linked'
  | 'linked'
  | 'directory-synced'
  | 'committed'

type CompensationPublicationResult =
  | { readonly status: 'committed'; readonly phase: 'committed' }
  | {
      readonly status: 'not-committed'
      readonly phase: Exclude<CompensationPublicationPhase, 'committed'>
      readonly failure: unknown
    }

type BackupCompensationResult =
  | {
      readonly status: 'original-safe'
      readonly cleanup: StagingCleanupResult
    }
  | {
      readonly status: 'restore-committed'
      readonly cleanup: StagingCleanupResult
      readonly originalCheckFailure?: unknown
    }
  | {
      readonly status: 'restore-not-committed'
      readonly publicationFailure: unknown
      readonly publicationPhase: Exclude<
        CompensationPublicationPhase,
        'committed'
      >
      readonly originalCheckFailure?: unknown
      readonly payload: EntryFact
      readonly directory: EntryFact
    }

type PairedDeletionPhase =
  | 'ready'
  | 'metadata-unlinked'
  | 'archive-unlinked'
  | 'directory-synced'
  | 'committed'

type PairedDeletionResult =
  | {
      readonly status: 'committed'
      readonly phase: 'committed'
      readonly quarantineCleanup: DeletionQuarantineCleanupResult
    }
  | {
      readonly status: 'not-committed'
      readonly phase: Exclude<PairedDeletionPhase, 'committed'>
      readonly failure: unknown
    }

interface DeletionQuarantine {
  readonly directory: string
  readonly parentParents: readonly DirectorySnapshot[]
  readonly directoryParents: readonly DirectorySnapshot[]
}

interface DeletionQuarantineCleanupResult {
  readonly status: 'complete' | 'incomplete'
  readonly location: string
  readonly directory: EntryFact
  readonly entries: readonly string[]
  readonly failure?: unknown
}

interface PlanIssue {
  readonly message: string
}

type PathBoundary = Pick<
  Paths,
  'root' | 'rootReal' | 'rootIdentity' | 'ownerUid'
>

function die(message: string): never {
  throw new Error(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorMessages(error: unknown): readonly string[] {
  if (!(error instanceof AggregateError)) return [errorMessage(error)]
  return [error.message, ...error.errors.flatMap(item => errorMessages(item))]
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) die(`缺少配置：${name}`)
  return value
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let mode: Mode = 'dry-run'
  let setMode = false
  let snapshotRegistry = false
  for (const arg of args) {
    switch (arg) {
      case '--dry-run':
        if (setMode) die('参数模式重复或冲突：--dry-run')
        mode = 'dry-run'
        setMode = true
        break
      case '--apply':
        if (setMode) die('参数模式重复或冲突：--apply')
        mode = 'apply'
        setMode = true
        break
      case '--snapshot-registry':
        if (snapshotRegistry) die('参数重复：--snapshot-registry')
        snapshotRegistry = true
        break
      default:
        die(`未知参数：${JSON.stringify(arg)}`)
    }
  }
  return { mode, snapshotRegistry }
}

function hasParentTraversal(value: string): boolean {
  return value.split('/').includes('..')
}

function assertSafeRoot(root: string): {
  readonly realpath: string
  readonly identity: FileIdentity
} {
  if (!isAbsolute(root)) die(`内测根必须是绝对路径：${JSON.stringify(root)}`)
  if (root === '/' || hasParentTraversal(root) || normalize(root) !== root) {
    die(`内测根不是规范化安全路径：${JSON.stringify(root)}`)
  }
  let stat
  try {
    stat = lstatSync(root)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT'))
      die(`内测根不存在：${JSON.stringify(root)}`)
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    die(`内测根不是普通目录：${JSON.stringify(root)}`)
  }
  if (!hasStrictRootMode(stat.mode))
    die(`内测根权限必须严格为 0700：${JSON.stringify(root)}`)
  const initialIdentity = identityAtPath(root, stat)
  const realpath = realpathSync(root)
  const stable = lstatSync(root)
  if (
    !sameIdentity(initialIdentity, identityAtPath(root, stable)) ||
    realpathSync(root) !== realpath
  )
    die(`内测根在验证期间发生变化：${JSON.stringify(root)}`)
  return { realpath, identity: identityAtPath(root, stable) }
}

function assertMarker(paths: Paths): void {
  const marker = join(paths.root, '.qianmo-beta-env')
  const firstLine = readCapturedFile(paths, marker, '标记文件')
    .bytes.toString('utf8')
    .split('\n', 1)[0]
  if (firstLine !== 'qianmo-beta-env/v1') {
    die('内测根标记文件身份不正确')
  }
}

function assertDerivedPath(
  paths: PathBoundary,
  target: string,
  label: string,
): void {
  if (
    !isAbsolute(target) ||
    hasParentTraversal(target) ||
    normalize(target) !== target
  ) {
    die(`${label} 不是规范化绝对路径：${JSON.stringify(target)}`)
  }
  const relation = relative(paths.root, target)
  if (
    relation.length === 0 ||
    relation === '..' ||
    relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relation)
  ) {
    die(`${label} 越出内测根：${JSON.stringify(target)}`)
  }
}

function assertRootBoundary(paths: PathBoundary): Stats {
  const stat = lstatSync(paths.root)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== paths.ownerUid ||
    !hasStrictRootMode(stat.mode) ||
    !sameBoundaryIdentity(
      paths.rootIdentity,
      identityAtPath(paths.root, stat),
    ) ||
    realpathSync(paths.root) !== paths.rootReal
  ) {
    die(`内测根在运行中变成了不安全路径：${JSON.stringify(paths.root)}`)
  }
  return stat
}

function assertExistingPath(
  paths: PathBoundary,
  target: string,
  label: string,
): Stats {
  assertDerivedPath(paths, target, label)
  const relation = relative(paths.root, target)
  let cursor = paths.root
  assertRootBoundary(paths)
  const parts = relation.split('/')
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part)
    let stat: Stats
    try {
      stat = lstatSync(cursor)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT'))
        die(`${label} 缺失：${JSON.stringify(cursor)}`)
      throw error
    }
    if (stat.isSymbolicLink())
      die(`${label} 或父路径是符号链接：${JSON.stringify(cursor)}`)
    if (index < parts.length - 1 && !stat.isDirectory())
      die(`${label} 父路径不是目录：${JSON.stringify(cursor)}`)
    if (stat.isDirectory())
      assertOwnedDirectoryMetadata(paths, stat, cursor, label)
  }
  const resolved = realpathSync(target)
  const realRelation = relative(paths.rootReal, resolved)
  if (
    realRelation === '..' ||
    realRelation.startsWith('../') ||
    isAbsolute(realRelation)
  ) {
    die(`${label} 真实路径越出内测根：${JSON.stringify(target)}`)
  }
  return lstatSync(target)
}

function assertExistingDirectory(
  paths: PathBoundary,
  target: string,
  label: string,
): Stats {
  const stat = assertExistingPath(paths, target, label)
  if (!stat.isDirectory()) die(`${label} 不是目录：${JSON.stringify(target)}`)
  assertOwnedDirectoryMetadata(paths, stat, target, label)
  return stat
}

function assertExistingRegularFile(
  paths: PathBoundary,
  target: string,
  label: string,
): Stats {
  const stat = assertExistingPath(paths, target, label)
  if (!stat.isFile()) die(`${label} 不是普通文件：${JSON.stringify(target)}`)
  if (stat.nlink !== 1)
    die(`${label} 必须恰有一个硬链接：${JSON.stringify(target)}`)
  if (stat.uid !== paths.ownerUid)
    die(`${label} 所有者与内测根不同：${JSON.stringify(target)}`)
  return stat
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function hasStrictRootMode(mode: number): boolean {
  return (mode & 0o7777) === 0o700
}

function assertOwnedDirectoryMetadata(
  paths: Pick<Paths, 'ownerUid'>,
  stat: Stats,
  target: string,
  label: string,
): void {
  if (stat.uid !== paths.ownerUid)
    die(`${label} 目录所有者与内测根不同：${JSON.stringify(target)}`)
}

function pathEntryExists(target: string): boolean {
  try {
    lstatSync(target)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

function ensureSafeDirectory(paths: PathBoundary, target: string): void {
  assertDerivedPath(paths, target, '待创建目录')
  const relation = relative(paths.root, target)
  let cursor = paths.root
  for (const part of relation.split('/')) {
    cursor = join(cursor, part)
    try {
      mkdirSync(cursor, { mode: 0o700 })
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error
    }
    // EEXIST can be an operator racing us or an attacker replacing this path.
    // Re-run the full lstat/realpath guard instead of assuming it is our directory.
    assertExistingDirectory(paths, cursor, '待创建目录')
  }
}

function readDirectory(
  paths: PathBoundary,
  directory: string,
  label: string,
): readonly string[] {
  if (!pathEntryExists(directory)) return []
  assertExistingDirectory(paths, directory, label)
  return readdirSync(directory).sort()
}

function nowMs(): number {
  const configured = process.env.QIANMO_BETA_RETAIN_NOW_EPOCH_MS
  if (configured === undefined) return Date.now()
  if (!/^\d+$/.test(configured))
    die('QIANMO_BETA_RETAIN_NOW_EPOCH_MS 必须是毫秒整数')
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value <= 0) {
    die('QIANMO_BETA_RETAIN_NOW_EPOCH_MS 超出有效范围')
  }
  return value
}

function utcDay(value: number): string {
  const date = new Date(value)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function utcDayWindowStart(now: number): number {
  const date = new Date(now)
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
    13 * DAY_MS
  )
}

function utcStamp(value: number): string {
  const date = new Date(value)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`
}

function isoWeek(value: number): string {
  const date = new Date(value)
  const day = date.getUTCDay() || 7
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day)
  const year = thursday.getUTCFullYear()
  const yearStart = Date.UTC(year, 0, 1)
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

function isSunday(value: number): boolean {
  return new Date(value).getUTCDay() === 0
}

function identityNumber(value: bigint, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result))
    die(`${label} 超出 JavaScript 安全整数范围`)
  return result
}

function identityMilliseconds(value: bigint, label: string): number {
  const milliseconds = value / 1_000_000n
  const nanoseconds = value % 1_000_000n
  return identityNumber(milliseconds, label) + Number(nanoseconds) / 1_000_000
}

function identityOf(stat: BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: identityNumber(stat.mode, '文件 mode'),
    nlink: identityNumber(stat.nlink, '文件 nlink'),
    size: identityNumber(stat.size, '文件 size'),
    mtimeMs: identityMilliseconds(stat.mtimeNs, '文件 mtime'),
    uid: identityNumber(stat.uid, '文件 uid'),
  }
}

function identityAtPath(target: string, _stat: Stats): FileIdentity {
  return identityOf(lstatSync(target, { bigint: true }))
}

function identityOfDescriptor(descriptor: number, _stat: Stats): FileIdentity {
  return identityOf(fstatSync(descriptor, { bigint: true }))
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.uid === right.uid
  )
}

function sameDirectoryIdentity(
  left: DirectorySnapshot,
  right: FileIdentity,
  allowMetadataChange: boolean,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    (allowMetadataChange ||
      (left.nlink === right.nlink &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs)) &&
    left.uid === right.uid
  )
}

function sameBoundaryIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  )
}

function parentSnapshots(paths: Paths, target: string): DirectorySnapshot[] {
  const relation = relative(paths.root, dirname(target))
  const result: DirectorySnapshot[] = []
  let cursor = paths.root
  const parts = relation.length === 0 ? [] : relation.split('/')
  for (const part of ['', ...parts]) {
    if (part.length > 0) cursor = join(cursor, part)
    const stat =
      cursor === paths.root
        ? assertRootBoundary(paths)
        : assertExistingPath(paths, cursor, '文件父目录')
    if (!stat.isDirectory())
      die(`文件父路径不是目录：${JSON.stringify(cursor)}`)
    assertOwnedDirectoryMetadata(paths, stat, cursor, '文件父目录')
    const identity = identityAtPath(cursor, stat)
    result.push({
      path: cursor,
      realpath: realpathSync(cursor),
      ...identity,
    })
  }
  return result
}

function captureFileSnapshot(
  paths: Paths,
  target: string,
  label: string,
): FileSnapshot {
  const stat = assertExistingRegularFile(paths, target, label)
  return {
    path: target,
    realpath: realpathSync(target),
    identity: identityAtPath(target, stat),
    parents: parentSnapshots(paths, target),
  }
}

function assertParentsUnchanged(
  paths: Paths,
  snapshots: readonly DirectorySnapshot[],
  label: string,
  allowMetadataChange = false,
): void {
  for (const snapshot of snapshots) {
    const stat =
      snapshot.path === paths.root
        ? assertRootBoundary(paths)
        : assertExistingPath(paths, snapshot.path, `${label}父目录`)
    if (
      !stat.isDirectory() ||
      !sameDirectoryIdentity(
        snapshot,
        identityAtPath(snapshot.path, stat),
        allowMetadataChange,
      ) ||
      realpathSync(snapshot.path) !== snapshot.realpath
    ) {
      die(`${label} 父目录在验证后被替换：${JSON.stringify(snapshot.path)}`)
    }
  }
}

function assertFileUnchanged(
  paths: Paths,
  snapshot: FileSnapshot,
  label: string,
  allowParentMetadataChange = false,
): Stats {
  assertParentsUnchanged(
    paths,
    snapshot.parents,
    label,
    allowParentMetadataChange,
  )
  const stat = assertExistingRegularFile(paths, snapshot.path, label)
  if (
    !sameIdentity(snapshot.identity, identityAtPath(snapshot.path, stat)) ||
    realpathSync(snapshot.path) !== snapshot.realpath
  ) {
    die(
      `${label} 在验证后发生身份或元数据变化：${JSON.stringify(snapshot.path)}`,
    )
  }
  return stat
}

const checkpointWait = new Int32Array(new SharedArrayBuffer(4))
let activeTestPaths: Paths | undefined

function testCheckpoint(name: string): void {
  if (process.env.QIANMO_BETA_RETAIN_TEST_PAUSE_AT !== name) return
  if (process.env.NODE_ENV !== 'test')
    die('测试暂停点只允许在 NODE_ENV=test 时启用')
  const paths = activeTestPaths
  if (paths === undefined) die('测试暂停点尚未绑定内测根')
  const directory = join(paths.run, '.retain-test-hook')
  assertExistingDirectory(paths, directory, '测试暂停目录')
  const ready = join(directory, 'ready')
  const release = join(directory, 'release')
  assertDerivedPath(paths, ready, '测试暂停 ready 文件')
  assertDerivedPath(paths, release, '测试暂停 release 文件')
  writeFileSync(ready, `${name}\n`, { flag: 'wx', mode: 0o600 })
  const deadline = Date.now() + 10_000
  while (!existsSync(release)) {
    if (Date.now() >= deadline) die(`测试暂停点等待超时：${name}`)
    Atomics.wait(checkpointWait, 0, 0, 5)
  }
}

function testFailure(name: string): void {
  const configured = process.env.QIANMO_BETA_RETAIN_TEST_FAIL_AT
  if (configured === undefined) return
  if (process.env.NODE_ENV !== 'test')
    die('测试故障注入只允许在 NODE_ENV=test 时启用')
  if (
    !configured
      .split(',')
      .map(value => value.trim())
      .includes(name)
  )
    return
  die(`测试故障注入：${name}`)
}

function readCapturedFile(
  paths: Paths,
  target: string,
  label: string,
  expected?: FileSnapshot,
  allowExpectedParentMetadataChange = false,
): CapturedFile {
  const before = captureFileSnapshot(paths, target, label)
  if (expected !== undefined)
    assertFileUnchanged(
      paths,
      expected,
      label,
      allowExpectedParentMetadataChange,
    )
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    const openedIdentity = identityOfDescriptor(descriptor, opened)
    if (!sameIdentity(before.identity, openedIdentity))
      die(`${label} 在验证与打开之间发生身份变化：${JSON.stringify(target)}`)
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (count === 0)
        die(`${label} 在读取期间被截断：${JSON.stringify(target)}`)
      offset += count
    }
    const afterDescriptor = fstatSync(descriptor)
    const afterIdentity = identityOfDescriptor(descriptor, afterDescriptor)
    assertFileUnchanged(paths, before, label)
    if (
      !sameIdentity(openedIdentity, afterIdentity) ||
      (expected !== undefined &&
        !sameIdentity(expected.identity, afterIdentity))
    ) {
      die(`${label} 在读取期间发生身份或内容变化：${JSON.stringify(target)}`)
    }
    return { snapshot: before, bytes, sha256: hashBytes(bytes) }
  } finally {
    closeSync(descriptor)
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameCapture(left: CapturedFile, right: CapturedFile): boolean {
  return (
    sameIdentity(left.snapshot.identity, right.snapshot.identity) &&
    left.sha256 === right.sha256 &&
    left.bytes.equals(right.bytes)
  )
}

function uniqueTemporary(paths: Paths, label: string): string {
  assertExistingDirectory(paths, paths.run, '运行态目录')
  const directory = mkdtempSync(join(paths.run, `.retain-${process.pid}-`))
  assertExistingDirectory(paths, directory, `${label}临时目录`)
  const temporary = join(directory, 'payload')
  assertDerivedPath(paths, temporary, `${label}临时文件`)
  return temporary
}

function writeCapturedTemporary(
  paths: Paths,
  temporary: string,
  bytes: Buffer,
  label: string,
  mode = 0o600,
  times?: { readonly atime: Date; readonly mtime: Date },
): FileSnapshot {
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  )
  try {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset)
    fsyncSync(descriptor)
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== paths.ownerUid)
      die(`${label}临时文件身份不安全：${JSON.stringify(temporary)}`)
  } finally {
    closeSync(descriptor)
  }
  if (times !== undefined) utimesSync(temporary, times.atime, times.mtime)
  return captureFileSnapshot(paths, temporary, `${label}临时文件`)
}

function removeTemporary(
  paths: Paths,
  temporary: string,
  label: string,
  expected?: FileSnapshot,
): void {
  if (pathEntryExists(temporary)) {
    if (expected !== undefined)
      assertFileUnchanged(paths, expected, `${label}临时文件`, true)
    else assertExistingRegularFile(paths, temporary, `${label}临时文件`)
    unlinkSync(temporary)
  }
  const directory = dirname(temporary)
  assertExistingDirectory(paths, directory, `${label}临时目录`)
  rmdirSync(directory)
}

function fsyncDirectory(paths: Paths, directory: string, label: string): void {
  const before = assertExistingDirectory(paths, directory, `${label}目标目录`)
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  )
  try {
    const opened = fstatSync(descriptor)
    if (
      !sameIdentity(
        identityAtPath(directory, before),
        identityOfDescriptor(descriptor, opened),
      )
    )
      die(`${label}目标目录在验证与打开之间发生身份变化`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function terminalDirectorySnapshot(
  snapshots: readonly DirectorySnapshot[],
  label: string,
): DirectorySnapshot {
  const snapshot = snapshots.at(-1)
  if (snapshot === undefined) die(`${label}缺少目录身份绑定`)
  return snapshot
}

function fsyncBoundDirectory(
  paths: Paths,
  parents: readonly DirectorySnapshot[],
  label: string,
): void {
  const expected = terminalDirectorySnapshot(parents, label)
  assertParentsUnchanged(paths, parents, label, true)
  const descriptor = openSync(
    expected.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  )
  try {
    const opened = identityOfDescriptor(descriptor, fstatSync(descriptor))
    if (!sameDirectoryIdentity(expected, opened, true))
      die(`${label}目录在验证与打开之间发生身份变化`)
    fsyncSync(descriptor)
    const synced = identityOfDescriptor(descriptor, fstatSync(descriptor))
    if (!sameDirectoryIdentity(expected, synced, true))
      die(`${label}目录在 fsync 期间发生身份变化`)
  } finally {
    closeSync(descriptor)
  }
  assertParentsUnchanged(paths, parents, label, true)
}

type NativeRenameNoReplace = (
  source: string,
  destination: string,
  label: string,
) => void

let cachedRenameNoReplace: NativeRenameNoReplace | undefined

function nativeRenameNoReplace(): NativeRenameNoReplace {
  if (cachedRenameNoReplace !== undefined) return cachedRenameNoReplace
  if (process.platform === 'darwin') {
    const library = dlopen('/usr/lib/libSystem.B.dylib', {
      renamex_np: {
        args: ['ptr', 'ptr', 'u32'],
        returns: 'int',
      },
    } as const)
    cachedRenameNoReplace = (source, destination, label) => {
      const sourceBytes = Buffer.from(`${source}\0`)
      const destinationBytes = Buffer.from(`${destination}\0`)
      const RENAME_EXCL = 0x00000004
      const result = library.symbols.renamex_np(
        ptr(sourceBytes),
        ptr(destinationBytes),
        RENAME_EXCL,
      )
      if (result !== 0)
        die(
          `${label}原子 no-clobber quarantine move 失败：${JSON.stringify(source)} -> ${JSON.stringify(destination)}`,
        )
    }
    return cachedRenameNoReplace
  }
  if (process.platform === 'linux') {
    const library = dlopen('libc.so.6', {
      renameat2: {
        args: ['int', 'ptr', 'int', 'ptr', 'u32'],
        returns: 'int',
      },
    } as const)
    cachedRenameNoReplace = (source, destination, label) => {
      const sourceBytes = Buffer.from(`${source}\0`)
      const destinationBytes = Buffer.from(`${destination}\0`)
      const AT_FDCWD = -100
      const RENAME_NOREPLACE = 1
      const result = library.symbols.renameat2(
        AT_FDCWD,
        ptr(sourceBytes),
        AT_FDCWD,
        ptr(destinationBytes),
        RENAME_NOREPLACE,
      )
      if (result !== 0)
        die(
          `${label}原子 no-clobber quarantine move 失败：${JSON.stringify(source)} -> ${JSON.stringify(destination)}`,
        )
    }
    return cachedRenameNoReplace
  }
  die(`当前平台不支持原子 no-clobber quarantine move：${process.platform}`)
}

function allocateDeletionQuarantine(
  paths: Paths,
  parent: string,
  label: string,
): DeletionQuarantine {
  const parentParents = parentSnapshots(
    paths,
    join(parent, '.retain-delete-parent-binding'),
  )
  assertParentsUnchanged(paths, parentParents, label, true)
  const directory = mkdtempSync(join(parent, `.retain-delete-${process.pid}-`))
  const stat = assertExistingDirectory(paths, directory, `${label} quarantine`)
  const directorySnapshot: DirectorySnapshot = {
    path: directory,
    realpath: realpathSync(directory),
    ...identityAtPath(directory, stat),
  }
  const quarantine = {
    directory,
    parentParents,
    directoryParents: [...parentParents, directorySnapshot],
  }
  assertParentsUnchanged(paths, quarantine.directoryParents, label, true)
  fsyncBoundDirectory(paths, parentParents, `${label} quarantine parent`)
  assertParentsUnchanged(paths, quarantine.directoryParents, label, true)
  return quarantine
}

function quarantinePath(
  paths: Paths,
  quarantine: DeletionQuarantine,
  name: string,
  label: string,
): string {
  const target = join(quarantine.directory, name)
  assertDerivedPath(paths, target, label)
  assertEntryMissingUnderParents(
    paths,
    target,
    quarantine.directoryParents,
    label,
  )
  return target
}

function assertIdentityAtPath(
  paths: Paths,
  target: string,
  parents: readonly DirectorySnapshot[],
  expected: FileIdentity,
  label: string,
): Stats {
  assertParentsUnchanged(paths, parents, label, true)
  const stat = assertExistingPath(paths, target, label)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== paths.ownerUid ||
    !sameIdentity(expected, identityAtPath(target, stat))
  ) {
    die(`${label}不是预期事务对象：${JSON.stringify(target)}`)
  }
  assertParentsUnchanged(paths, parents, label, true)
  return stat
}

function isolatePlannedFile(
  paths: Paths,
  quarantine: DeletionQuarantine,
  snapshot: FileSnapshot,
  quarantineName: string,
  label: string,
  checkpoint?: string,
): FileSnapshot {
  const isolated = quarantinePath(
    paths,
    quarantine,
    quarantineName,
    `${label} quarantine 目标`,
  )
  assertFileUnchanged(paths, snapshot, label, true)
  if (checkpoint !== undefined) testCheckpoint(checkpoint)
  nativeRenameNoReplace()(snapshot.path, isolated, label)
  const isolatedSnapshot = captureFileSnapshot(
    paths,
    isolated,
    `${label} quarantine 对象`,
  )
  if (!sameIdentity(snapshot.identity, isolatedSnapshot.identity))
    die(`${label} syscall 边界对象身份不符；拒绝删除 quarantine 对象`)
  fsyncBoundDirectory(
    paths,
    quarantine.directoryParents,
    `${label} quarantine 目录`,
  )
  fsyncBoundDirectory(paths, snapshot.parents, `${label}原父目录`)
  assertFileUnchanged(paths, isolatedSnapshot, `${label} quarantine 对象`, true)
  assertEntryMissingUnderParents(
    paths,
    snapshot.path,
    snapshot.parents,
    `${label}原 pathname 隔离复验`,
  )
  return isolatedSnapshot
}

function deleteIsolatedFile(
  paths: Paths,
  quarantine: DeletionQuarantine,
  isolated: FileSnapshot,
  label: string,
): void {
  assertFileUnchanged(paths, isolated, label, true)
  unlinkSync(isolated.path)
  assertEntryMissingUnderParents(
    paths,
    isolated.path,
    quarantine.directoryParents,
    `${label}私有 unlink 复验`,
  )
  fsyncBoundDirectory(
    paths,
    quarantine.directoryParents,
    `${label}私有 unlink 提交`,
  )
}

function rollbackQuarantineEntry(
  paths: Paths,
  quarantine: DeletionQuarantine,
  isolated: string,
  destination: string,
  destinationParents: readonly DirectorySnapshot[],
  expected: FileIdentity,
  label: string,
): void {
  assertParentsUnchanged(paths, quarantine.directoryParents, label, true)
  if (!pathEntryExists(isolated)) return
  const stat = assertExistingPath(paths, isolated, `${label} quarantine 对象`)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== paths.ownerUid ||
    stat.nlink !== 1
  ) {
    die(
      `${label} quarantine 对象身份未知；保留人工位置 ${JSON.stringify(isolated)}`,
    )
  }
  const identity = identityAtPath(isolated, stat)
  const plannedObject = sameIdentity(expected, identity)
  assertParentsUnchanged(paths, destinationParents, label, true)
  if (pathEntryExists(destination))
    die(
      `${label}原 pathname 已被占用；不覆盖并保留人工位置 ${JSON.stringify(isolated)}`,
    )
  try {
    linkSync(isolated, destination)
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST'))
      die(
        `${label}原 pathname 在 no-clobber rollback 时被占用；保留人工位置 ${JSON.stringify(isolated)}`,
      )
    throw error
  }
  assertQuarantineRollbackLink(
    paths,
    quarantine,
    isolated,
    destination,
    destinationParents,
    identity,
    label,
  )
  fsyncBoundDirectory(paths, destinationParents, `${label} rollback 原父目录`)
  assertQuarantineRollbackLink(
    paths,
    quarantine,
    isolated,
    destination,
    destinationParents,
    identity,
    label,
  )
  if (!plannedObject)
    die(
      `${label} syscall 边界对象不是计划 inode；已 no-clobber 恢复公开 pathname，但绝不 unlink quarantine 对象，人工位置 ${JSON.stringify(isolated)}`,
    )
  unlinkSync(isolated)
  assertEntryMissingUnderParents(
    paths,
    isolated,
    quarantine.directoryParents,
    `${label} quarantine rollback 私有链接`,
  )
  fsyncBoundDirectory(
    paths,
    quarantine.directoryParents,
    `${label} quarantine rollback 目录`,
  )
  assertIdentityAtPath(
    paths,
    destination,
    destinationParents,
    expected,
    `${label} rollback 对象`,
  )
}

function assertQuarantineRollbackLink(
  paths: Paths,
  quarantine: DeletionQuarantine,
  isolated: string,
  destination: string,
  destinationParents: readonly DirectorySnapshot[],
  expected: FileIdentity,
  label: string,
): void {
  assertParentsUnchanged(paths, quarantine.directoryParents, label, true)
  assertParentsUnchanged(paths, destinationParents, label, true)
  const isolatedStat = assertExistingPath(
    paths,
    isolated,
    `${label} quarantine 对象`,
  )
  const destinationStat = assertExistingPath(
    paths,
    destination,
    `${label} rollback 目标`,
  )
  const isolatedIdentity = identityAtPath(isolated, isolatedStat)
  const destinationIdentity = identityAtPath(destination, destinationStat)
  if (
    !isolatedStat.isFile() ||
    isolatedStat.isSymbolicLink() ||
    !destinationStat.isFile() ||
    destinationStat.isSymbolicLink() ||
    isolatedStat.uid !== paths.ownerUid ||
    destinationStat.uid !== paths.ownerUid ||
    isolatedStat.nlink !== 2 ||
    destinationStat.nlink !== 2 ||
    !samePublishedIdentity(expected, isolatedIdentity) ||
    !sameIdentity(isolatedIdentity, destinationIdentity)
  ) {
    die(
      `${label} no-clobber rollback 链接身份未知；不删除并保留人工位置 ${JSON.stringify(isolated)}`,
    )
  }
  assertParentsUnchanged(paths, quarantine.directoryParents, label, true)
  assertParentsUnchanged(paths, destinationParents, label, true)
}

function cleanupDeletionQuarantine(
  paths: Paths,
  quarantine: DeletionQuarantine,
  label: string,
): DeletionQuarantineCleanupResult {
  try {
    assertParentsUnchanged(paths, quarantine.directoryParents, label, true)
    const entries = readdirSync(quarantine.directory).sort()
    if (entries.length > 0) {
      return {
        status: 'incomplete',
        location: quarantine.directory,
        directory: 'present',
        entries,
        failure: new Error(
          `${label} quarantine 含未确认对象；不删除并保留人工位置 ${JSON.stringify(quarantine.directory)}`,
        ),
      }
    }
    fsyncBoundDirectory(
      paths,
      quarantine.directoryParents,
      `${label}空 quarantine 目录`,
    )
    rmdirSync(quarantine.directory)
    assertEntryMissingUnderParents(
      paths,
      quarantine.directory,
      quarantine.parentParents,
      `${label} quarantine 目录删除`,
    )
    fsyncBoundDirectory(
      paths,
      quarantine.parentParents,
      `${label} quarantine parent cleanup`,
    )
    return {
      status: 'complete',
      location: quarantine.directory,
      directory: 'missing',
      entries: [],
    }
  } catch (failure) {
    return {
      status: 'incomplete',
      location: quarantine.directory,
      directory: inspectEntryFact(
        paths,
        quarantine.directory,
        quarantine.parentParents,
        `${label} quarantine 状态`,
      ),
      entries: [],
      failure,
    }
  }
}

function quarantineCleanupFailureText(
  cleanup: DeletionQuarantineCleanupResult,
): string {
  return `quarantine cleanup=${cleanup.status}；directory=${cleanup.directory}；entries=${JSON.stringify(cleanup.entries)}；位置=${JSON.stringify(cleanup.location)}`
}

function assertEntryMissingUnderParents(
  paths: Paths,
  target: string,
  parents: readonly DirectorySnapshot[],
  label: string,
): void {
  assertParentsUnchanged(paths, parents, label, true)
  try {
    lstatSync(target)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      assertParentsUnchanged(paths, parents, label, true)
      return
    }
    throw error
  }
  die(`${label}路径仍被占用：${JSON.stringify(target)}`)
}

function inspectEntryFact(
  paths: Paths,
  target: string,
  parents: readonly DirectorySnapshot[],
  label: string,
): EntryFact {
  try {
    assertParentsUnchanged(paths, parents, label, true)
    const result = pathEntryExists(target) ? 'present' : 'missing'
    assertParentsUnchanged(paths, parents, label, true)
    return result
  } catch {
    return 'unknown'
  }
}

function stagingFacts(
  paths: Paths,
  staging: BackupStaging,
): Pick<StagingCleanupResult, 'payload' | 'directory'> {
  const directory = inspectEntryFact(
    paths,
    staging.directory,
    staging.runParents,
    '备份 staging 临时目录状态复验',
  )
  return {
    payload:
      directory === 'missing'
        ? 'missing'
        : inspectEntryFact(
            paths,
            staging.payload,
            staging.directoryParents,
            '备份 staging payload 状态复验',
          ),
    directory,
  }
}

function cleanupFactText(result: {
  readonly phase: StagingCleanupPhase
  readonly payload: EntryFact
  readonly directory: EntryFact
  readonly runDirectoryDurable: boolean
}): string {
  const fact = (value: EntryFact): string => {
    switch (value) {
      case 'present':
        return '存在'
      case 'missing':
        return '缺失'
      case 'unknown':
        return '无法安全确认'
    }
  }
  return `cleanup phase=${result.phase}；payload=${fact(result.payload)}；临时目录=${fact(result.directory)}；run 目录项持久化=${result.runDirectoryDurable ? '已完成' : '未完成'}`
}

function assertOwnedStagingPayload(
  paths: Paths,
  staging: BackupStaging,
  label: string,
): void {
  assertParentsUnchanged(paths, staging.directoryParents, label, true)
  const expected = staging.payloadSnapshot?.identity ?? staging.payloadIdentity
  if (expected === undefined) die(`${label}缺少本事务 payload 身份，拒绝删除`)
  const stat = assertExistingPath(paths, staging.payload, label)
  const identity = identityAtPath(staging.payload, stat)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== paths.ownerUid ||
    (stat.nlink !== 1 && stat.nlink !== 2) ||
    !samePublishedIdentity(expected, identity)
  ) {
    die(`${label}不再是本事务创建的 payload，拒绝删除`)
  }
  assertParentsUnchanged(paths, staging.directoryParents, label, true)
}

function cleanupBackupStaging(
  paths: Paths,
  staging: BackupStaging,
  label: string,
): StagingCleanupResult {
  let runDirectoryDurable = false
  let phase: StagingCleanupPhase = 'not-started'
  try {
    assertParentsUnchanged(paths, staging.runParents, label, true)
    if (!pathEntryExists(staging.directory)) {
      assertEntryMissingUnderParents(
        paths,
        staging.directory,
        staging.runParents,
        `${label}临时目录`,
      )
      phase = 'directory-removed'
      testFailure('backup-cleanup-run-dir-fsync')
      fsyncBoundDirectory(paths, staging.runParents, `${label}运行态目录`)
      runDirectoryDurable = true
      phase = 'complete'
      return {
        status: 'complete',
        phase,
        payload: 'missing',
        directory: 'missing',
        runDirectoryDurable,
      }
    }

    assertParentsUnchanged(paths, staging.directoryParents, label, true)
    if (pathEntryExists(staging.payload)) {
      assertOwnedStagingPayload(paths, staging, `${label} payload`)
      testFailure('backup-cleanup-payload-unlink')
      unlinkSync(staging.payload)
      assertEntryMissingUnderParents(
        paths,
        staging.payload,
        staging.directoryParents,
        `${label} payload unlink`,
      )
    }
    phase = 'payload-unlinked'

    testFailure('backup-cleanup-temp-dir-fsync')
    fsyncBoundDirectory(paths, staging.directoryParents, `${label}临时目录`)
    assertEntryMissingUnderParents(
      paths,
      staging.payload,
      staging.directoryParents,
      `${label} payload 持久化删除复验`,
    )
    phase = 'payload-unlink-durable'
    testFailure('backup-cleanup-temp-dir-rmdir')
    assertParentsUnchanged(paths, staging.directoryParents, label, true)
    rmdirSync(staging.directory)
    assertEntryMissingUnderParents(
      paths,
      staging.directory,
      staging.runParents,
      `${label}临时目录删除复验`,
    )
    phase = 'directory-removed'
    testFailure('backup-cleanup-run-dir-fsync')
    fsyncBoundDirectory(paths, staging.runParents, `${label}运行态目录`)
    runDirectoryDurable = true
    assertEntryMissingUnderParents(
      paths,
      staging.directory,
      staging.runParents,
      `${label}临时目录持久化删除复验`,
    )
    phase = 'complete'
    return {
      status: 'complete',
      phase,
      payload: 'missing',
      directory: 'missing',
      runDirectoryDurable,
    }
  } catch (failure) {
    const facts = stagingFacts(paths, staging)
    return {
      status: 'incomplete',
      phase,
      ...facts,
      runDirectoryDurable,
      failure,
    }
  }
}

function prepareBackupStaging(paths: Paths, backup: Backup): BackupStaging {
  const label = '备份元数据 staging'
  const runParents = parentSnapshots(
    paths,
    join(paths.run, '.retain-backup-staging-entry'),
  )
  assertParentsUnchanged(paths, runParents, label, true)
  let directory: string | undefined
  let staging: BackupStaging | undefined
  try {
    directory = mkdtempSync(join(paths.run, `.retain-${process.pid}-`))
    const directoryStat = lstatSync(directory)
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      directoryStat.uid !== paths.ownerUid
    ) {
      die(`${label}临时目录身份不安全：${JSON.stringify(directory)}`)
    }
    const directorySnapshot: DirectorySnapshot = {
      path: directory,
      realpath: realpathSync(directory),
      ...identityAtPath(directory, directoryStat),
    }
    staging = {
      directory,
      payload: join(directory, 'payload'),
      runParents,
      directoryParents: [...runParents, directorySnapshot],
      phase: 'directory-created',
    }
    assertParentsUnchanged(paths, staging.directoryParents, label, true)
    assertDerivedPath(paths, staging.payload, `${label} payload`)

    const descriptor = openSync(
      staging.payload,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      backup.metaSnapshot.identity.mode & 0o777,
    )
    try {
      const createdStat = fstatSync(descriptor)
      const createdIdentity = identityOfDescriptor(descriptor, createdStat)
      if (
        !createdStat.isFile() ||
        createdStat.nlink !== 1 ||
        createdStat.uid !== paths.ownerUid
      ) {
        die(`${label} payload 身份不安全`)
      }
      staging.payloadIdentity = createdIdentity
      staging.phase = 'payload-created'
      let offset = 0
      while (offset < backup.metaBytes.length) {
        offset += writeSync(
          descriptor,
          backup.metaBytes,
          offset,
          backup.metaBytes.length - offset,
          offset,
        )
      }
      fsyncSync(descriptor)
      const syncedIdentity = identityOfDescriptor(
        descriptor,
        fstatSync(descriptor),
      )
      if (
        !sameBoundaryIdentity(createdIdentity, syncedIdentity) ||
        syncedIdentity.nlink !== 1 ||
        syncedIdentity.size !== backup.metaBytes.length
      ) {
        die(`${label} payload 在写入或 fsync 期间发生身份变化`)
      }
      staging.payloadIdentity = syncedIdentity
      staging.phase = 'payload-synced'
    } catch (error) {
      try {
        staging.payloadIdentity = identityOfDescriptor(
          descriptor,
          fstatSync(descriptor),
        )
      } catch {
        // Keep the last descriptor identity. Cleanup will fail closed if the
        // pathname can no longer be proven to name that object.
      }
      throw error
    } finally {
      closeSync(descriptor)
    }

    staging.payloadSnapshot = captureFileSnapshot(
      paths,
      staging.payload,
      `${label} payload`,
    )
    const stablePayload = readCapturedFile(
      paths,
      staging.payload,
      `${label} payload`,
      staging.payloadSnapshot,
      true,
    )
    if (!stablePayload.bytes.equals(backup.metaBytes))
      die(`${label} payload 内容复验失败`)

    testFailure('backup-staging-temp-dir-fsync')
    fsyncBoundDirectory(paths, staging.directoryParents, `${label}临时目录`)
    staging.phase = 'payload-entry-durable'
    testCheckpoint('backup-after-staging-temp-dir-fsync')
    testFailure('backup-staging-run-dir-fsync')
    fsyncBoundDirectory(paths, staging.runParents, `${label}运行态目录`)
    staging.phase = 'directory-entry-durable'
    testCheckpoint('backup-after-staging-durable')
    const durablePayload = readCapturedFile(
      paths,
      staging.payload,
      `${label} payload`,
      staging.payloadSnapshot,
      true,
    )
    if (!durablePayload.bytes.equals(backup.metaBytes))
      die(`${label} 持久化后内容复验失败`)
    return staging
  } catch (failure) {
    if (staging === undefined) {
      const location = directory ?? paths.run
      throw new AggregateError(
        [failure],
        `备份元数据 staging 建立失败；成对删除尚未开始；临时对象无法安全确认或清理：${JSON.stringify(location)}`,
      )
    }
    const cleanup = cleanupBackupStaging(paths, staging, `${label}失败回收`)
    if (cleanup.status === 'complete') {
      throw new AggregateError(
        [failure],
        '备份元数据 staging 建立失败；成对删除尚未开始；本事务临时对象已持久化清理',
      )
    }
    throw new AggregateError(
      [failure, cleanup.failure],
      `备份元数据 staging 建立失败；成对删除尚未开始；临时对象 cleanup 不完整（${cleanupFactText(cleanup)}；位置=${JSON.stringify(staging.directory)}）`,
    )
  }
}

function waitForPublishedCapture(
  paths: Paths,
  destination: string,
  label: string,
  expectedIdentity?: FileIdentity,
): CapturedFile {
  const deadline = Date.now() + 1_000
  while (true) {
    assertDerivedPath(paths, destination, `${label}目标`)
    const stat = lstatSync(destination)
    if (!stat.isFile() || stat.isSymbolicLink())
      die(`${label}目标不是普通文件：${JSON.stringify(destination)}`)
    if (
      expectedIdentity !== undefined &&
      !samePublishedIdentity(
        expectedIdentity,
        identityAtPath(destination, stat),
      )
    )
      die(`${label}目标在发布后被替换：${JSON.stringify(destination)}`)
    // link(2) publication has a tiny, intentional nlink=2 interval until the
    // publisher removes its staging name. Wait for that transaction to settle.
    if (stat.nlink === 1) {
      const captured = readCapturedFile(paths, destination, `${label}目标`)
      if (
        expectedIdentity !== undefined &&
        !samePublishedIdentity(expectedIdentity, captured.snapshot.identity)
      )
        die(`${label}目标在发布捕获前被替换：${JSON.stringify(destination)}`)
      return captured
    }
    if (stat.nlink !== 2 || Date.now() >= deadline)
      die(`${label}目标硬链接状态不安全：${JSON.stringify(destination)}`)
    Atomics.wait(checkpointWait, 0, 0, 5)
  }
}

function samePublishedIdentity(
  expected: FileIdentity,
  actual: FileIdentity,
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.mode === actual.mode &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.uid === actual.uid
  )
}

interface Publication {
  readonly published: boolean
  readonly destination: CapturedFile
}

interface ApplyLock {
  readonly path: string
  readonly realpath: string
  readonly identity: FileIdentity
  readonly parents: readonly DirectorySnapshot[]
}

function acquireApplyLock(paths: Paths): ApplyLock {
  const lock = join(paths.run, '.retain-apply-lock')
  assertDerivedPath(paths, lock, '保留工具 apply 锁')
  assertExistingDirectory(paths, paths.run, '运行态目录')
  const parents = parentSnapshots(paths, lock)
  const deadline = performance.now() + 10_000
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 })
      assertParentsUnchanged(paths, parents, '保留工具 apply 锁', true)
      const stat = lstatSync(lock)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== paths.ownerUid
      )
        die('保留工具 apply 锁身份不安全')
      return {
        path: lock,
        realpath: realpathSync(lock),
        identity: identityAtPath(lock, stat),
        parents,
      }
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error
      assertParentsUnchanged(paths, parents, '保留工具 apply 锁', true)
      try {
        assertExistingDirectory(paths, lock, '保留工具 apply 锁')
      } catch (validationError) {
        // The owner may release the lock between our EEXIST and validation.
        // Retry only when no directory entry remains; persistent replacements
        // still fail through the normal path guard.
        if (!pathEntryExists(lock)) continue
        throw validationError
      }
      if (performance.now() >= deadline)
        die(`另一个保留工具 apply 10 秒内未完成：${JSON.stringify(lock)}`)
      Atomics.wait(checkpointWait, 0, 0, 10)
    }
  }
}

function releaseApplyLock(paths: Paths, lock: ApplyLock): void {
  assertParentsUnchanged(paths, lock.parents, '保留工具 apply 锁', true)
  const stat = lstatSync(lock.path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameIdentity(lock.identity, identityAtPath(lock.path, stat)) ||
    realpathSync(lock.path) !== lock.realpath
  ) {
    die('保留工具 apply 锁在运行中被替换，拒绝删除替换对象')
  }
  rmdirSync(lock.path)
  assertExistingDirectory(paths, paths.run, '运行态目录')
}

function publishTemporary(
  paths: Paths,
  temporary: string,
  temporarySnapshot: FileSnapshot,
  destination: string,
  label: string,
): Publication {
  assertDerivedPath(paths, destination, `${label}目标`)
  const destinationParents = parentSnapshots(paths, destination)
  assertFileUnchanged(paths, temporarySnapshot, `${label}临时文件`, true)
  try {
    assertParentsUnchanged(paths, destinationParents, `${label}目标`)
  } catch (error) {
    if (!pathEntryExists(destination)) throw error
    assertParentsUnchanged(paths, destinationParents, `${label}目标`, true)
  }
  let published = false
  try {
    linkSync(temporary, destination)
    published = true
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
  }
  // The staging inode now has nlink=2 when this process won publication, so
  // validate its immutable identity fields directly before dropping our name.
  const linkedStat = lstatSync(temporary)
  const linkedIdentity = identityAtPath(temporary, linkedStat)
  if (
    !samePublishedIdentity(temporarySnapshot.identity, linkedIdentity) ||
    linkedStat.nlink !== (published ? 2 : 1)
  ) {
    die(`${label}临时文件在发布时发生身份变化`)
  }
  unlinkSync(temporary)
  const temporaryDirectory = dirname(temporary)
  assertExistingDirectory(paths, temporaryDirectory, `${label}临时目录`)
  rmdirSync(temporaryDirectory)
  try {
    testCheckpoint('publication-after-staging-unlink')
    const captured = waitForPublishedCapture(
      paths,
      destination,
      label,
      published ? temporarySnapshot.identity : undefined,
    )
    fsyncDirectory(paths, dirname(destination), label)
    if (published)
      assertFileUnchanged(paths, captured.snapshot, `${label}目标`, true)
    return { published, destination: captured }
  } catch (error) {
    if (published && pathEntryExists(destination)) {
      const stat = assertExistingPath(
        paths,
        destination,
        `${label}发布清理目标`,
      )
      if (
        stat.isFile() &&
        stat.nlink === 1 &&
        samePublishedIdentity(
          temporarySnapshot.identity,
          identityAtPath(destination, stat),
        )
      ) {
        const ownPublication = captureFileSnapshot(
          paths,
          destination,
          `${label}发布清理目标`,
        )
        removeRegularFile(
          paths,
          destination,
          `${label}失败发布`,
          ownPublication,
        )
      }
    }
    throw error
  }
}

function assertLinkedCompensation(
  paths: Paths,
  temporary: string,
  temporarySnapshot: FileSnapshot,
  destination: string,
  destinationParents: readonly DirectorySnapshot[],
  expectedBytes: Buffer,
  label: string,
): void {
  assertParentsUnchanged(paths, temporarySnapshot.parents, label, true)
  assertParentsUnchanged(paths, destinationParents, label, true)
  const temporaryStat = assertExistingPath(paths, temporary, `${label}临时文件`)
  const destinationStat = assertExistingPath(paths, destination, `${label}目标`)
  const temporaryIdentity = identityAtPath(temporary, temporaryStat)
  const destinationIdentity = identityAtPath(destination, destinationStat)
  if (
    !temporaryStat.isFile() ||
    temporaryStat.isSymbolicLink() ||
    !destinationStat.isFile() ||
    destinationStat.isSymbolicLink() ||
    temporaryStat.uid !== paths.ownerUid ||
    destinationStat.uid !== paths.ownerUid ||
    temporaryStat.nlink !== 2 ||
    destinationStat.nlink !== 2 ||
    !samePublishedIdentity(temporarySnapshot.identity, temporaryIdentity) ||
    !sameIdentity(temporaryIdentity, destinationIdentity)
  ) {
    die(`${label}链接身份不安全`)
  }

  const descriptor = openSync(
    destination,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const opened = fstatSync(descriptor)
    const openedIdentity = identityOfDescriptor(descriptor, opened)
    if (!sameIdentity(destinationIdentity, openedIdentity))
      die(`${label}目标在验证与打开之间发生身份变化`)
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (count === 0) die(`${label}目标在读取期间被截断`)
      offset += count
    }
    if (!bytes.equals(expectedBytes)) die(`${label}目标内容不同`)
    const after = identityOfDescriptor(descriptor, fstatSync(descriptor))
    if (!sameIdentity(openedIdentity, after))
      die(`${label}目标在读取期间发生身份变化`)
  } finally {
    closeSync(descriptor)
  }

  const stableTemporary = assertExistingPath(
    paths,
    temporary,
    `${label}临时文件`,
  )
  const stableDestination = assertExistingPath(
    paths,
    destination,
    `${label}目标`,
  )
  if (
    !sameIdentity(
      temporaryIdentity,
      identityAtPath(temporary, stableTemporary),
    ) ||
    !sameIdentity(
      destinationIdentity,
      identityAtPath(destination, stableDestination),
    )
  ) {
    die(`${label}链接在验证期间发生变化`)
  }
  assertParentsUnchanged(paths, temporarySnapshot.parents, label, true)
  assertParentsUnchanged(paths, destinationParents, label, true)
}

function publishCompensationTemporary(
  paths: Paths,
  staging: BackupStaging,
  destination: string,
  expectedDestinationParents: readonly DirectorySnapshot[],
  expectedBytes: Buffer,
): CompensationPublicationResult {
  const label = '备份元数据补偿恢复'
  let phase: Exclude<CompensationPublicationPhase, 'committed'> = 'not-linked'
  try {
    const temporarySnapshot = staging.payloadSnapshot
    if (temporarySnapshot === undefined)
      die(`${label}缺少 durable staging payload 身份`)
    if (staging.phase !== 'directory-entry-durable')
      die(`${label}拒绝使用未完整持久化的 staging`)
    assertDerivedPath(paths, destination, `${label}目标`)
    assertParentsUnchanged(paths, expectedDestinationParents, label, true)
    assertFileUnchanged(paths, temporarySnapshot, `${label}临时文件`, true)

    try {
      linkSync(staging.payload, destination)
      phase = 'linked'
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST'))
        die(`${label}目标已被占用；拒绝覆盖并保留 staging`)
      throw error
    }

    testCheckpoint('backup-compensation-after-link')
    assertLinkedCompensation(
      paths,
      staging.payload,
      temporarySnapshot,
      destination,
      expectedDestinationParents,
      expectedBytes,
      label,
    )
    testFailure('backup-compensation-destination-fsync')
    fsyncBoundDirectory(paths, expectedDestinationParents, `${label}目标目录`)
    phase = 'directory-synced'
    assertLinkedCompensation(
      paths,
      staging.payload,
      temporarySnapshot,
      destination,
      expectedDestinationParents,
      expectedBytes,
      label,
    )
    return { status: 'committed', phase: 'committed' }
  } catch (failure) {
    return { status: 'not-committed', phase, failure }
  }
}

function atomicStableCopy(
  paths: Paths,
  source: string,
  destination: string,
  label: string,
  checkpoint: string,
  expected?: FileSnapshot,
): 'applied' | 'settled' {
  ensureSafeDirectory(paths, dirname(destination))
  const captured = readCapturedFile(
    paths,
    source,
    `${label}源文件`,
    expected,
    true,
  )
  if (pathEntryExists(destination)) {
    const published = waitForPublishedCapture(paths, destination, label)
    const stable = readCapturedFile(
      paths,
      source,
      `${label}源文件`,
      captured.snapshot,
    )
    if (
      !sameCapture(captured, stable) ||
      !published.bytes.equals(captured.bytes)
    )
      die(`${label}目标已存在且内容不同：${JSON.stringify(destination)}`)
    return 'settled'
  }
  const temporary = uniqueTemporary(paths, label)
  let temporarySnapshot: FileSnapshot | undefined
  let publication: Publication | undefined
  try {
    temporarySnapshot = writeCapturedTemporary(
      paths,
      temporary,
      captured.bytes,
      label,
    )
    testCheckpoint(checkpoint)
    const stableBefore = readCapturedFile(
      paths,
      source,
      `${label}源文件`,
      captured.snapshot,
    )
    if (!sameCapture(captured, stableBefore))
      die(`${label}源文件在复制期间发生内容变化：${JSON.stringify(source)}`)
    publication = publishTemporary(
      paths,
      temporary,
      temporarySnapshot,
      destination,
      label,
    )
    if (!publication.destination.bytes.equals(captured.bytes))
      die(`${label}发布后内容校验失败：${JSON.stringify(destination)}`)
    const stableAfter = readCapturedFile(
      paths,
      source,
      `${label}源文件`,
      captured.snapshot,
    )
    if (!sameCapture(captured, stableAfter))
      die(`${label}源文件在发布期间发生内容变化：${JSON.stringify(source)}`)
    return publication.published ? 'applied' : 'settled'
  } catch (error) {
    if (publication?.published === true && pathEntryExists(destination)) {
      removeRegularFile(
        paths,
        destination,
        `${label}过时发布`,
        publication.destination.snapshot,
      )
    }
    if (pathEntryExists(dirname(temporary)))
      removeTemporary(paths, temporary, label, temporarySnapshot)
    throw error
  }
}

function removeRegularFile(
  paths: Paths,
  target: string,
  label: string,
  expected?: FileSnapshot,
): 'applied' | 'settled' {
  if (!pathEntryExists(target)) return 'settled'
  let current: FileSnapshot
  try {
    current = captureFileSnapshot(paths, target, label)
  } catch (error) {
    if (!pathEntryExists(target)) return 'settled'
    throw error
  }
  if (expected !== undefined) assertFileUnchanged(paths, expected, label)
  testCheckpoint('before-delete')
  if (!pathEntryExists(target)) return 'settled'
  const planned = expected ?? current
  let quarantine: DeletionQuarantine | undefined
  const isolatedName = 'payload'
  try {
    quarantine = allocateDeletionQuarantine(paths, dirname(target), label)
    const isolated = isolatePlannedFile(
      paths,
      quarantine,
      planned,
      isolatedName,
      label,
      'generic-delete-before-quarantine-rename',
    )
    deleteIsolatedFile(paths, quarantine, isolated, label)
    const cleanup = cleanupDeletionQuarantine(paths, quarantine, label)
    if (cleanup.status === 'incomplete')
      throw new AggregateError(
        [cleanup.failure],
        `${label}计划对象已在私有 quarantine 删除，但 cleanup 不完整（${quarantineCleanupFailureText(cleanup)}）`,
      )
    assertEntryMissingUnderParents(
      paths,
      target,
      planned.parents,
      `${label}删除提交复验`,
    )
    return 'applied'
  } catch (failure) {
    if (quarantine === undefined) throw failure
    const recoveryFailures: unknown[] = []
    const isolated = join(quarantine.directory, isolatedName)
    try {
      rollbackQuarantineEntry(
        paths,
        quarantine,
        isolated,
        target,
        planned.parents,
        planned.identity,
        `${label}失败回滚`,
      )
    } catch (rollbackFailure) {
      recoveryFailures.push(rollbackFailure)
    }
    const cleanup = cleanupDeletionQuarantine(
      paths,
      quarantine,
      `${label}失败回滚`,
    )
    if (cleanup.status === 'incomplete') recoveryFailures.push(cleanup.failure)
    throw new AggregateError(
      [failure, ...recoveryFailures],
      `${label}安全删除未完成；公开 pathname replacement 未被 unlink 或覆盖（${quarantineCleanupFailureText(cleanup)}）`,
    )
  }
}

function removePlannedFile(
  paths: Paths,
  snapshot: FileSnapshot,
  label: string,
): 'applied' | 'settled' {
  if (!pathEntryExists(snapshot.path)) return 'settled'
  let current: FileSnapshot
  try {
    assertFileUnchanged(paths, snapshot, label, true)
    current = captureFileSnapshot(paths, snapshot.path, label)
  } catch (error) {
    if (!pathEntryExists(snapshot.path)) return 'settled'
    throw error
  }
  return removeRegularFile(paths, snapshot.path, label, current)
}

function originalBackupMetadataIsSafe(paths: Paths, backup: Backup): boolean {
  if (!pathEntryExists(backup.meta)) return false
  let captured: CapturedFile
  try {
    captured = readCapturedFile(
      paths,
      backup.meta,
      '备份元数据安全复验',
      backup.metaSnapshot,
      true,
    )
  } catch (error) {
    if (!pathEntryExists(backup.meta)) return false
    throw error
  }
  if (!captured.bytes.equals(backup.metaBytes))
    die(`备份元数据安全复验内容不同：${JSON.stringify(backup.meta)}`)
  return true
}

function compensateBackupDeletion(
  paths: Paths,
  backup: Backup,
  staging: BackupStaging,
): BackupCompensationResult {
  let metadataSafe = false
  let metadataCheckFailure: unknown
  try {
    metadataSafe = originalBackupMetadataIsSafe(paths, backup)
  } catch (error) {
    metadataCheckFailure = error
  }

  if (metadataSafe) {
    return {
      status: 'original-safe',
      cleanup: cleanupBackupStaging(paths, staging, '备份元数据补偿 cleanup'),
    }
  }

  const publication = publishCompensationTemporary(
    paths,
    staging,
    backup.meta,
    backup.metaSnapshot.parents,
    backup.metaBytes,
  )
  if (publication.status === 'not-committed') {
    const facts = stagingFacts(paths, staging)
    return {
      status: 'restore-not-committed',
      publicationFailure: publication.failure,
      publicationPhase: publication.phase,
      originalCheckFailure: metadataCheckFailure,
      ...facts,
    }
  }
  testCheckpoint('backup-compensation-after-commit')
  const payloadSnapshot = staging.payloadSnapshot
  if (payloadSnapshot === undefined)
    die('备份元数据补偿提交后缺少 staging payload 身份')
  try {
    assertLinkedCompensation(
      paths,
      staging.payload,
      payloadSnapshot,
      backup.meta,
      backup.metaSnapshot.parents,
      backup.metaBytes,
      '备份元数据补偿 cleanup 前复验',
    )
  } catch (failure) {
    const facts = stagingFacts(paths, staging)
    return {
      status: 'restore-committed',
      cleanup: {
        status: 'incomplete',
        phase: 'not-started',
        ...facts,
        runDirectoryDurable: false,
        failure,
      },
      originalCheckFailure: metadataCheckFailure,
    }
  }
  return {
    status: 'restore-committed',
    cleanup: cleanupBackupStaging(paths, staging, '备份元数据补偿 cleanup'),
    originalCheckFailure: metadataCheckFailure,
  }
}

function failBackupRecordWithRecovery(
  paths: Paths,
  backup: Backup,
  staging: BackupStaging,
  deletion: Extract<PairedDeletionResult, { status: 'not-committed' }>,
): never {
  const failure = deletion.failure
  const deletionPhase = `paired phase=${deletion.phase}`
  const compensation = compensateBackupDeletion(paths, backup, staging)
  switch (compensation.status) {
    case 'original-safe': {
      if (compensation.cleanup.status === 'complete') {
        throw new AggregateError(
          [failure],
          `备份成对删除未提交，不能确认归档提交完成（${deletionPhase}）；计划元数据经原身份和字节稳定复验仍安全；staging cleanup 已持久化完成`,
        )
      }
      throw new AggregateError(
        [failure, compensation.cleanup.failure],
        `备份成对删除未提交，不能确认归档提交完成（${deletionPhase}）；计划元数据经原身份和字节稳定复验仍安全；staging cleanup 不完整（${cleanupFactText(compensation.cleanup)}；位置=${JSON.stringify(staging.directory)}）`,
      )
    }
    case 'restore-not-committed':
      throw new AggregateError(
        [
          failure,
          ...(compensation.originalCheckFailure === undefined
            ? []
            : [compensation.originalCheckFailure]),
          compensation.publicationFailure,
        ],
        `备份成对删除未提交，不能确认归档提交完成（${deletionPhase}）；元数据恢复也未持久化提交（publication phase=${compensation.publicationPhase}）；未覆盖或删除并发对象；staging 状态 payload=${compensation.payload}、临时目录=${compensation.directory}，位置=${JSON.stringify(staging.directory)}`,
      )
    case 'restore-committed': {
      const failures = [
        failure,
        ...(compensation.originalCheckFailure === undefined
          ? []
          : [compensation.originalCheckFailure]),
      ]
      if (compensation.cleanup.status === 'complete') {
        throw new AggregateError(
          failures,
          `备份成对删除未提交，不能确认归档提交完成（${deletionPhase}）；原元数据已从 staging 无覆盖恢复并完整验证；恢复成功且目录项已持久化，cleanup 已完成`,
        )
      }
      throw new AggregateError(
        [...failures, compensation.cleanup.failure],
        `备份成对删除未提交，不能确认归档提交完成（${deletionPhase}）；原元数据已从 staging 无覆盖恢复并完整验证；恢复成功但 cleanup 不完整（${cleanupFactText(compensation.cleanup)}；临时目录位置=${JSON.stringify(staging.directory)}）`,
      )
    }
  }
}

function attemptPairedBackupDeletion(
  paths: Paths,
  backup: Backup,
): PairedDeletionResult {
  let phase: Exclude<PairedDeletionPhase, 'committed'> = 'ready'
  let quarantine: DeletionQuarantine | undefined
  const metadataName = 'metadata'
  const archiveName = 'archive'
  try {
    assertFileUnchanged(paths, backup.metaSnapshot, '备份元数据', true)
    assertFileUnchanged(paths, backup.archiveSnapshot, '备份归档', true)
    testCheckpoint('backup-before-delete')
    assertFileUnchanged(paths, backup.metaSnapshot, '备份元数据', true)
    assertFileUnchanged(paths, backup.archiveSnapshot, '备份归档', true)

    quarantine = allocateDeletionQuarantine(
      paths,
      paths.backups,
      '备份成对删除',
    )
    const isolatedMetadata = isolatePlannedFile(
      paths,
      quarantine,
      backup.metaSnapshot,
      metadataName,
      '备份元数据',
    )
    deleteIsolatedFile(paths, quarantine, isolatedMetadata, '备份元数据')
    phase = 'metadata-unlinked'
    testCheckpoint('backup-after-meta-delete')
    testFailure('backup-after-meta-delete')
    assertFileUnchanged(paths, backup.archiveSnapshot, '备份归档', true)
    const isolatedArchive = isolatePlannedFile(
      paths,
      quarantine,
      backup.archiveSnapshot,
      archiveName,
      '备份归档',
      'backup-archive-before-quarantine-rename',
    )
    deleteIsolatedFile(paths, quarantine, isolatedArchive, '备份归档')
    phase = 'archive-unlinked'

    testCheckpoint('backup-after-archive-delete')
    testFailure('backup-deletion-directory-fsync')
    assertParentsUnchanged(
      paths,
      backup.archiveSnapshot.parents,
      '备份成对删除提交',
      true,
    )
    fsyncBoundDirectory(
      paths,
      backup.metaSnapshot.parents,
      '备份成对删除 backups 目录提交',
    )
    phase = 'directory-synced'
    testCheckpoint('backup-after-deletion-directory-fsync')
    assertEntryMissingUnderParents(
      paths,
      backup.meta,
      backup.metaSnapshot.parents,
      '备份成对删除 metadata 提交复验',
    )
    assertEntryMissingUnderParents(
      paths,
      backup.archive,
      backup.archiveSnapshot.parents,
      '备份成对删除 archive 提交复验',
    )
    const quarantineCleanup = cleanupDeletionQuarantine(
      paths,
      quarantine,
      '已提交备份成对删除',
    )
    return {
      status: 'committed',
      phase: 'committed',
      quarantineCleanup,
    }
  } catch (failure) {
    if (quarantine === undefined)
      return { status: 'not-committed', phase, failure }
    const recoveryFailures: unknown[] = []
    for (const item of [
      {
        isolated: join(quarantine.directory, archiveName),
        destination: backup.archive,
        parents: backup.archiveSnapshot.parents,
        identity: backup.archiveSnapshot.identity,
        label: '备份归档 quarantine 失败回滚',
      },
      {
        isolated: join(quarantine.directory, metadataName),
        destination: backup.meta,
        parents: backup.metaSnapshot.parents,
        identity: backup.metaSnapshot.identity,
        label: '备份元数据 quarantine 失败回滚',
      },
    ]) {
      try {
        rollbackQuarantineEntry(
          paths,
          quarantine,
          item.isolated,
          item.destination,
          item.parents,
          item.identity,
          item.label,
        )
      } catch (rollbackFailure) {
        recoveryFailures.push(rollbackFailure)
      }
    }
    const cleanup = cleanupDeletionQuarantine(
      paths,
      quarantine,
      '备份成对删除失败回滚',
    )
    if (cleanup.status === 'incomplete') recoveryFailures.push(cleanup.failure)
    const transactionFailure =
      recoveryFailures.length === 0
        ? failure
        : new AggregateError(
            [failure, ...recoveryFailures],
            `备份成对删除 quarantine 回滚或 cleanup 不完整（${quarantineCleanupFailureText(cleanup)}）`,
          )
    return { status: 'not-committed', phase, failure: transactionFailure }
  }
}

function removeBackupRecord(
  paths: Paths,
  backup: Backup,
): 'applied' | 'settled' {
  const staging = prepareBackupStaging(paths, backup)
  const deletion = attemptPairedBackupDeletion(paths, backup)
  if (deletion.status === 'not-committed') {
    failBackupRecordWithRecovery(paths, backup, staging, deletion)
  }

  const cleanup = cleanupBackupStaging(
    paths,
    staging,
    '已提交备份删除 staging cleanup',
  )
  if (
    cleanup.status === 'incomplete' ||
    deletion.quarantineCleanup.status === 'incomplete'
  ) {
    const failures = [
      cleanup.failure,
      deletion.quarantineCleanup.failure,
    ].filter(failure => failure !== undefined)
    throw new AggregateError(
      failures,
      `备份成对删除已持久化提交，但事务 cleanup 不完整（staging: ${cleanupFactText(cleanup)}；quarantine: ${quarantineCleanupFailureText(deletion.quarantineCleanup)}）`,
    )
  }
  return 'applied'
}

function planBackups(paths: Paths, now: number): Plan {
  const entries = readDirectory(paths, paths.backups, '备份 store')
  const backups: Backup[] = []
  const accounted = new Set<string>()
  const errors: PlanIssue[] = []
  let invalidRecords = 0
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!SNAPSHOT_ID.test(id)) continue
    const meta = join(paths.backups, name)
    const archiveName = `${id}.tar.gz`
    const archive = join(paths.backups, archiveName)
    accounted.add(name)
    accounted.add(archiveName)
    try {
      const metaCapture = readCapturedFile(paths, meta, '备份元数据')
      const archiveSnapshot = captureFileSnapshot(paths, archive, '备份归档')
      let parsed: unknown
      try {
        parsed = JSON.parse(metaCapture.bytes.toString('utf8'))
      } catch {
        die(`备份：元数据不是有效 JSON（${JSON.stringify(meta)}）`)
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('id' in parsed) ||
        !('createdAt' in parsed) ||
        parsed.id !== id ||
        typeof parsed.createdAt !== 'number' ||
        !Number.isFinite(parsed.createdAt) ||
        !Number.isSafeInteger(parsed.createdAt) ||
        parsed.createdAt <= 0 ||
        parsed.createdAt > DATE_MAX_MS ||
        parsed.createdAt > now
      ) {
        die(
          `备份：元数据身份或时间戳无效或异常未来时间（${JSON.stringify(meta)}）`,
        )
      }
      backups.push({
        id,
        createdAt: parsed.createdAt,
        archive,
        meta,
        metaBytes: metaCapture.bytes,
        archiveSnapshot,
        metaSnapshot: metaCapture.snapshot,
      })
    } catch (error) {
      invalidRecords += 1
      errors.push({ message: errorMessage(error) })
    }
  }

  const orphans = entries.filter(name => !accounted.has(name))
  for (const name of orphans) {
    invalidRecords += 1
    const path = join(paths.backups, name)
    try {
      captureFileSnapshot(paths, path, '备份 orphan 实物')
      errors.push({
        message: `备份：发现缺少元数据或无法识别的实物（${JSON.stringify(path)}）`,
      })
    } catch (error) {
      errors.push({ message: errorMessage(error) })
    }
  }

  const fullCutoff = now - BACKUP_FULL_RETENTION_MS
  const dailyWindow = utcDayWindowStart(now)
  const representatives = new Set<string>()
  const days = new Map<string, Backup[]>()
  for (const backup of backups) {
    if (backup.createdAt >= fullCutoff || backup.createdAt < dailyWindow)
      continue
    const day = utcDay(backup.createdAt)
    const sameDay = days.get(day) ?? []
    sameDay.push(backup)
    days.set(day, sameDay)
  }
  for (const sameDay of days.values()) {
    sameDay.sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    )
    representatives.add(sameDay[0].id)
  }
  const remove = backups.filter(backup => {
    if (backup.createdAt >= fullCutoff) return false
    if (backup.createdAt >= dailyWindow) return !representatives.has(backup.id)
    return true
  })
  return {
    name: '备份',
    operations: remove.map(backup => ({
      execute: () => removeBackupRecord(paths, backup),
    })),
    remaining: backups.length - remove.length + invalidRecords,
    warnings: [],
    errors,
  }
}

function activeLogNames(paths: Paths): {
  readonly values: ReadonlySet<string>
  readonly issues: readonly PlanIssue[]
} {
  const active = new Set<string>()
  const issues: PlanIssue[] = []
  for (const name of readDirectory(paths, paths.run, '运行态目录')) {
    if (!name.endsWith('.pid')) continue
    const pidFile = join(paths.run, name)
    try {
      const pidCapture = readCapturedFile(paths, pidFile, 'pid 文件')
      const pid = Number(pidCapture.bytes.toString('utf8').trim())
      if (!Number.isSafeInteger(pid) || pid <= 0)
        die(`pid 文件不是有效正整数：${JSON.stringify(pidFile)}`)
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (hasErrorCode(error, 'ESRCH')) continue
        if (!hasErrorCode(error, 'EPERM')) throw error
      }
      const processName = name.slice(0, -'.pid'.length)
      active.add(`${processName}.out`)
      active.add(`${processName}.err`)
    } catch (error) {
      issues.push({ message: errorMessage(error) })
    }
  }
  return { values: active, issues }
}

function verifyGzipCapture(
  captured: CapturedFile,
  source: CapturedFile,
  label: string,
): void {
  let decompressed: Buffer
  try {
    decompressed = gunzipSync(captured.bytes)
  } catch {
    die(`${label} 不是有效 gzip`)
  }
  if (!decompressed.equals(source.bytes))
    die(`${label} 解压内容与稳定日志源不一致`)
  if (
    Math.abs(
      captured.snapshot.identity.mtimeMs - source.snapshot.identity.mtimeMs,
    ) >= 1
  )
    die(`${label} 的保留时间与日志源不一致`)
}

function gzipLog(
  paths: Paths,
  source: string,
  destination: string,
  expected: CapturedFile,
): 'applied' | 'settled' {
  if (!pathEntryExists(source)) {
    if (!pathEntryExists(destination))
      die(`日志源与 gzip 目标同时缺失：${JSON.stringify(source)}`)
    const published = waitForPublishedCapture(paths, destination, '日志 gzip')
    verifyGzipCapture(
      published,
      expected,
      `日志 gzip 目标 ${JSON.stringify(destination)}`,
    )
    return 'settled'
  }
  const captured = readCapturedFile(
    paths,
    source,
    '日志源文件',
    expected.snapshot,
    true,
  )
  if (!captured.bytes.equals(expected.bytes))
    die(`日志源文件在计划后被改写：${JSON.stringify(source)}`)
  const compressed = gzipSync(captured.bytes)
  const temporary = uniqueTemporary(paths, '日志 gzip')
  let temporarySnapshot: FileSnapshot | undefined
  let publication: Publication | undefined
  try {
    temporarySnapshot = writeCapturedTemporary(
      paths,
      temporary,
      compressed,
      '日志 gzip',
      captured.snapshot.identity.mode & 0o777,
      {
        atime: new Date(captured.snapshot.identity.mtimeMs),
        mtime: new Date(captured.snapshot.identity.mtimeMs),
      },
    )
    const temporaryCapture = readCapturedFile(
      paths,
      temporary,
      '日志 gzip 临时文件',
      temporarySnapshot,
    )
    verifyGzipCapture(
      temporaryCapture,
      captured,
      `日志 gzip 临时文件 ${JSON.stringify(temporary)}`,
    )
    testCheckpoint('log-after-capture')
    const stableBefore = readCapturedFile(
      paths,
      source,
      '日志源文件',
      captured.snapshot,
      true,
    )
    if (!sameCapture(captured, stableBefore))
      die(`日志源文件在压缩期间被改写：${JSON.stringify(source)}`)
    ensureSafeDirectory(paths, dirname(destination))
    publication = publishTemporary(
      paths,
      temporary,
      temporarySnapshot,
      destination,
      '日志 gzip',
    )
    verifyGzipCapture(
      publication.destination,
      captured,
      `日志 gzip 目标 ${JSON.stringify(destination)}`,
    )
    if (!pathEntryExists(source)) return 'settled'
    const stableAfter = readCapturedFile(
      paths,
      source,
      '日志源文件',
      captured.snapshot,
      true,
    )
    if (!sameCapture(captured, stableAfter))
      die(`日志源文件在发布期间被改写：${JSON.stringify(source)}`)
    removeRegularFile(paths, source, '日志源文件', stableAfter.snapshot)
    return publication.published ? 'applied' : 'settled'
  } catch (error) {
    if (!pathEntryExists(source) && pathEntryExists(destination)) {
      const settled = waitForPublishedCapture(paths, destination, '日志 gzip')
      verifyGzipCapture(
        settled,
        captured,
        `日志 gzip 目标 ${JSON.stringify(destination)}`,
      )
      if (pathEntryExists(dirname(temporary)))
        removeTemporary(paths, temporary, '日志 gzip', temporarySnapshot)
      return 'settled'
    }
    if (publication?.published === true && pathEntryExists(destination)) {
      removeRegularFile(
        paths,
        destination,
        '日志 gzip 过时发布',
        publication.destination.snapshot,
      )
    }
    if (pathEntryExists(dirname(temporary)))
      removeTemporary(paths, temporary, '日志 gzip', temporarySnapshot)
    throw error
  }
}

function planLogs(paths: Paths, now: number): Plan {
  const activeScan = activeLogNames(paths)
  const active = activeScan.values
  const operations: Operation[] = []
  const errors: PlanIssue[] = [...activeScan.issues]
  let remaining = 0
  const files: {
    readonly name: string
    readonly path: string
    readonly snapshot: FileSnapshot
  }[] = []
  for (const name of readDirectory(paths, paths.logs, '日志目录')) {
    const path = join(paths.logs, name)
    try {
      files.push({
        name,
        path,
        snapshot: captureFileSnapshot(paths, path, '日志文件'),
      })
    } catch (error) {
      errors.push({ message: errorMessage(error) })
      remaining += 1
    }
  }
  const pairedGzip = new Set(
    files
      .filter(file => file.name.endsWith('.out') || file.name.endsWith('.err'))
      .map(file => `${file.name}.${utcDay(file.snapshot.identity.mtimeMs)}.gz`),
  )
  for (const { name, path, snapshot } of files) {
    try {
      const age = now - snapshot.identity.mtimeMs
      if (name.endsWith('.gz')) {
        // A raw peer owns validation for this target. Defer gzip retirement until
        // a later scan, even when both files already exceed the retention window.
        if (pairedGzip.has(name)) continue
        if (age >= LOG_RETENTION_MS) {
          operations.push({
            execute: () => removePlannedFile(paths, snapshot, '过期 gzip 日志'),
          })
        } else {
          remaining += 1
        }
        continue
      }
      if (!name.endsWith('.out') && !name.endsWith('.err')) {
        remaining += 1
        continue
      }
      const destination = `${path}.${utcDay(snapshot.identity.mtimeMs)}.gz`
      assertDerivedPath(paths, destination, '日志 gzip 目标')
      const sourceCapture = readCapturedFile(
        paths,
        path,
        '日志源文件',
        snapshot,
      )
      if (pathEntryExists(destination)) {
        const gzipCapture = readCapturedFile(
          paths,
          destination,
          '日志 gzip 目标',
        )
        verifyGzipCapture(
          gzipCapture,
          sourceCapture,
          `日志 gzip 目标 ${JSON.stringify(destination)}`,
        )
        const stableSource = readCapturedFile(
          paths,
          path,
          '日志源文件',
          sourceCapture.snapshot,
        )
        if (!sameCapture(sourceCapture, stableSource))
          die(`日志源文件在预检期间被改写：${JSON.stringify(path)}`)
      }
      if (active.has(name)) {
        remaining += 1
        continue
      }
      operations.push({
        execute: () => gzipLog(paths, path, destination, sourceCapture),
      })
      remaining += 1
    } catch (error) {
      errors.push({ message: errorMessage(error) })
      remaining += 1
    }
  }
  return { name: '日志', operations, remaining, warnings: [], errors }
}

function nodeDirectories(paths: Paths): {
  readonly values: readonly string[]
  readonly issues: readonly PlanIssue[]
} {
  const values: string[] = []
  const issues: PlanIssue[] = []
  for (const name of readDirectory(paths, paths.nodes, '节点目录')) {
    const path = join(paths.nodes, name)
    try {
      const stat = assertExistingPath(paths, path, '节点目录项')
      if (!stat.isDirectory())
        die(`节点目录项不是目录：${JSON.stringify(path)}`)
      values.push(path)
    } catch (error) {
      issues.push({ message: errorMessage(error) })
    }
  }
  return { values, issues }
}

function planAudits(paths: Paths, now: number): Plan {
  if (!isSunday(now))
    return {
      name: '审计链',
      operations: [],
      remaining: 0,
      warnings: [],
      errors: [],
    }
  const week = isoWeek(now)
  const operations: Operation[] = []
  const errors: PlanIssue[] = []
  let remaining = 0
  for (const name of readDirectory(paths, paths.nodes, '节点目录')) {
    try {
      const node = join(paths.nodes, name)
      const nodeStat = assertExistingPath(paths, node, '节点目录项')
      if (!nodeStat.isDirectory())
        die(`节点目录项不是目录：${JSON.stringify(node)}`)
      const source = join(node, 'config/qianmo/audit/trail.ndjson')
      if (!pathEntryExists(source)) continue
      const sourceCapture = readCapturedFile(paths, source, '审计链源文件')
      const destination = join(
        dirname(source),
        'archive',
        `trail-${week}.ndjson`,
      )
      if (pathEntryExists(destination)) {
        const destinationCapture = waitForPublishedCapture(
          paths,
          destination,
          '审计链封存',
        )
        const stableSource = readCapturedFile(
          paths,
          source,
          '审计链源文件',
          sourceCapture.snapshot,
        )
        if (
          !sameCapture(sourceCapture, stableSource) ||
          !destinationCapture.bytes.equals(sourceCapture.bytes)
        ) {
          die(
            `审计链：封存目标已存在且内容不同（${JSON.stringify(destination)}）`,
          )
        }
        remaining += 1
        continue
      }
      operations.push({
        execute: () =>
          atomicStableCopy(
            paths,
            source,
            destination,
            '审计链封存',
            'audit-after-capture',
            sourceCapture.snapshot,
          ),
      })
      remaining += 1
    } catch (error) {
      errors.push({ message: errorMessage(error) })
      remaining += 1
    }
  }
  return {
    name: '审计链',
    operations,
    remaining,
    warnings: [],
    errors,
  }
}

function snapshots(paths: Paths): {
  readonly values: RegistrySnapshot[]
  readonly issues: readonly PlanIssue[]
} {
  const result: RegistrySnapshot[] = []
  const issues: PlanIssue[] = []
  for (const name of readDirectory(
    paths,
    paths.registrySnapshots,
    '注册表快照目录',
  )) {
    const match = REGISTRY_SNAPSHOT.exec(name)
    if (match === null) continue
    const path = join(paths.registrySnapshots, name)
    try {
      const snapshot = captureFileSnapshot(paths, path, '注册表快照')
      result.push({ name, path, stamp: match[1], snapshot })
    } catch (error) {
      issues.push({ message: errorMessage(error) })
    }
  }
  return { values: result, issues }
}

function planRegistry(
  paths: Paths,
  now: number,
  snapshotRegistry: boolean,
): Plan {
  const snapshotScan = snapshots(paths)
  const current = snapshotScan.values
  const errors: PlanIssue[] = [...snapshotScan.issues]
  const operations: Operation[] = []
  if (snapshotRegistry) {
    try {
      const sourceCapture = readCapturedFile(
        paths,
        paths.registryState,
        '注册表当前落盘',
      )
      const name = `registry-${utcStamp(now)}.json`
      const destination = join(paths.registrySnapshots, name)
      if (pathEntryExists(destination)) {
        const destinationCapture = waitForPublishedCapture(
          paths,
          destination,
          '注册表快照',
        )
        const stableSource = readCapturedFile(
          paths,
          paths.registryState,
          '注册表当前落盘',
          sourceCapture.snapshot,
        )
        if (
          !sameCapture(sourceCapture, stableSource) ||
          !destinationCapture.bytes.equals(sourceCapture.bytes)
        ) {
          die(
            `注册表：同一时间戳快照已存在且内容不同（${JSON.stringify(destination)}）`,
          )
        }
      } else {
        current.push({ name, path: destination, stamp: utcStamp(now) })
        operations.push({
          execute: () => {
            ensureSafeDirectory(paths, paths.registrySnapshots)
            return atomicStableCopy(
              paths,
              paths.registryState,
              destination,
              '注册表快照',
              'registry-after-capture',
              sourceCapture.snapshot,
            )
          },
        })
      }
    } catch (error) {
      errors.push({ message: errorMessage(error) })
    }
  }
  current.sort(
    (a, b) => a.stamp.localeCompare(b.stamp) || a.name.localeCompare(b.name),
  )
  const remove = current.slice(0, Math.max(0, current.length - 4))
  operations.push(
    ...remove.map(snapshot => ({
      execute: () => {
        if (!pathEntryExists(snapshot.path)) return 'settled'
        if (snapshot.snapshot !== undefined)
          return removePlannedFile(paths, snapshot.snapshot, '旧注册表快照')
        const current = captureFileSnapshot(
          paths,
          snapshot.path,
          '旧注册表快照',
        )
        return removeRegularFile(paths, snapshot.path, '旧注册表快照', current)
      },
    })),
  )
  return {
    name: '注册表快照',
    operations,
    remaining: Math.min(4, current.length),
    warnings: [],
    errors,
  }
}

function planLedgers(paths: Paths): Plan {
  const warnings: string[] = []
  const nodeScan = nodeDirectories(paths)
  const errors: PlanIssue[] = [...nodeScan.issues]
  let remaining = 0
  for (const node of nodeScan.values) {
    const resident = join(node, 'config/resident')
    let agents: readonly string[]
    try {
      if (!pathEntryExists(resident)) continue
      agents = readDirectory(paths, resident, '准入台账目录')
    } catch (error) {
      errors.push({ message: errorMessage(error) })
      remaining += 1
      continue
    }
    for (const agent of agents) {
      const agentDirectory = join(resident, agent)
      try {
        const agentStat = assertExistingPath(
          paths,
          agentDirectory,
          '准入台账 agent 目录',
        )
        if (!agentStat.isDirectory())
          die(`准入台账 agent 项不是目录：${JSON.stringify(agentDirectory)}`)
        const ledger = join(agentDirectory, 'admission.ndjson')
        if (!pathEntryExists(ledger)) continue
        const stat = assertExistingRegularFile(paths, ledger, '准入台账')
        remaining += 1
        if (stat.size > LEDGER_WARNING_BYTES) {
          warnings.push(
            `准入台账超过 10 MiB：${JSON.stringify(ledger)}；只告警，绝不裁剪或压缩`,
          )
        }
      } catch (error) {
        errors.push({ message: errorMessage(error) })
        remaining += 1
      }
    }
  }
  return {
    name: '准入台账',
    operations: [],
    remaining,
    warnings,
    errors,
  }
}

function pathsFromEnvironment(): Paths {
  const root = requiredEnv('BETA_RETAIN_ROOT')
  const safeRoot = assertSafeRoot(root)
  const paths: Paths = {
    root,
    rootReal: safeRoot.realpath,
    rootIdentity: safeRoot.identity,
    ownerUid: safeRoot.identity.uid,
    run: requiredEnv('BETA_RETAIN_RUN_DIR'),
    logs: requiredEnv('BETA_RETAIN_LOG_DIR'),
    backups: requiredEnv('BETA_RETAIN_BACKUP_STORE'),
    registryState: requiredEnv('BETA_RETAIN_REGISTRY_STATE'),
    registrySnapshots: requiredEnv('BETA_RETAIN_REGISTRY_SNAPSHOT_DIR'),
    nodes: requiredEnv('BETA_RETAIN_NODES_DIR'),
  }
  const expected = {
    run: join(root, 'run'),
    logs: join(root, 'logs'),
    backups: join(root, 'backups'),
    registryState: join(root, 'state/registry-agents.json'),
    registrySnapshots: join(root, 'state/snapshots'),
    nodes: join(root, 'nodes'),
  }
  for (const [key, value] of Object.entries(expected)) {
    if (paths[key as keyof typeof expected] !== value) {
      die(`拒绝非 common.sh 派生的 ${key} 路径`)
    }
  }
  assertMarker(paths)
  return paths
}

function printPlan(plan: Plan, applied: number, elapsedMs: number): void {
  for (const warning of plan.warnings) console.log(`WARN : ${warning}`)
  console.log(
    `${plan.name}: 候选=${plan.operations.length} 实际=${applied} 剩余=${plan.remaining} 耗时=${elapsedMs}ms`,
  )
}

function safelyBuildPlan(name: string, build: () => Plan): Plan {
  try {
    return build()
  } catch (error) {
    return {
      name,
      operations: [],
      remaining: 0,
      warnings: [],
      errors: errorMessages(error).map(message => ({ message })),
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const paths = pathsFromEnvironment()
  activeTestPaths = paths
  const lock = args.mode === 'apply' ? acquireApplyLock(paths) : undefined
  const execute = (): void => {
    const now = nowMs()
    const builders: readonly {
      readonly name: string
      readonly build: () => Plan
    }[] = [
      { name: '备份', build: () => planBackups(paths, now) },
      { name: '日志', build: () => planLogs(paths, now) },
      { name: '审计链', build: () => planAudits(paths, now) },
      {
        name: '注册表快照',
        build: () => planRegistry(paths, now, args.snapshotRegistry),
      },
      { name: '准入台账', build: () => planLedgers(paths) },
    ]
    const plans: { readonly plan: Plan; readonly started: number }[] = []
    for (const builder of builders) {
      const started = Date.now()
      plans.push({
        plan: safelyBuildPlan(builder.name, builder.build),
        started,
      })
    }
    console.log(
      `模式: ${args.mode}${args.snapshotRegistry ? '；升级前注册表快照' : ''}`,
    )
    if (plans.some(item => item.plan.errors.length > 0)) {
      for (const item of plans)
        printPlan(item.plan, 0, Date.now() - item.started)
      for (const item of plans) {
        for (const issue of item.plan.errors)
          console.error(`FAIL : ${issue.message}`)
      }
      process.exitCode = 1
      return
    }
    for (const item of plans) {
      let applied = 0
      if (args.mode === 'apply') {
        for (const operation of item.plan.operations) {
          if (operation.execute() === 'applied') applied += 1
        }
      }
      printPlan(item.plan, applied, Date.now() - item.started)
    }
  }

  let failure: unknown
  try {
    execute()
  } catch (error) {
    failure = error
  }
  let releaseFailure: unknown
  if (lock !== undefined) {
    try {
      releaseApplyLock(paths, lock)
    } catch (error) {
      releaseFailure = error
    }
  }
  if (failure !== undefined && releaseFailure !== undefined) {
    throw new AggregateError(
      [failure, releaseFailure],
      '保留工具执行失败，且 apply 锁释放失败',
    )
  }
  if (failure !== undefined) throw failure
  if (releaseFailure !== undefined) throw releaseFailure
}

try {
  main()
} catch (error) {
  for (const message of errorMessages(error)) console.error(`FAIL : ${message}`)
  process.exitCode = 1
}
