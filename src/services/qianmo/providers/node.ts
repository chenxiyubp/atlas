// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Node-side provider write path: two-phase apply (R-5, §2.6).
 *
 * ## Call contract (P18.3 resident, P18.7 `qm provider`)
 *
 * Phase 1 — `stageProviderApply(req)`; caller: `qm provider serve-stdin`
 * (P18.7) for `op: "apply"`. Re-validates the request with the shared schema
 * (the node does not trust the hub), takes `apply.lock`, checks
 * `expect.ownedHash` against the managed keys on disk (skipped with `force`),
 * writes the first-write backup once, and writes `pending.json` (0600). It
 * NEVER touches `settings.json`. `dryRun` compiles and returns `diffKeys`
 * without taking the lock or writing anything. Safe to call while a resident
 * and its ACP child are running — that is the point of it.
 *
 * Phase 2 — `commitPendingProviderConfig()`; callers:
 *   - the resident (P18.3), ONLY at an ACP generation boundary. §2.7's order
 *     is: wait until the child is idle (no in-flight task, no running turn),
 *     commit, then `recycle()`. Between the commit and the old child's stop
 *     no delivery may reach it — hold new deliveries for the next generation,
 *     as §2.7 already says — because a `createSession` on the old child
 *     re-reads settings and would pull the new env into a process whose other
 *     sessions are still mid-conversation (matrix §4.4);
 *   - the resident at startup, BEFORE spawning the first child — this is the
 *     crash roll-forward (§2.6 step 5);
 *   - `qm provider` itself when no resident is running (pid file absent or
 *     dead).
 * Returns `{status: 'none'}` when there is nothing to do, so calling it on
 * every boundary is cheap. On `committed` the result carries the `sessions`
 * policy the hub asked for (`keep` / `reset`); the resident applies it to the
 * session map before the new generation takes deliveries, then calls
 * {@link recordProviderGeneration} with the new generation number.
 * `busy` means another process holds `apply.lock`: retry at the next poll.
 * `refused` (config root not 0700) and `conflict` must be surfaced as alerts;
 * `conflict` has already discarded the intent (it contained a key), so the
 * hub has to re-send after ops decides.
 *
 * Polling: `hasPendingProviderConfig()` is a single `stat`; the resident polls
 * it every 5 s and on SIGHUP (no `fs.watchFile`, see §2.7).
 *
 * The option and result types (`StageResult`, `CommitResult`, …) stay
 * module-private until something outside imports them — the dead-code
 * ratchet counts an exported type nobody imports. The caller that needs one
 * adds the `export` in its own change, or uses `ReturnType<typeof …>`.
 *
 * ## Crash windows (roll forward, never back)
 *
 *   1. after `pending.json`, before `settings.json` changes → the disk still
 *      hashes to `expectHash`: commit normally;
 *   2. after `settings.json` was renamed into place, before `state.json` →
 *      the disk hashes to `targetHash`: record the state, drop the intent;
 *   3. after `state.json`, before `pending.json` is removed → `state.applied`
 *      already names this `requestId`: drop the intent.
 * Anything else is a third party's edit → `conflict`.
 *
 * `readProviderState()` is §2.4 without `effective`;
 * `computeEffectiveProviderState()` (re-exported from ./effective.js) MUTATES
 * process.env and must run in its own short-lived process, spawned with the
 * provider keys stripped from its env exactly as the ACP child's are
 * (`inheritedProviderKeyNames`). `{ model }` evaluates a model the session
 * switched to instead of the one a fresh session starts with. See
 * `__tests__/fixtures/effective-state.runner.ts` for the spawn shape.
 */

import {
  type AppliedRecord,
  type ApplyRequest,
  type LastCommitResult,
  type NodeCapabilities,
  type ProviderErrorCode,
  type ProviderNodeState,
  type ProviderWarning,
  parseProviderRequest,
  primaryKey,
  type SessionPolicy,
  secretFingerprint,
} from '@qianmo/providers'
import { occConfigDir } from '../../../config/paths.js'
import { MODEL_SETTINGS_SLOTS } from '../../../utils/model/modelTier.js'
import {
  getSettingsFilePathForSource,
  updateSettingsForSource,
} from '../../../utils/settings/settings.js'
import { compileProfile } from './compile.js'
import {
  applyPatchToView,
  diffKeyHashes,
  envValueHash,
  hashManagedView,
  keyHashesOf,
  type ManagedView,
  managedViewOf,
  type SettingsPatch,
  unreadableView,
} from './managedView.js'
import {
  acquireApplyLock,
  ensurePrivateDir,
  isOwnerOnly,
  isProcessAlive,
  PRIVATE_FILE_MODE,
  providerDir,
  providerPaths,
  readTextIfExists,
  removeIfExists,
  writePrivateFileAtomic,
  writePrivateJson,
} from './store.js'
import { chmodSync, existsSync } from 'node:fs'
import {
  checkEnvAgainstWhitelist,
  inheritedProviderKeyNames,
  SECRET_ENV_KEYS,
} from './whitelist.js'

export { computeEffectiveProviderState } from './effective.js'
export { inheritedProviderKeyNames } from './whitelist.js'

/** What this build can do. Flipped by the packages that add each ability. */
const NODE_PROVIDER_CAPABILITIES: NodeCapabilities = {
  protocol: 1,
  chatEffortHonorsOverride: false,
  replayFilter: false,
  multiKey: false,
}

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

function settingsPath(): string {
  const path = getSettingsFilePathForSource('userSettings')
  if (path === undefined) throw new Error('userSettings 没有文件路径')
  return path
}

function readSettingsView(): ManagedView {
  const text = readTextIfExists(settingsPath())
  if (text === undefined) return managedViewOf({})
  try {
    return managedViewOf(JSON.parse(text) as unknown)
  } catch {
    return unreadableView(text)
  }
}

/** Hash of the managed keys on disk right now (§2.4 `onDiskHash`). */
export function currentManagedHash(): string {
  return hashManagedView(readSettingsView())
}

// ---------------------------------------------------------------------------
// pending.json / state.json / generation.json
// ---------------------------------------------------------------------------

type StoredSlot = { effort: string | null; contextTokens: number | null } | null

/** `SettingsPatch` with deletions spelled `null` — JSON drops `undefined`. */
type StoredPatch = {
  modelType: string
  env: Record<string, string | null>
  modelSettings: Record<string, StoredSlot>
}

type PendingFile = {
  v: 1
  requestId: string
  profile: { id: string; revision: number }
  keyId: string
  patch: StoredPatch
  expectHash: string
  targetHash: string
  targetKeyHashes: Record<string, string>
  /** Compat keys this intent writes → hash of the value written. */
  compat: Record<string, string>
  sessions: SessionPolicy
  force: boolean
  stagedAt: string
}

type StateFile = {
  v: 1
  applied: AppliedRecord | null
  appliedHash: string | null
  appliedKeyHashes: Record<string, string>
  compat: Record<string, string>
  keyId: string | null
  lastResult: LastCommitResult | null
}

type GenerationRecord = {
  generation: number
  startedAt: string
  loadedHash: string
  inheritedProviderKeys: string[]
}

function storePatch(patch: SettingsPatch): StoredPatch {
  const env: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(patch.env)) env[key] = value ?? null
  const modelSettings: Record<string, StoredSlot> = {}
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const entry = patch.modelSettings[slot]
    modelSettings[slot] =
      entry === undefined
        ? null
        : {
            effort: entry.effort ?? null,
            contextTokens: entry.contextTokens ?? null,
          }
  }
  return { modelType: patch.modelType, env, modelSettings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict: anything malformed makes the whole pending file bad. */
function loadPatch(value: unknown): SettingsPatch | null {
  if (!isRecord(value) || typeof value.modelType !== 'string') return null
  if (!isRecord(value.env) || !isRecord(value.modelSettings)) return null
  const env: Record<string, string | undefined> = {}
  for (const [key, entry] of Object.entries(value.env)) {
    if (entry !== null && typeof entry !== 'string') return null
    env[key] = entry ?? undefined
  }
  const modelSettings = {} as SettingsPatch['modelSettings']
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const entry = value.modelSettings[slot]
    if (entry === null || entry === undefined) {
      modelSettings[slot] = undefined
      continue
    }
    if (!isRecord(entry)) return null
    const { effort, contextTokens } = entry
    if (effort !== null && typeof effort !== 'string') return null
    if (contextTokens !== null && typeof contextTokens !== 'number') return null
    modelSettings[slot] = {
      effort: effort ?? undefined,
      contextTokens: contextTokens ?? undefined,
    }
  }
  return { modelType: value.modelType, env, modelSettings }
}

function loadPending(
  text: string,
): { file: PendingFile; patch: SettingsPatch } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null
  const file = parsed as Partial<PendingFile>
  if (
    typeof file.requestId !== 'string' ||
    !isRecord(file.profile) ||
    typeof file.expectHash !== 'string' ||
    typeof file.targetHash !== 'string' ||
    (file.sessions !== 'keep' && file.sessions !== 'reset')
  ) {
    return null
  }
  const patch = loadPatch(file.patch)
  if (patch === null || checkEnvAgainstWhitelist(patch.env) !== null)
    return null
  return { file: file as PendingFile, patch }
}

function readState(): StateFile | null {
  const text = readTextIfExists(providerPaths.state())
  if (text === undefined) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) && parsed.v === 1 ? (parsed as StateFile) : null
  } catch {
    return null
  }
}

function writeState(state: StateFile): void {
  writePrivateJson(providerPaths.state(), state)
}

function readGeneration(): GenerationRecord | null {
  const text = readTextIfExists(providerPaths.generation())
  if (text === undefined) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) && typeof parsed.loadedHash === 'string'
      ? (parsed as GenerationRecord)
      : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Phase 1: stage
// ---------------------------------------------------------------------------

type StageOptions = {
  /** The node name from the forced command; checked against `req.node`. */
  node?: string
  capabilities?: NodeCapabilities
  now?: Date
}

type StageResult =
  | {
      ok: true
      requestId: string
      /** True when an intent is waiting for the next generation boundary. */
      pending: boolean
      dryRun: boolean
      /** Set when this `requestId` was already staged or applied. */
      duplicate: 'pending' | 'applied' | null
      /** Managed keys that change, by name only. */
      diffKeys: string[]
      warnings: ProviderWarning[]
    }
  | {
      ok: false
      requestId: string | null
      code: ProviderErrorCode
      message: string
      diffKeys?: string[]
    }

function failure(
  requestId: string | null,
  code: ProviderErrorCode,
  message: string,
  diffKeys?: string[],
): StageResult {
  return {
    ok: false,
    requestId,
    code,
    message,
    ...(diffKeys === undefined ? {} : { diffKeys }),
  }
}

/** Find the current value a `keep` fingerprint refers to, among credential keys. */
function resolveKept(
  view: ManagedView,
  fingerprint: string,
): string | undefined {
  for (const key of SECRET_ENV_KEYS) {
    const value = view.env[key]
    if (value !== undefined && secretFingerprint(value) === fingerprint)
      return value
  }
  return undefined
}

/**
 * Validate an `apply` and record it as a pending intent. See the module
 * header for the contract. Never writes `settings.json`.
 */
export function stageProviderApply(
  req: ApplyRequest,
  options: StageOptions = {},
): StageResult {
  const capabilities = options.capabilities ?? NODE_PROVIDER_CAPABILITIES
  const now = options.now ?? new Date()
  const parsed = parseProviderRequest(req, {
    capabilities,
    now,
    ...(options.node === undefined ? {} : { node: options.node }),
  })
  if (!parsed.ok) {
    return failure(parsed.requestId, parsed.error.code, parsed.error.message)
  }
  if (parsed.request.op !== 'apply') {
    return failure(
      parsed.request.requestId,
      'unsupported-op',
      '这里只处理 apply',
    )
  }
  const request = parsed.request
  const { requestId, profile } = request

  const plan = (view: ManagedView, state: StateFile | null) => {
    const key = primaryKey(profile.auth.keys)
    const secret = 'value' in key ? key.value : resolveKept(view, key.keep)
    if (secret === undefined) {
      return failure(
        requestId,
        'secret-mismatch',
        '节点上没有指纹相符的密钥 · 需要重新填写',
      )
    }
    const compiled = compileProfile(profile, { secret, capabilities })
    if (!compiled.ok) {
      return failure(requestId, compiled.error.code, compiled.error.message)
    }
    const patch = compiled.compiled.patch
    // Compat keys are not in ALL_PROFILE_ENV_KEYS, so activation does not
    // clear them. Drop the ones WE wrote last time if they still hold the
    // value we wrote; one somebody changed since is theirs now (§2.6).
    for (const [key, hash] of Object.entries(state?.compat ?? {})) {
      if (key in compiled.compiled.compat) continue
      const current = view.env[key]
      if (current !== undefined && envValueHash(key, current) === hash) {
        patch.env[key] = undefined
      }
    }
    const target = applyPatchToView(view, patch)
    return { compiled: compiled.compiled, patch, target }
  }

  if (request.dryRun) {
    const view = readSettingsView()
    const planned = plan(view, readState())
    if ('ok' in planned) return planned
    return {
      ok: true,
      requestId,
      pending: false,
      dryRun: true,
      duplicate: null,
      diffKeys: diffKeyHashes(keyHashesOf(view), keyHashesOf(planned.target)),
      warnings: parsed.warnings,
    }
  }

  ensurePrivateDir(providerDir())
  const lock = acquireApplyLock(now)
  if (lock === null) return failure(requestId, 'busy', '另一次下发正在进行')
  try {
    const pendingText = readTextIfExists(providerPaths.pending())
    const existing = pendingText === undefined ? null : loadPending(pendingText)
    const state = readState()
    if (existing?.file.requestId === requestId) {
      return {
        ok: true,
        requestId,
        pending: true,
        dryRun: false,
        duplicate: 'pending',
        diffKeys: [],
        warnings: parsed.warnings,
      }
    }
    if (state?.applied?.requestId === requestId) {
      return {
        ok: true,
        requestId,
        pending: false,
        dryRun: false,
        duplicate: 'applied',
        diffKeys: [],
        warnings: parsed.warnings,
      }
    }

    const view = readSettingsView()
    const onDiskHash = hashManagedView(view)
    const managed = state?.applied !== null && state?.applied !== undefined
    if (!request.force) {
      const expected = request.expect.ownedHash
      if (expected === null && managed) {
        return failure(
          requestId,
          'conflict',
          '节点已经被托管 · 中枢没有它的下发记录 · 需要确认覆盖',
        )
      }
      if (expected !== null && (!managed || onDiskHash !== expected)) {
        const diffKeys = managed
          ? diffKeyHashes(state?.appliedKeyHashes ?? {}, keyHashesOf(view))
          : []
        return failure(
          requestId,
          'conflict',
          '节点上的受管键在上次下发后被改过',
          diffKeys,
        )
      }
    }

    const planned = plan(view, state)
    if ('ok' in planned) return planned

    if (
      !managed &&
      readTextIfExists(providerPaths.firstWrite()) === undefined
    ) {
      const original = readTextIfExists(settingsPath())
      writePrivateFileAtomic(providerPaths.firstWrite(), original ?? '{}\n')
    }

    const compatHashes = Object.fromEntries(
      Object.entries(planned.compiled.compat).map(([key, value]) => [
        key,
        envValueHash(key, value),
      ]),
    )
    const pending: PendingFile = {
      v: 1,
      requestId,
      profile: { id: profile.id, revision: profile.revision },
      keyId: planned.compiled.keyId,
      patch: storePatch(planned.patch),
      expectHash: onDiskHash,
      targetHash: hashManagedView(planned.target),
      targetKeyHashes: keyHashesOf(planned.target),
      compat: compatHashes,
      sessions: request.recycle.sessions,
      force: request.force,
      stagedAt: now.toISOString(),
    }
    writePrivateJson(providerPaths.pending(), pending)
    return {
      ok: true,
      requestId,
      pending: true,
      dryRun: false,
      duplicate: null,
      diffKeys: diffKeyHashes(keyHashesOf(view), pending.targetKeyHashes),
      warnings: parsed.warnings,
    }
  } catch (error) {
    return failure(
      requestId,
      'write-failed',
      `写入 pending 失败 · ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------------------
// Phase 2: commit
// ---------------------------------------------------------------------------

type CommitResult =
  | { status: 'none' }
  | {
      status: 'committed'
      requestId: string
      applied: AppliedRecord
      appliedHash: string
      sessions: SessionPolicy
      /** True when this call finished a commit a crash had interrupted. */
      recovered: boolean
    }
  | { status: 'conflict'; requestId: string; diffKeys: string[] }
  | { status: 'refused'; reason: 'config-root-not-private'; message: string }
  | { status: 'busy' }
  | { status: 'bad-pending'; movedTo: string }
  | { status: 'write-failed'; requestId: string; message: string }

type CommitOptions = { now?: Date }

/** Single `stat`, for the resident's 5 s poll. */
export function hasPendingProviderConfig(): boolean {
  return existsSync(providerPaths.pending())
}

function ensurePrivateSettingsFile(path: string): void {
  if (existsSync(path)) {
    chmodSync(path, PRIVATE_FILE_MODE)
    return
  }
  writePrivateFileAtomic(path, '{}\n')
}

/**
 * Write `patch` into userSettings through the base writer, with umask 077 for
 * the duration so the base's tmp file is 0600 from its creation (the base
 * creates it under the process umask and only chmods after writing).
 */
function writeSettingsPrivately(patch: SettingsPatch): Error | null {
  const path = settingsPath()
  ensurePrivateSettingsFile(path)
  const previous = process.umask(0o077)
  try {
    const { error } = updateSettingsForSource('userSettings', {
      modelType: patch.modelType,
      env: patch.env,
      modelSettings: patch.modelSettings,
    } as unknown as Parameters<typeof updateSettingsForSource>[1])
    return error
  } finally {
    process.umask(previous)
  }
}

function finish(
  pending: PendingFile,
  state: StateFile | null,
  appliedHash: string,
  appliedKeyHashes: Record<string, string>,
  at: Date,
  recovered: boolean,
): CommitResult {
  const applied: AppliedRecord = {
    profileId: pending.profile.id,
    revision: pending.profile.revision,
    requestId: pending.requestId,
    at: at.toISOString(),
  }
  writeState({
    v: 1,
    applied,
    appliedHash,
    appliedKeyHashes,
    compat: pending.compat,
    keyId: pending.keyId,
    lastResult: state?.lastResult ?? null,
  })
  removeIfExists(providerPaths.pending())
  return {
    status: 'committed',
    requestId: pending.requestId,
    applied,
    appliedHash,
    sessions: pending.sessions,
    recovered,
  }
}

/**
 * Commit the pending intent, if any. Call only at a generation boundary (or
 * at resident start, or with no resident running) — see the module header.
 */
export function commitPendingProviderConfig(
  options: CommitOptions = {},
): CommitResult {
  const now = options.now ?? new Date()
  if (!hasPendingProviderConfig()) return { status: 'none' }
  const lock = acquireApplyLock(now)
  if (lock === null) return { status: 'busy' }
  try {
    const text = readTextIfExists(providerPaths.pending())
    if (text === undefined) return { status: 'none' }
    const loaded = loadPending(text)
    if (loaded === null) {
      const movedTo = `${providerPaths.pending().replace(/\.json$/, '')}.bad-${now
        .toISOString()
        .replace(/[:.]/g, '-')}`
      writePrivateFileAtomic(movedTo, text)
      removeIfExists(providerPaths.pending())
      return { status: 'bad-pending', movedTo }
    }
    const { file: pending, patch } = loaded

    if (!isOwnerOnly(occConfigDir())) {
      return {
        status: 'refused',
        reason: 'config-root-not-private',
        message: '配置根目录不是 0700 · 拒绝提交 · 先收紧权限',
      }
    }

    const state = readState()
    if (state?.applied?.requestId === pending.requestId) {
      // Window 3: state already records this commit.
      removeIfExists(providerPaths.pending())
      ensurePrivateSettingsFile(settingsPath())
      return {
        status: 'committed',
        requestId: pending.requestId,
        applied: state.applied,
        appliedHash: state.appliedHash ?? currentManagedHash(),
        sessions: pending.sessions,
        recovered: true,
      }
    }

    const view = readSettingsView()
    const onDiskHash = hashManagedView(view)
    if (onDiskHash === pending.targetHash) {
      // Window 2 (or an intent identical to what is on disk): nothing to write.
      ensurePrivateSettingsFile(settingsPath())
      return finish(
        pending,
        state,
        onDiskHash,
        keyHashesOf(view),
        now,
        onDiskHash !== pending.expectHash,
      )
    }
    if (onDiskHash !== pending.expectHash) {
      const diffKeys = diffKeyHashes(
        state?.appliedKeyHashes ?? {},
        keyHashesOf(view),
      )
      writeState({
        v: 1,
        applied: state?.applied ?? null,
        appliedHash: state?.appliedHash ?? null,
        appliedKeyHashes: state?.appliedKeyHashes ?? {},
        compat: state?.compat ?? {},
        keyId: state?.keyId ?? null,
        lastResult: {
          requestId: pending.requestId,
          code: 'conflict',
          at: now.toISOString(),
          diffKeys,
        },
      })
      removeIfExists(providerPaths.pending())
      return { status: 'conflict', requestId: pending.requestId, diffKeys }
    }

    const error = writeSettingsPrivately(patch)
    if (error !== null) {
      return {
        status: 'write-failed',
        requestId: pending.requestId,
        message: error.message,
      }
    }
    const written = readSettingsView()
    return finish(
      pending,
      state,
      hashManagedView(written),
      keyHashesOf(written),
      now,
      false,
    )
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------------------
// State (§2.4 without `effective`)
// ---------------------------------------------------------------------------

type ResidentPidFile = { pid?: unknown; startedAt?: unknown; nonce?: unknown }

function readResident(
  generation: GenerationRecord | null,
): ProviderNodeState['resident'] {
  const text = readTextIfExists(providerPaths.residentPid())
  if (text === undefined) return null
  try {
    const parsed = JSON.parse(text) as ResidentPidFile
    return {
      running: typeof parsed.pid === 'number' && isProcessAlive(parsed.pid),
      generation: generation?.generation ?? null,
      inFlight: null,
    }
  } catch {
    return null
  }
}

export function readProviderState(): ProviderNodeState {
  const state = readState()
  const generation = readGeneration()
  const pendingText = readTextIfExists(providerPaths.pending())
  const pending = pendingText === undefined ? null : loadPending(pendingText)
  return {
    managed: state?.applied !== null && state?.applied !== undefined,
    applied: state?.applied ?? null,
    onDiskHash: currentManagedHash(),
    appliedHash: state?.appliedHash ?? null,
    loadedHash: generation?.loadedHash ?? null,
    pending:
      pending === null
        ? null
        : {
            requestId: pending.file.requestId,
            since: pending.file.stagedAt,
            waitingTurns: null,
          },
    resident: readResident(generation),
    inheritedProviderKeys: generation?.inheritedProviderKeys ?? [],
    capabilities: NODE_PROVIDER_CAPABILITIES,
    lastResult: state?.lastResult ?? null,
  }
}

/**
 * For the resident (P18.3): record which managed configuration the generation
 * it is about to spawn loads. Call after a commit (or at start), before the
 * new ACP child's first `createSession`.
 */
export function recordProviderGeneration(input: {
  generation: number
  startedAt?: Date
  env?: Readonly<Record<string, string | undefined>>
}): GenerationRecord {
  const record: GenerationRecord = {
    generation: input.generation,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    loadedHash: currentManagedHash(),
    inheritedProviderKeys: inheritedProviderKeyNames(input.env ?? process.env),
  }
  writePrivateJson(providerPaths.generation(), record)
  return record
}
