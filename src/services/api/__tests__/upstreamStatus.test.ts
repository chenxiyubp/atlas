// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel that lets an out-of-process observer see an HTTP status the
 * request itself already swallowed (issue #37 ②).
 *
 * The failure this closes: a resident node's inactivity watchdog runs in the
 * parent process, the ACP child is the only one that talks to a model
 * endpoint, and the retry ladders answer a 401 by quietly trying again. From
 * outside, a refused credential and a slow model are the same silence — which
 * is how a dead API key came back as "produced no activity for 120000ms".
 *
 * The second describe block drives the **real** OpenAI-compatible retry ladder
 * rather than asserting the reporter in isolation: the thing that regresses is
 * the call site, not the registry. No `mock.module` — `retry.ts` is importable
 * as-is, which is why the assertion can be about the ladder at all.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  readUpstreamHttpStatus,
  registerUpstreamStatusCallback,
  reportUpstreamFailure,
  unregisterUpstreamStatusCallback,
  type UpstreamStatusReport,
} from '../upstreamStatus.js'
import { OpenAIRequestError, retryOpenAIRequest } from '../openai/retry.js'

/** Collect reports for one test, and always hand the sink back afterwards. */
function collecting(): UpstreamStatusReport[] {
  const seen: UpstreamStatusReport[] = []
  registerUpstreamStatusCallback(report => seen.push(report))
  return seen
}

afterEach(() => {
  // The sink is process-global by design (see the module comment). Leaving one
  // installed would make this file's subscriber the observer for every test
  // that runs after it in the same worker.
  unregisterUpstreamStatusCallback()
})

describe('reading a status off whatever an API layer threw', () => {
  test('finds it on every client shape in this repo', () => {
    // Anthropic SDK APIError, OpenAI SDK APIError, OpenAIRequestError and
    // GeminiRequestError all spell it `status`; one property read covers them
    // without importing four classes.
    expect(readUpstreamHttpStatus({ status: 401 })).toBe(401)
    expect(
      readUpstreamHttpStatus(
        new OpenAIRequestError('x', {
          retryable: false,
          status: 403,
        }),
      ),
    ).toBe(403)
    // OpenAI-compatible error bodies sometimes carry it as a string.
    expect(readUpstreamHttpStatus({ status: '429' })).toBe(429)
  })

  test('refuses to invent one', () => {
    // A transport failure never got an answer, and "no answer" is a different
    // diagnosis from "the answer was 401". Inventing a status here would let
    // the watchdog blame a credential for a network outage.
    for (const shape of [
      undefined,
      null,
      new TypeError('fetch failed'),
      { status: 'unauthorized' },
      { status: 99 },
      { status: 600 },
      { status: 401.5 },
      { statusCode: 401 },
    ]) {
      expect(readUpstreamHttpStatus(shape)).toBeUndefined()
    }
  })

  test('a failure with no status reports nothing at all', () => {
    const seen = collecting()
    reportUpstreamFailure(new TypeError('fetch failed'))
    expect(seen).toEqual([])
  })

  test('a sink that throws cannot fail the request it describes', () => {
    registerUpstreamStatusCallback(() => {
      throw new Error('the ACP link is already gone')
    })
    expect(() => reportUpstreamFailure({ status: 401 })).not.toThrow()
  })

  test('with nobody listening it is a no-op', () => {
    unregisterUpstreamStatusCallback()
    expect(() => reportUpstreamFailure({ status: 401 })).not.toThrow()
  })
})

describe('the retry ladder reports every attempt', () => {
  const noDelay = async (): Promise<void> => {}

  test('a refused credential is visible even though the ladder retries it', async () => {
    // 401 is on the retryable list, so the ladder sits on it and the caller
    // sees nothing for as long as the retries last. That window is exactly
    // the 120 seconds of "no activity" the watchdog was reporting.
    const seen = collecting()
    const error = new OpenAIRequestError('unauthorized', {
      retryable: true,
      status: 401,
    })
    await expect(
      retryOpenAIRequest(
        async () => {
          throw error
        },
        {
          signal: new AbortController().signal,
          maxRetries: 2,
          delay: noDelay,
        },
      ),
    ).rejects.toBe(error)

    // Three attempts, three reports: the observer learns on the first one,
    // long before the ladder gives up.
    expect(seen).toEqual([{ status: 401 }, { status: 401 }, { status: 401 }])
  })

  test('a successful request reports nothing', async () => {
    const seen = collecting()
    await expect(
      retryOpenAIRequest(async () => 'ok', {
        signal: new AbortController().signal,
        delay: noDelay,
      }),
    ).resolves.toBe('ok')
    // Failures only: a notice per successful call would put a message on the
    // ACP wire for every request a healthy node makes.
    expect(seen).toEqual([])
  })
})
