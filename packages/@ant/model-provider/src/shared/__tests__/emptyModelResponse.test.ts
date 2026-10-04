// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A completion that ends properly but says nothing must not look like an
 * ordinary stop.
 *
 * An OpenAI-compatible gateway occasionally answers HTTP 200, closes the
 * stream with a finish_reason, and sends no text and no tool call. The six
 * shapes below are the ones reproduced against the beta fleet's build on
 * 2026-09-27; all six used to leave the turn without an assistant message.
 * The adapter now raises a retryable error for them *before* message_delta /
 * message_stop, so the retry ladder in `streamAssembly.ts` can ask again while
 * nothing has been shown yet.
 *
 * `length` is the one finish_reason exempt from this: a zero-output
 * truncation is a max_tokens problem with its own recovery path.
 */

import { describe, expect, test } from 'bun:test'
import { adaptOpenAIStreamToAnthropic } from '../openaiStreamAdapter.js'

type Chunk = Record<string, unknown>

const USAGE = { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 }

function chunk(
  delta: Record<string, unknown> | null,
  finish: string | null = null,
  usage?: Record<string, number>,
): Chunk {
  return {
    id: 'chatcmpl-empty',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3.8-flash-high',
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

const usageOnly = chunk(null, null, USAGE)

/** The six zero-output shapes from the fleet reproduction (repro/fake_openai.py). */
const EMPTY_SHAPES: ReadonlyArray<{
  readonly name: string
  readonly finishReason: string
  readonly chunks: Chunk[]
}> = [
  {
    name: 'role chunk, then finish_reason stop, then usage',
    finishReason: 'stop',
    chunks: [chunk({ role: 'assistant' }), chunk({}, 'stop'), usageOnly],
  },
  {
    name: 'finish_reason stop without a usage chunk',
    finishReason: 'stop',
    chunks: [chunk({ role: 'assistant' }), chunk({}, 'stop')],
  },
  {
    name: 'content null on the finishing chunk',
    finishReason: 'stop',
    chunks: [chunk({ role: 'assistant', content: null }, 'stop'), usageOnly],
  },
  {
    name: 'content empty string on the finishing chunk',
    finishReason: 'stop',
    chunks: [chunk({ role: 'assistant', content: '' }, 'stop'), usageOnly],
  },
  {
    name: 'Gemini MALFORMED_FUNCTION_CALL with nothing else',
    finishReason: 'MALFORMED_FUNCTION_CALL',
    chunks: [
      chunk({ role: 'assistant' }),
      chunk({}, 'MALFORMED_FUNCTION_CALL'),
      usageOnly,
    ],
  },
  {
    name: 'content_filter with nothing else',
    finishReason: 'content_filter',
    chunks: [chunk({ role: 'assistant' }, 'content_filter'), usageOnly],
  },
]

async function* stream(chunks: Chunk[]): AsyncGenerator<unknown> {
  for (const c of chunks) yield c
}

async function run(
  chunks: Chunk[],
): Promise<{ events: Array<{ type: string }>; error: unknown }> {
  const events: Array<{ type: string }> = []
  try {
    for await (const event of adaptOpenAIStreamToAnthropic(
      stream(chunks) as never,
      'gemini-3.8-flash-high',
    )) {
      events.push(event as { type: string })
    }
    return { events, error: undefined }
  } catch (error) {
    return { events, error }
  }
}

describe('zero-output completions', () => {
  for (const shape of EMPTY_SHAPES) {
    test(`${shape.name} is a retryable empty response`, async () => {
      const { events, error } = await run(shape.chunks)

      expect(error).toMatchObject({
        name: 'EmptyModelResponseError',
        retryable: true,
        code: 'empty_response',
        finishReason: shape.finishReason,
      })
      expect((error as Error).message).toBe(
        `Model returned an empty response (finish_reason=${shape.finishReason})`,
      )
      // Raised before the stop events: the retry ladder must still see an
      // attempt that committed nothing, and no consumer may assemble a
      // finished message out of it.
      expect(events.map(event => event.type)).toEqual(['message_start'])
    })
  }

  test('carries the usage the gateway reported, and nothing else', async () => {
    const { error } = await run(EMPTY_SHAPES[0]!.chunks)
    expect(error).toMatchObject({ inputTokens: 1000, outputTokens: 0 })
  })

  test('a gateway-supplied finish_reason is reduced to a plain token', async () => {
    const { error } = await run([
      chunk({ role: 'assistant' }),
      chunk({}, 'weird reason\nwith "quotes" and a very long tail'.repeat(4)),
    ])
    const finishReason = (error as { finishReason: string }).finishReason
    expect(finishReason).toMatch(/^[A-Za-z0-9_.-]{1,64}$/)
  })

  test('finish_reason length with no output keeps the max_tokens path', async () => {
    const { events, error } = await run([
      chunk({ role: 'assistant' }),
      chunk({}, 'length'),
      usageOnly,
    ])
    expect(error).toBeUndefined()
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
    })
    expect(events.at(-1)?.type).toBe('message_stop')
  })

  test('a reasoning-only answer is output and still ends normally', async () => {
    const { events, error } = await run([
      chunk({ role: 'assistant', reasoning_content: 'thinking...' }),
      chunk({}, 'stop'),
      usageOnly,
    ])
    expect(error).toBeUndefined()
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    })
  })

  test('a tool call without text is output and still ends normally', async () => {
    const { events, error } = await run([
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'Bash', arguments: '{"command":"df -P /"}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      usageOnly,
    ])
    expect(error).toBeUndefined()
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    })
  })
})
