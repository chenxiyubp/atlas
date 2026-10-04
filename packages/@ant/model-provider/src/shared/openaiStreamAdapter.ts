import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { randomUUID } from 'crypto'
import {
  normalizeOpenAIUsage,
  readOpenAICachedTokens,
  readOpenAICacheWriteTokens,
} from './openaiUsage.js'
import {
  type ToolCallStep,
  ToolCallDeltaAssembler,
} from './qianmo/toolCallDeltas.js'

/**
 * Adapt an OpenAI streaming response into Anthropic BetaRawMessageStreamEvent.
 *
 * Mapping:
 *   First chunk              → message_start
 *   delta.reasoning_content  → content_block_start(thinking) + thinking_delta + content_block_stop
 *   delta.content            → content_block_start(text) + text_delta + content_block_stop
 *   delta.tool_calls         → content_block_start(tool_use) + input_json_delta + content_block_stop
 *   finish_reason            → message_delta(stop_reason) + message_stop
 *
 * Usage field mapping (OpenAI → Anthropic):
 *   prompt_tokens - cached_tokens - cache_write_tokens → input_tokens
 *   completion_tokens                         → output_tokens
 *   prompt_tokens_details.cached_tokens       → cache_read_input_tokens
 *   prompt_tokens_details.cache_write_tokens  → cache_creation_input_tokens
 *
 *   All four fields are emitted in the post-loop message_delta (not message_start)
 *   so that trailing usage chunks (sent after finish_reason by some
 *   OpenAI-compatible endpoints) are fully captured before the final counts are reported.
 *
 * Thinking support:
 *   DeepSeek and compatible providers send `delta.reasoning_content` for chain-of-thought.
 *   This is mapped to Anthropic's `thinking` content blocks:
 *     content_block_start: { type: 'thinking', thinking: '', signature: '' }
 *     content_block_delta: { type: 'thinking_delta', thinking: '...' }
 *
 * Prompt caching:
 *   OpenAI reports cached tokens in usage.prompt_tokens_details.cached_tokens.
 *   DeepSeek reports usage.prompt_cache_hit_tokens; some proxies flatten it to
 *   usage.cached_tokens. All three map to Anthropic's cache_read_input_tokens.
 */
class IncompleteOpenAIStreamError extends Error {
  readonly retryable = true

  constructor() {
    super('OpenAI-compatible stream ended before finish_reason')
    this.name = 'IncompleteOpenAIStreamError'
  }
}

/**
 * The stream ended properly and said nothing: a finish_reason arrived, but no
 * text, no tool call and no reasoning did.
 *
 * OpenAI-compatible gateways do this intermittently — HTTP 200, a clean
 * stream, finish_reason `stop`, `content_filter` or Gemini's
 * `MALFORMED_FUNCTION_CALL`. Passed through as an ordinary stop it leaves the
 * turn with no assistant message at all. Thrown before `message_delta` /
 * `message_stop`, so the retry ladder sees an attempt that committed nothing;
 * `streamAssembly.ts` retries it on its own small budget.
 *
 * Carries the finish_reason and the usage the gateway reported. There is no
 * content to carry, and nothing from the request goes in.
 */
export class EmptyModelResponseError extends Error {
  readonly retryable = true
  readonly code = 'empty_response'
  /** Reduced to a plain token: it is gateway-controlled text. */
  readonly finishReason: string
  readonly inputTokens: number
  readonly outputTokens: number

  constructor(
    finishReason: string,
    usage: { inputTokens: number; outputTokens: number },
  ) {
    const reason =
      finishReason.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown'
    super(`Model returned an empty response (finish_reason=${reason})`)
    this.name = 'EmptyModelResponseError'
    this.finishReason = reason
    this.inputTokens = usage.inputTokens
    this.outputTokens = usage.outputTokens
  }
}

export async function* adaptOpenAIStreamToAnthropic(
  stream: AsyncIterable<ChatCompletionChunk>,
  model: string,
  options?: { includeCacheWriteTokens?: boolean },
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  let started = false
  let currentContentIndex = -1

  // Track tool_use blocks: call slot (toolCallDeltas.ts) → { contentIndex, id, name, arguments }
  const toolBlocks = new Map<
    number,
    { contentIndex: number; id: string; name: string; arguments: string }
  >()

  // Track thinking block state
  let thinkingBlockOpen = false

  // Track text block state
  let textBlockOpen = false

  // Track raw OpenAI usage across chunks. The normalized Anthropic fields are
  // disjoint: ordinary input + cache reads + cache writes = total input.
  let rawInputTokens = 0
  let outputTokens = 0
  let rawCacheReadTokens = 0
  let rawCacheWriteTokens = 0
  let usage = normalizeOpenAIUsage({ totalInputTokens: 0, outputTokens: 0 })

  // Track all open content block indices (for cleanup)
  const openBlockIndices = new Set<number>()

  // Deferred finish state
  let pendingFinishReason: string | null = null
  let pendingHasToolCalls = false
  let sawOutput = false
  let sawTerminalUsageChunk = false

  // qianmo P18.5 (hermes #9): tool_use emission, unchanged except that the
  // slot, id and name come from shared/qianmo/toolCallDeltas.ts.
  const toolCallDeltas = new ToolCallDeltaAssembler(
    () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
  )
  function* emitToolCallSteps(
    steps: ToolCallStep[],
  ): Generator<BetaRawMessageStreamEvent, void> {
    for (const step of steps) {
      if (step.type === 'start') {
        // Close thinking block if open
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(currentContentIndex)
          thinkingBlockOpen = false
        }

        // Close text block if open
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(currentContentIndex)
          textBlockOpen = false
        }

        // Start new tool_use block
        currentContentIndex++
        toolBlocks.set(step.slot, {
          contentIndex: currentContentIndex,
          id: step.id,
          name: step.name,
          arguments: '',
        })
        openBlockIndices.add(currentContentIndex)

        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: {
            type: 'tool_use',
            id: step.id,
            name: step.name,
            input: {},
          },
        } as BetaRawMessageStreamEvent
        continue
      }

      // Stream argument fragments
      const block = toolBlocks.get(step.slot)!
      block.arguments += step.fragment
      yield {
        type: 'content_block_delta',
        index: block.contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: step.fragment,
        },
      } as BetaRawMessageStreamEvent
    }
  }

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta

    // Extract usage from any chunk that carries it.
    if (chunk.usage) {
      // Some OpenAI-compatible gateways close a successful stream with an
      // include_usage chunk but omit both finish_reason and [DONE]. The usage
      // chunk is terminal evidence only after actual output has been seen; an
      // empty or abruptly truncated stream must remain retryable.
      if (
        (chunk.usage.completion_tokens ?? 0) > 0 &&
        // `choices` is typed as required, but the reader above already guards
        // it with `chunk.choices?.[0]` — some gateways send the terminal usage
        // chunk with the field omitted entirely rather than as an empty array.
        // Reading `.length` off it there would throw; a missing field means the
        // same thing an empty array does here, so treat it that way.
        (chunk.choices?.length ?? 0) === 0
      ) {
        sawTerminalUsageChunk = true
      }
      rawInputTokens = chunk.usage.prompt_tokens ?? rawInputTokens
      outputTokens = chunk.usage.completion_tokens ?? outputTokens

      // Endpoints disagree on where the cached-prefix count lives; the field
      // preference order is centralized in readOpenAICachedTokens. Carried
      // forward when a chunk omits it — a trailing usage chunk that reports
      // only totals must not zero an already-seen cache read.
      const cachedTokens = readOpenAICachedTokens(chunk.usage)
      if (cachedTokens !== undefined) {
        rawCacheReadTokens = cachedTokens
      }
      if (options?.includeCacheWriteTokens) {
        rawCacheWriteTokens =
          readOpenAICacheWriteTokens(chunk.usage) ?? rawCacheWriteTokens
      } else {
        rawCacheWriteTokens = 0
      }

      usage = normalizeOpenAIUsage({
        totalInputTokens: rawInputTokens,
        outputTokens,
        cacheReadTokens: rawCacheReadTokens,
        cacheWriteTokens: rawCacheWriteTokens,
      })
    }

    // Emit message_start on first chunk
    if (!started) {
      started = true

      yield {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...usage,
            output_tokens: 0,
          },
        },
      } as unknown as BetaRawMessageStreamEvent
    }

    // Skip chunks that carry only usage data (no delta content)
    if (!delta) continue

    // Handle reasoning_content → Anthropic thinking block.
    // Empty string is a valid signal: DeepSeek v4 thinking mode sometimes
    // returns reasoning_content: "" when the model answers directly. The
    // empty thinking block must round-trip back to the API in subsequent
    // requests, otherwise DeepSeek rejects with 400.
    const reasoningContent = (delta as any).reasoning_content
    // An empty string arriving *while text is already flowing* carries no
    // information, and acting on it is expensive: the branch below closes the
    // open text block and opens a fresh empty thinking block, so a provider
    // that pairs `reasoning_content: ""` with every text chunk shreds one
    // answer into hundreds of alternating blocks. Measured through an
    // OpenAI-compatible gateway: qwen3.8-max produced 251 blocks for a
    // two-point answer (126 thinking, 125 of them empty), against 2 for
    // deepseek-v4-pro. Those blocks are persisted and replayed on every
    // subsequent request, so the cost is paid again each turn.
    //
    // The DeepSeek contract above is untouched: it is about `""` arriving
    // *before* any text, when the model answers directly. That case still
    // opens its empty thinking block and still round-trips.
    const emptyReasoningMidText =
      reasoningContent === '' && textBlockOpen && !thinkingBlockOpen
    if (reasoningContent != null && !emptyReasoningMidText) {
      // Upstream v2.46.0 added this flag: it is what lets a gateway that
      // terminates with a usage chunk instead of `finish_reason` be treated as
      // an ordinary stop rather than an incomplete stream. Setting it inside
      // the guarded branch is safe — the branch is only skipped when text is
      // already flowing, and the text handler below sets `sawOutput` before it
      // ever opens a text block, so `textBlockOpen` already implies it.
      sawOutput = true
      if (!thinkingBlockOpen) {
        // Close an open text block first, mirroring what the text and
        // tool_call handlers below already do for each other.
        //
        // DeepSeek thinking mode reasons *between* steps ("multiple turns of
        // reasoning and tool calls" — api-docs.deepseek.com/guides/thinking_mode),
        // so reasoning genuinely arrives after text has started. Without this,
        // currentContentIndex advanced to the new thinking block while
        // textBlockOpen stayed true, and the next delta.content emitted a
        // text_delta at the thinking block's index — the visible answer was
        // appended into the model's chain of thought, and the text block was
        // left open until the end-of-stream safety sweep.
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(currentContentIndex)
          textBlockOpen = false
        }

        currentContentIndex++
        thinkingBlockOpen = true
        openBlockIndices.add(currentContentIndex)

        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
            signature: '',
          },
        } as BetaRawMessageStreamEvent
      }

      if (reasoningContent !== '') {
        yield {
          type: 'content_block_delta',
          index: currentContentIndex,
          delta: {
            type: 'thinking_delta',
            thinking: reasoningContent,
          },
        } as BetaRawMessageStreamEvent
      }
    }

    // Handle text content
    if (delta.content != null && delta.content !== '') {
      sawOutput = true
      if (!textBlockOpen) {
        // Close thinking block if still open
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(currentContentIndex)
          thinkingBlockOpen = false
        }

        currentContentIndex++
        textBlockOpen = true
        openBlockIndices.add(currentContentIndex)

        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        } as BetaRawMessageStreamEvent
      }

      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: {
          type: 'text_delta',
          text: delta.content,
        },
      } as BetaRawMessageStreamEvent
    }

    // Handle tool calls. qianmo P18.5 (hermes #9): which delta belongs to
    // which call, and when a call's block may open, is decided in
    // shared/qianmo/toolCallDeltas.ts; emitToolCallSteps turns that into events.
    if (delta.tool_calls) {
      sawOutput = true
      yield* emitToolCallSteps(toolCallDeltas.accept(delta.tool_calls))
    }

    // Handle finish
    if (choice?.finish_reason) {
      // qianmo P18.5 (hermes #9): a call whose name never arrived opens now,
      // with the empty name it always had.
      yield* emitToolCallSteps(toolCallDeltas.flush())

      if (thinkingBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        openBlockIndices.delete(currentContentIndex)
        thinkingBlockOpen = false
      }

      if (textBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        openBlockIndices.delete(currentContentIndex)
        textBlockOpen = false
      }

      for (const [, block] of toolBlocks) {
        if (openBlockIndices.has(block.contentIndex)) {
          yield {
            type: 'content_block_stop',
            index: block.contentIndex,
          } as BetaRawMessageStreamEvent
          openBlockIndices.delete(block.contentIndex)
        }
      }

      pendingFinishReason = choice.finish_reason
      pendingHasToolCalls = toolBlocks.size > 0
    }
  }

  if (pendingFinishReason === null) {
    if (sawOutput && sawTerminalUsageChunk) {
      // qianmo P18.5 (hermes #9): as at finish_reason above.
      yield* emitToolCallSteps(toolCallDeltas.flush())
      // Compatibility fallback for gateways that terminate with usage instead of
      // finish_reason. Text/reasoning answers are ordinary stops; tool output is
      // still forced to tool_use by pendingHasToolCalls below.
      pendingFinishReason = 'stop'
      pendingHasToolCalls = toolBlocks.size > 0
    } else {
      throw new IncompleteOpenAIStreamError()
    }
  }

  // `length` is exempt: a zero-output truncation is a max_tokens problem and
  // has its own recovery path downstream.
  if (
    !sawOutput &&
    pendingFinishReason !== null &&
    pendingFinishReason !== 'length'
  ) {
    throw new EmptyModelResponseError(pendingFinishReason, {
      inputTokens: rawInputTokens,
      outputTokens,
    })
  }

  // Safety: close any remaining open blocks
  for (const idx of openBlockIndices) {
    yield {
      type: 'content_block_stop',
      index: idx,
    } as BetaRawMessageStreamEvent
  }

  // Emit message_delta + message_stop
  if (pendingFinishReason !== null) {
    const stopReason =
      pendingFinishReason === 'length'
        ? 'max_tokens'
        : pendingHasToolCalls
          ? 'tool_use'
          : mapFinishReason(pendingFinishReason)

    yield {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage,
    } as BetaRawMessageStreamEvent

    yield {
      type: 'message_stop',
    } as BetaRawMessageStreamEvent
  }
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason.
 */
function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}
