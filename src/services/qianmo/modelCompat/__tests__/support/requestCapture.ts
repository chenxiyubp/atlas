// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recording stub for the OpenAI-compatible lane (design §5.9 item 2, §8.2).
 *
 * Drives the REAL `queryModelOpenAI` — wire selection, effort gate, output
 * cap, sampling parameters, body builders — and captures what it would have
 * put on the wire through `options.fetchOverride`. Nothing leaves the
 * process: the override answers every request with a constructed SSE body,
 * and the API key is a canary that no vendor would accept.
 *
 * Why not unit-compose the pieces: the parity table is supposed to be the
 * executable form of "display = node computation = request body" (AC-P4). A
 * table that re-implements index.ts's wiring would keep passing after
 * index.ts changed — exactly the failure it exists to catch.
 *
 * Callers own the settings mock (getInitialSettings → `{}`), so the lane comes
 * from the env this helper sets and not from the developer's settings.json.
 */
import { queryModelOpenAI } from 'src/services/api/openai/index.js'
import type { Options } from 'src/services/api/claude.js'
import type { SystemPrompt } from 'src/utils/session/systemPromptType.js'

const CANARY_API_KEY = 'sk-test-canary-p185-not-a-real-key'

/**
 * Every env key that can steer the body this helper captures. All of them are
 * cleared before a row applies its own, so rows cannot leak into each other
 * and a developer's shell cannot leak into any row.
 */
const OPENAI_LANE_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENAI_AUTH_MODE',
  'OPENAI_ENABLE_THINKING',
  'OPENAI_MAX_TOKENS',
  'OPENAI_VERBOSITY',
  'OPENAI_REASONING_SUMMARY',
  'OPENAI_PROMPT_CACHE_KEY',
  'OPENAI_PROMPT_CACHE_KEY_SCOPE',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'DEEPSEEK_TEMPERATURE',
  'OPENCODE_MODEL',
  'OPENCODE_API_KEY',
  'OPENCODE_AUTH_MODE',
  'OPENCODE_WIRE_API',
  'OPENCODE_BASE_URL',
  'OPENCODE_INFERENCE_PLANE',
  'ENABLE_SEARCH_EXTRA_TOOLS',
] as const

const CHAT_SSE =
  'data: {"id":"chatcmpl-p185","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-p185","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

const RESPONSES_SSE =
  'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
  'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'

type CapturedRequest = {
  url: string
  body: Record<string, unknown>
}

export type CaptureParams = {
  /** Session model as the query pipeline hands it over (options.model). */
  model: string
  /** OPENAI_BASE_URL; `undefined` leaves it unset (SDK default). */
  baseURL?: string
  /** Every other env key this row needs. `undefined` values are deleted. */
  env?: Record<string, string | undefined>
  /** options.effortValue — the in-session `/effort` value. */
  effortValue?: Options['effortValue']
  /** options.temperatureOverride — side queries (hooks) pass 0. */
  temperatureOverride?: number
  /** options.maxOutputTokensOverride — programmatic cap. */
  maxOutputTokensOverride?: number
  /**
   * Answer the first N requests with this error instead of a stream. Lets a
   * row exercise the request-level fallbacks without a network.
   */
  failFirst?: { status: number; body: unknown }[]
}

/**
 * Run one request through `queryModelOpenAI` and return every request the
 * lane put on the wire (more than one when a fallback re-sends).
 */
export async function captureOpenAIRequests(
  params: CaptureParams,
): Promise<CapturedRequest[]> {
  const saved = new Map<string, string | undefined>()
  for (const key of OPENAI_LANE_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  const rowEnv: Record<string, string | undefined> = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: CANARY_API_KEY,
    OPENAI_BASE_URL: params.baseURL,
    ...params.env,
  }
  for (const [key, value] of Object.entries(rowEnv)) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  const failures = [...(params.failFirst ?? [])]
  const captured: CapturedRequest[] = []
  const fetchOverride = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    const failure = failures.shift()
    if (failure) {
      return new Response(JSON.stringify(failure.body), {
        status: failure.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(url.endsWith('/responses') ? RESPONSES_SSE : CHAT_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const options = {
    model: params.model,
    querySource: 'main_loop',
    agents: [],
    allowedAgentTypes: [],
    getToolPermissionContext: async () => ({
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }),
    fetchOverride,
    effortValue: params.effortValue,
    temperatureOverride: params.temperatureOverride,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
  } as unknown as Options

  try {
    const signal = new AbortController().signal
    for await (const _ of queryModelOpenAI(
      [],
      [] as unknown as SystemPrompt,
      [],
      signal,
      options,
    )) {
      // drain
    }
    return captured
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The single request of a row that is expected not to re-send. */
export async function captureOpenAIRequest(
  params: CaptureParams,
): Promise<CapturedRequest> {
  const all = await captureOpenAIRequests(params)
  if (all.length !== 1) {
    throw new Error(`expected exactly one request, got ${all.length}`)
  }
  return all[0]!
}
