// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LIMITS } from '@qianmo/protocol'

/**
 * The handoff manifest, the git ref names it points at, and the JSON that
 * travels back in `task.result.content`.
 *
 * The manifest is the body of `POST /v0/handoff` and the payload of the
 * `task.request` the hub dispatches (handoff-p17-plan.md §1). It carries
 * references only — commit and tree hashes, a session ref — never code or
 * transcript text, so it can stay small and fully closed:
 *
 * - **Every field is whitelisted.** An unknown key is a rejection, not
 *   something carried along. A manifest is read by the hub, written to the
 *   ledger and forwarded to a node; a field nobody validated would ride all
 *   three hops.
 * - **Every string has a byte cap, and so does the whole.** The whole is
 *   bounded at a sixteenth of `LIMITS.maxMessageBytes`, derived rather than
 *   restated, so the manifest can never be the reason an envelope is too big.
 * - **Names that end up inside ref names are ref-safe by construction.** The
 *   device, branch and session id become path segments of
 *   `refs/qianmo/...`; checking them here is what lets the hub hand them to
 *   `git` without quoting rules of its own.
 */

/** Payload shape marker. `task.request` payloads are not checked by the protocol. */
export const MANIFEST_KIND = 'handoff'

/** The two tools a handoff can start from. */
export const HANDOFF_TOOLS = ['qmcode', 'claude-code'] as const
export type HandoffTool = (typeof HANDOFF_TOOLS)[number]

/**
 * The device name reserved for what the cloud writes back
 * (`refs/qianmo/sessions/cloud/<threadId>`). A local manifest may not use it:
 * that would let a laptop overwrite the node's transcript ref.
 */
export const CLOUD_DEVICE = 'cloud'

/** Upper bound of a serialized manifest: 16 KiB, a sixteenth of an envelope. */
export const MANIFEST_MAX_BYTES = LIMITS.maxMessageBytes / 16

/** Upper bound of a serialized `task.result` content, same reasoning. */
export const RESULT_MAX_BYTES = LIMITS.maxMessageBytes / 16

/**
 * Per-field caps, in UTF-8 bytes. Sized so that a manifest whose fields are
 * each at their cap still fits {@link MANIFEST_MAX_BYTES} before JSON escaping.
 */
export const FIELD_MAX_BYTES = {
  /** Project, device: bare-repo and ref-segment names. */
  name: 64,
  /** Task id: becomes `qianmo/<taskId>` and a work-tree directory name. */
  taskId: 64,
  /** Session / thread id. */
  sessionId: 128,
  /** Local branch name (may contain `/`). */
  branch: 200,
  /** Local working directory. */
  cwd: 1024,
  /** Each of `brief.goal`, `brief.done`, `brief.remaining`. */
  brief: 4096,
  /** `task.result` summary. */
  summary: 8192,
} as const

export interface HandoffBrief {
  readonly goal: string
  readonly done: string
  readonly remaining: string
}

export interface HandoffManifest {
  readonly kind: typeof MANIFEST_KIND
  /** Bare repository name on the hub (`<project>.git`). */
  readonly project: string
  readonly device: string
  /** Local branch the shadow commit was taken on. */
  readonly branch: string
  /** Shadow commit. */
  readonly wip: string
  /** Local work-tree tree hash, for the AC-H1 check against `wip`'s tree. */
  readonly tree: string
  readonly tool: HandoffTool
  readonly sessionId: string
  /** Always `refs/qianmo/sessions/<device>/<sessionId>`. */
  readonly sessionRef: string
  readonly sessionCommit: string
  /** Local working directory, absolute; the node remaps it. */
  readonly cwd: string
  readonly brief: HandoffBrief
  /** ISO 8601 UTC, `YYYY-MM-DDTHH:MM:SS[.sss]Z`. */
  readonly deadline: string
}

/** How the cloud turn ended (the app-server `turn.status` values). */
export const RESULT_STATUSES = ['completed', 'interrupted', 'failed'] as const
export type HandoffResultStatus = (typeof RESULT_STATUSES)[number]

/** What `task.result.content` carries, JSON-encoded. */
export interface HandoffResult {
  readonly status: HandoffResultStatus
  /** `qianmo/<taskId>`. */
  readonly branch: string
  /** Tip of that branch. */
  readonly head: string
  readonly threadId: string
  readonly summary: string
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] }

/** Thrown by the encoders when their input does not validate. */
export class HandoffValidationError extends Error {
  readonly errors: readonly string[]

  constructor(what: string, errors: readonly string[]) {
    super(`invalid ${what}: ${errors.join('; ')}`)
    this.name = 'HandoffValidationError'
    this.errors = errors
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────

/** A full object id: SHA-1 (40) or SHA-256 (64), lowercase. */
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Project, device, session and task ids. ASCII so that byte length equals
 * character length and the value is the same on every filesystem; dots
 * allowed inside (host names), but see {@link isSafeName} for the dot rules.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Task ids: no dots, since they also become directory names on the node. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const DEADLINE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/** POSIX `/…`, Windows `C:\…` / `C:/…`, or UNC `\\server\share…`. */
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL only
const NUL_PATTERN = /\u0000/

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_PATTERN.test(value)
}

function isSafeName(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxBytes &&
    NAME_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  )
}

export function isTaskId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= FIELD_MAX_BYTES.taskId &&
    TASK_ID_PATTERN.test(value)
  )
}

/**
 * `git check-ref-format` rules, applied to a full ref name.
 *
 * Restated rather than shelled out for: validation runs on the hub's request
 * path and in the ledger's replay, neither of which should fork. The rules are
 * git's documented ten, nothing project-specific.
 */
export function isValidRefName(ref: string): boolean {
  if (ref === '@' || ref.length === 0) return false
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) {
    return false
  }
  if (ref.includes('//') || ref.includes('..') || ref.includes('@{')) {
    return false
  }
  if (CONTROL_PATTERN.test(ref) || /[ ~^:?*[\\]/.test(ref)) return false
  if (!ref.includes('/')) return false
  return ref
    .split('/')
    .every(part => !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * A local branch name that can sit under `refs/qianmo/wip/<device>/`.
 * `@` passes `check-ref-format` under `refs/heads/` but is HEAD's shorthand,
 * so git itself refuses it as a branch name.
 */
export function isValidBranchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '@' &&
    byteLength(value) <= FIELD_MAX_BYTES.branch &&
    !value.startsWith('-') &&
    !value.startsWith('refs/') &&
    isValidRefName(`refs/heads/${value}`)
  )
}

function isAbsoluteCwd(value: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(value) && !CONTROL_PATTERN.test(value)
}

/** Strict ISO 8601 UTC instant that names a real calendar time. */
export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !DEADLINE_PATTERN.test(value)) return false
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return false
  // `Date.parse('2026-02-30T00:00:00Z')` rolls over to March instead of
  // failing; comparing the canonical rendering catches it.
  return new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
}

// ─── Refs ────────────────────────────────────────────────────────────

const WIP_PREFIX = 'refs/qianmo/wip/'
const SESSIONS_PREFIX = 'refs/qianmo/sessions/'
const TASK_BRANCH_PREFIX = 'qianmo/'
const TASK_REF_PREFIX = `refs/heads/${TASK_BRANCH_PREFIX}`

/** The three kinds of ref a handoff reads or writes; nothing else parses. */
export type QianmoRef =
  | { readonly kind: 'wip'; readonly device: string; readonly branch: string }
  | {
      readonly kind: 'session'
      readonly device: string
      readonly sessionId: string
    }
  | { readonly kind: 'task'; readonly taskId: string }

function isDevice(value: unknown): value is string {
  return isSafeName(value, FIELD_MAX_BYTES.name)
}

function isSessionId(value: unknown): value is string {
  return isSafeName(value, FIELD_MAX_BYTES.sessionId)
}

/** `refs/qianmo/wip/<device>/<branch>`. Throws on an unsafe component. */
export function wipRef(device: string, branch: string): string {
  if (!isDevice(device)) throw new TypeError(`unsafe device name: ${device}`)
  if (!isValidBranchName(branch)) {
    throw new TypeError(`unsafe branch name: ${branch}`)
  }
  return `${WIP_PREFIX}${device}/${branch}`
}

/** `refs/qianmo/sessions/<device>/<sessionId>`. Throws on an unsafe component. */
export function sessionRef(device: string, sessionId: string): string {
  if (!isDevice(device)) throw new TypeError(`unsafe device name: ${device}`)
  if (!isSessionId(sessionId)) {
    throw new TypeError(`unsafe session id: ${sessionId}`)
  }
  return `${SESSIONS_PREFIX}${device}/${sessionId}`
}

/** `qianmo/<taskId>`, the only branch the cloud side writes. */
export function taskBranch(taskId: string): string {
  if (!isTaskId(taskId)) throw new TypeError(`unsafe task id: ${taskId}`)
  return `${TASK_BRANCH_PREFIX}${taskId}`
}

/** `refs/heads/qianmo/<taskId>`. */
export function taskRef(taskId: string): string {
  return `refs/heads/${taskBranch(taskId)}`
}

/** Parse one of the three handoff refs; anything else is `null`. */
export function parseQianmoRef(ref: unknown): QianmoRef | null {
  if (typeof ref !== 'string' || !isValidRefName(ref)) return null
  if (ref.startsWith(WIP_PREFIX)) {
    const rest = ref.slice(WIP_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    const device = rest.slice(0, slash)
    const branch = rest.slice(slash + 1)
    return isDevice(device) && isValidBranchName(branch)
      ? { kind: 'wip', device, branch }
      : null
  }
  if (ref.startsWith(SESSIONS_PREFIX)) {
    const parts = ref.slice(SESSIONS_PREFIX.length).split('/')
    if (parts.length !== 2) return null
    const [device, sessionId] = parts
    return isDevice(device) && isSessionId(sessionId)
      ? { kind: 'session', device, sessionId }
      : null
  }
  if (ref.startsWith(TASK_REF_PREFIX)) {
    const taskId = ref.slice(TASK_REF_PREFIX.length)
    return isTaskId(taskId) ? { kind: 'task', taskId } : null
  }
  return null
}

// ─── Validation ──────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Report keys outside `allowed`, and required keys that are missing. */
function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${where}${key}: unknown field`)
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) errors.push(`${where}${key}: missing`)
  }
}

function checkText(
  value: unknown,
  field: string,
  maxBytes: number,
  errors: string[],
  options: { readonly nonEmpty?: boolean } = {},
): void {
  if (typeof value !== 'string') {
    errors.push(`${field}: must be a string`)
    return
  }
  if (options.nonEmpty === true && value.trim() === '') {
    errors.push(`${field}: must not be empty`)
  }
  if (NUL_PATTERN.test(value)) errors.push(`${field}: contains NUL`)
  if (byteLength(value) > maxBytes) {
    errors.push(`${field}: longer than ${maxBytes} bytes`)
  }
}

const MANIFEST_KEYS = [
  'kind',
  'project',
  'device',
  'branch',
  'wip',
  'tree',
  'tool',
  'sessionId',
  'sessionRef',
  'sessionCommit',
  'cwd',
  'brief',
  'deadline',
] as const

const BRIEF_KEYS = ['goal', 'done', 'remaining'] as const

const RESULT_KEYS = ['status', 'branch', 'head', 'threadId', 'summary'] as const

/**
 * Validate a decoded manifest. Collects every problem rather than stopping
 * at the first, because the hub returns the list to the person who sent it.
 */
export function validateManifest(
  value: unknown,
): ValidationResult<HandoffManifest> {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['manifest: must be an object'] }
  }
  const errors: string[] = []
  checkKeys(value, MANIFEST_KEYS, '', errors)

  if (Object.hasOwn(value, 'kind') && value.kind !== MANIFEST_KIND) {
    errors.push(`kind: must be "${MANIFEST_KIND}"`)
  }
  const project = value.project
  if (
    Object.hasOwn(value, 'project') &&
    (!isSafeName(project, FIELD_MAX_BYTES.name) || project.endsWith('.git'))
  ) {
    errors.push('project: not a safe repository name')
  }
  const device = value.device
  if (Object.hasOwn(value, 'device')) {
    if (!isDevice(device)) errors.push('device: not a safe device name')
    else if (device === CLOUD_DEVICE) {
      errors.push(`device: "${CLOUD_DEVICE}" is reserved for the cloud side`)
    }
  }
  if (Object.hasOwn(value, 'branch') && !isValidBranchName(value.branch)) {
    errors.push('branch: not a valid branch name')
  }
  for (const key of ['wip', 'tree', 'sessionCommit'] as const) {
    if (Object.hasOwn(value, key) && !isSha(value[key])) {
      errors.push(`${key}: not a full object id`)
    }
  }
  if (
    isSha(value.wip) &&
    isSha(value.tree) &&
    isSha(value.sessionCommit) &&
    new Set([value.wip.length, value.tree.length, value.sessionCommit.length])
      .size !== 1
  ) {
    errors.push('wip/tree/sessionCommit: mixed object formats')
  }
  if (
    Object.hasOwn(value, 'tool') &&
    !(HANDOFF_TOOLS as readonly unknown[]).includes(value.tool)
  ) {
    errors.push(`tool: must be one of ${HANDOFF_TOOLS.join(' | ')}`)
  }
  const sessionId = value.sessionId
  if (Object.hasOwn(value, 'sessionId') && !isSessionId(sessionId)) {
    errors.push('sessionId: not a safe session id')
  }
  if (Object.hasOwn(value, 'sessionRef')) {
    const parsed = parseQianmoRef(value.sessionRef)
    if (parsed === null || parsed.kind !== 'session') {
      errors.push('sessionRef: not refs/qianmo/sessions/<device>/<sessionId>')
    } else if (parsed.device !== device || parsed.sessionId !== sessionId) {
      errors.push('sessionRef: does not match device and sessionId')
    }
  }
  if (Object.hasOwn(value, 'cwd')) {
    checkText(value.cwd, 'cwd', FIELD_MAX_BYTES.cwd, errors)
    if (typeof value.cwd === 'string' && !isAbsoluteCwd(value.cwd)) {
      errors.push('cwd: must be an absolute path')
    }
  }
  if (Object.hasOwn(value, 'brief')) {
    const brief = value.brief
    if (!isPlainObject(brief)) {
      errors.push('brief: must be an object')
    } else {
      checkKeys(brief, BRIEF_KEYS, 'brief.', errors)
      checkText(brief.goal, 'brief.goal', FIELD_MAX_BYTES.brief, errors, {
        nonEmpty: true,
      })
      checkText(brief.done, 'brief.done', FIELD_MAX_BYTES.brief, errors)
      checkText(
        brief.remaining,
        'brief.remaining',
        FIELD_MAX_BYTES.brief,
        errors,
      )
    }
  }
  if (Object.hasOwn(value, 'deadline') && !isIsoInstant(value.deadline)) {
    errors.push('deadline: must be an ISO 8601 UTC time (…Z)')
  }

  if (errors.length > 0) return { ok: false, errors }
  // Rebuilt field by field rather than returned as received: what the hub
  // stores and forwards is then exactly the validated shape, whatever kind of
  // object the caller handed in.
  const raw = value as unknown as HandoffManifest
  const manifest: HandoffManifest = {
    kind: MANIFEST_KIND,
    project: raw.project,
    device: raw.device,
    branch: raw.branch,
    wip: raw.wip,
    tree: raw.tree,
    tool: raw.tool,
    sessionId: raw.sessionId,
    sessionRef: raw.sessionRef,
    sessionCommit: raw.sessionCommit,
    cwd: raw.cwd,
    brief: {
      goal: raw.brief.goal,
      done: raw.brief.done,
      remaining: raw.brief.remaining,
    },
    deadline: raw.deadline,
  }
  const size = byteLength(JSON.stringify(manifest))
  if (size > MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      errors: [`manifest: ${size} bytes, over ${MANIFEST_MAX_BYTES}`],
    }
  }
  return { ok: true, value: manifest }
}

/** Size-check, `JSON.parse` and {@link validateManifest} a request body. */
export function parseManifest(text: string): ValidationResult<HandoffManifest> {
  return parseBounded(text, MANIFEST_MAX_BYTES, 'manifest', validateManifest)
}

/** Validate a decoded `task.result` content object. */
export function validateResult(
  value: unknown,
): ValidationResult<HandoffResult> {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['result: must be an object'] }
  }
  const errors: string[] = []
  checkKeys(value, RESULT_KEYS, '', errors)
  if (
    Object.hasOwn(value, 'status') &&
    !(RESULT_STATUSES as readonly unknown[]).includes(value.status)
  ) {
    errors.push(`status: must be one of ${RESULT_STATUSES.join(' | ')}`)
  }
  if (Object.hasOwn(value, 'branch')) {
    const parsed =
      typeof value.branch === 'string'
        ? parseQianmoRef(`refs/heads/${value.branch}`)
        : null
    if (parsed === null || parsed.kind !== 'task') {
      errors.push('branch: must be qianmo/<taskId>')
    }
  }
  if (Object.hasOwn(value, 'head') && !isSha(value.head)) {
    errors.push('head: not a full object id')
  }
  if (Object.hasOwn(value, 'threadId') && !isSessionId(value.threadId)) {
    errors.push('threadId: not a safe thread id')
  }
  if (Object.hasOwn(value, 'summary')) {
    checkText(value.summary, 'summary', FIELD_MAX_BYTES.summary, errors)
  }
  if (errors.length > 0) return { ok: false, errors }
  const raw = value as unknown as HandoffResult
  return {
    ok: true,
    value: {
      status: raw.status,
      branch: raw.branch,
      head: raw.head,
      threadId: raw.threadId,
      summary: raw.summary,
    },
  }
}

/**
 * The string for `task.result.content`. Throws {@link HandoffValidationError}
 * rather than encoding something the hub would refuse to decode.
 */
export function encodeResultContent(result: HandoffResult): string {
  const checked = validateResult(result)
  if (!checked.ok) throw new HandoffValidationError('result', checked.errors)
  const content = JSON.stringify(checked.value)
  const size = byteLength(content)
  if (size > RESULT_MAX_BYTES) {
    throw new HandoffValidationError('result', [
      `result: ${size} bytes, over ${RESULT_MAX_BYTES}`,
    ])
  }
  return content
}

/** Decode `task.result.content`. */
export function decodeResultContent(
  content: string,
): ValidationResult<HandoffResult> {
  return parseBounded(content, RESULT_MAX_BYTES, 'result', validateResult)
}

function parseBounded<T>(
  text: string,
  maxBytes: number,
  what: string,
  validate: (value: unknown) => ValidationResult<T>,
): ValidationResult<T> {
  if (typeof text !== 'string') {
    return { ok: false, errors: [`${what}: must be a JSON string`] }
  }
  const size = byteLength(text)
  if (size > maxBytes) {
    return { ok: false, errors: [`${what}: ${size} bytes, over ${maxBytes}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: [`${what}: not JSON`] }
  }
  return validate(parsed)
}
