// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The tool-layer citation contract — decision D-6, roadmap P3.3 v2.2 补充.
 *
 * WHY A TOOL AND NOT A VENDOR CITATION BLOCK
 *
 * The research recommendation for AC-4 was Anthropic's native `search_result`
 * citation block. It was rejected, and this file is the replacement: the native
 * block is mutually exclusive with structured output (both together is a 400)
 * and exists on exactly one vendor's line, while AC-5 requires the same code to
 * run on two. Building AC-4 on it would have put the two acceptance criteria in
 * permanent conflict from S1 onward. **That conflict is resolved by this file;
 * do not reintroduce the native path.**
 *
 * WHAT MAKES IT NEUTRAL
 *
 * Everything below is plain data: a name, a description and a JSON Schema
 * object. It names no SDK, imports no provider type, and mentions no vendor.
 * The base's own adapters convert it — `anthropicToolsToOpenAI` for the
 * OpenAI-compatible line, verbatim on the Anthropic-native line — so switching
 * providers is a configuration change, exactly as AC-5 requires.
 *
 * WHAT MAKES IT ENFORCEABLE
 *
 * A tool call returns *arguments*, not prose. `citations` therefore arrives as
 * a list of ids rather than as a sentence to be regex-mined, and every id can
 * be resolved against the store before the answer is allowed through
 * (`citation.ts`). A fabricated id does not resolve, so it cannot be accepted —
 * the negative half of AC-4 is a lookup, not a prompt-engineering hope.
 */

/** JSON Schema, narrowed to what a tool input schema may be. */
export type ToolInputSchema = {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, unknown>>
  readonly required: readonly string[]
  readonly additionalProperties?: boolean
}

/**
 * A provider-neutral tool definition. Structurally the intersection of what
 * every provider's tool API needs; the adapter layer supplies the rest.
 */
export type RecallToolDefinition = {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
}

export const MEMORY_ANSWER_TOOL_NAME = 'qianmo_memory_answer'

export const MEMORY_ANSWER_TOOL: RecallToolDefinition = {
  name: MEMORY_ANSWER_TOOL_NAME,
  description:
    'Answer the user using ONLY the Qianmo memory entries provided in the ' +
    'context block, and declare which entries the answer came from. Every ' +
    'id in `citations` must be copied verbatim from an `entry_id` field in ' +
    'that block. Ids are verified against the memory store: an id that is ' +
    'not in the block is rejected and the answer is discarded. If no entry ' +
    'covers the question, say so plainly and pass an empty `citations` list ' +
    '— that is a correct answer, and inventing an id is not.',
  inputSchema: {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        description:
          'The answer, in the language the question was asked in. State the ' +
          'decision as recorded; do not add advice that is not in the entries.',
      },
      citations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The `entry_id` values of every memory entry the answer relies on, ' +
          'copied verbatim. Empty if the answer relies on no entry.',
      },
    },
    required: ['answer', 'citations'],
    additionalProperties: false,
  },
}

/** Thrown when a tool call's arguments are not the declared shape. */
export class RecallToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecallToolError'
  }
}

export type MemoryAnswerArgs = {
  readonly answer: string
  readonly citations: readonly string[]
}

/**
 * Validate one tool call's arguments.
 *
 * Strict about the *shape* (a missing `citations` is a contract violation, not
 * an empty list) and deliberately silent about the *content* — whether an id is
 * real is `citation.ts`'s question, and answering it here would let a
 * malformed-shaped call and a fabricated-id call fail with the same message.
 */
export function parseMemoryAnswerArgs(input: unknown): MemoryAnswerArgs {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RecallToolError(
      `${MEMORY_ANSWER_TOOL_NAME} arguments must be an object`,
    )
  }
  const record = input as Record<string, unknown>
  const answer = record['answer']
  if (typeof answer !== 'string') {
    throw new RecallToolError(
      `${MEMORY_ANSWER_TOOL_NAME}.answer must be a string`,
    )
  }
  const citations = record['citations']
  if (!Array.isArray(citations) || citations.some(c => typeof c !== 'string')) {
    throw new RecallToolError(
      `${MEMORY_ANSWER_TOOL_NAME}.citations must be a list of strings`,
    )
  }
  return { answer, citations: citations as string[] }
}
