// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A turn that ends in an API error has to look like one on the ACP side.
 *
 * Two things hid it. The bridge maps every `is_error` result to `end_turn`
 * (ACP has no error stop reason, and inventing one would break editors), and
 * once any stream event had arrived it dropped the text blocks of every later
 * assistant message as "already streamed". API error messages are synthetic —
 * they are never streamed — so their text was dropped too. A client therefore
 * received a well-formed `end_turn` with nothing in it. A resident node
 * recorded that as `completed`, which is how an HTTP 400 from the gateway was
 * counted as a successful watch run, and how an empty model response would
 * have been counted the same way once the crash in front of it was fixed.
 */

import { describe, expect, mock, test } from 'bun:test'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { forwardSessionUpdates } from '../bridge.js'
import type { SDKMessage } from '../../../entrypoints/sdk/coreTypes.js'

const ERROR_TEXT =
  'API Error [OpenAI]: Model returned an empty response (finish_reason=stop) · code=empty_response · name=EmptyModelResponseError · category=server_error · retryable=yes'

function makeConn() {
  const updates: Array<Record<string, unknown>> = []
  const conn = {
    sessionUpdate: mock(async (params: { update: Record<string, unknown> }) => {
      updates.push(params.update)
    }),
    requestPermission: mock(async () => ({
      outcome: { outcome: 'cancelled' },
    })),
  } as unknown as AgentSideConnection
  return { conn, updates }
}

async function* stream(
  msgs: readonly Record<string, unknown>[],
): AsyncGenerator<SDKMessage, void, unknown> {
  for (const m of msgs) yield m as unknown as SDKMessage
}

function streamEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { type: 'stream_event', event, parent_tool_use_id: null }
}

/** What the retry ladder leaves on the stream for an attempt that said nothing. */
const EMPTY_ATTEMPT = [
  streamEvent({
    type: 'message_start',
    message: { id: 'msg_1', content: [], model: 'gemini-3.8-flash-high' },
  }),
  streamEvent({ type: 'message_stop' }),
]

const API_ERROR_MESSAGE = {
  type: 'assistant',
  parent_tool_use_id: null,
  uuid: 'u-err',
  error: 'server_error',
  message: {
    id: 'm-err',
    model: '<synthetic>',
    role: 'assistant',
    content: [{ type: 'text', text: ERROR_TEXT }],
  },
}

function errorResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: ERROR_TEXT,
    stop_reason: 'stop_sequence',
    ...overrides,
  }
}

/** Non-empty agent text, in order. A `content_block_start` sends an empty chunk. */
function agentText(updates: readonly Record<string, unknown>[]): string[] {
  return updates
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map(update => (update.content as { text?: string } | undefined)?.text)
    .filter((text): text is string => typeof text === 'string' && text !== '')
}

describe('an API error at the end of an ACP turn', () => {
  test('its text reaches the client even after stream events', async () => {
    const { conn, updates } = makeConn()
    await forwardSessionUpdates(
      's1',
      stream([...EMPTY_ATTEMPT, API_ERROR_MESSAGE, errorResult()]),
      conn,
      new AbortController().signal,
      {},
    )

    expect(agentText(updates)).toEqual([ERROR_TEXT])
  })

  test('the turn result carries the error next to the unchanged stop reason', async () => {
    const { conn } = makeConn()
    const result = await forwardSessionUpdates(
      's1',
      stream([...EMPTY_ATTEMPT, API_ERROR_MESSAGE, errorResult()]),
      conn,
      new AbortController().signal,
      {},
    )

    expect(result.stopReason).toBe('end_turn')
    expect(result.error).toEqual({
      category: 'server_error',
      message: ERROR_TEXT,
    })
  })

  test('an error with no category of its own is reported as unknown', async () => {
    // query.ts's own "Model returned an empty response." is built without a
    // category.
    const { conn } = makeConn()
    const result = await forwardSessionUpdates(
      's1',
      stream([
        { ...API_ERROR_MESSAGE, error: undefined },
        errorResult({ result: 'Model returned an empty response.' }),
      ]),
      conn,
      new AbortController().signal,
      {},
    )

    expect(result.error).toEqual({
      category: 'unknown',
      message: 'Model returned an empty response.',
    })
  })

  test('an error_during_execution result is an error too', async () => {
    const { conn } = makeConn()
    const result = await forwardSessionUpdates(
      's1',
      stream([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['[ede_diagnostic] result_type=user', 'second line'],
        },
      ]),
      conn,
      new AbortController().signal,
      {},
    )

    expect(result.stopReason).toBe('end_turn')
    expect(result.error).toEqual({
      category: 'unknown',
      message: '[ede_diagnostic] result_type=user',
    })
  })

  test('a very long error message is bounded', async () => {
    const { conn } = makeConn()
    const result = await forwardSessionUpdates(
      's1',
      stream([errorResult({ result: 'x'.repeat(5_000) })]),
      conn,
      new AbortController().signal,
      {},
    )

    expect(result.error?.message.length).toBeLessThanOrEqual(500)
  })
})

describe('ordinary turns are unchanged', () => {
  test('a streamed answer is not sent twice', async () => {
    const { conn, updates } = makeConn()
    const result = await forwardSessionUpdates(
      's1',
      stream([
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        streamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        }),
        {
          type: 'assistant',
          parent_tool_use_id: null,
          uuid: 'u-ok',
          message: {
            id: 'm-ok',
            model: 'gemini-3.8-flash-high',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'hello',
          stop_reason: 'end_turn',
        },
      ]),
      conn,
      new AbortController().signal,
      {},
    )

    expect(agentText(updates)).toEqual(['hello'])
    expect(result.stopReason).toBe('end_turn')
    expect(result.error).toBeUndefined()
  })

  test('a cancelled turn reports cancelled and no error', async () => {
    const controller = new AbortController()
    controller.abort()
    const { conn } = makeConn()
    const result = await forwardSessionUpdates(
      's1',
      stream([API_ERROR_MESSAGE, errorResult()]),
      conn,
      controller.signal,
      {},
    )

    expect(result.stopReason).toBe('cancelled')
    expect(result.error).toBeUndefined()
  })
})
