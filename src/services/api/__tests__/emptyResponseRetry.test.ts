// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retry ladder's handling of an empty model response, driven through the
 * real OpenAI chat adapter.
 *
 * An empty response (HTTP 200, a finish_reason, no text, no tool call) is
 * transient in practice: on the beta fleet the next scheduled run always
 * succeeded. So it is retried — but on its own small budget. The 10-attempt,
 * 32-second-capped ladder is sized for 5xx and dropped connections; spending it
 * on a gateway that keeps answering with nothing would hold a turn for
 * minutes before saying so. When the small budget runs out the error is thrown,
 * which the provider layer turns into a visible API error message. It must
 * never end as a quiet, successful, empty turn.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { adaptOpenAIStreamToAnthropic } from '@ant/model-provider'
import { retryThirdPartyEventStream } from '../streamAssembly.js'
import { OpenAIRequestError } from '../openai/retry.js'
import {
  categorizeRetryableAPIError,
  isRetryableAPIError,
} from '../retryClassification.js'
import {
  registerEmptyModelResponseCallback,
  unregisterEmptyModelResponseCallback,
} from '../upstreamStatus.js'

type Chunk = Record<string, unknown>
type Reply = 'empty' | 'normal' | 'http500'

function chunk(
  delta: Record<string, unknown> | null,
  finish: string | null = null,
  usage?: Record<string, number>,
): Chunk {
  return {
    id: 'chatcmpl-retry',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gemini-3.8-flash-high',
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }
}

const EMPTY: Chunk[] = [
  chunk({ role: 'assistant' }),
  chunk({}, 'stop'),
  chunk(null, null, {
    prompt_tokens: 1000,
    completion_tokens: 0,
    total_tokens: 1000,
  }),
]
const NORMAL: Chunk[] = [
  chunk({ role: 'assistant', content: 'ok' }),
  chunk({}, 'stop'),
  chunk(null, null, { prompt_tokens: 1000, completion_tokens: 1 }),
]

async function* stream(chunks: Chunk[]): AsyncGenerator<unknown> {
  for (const c of chunks) yield c
}

/**
 * Answer each request from `replies` in order (the last one repeats), exactly
 * as `queryModelOpenAI` builds `create`: a fresh adapter over a fresh stream.
 */
function ladder(replies: readonly Reply[], maxRetries: number) {
  let requests = 0
  const delays: number[] = []
  const events = (async function* () {
    yield* retryThirdPartyEventStream({
      signal: new AbortController().signal,
      maxRetries,
      delay: async ms => {
        delays.push(ms)
      },
      create: async () => {
        const reply = replies[Math.min(requests, replies.length - 1)]!
        requests++
        if (reply === 'http500') {
          throw new OpenAIRequestError(
            'OpenAI request failed (500): upstream',
            {
              retryable: true,
              status: 500,
            },
          )
        }
        return adaptOpenAIStreamToAnthropic(
          stream(reply === 'empty' ? EMPTY : NORMAL) as never,
          'gemini-3.8-flash-high',
        )
      },
    })
  })()
  return { events, requests: () => requests, delays: () => delays }
}

async function drain(
  events: AsyncIterable<BetaRawMessageStreamEvent>,
): Promise<{ events: BetaRawMessageStreamEvent[]; error: unknown }> {
  const seen: BetaRawMessageStreamEvent[] = []
  try {
    for await (const event of events) seen.push(event)
    return { events: seen, error: undefined }
  } catch (error) {
    return { events: seen, error }
  }
}

function text(events: readonly BetaRawMessageStreamEvent[]): string {
  return events
    .map(event =>
      event.type === 'content_block_delta' && event.delta.type === 'text_delta'
        ? event.delta.text
        : '',
    )
    .join('')
}

describe('empty model responses on the third-party retry ladder', () => {
  test('an empty response followed by a real one recovers the real answer', async () => {
    const run = ladder(['empty', 'normal'], 10)
    const { events, error } = await drain(run.events)

    expect(error).toBeUndefined()
    expect(run.requests()).toBe(2)
    expect(text(events)).toBe('ok')
    expect(events.at(-2)).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    })
    // Exactly one finished answer: the empty attempt left no message_delta.
    expect(events.filter(event => event.type === 'message_delta')).toHaveLength(
      1,
    )
  })

  test('two empty responses in a row still recover', async () => {
    const run = ladder(['empty', 'empty', 'normal'], 10)
    const { events, error } = await drain(run.events)

    expect(error).toBeUndefined()
    expect(run.requests()).toBe(3)
    expect(text(events)).toBe('ok')
  })

  test('persistent empty responses fail after the small budget, not the 10-attempt one', async () => {
    const run = ladder(['empty'], 10)
    const { events, error } = await drain(run.events)

    // One request plus two retries, then a real error instead of a quiet stop.
    expect(run.requests()).toBe(3)
    expect(run.delays()).toEqual([500, 1000])
    expect(error).toMatchObject({
      name: 'EmptyModelResponseError',
      code: 'empty_response',
    })
    expect(isRetryableAPIError(error)).toBe(true)
    expect(categorizeRetryableAPIError(error)).toBe('server_error')
    expect(events.some(event => event.type === 'message_delta')).toBe(false)
  })

  test('empty responses do not spend the 5xx budget', async () => {
    // maxRetries 1: the single 5xx retry is still available after two empties.
    const run = ladder(['empty', 'empty', 'http500', 'normal'], 1)
    const { events, error } = await drain(run.events)

    expect(error).toBeUndefined()
    expect(run.requests()).toBe(4)
    expect(text(events)).toBe('ok')
  })

  test('5xx keeps its own ladder unchanged', async () => {
    const run = ladder(['http500', 'http500', 'http500', 'normal'], 10)
    const { events, error } = await drain(run.events)

    expect(error).toBeUndefined()
    expect(run.requests()).toBe(4)
    expect(text(events)).toBe('ok')
    expect(run.delays()).toHaveLength(3)
  })

  test('a 5xx that never clears still exhausts the configured budget', async () => {
    const run = ladder(['http500'], 3)
    const { error } = await drain(run.events)

    expect(run.requests()).toBe(4)
    expect(error).toBeInstanceOf(OpenAIRequestError)
  })
})

describe('what an empty response leaves in the node log', () => {
  afterEach(() => {
    // Process-global by design (see upstreamStatus.ts); never leave one behind.
    unregisterEmptyModelResponseCallback()
  })

  test('one line per empty response: finish_reason, usage, and what happens next', async () => {
    const lines: string[] = []
    registerEmptyModelResponseCallback(line => lines.push(line))

    await drain(ladder(['empty'], 10).events)

    expect(lines).toEqual([
      '[model] empty model response: finish_reason=stop input_tokens=1000 output_tokens=0 occurrence=1 action=retry',
      '[model] empty model response: finish_reason=stop input_tokens=1000 output_tokens=0 occurrence=2 action=retry',
      '[model] empty model response: finish_reason=stop input_tokens=1000 output_tokens=0 occurrence=3 action=fail',
    ])
  })

  test('a recovered empty response is still recorded', async () => {
    const lines: string[] = []
    registerEmptyModelResponseCallback(line => lines.push(line))

    await drain(ladder(['empty', 'normal'], 10).events)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toEndWith('action=retry')
  })

  test('other failures write nothing here', async () => {
    const lines: string[] = []
    registerEmptyModelResponseCallback(line => lines.push(line))

    await drain(ladder(['http500', 'normal'], 10).events)

    expect(lines).toEqual([])
  })

  test('a subscriber that throws cannot fail the request', async () => {
    registerEmptyModelResponseCallback(() => {
      throw new Error('sink broke')
    })

    const { events, error } = await drain(
      ladder(['empty', 'normal'], 10).events,
    )

    expect(error).toBeUndefined()
    expect(text(events)).toBe('ok')
  })
})
