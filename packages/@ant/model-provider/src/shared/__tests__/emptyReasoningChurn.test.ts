// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An empty `reasoning_content` must not shred one answer into hundreds of
 * alternating blocks.
 *
 * Some OpenAI-compatible endpoints pair `reasoning_content: ""` with *every*
 * text chunk. The thinking handler treats any non-null value as a signal to
 * open a thinking block — which first closes the open text block — so each of
 * those empty strings costs one block boundary. Measured through a real
 * gateway before the fix: qwen3.8-max produced **251 blocks** for a two-point
 * answer (126 thinking, 125 of them empty) where deepseek-v4-pro produced 2.
 * Those blocks are persisted and replayed on every later request, so the cost
 * recurs each turn.
 *
 * The DeepSeek contract is the other half of this test: `""` arriving *before*
 * any text means "the model answered directly", and that empty thinking block
 * must still be produced and still round-trip.
 */

import { describe, expect, test } from 'bun:test'
import { adaptOpenAIStreamToAnthropic } from '../openaiStreamAdapter.js'

type Chunk = Record<string, unknown>

function chunk(delta: Record<string, unknown>): Chunk {
  return {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'probe',
    choices: [{ index: 0, delta, finish_reason: null }],
  }
}

/** The adapter throws IncompleteOpenAIStreamError unless a finish_reason lands. */
const DONE: Chunk = {
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'probe',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
}

async function* stream(chunks: Chunk[]): AsyncGenerator<unknown> {
  for (const c of chunks) yield c
}

async function blockTypes(chunks: Chunk[]): Promise<string[]> {
  const types: string[] = []
  for await (const event of adaptOpenAIStreamToAnthropic(
    stream(chunks) as never,
    'probe',
  )) {
    const e = event as { type?: string; content_block?: { type?: string } }
    if (e.type === 'content_block_start' && e.content_block?.type) {
      types.push(e.content_block.type)
    }
  }
  return types
}

describe('empty reasoning_content interleaved with text', () => {
  test('does not open a block per chunk', async () => {
    // The shape a chatty gateway produces: every text delta carries "".
    const chunks = [
      chunk({ role: 'assistant', content: '' }),
      ...Array.from({ length: 20 }, (_, i) =>
        chunk({ content: `part${i}`, reasoning_content: '' }),
      ),
      DONE,
    ]
    const types = await blockTypes(chunks)
    // Two blocks for the whole answer, not forty. The single thinking block is
    // the DeepSeek contract firing on the *first* empty string (no text had
    // started yet); the other nineteen are suppressed. This is exactly the
    // shape measured on the real gateway after the fix: 251 blocks → 2.
    expect(types).toEqual(['thinking', 'text'])
  })

  test('real reasoning still opens exactly one thinking block', async () => {
    const chunks = [
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning_content: 'let me think' }),
      chunk({ reasoning_content: ' more' }),
      chunk({ content: 'the answer' }),
      DONE,
    ]
    expect(await blockTypes(chunks)).toEqual(['thinking', 'text'])
  })

  test('DeepSeek contract: an empty string BEFORE any text still yields a thinking block', async () => {
    // "The model answered directly" — the empty thinking block must exist so it
    // can round-trip, or DeepSeek rejects the next request with 400.
    const chunks = [
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning_content: '' }),
      chunk({ content: 'direct answer' }),
      DONE,
    ]
    expect(await blockTypes(chunks)).toEqual(['thinking', 'text'])
  })

  test('reasoning that genuinely follows text still opens its own block', async () => {
    // DeepSeek reasons between steps, so this must keep working.
    const chunks = [
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'first' }),
      chunk({ reasoning_content: 'now reconsider' }),
      chunk({ content: 'second' }),
      DONE,
    ]
    expect(await blockTypes(chunks)).toEqual(['text', 'thinking', 'text'])
  })
})
