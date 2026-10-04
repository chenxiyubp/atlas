// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Profile validation, shared verbatim by the hub and the node (§2.2: the node
 * re-validates with the same schema and does not trust the hub).
 *
 * Strict by construction: an object property this module does not know is
 * `unknown-key`, never ignored. The `env` block a profile compiles into is
 * applied to the whole process, so "ignore what you don't understand" would be
 * the bug.
 *
 * Hard errors only cover what can never work (bad shape, a value the node
 * cannot honour). Things that might be a mistake but can work come back as
 * `warnings` (§6.3.2 point 7: soft problems do not block a save).
 */

import {
  checkCompatValue,
  isCompatKey,
  isForbiddenEnvKey,
  PROFILE_SETTABLE_COMPAT_KEYS,
} from './compatKeys.js'
import {
  clampSharedEffortDown,
  compiledEffortLevel,
  isEffortLevel,
  sortEffortLevels,
  UNSPECIFIED_EFFORT_LEVEL,
} from './effort.js'
import type { ProviderErrorCode, ProviderIssue } from './errors.js'
import { isSecretFingerprint } from './fingerprint.js'
import { modelRetirementStatus } from './retirements.js'
import { isKeyId, isProfileId } from './secretRef.js'
import {
  AUTH_SCHEMES,
  type AuthScheme,
  type CompatEnv,
  EFFORT_SENDS,
  type EffortLevel,
  type Evaluated,
  type HttpProbe,
  KEY_SELECTIONS,
  type KeyRef,
  type KeySelection,
  LANES,
  type Lane,
  MAX_KEYS_PER_PROFILE,
  MODEL_ROLES,
  MODEL_TIERS,
  type ModelCapabilities,
  type ModelEffort,
  type ModelTier,
  type NodeCapabilities,
  PLANS,
  type Plan,
  type ProbeSpec,
  type ProfileCore,
  type ProviderModel,
  type ProviderProfile,
  type Terms,
  type WireKey,
  type WireProfile,
} from './types.js'

export type ProviderWarning = {
  code:
    | 'retiring-model'
    | 'tier-unpinned'
    | 'override-on-claude-catalog'
    | 'key-hint-mismatch'
  message: string
  path: string
}

export type Validated<T> =
  | { ok: true; value: T; warnings: ProviderWarning[] }
  | { ok: false; error: ProviderIssue }

export type ValidateOptions = {
  /** Clock for the retirement check. */
  now?: Date
  /**
   * The node's capabilities. When given, settings the node cannot honour are
   * refused here (`effort-unsendable`); when omitted, only shape is checked.
   */
  capabilities?: NodeCapabilities
}

/** Thrown internally and turned into a {@link Validated} failure at the boundary. */
class Refusal extends Error {
  constructor(readonly issue: ProviderIssue) {
    super(issue.message)
  }
}

function refuse(code: ProviderErrorCode, path: string, message: string): never {
  throw new Refusal({ code, path, message })
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, path: string): Json {
  if (!isRecord(value)) refuse('bad-request', path, '必须是对象')
  return value
}

function onlyKeys(value: Json, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      refuse(
        'unknown-key',
        path ? `${path}.${key}` : key,
        `不认识的字段 ${key}`,
      )
    }
  }
}

/** No control characters anywhere in a string that may reach settings.json. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately rejecting control chars
const CONTROL = /[\u0000-\u001f\u007f]/

function text(
  value: unknown,
  path: string,
  { max, min = 1 }: { max: number; min?: number },
): string {
  if (typeof value !== 'string') refuse('bad-request', path, '必须是字符串')
  if (value.length < min || value.length > max) {
    refuse('bad-value', path, `长度必须在 ${min} 到 ${max} 之间`)
  }
  if (CONTROL.test(value)) refuse('bad-value', path, '不能含控制字符')
  return value
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    refuse('bad-value', path, `必须是 ${allowed.join(' / ')} 之一`)
  }
  return value as T
}

function integer(
  value: unknown,
  path: string,
  { min, max }: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    refuse('bad-request', path, '必须是整数')
  }
  if (value < min || value > max) {
    refuse('bad-value', path, `必须在 ${min} 到 ${max} 之间`)
  }
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') refuse('bad-request', path, '必须是布尔值')
  return value
}

function isoTime(value: unknown, path: string): string {
  const s = text(value, path, { max: 40 })
  if (Number.isNaN(Date.parse(s)))
    refuse('bad-value', path, '不是合法的 ISO 时间')
  return s
}

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

const TEMPLATE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
/** Hostname-label safe, so a value cannot move the URL to another host. */
const TEMPLATE_VALUE = /^[A-Za-z0-9-]{1,63}$/
const PLACEHOLDER = /\{([^{}]*)\}/g

/**
 * `{Name}` placeholders filled from `values`. Every placeholder must resolve;
 * a value is limited to one hostname label so it cannot redirect the request.
 */
export function resolveBaseUrl(
  baseUrl: string,
  values: Record<string, string> = {},
): { ok: true; url: string } | { ok: false; message: string } {
  for (const [name, value] of Object.entries(values)) {
    if (!TEMPLATE_NAME.test(name)) {
      return { ok: false, message: `模板变量名 ${name} 不合法` }
    }
    if (!TEMPLATE_VALUE.test(value)) {
      return {
        ok: false,
        message: `模板变量 ${name} 的值只能是字母、数字和连字符`,
      }
    }
  }
  let missing: string | undefined
  const url = baseUrl.replace(PLACEHOLDER, (whole, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined
    if (value === undefined) {
      missing ??= name
      return whole
    }
    return value
  })
  if (missing !== undefined) {
    return { ok: false, message: `缺少模板变量 ${missing}` }
  }
  return { ok: true, url }
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!octets) return false
  const [a, b] = [Number(octets[1]), Number(octets[2])]
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

/**
 * §3.1: https anywhere, or plain http to a loopback / private address (a local
 * server, resolved ON THE NODE). Never user:password, a query or a fragment —
 * those are where keys leak into logs.
 */
export function checkBaseUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '不是合法的 URL'
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return '地址里不能带用户名或密码'
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return '地址里不能带查询串或片段'
  }
  if (parsed.protocol === 'https:') return null
  if (parsed.protocol === 'http:' && isPrivateOrLoopbackHost(parsed.hostname)) {
    return null
  }
  return '必须是 https · 或者回环 / 私网地址上的 http'
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Wire ids: vendor paths (`deepseek-ai/…`), tags (`model:tag`), `~vendor/…`. */
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:/~@+-]{0,127}$/

const CAPABILITY_TIERS: readonly ModelTier[] = ['opus', 'sonnet', 'haiku']

function parseCapabilities(value: unknown, path: string): ModelCapabilities {
  const raw = record(value, path)
  const mode = oneOf(raw.mode, ['family', 'explicit'] as const, `${path}.mode`)
  if (mode === 'family') {
    onlyKeys(raw, ['mode'], path)
    return { mode }
  }
  onlyKeys(
    raw,
    ['mode', 'thinking', 'adaptive_thinking', 'interleaved_thinking'],
    path,
  )
  return {
    mode,
    thinking: bool(raw.thinking, `${path}.thinking`),
    adaptive_thinking: bool(raw.adaptive_thinking, `${path}.adaptive_thinking`),
    interleaved_thinking: bool(
      raw.interleaved_thinking,
      `${path}.interleaved_thinking`,
    ),
  }
}

function parseEffort(value: unknown, path: string): ModelEffort {
  const raw = record(value, path)
  onlyKeys(raw, ['send', 'level', 'levels'], path)
  const effort: ModelEffort = {
    send: oneOf(raw.send, EFFORT_SENDS, `${path}.send`),
  }
  if (raw.level !== undefined) {
    if (!isEffortLevel(raw.level)) {
      refuse(
        'bad-value',
        `${path}.level`,
        '档位必须是 low/medium/high/xhigh/max',
      )
    }
    effort.level = raw.level
  }
  if (raw.levels !== undefined) {
    if (!Array.isArray(raw.levels)) {
      refuse('bad-request', `${path}.levels`, '必须是数组')
    }
    const levels: EffortLevel[] = []
    raw.levels.forEach((level, index) => {
      if (!isEffortLevel(level)) {
        refuse(
          'bad-value',
          `${path}.levels.${index}`,
          '档位必须是 low/medium/high/xhigh/max',
        )
      }
      if (levels.includes(level)) {
        refuse('bad-value', `${path}.levels.${index}`, `档位 ${level} 重复`)
      }
      levels.push(level)
    })
    effort.levels = sortEffortLevels(levels)
  }
  return effort
}

function parseModel(value: unknown, path: string): ProviderModel {
  const raw = record(value, path)
  onlyKeys(
    raw,
    [
      'id',
      'role',
      'tiers',
      'capabilities',
      'effort',
      'contextTokens',
      'maxOutputTokens',
      'retireAt',
    ],
    path,
  )
  const id = text(raw.id, `${path}.id`, { max: 128 })
  if (/\[1m\]$/i.test(id)) {
    refuse(
      'bad-value',
      `${path}.id`,
      '模型名不能带 [1m] · 那是客户端标记 · 上下文用 contextTokens 表达',
    )
  }
  if (!MODEL_ID.test(id))
    refuse('bad-value', `${path}.id`, '模型名含不允许的字符')
  if (!Array.isArray(raw.tiers))
    refuse('bad-request', `${path}.tiers`, '必须是数组')
  const tiers: ModelTier[] = []
  raw.tiers.forEach((tier, index) => {
    const parsed = oneOf(tier, MODEL_TIERS, `${path}.tiers.${index}`)
    if (tiers.includes(parsed)) {
      refuse('bad-value', `${path}.tiers.${index}`, `档位 ${parsed} 重复`)
    }
    tiers.push(parsed)
  })
  const model: ProviderModel = {
    id,
    role: oneOf(raw.role, MODEL_ROLES, `${path}.role`),
    tiers,
    capabilities: parseCapabilities(raw.capabilities, `${path}.capabilities`),
    effort: parseEffort(raw.effort, `${path}.effort`),
  }
  if (raw.contextTokens !== undefined) {
    model.contextTokens = integer(raw.contextTokens, `${path}.contextTokens`, {
      min: 1_000,
      max: 100_000_000,
    })
  }
  if (raw.maxOutputTokens !== undefined) {
    model.maxOutputTokens = integer(
      raw.maxOutputTokens,
      `${path}.maxOutputTokens`,
      { min: 1, max: 10_000_000 },
    )
  }
  if (raw.retireAt !== undefined) {
    model.retireAt = isoTime(raw.retireAt, `${path}.retireAt`)
  }
  return model
}

/**
 * The §3.4 rules for one model on one lane. Exported because the compiler
 * applies them to the lane a profile EFFECTIVELY runs on, which can differ
 * from the declared one (DeepSeek with the Anthropic mirror switched off runs
 * on chat).
 */
export function checkModelEffort(
  model: ProviderModel,
  lane: Lane,
  path: string,
  capabilities?: NodeCapabilities,
): ProviderIssue | null {
  const { send, level, levels } = model.effort
  const mode = model.capabilities.mode
  if (send === 'auto' && mode !== 'family') {
    return {
      code: 'bad-value',
      path: `${path}.capabilities`,
      message:
        'effort 为 auto 时能力必须是 family · 显式能力要配 always 或 never',
    }
  }
  if (send !== 'auto' && mode !== 'explicit') {
    return {
      code: 'bad-value',
      path: `${path}.capabilities`,
      message:
        'effort 为 always 或 never 时能力必须显式给出 · 基座把缺项读成 false · 只能全有或全无',
    }
  }
  if (send !== 'auto' && (lane === 'gemini' || lane === 'grok')) {
    return {
      code: 'effort-unsendable',
      path: `${path}.effort.send`,
      message: `${lane} 线 v1 只允许 effort auto · 能力覆盖还不读这条线路自己的前缀`,
    }
  }
  if (
    send === 'always' &&
    lane === 'openai-chat' &&
    capabilities !== undefined &&
    !capabilities.chatEffortHonorsOverride
  ) {
    return {
      code: 'effort-unsendable',
      path: `${path}.effort.send`,
      message:
        'chat 线在当前节点代码上发不了显式 effort · 等节点报 chatEffortHonorsOverride',
    }
  }
  if (send === 'always' && (levels === undefined || levels.length === 0)) {
    return {
      code: 'bad-value',
      path: `${path}.effort.levels`,
      message: 'effort 为 always 时必须给出可选档位',
    }
  }
  if (
    send !== 'auto' &&
    !model.tiers.some(tier => CAPABILITY_TIERS.includes(tier))
  ) {
    return {
      code: 'bad-value',
      path: `${path}.tiers`,
      message:
        '显式能力要挂在 opus / sonnet / haiku 档上才会被读到 · fable 档在 P18.5 之前没人读',
    }
  }
  if (levels !== undefined && compiledEffortLevel(model.effort) === null) {
    const requested = level ?? `${UNSPECIFIED_EFFORT_LEVEL}（未指定时的默认）`
    return {
      code: 'bad-value',
      path: `${path}.effort.level`,
      message: `档位 ${requested} 往低夹不到 ${levels.join('/')} 里的任何一档`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Profile core
// ---------------------------------------------------------------------------

function parseCompat(value: unknown, path: string, lane: Lane): CompatEnv {
  const raw = record(value, path)
  const compat: CompatEnv = {}
  for (const [key, entry] of Object.entries(raw)) {
    const at = `${path}.${key}`
    if (isForbiddenEnvKey(key) || !isCompatKey(key)) {
      refuse('unknown-key', at, `${key} 不在闭合兼容键集里`)
    }
    if (!PROFILE_SETTABLE_COMPAT_KEYS.includes(key)) {
      refuse(
        'bad-value',
        at,
        `${key} 由编译器从 effortLock 和各模型的 effort 推导 · 不能直接设`,
      )
    }
    if (key === 'ANTHROPIC_CUSTOM_HEADERS' && lane !== 'anthropic') {
      refuse('bad-value', at, '只用于 Anthropic 线')
    }
    const valueText = text(entry, at, { max: 256 })
    const problem = checkCompatValue(key, valueText)
    if (problem !== null) refuse('bad-value', at, `${key} ${problem}`)
    compat[key] = valueText
  }
  return compat
}

const CORE_KEYS = [
  'id',
  'revision',
  'lane',
  'baseUrl',
  'templateValues',
  'models',
  'compat',
  'effortLock',
  'keySelection',
] as const

const MAX_MODELS = 32

function parseCore(
  raw: Json,
  path: string,
  options: ValidateOptions,
  warnings: ProviderWarning[],
): ProfileCore {
  const at = (field: string) => (path ? `${path}.${field}` : field)
  if (!isProfileId(raw.id)) {
    refuse('bad-value', at('id'), 'id 必须是 [a-z0-9-]{1,48}')
  }
  const lane = oneOf(raw.lane, LANES, at('lane'))
  const baseUrl = text(raw.baseUrl, at('baseUrl'), { max: 512 })
  let templateValues: Record<string, string> | undefined
  if (raw.templateValues !== undefined) {
    const values = record(raw.templateValues, at('templateValues'))
    templateValues = {}
    for (const [name, entry] of Object.entries(values)) {
      templateValues[name] = text(entry, at(`templateValues.${name}`), {
        max: 63,
      })
    }
  }
  const resolved = resolveBaseUrl(baseUrl, templateValues)
  if (!resolved.ok) refuse('bad-value', at('templateValues'), resolved.message)
  const urlProblem = checkBaseUrl(resolved.url)
  if (urlProblem !== null) refuse('bad-value', at('baseUrl'), urlProblem)

  if (!Array.isArray(raw.models))
    refuse('bad-request', at('models'), '必须是数组')
  if (raw.models.length === 0 || raw.models.length > MAX_MODELS) {
    refuse('bad-value', at('models'), `模型数必须在 1 到 ${MAX_MODELS} 之间`)
  }
  const models = raw.models.map((entry, index) =>
    parseModel(entry, at(`models.${index}`)),
  )
  const mains = models.filter(model => model.role === 'main')
  if (mains.length !== 1) {
    refuse('bad-value', at('models'), 'role 为 main 的模型必须恰好一个')
  }
  if (mains[0] !== undefined && mains[0].tiers.length === 0) {
    refuse('bad-value', at('models'), '主模型至少要占一个档位')
  }
  const seenIds = new Set<string>()
  const owner = new Map<ModelTier, number>()
  models.forEach((model, index) => {
    if (seenIds.has(model.id)) {
      refuse('bad-value', at(`models.${index}.id`), `模型 ${model.id} 重复`)
    }
    seenIds.add(model.id)
    for (const tier of model.tiers) {
      if (owner.has(tier)) {
        refuse(
          'bad-value',
          at(`models.${index}.tiers`),
          `档位 ${tier} 已被另一个模型占用`,
        )
      }
      owner.set(tier, index)
    }
    const issue = checkModelEffort(
      model,
      lane,
      at(`models.${index}`),
      options.capabilities,
    )
    if (issue !== null) throw new Refusal(issue)
    const status = modelRetirementStatus(
      model.id,
      options.now ?? new Date(),
      model.retireAt,
    )
    if (status === 'retired') {
      refuse(
        'retired-model',
        at(`models.${index}.id`),
        `模型 ${model.id} 已过下线日期`,
      )
    }
    if (status === 'retiring') {
      warnings.push({
        code: 'retiring-model',
        path: at(`models.${index}.id`),
        message: `模型 ${model.id} 将在 14 天内下线`,
      })
    }
    if (
      model.effort.send !== 'auto' &&
      lane === 'anthropic' &&
      /claude/i.test(model.id)
    ) {
      warnings.push({
        code: 'override-on-claude-catalog',
        path: at(`models.${index}.effort.send`),
        message:
          'Claude 模型的能力由基座能力表决定 · 显式覆盖可能不生效 · 以节点算出的值为准',
      })
    }
  })
  // Anthropic's own host resolves an unpinned alias to a real Claude model;
  // every other endpoint answers it with "model not found".
  const officialAnthropic =
    lane === 'anthropic' &&
    new URL(resolved.url).hostname === 'api.anthropic.com'
  for (const tier of MODEL_TIERS) {
    if (!owner.has(tier) && !officialAnthropic) {
      warnings.push({
        code: 'tier-unpinned',
        path: at('models'),
        message: `档位 ${tier} 没有模型 · 用到这一档时会落到基座的族默认模型`,
      })
    }
  }

  const compat =
    raw.compat === undefined ? {} : parseCompat(raw.compat, at('compat'), lane)

  let effortLock: EffortLevel | null = null
  if (raw.effortLock !== undefined && raw.effortLock !== null) {
    if (!isEffortLevel(raw.effortLock)) {
      refuse(
        'bad-value',
        at('effortLock'),
        '档位必须是 low/medium/high/xhigh/max',
      )
    }
    const sets = models
      .filter(model => model.effort.send !== 'never')
      .map(model => model.effort.levels)
      .filter((levels): levels is EffortLevel[] => levels !== undefined)
    if (clampSharedEffortDown(raw.effortLock, sets) === null) {
      refuse(
        'bad-value',
        at('effortLock'),
        `锁定档位 ${raw.effortLock} 往低夹不到所有模型都接受的一档`,
      )
    }
    effortLock = raw.effortLock
  }

  const keySelection: KeySelection =
    raw.keySelection === undefined
      ? 'fill_first'
      : oneOf(raw.keySelection, KEY_SELECTIONS, at('keySelection'))

  return {
    id: raw.id,
    revision: integer(raw.revision, at('revision'), {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    lane,
    baseUrl,
    ...(templateValues === undefined ? {} : { templateValues }),
    models,
    compat,
    effortLock,
    keySelection,
  }
}

function parseAuthScheme(raw: Json, path: string, lane: Lane): AuthScheme {
  const scheme = oneOf(raw.scheme, AUTH_SCHEMES, `${path}.scheme`)
  if (scheme === 'x-api-key' && lane !== 'anthropic') {
    refuse(
      'bad-value',
      `${path}.scheme`,
      'x-api-key 只用于 Anthropic 线 · 其他线路一律 Bearer',
    )
  }
  return scheme
}

function checkUniqueKeyIds(ids: string[], path: string): void {
  ids.forEach((id, index) => {
    if (ids.indexOf(id) !== index) {
      refuse('bad-value', `${path}.${index}.id`, `密钥 id ${id} 重复`)
    }
  })
}

function keyListShape(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) refuse('bad-request', path, '必须是数组')
  if (value.length < 1 || value.length > MAX_KEYS_PER_PROFILE) {
    refuse(
      'bad-value',
      path,
      `密钥数必须在 1 到 ${MAX_KEYS_PER_PROFILE} 之间 · Anthropic 线的第三方主机没有密钥时会把节点本地登录凭据发出去`,
    )
  }
  return value
}

/** A key value: printable, no whitespace, bounded. Never echoed in messages. */
function secretValue(value: unknown, path: string): string {
  if (typeof value !== 'string') refuse('bad-request', path, '必须是字符串')
  if (
    value.length < 1 ||
    value.length > 4096 ||
    /\s/.test(value) ||
    CONTROL.test(value)
  ) {
    refuse(
      'bad-value',
      path,
      '密钥不能为空 · 不能含空白或控制字符 · 不超过 4096 字符',
    )
  }
  return value
}

function parseWireKeys(value: unknown, path: string): WireKey[] {
  const keys = keyListShape(value, path).map((entry, index): WireKey => {
    const at = `${path}.${index}`
    const raw = record(entry, at)
    if (!isKeyId(raw.id))
      refuse('bad-value', `${at}.id`, '密钥 id 必须是 [a-z0-9-]{1,32}')
    if (raw.value !== undefined && raw.keep !== undefined) {
      refuse('bad-request', at, 'value 与 keep 只能给一个')
    }
    const priority =
      raw.priority === undefined
        ? {}
        : {
            priority: integer(raw.priority, `${at}.priority`, {
              min: -1000,
              max: 1000,
            }),
          }
    if (raw.keep !== undefined) {
      onlyKeys(raw, ['id', 'keep', 'priority'], at)
      if (!isSecretFingerprint(raw.keep)) {
        refuse('bad-value', `${at}.keep`, 'keep 必须是密钥指纹')
      }
      return { id: raw.id, keep: raw.keep, ...priority }
    }
    onlyKeys(raw, ['id', 'value', 'priority'], at)
    return {
      id: raw.id,
      value: secretValue(raw.value, `${at}.value`),
      ...priority,
    }
  })
  checkUniqueKeyIds(
    keys.map(key => key.id),
    path,
  )
  return keys
}

function parseKeyRefs(value: unknown, path: string): KeyRef[] {
  const keys = keyListShape(value, path).map((entry, index): KeyRef => {
    const at = `${path}.${index}`
    const raw = record(entry, at)
    onlyKeys(raw, ['id', 'label', 'priority', 'fingerprint', 'setAt'], at)
    if (!isKeyId(raw.id))
      refuse('bad-value', `${at}.id`, '密钥 id 必须是 [a-z0-9-]{1,32}')
    const ref: KeyRef = { id: raw.id }
    if (raw.label !== undefined)
      ref.label = text(raw.label, `${at}.label`, { max: 40 })
    if (raw.priority !== undefined) {
      ref.priority = integer(raw.priority, `${at}.priority`, {
        min: -1000,
        max: 1000,
      })
    }
    if (raw.fingerprint !== undefined) {
      if (!isSecretFingerprint(raw.fingerprint)) {
        refuse('bad-value', `${at}.fingerprint`, '不是密钥指纹')
      }
      ref.fingerprint = raw.fingerprint
    }
    if (raw.setAt !== undefined) ref.setAt = isoTime(raw.setAt, `${at}.setAt`)
    return ref
  })
  checkUniqueKeyIds(
    keys.map(key => key.id),
    path,
  )
  return keys
}

/**
 * The key a v1 node compiles and delivers: highest `priority` (absent = 0),
 * ties broken by list order. The rest of the list is P18.18's.
 */
export function primaryKey<T extends { id: string; priority?: number }>(
  keys: readonly T[],
): T {
  let best: T | undefined
  for (const key of keys) {
    if (best === undefined || (key.priority ?? 0) > (best.priority ?? 0)) {
      best = key
    }
  }
  if (best === undefined) throw new TypeError('primaryKey: 密钥列表为空')
  return best
}

function guard<T>(run: () => T, warnings: ProviderWarning[]): Validated<T> {
  try {
    const value = run()
    return { ok: true, value, warnings }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.issue }
    throw error
  }
}

/** The profile inside a sixth-action request (§2.5). */
export function parseWireProfile(
  input: unknown,
  options: ValidateOptions = {},
  path = 'profile',
): Validated<WireProfile> {
  const warnings: ProviderWarning[] = []
  return guard((): WireProfile => {
    const raw = record(input, path)
    onlyKeys(raw, [...CORE_KEYS, 'auth'], path)
    const auth = record(raw.auth, `${path}.auth`)
    onlyKeys(auth, ['scheme', 'keys'], `${path}.auth`)
    const keys = parseWireKeys(auth.keys, `${path}.auth.keys`)
    const core = parseCore(raw, path, options, warnings)
    const scheme = parseAuthScheme(auth, `${path}.auth`, core.lane)
    return { ...core, auth: { scheme, keys } }
  }, warnings)
}

function parseProbe(value: unknown, path: string): ProbeSpec {
  const raw = record(value, path)
  onlyKeys(raw, ['auth', 'models'], path)
  const one = (entry: unknown, at: string): HttpProbe | null => {
    if (entry === null) return null
    const probe = record(entry, at)
    onlyKeys(probe, ['method', 'path', 'body', 'free'], at)
    const method = oneOf(probe.method, ['GET', 'POST'] as const, `${at}.method`)
    const probePath = text(probe.path, `${at}.path`, { max: 256 })
    if (!probePath.startsWith('/'))
      refuse('bad-value', `${at}.path`, '必须以 / 开头')
    return {
      method,
      path: probePath,
      ...(probe.body === undefined
        ? {}
        : { body: record(probe.body, `${at}.body`) }),
      free: bool(probe.free, `${at}.free`),
    }
  }
  return {
    auth: one(raw.auth, `${path}.auth`),
    models: one(raw.models, `${path}.models`),
  }
}

function parseTerms(value: unknown, path: string): Terms {
  const raw = record(value, path)
  onlyKeys(raw, ['restricted', 'note', 'url'], path)
  const url = text(raw.url, `${path}.url`, { max: 512 })
  if (checkBaseUrl(url) !== null || !url.startsWith('https://')) {
    refuse('bad-value', `${path}.url`, '必须是 https 地址')
  }
  return {
    restricted: bool(raw.restricted, `${path}.restricted`),
    note: text(raw.note, `${path}.note`, { max: 200 }),
    url,
  }
}

function parseEvaluated(value: unknown, path: string): Evaluated {
  if (value === false) return false
  const raw = record(value, path)
  onlyKeys(raw, ['at', 'by', 'evidence'], path)
  return {
    at: isoTime(raw.at, `${path}.at`),
    by: text(raw.by, `${path}.by`, { max: 80 }),
    evidence: text(raw.evidence, `${path}.evidence`, { max: 500 }),
  }
}

/** §3.1 — a profile as the hub stores it. Carries no key values. */
export function parseProviderProfile(
  input: unknown,
  options: ValidateOptions = {},
): Validated<ProviderProfile> {
  const warnings: ProviderWarning[] = []
  return guard((): ProviderProfile => {
    const raw = record(input, '')
    onlyKeys(
      raw,
      [
        ...CORE_KEYS,
        'name',
        'presetId',
        'plan',
        'site',
        'auth',
        'keys',
        'probe',
        'terms',
        'evaluated',
      ],
      '',
    )
    const auth = record(raw.auth, 'auth')
    onlyKeys(auth, ['scheme'], 'auth')
    const core = parseCore(raw, '', options, warnings)
    const plan: Plan = oneOf(raw.plan, PLANS, 'plan')
    const presetId =
      raw.presetId === null
        ? null
        : isProfileId(raw.presetId)
          ? raw.presetId
          : refuse('bad-value', 'presetId', 'presetId 必须是预设 id 或 null')
    const site =
      raw.site === null || raw.site === undefined
        ? null
        : isKeyId(raw.site)
          ? raw.site
          : refuse('bad-value', 'site', 'site 必须是 [a-z0-9-]{1,32}')
    return {
      ...core,
      name: text(raw.name, 'name', { max: 40 }),
      presetId,
      plan,
      site,
      auth: { scheme: parseAuthScheme(auth, 'auth', core.lane) },
      keys: parseKeyRefs(raw.keys, 'keys'),
      ...(raw.probe === undefined
        ? {}
        : { probe: parseProbe(raw.probe, 'probe') }),
      ...(raw.terms === undefined
        ? {}
        : { terms: parseTerms(raw.terms, 'terms') }),
      evaluated: parseEvaluated(raw.evaluated, 'evaluated'),
    }
  }, warnings)
}

/**
 * Soft check of a key against a preset's hint (§4.1 rule 4). Never a reason
 * to refuse; the caller shows a hint. `true` when the hint is silent.
 */
export function keyMatchesHint(
  key: string,
  hint: { prefixes: readonly string[]; pattern?: string } | null,
): boolean {
  if (hint === null) return true
  if (hint.pattern !== undefined && new RegExp(hint.pattern).test(key))
    return true
  if (hint.prefixes.length === 0) return hint.pattern === undefined
  return hint.prefixes.some(prefix => key.startsWith(prefix))
}
