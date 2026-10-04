// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sandbox daemon port, and the one RPC implementation of it.
 *
 * Both faces of P2.5 — the activator and the keepalive — talk to the sandbox
 * supervisor (Dormice) through this port and through nothing else. That is not
 * tidiness: it is what makes "this component cannot destroy a sandbox" a
 * property of three small files rather than a claim about the whole codebase.
 *
 * The port is an interface because the daemon is an **external system, not the
 * unit under test**. Substituting a local stand-in for it lets every line of
 * our own scheduling, backoff, allowlist and recovery logic run for real
 * against a real socket. It does **not** make any statement about how the real
 * daemon behaves — no test in this package can, and none claims to. What the
 * stand-in *does* now reproduce is the daemon's **wire shape**, which was
 * verified on the host on 2026-08-12 and is described in `capability.ts`.
 *
 * ## Sandboxes are addressed by name, not by id
 *
 * Both calls we are allowed to make key on the sandbox's `name`:
 * `acquireSandbox` takes `{ name }`, and `listSandboxes` returns rows carrying
 * both `id` and `name`. There is no by-id lookup in the API at all. Passing an
 * id where a name belongs would not fail loudly — `acquireSandbox` creates a
 * sandbox for an unknown name (its response carries `created: boolean`) — so it
 * would quietly stand up a second sandbox named after the first one's id. Hence
 * the parameter is called `sandboxName` everywhere in this package.
 *
 * Credentials are injected as a getter and read from the environment at most.
 * Nothing key-shaped is ever written down here.
 */

import type { AuditLog } from './audit.js'
import { DaemonOp, resolveRoute } from './capability.js'
import { type Clock, systemClock } from './clock.js'

/**
 * Lifecycle states this component distinguishes.
 *
 * `active` / `frozen` / `stopped` are the values observed on the host on
 * 2026-08-12 in `listSandboxes` rows. An earlier version of this file expected
 * `running`, which the daemon never emits.
 */
export type SandboxState =
  /** Executing; the idle timer is what it has to fear. */
  | 'active'
  /** Paused. Memory intact, clocks still advancing (E4). Wakes via `acquire`. */
  | 'frozen'
  /** Shut down. A wake means a cold start, not a thaw. */
  | 'stopped'
  /**
   * The daemon said something this version does not recognize.
   *
   * Deliberately its own value rather than being folded into one of the three
   * above: the policy rows carry an `archiveAfterSeconds`, so at least one more
   * state plausibly exists, and guessing which known state it resembles is how
   * a component ends up forwarding to a node that is not there.
   */
  | 'unknown'

/** A sandbox's lifecycle state as of one observation. */
export interface SandboxStatus {
  readonly sandboxName: string
  readonly state: SandboxState
}

/**
 * What this component can ask of the sandbox supervisor.
 *
 * Two members. There is no destructive member and there must never be one: the
 * daemon bearer has no privilege tiers and `destroySandbox` sits on the same
 * endpoint, so the surface declared here *is* the privilege boundary AC-6(c)
 * rests on (see `capability.ts`).
 */
export interface SandboxDaemon {
  /**
   * The daemon's single entry point: idempotent, wakes a frozen or stopped
   * sandbox, and — measured — resets the idle clock. Both faces use it, the
   * activator to wake and the keepalive to stay awake, because the daemon
   * offers no separate keep-alive verb.
   */
  acquire(sandboxName: string): Promise<SandboxStatus>
  /** Read lifecycle state, via `listSandboxes` plus a filter. */
  status(sandboxName: string): Promise<SandboxStatus>
}

/** The daemon answered, but not with success. */
export class DaemonRequestError extends Error {
  readonly op: string
  readonly httpStatus: number

  constructor(op: string, httpStatus: number, message: string) {
    super(`daemon ${op} failed with status ${httpStatus}: ${message}`)
    this.name = 'DaemonRequestError'
    this.op = op
    this.httpStatus = httpStatus
  }
}

/**
 * The daemon answered, and the sandbox we asked about was not in the answer.
 *
 * Its own error rather than a `state: 'unknown'` reading, because the two mean
 * different things to a caller: "the row says something new" is a parsing gap,
 * while "there is no such row" means the name is wrong or the sandbox is gone,
 * and the activator should fail the request explicitly instead of acquiring —
 * which, for an unknown name, would *create* a sandbox.
 */
export class SandboxNotFoundError extends Error {
  readonly sandboxName: string

  constructor(sandboxName: string, listed: number) {
    super(
      `no sandbox named ${JSON.stringify(sandboxName)} in the daemon's list of ${listed}`,
    )
    this.name = 'SandboxNotFoundError'
    this.sandboxName = sandboxName
  }
}

/** Environment variable the loopback daemon URL is injected through. */
export const DAEMON_URL_ENV_VAR = 'QIANMO_SANDBOX_DAEMON_URL'

/** Environment variable the bearer token is read from. Never a literal. */
export const DAEMON_TOKEN_ENV_VAR = 'QIANMO_SANDBOX_DAEMON_TOKEN'

/** Reads {@link DAEMON_TOKEN_ENV_VAR}, or throws if it is unset or blank. */
export function tokenFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[DAEMON_TOKEN_ENV_VAR]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${DAEMON_TOKEN_ENV_VAR} is unset; the daemon token is injected, never stored in the repository`,
    )
  }
  return value
}

/** Hosts that are on the machine and only on the machine. */
const LOOPBACK_HOSTS: readonly string[] = [
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]

/**
 * Refuse a daemon URL that is not on loopback.
 *
 * P0.7 measured what stands between a sandboxed agent and the full daemon API:
 * one thing, the daemon's loopback bind. Nothing in the firewall restricts
 * container-to-host traffic. If this component is ever pointed at a routable
 * address, it has published to the sandbox exactly the credential that AC-6(c)
 * depends on the sandbox never holding. So a non-loopback base URL is a
 * startup error, not a warning.
 */
export function assertLoopbackBaseUrl(baseUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`daemon base URL is not a URL: ${baseUrl}`)
  }
  const host = parsed.hostname.toLowerCase()
  const loopback =
    LOOPBACK_HOSTS.includes(host) ||
    // 127.0.0.0/8 in full, not just the one canonical address.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  if (!loopback) {
    throw new Error(
      `daemon base URL must stay on loopback, got host "${parsed.hostname}"; ` +
        'reaching the daemon from anywhere but the host machine breaks AC-6(c) (P0.7)',
    )
  }
  return parsed
}

/**
 * Sandbox names go into a JSON body, keep them boring anyway.
 *
 * Under the invented REST shape this check was load-bearing: the identifier was
 * interpolated into the URL, so a crafted one could pick the route. Under the
 * real shape the URL is built entirely from the allowlist and the identifier
 * never touches it, which is a genuine narrowing of the attack surface — the
 * check stays because a name the daemon will not accept is better refused here,
 * with the offending value named, than turned into a 4xx and a hunt.
 */
export function assertSandboxName(sandboxName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sandboxName)) {
    throw new Error(`not a usable sandbox name: ${JSON.stringify(sandboxName)}`)
  }
  return sandboxName
}

/** The slice of `fetch` this file uses. Injected so tests can be offline. */
export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<Response>

/** One daemon reply, already read. */
export interface DaemonResponse {
  readonly ok: boolean
  readonly status: number
  readonly body: unknown
}

/** Knobs of {@link HttpSandboxDaemon}. */
export interface HttpSandboxDaemonOptions {
  /** Must be on loopback — see {@link assertLoopbackBaseUrl}. */
  readonly baseUrl: string
  /** Called per request. A getter, so a rotated token is picked up. */
  readonly token: () => string
  readonly audit: AuditLog
  readonly fetch?: FetchLike
  readonly clock?: Clock
  /** Per-request ceiling. Short: a hung heartbeat is a freeze in waiting. */
  readonly timeoutMs?: number
}

/** Default per-request timeout. */
export const DEFAULT_DAEMON_TIMEOUT_MS = 5_000

/** One row of a `listSandboxes` answer, narrowed to what we read. */
interface SandboxRow {
  readonly name: string
  readonly state: SandboxState
}

/**
 * Map a `state` field onto {@link SandboxState}.
 *
 * Anything outside the three observed values becomes `unknown` rather than
 * being rounded to the nearest familiar state.
 */
function toState(raw: unknown): SandboxState {
  return raw === 'active' || raw === 'frozen' || raw === 'stopped'
    ? raw
    : 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Read the sandbox object out of an `acquireSandbox` answer.
 *
 * Observed shape: `{ status: 'ready' | 'restoring', created: boolean,
 * sandbox: { id, name, state, … } }`. Note that `status` there is the *call's*
 * outcome, not the lifecycle state — the lifecycle state is one level down, in
 * `sandbox.state`, and reading the wrong one would report `ready` for a sandbox
 * the daemon is still restoring.
 */
function parseAcquired(body: unknown, sandboxName: string): SandboxStatus {
  const sandbox = asRecord(asRecord(body)?.sandbox)
  return { sandboxName, state: toState(sandbox?.state) }
}

/**
 * Read the rows out of a `listSandboxes` answer.
 *
 * Observed shape: `{ sandboxes: [ { id, name, state, nodeId, endpoint, policy,
 * template, metadata, createdAt, lastActiveAt } ] }`.
 */
function parseSandboxRows(body: unknown): SandboxRow[] {
  const listed = asRecord(body)?.sandboxes
  if (!Array.isArray(listed)) return []
  const rows: SandboxRow[] = []
  for (const entry of listed) {
    const row = asRecord(entry)
    const name = row?.name
    if (typeof name === 'string')
      rows.push({ name, state: toState(row?.state) })
  }
  return rows
}

/**
 * RPC client for the sandbox daemon, restricted to the allowlist.
 *
 * `send` is public on purpose. Hiding the low-level door would be security by
 * obscurity, and DoD ③ asks for a *demonstrated* refusal of a destructive call,
 * which needs a door to knock on. The safety comes from the guard being on the
 * door: every request, from any caller, resolves through
 * {@link resolveRoute} first — which decides the path *and* the body.
 */
export class HttpSandboxDaemon implements SandboxDaemon {
  readonly #base: URL
  readonly #token: () => string
  readonly #audit: AuditLog
  readonly #fetch: FetchLike
  readonly #clock: Clock
  readonly #timeoutMs: number

  constructor(options: HttpSandboxDaemonOptions) {
    this.#base = assertLoopbackBaseUrl(options.baseUrl)
    this.#token = options.token
    this.#audit = options.audit
    const injected = options.fetch
    this.#fetch =
      injected ??
      ((input, init) => fetch(input, init as unknown as RequestInit))
    this.#clock = options.clock ?? systemClock
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS
  }

  /** The daemon this client talks to, for logs and assertions. */
  get baseUrl(): string {
    return this.#base.toString()
  }

  /**
   * The single chokepoint to the daemon's RPC surface.
   *
   * @param op Typed `string`, not `DaemonOp`: this is the layer that has to
   * hold when a caller has already cast past the enum.
   * @throws CapabilityDeniedError before any request is built, for any op
   * outside the allowlist — with an audit record written first.
   */
  async send(op: string, sandboxName: string): Promise<DaemonResponse> {
    assertSandboxName(sandboxName)
    const route = resolveRoute(op, sandboxName, this.#audit, this.#clock.now())
    // Keep any path prefix the base URL carries: a leading-slash path resolved
    // against the base would discard it, silently addressing a different
    // service on the same port.
    const prefix = this.#base.pathname.replace(/\/+$/, '')
    const url = new URL(`${prefix}${route.path}`, this.#base).toString()
    const response = await this.#fetch(url, {
      method: route.method,
      headers: {
        // Injected per call; never read from a file in this repository.
        authorization: `Bearer ${this.#token()}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(route.body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // A body-less answer is still an answer; the status carries the verdict.
      body = null
    }
    return { ok: response.ok, status: response.status, body }
  }

  async #expectOk(op: DaemonOp, sandboxName: string): Promise<DaemonResponse> {
    const response = await this.send(op, sandboxName)
    if (!response.ok) {
      throw new DaemonRequestError(
        op,
        response.status,
        JSON.stringify(response.body),
      )
    }
    return response
  }

  async acquire(sandboxName: string): Promise<SandboxStatus> {
    const response = await this.#expectOk(DaemonOp.AcquireSandbox, sandboxName)
    return parseAcquired(response.body, sandboxName)
  }

  /**
   * The API has no by-name read, so this is a list plus a filter.
   *
   * A name that is not in the list is a {@link SandboxNotFoundError}, not a
   * state — see that error for why the distinction matters here.
   */
  async status(sandboxName: string): Promise<SandboxStatus> {
    const response = await this.#expectOk(DaemonOp.ListSandboxes, sandboxName)
    const rows = parseSandboxRows(response.body)
    const row = rows.find(candidate => candidate.name === sandboxName)
    if (row === undefined) {
      throw new SandboxNotFoundError(sandboxName, rows.length)
    }
    return { sandboxName, state: row.state }
  }
}
