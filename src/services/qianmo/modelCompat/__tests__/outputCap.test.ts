// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #5: output-cap errors are recognised, kept out of the overflow
 * verdict, and re-sent once with a smaller cap — only before any output.
 *
 * Every error string is CONSTRUCTED from the wording hermes quotes in
 * `agent/model_metadata.py:1617-1801` (`f9b29c49b6`), cited per row. None was
 * received from a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import { isContextOverflowErrorText } from 'src/services/api/errors.js'
import {
  isOutputCapError,
  isOutputCapErrorText,
  OUTPUT_CAP_SAFETY_MARGIN,
  outputCapRetryTokens,
  parseAvailableOutputTokens,
} from '../outputCap.js'

/** model_metadata.py:1630-1631 (docstring). */
const ANTHROPIC =
  'max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000'
/** model_metadata.py:1700-1711 (OpenRouter / Nous parts form). */
const OPENROUTER =
  "This endpoint's maximum context length is 200000 tokens. However, you requested about 210000 tokens (150000 of text input, 10000 of tool input, 50000 in the output). Please reduce the length of either one."
/** model_metadata.py:1650-1653 (LM Studio / llama.cpp, characters). */
const LM_STUDIO =
  "This model's maximum context length is 65536 tokens. However, you requested 65536 output tokens and your prompt contains 77409 characters"
/** model_metadata.py:1727-1731 (vLLM, tokens; input fits). */
const VLLM_FITS =
  "This model's maximum context length is 32768 tokens. However, you requested 32000 output tokens and your prompt contains at least 20000 input tokens, for a total of at least 52000 tokens. Please reduce the length of the input prompt or the number of requested output tokens."
/** Same vLLM form, but the input alone is over the window (`:1733-1735`). */
const VLLM_INPUT_TOO_BIG =
  "This model's maximum context length is 32768 tokens. However, you requested 32000 output tokens and your prompt contains at least 40000 input tokens, for a total of at least 72000 tokens. Please reduce the length of the input prompt or the number of requested output tokens."
/** model_metadata.py:1660-1664 (DashScope / Qwen, hermes #55546). */
const DASHSCOPE =
  '<400> InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 65536]'
/** Anthropic's input+output overflow — base contextOverflow.test.ts pins it as overflow. */
const ANTHROPIC_INPUT_PLUS_OUTPUT =
  'input length and `max_tokens` exceed context limit: 200000 + 8192 > 204698, decrease input length or `max_tokens` and try again'

describe('parseAvailableOutputTokens', () => {
  test.each([
    ['Anthropic available_tokens', ANTHROPIC, 10000],
    ['OpenRouter parts', OPENROUTER, 200000 - 150000 - 10000],
    ['LM Studio characters', LM_STUDIO, 65536 - Math.floor((77409 + 2) / 3)],
    ['vLLM tokens', VLLM_FITS, 32768 - 20000],
    ['DashScope range', DASHSCOPE, 65536],
  ])('%s', (_label, raw, expected) => {
    expect(parseAvailableOutputTokens(raw)).toBe(expected)
  })

  test.each([
    ['vLLM, input alone over the window', VLLM_INPUT_TOO_BIG],
    ['Anthropic input + output overflow', ANTHROPIC_INPUT_PLUS_OUTPUT],
    ['plain overflow', 'prompt is too long: 210000 tokens > 200000 maximum'],
    ['unrelated', 'Rate limit reached'],
  ])('%s → undefined', (_label, raw) => {
    expect(parseAvailableOutputTokens(raw)).toBeUndefined()
  })
})

describe('isOutputCapErrorText (no number needed)', () => {
  test.each([
    ['generic bound', 'max_tokens must be less than or equal to 8192', true],
    ['alias', 'max_completion_tokens should be at most 16384', true],
    [
      'input overflow mentioning max_tokens',
      'max_tokens must be set; input is too long for this model',
      false,
    ],
    ['no parameter named', 'output limit reached', false],
  ])('%s', (_label, raw, expected) => {
    expect(isOutputCapErrorText(raw)).toBe(expected)
  })
})

describe('hermes-research §11.9-③: output-cap errors are not overflow', () => {
  test.each([
    ['vLLM output-cap (input fits)', VLLM_FITS],
    ['LM Studio output-cap', LM_STUDIO],
    ['DashScope output-cap', DASHSCOPE],
    ['Anthropic available_tokens', ANTHROPIC],
    ['OpenRouter parts', OPENROUTER],
  ])('%s', (_label, raw) => {
    expect(isOutputCapError(raw)).toBe(true)
    expect(isContextOverflowErrorText(raw)).toBe(false)
  })

  test.each([
    ['vLLM, input alone over the window', VLLM_INPUT_TOO_BIG],
    ['Anthropic input + output (base pin)', ANTHROPIC_INPUT_PLUS_OUTPUT],
  ])('%s stays overflow', (_label, raw) => {
    expect(isContextOverflowErrorText(raw)).toBe(true)
  })
})

describe('outputCapRetryTokens', () => {
  /** Shape of an OpenAI SDK BadRequestError: status line + body envelope. */
  const sdkError = (message: string) =>
    Object.assign(new Error(`400 ${message}`), {
      status: 400,
      error: { message, type: 'BadRequestError', code: 400 },
    })

  test('available minus the 64-token margin (conversation_loop.py:5554)', () => {
    expect(OUTPUT_CAP_SAFETY_MARGIN).toBe(64)
    expect(outputCapRetryTokens(sdkError(VLLM_FITS), 32000)).toBe(12768 - 64)
    expect(outputCapRetryTokens(sdkError(ANTHROPIC), 32768)).toBe(10000 - 64)
  })

  test('a request that sent no cap still gets one', () => {
    expect(outputCapRetryTokens(sdkError(VLLM_FITS), undefined)).toBe(12704)
  })

  test('never below 1', () => {
    expect(
      outputCapRetryTokens(
        'max_tokens: 100 > context_window: 1000 - input_tokens: 990 = available_tokens: 10',
        100,
      ),
    ).toBe(1)
  })

  test('no re-send when the smaller cap is not smaller', () => {
    expect(outputCapRetryTokens(sdkError(DASHSCOPE), 8192)).toBeUndefined()
  })

  test('no re-send without a readable budget', () => {
    expect(
      outputCapRetryTokens(sdkError('max_tokens must be <= 8192'), 64000),
    ).toBeUndefined()
    expect(outputCapRetryTokens(sdkError(VLLM_INPUT_TOO_BIG), 32000)).toBe(
      undefined,
    )
    expect(outputCapRetryTokens(new Error('fetch failed'), 64000)).toBe(
      undefined,
    )
  })
})
