// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sixth-action protocol, schema v1 (§2.5).
 *
 * One JSON line in on stdin, one JSON line out on stdout. The operation set is
 * closed — `status`, `probe`, `models`, `apply` — and every request field is
 * named here; anything else is refused. The closure that matters in a hub
 * compromise is enforced by the node's sshd forced command, not by this file;
 * this file is what the node checks AFTER that, without trusting the hub.
 *
 * Responses never echo a value: key names, hashes and fingerprints only.
 */

import {
  isProviderErrorCode,
  type ProviderErrorCode,
  type ProviderIssue,
} from './errors.js'
import {
  type ProviderWarning,
  parseWireProfile,
  type ValidateOptions,
} from './validate.js'
import type { EffortLevel, NodeCapabilities, WireProfile } from './types.js'

export const PROTOCOL_VERSION = 1

/** What the hub runs on the far side of ssh: a command that must NOT exist (§2.5). */
export const SENTINEL_COMMAND = 'qianmo-model-apply-v1'

export const PROVIDER_OPS = ['status', 'probe', 'models', 'apply'] as const
export type ProviderOp = (typeof PROVIDER_OPS)[number]

export const PROBE_MODES = ['auth', 'latency', 'call'] as const
export type ProbeMode = (typeof PROBE_MODES)[number]

export const SESSION_POLICIES = ['keep', 'reset'] as const
export type SessionPolicy = (typeof SESSION_POLICIES)[number]

/**
 * §2.5 limits. `models` has no figure in the design; it is one HTTP GET with
 * a fallback, so it shares `probe auth`'s 30 s.
 */
export const PROTOCOL_LIMITS = {
  maxRequestBytes: 64 * 1024,
  timeoutMs: {
    status: 20_000,
    probeAuth: 30_000,
    probeLatency: 30_000,
    probeCall: 90_000,
    models: 30_000,
    apply: 30_000,
  },
} as const

const REQUEST_ID = /^[0-9A-Za-z_-]{8,64}$/
const NODE_NAME = /^[a-z0-9-]{1,32}$/
const OWNED_HASH = /^sha256:[0-9a-f]{64}$/

type RequestBase = { v: 1; requestId: string; node: string }

export type StatusRequest = RequestBase & { op: 'status' }

export type ProbeRequest = RequestBase & {
  op: 'probe'
  profile: WireProfile
  probe: { mode: ProbeMode }
}

/** Without `profile`, lists models for the configuration already applied. */
export type ModelsRequest = RequestBase & {
  op: 'models'
  profile?: WireProfile
}

export type ApplyRequest = RequestBase & {
  op: 'apply'
  /** `null`: the hub has never managed this node. */
  expect: { ownedHash: string | null }
  profile: WireProfile
  recycle: { sessions: SessionPolicy }
  dryRun: boolean
  /** Skip the `expect` check; only after ops confirms an overwrite. */
  force: boolean
}

export type ProviderRequest =
  | StatusRequest
  | ProbeRequest
  | ModelsRequest
  | ApplyRequest

export type ParsedRequest =
  | { ok: true; request: ProviderRequest; warnings: ProviderWarning[] }
  | { ok: false; error: ProviderIssue; requestId: string | null }

export type ParseRequestOptions = ValidateOptions & {
  /** The node name the forced command was installed with. */
  node?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(
  code: ProviderErrorCode,
  path: string,
  message: string,
  requestId: string | null,
): ParsedRequest {
  return { ok: false, error: { code, path, message }, requestId }
}

const TOP_LEVEL: Record<ProviderOp, readonly string[]> = {
  status: ['v', 'op', 'requestId', 'node'],
  probe: ['v', 'op', 'requestId', 'node', 'profile', 'probe'],
  models: ['v', 'op', 'requestId', 'node', 'profile'],
  apply: [
    'v',
    'op',
    'requestId',
    'node',
    'expect',
    'profile',
    'recycle',
    'dryRun',
    'force',
  ],
}

/**
 * Parse one request. `input` is the raw stdin line (size-checked in UTF-8
 * bytes, before JSON parsing) or an already-parsed value.
 */
export function parseProviderRequest(
  input: string | unknown,
  options: ParseRequestOptions = {},
): ParsedRequest {
  let raw: unknown = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > PROTOCOL_LIMITS.maxRequestBytes) {
      return fail('bad-request', '', '请求超过 64 KiB', null)
    }
    try {
      raw = JSON.parse(input)
    } catch {
      return fail('bad-request', '', '请求不是合法的 JSON', null)
    }
  }
  if (!isRecord(raw))
    return fail('bad-request', '', '请求必须是 JSON 对象', null)

  const requestId =
    typeof raw.requestId === 'string' && REQUEST_ID.test(raw.requestId)
      ? raw.requestId
      : null
  if (raw.v === undefined)
    return fail('bad-request', 'v', '缺少协议版本 v', requestId)
  if (raw.v !== PROTOCOL_VERSION) {
    return fail(
      'version-skew',
      'v',
      `不支持协议版本 ${String(raw.v)} · 节点只认 v1`,
      requestId,
    )
  }
  if (
    typeof raw.op !== 'string' ||
    !(PROVIDER_OPS as readonly string[]).includes(raw.op)
  ) {
    return fail('unsupported-op', 'op', '不支持的操作', requestId)
  }
  const op = raw.op as ProviderOp
  if (requestId === null) {
    return fail(
      'bad-request',
      'requestId',
      'requestId 必须是 [0-9A-Za-z_-]{8,64}',
      null,
    )
  }
  if (typeof raw.node !== 'string' || !NODE_NAME.test(raw.node)) {
    return fail(
      'bad-request',
      'node',
      '节点名必须是 [a-z0-9-]{1,32}',
      requestId,
    )
  }
  if (options.node !== undefined && raw.node !== options.node) {
    return fail(
      'node-mismatch',
      'node',
      '请求里的节点名与本节点不符',
      requestId,
    )
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL[op].includes(key)) {
      return fail('bad-request', key, `操作 ${op} 不接受字段 ${key}`, requestId)
    }
  }
  const base = { v: PROTOCOL_VERSION, requestId, node: raw.node } as const

  if (op === 'status') {
    return { ok: true, request: { ...base, op }, warnings: [] }
  }

  let profile: WireProfile | undefined
  let warnings: ProviderWarning[] = []
  if (raw.profile !== undefined) {
    const parsed = parseWireProfile(raw.profile, options)
    if (!parsed.ok) return { ok: false, error: parsed.error, requestId }
    profile = parsed.value
    warnings = parsed.warnings
    if (
      options.capabilities !== undefined &&
      !options.capabilities.multiKey &&
      profile.auth.keys.length > 1
    ) {
      return fail(
        'unsupported-multi-key',
        'profile.auth.keys',
        '本节点一次只接受一把密钥 · 多密钥轮换要等节点支持',
        requestId,
      )
    }
  } else if (op !== 'models') {
    return fail(
      'bad-request',
      'profile',
      `操作 ${op} 必须带 profile`,
      requestId,
    )
  }

  if (op === 'models') {
    return {
      ok: true,
      request:
        profile === undefined ? { ...base, op } : { ...base, op, profile },
      warnings,
    }
  }

  if (op === 'probe') {
    if (!isRecord(raw.probe)) {
      return fail('bad-request', 'probe', 'probe 必须是对象', requestId)
    }
    const extra = Object.keys(raw.probe).find(key => key !== 'mode')
    if (extra !== undefined) {
      return fail(
        'bad-request',
        `probe.${extra}`,
        `probe 不接受字段 ${extra}`,
        requestId,
      )
    }
    const mode = raw.probe.mode
    if (
      typeof mode !== 'string' ||
      !(PROBE_MODES as readonly string[]).includes(mode)
    ) {
      return fail(
        'bad-value',
        'probe.mode',
        'probe.mode 必须是 auth / latency / call',
        requestId,
      )
    }
    return {
      ok: true,
      request: {
        ...base,
        op,
        profile: profile as WireProfile,
        probe: { mode: mode as ProbeMode },
      },
      warnings,
    }
  }

  // apply
  if (!isRecord(raw.expect)) {
    return fail('bad-request', 'expect', 'apply 必须带 expect', requestId)
  }
  const expectExtra = Object.keys(raw.expect).find(key => key !== 'ownedHash')
  if (expectExtra !== undefined) {
    return fail(
      'bad-request',
      `expect.${expectExtra}`,
      `expect 不接受字段 ${expectExtra}`,
      requestId,
    )
  }
  const ownedHash = raw.expect.ownedHash
  if (
    ownedHash !== null &&
    (typeof ownedHash !== 'string' || !OWNED_HASH.test(ownedHash))
  ) {
    return fail(
      'bad-value',
      'expect.ownedHash',
      'ownedHash 必须是 sha256:<64 位十六进制> 或 null',
      requestId,
    )
  }
  let sessions: SessionPolicy = 'reset'
  if (raw.recycle !== undefined) {
    if (!isRecord(raw.recycle)) {
      return fail('bad-request', 'recycle', 'recycle 必须是对象', requestId)
    }
    const recycleExtra = Object.keys(raw.recycle).find(
      key => key !== 'sessions',
    )
    if (recycleExtra !== undefined) {
      return fail(
        'bad-request',
        `recycle.${recycleExtra}`,
        `recycle 不接受字段 ${recycleExtra}`,
        requestId,
      )
    }
    const policy = raw.recycle.sessions
    if (
      typeof policy !== 'string' ||
      !(SESSION_POLICIES as readonly string[]).includes(policy)
    ) {
      return fail(
        'bad-value',
        'recycle.sessions',
        'sessions 必须是 keep 或 reset',
        requestId,
      )
    }
    sessions = policy as SessionPolicy
  }
  for (const flag of ['dryRun', 'force'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
      return fail('bad-request', flag, `${flag} 必须是布尔值`, requestId)
    }
  }
  return {
    ok: true,
    request: {
      ...base,
      op,
      expect: { ownedHash: ownedHash as string | null },
      profile: profile as WireProfile,
      recycle: { sessions },
      dryRun: raw.dryRun === true,
      force: raw.force === true,
    },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Responses and node state (§2.4)
// ---------------------------------------------------------------------------

/** The last commit to `settings.json`. */
export type AppliedRecord = {
  profileId: string
  revision: number
  requestId: string
  at: string
}

export type PendingSummary = {
  requestId: string
  since: string
  /** Filled by the resident (P18.3); `null` when nobody is counting. */
  waitingTurns: number | null
}

export type ResidentSummary = {
  running: boolean
  generation: number | null
  inFlight: number | null
}

/** Outcome of the most recent commit attempt that did NOT end in `committed`. */
export type LastCommitResult = {
  requestId: string
  code: 'conflict' | 'write-failed'
  at: string
  diffKeys: string[]
}

/** §2.4, minus `effective` (that one needs its own process). */
export type ProviderNodeState = {
  managed: boolean
  applied: AppliedRecord | null
  onDiskHash: string
  appliedHash: string | null
  loadedHash: string | null
  pending: PendingSummary | null
  resident: ResidentSummary | null
  inheritedProviderKeys: string[]
  capabilities: NodeCapabilities
  lastResult: LastCommitResult | null
}

/** §2.4 `effective`: computed by the node's REAL gate functions. */
export type EffectiveState = {
  /** `getAPIProvider()`. */
  apiProvider: string
  /** `anthropic` for the Messages wire, else `chat` / `responses` / `gemini` / `grok`. */
  wire: string
  /** The main-loop model the session selects (`getMainLoopModel()`). */
  model: string
  /** The id the lane actually puts on the wire after its own mapping. */
  wireModel: string
  /** The `settings.modelSettings` slot that governs the main loop, or `null`. */
  modelSettingsSlot: string | null
  effortOnWire: boolean
  effortLevel: EffortLevel | null
  contextTokens: number
}

export type ProviderResponse =
  | {
      v: typeof PROTOCOL_VERSION
      requestId: string | null
      ok: true
      state?: ProviderNodeState
      effective?: EffectiveState
      /** `dryRun`: env keys that would change, by name only. */
      diffKeys?: string[]
      warnings?: ProviderWarning[]
    }
  | {
      v: typeof PROTOCOL_VERSION
      requestId: string | null
      ok: false
      code: ProviderErrorCode
      message: string
      diffKeys?: string[]
      state?: ProviderNodeState
    }

/** Build an error response from an issue; `message` never includes values. */
export function errorResponse(
  requestId: string | null,
  issue: ProviderIssue,
  extra: { diffKeys?: string[]; state?: ProviderNodeState } = {},
): ProviderResponse {
  if (!isProviderErrorCode(issue.code)) {
    throw new TypeError('errorResponse: 错误码不在闭合集合里')
  }
  return {
    v: PROTOCOL_VERSION,
    requestId,
    ok: false,
    code: issue.code,
    message: issue.path ? `${issue.message}（${issue.path}）` : issue.message,
    ...extra,
  }
}
