// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Context-overflow wording, and the wording that must never count as overflow
 * (P18.5, hermes #6; design `providers-console-m1.md` §5.6 row 6, §5.7).
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/error_classifier.py:312-356` `_CONTEXT_OVERFLOW_PATTERNS` — the
 *     overflow phrasings (vLLM, Ollama, llama.cpp, Z.AI, Bedrock, Together,
 *     Chinese providers);
 *   - `agent/error_classifier.py:183-207` `_RATE_LIMIT_PATTERNS` — checked
 *     first, so a throttle that says "Too many tokens, please wait" backs off
 *     instead of compacting a healthy session (`:200-206`);
 *   - `agent/error_classifier.py:453-460` `_REQUEST_VALIDATION_PATTERNS` and
 *     the guard at `:1476-1502` — an unsupported-parameter 400 is a request
 *     shape problem that compaction cannot fix.
 * Only the phrasings are taken; the code is ours.
 *
 * `errors.ts`'s `isContextOverflowErrorText` consults {@link overflowTextVerdict}
 * at its entry. The base regex (`CONTEXT_OVERFLOW_ERROR_PATTERN`) still
 * decides whatever this returns `undefined` for. Order: rate limit → request
 * validation → output cap (`outputCap.ts`, hermes #5) → overflow table.
 *
 * Differences from hermes, on purpose:
 *
 *   - hermes matches its overflow list only after it knows the HTTP status
 *     (400 / 413 / 500 / 503) or has ruled out billing, rate limit and empty
 *     responses. `isContextOverflowErrorText` has no status — it runs on any
 *     API error text — so four of hermes's bare phrases are NOT taken, because
 *     without a status they also describe other failures: `max_tokens` (an
 *     unsupported-parameter or output-cap error names it; hermes keeps it only
 *     to feed its output-cap retry, which is `outputCap.ts` here), `input
 *     token` ("input tokens per minute"), `token limit` (daily/usage token
 *     limits), `exceeds the limit` (file and image size limits). The narrower
 *     neighbours of each (`max input token`, `exceeds the maximum number of
 *     input tokens`, the base regex's Gemini `input token count … exceeds`)
 *     are kept. This follows the rule already written above the base regex:
 *     only phrasing that can *only* mean context overflow.
 *   - Qianmo adds `please wait` / `wait before trying again` to the rate-limit
 *     side. hermes's own example (`:200-203`) only escapes the overflow list
 *     through its `throttling` prefix; an adapter that drops the prefix and
 *     keeps "Too many tokens, please wait before trying again." would still be
 *     read as overflow (hermes-research §11.4.4 guard 1).
 *
 * The phrasings are hermes's records plus vendor wording quoted in its
 * comments; none was checked against a real endpoint (design §11 item 5).
 */
import { isOutputCapError } from './outputCap.js'

/** hermes `error_classifier.py:183-207`. */
const RATE_LIMIT_TEXT = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'throttled',
  'requests per minute',
  'tokens per minute',
  'requests per day',
  'try again in',
  'please retry after',
  'resource_exhausted',
  'rate increased too quickly',
  'throttlingexception',
  'too many concurrent requests',
  'servicequotaexceededexception',
  'throttling',
]

/** Qianmo addition — see the header. */
const THROTTLE_WAIT_TEXT = ['please wait', 'wait before trying again']

/**
 * hermes `error_classifier.py:453-460`, minus `invalid_request_error`, which
 * OpenAI also stamps on genuine overflow 400s (hermes leaves it out of the
 * guard for the same reason, `:1491-1494`).
 */
const REQUEST_VALIDATION_TEXT = [
  'unknown parameter',
  'unsupported parameter',
  'unrecognized request argument',
  'unknown_parameter',
  'unsupported_parameter',
]

/**
 * hermes `error_classifier.py:312-356`, minus `max_tokens`, `input token`,
 * `token limit`, `exceeds the limit` (see the header). Duplicates dropped.
 */
const OVERFLOW_TEXT = [
  // generic
  'context length',
  'context size',
  'maximum context',
  'too many tokens',
  'reduce the length',
  'context window',
  'prompt is too long',
  'prompt exceeds max length',
  'maximum number of tokens',
  // vLLM / local inference servers
  'exceeds the max_model_len',
  'max_model_len',
  'prompt length',
  'input is too long',
  'maximum model length',
  // Ollama
  'context length exceeded',
  'truncating input',
  // llama.cpp / llama-server
  'slot context',
  'n_ctx_slot',
  // Chinese providers
  '超过最大长度',
  '上下文长度',
  // Z.AI / Zhipu GLM (error code 1210)
  'tokens in request more than max tokens allowed',
  // AWS Bedrock Converse
  'max input token',
  'exceeds the maximum number of input tokens',
  // Together / Fireworks
  'maximum allowed input length',
]

function includesAny(lower: string, phrases: readonly string[]): boolean {
  return phrases.some(phrase => lower.includes(phrase))
}

/** Rate-limit or throttle wording (hermes's list plus the Qianmo wait rule). */
export function isRateLimitErrorText(raw: string): boolean {
  const lower = raw.toLowerCase()
  return (
    includesAny(lower, RATE_LIMIT_TEXT) ||
    includesAny(lower, THROTTLE_WAIT_TEXT)
  )
}

/**
 * `false` — this text must not count as context overflow, whatever else it
 * says; `true` — hermes's overflow table names it; `undefined` — no opinion,
 * let the base regex decide.
 */
export function overflowTextVerdict(raw: string): boolean | undefined {
  const lower = raw.toLowerCase()
  if (isRateLimitErrorText(lower)) return false
  if (includesAny(lower, REQUEST_VALIDATION_TEXT)) return false
  // The input fits; only the requested output does not (outputCap.ts).
  if (isOutputCapError(lower)) return false
  if (includesAny(lower, OVERFLOW_TEXT)) return true
  return undefined
}
