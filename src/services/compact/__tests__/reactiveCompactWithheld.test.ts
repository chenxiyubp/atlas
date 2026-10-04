// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two withheld-error predicates reactive compact exposes to the query loop.
 *
 * The query loop asks them about `assistantMessages.at(-1)`, which is
 * `undefined` whenever a model call produced no assistant message at all — an
 * OpenAI-compatible gateway answering HTTP 200 with a finish_reason and no
 * content does exactly that. They used to read `message.type` unguarded, so
 * that turn died with `TypeError: undefined is not an object` before the
 * loop's own "Model returned an empty response." handling could run
 * (beta-5, 2026-09-27: three watch turns lost as `-32603 Internal error`).
 *
 * Plain `bun test` compiles REACTIVE_COMPACT out of query.ts, so the loop-level
 * test in `src/__tests__/queryAutonomyProviderBoundary.test.ts` only reaches
 * these functions under `bun run test:shipped-features`. This file calls them
 * directly and therefore runs in every mode.
 */

import { describe, expect, test } from 'bun:test'
import {
  isWithheldMediaSizeError,
  isWithheldPromptTooLong,
} from '../reactiveCompact.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../../api/errors.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../../../utils/messages.js'

describe('reactive compact withheld-error predicates', () => {
  test('a turn with no assistant message is not a withheld error', () => {
    expect(isWithheldPromptTooLong(undefined)).toBe(false)
    expect(isWithheldMediaSizeError(undefined)).toBe(false)
  })

  test('non-assistant and ordinary messages are not withheld errors', () => {
    const user = createUserMessage({ content: 'hello' })
    const apiError = createAssistantAPIErrorMessage({
      content: 'API Error: upstream failed',
    })
    expect(isWithheldPromptTooLong(user)).toBe(false)
    expect(isWithheldMediaSizeError(user)).toBe(false)
    expect(isWithheldPromptTooLong(apiError)).toBe(false)
    expect(isWithheldMediaSizeError(apiError)).toBe(false)
  })

  test('the errors they exist for are still recognised', () => {
    expect(
      isWithheldPromptTooLong(
        createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
        }),
      ),
    ).toBe(true)
    expect(
      isWithheldMediaSizeError(
        createAssistantAPIErrorMessage({
          content: 'Image was too large.',
          errorDetails: 'image exceeds 5 MB maximum: 7340032 bytes',
        }),
      ),
    ).toBe(true)
  })
})
