// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Does this node's model credential actually work?
 *
 * `warnMissingModelCredentials` answers a different, weaker question: is a
 * credential *visible*. A node whose API key had been revoked passed that
 * check, printed a clean banner, listened on its port, accepted tasks with
 * `receipt: "accepted"` — and then burned 120 seconds of silence per task
 * before reporting `ResidentInactivityError`, an error about model latency.
 * The endpoint had been answering `HTTP 401 {"error":"Invalid API key"}` in 44
 * milliseconds the whole time (issue #37).
 *
 * So this asks the endpoint. One request, the smallest the wire allows, at
 * startup, on the same environment the ACP child will inherit.
 *
 * ## What the verdict does and does not mean
 *
 * The question is deliberately narrow: **was the credential refused**. A 400
 * on a model id, a 404 on a path, a 500 from a gateway — all of those are
 * `reachable`, because they prove the request was authenticated far enough to
 * be judged on its merits, and none of them is something an operator should be
 * told to go rotate a key over. Only 401/403/407 are a refusal.
 *
 * That narrowness is also why the probe's model id barely matters: it is taken
 * from the same resolution the session will use, but a wrong one would still
 * answer the question being asked.
 *
 * ## Why it is hand-built rather than routed through the provider SDKs
 *
 * The SDK path drags in client caches, retry ladders and streaming assembly,
 * all of which exist to make a *turn* work and none of which help here — and
 * the retry ladders in particular would sit on a 401 for tens of seconds,
 * which is the very failure mode being diagnosed. A single `fetch` with an
 * injectable implementation is also the only shape that is testable without a
 * process-global module mock.
 */

import { invokedBinName } from '../../constants/brand.js'
import { buildProviderResourceURL } from '../../utils/network/providerUrl.js'

/** Where one probe request goes, and what it carries. */
export type ResidentModelProbeTarget = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Readonly<Record<string, unknown>>
  /**
   * Origin + path only, for the warning line. Never carries a credential —
   * query strings are dropped precisely because some gateways put keys there.
   */
  readonly endpoint: string
}

export type ResidentModelProbeVerdict =
  /** Nothing was asked, and the reason is not a fault. */
  | { readonly status: 'skipped'; readonly detail: string }
  /**
   * Nothing was asked because the probe could not be *built* — an exception,
   * not an answer.
   *
   * Split out of `skipped` on purpose. `skipped` is a **decision** this file
   * made and can defend ("Bedrock signs through its own credential chain",
   * "no OPENAI_API_KEY to test"); it is an expected outcome on healthy nodes,
   * so it stays silent. This one is the diagnostic failing at its own job,
   * which is never expected and never self-evident — and folding the two
   * together is exactly how the first version of this probe shipped dead:
   * `residentModelProbeInputs()` threw on every real node, the throw became a
   * `skipped` nobody printed, and a check written to end silent failures spent
   * its whole life failing silently.
   */
  | { readonly status: 'unavailable'; readonly detail: string }
  /** The endpoint answered something that is not a credential refusal. */
  | { readonly status: 'reachable'; readonly httpStatus: number }
  /** 401 / 403 / 407 — the credential itself was rejected. */
  | {
      readonly status: 'refused'
      readonly httpStatus: number
      readonly endpoint: string
      readonly detail: string
    }
  /** No answer at all: DNS, TLS, connection refused, or the probe timed out. */
  | { readonly status: 'unreachable'; readonly detail: string }

/**
 * Live inputs the pure resolver needs. Gathered by the caller so that
 * {@link resolveResidentModelProbeTarget} stays a function of its arguments.
 */
export type ResidentModelProbeInputs = {
  /** `getAPIProvider()` — which wire this session speaks. */
  readonly provider: string
  /** `getSmallFastModel()` — the cheapest model this configuration resolves. */
  readonly model: string
  readonly env: NodeJS.ProcessEnv
  /**
   * `getAuthHeaders()` for the Anthropic wire: `x-api-key` for a key,
   * `Authorization: Bearer` plus the OAuth beta header for a subscription.
   * Empty means "nothing usable", which the resolver reports as skipped.
   *
   * **A thunk, not a value, and the difference is not style.** Resolved
   * eagerly it ran ahead of the provider switch below, so every lane paid for
   * the Anthropic credential stack whether or not it speaks that wire — and
   * that stack throws for reasons of its own. Demonstrated: an
   * OpenAI-lane node holding a perfectly good `OPENAI_API_KEY`, on a machine
   * with `CI` set and no `ANTHROPIC_API_KEY`, has `getAnthropicApiKeyWithSource()`
   * throw `ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required`
   * from a branch that exists only for CI — and the probe that was going to
   * check the OpenAI key never gets built. Deferred, only the lane that needs
   * these headers can be blinded by them.
   *
   * The resolver stays pure in the sense that matters: it still reads nothing
   * this object did not hand it.
   */
  readonly anthropicAuthHeaders: () => Readonly<Record<string, string>>
}

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_GROK_BASE_URL = 'https://api.x.ai/v1'
const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta'
const ANTHROPIC_VERSION = '2023-06-01'

/** Enough of an answer to be judged; not enough to cost anything. */
const PROBE_MAX_TOKENS = 1
/** The Responses API rejects anything under 16. */
const PROBE_MAX_OUTPUT_TOKENS = 16

const CREDENTIAL_REFUSED_STATUSES = new Set([401, 403, 407])

function skip(detail: string): { status: 'skipped'; detail: string } {
  return { status: 'skipped', detail }
}

/** Origin + path, with credentials and query stripped. */
function sanitizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return '[unparseable endpoint]'
  }
}

function openAICompatibleTarget(input: {
  baseURL: string
  apiKey: string
  model: string
  responses: boolean
}): ResidentModelProbeTarget {
  const url = buildProviderResourceURL(
    input.baseURL,
    'openai',
    input.responses ? 'responses' : 'chat/completions',
  )
  return {
    url,
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: input.responses
      ? {
          model: input.model,
          input: 'ping',
          max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
          stream: false,
        }
      : {
          model: input.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: PROBE_MAX_TOKENS,
          stream: false,
        },
    endpoint: sanitizeEndpoint(url),
  }
}

/**
 * Build the one request that answers "is this credential accepted", or say why
 * no such request exists for this configuration.
 *
 * Pure: everything it reads arrives in `input`.
 */
export function resolveResidentModelProbeTarget(
  input: ResidentModelProbeInputs,
): ResidentModelProbeTarget | { status: 'skipped'; detail: string } {
  const { env, model, provider } = input

  // Bedrock / Vertex / Foundry sign every request from an ambient credential
  // chain (SigV4, ADC, Entra) that lives inside the vendor SDKs. A hand-built
  // request would be testing this file's idea of those protocols rather than
  // the node's credentials, and a false alarm here is worse than no probe.
  if (
    provider === 'bedrock' ||
    provider === 'vertex' ||
    provider === 'foundry'
  ) {
    return skip(`${provider} signs requests through its own credential chain`)
  }

  if (provider === 'openai') {
    // The ChatGPT-subscription backend is Codex's, not the public API: it
    // wants client fingerprint headers this file has no business reproducing.
    if (env.OPENAI_AUTH_MODE === 'chatgpt') {
      return skip('ChatGPT subscription auth uses the Codex backend')
    }
    const apiKey = env.OPENAI_API_KEY ?? ''
    if (!apiKey) return skip('no OPENAI_API_KEY to test')
    return openAICompatibleTarget({
      baseURL: env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
      apiKey,
      model,
      responses: env.OPENAI_WIRE_API?.trim().toLowerCase() === 'responses',
    })
  }

  if (provider === 'grok') {
    const apiKey = env.GROK_API_KEY || env.XAI_API_KEY || ''
    if (!apiKey) return skip('no GROK_API_KEY / XAI_API_KEY to test')
    return openAICompatibleTarget({
      baseURL: env.GROK_BASE_URL || DEFAULT_GROK_BASE_URL,
      apiKey,
      model,
      responses: false,
    })
  }

  if (provider === 'gemini') {
    // Antigravity is an OAuth-fronted backend with its own request envelope.
    if (env.GEMINI_AUTH_MODE === 'antigravity') {
      return skip('Antigravity auth uses its own request envelope')
    }
    const apiKey = env.GEMINI_API_KEY ?? ''
    if (!apiKey) return skip('no GEMINI_API_KEY to test')
    const modelPath = model.replace(/^\/+/, '').replace(/^models\//, '')
    const url = buildProviderResourceURL(
      env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      'gemini',
      `models/${modelPath}:generateContent`,
    )
    return {
      url,
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: PROBE_MAX_TOKENS },
      },
      endpoint: sanitizeEndpoint(url),
    }
  }

  // Everything else speaks the Anthropic Messages wire — first party, a
  // gateway, DeepSeek's `/anthropic` route, OpenCode's `/messages` lane. The
  // auth headers are whatever this session would really send, resolved by the
  // caller, so a mirrored credential is tested as the mirror wrote it.
  const headers = input.anthropicAuthHeaders()
  if (Object.keys(headers).length === 0) {
    return skip('no Anthropic-wire credential to test')
  }
  const url = buildProviderResourceURL(
    env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL,
    'anthropic',
    'v1/messages',
  )
  return {
    url,
    headers: {
      ...headers,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
    },
    endpoint: sanitizeEndpoint(url),
  }
}

/** Trim a response body to something that fits on one warning line. */
function summarize(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return 'no response body'
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed
}

/**
 * Ask the endpoint, once.
 *
 * Never throws and never retries: this is a diagnostic run before the node is
 * listening, and neither an exception nor a retry ladder would leave the
 * operator better off than a verdict of `unreachable`.
 */
export async function probeResidentModel(
  target: ResidentModelProbeTarget,
  options: {
    readonly fetchImpl?: typeof fetch
    readonly timeoutMs?: number
  } = {},
): Promise<ResidentModelProbeVerdict> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 10_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: { ...target.headers },
      body: JSON.stringify(target.body),
      signal: controller.signal,
    })
    if (!CREDENTIAL_REFUSED_STATUSES.has(response.status)) {
      return { status: 'reachable', httpStatus: response.status }
    }
    const body = await response.text().catch(() => '')
    return {
      status: 'refused',
      httpStatus: response.status,
      endpoint: target.endpoint,
      detail: summarize(body),
    }
  } catch (error) {
    // `aborted` is only ever set by the timer above — this probe has no other
    // cancellation path — so it separates "took too long" from "was refused a
    // connection", which are different things to tell an operator.
    return {
      status: 'unreachable',
      detail: controller.signal.aborted
        ? `no answer within ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Say, once at startup, that the endpoint refused this node's credential.
 *
 * Only `refused` warns. `unreachable` deliberately stays silent: a node
 * started by a supervisor often runs before the network is up, and a warning
 * that fires on healthy nodes is a warning people learn to skip — the same
 * rule {@link warnMissingModelCredentials} and `warnUnselectedTaskPolicy`
 * follow, and the reason `<node>.err` staying at zero bytes is worth
 * protecting.
 *
 * Returns whether it warned, so the caller can assert on it.
 */
export function warnRefusedModelCredentials(
  verdict: ResidentModelProbeVerdict,
  warn: (message: string) => void = message => {
    process.stderr.write(`${message}\n`)
  },
): boolean {
  if (verdict.status !== 'refused') return false
  warn(
    `[resident] this node's model endpoint REFUSED its credential: HTTP ${verdict.httpStatus} from ` +
      `${verdict.endpoint} — ${verdict.detail}. The credential is present, which is why the startup ` +
      'checks passed; it is not accepted, so every task woken here will be admitted, receipted, ' +
      'audited — and then produce nothing until the inactivity watchdog fails it. ' +
      'The ACP child inherits this process environment, so the fix has to be in place before the ' +
      'resident starts: rotate the key (or re-login) and restart this node.',
  )
  return true
}

/**
 * Say, once at startup, that the credential check itself did not run.
 *
 * **`unavailable` is not `unreachable`, and the difference is the whole point
 * of having two statuses.** `unreachable` means the question was asked and the
 * endpoint did not answer — routine on a node a supervisor starts before the
 * network is up, so it stays silent for the reason
 * {@link warnRefusedModelCredentials} gives. `unavailable` means the question
 * was never asked: no request left this process, and the operator's mental
 * model ("startup would have told me if the credential were dead") is wrong
 * without anything on the node saying so.
 *
 * That is the same shape as the fault this whole file exists to end (issue
 * #37), one level up — so it gets a line, and it is worded to say what the
 * node does *not* know rather than to imply a verdict it never reached.
 *
 * Returns whether it warned, so the caller can assert on it.
 */
export function warnUnavailableModelCredentialProbe(
  verdict: ResidentModelProbeVerdict,
  warn: (message: string) => void = message => {
    process.stderr.write(`${message}\n`)
  },
): boolean {
  if (verdict.status !== 'unavailable') return false
  warn(
    // `Error.message` usually ends in a full stop of its own and sometimes
    // does not; the line reads as a sentence either way only if exactly one
    // survives.
    `[resident] the startup model-credential check could not run: ${verdict.detail.replace(/[.\s]+$/, '')}. ` +
      'Nothing was sent, so this node does NOT know whether its credential is accepted — a revoked ' +
      'one would still let it print a clean banner, admit tasks and receipt them, and only surface ' +
      'as an inactivity timeout two minutes into each one. This is different from an endpoint that ' +
      'did not answer, which is normal at boot and stays silent on purpose: here nobody asked. ' +
      `Run \`${invokedBinName()} auth status\` with this node's OCC_CONFIG_DIR to check the ` +
      'credential by hand until this is fixed.',
  )
  return true
}
