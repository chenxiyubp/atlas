// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether the Chat Completions lane carries `reasoning_effort`, and with what
 * value (P18.5 Q-1, design `providers-console-m1.md` §5.2).
 *
 * The chat lane used to send `reasoning_effort` only for
 * `isChatGPTCodexReasoningModel(model)` (`openai/index.ts`), while the
 * display, the Responses lane and the Anthropic lane all ask
 * `modelSupportsEffort()`. Two consequences, both a display/wire split:
 *
 *  - an explicit opt-in — `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`, or a tier's
 *    `*_SUPPORTED_CAPABILITIES` list naming `effort` — showed effort as on
 *    while the chat request never carried it;
 *  - an explicit opt-out (a capability list without `effort`) showed it as
 *    off while a Codex reasoning model on chat kept sending it.
 *
 * Now the chat lane asks the same `modelSupportsEffort()`. The value is still
 * the chat mapping (`getChatReasoningEffort`: xhigh / max fold to high); which
 * key each vendor wants is P18.8's vendor table (hermes #14).
 *
 * DeepSeek is the one exception, and it is not a new one: its ladder lives in
 * `requestBody.ts` (three rungs, only while thinking is on), and that code
 * never consulted the generic value for DeepSeek. Keeping it out here keeps
 * DeepSeek's chat body byte-identical — thinking off still sends no
 * `reasoning_effort`.
 */
import { getChatReasoningEffort } from 'src/services/api/openai/reasoning.js'
import { isDeepSeekTuningActiveForModel } from 'src/utils/model/deepseekTuning.js'
import { modelSupportsEffort } from 'src/utils/model/effort.js'

/**
 * The gate: does a chat request for `model` carry `reasoning_effort` at all.
 * `baseURL` is the request's endpoint (it is what makes a renamed DeepSeek
 * checkpoint DeepSeek).
 */
export function chatLaneSendsReasoningEffort(
  model: string,
  baseURL: string | undefined,
): boolean {
  if (isDeepSeekTuningActiveForModel(model, baseURL)) return false
  return modelSupportsEffort(model)
}

/**
 * The value the chat lane puts on the wire for this request, or `undefined`
 * when the key is omitted. `appliedEffort` is `resolveAppliedEffort(...)` for
 * the session-selected model — the same input the Responses lane uses.
 *
 * This is the chat half of a node's `effective.effortOnWire` (design §2.4):
 * P18.7's `status` should call it rather than re-deriving the rule.
 */
export function resolveChatReasoningEffort(
  model: string,
  appliedEffort: unknown,
  baseURL: string | undefined,
): 'low' | 'medium' | 'high' | undefined {
  return chatLaneSendsReasoningEffort(model, baseURL)
    ? getChatReasoningEffort(model, appliedEffort)
    : undefined
}

/**
 * True since P18.5: an explicit effort override (the `effort` capability, or
 * `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`) reaches the chat wire. The compiler in
 * P18.2 only accepts `effort.send = always` on the `openai-chat` lane once a
 * node reports this (design §3.4). The claim is pinned by a behavioural test
 * (`chatEffort.test.ts`), not just by this constant: if the gate above ever
 * stops consulting `modelSupportsEffort`, that test fails.
 */
export const CHAT_EFFORT_HONORS_OVERRIDE = true
