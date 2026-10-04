// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The startup liveness probe (issue #37 ①).
 *
 * What is being pinned is not "the function returns a value" — it is the two
 * judgements the probe exists to make, both of which were wrong by omission
 * before it existed:
 *
 *   1. a *refused* credential is loud at startup, in `<node>.err`, seconds
 *      after boot, instead of surfacing 120 seconds into the first task as an
 *      error about model latency; and
 *   2. everything that is not a refusal stays silent, because a warning that
 *      also fires on healthy nodes is a warning operators learn to skip.
 *
 * Driven entirely through an injected `fetch`, so there is no network and no
 * `mock.module` — the resolver is pure and the prober takes its transport as
 * an argument precisely to make that possible.
 */
import { describe, expect, test } from 'bun:test'
import {
  probeResidentModel,
  resolveResidentModelProbeTarget,
  warnRefusedModelCredentials,
  warnUnavailableModelCredentialProbe,
  type ResidentModelProbeInputs,
  type ResidentModelProbeTarget,
  type ResidentModelProbeVerdict,
} from '../residentModelProbe.js'
import { runResidentModelCredentialProbe } from '../resident.js'

function inputs(
  overrides: Partial<ResidentModelProbeInputs> = {},
): ResidentModelProbeInputs {
  return {
    provider: 'firstParty',
    model: 'claude-haiku-5',
    env: {},
    anthropicAuthHeaders: () => ({}),
    ...overrides,
  }
}

/** A `fetch` that answers with one status and body, and records what it saw. */
function fetchAnswering(
  status: number,
  body = '',
): typeof fetch & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status })
  }) as typeof fetch & { calls: { url: string; init: RequestInit }[] }
  impl.calls = calls
  return impl
}

function assertTarget(
  resolved: ResidentModelProbeTarget | { status: 'skipped'; detail: string },
): ResidentModelProbeTarget {
  if ('status' in resolved) {
    throw new Error(`expected a target, got skipped: ${resolved.detail}`)
  }
  return resolved
}

describe('where the probe request goes', () => {
  test('an OpenAI-compatible session probes chat/completions with its bearer', () => {
    const target = assertTarget(
      resolveResidentModelProbeTarget(
        inputs({
          provider: 'openai',
          model: 'gpt-5',
          env: {
            OPENAI_API_KEY: 'sk-test',
            OPENAI_BASE_URL: 'https://gateway.example/proxy/v1',
          },
        }),
      ),
    )
    expect(target.url).toBe('https://gateway.example/proxy/v1/chat/completions')
    expect(target.headers.authorization).toBe('Bearer sk-test')
    expect(target.body.max_tokens).toBe(1)
    expect(target.body.stream).toBe(false)
  })

  test('OPENAI_WIRE_API=responses probes the other route', () => {
    const target = assertTarget(
      resolveResidentModelProbeTarget(
        inputs({
          provider: 'openai',
          env: { OPENAI_API_KEY: 'sk-test', OPENAI_WIRE_API: 'responses' },
        }),
      ),
    )
    expect(target.url).toBe('https://api.openai.com/v1/responses')
    // The Responses API rejects a smaller ceiling outright, which would make
    // the probe report a configuration fault that does not exist.
    expect(target.body.max_output_tokens).toBe(16)
  })

  test('the Anthropic wire sends whatever this session would really send', () => {
    // Including a mirrored credential: DeepSeek and OpenCode write their own
    // key into the Anthropic keys, and testing anything else would be testing
    // a request the node never makes.
    const target = assertTarget(
      resolveResidentModelProbeTarget(
        inputs({
          anthropicAuthHeaders: () => ({ 'x-api-key': 'mirrored-key' }),
          env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
        }),
      ),
    )
    expect(target.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(target.headers['x-api-key']).toBe('mirrored-key')
    expect(target.headers['anthropic-version']).toBe('2023-06-01')
  })

  test('the endpoint shown to the operator carries no credential', () => {
    // Some gateways take the key in the query string. The warning line is
    // written to a log file that gets pasted into issues.
    const target = assertTarget(
      resolveResidentModelProbeTarget(
        inputs({
          provider: 'openai',
          env: {
            OPENAI_API_KEY: 'sk-test',
            OPENAI_BASE_URL: 'https://gw.example/v1?key=super-secret',
          },
        }),
      ),
    )
    expect(target.endpoint).not.toContain('super-secret')
    expect(target.url).toContain('super-secret')
  })

  test('configurations with no request to build say so instead of guessing', () => {
    for (const [input, fragment] of [
      [inputs({ provider: 'bedrock' }), 'credential chain'],
      [inputs({ provider: 'vertex' }), 'credential chain'],
      [inputs({ provider: 'foundry' }), 'credential chain'],
      [
        inputs({ provider: 'openai', env: { OPENAI_AUTH_MODE: 'chatgpt' } }),
        'Codex backend',
      ],
      [inputs({ provider: 'openai' }), 'no OPENAI_API_KEY'],
      [
        inputs({
          provider: 'gemini',
          env: { GEMINI_AUTH_MODE: 'antigravity' },
        }),
        'Antigravity',
      ],
      [inputs({}), 'no Anthropic-wire credential'],
    ] as const) {
      const resolved = resolveResidentModelProbeTarget(input)
      expect('status' in resolved && resolved.status).toBe('skipped')
      expect('detail' in resolved && resolved.detail).toContain(fragment)
    }
  })

  test('a lane that does not speak the Anthropic wire never asks for its headers', () => {
    // Resolved eagerly, this ran ahead of the provider switch and every lane
    // paid for the Anthropic credential stack. That stack throws on its own
    // account — set `CI` with no `ANTHROPIC_API_KEY` and
    // getAnthropicApiKeyWithSource() raises "ANTHROPIC_API_KEY or
    // CLAUDE_CODE_OAUTH_TOKEN env var is required" from a CI-only branch — so
    // an OpenAI node holding a perfectly good key had its probe blinded by a
    // credential it does not use. Verified against a real `qm resident`:
    // zero requests reached the stub upstream.
    let asked = 0
    const target = assertTarget(
      resolveResidentModelProbeTarget(
        inputs({
          provider: 'openai',
          env: { OPENAI_API_KEY: 'sk-test' },
          anthropicAuthHeaders: () => {
            asked += 1
            throw new Error(
              'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required',
            )
          },
        }),
      ),
    )
    expect(asked).toBe(0)
    expect(target.url).toBe('https://api.openai.com/v1/chat/completions')
  })

  test('the Anthropic lane still surfaces its own credential stack failing', () => {
    // The other half of the same rule: deferring must not become swallowing.
    // A node that really does speak this wire and cannot resolve its headers
    // has no probe, and `runResidentModelCredentialProbe` turns that throw
    // into an `unavailable` verdict that prints — see below.
    expect(() =>
      resolveResidentModelProbeTarget(
        inputs({
          anthropicAuthHeaders: () => {
            throw new Error('Config accessed before allowed.')
          },
        }),
      ),
    ).toThrow('Config accessed before allowed.')
  })
})

describe('what the endpoint answering means', () => {
  const target = assertTarget(
    resolveResidentModelProbeTarget(
      inputs({ provider: 'openai', env: { OPENAI_API_KEY: 'sk-test' } }),
    ),
  )

  test('401 / 403 / 407 are the credential being refused', async () => {
    for (const status of [401, 403, 407]) {
      const verdict = await probeResidentModel(target, {
        fetchImpl: fetchAnswering(status, '{"error":"Invalid API key"}'),
      })
      expect(verdict.status).toBe('refused')
      if (verdict.status !== 'refused') throw new Error('unreachable')
      expect(verdict.httpStatus).toBe(status)
      expect(verdict.detail).toContain('Invalid API key')
    }
  })

  test('a wrong model, a wrong path or a broken gateway are not', async () => {
    // All of these prove the request got past authentication and was judged on
    // its merits. Telling an operator to rotate a key over a 404 sends them to
    // fix something that was never broken.
    for (const status of [200, 400, 404, 429, 500, 503]) {
      const verdict = await probeResidentModel(target, {
        fetchImpl: fetchAnswering(status),
      })
      expect(verdict).toEqual({ status: 'reachable', httpStatus: status })
    }
  })

  test('the probe sends one small POST and nothing else', async () => {
    const impl = fetchAnswering(200)
    await probeResidentModel(target, { fetchImpl: impl })
    expect(impl.calls.length).toBe(1)
    expect(impl.calls[0]!.init.method).toBe('POST')
    const body = JSON.parse(String(impl.calls[0]!.init.body)) as {
      max_tokens: number
    }
    expect(body.max_tokens).toBe(1)
  })

  test('a transport failure is unreachable, never a refusal', async () => {
    const verdict = await probeResidentModel(target, {
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    expect(verdict).toEqual({
      status: 'unreachable',
      detail: 'fetch failed',
    })
  })

  test('an endpoint that never answers times out instead of hanging startup', async () => {
    const verdict = await probeResidentModel(target, {
      timeoutMs: 5,
      fetchImpl: (async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        })) as unknown as typeof fetch,
    })
    expect(verdict.status).toBe('unreachable')
    if (verdict.status !== 'unreachable') throw new Error('unreachable')
    expect(verdict.detail).toContain('5ms')
  })
})

describe('what the operator is told', () => {
  function warningFor(verdict: ResidentModelProbeVerdict): string[] {
    const lines: string[] = []
    warnRefusedModelCredentials(verdict, message => lines.push(message))
    return lines
  }

  test('a refusal is loud and names the endpoint and the status', () => {
    const lines = warningFor({
      status: 'refused',
      httpStatus: 401,
      endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
      detail: '{"error":"Invalid API key"}',
    })
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('REFUSED')
    expect(lines[0]).toContain('HTTP 401')
    expect(lines[0]).toContain('api.deepseek.com')
    // The whole point: it says the node looks healthy and is not, and it names
    // the restart, because the ACP child inherits this process's environment.
    expect(lines[0]).toContain('inactivity watchdog')
    expect(lines[0]).toContain('restart this node')
  })

  test('everything else keeps <node>.err at zero bytes', () => {
    // Same discipline as warnMissingModelCredentials and
    // warnUnselectedTaskPolicy: these warnings earn attention by being rare.
    expect(warningFor({ status: 'reachable', httpStatus: 200 })).toEqual([])
    expect(warningFor({ status: 'reachable', httpStatus: 500 })).toEqual([])
    expect(
      warningFor({ status: 'skipped', detail: 'nothing to test' }),
    ).toEqual([])
    expect(
      warningFor({ status: 'unreachable', detail: 'no answer within 10000ms' }),
    ).toEqual([])
    expect(
      warningFor({ status: 'unavailable', detail: 'probe could not be built' }),
    ).toEqual([])
  })

  function unavailableWarningFor(verdict: ResidentModelProbeVerdict): string[] {
    const lines: string[] = []
    warnUnavailableModelCredentialProbe(verdict, message => lines.push(message))
    return lines
  }

  test('"nobody asked" is said out loud, and distinguished from "no answer"', () => {
    const lines = unavailableWarningFor({
      status: 'unavailable',
      detail: 'Config accessed before allowed.',
    })
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('could not run')
    expect(lines[0]).toContain('Config accessed before allowed.')
    // One full stop, not two: the detail already ends in one.
    expect(lines[0]).not.toContain('allowed..')
    expect(lines[0]).toContain('nobody asked')
  })

  test('an endpoint that merely did not answer still says nothing', () => {
    // The distinction the two statuses exist for. `unreachable` is routine on a
    // node a supervisor starts before the network is up; warning there would
    // fire on healthy nodes and train people past both lines.
    expect(
      unavailableWarningFor({
        status: 'unreachable',
        detail: 'no answer within 10000ms',
      }),
    ).toEqual([])
    expect(
      unavailableWarningFor({ status: 'reachable', httpStatus: 200 }),
    ).toEqual([])
    expect(
      unavailableWarningFor({ status: 'skipped', detail: 'nothing to test' }),
    ).toEqual([])
    expect(
      unavailableWarningFor({
        status: 'refused',
        httpStatus: 401,
        endpoint: 'https://api.anthropic.com/v1/messages',
        detail: 'nope',
      }),
    ).toEqual([])
  })
})

describe('the probe as the resident startup runs it', () => {
  test('a refused key warns, and reports the status the watchdog will use', async () => {
    const lines: string[] = []
    const verdict = await runResidentModelCredentialProbe({
      hasCredential: true,
      inputs: inputs({
        provider: 'openai',
        env: { OPENAI_API_KEY: 'sk-dead' },
      }),
      fetchImpl: fetchAnswering(401, '{"error":"Invalid API key"}'),
      warn: message => lines.push(message),
    })
    expect(verdict.status).toBe('refused')
    expect(lines.length).toBe(1)
  })

  test('a node with no credential at all is left to the other warning', async () => {
    // warnMissingModelCredentials has already said it, in more useful words.
    // Two warnings for one fault teach people to read neither.
    const lines: string[] = []
    const verdict = await runResidentModelCredentialProbe({
      hasCredential: false,
      warn: message => lines.push(message),
    })
    expect(verdict).toEqual({
      status: 'skipped',
      detail: 'no model credential is visible',
    })
    expect(lines).toEqual([])
  })

  test('a base URL that cannot even be parsed is reported, not thrown', async () => {
    // Startup must not die because a probe could not be built — but it must
    // not go quiet either. An unparseable OPENAI_BASE_URL is never a healthy
    // node's configuration, so this is `unavailable` rather than `skipped`,
    // and it says so once.
    const lines: string[] = []
    const verdict = await runResidentModelCredentialProbe({
      hasCredential: true,
      inputs: inputs({
        provider: 'openai',
        env: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'not a url' },
      }),
      fetchImpl: fetchAnswering(200),
      warn: message => lines.push(message),
    })
    expect(verdict.status).toBe('unavailable')
    expect(lines.length).toBe(1)
  })

  test('the exact throw that made this probe dead code now speaks', async () => {
    // The regression under test, in miniature. `qm resident` is a fast path in
    // entrypoints/cli.tsx, so for the whole of PR #50's life it ran before any
    // enableConfigs() and `getAuthHeaders()` threw `Config accessed before
    // allowed.` on every node — first line of residentModelProbeInputs(),
    // ahead of the provider switch, so no provider escaped it. The throw was
    // caught, turned into `skipped`, and never printed: zero requests sent,
    // zero bytes in <node>.err, and a full unit suite green underneath.
    //
    // Two independent guards now stand where that hole was: this one keeps the
    // failure *audible*, and tests/integration/qianmo-resident-startup-probe
    // keeps it from happening at all by running a real `qm resident`.
    const lines: string[] = []
    const verdict = await runResidentModelCredentialProbe({
      hasCredential: true,
      environment: {
        getAPIProvider: () => 'firstParty',
        getSmallFastModel: () => 'claude-haiku-5',
        getAuthHeaders: () => {
          throw new Error('Config accessed before allowed.')
        },
      },
      fetchImpl: fetchAnswering(200),
      warn: message => lines.push(message),
    })
    expect(verdict).toEqual({
      status: 'unavailable',
      detail: 'Config accessed before allowed.',
    })
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('Config accessed before allowed')
    // It must not read as a verdict on the credential — nothing was asked.
    expect(lines[0]).toContain('does NOT know')
    expect(lines[0]).not.toContain('REFUSED')
  })

  test('an unbuildable probe never reaches the network', async () => {
    // The failure it replaces was invisible precisely because no request was
    // sent; pin that the verdict and the absence of traffic agree.
    const fetchImpl = fetchAnswering(200)
    const verdict = await runResidentModelCredentialProbe({
      hasCredential: true,
      environment: {
        getAPIProvider: () => 'firstParty',
        getSmallFastModel: () => 'claude-haiku-5',
        getAuthHeaders: () => {
          throw new Error('Config accessed before allowed.')
        },
      },
      fetchImpl,
      warn: () => {},
    })
    expect(verdict.status).toBe('unavailable')
    expect(fetchImpl.calls).toEqual([])
  })
})
