// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #6: hermes's overflow wording reaches `isContextOverflowErrorText`,
 * and rate-limit / request-validation wording never does.
 *
 * Every string below is CONSTRUCTED, not recorded: either the vendor wording
 * hermes quotes in a comment (cited per row, `agent/error_classifier.py` and
 * `agent/model_metadata.py` at `f9b29c49b6`), or the bare table phrase put in
 * a plausible sentence. None was received from a real endpoint.
 */
import { describe, expect, test } from 'bun:test'
import {
  classifyAPIError,
  isContextOverflowErrorText,
} from 'src/services/api/errors.js'
import { overflowTextVerdict } from '../overflowText.js'

describe('hermes overflow wording now counts as overflow', () => {
  test.each([
    [
      'vLLM max_model_len',
      'The decoder prompt (length 40000) exceeds the max_model_len 32768.',
      'error_classifier.py:333-334',
    ],
    [
      'vLLM engine prompt length',
      'engine prompt length 40000 exceeds the maximum model length 32768',
      'error_classifier.py:335-337',
    ],
    [
      'Ollama truncating input',
      'truncating input prompt: limit=8192 prompt=12000',
      'error_classifier.py:339-341',
    ],
    [
      'llama.cpp slot context',
      'the request exceeds the available context size, slot context: 4096 tokens, prompt 5000 tokens',
      'error_classifier.py:342-344',
    ],
    [
      'llama.cpp n_ctx_slot',
      'n_ctx_slot = 4096, n_prompt_tokens = 5000',
      ':344',
    ],
    ['Chinese, max length', '输入超过最大长度限制，请缩短后重试', ':345-347'],
    ['Chinese, context length', '请求的上下文长度超出模型限制', ':345-347'],
    [
      'Z.AI 1210',
      '{"error":{"code":"1210","message":"tokens in request more than max tokens allowed"}}',
      ':348-349',
    ],
    [
      'Bedrock Converse',
      'ValidationException: The number of input tokens exceeds the maximum number of input tokens',
      ':350-353',
    ],
    [
      'Bedrock max input token',
      'Max input token limit reached for model',
      ':352',
    ],
    [
      'Together / Fireworks',
      'Input length 131393 exceeds the maximum allowed input length of 131040 tokens.',
      ':354-356',
    ],
    [
      'generic context size',
      'request exceeds the available context size',
      ':314',
    ],
    ['prompt exceeds max length', 'Prompt exceeds max length of 8192', ':321'],
  ])('%s', (_label, raw, _source) => {
    expect(isContextOverflowErrorText(raw)).toBe(true)
  })
})

describe('rate-limit wording is not overflow (hermes-research §11.9-③ guard 1)', () => {
  test.each([
    [
      'Bedrock throttle, full prefix',
      'Throttling error: Too many tokens, please wait before trying again.',
      'error_classifier.py:200-206',
    ],
    [
      'throttle with the prefix stripped (Qianmo wait rule)',
      'Too many tokens, please wait before trying again.',
      'Qianmo addition',
    ],
    ['short form', 'Too many tokens, please wait', 'Qianmo addition'],
    [
      'TPM limit naming context window',
      'Rate limit reached for tokens per minute; context window usage is fine',
      'error_classifier.py:183-189',
    ],
    [
      'Bedrock ThrottlingException',
      'ThrottlingException: too many tokens processed',
      ':196',
    ],
  ])('%s', (_label, raw, _source) => {
    expect(isContextOverflowErrorText(raw)).toBe(false)
  })

  test('classifyAPIError reports a throttle as something other than prompt_too_long', () => {
    expect(
      classifyAPIError(
        new Error(
          'Throttling error: Too many tokens, please wait before trying again.',
        ),
      ),
    ).not.toBe('prompt_too_long')
  })
})

describe('request-validation wording is not overflow', () => {
  test('unsupported max_tokens names max_tokens but is a request-shape 400', () => {
    // error_classifier.py:1478-1481 quotes this wording.
    const raw =
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead. (context window 400000)"
    expect(isContextOverflowErrorText(raw)).toBe(false)
  })
})

describe('bare phrases deliberately not taken (see overflowText.ts header)', () => {
  test.each([
    [
      'daily token limit',
      'You have reached your daily token limit for this key',
    ],
    ['file size limit', 'Uploaded file exceeds the limit of 20 MB'],
    ['max_tokens validation', 'max_tokens must be a positive integer'],
  ])('%s', (_label, raw) => {
    // Never `true`: the table does not claim them (an output-cap guard may
    // answer `false` for the max_tokens one, which is also not overflow).
    expect(overflowTextVerdict(raw)).not.toBe(true)
    expect(isContextOverflowErrorText(raw)).toBe(false)
  })
})

describe('overflowTextVerdict', () => {
  test('no opinion leaves the base regex in charge', () => {
    expect(overflowTextVerdict('getaddrinfo ENOTFOUND api.example.com')).toBe(
      undefined,
    )
    // Base-regex-only phrasing still matches through the fallthrough.
    expect(
      overflowTextVerdict('Requested tokens exceed context window of 32768'),
    ).toBe(true)
  })
})
