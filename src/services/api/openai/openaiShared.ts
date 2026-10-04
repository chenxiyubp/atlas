/**
 * Shared utilities for OpenAI-compatible API paths.
 *
 * Both the OpenAI path (queryModelOpenAI) and Grok path (queryModelGrok) use
 * the same adapters (openaiStreamAdapter, openaiConvertMessages), so the event
 * processing logic should be shared rather than duplicated.
 *
 * Keep this module free of bootstrap/state imports so pure request-body unit
 * tests and isolated mocks do not need a full session runtime.
 *
 * Keep imports limited to leaf modules so request-body unit tests do not pull
 * in the session runtime.
 */

import { createHash } from 'node:crypto'
import { BIN_NAME } from 'src/constants/brand.js'
import { isGptFamilyModel } from 'src/utils/model/chatgptModels.js'

export type OpenAIVerbosity = 'low' | 'medium' | 'high'

export function resolveOpenAIVerbosity(
  model: string,
  opts: { baseURL?: string; isChatGPTAuth: boolean },
): OpenAIVerbosity | undefined {
  if (!isGptFamilyModel(model)) return undefined

  const override = process.env.OPENAI_VERBOSITY?.toLowerCase().trim()
  if (override === 'off' || override === '0' || override === 'false') {
    return undefined
  }
  if (override === 'low' || override === 'medium' || override === 'high') {
    return override
  }
  return opts.isChatGPTAuth || isOfficialOpenAIBaseURL(opts.baseURL)
    ? 'low'
    : undefined
}

/**
 * Whether a configured base URL resolves directly to OpenAI's official API.
 *
 * An absent URL means the OpenAI SDK default (`api.openai.com`). Regional
 * endpoints are subdomains of `api.openai.com`. Keep this strict so generic
 * OpenAI-compatible providers never receive OpenAI-specific cache parameters.
 */
export function isOfficialOpenAIBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL?.trim()) return true

  try {
    const url = new URL(baseURL)
    const isOfficialHost =
      url.hostname === 'api.openai.com' ||
      url.hostname.endsWith('.api.openai.com')
    return (
      url.protocol === 'https:' &&
      isOfficialHost &&
      (url.port === '' || url.port === '443')
    )
  } catch {
    return false
  }
}

/**
 * Build a stable OpenAI `prompt_cache_key` for a session.
 *
 * OpenAI automatic prefix caching benefits from routing sticky keys so multi-turn
 * requests land on the same cache-bearing compute node. The key must be stable
 * for the whole conversation — never derived from full message bodies (that
 * changes every turn and defeats routing).
 *
 * Format: `occ:<sessionId>`
 */
export function formatOpenAIPromptCacheKey(sessionId: string): string {
  return `${BIN_NAME}:${sessionId}`
}

/**
 * Build a `prompt_cache_key` from the request's own cached prefix instead of
 * from the session id.
 *
 * Why this is not the same thing as the session key: the key is a *routing*
 * hint. Requests carrying the same key are steered to the same cache-bearing
 * node, so a key that changes whenever a session changes throws away every
 * cache entry the previous session paid to create — even though the prefix
 * (system prompt + tool table) is byte-identical.
 *
 * Measured against the live gateway this repo tests against (`gpt-5.6-sol`):
 * four byte-identical single-turn requests, 39167 input tokens each, one fresh
 * session per request, nothing varied but the key.
 *
 * | key                     | cached / input | hit   |
 * | ----------------------- | -------------- | ----- |
 * | `occ:<sessionId>`       | 0 / 39167      |  0.0% |
 * | `occ:<sessionId>`       | 0 / 39167      |  0.0% |
 * | `occ:p:<fingerprint>`   | 38400 / 39167  | 98.0% |
 * | `occ:p:<fingerprint>`   | 38400 / 39167  | 98.0% |
 *
 * Later turns were already ~97% either way — within one session the session id
 * is stable, so both schemes route consistently. The whole gap is the cold
 * start, which is exactly the shape a resident node pays: every wake is a new
 * session against an unchanged prefix.
 *
 * The fingerprint deliberately covers only material that is *provably* inside
 * the cached prefix and stable across turns:
 *
 *  - the model id (a different model is a different cache);
 *  - the system/developer text, which on the Responses line becomes the
 *    `instructions` field and on the chat line is `messages[0]` — it already
 *    embeds the working directory and platform block, so the key is scoped per
 *    workspace for free;
 *  - the tool names, in order, as a cheap faithful proxy for the tool table.
 *
 * Being too *coarse* is harmless: two different prefixes sharing a key just
 * means the node holds a prefix that does not match, i.e. an ordinary miss.
 * Being too *fine* is what costs money, which is why nothing per-turn (message
 * bodies, timestamps, request ids) may ever enter this hash.
 */
function formatOpenAIPrefixCacheKey(params: {
  model: string
  messages: readonly unknown[]
  tools: readonly unknown[]
}): string {
  const hash = createHash('sha256')
  hash.update(params.model)
  for (const message of params.messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role !== 'system' && record.role !== 'developer') continue
    hash.update('\u0000s')
    hash.update(plainTextOfContent(record.content))
  }
  for (const tool of params.tools) {
    const name = toolName(tool)
    if (name === undefined) continue
    hash.update('\u0000t')
    hash.update(name)
  }
  return `${BIN_NAME}:p:${hash.digest('hex').slice(0, 16)}`
}

/**
 * Flatten OpenAI chat-format `content` to the text the model actually sees.
 * Deliberately local rather than shared with responsesAdapter's version: this
 * module must stay importable by the pure request-body tests.
 */
function plainTextOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (!part || typeof part !== 'object') continue
    const text = (part as Record<string, unknown>).text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('')
}

/** Tool name for both the chat (`{function:{name}}`) and flat shapes. */
function toolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object') return undefined
  const record = tool as Record<string, unknown>
  const fn = record.function
  if (fn && typeof fn === 'object') {
    const nested = (fn as Record<string, unknown>).name
    if (typeof nested === 'string') return nested
  }
  return typeof record.name === 'string' ? record.name : undefined
}

/**
 * Which requests should share a `prompt_cache_key` routing bucket.
 *
 * `prefix` (default) keys on the cached prefix, so a new session reuses the
 * node that already holds it — see {@link formatOpenAIPrefixCacheKey} for the
 * measurement. `session` restores the pre-2026-08 behaviour of one bucket per
 * session id, for a gateway whose per-key rate limit makes bucket sharing
 * worse than a cold start, or for anyone who wants unrelated sessions kept on
 * separate compute.
 *
 * Nothing about either scope changes what is *sent*: the key is an opaque
 * routing label, never request content, and OpenAI does not share caches
 * across organizations. So this is a throughput knob, not a privacy one.
 */
export function getOpenAIPromptCacheKeyScope(): 'prefix' | 'session' {
  return process.env.OPENAI_PROMPT_CACHE_KEY_SCOPE?.toLowerCase().trim() ===
    'session'
    ? 'session'
    : 'prefix'
}

// Env truthiness is re-implemented here rather than imported from
// utils/config/envUtils: this module is deliberately dependency-free so the
// pure request-body unit tests can load it without a session runtime. Keep
// the accepted spellings in sync with isEnvTruthy/isEnvDefinedFalsy.
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

function envFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const value = raw.toLowerCase().trim()
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  return undefined
}

/**
 * Whether this request may carry OpenAI's `prompt_cache_key`.
 *
 * Measured against a live OpenAI-compatible gateway (5 turns, ~4K-token
 * stable prefix, everything else held constant): omitting the key dropped the
 * cumulative hit rate from **75.8% to 18.3%** — per-turn 95/0/0/0/0. Without
 * a sticky routing key each turn is free to land on a different
 * cache-bearing node, so only the very first follow-up hits. This is the
 * single largest lever on the OpenAI side, well ahead of anything about
 * request-body shape.
 *
 * Sent by default everywhere, because the endpoints that cannot take it say
 * so and are then never asked again (see {@link markPromptCacheKeyRejected}).
 * The previous default — OpenAI's own endpoint only on the chat line — meant
 * the single largest cache lever was opt-in behind an env var for exactly the
 * population that needs it most: OpenAI behind a chat gateway (LiteLLM,
 * one-api, new-api, OpenRouter). Those users silently ran at the 18.3% number
 * above unless they happened to read the docs.
 *
 * The trade for endpoints that reject unknown top-level keys (Cerebras and
 * Qwen direct, historically) is one failed request per session, after which
 * the key is suppressed for the rest of the process. Endpoints that merely
 * ignore the field — the common case across the OpenAI-compatible ecosystem —
 * pay nothing.
 *
 * `OPENAI_PROMPT_CACHE_KEY=0` forces it off outright, for a gateway that
 * neither accepts the key nor returns a recognisable rejection; `=1` forces it
 * on even after a rejection.
 */
export function canAutoDisableOpenAIPromptCacheKey(
  baseURL: string | undefined,
): boolean {
  return (
    envFlag(process.env.OPENAI_PROMPT_CACHE_KEY) !== true &&
    !isOfficialOpenAIBaseURL(baseURL)
  )
}

export function shouldSendOpenAIPromptCacheKey(
  baseURL: string | undefined,
  wireProtocol?: 'chat' | 'responses',
): boolean {
  const forced = envFlag(process.env.OPENAI_PROMPT_CACHE_KEY)
  if (forced !== undefined) return forced
  const rejected =
    wireProtocol === 'responses'
      ? responsesPromptCacheKeyRejected
      : promptCacheKeyRejected
  return !rejected || isOfficialOpenAIBaseURL(baseURL)
}

/**
 * Latched once an endpoint has rejected `prompt_cache_key`, so the rest of the
 * session stops paying a failed round trip per turn to re-learn it. Never set
 * for OpenAI's own endpoint, which documents the field.
 */
let promptCacheKeyRejected = false
let responsesPromptCacheKeyRejected = false

/**
 * Whether a failed chat request looks like the endpoint objecting to
 * `prompt_cache_key` in particular, rather than to anything else in the body.
 */
export function isPromptCacheKeyRejection(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  const lower = message.toLowerCase()
  if (!lower.includes('prompt_cache_key')) return false
  return (
    lower.includes('unknown') ||
    lower.includes('unsupported') ||
    lower.includes('unrecognized') ||
    lower.includes('not supported') ||
    lower.includes('extra') ||
    lower.includes('invalid')
  )
}

/** Suppress the key for the remainder of the process on one wire protocol. */
export function markPromptCacheKeyRejected(
  wireProtocol: 'chat' | 'responses' = 'chat',
): void {
  if (wireProtocol === 'responses') responsesPromptCacheKeyRejected = true
  else promptCacheKeyRejected = true
}

/** Test-only: undo the process-wide latches between cases. */
export function _resetPromptCacheKeySupportForTesting(): void {
  promptCacheKeyRejected = false
  responsesPromptCacheKeyRejected = false
}

/**
 * Session-sticky cache key for endpoints that accept it, or undefined when
 * the key must be withheld. See {@link shouldSendOpenAIPromptCacheKey}.
 */
export function getOpenAIPromptCacheKey(
  baseURL: string | undefined,
  sessionId: string,
  wireProtocol?: 'chat' | 'responses',
): string | undefined {
  return shouldSendOpenAIPromptCacheKey(baseURL, wireProtocol)
    ? formatOpenAIPromptCacheKey(sessionId)
    : undefined
}

/**
 * The cache key this request should carry, or undefined when the key must be
 * withheld (see {@link shouldSendOpenAIPromptCacheKey}).
 *
 * Prefers the prefix-scoped key so a fresh session lands on the node that
 * already holds an identical prefix; falls back to the session key when the
 * user pins `OPENAI_PROMPT_CACHE_KEY_SCOPE=session`, or when this request
 * carries no cacheable prefix at all (no system text and no tools — there is
 * nothing to route *to*, and one shared bucket for every such request across
 * every session would be a routing hot spot for no gain).
 */
export function resolveOpenAIPromptCacheKey(params: {
  baseURL: string | undefined
  sessionId: string
  wireProtocol?: 'chat' | 'responses'
  model: string
  messages: readonly unknown[]
  tools: readonly unknown[]
}): string | undefined {
  if (!shouldSendOpenAIPromptCacheKey(params.baseURL, params.wireProtocol)) {
    return undefined
  }
  if (getOpenAIPromptCacheKeyScope() === 'session') {
    return formatOpenAIPromptCacheKey(params.sessionId)
  }
  if (!hasCacheablePrefix(params.messages, params.tools)) {
    return formatOpenAIPromptCacheKey(params.sessionId)
  }
  return formatOpenAIPrefixCacheKey({
    model: params.model,
    messages: params.messages,
    tools: params.tools,
  })
}

function hasCacheablePrefix(
  messages: readonly unknown[],
  tools: readonly unknown[],
): boolean {
  for (const tool of tools) {
    if (toolName(tool) !== undefined) return true
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role !== 'system' && record.role !== 'developer') continue
    if (plainTextOfContent(record.content).length > 0) return true
  }
  return false
}

/**
 * Merge a delta usage into the accumulated usage, preserving cache-related
 * fields from previous values when the delta carries explicit zeroes or
 * undefined values.
 *
 * Mirrors updateUsage() in claude.ts: a future adapter change that omits
 * cache fields from certain streaming events should not silently zero the
 * accumulated counters.
 */
export function updateOpenAIUsage(
  current: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  },
  delta: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): typeof current {
  return {
    input_tokens: delta.input_tokens ?? current.input_tokens,
    output_tokens: delta.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens !== undefined &&
      delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : current.cache_creation_input_tokens,
    cache_read_input_tokens:
      delta.cache_read_input_tokens !== undefined &&
      delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : current.cache_read_input_tokens,
  }
}
