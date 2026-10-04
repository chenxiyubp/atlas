// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #5 recovery: "shrink the cap and re-send once" goes through the
 * same exactly-once barrier as every other third-party replay (design §5.6
 * row 29). Two layers:
 *
 *  - the retry loop itself (`retryThirdPartyEventStream`) with scripted
 *    attempts: re-sent only when nothing was shown, only when replayable,
 *    only once;
 *  - the real `queryModelOpenAI` through the recording stub: the second
 *    request carries the smaller cap, on both wires.
 *
 * The error bodies are CONSTRUCTED from the vLLM wording hermes quotes in
 * `agent/model_metadata.py:1727-1731` (`f9b29c49b6`), not recorded.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { OpenAIRequestError } from 'src/services/api/openai/retry.js'
import { retryThirdPartyEventStream } from 'src/services/api/streamAssembly.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const VLLM_OUTPUT_CAP =
  "This model's maximum context length is 32768 tokens. However, you requested 32000 output tokens and your prompt contains at least 20000 input tokens, for a total of at least 52000 tokens. Please reduce the length of the input prompt or the number of requested output tokens."
/** 32768 − 20000 − 64 (outputCap.ts). */
const SHRUNK_CAP = 12704

const ev = (event: Record<string, unknown>) =>
  event as unknown as BetaRawMessageStreamEvent
const MESSAGE_START = ev({
  type: 'message_start',
  message: {
    id: 'msg_p185',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'm',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
})
const TEXT_START = ev({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
})
const TEXT_DELTA = ev({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text: 'partial' },
})
const THINKING_START = ev({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'thinking', thinking: '', signature: '' },
})
const THINKING_DELTA = ev({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'thinking_delta', thinking: 'plan' },
})
const BLOCK_STOP = ev({ type: 'content_block_stop', index: 0 })
const MESSAGE_DELTA = ev({
  type: 'message_delta',
  delta: { stop_reason: 'end_turn', stop_sequence: null },
  usage: { output_tokens: 1 },
})
const MESSAGE_STOP = ev({ type: 'message_stop' })
const COMPLETE = [
  MESSAGE_START,
  TEXT_START,
  TEXT_DELTA,
  BLOCK_STOP,
  MESSAGE_DELTA,
  MESSAGE_STOP,
]

const outputCapError = (replayable = true) =>
  new OpenAIRequestError(`OpenAI request failed (400): ${VLLM_OUTPUT_CAP}`, {
    retryable: false,
    status: 400,
    replayable,
  })

type Attempt = { events: BetaRawMessageStreamEvent[]; thenThrow?: unknown }

async function runLadder(attempts: Attempt[], recoverAnswer = true) {
  let created = 0
  let recoverCalls = 0
  const seen: BetaRawMessageStreamEvent[] = []
  let thrown: unknown
  try {
    for await (const event of retryThirdPartyEventStream({
      signal: new AbortController().signal,
      maxRetries: 3,
      delay: async () => {},
      recoverOutputCap: () => {
        recoverCalls++
        return recoverAnswer
      },
      create: async () => {
        const attempt = attempts[Math.min(created, attempts.length - 1)]!
        created++
        return (async function* () {
          for (const event of attempt.events) yield event
          if (attempt.thenThrow !== undefined) throw attempt.thenThrow
        })()
      },
    })) {
      seen.push(event)
    }
  } catch (error) {
    thrown = error
  }
  return { created, recoverCalls, seen, thrown }
}

describe('retry loop: output-cap re-send stays behind the barrier', () => {
  test('before any output: re-sent once, the answer arrives once', async () => {
    const run = await runLadder([
      { events: [], thenThrow: outputCapError() },
      { events: COMPLETE },
    ])
    expect(run.thrown).toBeUndefined()
    expect(run.created).toBe(2)
    expect(run.recoverCalls).toBe(1)
    expect(run.seen.filter(e => e.type === 'message_start')).toHaveLength(1)
    expect(run.seen.filter(e => e.type === 'content_block_delta')).toHaveLength(
      1,
    )
  })

  test('after visible text: not re-sent', async () => {
    const run = await runLadder([
      {
        events: [MESSAGE_START, TEXT_START, TEXT_DELTA],
        thenThrow: outputCapError(),
      },
      { events: COMPLETE },
    ])
    expect(run.recoverCalls).toBe(0)
    expect(run.created).toBe(1)
    expect(run.thrown).toBeDefined()
  })

  test('after reasoning text: not re-sent', async () => {
    const run = await runLadder([
      {
        events: [MESSAGE_START, THINKING_START, THINKING_DELTA],
        thenThrow: outputCapError(),
      },
      { events: COMPLETE },
    ])
    expect(run.recoverCalls).toBe(0)
    expect(run.created).toBe(1)
    expect(run.thrown).toBeDefined()
  })

  test('producer marked the error unreplayable: not re-sent', async () => {
    const run = await runLadder([
      { events: [], thenThrow: outputCapError(false) },
      { events: COMPLETE },
    ])
    expect(run.recoverCalls).toBe(0)
    expect(run.created).toBe(1)
    expect(run.thrown).toBeDefined()
  })

  test('only once: a second output-cap rejection surfaces', async () => {
    const run = await runLadder([
      { events: [], thenThrow: outputCapError() },
      { events: [], thenThrow: outputCapError() },
      { events: COMPLETE },
    ])
    expect(run.recoverCalls).toBe(1)
    expect(run.created).toBe(2)
    expect(run.thrown).toBeInstanceOf(OpenAIRequestError)
  })

  test('the lane declines (no readable budget): surfaces at once', async () => {
    const run = await runLadder(
      [{ events: [], thenThrow: outputCapError() }, { events: COMPLETE }],
      false,
    )
    expect(run.recoverCalls).toBe(1)
    expect(run.created).toBe(1)
    expect(run.thrown).toBeInstanceOf(OpenAIRequestError)
  })
})

describe('queryModelOpenAI: the re-send carries the smaller cap', () => {
  /** OpenAI-style envelope: `{ error: { message, type, param, code } }`. */
  const failure = {
    status: 400,
    body: {
      error: {
        message: VLLM_OUTPUT_CAP,
        type: 'BadRequestError',
        param: null,
        code: 400,
      },
    },
  }
  /** Bare body without the `error` envelope (older vLLM-style shape). */
  const bareFailure = {
    status: 400,
    body: {
      object: 'error',
      message: VLLM_OUTPUT_CAP,
      type: 'BadRequestError',
      param: null,
      code: 400,
    },
  }

  test('chat lane: max_tokens 32000 → 12704', async () => {
    const requests = await captureOpenAIRequests({
      model: 'qwen3-coder',
      baseURL: 'http://localhost:8000/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      maxOutputTokensOverride: 32000,
      failFirst: [failure],
    })
    expect(requests.map(r => r.body.max_tokens)).toEqual([32000, SHRUNK_CAP])
  })

  test('Responses lane: max_output_tokens 32000 → 12704', async () => {
    const requests = await captureOpenAIRequests({
      model: 'gpt-6-luna',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'responses' },
      maxOutputTokensOverride: 32000,
      failFirst: [failure],
    })
    expect(requests.map(r => r.body.max_output_tokens)).toEqual([
      32000,
      SHRUNK_CAP,
    ])
  })

  test('Responses lane reads a bare body too', async () => {
    const requests = await captureOpenAIRequests({
      model: 'gpt-6-luna',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'responses' },
      maxOutputTokensOverride: 32000,
      failFirst: [bareFailure],
    })
    expect(requests.map(r => r.body.max_output_tokens)).toEqual([
      32000,
      SHRUNK_CAP,
    ])
  })

  test('KNOWN GAP — chat lane cannot see a bare body: the OpenAI Node SDK renders it as "400 status code (no body)"', async () => {
    // Not P18.5's to fix (the SDK client is outside its file scope); pinned so
    // the day the text starts arriving, this fails and the gap is re-checked.
    const requests = await captureOpenAIRequests({
      model: 'qwen3-coder',
      baseURL: 'http://localhost:8000/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      maxOutputTokensOverride: 32000,
      failFirst: [bareFailure],
    })
    expect(requests).toHaveLength(1)
  })

  test('an ordinary 400 is still sent once', async () => {
    const requests = await captureOpenAIRequests({
      model: 'qwen3-coder',
      baseURL: 'http://localhost:8000/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      maxOutputTokensOverride: 32000,
      failFirst: [
        {
          status: 400,
          body: { error: { message: 'Invalid tool schema', type: 'x' } },
        },
      ],
    })
    expect(requests).toHaveLength(1)
  })
})
