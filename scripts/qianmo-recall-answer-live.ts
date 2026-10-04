// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live transport of the answer-layer executor: the AC-4 leg's request,
 * through the base's own adapter chain.
 *
 * `buildWireBody` is `askWithMemory` of `tests/integration/qianmo-memory-
 * recall.test.ts` step for step — `anthropicMessagesToOpenAI`,
 * `anthropicToolsToOpenAI`, `buildOpenAIRequestBody` (max_tokens 8192, effort
 * `low`, no sampling parameter of its own), `applyCompatRule` — so a number
 * measured here is a number about the request AC-4 sends (§4 「请求构造与
 * AC-4 腿的 askWithMemory 相同」). The one addition is the second round: the
 * model's own turn, thinking included, and the rejection as the tool result,
 * the way the AC-5 leg feeds a tool result back.
 *
 * Providers are the two of the AC-5 fixture (id, default model, compat rule).
 * The endpoint and the key come from `OPENAI_BASE_URL` / `OPENAI_API_KEY`
 * only; nothing here writes either anywhere, and the call log records the
 * provider id, never a host.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  BetaRawMessageStreamEvent,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions/completions.mjs'

import {
  adaptOpenAIStreamToAnthropic,
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  type AssistantMessage,
  asSystemPrompt,
  type UserMessage,
} from '@ant/model-provider'
import type {
  AnswerRequest,
  AnswerResponse,
  AnswerTransport,
  ToolCall,
  TokenUsage,
  Turn,
} from '../packages/recall/eval/answer/types.js'
import { MEMORY_ANSWER_TOOL } from '../packages/recall/src/tool.js'
import { getOpenAIClient } from '../src/services/api/openai/client.js'
import {
  buildOpenAIRequestBody,
  isOpenAIThinkingEnabled,
} from '../src/services/api/openai/requestBody.js'
import { applyCompatRule } from '../src/services/providerRegistry/providerCompatMatrix.js'
import {
  type ProviderConfig,
  ProvidersFileSchema,
} from '../src/services/providerRegistry/types.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The AC-5 fixture: the one definition of "the two providers". */
const PROVIDERS_FIXTURE = join(
  REPO_ROOT,
  'tests/integration/fixtures/qianmo-providers.json',
)

/** As `askWithMemory`. */
export const MAX_TOKENS = 8192

export function loadProviders(): ProviderConfig[] {
  return ProvidersFileSchema.parse(
    JSON.parse(readFileSync(PROVIDERS_FIXTURE, 'utf8')),
  )
}

type Credentials = { readonly apiKey: string; readonly baseURL: string }

/** The credentials, or why the live run is skipped (AC-4's gate, verbatim). */
export function liveCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Credentials | { readonly skip: string } {
  if (env.QIANMO_PROVIDER_LIVE === '0') {
    return { skip: 'QIANMO_PROVIDER_LIVE=0 —— 显式关闭了真调用' }
  }
  const apiKey = env.OPENAI_API_KEY
  const baseURL = env.OPENAI_BASE_URL
  if (!apiKey) return { skip: 'OPENAI_API_KEY 未设置' }
  if (!baseURL) return { skip: 'OPENAI_BASE_URL 未设置' }
  return { apiKey, baseURL }
}

const MEMORY_TOOL: BetaToolUnion = {
  name: MEMORY_ANSWER_TOOL.name,
  description: MEMORY_ANSWER_TOOL.description,
  input_schema: MEMORY_ANSWER_TOOL.inputSchema,
} as unknown as BetaToolUnion

function userText(text: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: text },
  }
}

/** Executor turns → base messages; consecutive tool results share one turn. */
function toBaseMessages(
  turns: readonly Turn[],
): (UserMessage | AssistantMessage)[] {
  const messages: (UserMessage | AssistantMessage)[] = []
  let results: Record<string, unknown>[] | null = null
  const flush = () => {
    if (results === null) return
    messages.push({
      type: 'user',
      uuid: randomUUID(),
      message: {
        role: 'user',
        content: results as unknown as UserMessage['message']['content'],
      },
    })
    results = null
  }
  for (const turn of turns) {
    if (turn.role === 'tool') {
      results ??= []
      results.push({
        type: 'tool_result',
        tool_use_id: turn.toolCallId,
        content: turn.content,
      })
      continue
    }
    flush()
    if (turn.role === 'user') {
      messages.push(userText(turn.text))
      continue
    }
    // As the AC-5 leg: the thinking block is kept, because a reasoning
    // model's echo contract depends on it.
    const content: Record<string, unknown>[] = []
    if (turn.thinking.length > 0) {
      content.push({ type: 'thinking', thinking: turn.thinking, signature: '' })
    }
    if (turn.text.length > 0) content.push({ type: 'text', text: turn.text })
    for (const call of turn.toolCalls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      })
    }
    messages.push({
      type: 'assistant',
      uuid: randomUUID(),
      message: {
        role: 'assistant',
        content: content as unknown as AssistantMessage['message']['content'],
      },
    })
  }
  flush()
  return messages
}

/** The request body as it goes on the wire, built exactly as AC-4 builds it. */
export function buildWireBody(
  provider: ProviderConfig,
  request: Pick<AnswerRequest, 'system' | 'turns'>,
  baseURL: string,
): Record<string, unknown> {
  const model = provider.defaultModel
  const enableThinking = isOpenAIThinkingEnabled(model)
  const body = buildOpenAIRequestBody({
    model,
    messages: anthropicMessagesToOpenAI(
      toBaseMessages(request.turns),
      asSystemPrompt([...request.system]),
      { enableThinking },
    ),
    tools: anthropicToolsToOpenAI([MEMORY_TOOL]),
    toolChoice: undefined,
    enableThinking,
    maxTokens: MAX_TOKENS,
    baseURL,
    effortValue: 'low',
  })
  return applyCompatRule(
    body as unknown as Record<string, unknown>,
    provider.compatRule,
  )
}

/**
 * The text of a wire body a model reads: every message and the tool
 * declarations. What the dry run counts.
 */
export function modelVisibleText(wire: Record<string, unknown>): string {
  return JSON.stringify([wire['messages'], wire['tools']])
}

/**
 * An upper bound on the input tokens of a request: its UTF-8 byte length. A
 * byte-level BPE token covers at least one byte, and the JSON punctuation of
 * the body outweighs a chat template's special tokens.
 */
export function wireByteLength(wire: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(wire), 'utf8')
}

type Observed = { model: string | null; usage: TokenUsage | null }

/** Pass the raw stream through, noting the model id and usage it reports. */
async function* observe(
  stream: AsyncIterable<ChatCompletionChunk>,
  seen: Observed,
): AsyncGenerator<ChatCompletionChunk> {
  for await (const chunk of stream) {
    if (typeof chunk.model === 'string' && chunk.model.length > 0) {
      seen.model = chunk.model
    }
    const usage = chunk.usage
    if (usage) {
      const input = usage.prompt_tokens
      const output = usage.completion_tokens
      seen.usage =
        Number.isInteger(input) && Number.isInteger(output)
          ? { input, output }
          : null
    }
    yield chunk
  }
}

/** Text, thinking and tool calls out of the adapted event stream. */
function assemble(
  events: readonly BetaRawMessageStreamEvent[],
): Pick<AnswerResponse, 'text' | 'thinking' | 'toolCalls' | 'stopReason'> {
  let text = ''
  let thinking = ''
  let stopReason: string | null = null
  const buffers = new Map<number, { id: string; name: string; args: string }>()
  const order: number[] = []
  for (const event of events) {
    if (event.type === 'content_block_start') {
      const block = event.content_block as unknown as Record<string, unknown>
      if (block['type'] === 'tool_use') {
        buffers.set(event.index, {
          id: String(block['id'] ?? ''),
          name: String(block['name'] ?? ''),
          args: '',
        })
        order.push(event.index)
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as unknown as Record<string, unknown>
      if (delta['type'] === 'text_delta') {
        text += String(delta['text'] ?? '')
      } else if (delta['type'] === 'thinking_delta') {
        thinking += String(delta['thinking'] ?? '')
      } else if (delta['type'] === 'input_json_delta') {
        const buffer = buffers.get(event.index)
        if (buffer) buffer.args += String(delta['partial_json'] ?? '')
      }
    } else if (event.type === 'message_delta') {
      const delta = event.delta as unknown as Record<string, unknown>
      if (typeof delta['stop_reason'] === 'string') {
        stopReason = delta['stop_reason']
      }
    }
  }
  const toolCalls = order.flatMap((index): ToolCall[] => {
    const buffer = buffers.get(index)
    if (buffer === undefined) return []
    let input: unknown = {}
    if (buffer.args.trim().length > 0) {
      try {
        input = JSON.parse(buffer.args)
      } catch {
        // Unparseable arguments are the model's answer, not a transport
        // failure: `parseMemoryAnswerArgs` rejects them as bad arguments.
        input = buffer.args
      }
    }
    return [{ id: buffer.id, name: buffer.name, input }]
  })
  return { text, thinking, toolCalls, stopReason }
}

export function createLiveTransport(
  provider: ProviderConfig,
  credentials: Credentials,
): AnswerTransport {
  const wireOf = (request: AnswerRequest) =>
    buildWireBody(provider, request, credentials.baseURL)
  return {
    providerId: provider.id,
    requestedModel: provider.defaultModel,
    maxOutputTokens: MAX_TOKENS,
    inputUpperBound: request => wireByteLength(wireOf(request)),
    send: async request => {
      const client = getOpenAIClient({
        apiKeyOverride: credentials.apiKey,
        baseURLOverride: credentials.baseURL,
      })
      const stream = await client.chat.completions.create(
        wireOf(request) as unknown as ChatCompletionCreateParamsStreaming,
      )
      const seen: Observed = { model: null, usage: null }
      const events: BetaRawMessageStreamEvent[] = []
      for await (const event of adaptOpenAIStreamToAnthropic(
        observe(stream, seen),
        provider.defaultModel,
      )) {
        events.push(event)
      }
      return { ...assemble(events), model: seen.model, usage: seen.usage }
    },
  }
}
