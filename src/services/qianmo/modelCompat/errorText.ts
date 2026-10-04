// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Telling an exhausted account apart from a rate limit and from an overloaded
 * server (P18.5, hermes #15; design `providers-console-m1.md` §5.6 row 15,
 * §5.7 "计费、限流、过载").
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/error_classifier.py:119-141` `_BILLING_PATTERNS`;
 *   - `agent/error_classifier.py:170-180` `_BILLING_ERROR_CODES`, read from
 *     the body's `code` / `type` (`:1891-1915` `_extract_error_code`);
 *   - `agent/error_classifier.py:219-232` `_OVERLOADED_PATTERNS` — a busy
 *     server that reuses 429 (Z.AI, `:1258-1270`) is checked first;
 *   - the rate-limit wording is `overflowText.ts`'s copy of `:183-207`.
 * Only the phrasings and codes are taken; the code is ours.
 *
 * Why: a 429 `insufficient_quota` used to be read as a rate limit (the SDK's
 * `RateLimitError` name plus the 429 status) and retried with backoff — up to
 * the whole ladder — for an account that cannot pay. Retrying never helps.
 *
 * Where: `retryClassification.ts`'s `classifyRetryableAPIError` asks
 * {@link isQuotaExhaustedError} before it reads `x-should-retry`, the status or
 * any structured signal; `true` is answered `billing_error`, never retried.
 *
 * Narrower than hermes on purpose:
 *   - only for a 429 or a failure with no HTTP status (a stream-level error
 *     event). Every other status already never retries, and leaving their
 *     category alone keeps the Anthropic lane's 400/403 handling as it was.
 *   - billing WORDING only counts when no rate-limit wording or code rides
 *     along. Gemini's free-tier per-minute quota says "You exceeded your
 *     current quota … billing details" with `RESOURCE_EXHAUSTED`, and that one
 *     does clear on retry. A billing CODE (`insufficient_quota`, …) counts on
 *     its own.
 *
 * Differs from hermes on purpose: hermes classifies every 429 before it looks
 * at billing (`:1258-1293`) and rotates the key instead; Qianmo has one key per
 * process, so the design asks for "billing, not retried" (§5.6 row 15).
 * hermes-research §11.4.2 describes hermes as checking billing on 429; its code
 * at `f9b29c49b6` does not.
 *
 * The wording is hermes's record of each vendor; none was checked against a
 * real endpoint (design §11 item 5).
 */
import { isRateLimitErrorText } from './overflowText.js'

/** hermes `error_classifier.py:119-141`. */
const BILLING_TEXT = [
  'insufficient credits',
  'insufficient_quota',
  'insufficient balance',
  'credit balance',
  'credits exhausted',
  'credits have been exhausted',
  'requires available credits',
  'account balance is too low',
  'no usable credits',
  'top up your credits',
  'payment required',
  'billing hard limit',
  'exceeded your current quota',
  'account is deactivated',
  'plan does not include',
  'out of extra usage',
  'out of funds',
  'run out of funds',
  'balance_depleted',
  'model_not_supported_on_free_tier',
  'not available on the free tier',
]

/** hermes `error_classifier.py:170-180`. */
const BILLING_ERROR_CODES = new Set([
  'insufficient_quota',
  'billing_not_active',
  'payment_required',
  'insufficient_credits',
  'no_usable_credits',
  'balance_depleted',
  'model_not_supported_on_free_tier',
  'member_spend_cap_exceeded',
  'personal-team-blocked:spending-limit',
])

/** hermes `error_classifier.py:219-232`. */
const OVERLOADED_TEXT = [
  'overloaded',
  'temporarily overloaded',
  'service is temporarily overloaded',
  'service may be temporarily overloaded',
  'server is overloaded',
  'server overloaded',
  'service overloaded',
  'service is overloaded',
  'upstream overloaded',
  'currently overloaded',
  'at capacity',
  'over capacity',
]

/** Structured codes that mean "rate limited", never "cannot pay". */
const RATE_LIMIT_CODES = new Set([
  'resource_exhausted',
  'throttled',
  'rate_limit_exceeded',
  'rate_limit_error',
])

function includesAny(lower: string, phrases: readonly string[]): boolean {
  return phrases.some(phrase => lower.includes(phrase))
}

export function isOverloadedErrorText(raw: string): boolean {
  return includesAny(raw.toLowerCase(), OVERLOADED_TEXT)
}

function isBillingErrorText(raw: string): boolean {
  return includesAny(raw.toLowerCase(), BILLING_TEXT)
}

export function isBillingErrorCode(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    BILLING_ERROR_CODES.has(code.trim().toLowerCase())
  )
}

/** `code` / `type` / `error_code` / `status` strings of every error envelope. */
function structuredCodes(
  records: readonly Record<string, unknown>[],
): string[] {
  const codes: string[] = []
  for (const record of records) {
    for (const key of ['code', 'type', 'error_code', 'status']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        codes.push(value.trim().toLowerCase())
      }
    }
  }
  return codes
}

/**
 * An account that cannot pay, reported as a 429 or without a status.
 *
 * `records` / `messages` are what `retryClassification.ts` already collected
 * (the error and its `error` / `response` / `data` / `cause` envelopes, and
 * their `message` strings); `status` is its explicit HTTP status.
 */
export function isQuotaExhaustedError(params: {
  status: number | undefined
  records: readonly Record<string, unknown>[]
  messages: readonly string[]
}): boolean {
  if (params.status !== undefined && params.status !== 429) return false
  if (params.messages.some(isOverloadedErrorText)) return false
  const codes = structuredCodes(params.records)
  if (codes.some(isBillingErrorCode)) return true
  if (!params.messages.some(isBillingErrorText)) return false
  const rateLimited =
    codes.some(code => RATE_LIMIT_CODES.has(code)) ||
    params.messages.some(isRateLimitErrorText)
  return !rateLimited
}
