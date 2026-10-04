// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #9: tool-call deltas → tool_use blocks.
 *
 * The chunk sequences below are CONSTRUCTED, not recorded. Each follows the
 * provider behaviour hermes describes in `agent/chat_completion_helpers.py`
 * at `f9b29c49b6` (cited per fixture) and the hermes-research §11.9-① probe
 * that showed the defect on Qianmo; none was received from a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { adaptOpenAIStreamToAnthropic } from '../../openaiStreamAdapter.js'
import { ToolCallDeltaAssembler } from '../toolCallDeltas.js'

type Delta = Record<string, unknown>

function chunk(delta: Delta | null, finish: string | null = null) {
  return {
    id: 'chatcmpl-p185',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }],
  } as unknown as ChatCompletionChunk
}

async function* streamOf(chunks: ChatCompletionChunk[]) {
  for (const c of chunks) yield c
}

async function run(chunks: ChatCompletionChunk[]) {
  const events: BetaRawMessageStreamEvent[] = []
  let thrown: unknown
  try {
    for await (const event of adaptOpenAIStreamToAnthropic(
      streamOf(chunks),
      'm',
    )) {
      events.push(event)
    }
  } catch (error) {
    thrown = error
  }
  return { events, thrown }
}

type ToolUse = { index: number; id: string; name: string; args: string }

/** tool_use blocks with their concatenated arguments. */
function toolUses(events: BetaRawMessageStreamEvent[]): ToolUse[] {
  const byIndex = new Map<number, ToolUse>()
  for (const raw of events) {
    const event = raw as unknown as Record<string, any>
    if (
      event.type === 'content_block_start' &&
      event.content_block.type === 'tool_use'
    ) {
      byIndex.set(event.index, {
        index: event.index,
        id: event.content_block.id,
        name: event.content_block.name,
        args: '',
      })
    }
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'input_json_delta'
    ) {
      byIndex.get(event.index)!.args += event.delta.partial_json
    }
  }
  return [...byIndex.values()]
}

function stopReason(events: BetaRawMessageStreamEvent[]): unknown {
  const delta = events.find(e => e.type === 'message_delta') as
    | { delta: { stop_reason: unknown } }
    | undefined
  return delta?.delta.stop_reason
}

describe('hermes-research §11.9-① probes flip', () => {
  test('C: the name arrives only in the second delta → the later name is used', async () => {
    // hermes chat_completion_helpers.py:4214-4226: the name may come in any
    // chunk and is assigned, not taken from the first delta only.
    const { events, thrown } = await run([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { arguments: '{"a":1}' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'Read' } }] }),
      chunk({}, 'tool_calls'),
    ])
    expect(thrown).toBeUndefined()
    expect(toolUses(events)).toEqual([
      { index: 0, id: 'call_1', name: 'Read', args: '{"a":1}' },
    ])
    expect(stopReason(events)).toBe('tool_use')
  })

  test('D: Ollama reuses index 0 with a new id → two calls, not one', async () => {
    // hermes chat_completion_helpers.py:4181-4193 ("Ollama fix").
    const { events, thrown } = await run([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'Read', arguments: '{"a":1}' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_b',
            type: 'function',
            function: { name: 'Read', arguments: '{"b":2}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
    ])
    expect(thrown).toBeUndefined()
    const uses = toolUses(events)
    expect(uses.map(u => [u.id, u.name, u.args])).toEqual([
      ['call_a', 'Read', '{"a":1}'],
      ['call_b', 'Read', '{"b":2}'],
    ])
    for (const use of uses) expect(() => JSON.parse(use.args)).not.toThrow()
  })
})

describe('other hermes rules', () => {
  test('integer id becomes a string (Poolside, :4197-4199)', async () => {
    const { events } = await run([
      chunk({
        tool_calls: [
          { index: 0, id: 7, function: { name: 'Bash', arguments: '{}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
    ])
    expect(toolUses(events)[0]!.id).toBe('7')
  })

  test('a name resent in every chunk is not concatenated (MiniMax via NIM, :4216-4223)', async () => {
    const { events } = await run([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_m',
            function: { name: 'read_file', arguments: '{"p' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { name: 'read_file', arguments: '":1}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
    ])
    expect(toolUses(events)).toEqual([
      { index: 0, id: 'call_m', name: 'read_file', args: '{"p":1}' },
    ])
  })

  test('a missing index counts as 0 (:4177)', async () => {
    const { events } = await run([
      chunk({ tool_calls: [{ id: 'call_x', function: { name: 'Ls' } }] }),
      chunk({ tool_calls: [{ function: { arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ])
    expect(toolUses(events)).toEqual([
      { index: 0, id: 'call_x', name: 'Ls', args: '{}' },
    ])
  })

  test('parallel calls interleaved by index stay apart', async () => {
    const { events } = await run([
      chunk({
        tool_calls: [
          { index: 0, id: 'c0', function: { name: 'A', arguments: '{"x"' } },
          { index: 1, id: 'c1', function: { name: 'B', arguments: '{"y"' } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 1, function: { arguments: ':2}' } },
          { index: 0, function: { arguments: ':1}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
    ])
    expect(toolUses(events).map(u => [u.name, u.args])).toEqual([
      ['A', '{"x":1}'],
      ['B', '{"y":2}'],
    ])
  })
})

describe('a name that never arrives', () => {
  const nameless = [
    chunk({
      tool_calls: [{ index: 0, id: 'call_n', function: { arguments: '{}' } }],
    }),
  ]

  test('opens at finish_reason with the empty name, as before', async () => {
    const { events, thrown } = await run([...nameless, chunk({}, 'tool_calls')])
    expect(thrown).toBeUndefined()
    expect(toolUses(events)).toEqual([
      { index: 0, id: 'call_n', name: '', args: '{}' },
    ])
    expect(stopReason(events)).toBe('tool_use')
  })

  test('opens when a terminal usage chunk ends the stream', async () => {
    const usage = {
      ...chunk(null),
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    } as unknown as ChatCompletionChunk
    const { events, thrown } = await run([...nameless, usage])
    expect(thrown).toBeUndefined()
    expect(toolUses(events)).toHaveLength(1)
    expect(stopReason(events)).toBe('tool_use')
  })

  test('a cut stream shows nothing of it, so the attempt stays replayable', async () => {
    const { events, thrown } = await run(nameless)
    expect(thrown).toBeInstanceOf(Error)
    expect(
      events.some(
        e =>
          e.type === 'content_block_start' || e.type === 'content_block_delta',
      ),
    ).toBe(false)
  })
})

describe('ToolCallDeltaAssembler', () => {
  test('a late id before the name replaces the empty one; start carries it', () => {
    const assembler = new ToolCallDeltaAssembler(() => 'generated')
    expect(
      assembler.accept([{ index: 0, function: { arguments: '{' } }]),
    ).toEqual([])
    expect(assembler.accept([{ index: 0, id: 'late' }])).toEqual([])
    expect(
      assembler.accept([{ index: 0, function: { name: 'N', arguments: '}' } }]),
    ).toEqual([
      { type: 'start', slot: 0, id: 'late', name: 'N' },
      { type: 'arguments', slot: 0, fragment: '{' },
      { type: 'arguments', slot: 0, fragment: '}' },
    ])
    expect(assembler.flush()).toEqual([])
  })

  test('no id ever → minted once', () => {
    const assembler = new ToolCallDeltaAssembler(() => 'toolu_minted')
    expect(assembler.accept([{ index: 3, function: { name: 'N' } }])).toEqual([
      { type: 'start', slot: 0, id: 'toolu_minted', name: 'N' },
    ])
  })
})
