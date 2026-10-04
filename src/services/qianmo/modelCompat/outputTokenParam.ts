// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `max_tokens` or `max_completion_tokens` on the Chat Completions lane
 * (P18.5, hermes #11; design `providers-console-m1.md` §5.6 row 11, §5.7).
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `utils.py:871-903` `model_forces_max_completion_tokens` — the name
 *     families, matched on the id after a `vendor/` prefix;
 *   - `run_agent.py:1617-1639` `_max_tokens_param` — URL first (official
 *     OpenAI, Azure), then the name check for gateways fronting those models.
 *
 * hermes (and design §5.6 row 11): official OpenAI or Azure host → always the
 * new name; any host → the new name for gpt-4o / gpt-4.1 / gpt-5 / o1 / o3 / o4.
 *
 * Qianmo takes a subset, because base tests outside P18.5's file scope pin
 * the old name: `openai/__tests__/thinking.test.ts` ("keeps max_tokens for
 * gpt-4o on official OpenAI", "keeps max_tokens for GPT-5 on compatible
 * endpoints") and `queryModelOpenAI.runner.ts` ("official OpenAI requests
 * include max_tokens", an arbitrary `test-model` on the SDK-default host):
 *
 *   - official OpenAI or Azure host → the new name for the Codex lineage
 *     (gpt-5.x, *codex*, what the base already did), for GPT generations 6
 *     and later (hermes's "always" covers them; its name list stops at gpt-5),
 *     and for o1 / o3 / o4. Other ids there (gpt-4o, gpt-4.1, unknown) keep
 *     `max_tokens`.
 *   - any other host → the new name for o1 / o3 / o4 only. gpt-5 (and gpt-4o,
 *     gpt-4.1) on a compatible endpoint keep `max_tokens`.
 *
 * The exceptions are for the owner to rule on (P18.5 report); the design
 * itself marks the gpt-4o / gpt-4.1 half unverified (§5.10).
 *
 * o-series on any host: OpenAI rejects `max_tokens` for its reasoning models
 * with `unsupported_parameter` naming `max_completion_tokens`, and gateways
 * that front them pass the rejection through (hermes docstring above). Not
 * verified against a real endpoint (design §11 item 5).
 *
 * Not taken: hermes's GitHub Copilot host — no Copilot lane here. Prefix
 * matching is a little stricter than hermes's bare `startswith('o1')`: the
 * o-series id must be exactly `o1`/`o3`/`o4` or continue with `-`, so an
 * unrelated id that merely starts with those letters is not caught.
 */
import { isOfficialOpenAIBaseURL } from 'src/services/api/openai/openaiShared.js'
import { isCodexFamilyModel } from 'src/utils/model/chatgptModels.js'

/** hermes `utils.py:900-902`: the reasoning families of the forced list. */
const O_SERIES_PREFIXES = ['o1', 'o3', 'o4']

/** First GPT generation past the Codex lineage that `isCodexFamilyModel` names. */
const FIRST_POST_CODEX_GPT_GENERATION = 6

/** Model id after a `vendor/` prefix copied from OpenRouter-style ids. */
function bareModelId(model: string): string {
  const lower = model.trim().toLowerCase()
  const slash = lower.lastIndexOf('/')
  return slash === -1 ? lower : lower.slice(slash + 1)
}

function isAzureOpenAIBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL?.trim()) return false
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase()
    return (
      hostname === 'openai.azure.com' || hostname.endsWith('.openai.azure.com')
    )
  } catch {
    return false
  }
}

/** OpenAI's o-series reasoning models (o1, o3, o4 and their variants). */
export function isOSeriesReasoningModel(model: string): boolean {
  const bare = bareModelId(model)
  return O_SERIES_PREFIXES.some(
    prefix => bare === prefix || bare.startsWith(`${prefix}-`),
  )
}

function isPostCodexGptGeneration(model: string): boolean {
  const match = /^gpt-(\d+)(?:[.-]|$)/.exec(bareModelId(model))
  return match !== null && Number(match[1]) >= FIRST_POST_CODEX_GPT_GENERATION
}

/** Whether the chat request should name its output cap `max_completion_tokens`. */
export function usesMaxCompletionTokens(
  model: string,
  baseURL: string | undefined,
): boolean {
  if (isOSeriesReasoningModel(model)) return true
  if (!isOfficialOpenAIBaseURL(baseURL) && !isAzureOpenAIBaseURL(baseURL)) {
    return false
  }
  return isCodexFamilyModel(model) || isPostCodexGptGeneration(model)
}
