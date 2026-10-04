// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hosts that mandate a wire protocol (P18.5, hermes #22; design
 * `providers-console-m1.md` §5.6 row 22, §5.7 "必须走 Responses 的主机和模型").
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `hermes_cli/providers.py:614-657` `host_mandated_api_mode` — the host
 *     table and the exact-hostname / dot-suffix matching rule (#32243: never
 *     substring, so `api.openai.com.attacker.test` and
 *     `proxy.test/api.openai.com/v1` do not match); an empty base URL mandates
 *     nothing (`:633-634`).
 *   - `hermes_cli/models.py:4436-4479` `azure_foundry_model_api_mode` — the
 *     Azure model families that only accept the Responses API.
 *
 * Only facts are taken (which host, which lane); the code is ours.
 *
 * Where this is consulted: `resolveOpenAIWireProtocol` (openai/wireProtocol.ts)
 * AFTER an explicit `OPENAI_WIRE_API` — hermes applies its mandate last and
 * lets it override an explicit choice; Qianmo keeps the user's explicit lane
 * (design §5.6 row 22), so `OPENAI_WIRE_API=chat` against api.openai.com still
 * goes to chat.
 *
 * Two of hermes's mandates name a lane this module can only report, not act
 * on: an Anthropic-compatible shim speaks Messages, and the OpenAI lane cannot
 * switch protocol family from inside `resolveOpenAIWireProtocol`. They are in
 * the table so a node's `status` (P18.7) can say "this base URL wants the
 * Anthropic lane" instead of silently 400-ing; the wire resolver ignores them.
 *
 * Not taken: hermes's Bedrock mandate (`bedrock_converse`) — no such lane here.
 *
 * Unverified (design §11 item 5, hermes-research §11.10): hermes contradicts
 * itself on Azure — `run_agent.py:1348-1362` says Azure OpenAI "does NOT
 * support the Responses API", `models.py:4436-4443` records a 400 "The
 * requested operation is unsupported." from /chat/completions on Azure
 * `gpt-5.3-codex`. This table follows the latter (the one with an incident)
 * and only for the model families it names; GPT-4-era deployments stay on chat.
 */

type MandatedLane = 'responses' | 'chat' | 'anthropic-messages'

/** hermes `models.py:4444-4450` `_AZURE_FOUNDRY_RESPONSES_PREFIXES`. */
const AZURE_RESPONSES_MODEL_PREFIXES = ['codex', 'gpt-5', 'o1', 'o3', 'o4']

function baseURLHostname(baseURL: string): string | undefined {
  try {
    const raw = baseURL.includes('://') ? baseURL : `//${baseURL}`
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

/** Model id after a `vendor/` prefix copied from OpenRouter-style ids. */
function bareModelId(model: string): string {
  const lower = model.trim().toLowerCase()
  const slash = lower.lastIndexOf('/')
  return slash === -1 ? lower : lower.slice(slash + 1)
}

/**
 * The lane `baseURL` requires for `model`, or `undefined` when the host has no
 * mandate. `model` only matters for Azure.
 */
export function hostMandatedLane(
  baseURL: string | undefined,
  model?: string,
): MandatedLane | undefined {
  const trimmed = baseURL?.trim()
  if (!trimmed) return undefined
  const hostname = baseURLHostname(trimmed)
  if (!hostname) return undefined
  const urlLower = trimmed.replace(/\/+$/, '').toLowerCase()

  // Kimi's /coding endpoint and Anthropic itself (or any `…/anthropic`
  // mount) speak native Messages — providers.py:640-643.
  if (hostname === 'api.kimi.com' && urlLower.includes('/coding')) {
    return 'anthropic-messages'
  }
  if (hostname === 'api.anthropic.com' || urlLower.endsWith('/anthropic')) {
    return 'anthropic-messages'
  }
  // Official OpenAI, canonical and regional (`us.` / `eu.`): reasoning models
  // with tools are Responses-only there — providers.py:644-649.
  if (hostMatches(hostname, 'api.openai.com')) return 'responses'
  // Meta Model API: prompt-cache hits only on /responses — providers.py:650-654.
  if (hostname === 'api.meta.ai') return 'responses'
  // Azure: per model family — models.py:4436-4479.
  if (hostMatches(hostname, 'openai.azure.com') && model !== undefined) {
    const bare = bareModelId(model)
    if (
      AZURE_RESPONSES_MODEL_PREFIXES.some(prefix => bare.startsWith(prefix))
    ) {
      return 'responses'
    }
  }
  return undefined
}
