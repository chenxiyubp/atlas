// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether the Chat Completions request carries an output cap at all, and
 * which (P18.5, hermes #3; design `providers-console-m1.md` §5.6 row 3, §3.2
 * `maxOutputTokens`, §12 "#3 的回退风险").
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/transports/chat_completions.py:733-763` — the order: a re-send
 *     cap, then the user's value, then the provider profile's default, then
 *     the Claude/MiniMax/Qwen3 cap; with none of them, no cap is sent;
 *   - `agent/chat_completion_helpers.py:1993-2013` — the Claude/MiniMax/Qwen3
 *     cap is gated on the model name, not the URL: proxies omitting it
 *     "default as low as 4096 output tokens";
 *   - `providers/base.py:96`, `:183-195` — a profile's default is `None`
 *     unless it says otherwise;
 *   - `plugins/model-providers/custom/__init__.py:96-100` — the catch-all
 *     profile for any user-configured endpoint (Ollama, vLLM, llama.cpp, …)
 *     DOES send a default: without it Ollama falls back to `num_predict=128`
 *     (hermes #39281);
 *   - `plugins/model-providers/kimi-coding/__init__.py:119-136` (32000),
 *     `nvidia/__init__.py:17-18` (16384), `meta-ai/__init__.py:25-26,109`
 *     (16384), `qwen-oauth/__init__.py:103-105` (65536) — profile defaults;
 *   - `agent/model_metadata.py:686-737` `_URL_TO_PROVIDER` plus each profile's
 *     `base_url` — which hostnames are a named provider and not "custom".
 * Only the facts are taken; the code is ours.
 *
 * Qianmo has no provider profile, only `OPENAI_BASE_URL`, so the profile is
 * read off the host. The decision for the chat lane:
 *
 *   1. an explicit value — `options.maxOutputTokensOverride`,
 *      `OPENAI_MAX_TOKENS` (the console catalog's `maxOutputTokens` compiles
 *      here), `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — is sent, as before;
 *   2. a host whose hermes profile has a default sends that default;
 *   3. a model Qianmo's own table knows (`getModelMaxOutputTokens` returns
 *      something other than its generic fallback) sends that, as before;
 *   4. a Claude / MiniMax / Qwen3 name sends the same value as before;
 *   5. a named provider host with no default sends NOTHING — this is the
 *      behaviour change: OpenAI, Zhipu, DeepSeek, OpenRouter, … pick their
 *      own cap for a model Qianmo knows nothing about;
 *   6. any other host (local runtimes, LAN servers, gateways, 方舟 …) sends
 *      the same value as before.
 *
 * Differences from the design, on purpose (P18.5 report): the design reads
 * "unknown models: not sent". hermes's own code sends a default to every
 * endpoint it does not recognise (the `custom` profile), and Qianmo's vendor
 * research records a 4k default when 方舟 receives no cap; omitting it there
 * would truncate. So step 6 keeps today's value, and step 5 is where unknown
 * models stop sending. Values in steps 3, 4 and 6 stay Qianmo's own (hermes
 * would send 65536 for `custom`, 131072 for MiniMax); only the host defaults
 * of step 2 are hermes's numbers.
 *
 * The Responses lane is untouched (`max_output_tokens` as before — the fleet's
 * gpt-6-luna path is pinned in `requestParity.test.ts`). Server-side defaults
 * of the step-5 hosts were not checked against real endpoints (design §11
 * item 5); hermes runs them this way.
 */
import { resolveOpenAIMaxTokens } from 'src/services/api/openai/requestBody.js'
import type { OpenAIWireProtocol } from 'src/services/api/openai/wireProtocol.js'
import { getModelMaxOutputTokens } from 'src/utils/session/context.js'

/**
 * `getModelMaxOutputTokens`'s generic fallback (`context.ts:37-38`,
 * `MAX_OUTPUT_TOKENS_DEFAULT` / `MAX_OUTPUT_TOKENS_UPPER_LIMIT`, not
 * exported). A test pins that an unknown id still returns exactly this pair.
 */
export const GENERIC_OUTPUT_TOKENS_FALLBACK = {
  default: 32_000,
  upperLimit: 64_000,
} as const

/** hermes profile defaults, by hostname. */
const HOST_DEFAULT_MAX_TOKENS: readonly (readonly [string, number])[] = [
  ['api.moonshot.ai', 32_000],
  ['api.moonshot.cn', 32_000],
  ['api.kimi.com', 32_000],
  ['integrate.api.nvidia.com', 16_384],
  ['api.meta.ai', 16_384],
  ['portal.qwen.ai', 65_536],
]

/**
 * Named providers whose hermes profile has no default (`_URL_TO_PROVIDER` and
 * profile `base_url`s). Left out on purpose: `api.anthropic.com` and MiniMax
 * (their profiles speak Messages, which requires a cap), Gemini (hermes uses
 * its native adapter there, default 65535), `opencode.ai` (per-model hook;
 * Qianmo has its own OpenCode lane), GitHub Copilot (no such lane here).
 */
const NAMED_HOSTS_WITHOUT_DEFAULT: readonly string[] = [
  'api.openai.com',
  'api.z.ai',
  'open.bigmodel.cn',
  'api.deepseek.com',
  'openrouter.ai',
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'api.stepfun.ai',
  'api.stepfun.com',
  'api.arcee.ai',
  'inference-api.nousresearch.com',
  'api.fireworks.ai',
  'api.x.ai',
  'xiaomimimo.com',
  'api.gmi-serving.com',
  'api.novita.ai',
  'tokenhub.tencentmaas.com',
  'ollama.com',
  'ai-gateway.vercel.sh',
  'api.kilo.ai',
  'router.huggingface.co',
  'api.deepinfra.com',
  'api.upstage.ai',
]

/** hermes `_ANTHROPIC_OUTPUT_LIMITS` name families (`anthropic_adapter.py:146-179`). */
const NAME_FAMILIES_THAT_NEED_A_CAP = ['claude', 'minimax', 'qwen3']

/** The SDK default when `OPENAI_BASE_URL` is unset. */
const SDK_DEFAULT_HOST = 'api.openai.com'

function hostOf(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim()
  if (!trimmed) return SDK_DEFAULT_HOST
  try {
    const raw = trimmed.includes('://') ? trimmed : `//${trimmed}`
    const host = new URL(raw, 'https://placeholder.invalid').hostname
    return host.toLowerCase().replace(/\.$/, '') || undefined
  } catch {
    return undefined
  }
}

/** Exact hostname or a dot-suffix subdomain of it — never a substring. */
function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

/** hermes profile default for this base URL; `undefined` when it has none. */
export function hostDefaultMaxTokens(
  baseURL: string | undefined,
): number | undefined {
  const host = hostOf(baseURL)
  if (!host) return undefined
  return HOST_DEFAULT_MAX_TOKENS.find(([domain]) =>
    hostMatches(host, domain),
  )?.[1]
}

/** A named provider that picks its own cap when the request has none. */
export function isNamedHostWithoutDefault(
  baseURL: string | undefined,
): boolean {
  const host = hostOf(baseURL)
  if (!host) return false
  return NAMED_HOSTS_WITHOUT_DEFAULT.some(domain => hostMatches(host, domain))
}

function hasExplicitMaxTokens(maxOutputTokensOverride?: number): boolean {
  // Same sources and parsing as resolveOpenAIMaxTokens (requestBody.ts).
  return (
    maxOutputTokensOverride !== undefined ||
    Boolean(Number.parseInt(process.env.OPENAI_MAX_TOKENS ?? '', 10)) ||
    Boolean(
      Number.parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '', 10),
    )
  )
}

function isKnownToQianmo(model: string): boolean {
  const known = getModelMaxOutputTokens(model)
  return (
    known.default !== GENERIC_OUTPUT_TOKENS_FALLBACK.default ||
    known.upperLimit !== GENERIC_OUTPUT_TOKENS_FALLBACK.upperLimit
  )
}

function isNameFamilyThatNeedsACap(model: string): boolean {
  const lower = model.toLowerCase()
  return NAME_FAMILIES_THAT_NEED_A_CAP.some(family => lower.includes(family))
}

/**
 * The output cap this request sends, or `undefined` to send none. Drop-in for
 * `resolveOpenAIMaxTokens(upperLimit, maxOutputTokensOverride)`: the Responses
 * lane and every "send" branch return exactly what that returns.
 */
export function resolveOpenAIRequestMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride: number | undefined,
  request: {
    wireProtocol: OpenAIWireProtocol
    model: string
    baseURL: string | undefined
  },
): number | undefined {
  const asBefore = resolveOpenAIMaxTokens(upperLimit, maxOutputTokensOverride)
  if (request.wireProtocol !== 'chat') return asBefore
  if (hasExplicitMaxTokens(maxOutputTokensOverride)) return asBefore
  const hostDefault = hostDefaultMaxTokens(request.baseURL)
  if (hostDefault !== undefined) return hostDefault
  if (isKnownToQianmo(request.model)) return asBefore
  if (isNameFamilyThatNeedsACap(request.model)) return asBefore
  if (isNamedHostWithoutDefault(request.baseURL)) return undefined
  return asBefore
}
