// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Models that must not receive a `temperature` on the Chat Completions lane
 * (P18.5, hermes #12; design `providers-console-m1.md` §5.6 row 12).
 *
 * The main loop never sends one; side queries (hooks, skill improvement) pass
 * `temperatureOverride: 0`, and the chat lane forwarded it whenever thinking
 * was off — to reasoning models that only accept their default
 * (hermes-research §11.9-②: o3 and kimi-k3 side queries carried
 * `temperature: 0`).
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/auxiliary_client.py:604-616` `OMIT_TEMPERATURE` /
 *     `_is_kimi_model` — Kimi / Moonshot pick the temperature server-side
 *     (thinking 1.0, non-thinking 0.6), so no value is sent, not even a
 *     "right" one; the id is matched after a `vendor/` prefix;
 *   - `plugins/model-providers/kimi-coding/__init__.py:119-136` — the Kimi
 *     hosts omit it for every model (`fixed_temperature=OMIT_TEMPERATURE`);
 *   - `agent/transports/chat_completions.py:711-720` — how the omission is
 *     applied.
 * Only the facts are taken; the code is ours.
 *
 * Qianmo additions, from the design (§5.6 row 12): OpenAI's o-series and
 * GPT generation 5 and later — reasoning models that only accept the default
 * temperature. hermes covers those reactively (strip the field after the
 * rejection, `auxiliary_client.py:4275-4306`, see `unsupportedParam.ts`); this
 * module avoids the failed request. Not checked against a real endpoint
 * (design §11 item 5, hermes-research §11.10 item 3).
 *
 * Thinking-enabled requests already never carried `temperature`
 * (`requestBody.ts`), and DeepSeek keeps its own coding temperature (#30).
 */
import { isOSeriesReasoningModel } from './outputTokenParam.js'

/** hermes `kimi-coding/__init__.py:119`, `:134`; `model_metadata.py:692-694`. */
const KIMI_HOSTS = ['api.moonshot.ai', 'api.moonshot.cn', 'api.kimi.com']

/** First GPT generation that is a reasoning model on OpenAI's chat endpoint. */
const FIRST_REASONING_GPT_GENERATION = 5

function bareModelId(model: string): string {
  const lower = model.trim().toLowerCase()
  const slash = lower.lastIndexOf('/')
  return slash === -1 ? lower : lower.slice(slash + 1)
}

function hostMatches(baseURL: string | undefined, domains: string[]): boolean {
  if (!baseURL?.trim()) return false
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return domains.some(
      domain => host === domain || host.endsWith(`.${domain}`),
    )
  } catch {
    return false
  }
}

/** hermes `auxiliary_client.py:613-616`. */
export function isKimiModel(model: string): boolean {
  const bare = bareModelId(model)
  return bare === 'kimi' || bare.startsWith('kimi-')
}

function isReasoningGptGeneration(model: string): boolean {
  const match = /^gpt-(\d+)(?:[.-]|$)/.exec(bareModelId(model))
  return match !== null && Number(match[1]) >= FIRST_REASONING_GPT_GENERATION
}

/** Whether a chat request to `model` at `baseURL` must leave `temperature` out. */
export function omitsSamplingTemperature(
  model: string,
  baseURL: string | undefined,
): boolean {
  return (
    isOSeriesReasoningModel(model) ||
    isReasoningGptGeneration(model) ||
    isKimiModel(model) ||
    hostMatches(baseURL, KIMI_HOSTS)
  )
}
