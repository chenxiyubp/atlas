// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.5 hermes #15: a 429 that means "cannot pay" is billing and is not
 * retried; a 429 that means "slow down" or "busy" still is.
 *
 * Error objects are CONSTRUCTED in the shapes Qianmo's lanes produce (OpenAI
 * Node SDK `APIError`, Qianmo's `OpenAIRequestError`, a stream-level error
 * envelope). The bodies follow the wording hermes records in
 * `agent/error_classifier.py:119-232` (`f9b29c49b6`) and the vendor quotes
 * cited per case; none was received from a real endpoint.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import { OpenAIRequestError } from 'src/services/api/openai/retry.js'
import {
  classifyRetryableAPIError,
  isRetryableAPIError,
} from 'src/services/api/retryClassification.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  isBillingErrorCode,
  isOverloadedErrorText,
  isQuotaExhaustedError,
} from '../errorText.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

/** What the OpenAI Node SDK throws for a 429 with an `{ error: … }` body. */
function sdk429(error: Record<string, unknown>): unknown {
  return OpenAI.APIError.generate(
    429,
    { error },
    undefined,
    new Headers({ 'content-type': 'application/json' }),
  )
}

const INSUFFICIENT_QUOTA = {
  message:
    'You exceeded your current quota, please check your plan and billing details.',
  type: 'insufficient_quota',
  code: 'insufficient_quota',
}

describe('429 insufficient_quota is billing, never retried', () => {
  test('OpenAI SDK RateLimitError (chat lane)', () => {
    const error = sdk429(INSUFFICIENT_QUOTA)
    expect(error).toBeInstanceOf(OpenAI.RateLimitError)
    expect(classifyRetryableAPIError(error)).toMatchObject({
      category: 'billing_error',
      retryable: false,
    })
  })

  test('OpenAIRequestError (Responses lane)', () => {
    const error = new OpenAIRequestError(
      `OpenAI Responses request failed (429): ${INSUFFICIENT_QUOTA.message}`,
      {
        retryable: true,
        status: 429,
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    )
    expect(isRetryableAPIError(error)).toBe(false)
  })

  test('stream-level error event without an HTTP status', () => {
    expect(
      classifyRetryableAPIError({
        type: 'error',
        error: { type: 'billing_not_active', message: 'Billing is not active' },
      }),
    ).toMatchObject({ category: 'billing_error', retryable: false })
  })

  test('billing wording alone, no rate-limit sign (hermes :119-141)', () => {
    const error = sdk429({
      message: 'Insufficient balance. Please top up your credits.',
      type: 'invalid_request_error',
    })
    expect(isRetryableAPIError(error)).toBe(false)
  })

  test('the lane makes one request, not a retry ladder', async () => {
    const requests = await captureOpenAIRequests({
      model: 'gpt-5.4',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      failFirst: [
        { status: 429, body: { error: INSUFFICIENT_QUOTA } },
        { status: 429, body: { error: INSUFFICIENT_QUOTA } },
      ],
    })
    expect(requests).toHaveLength(1)
  })
})

describe('429s that are not billing keep retrying', () => {
  test.each([
    [
      'plain rate limit',
      {
        message:
          'Rate limit reached for gpt-5.4 in organization org-x on tokens per min (TPM). Please try again in 2s.',
        type: 'requests',
        code: 'rate_limit_exceeded',
      },
    ],
    [
      'Z.AI overload reusing 429 (hermes :1258-1270, code 1305)',
      {
        message:
          'The service may be temporarily overloaded, please try again later',
        code: '1305',
      },
    ],
    [
      'overload that also mentions a quota',
      { message: 'Server is overloaded; your quota is unaffected' },
    ],
    [
      'Gemini free-tier per-minute quota (RESOURCE_EXHAUSTED)',
      {
        message:
          'You exceeded your current quota, please check your plan and billing details.',
        status: 'RESOURCE_EXHAUSTED',
        code: 429,
      },
    ],
  ])('%s', (_label, body) => {
    expect(classifyRetryableAPIError(sdk429(body))).toMatchObject({
      retryable: true,
    })
  })
})

describe('other statuses are left alone', () => {
  test('400 "out of extra usage" keeps its base classification', () => {
    expect(
      isQuotaExhaustedError({
        status: 400,
        records: [{ type: 'invalid_request_error' }],
        messages: ['You are out of extra usage'],
      }),
    ).toBe(false)
  })
})

describe('tables', () => {
  test('billing codes (hermes :170-180)', () => {
    for (const code of [
      'insufficient_quota',
      'billing_not_active',
      'payment_required',
      'insufficient_credits',
      'no_usable_credits',
      'balance_depleted',
      'model_not_supported_on_free_tier',
      'member_spend_cap_exceeded',
      'personal-team-blocked:spending-limit',
    ]) {
      expect(isBillingErrorCode(code)).toBe(true)
    }
    expect(isBillingErrorCode('rate_limit_exceeded')).toBe(false)
  })
  test('overloaded wording (hermes :219-232)', () => {
    expect(isOverloadedErrorText('Upstream overloaded, retry')).toBe(true)
    expect(isOverloadedErrorText('You have been rate-limited')).toBe(false)
  })
})
