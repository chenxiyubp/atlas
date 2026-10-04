// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Output cap too large" errors: recognise them, read how much output still
 * fits, and size the one re-send (P18.5, hermes #5; design
 * `providers-console-m1.md` §5.6 row 5, §5.7).
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/model_metadata.py:1617-1737` `parse_available_output_tokens_from_error`
 *     — which wording is an output-cap error and how the available output is
 *     read: Anthropic `available_tokens`, OpenRouter/Nous "N of text input, M
 *     of tool input, K in the output", LM Studio / llama.cpp prompt size in
 *     characters (÷ 3, rounded up), vLLM prompt size in tokens, DashScope
 *     "Range of max_tokens should be [1, N]";
 *   - `agent/model_metadata.py:1740-1801` `is_output_cap_error` — the broader
 *     yes/no check for wording no number can be read from;
 *   - `agent/conversation_loop.py:5533-5555` — the re-send cap is the
 *     available output minus 64, never below 1.
 * Only the rules are taken; the code is ours.
 *
 * Why it matters (hermes issue #55546): the input already fits, only the
 * requested output does not. Read as context overflow, the session is
 * compacted, re-sent with the same cap, rejected the same way, and loops until
 * nothing is left to compact. So:
 *
 *   - `overflowText.ts` asks {@link isOutputCapError} before the overflow
 *     table, so `isContextOverflowErrorText` (and `isPromptTooLongMessage`)
 *     answers `false` for these;
 *   - the third-party retry loop (`streamAssembly.ts`) asks the lane once,
 *     before any output, whether it can shrink the cap; the OpenAI lane
 *     answers with {@link outputCapRetryTokens}.
 *
 * Differences from hermes: hermes also compacts history on this path and
 * clamps by a local token estimate (`conversation_loop.py:5541-5548`); Qianmo
 * does neither — the design asks only for "shrink the cap and re-send once"
 * (§5.6 row 5). When no number can be read, hermes stops with an actionable
 * message; here the error simply surfaces as itself (no compaction, no
 * second re-send).
 *
 * The wording is hermes's record of each vendor; none was checked against a
 * real endpoint (design §11 item 5). Not covered: OpenAI's own "max_tokens is
 * too large … supports at most N completion tokens" and the newer vLLM
 * "'max_tokens' or 'max_completion_tokens' is too large" — hermes reads no
 * number from either, so neither is re-sent (both were already not overflow).
 */

import { errorMessageTexts } from './errorMessages.js'

/** hermes `conversation_loop.py:5548`, `:5554`. */
export const OUTPUT_CAP_SAFETY_MARGIN = 64

function looksLikeOutputCapError(lower: string): boolean {
  return (
    (lower.includes('max_tokens') &&
      (lower.includes('available_tokens') ||
        lower.includes('available tokens'))) ||
    (lower.includes('in the output') &&
      lower.includes('maximum context length')) ||
    (lower.includes('maximum context length') &&
      lower.includes('requested') &&
      lower.includes('output tokens')) ||
    lower.includes('range of max_tokens should be')
  )
}

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value >= 1 ? value : undefined
}

/**
 * Output tokens the provider says would still fit, or `undefined` when the
 * text is not an output-cap error or names no usable number (hermes
 * `model_metadata.py:1617-1737`, same order of attempts).
 */
export function parseAvailableOutputTokens(raw: string): number | undefined {
  const lower = raw.toLowerCase()
  if (!looksLikeOutputCapError(lower)) return undefined

  const range =
    /range of max_tokens should be\s*\[\s*\d+\s*,\s*(\d+)\s*\]/.exec(lower)
  if (range) {
    const cap = positive(Number(range[1]))
    if (cap !== undefined) return cap
  }

  for (const pattern of [
    /available_tokens[:\s]+(\d+)/,
    /available\s+tokens[:\s]+(\d+)/,
    /=\s*(\d+)\s*$/,
  ]) {
    const match = pattern.exec(lower)
    if (match) {
      const tokens = positive(Number(match[1]))
      if (tokens !== undefined) return tokens
    }
  }

  const contextTokens = /maximum context length is (\d+)/.exec(lower)
  const parts =
    /\((\d+)\s+of text input,\s*(\d+)\s+of tool input,\s*(\d+)\s+in the output\)/.exec(
      lower,
    )
  if (contextTokens && parts) {
    const available = positive(
      Number(contextTokens[1]) - Number(parts[1]) - Number(parts[2]),
    )
    if (available !== undefined) return available
  }

  const windowTokens = /maximum context length is (\d+)\s*token/.exec(lower)
  const promptChars = /prompt contains (\d+)\s*character/.exec(lower)
  if (windowTokens && promptChars) {
    const estimatedInput = Math.floor((Number(promptChars[1]) + 2) / 3)
    const available = positive(Number(windowTokens[1]) - estimatedInput)
    if (available !== undefined) return available
  }

  const promptTokens =
    /prompt contains (?:at least )?(\d+)\s*input tokens/.exec(lower)
  if (windowTokens && promptTokens) {
    const available = positive(
      Number(windowTokens[1]) - Number(promptTokens[1]),
    )
    if (available !== undefined) return available
  }

  return undefined
}

/**
 * Wording about the output-cap parameter being too large, with no sign that
 * the input itself is too long (hermes `model_metadata.py:1740-1801`).
 */
export function isOutputCapErrorText(raw: string): boolean {
  const lower = raw.toLowerCase()
  const mentionsOutputParam =
    lower.includes('max_tokens') ||
    lower.includes('max_output_tokens') ||
    lower.includes('max_completion_tokens')
  if (!mentionsOutputParam) return false
  const outputCapSignal =
    lower.includes('range of max_tokens should be') ||
    lower.includes('available_tokens') ||
    lower.includes('available tokens') ||
    (lower.includes('in the output') &&
      lower.includes('maximum context length')) ||
    (lower.includes('requested') && lower.includes('output tokens')) ||
    lower.includes('should be') ||
    lower.includes('less than or equal') ||
    lower.includes('must be')
  if (!outputCapSignal) return false
  const inputOverflowSignal =
    lower.includes('prompt is too long') ||
    lower.includes('prompt too long') ||
    lower.includes('input is too long') ||
    lower.includes('input token') ||
    lower.includes('prompt length') ||
    lower.includes('prompt contains') ||
    lower.includes('reduce the length')
  return !inputOverflowSignal
}

/**
 * Either test says "this is about the output cap". `overflowText.ts` uses it to
 * keep these out of the context-overflow verdict.
 */
export function isOutputCapError(raw: string): boolean {
  return (
    parseAvailableOutputTokens(raw) !== undefined || isOutputCapErrorText(raw)
  )
}

/**
 * The output cap to re-send with after `error`, or `undefined` when `error` is
 * not an output-cap rejection with a readable budget, or the smaller cap would
 * not be smaller than `currentCap` (re-sending would fail the same way).
 * `currentCap` is `undefined` when the request carried no cap of its own.
 */
export function outputCapRetryTokens(
  error: unknown,
  currentCap: number | undefined,
): number | undefined {
  for (const text of errorMessageTexts(error)) {
    const available = parseAvailableOutputTokens(text)
    if (available === undefined) continue
    const next = Math.max(1, available - OUTPUT_CAP_SAFETY_MARGIN)
    if (currentCap !== undefined && next >= currentCap) return undefined
    return next
  }
  return undefined
}
