// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  InMemoryRegistry,
  RegistryErrorCode,
  type AgentRecord,
  type RegisterResult,
} from './registry.js'
import { assertRegistryWriteToken, registryWriteTokenMatches } from './token.js'

/** Prefix of every route in this API version. */
export const API_PREFIX = '/v0'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
} as const

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

function fail(
  status: number,
  code: RegistryErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, headers)
}

function notFound(message: string): Response {
  return fail(404, RegistryErrorCode.E_NOT_FOUND, message)
}

function methodNotAllowed(allowed: readonly string[]): Response {
  return fail(
    405,
    RegistryErrorCode.E_BAD_REQUEST,
    `allowed methods: ${allowed.join(', ')}`,
    {
      allow: allowed.join(', '),
    },
  )
}

function agentBody(entry: AgentRecord): Record<string, unknown> {
  return {
    address: entry.address,
    endpoint: entry.endpoint,
    capabilities: entry.capabilities,
    // Dropped from the JSON when absent — no key has been published yet.
    publicKey: entry.publicKey,
    // Same rule (§5.2): absent until the registrant has adopted certificates.
    certificate: entry.certificate,
    status: entry.status,
    registeredAt: entry.registeredAt,
    lastHeartbeatAt: entry.lastHeartbeatAt,
    expiresAt: entry.expiresAt,
  }
}

function statusFor(code: RegistryErrorCode): number {
  switch (code) {
    case RegistryErrorCode.E_BAD_REQUEST:
      return 400
    case RegistryErrorCode.E_UNAUTHORIZED:
      return 401
    case RegistryErrorCode.E_CONFLICT:
      return 409
    case RegistryErrorCode.E_NOT_FOUND:
      return 404
    case RegistryErrorCode.E_STORAGE:
      return 500
  }
}

/**
 * The answer to a write that did not carry the write token.
 *
 * Returned before the body is read and before the registry is touched, so a
 * refused write leaves the table exactly as it was. The message names what is
 * missing and nothing about what the token is.
 */
function unauthorized(): Response {
  return fail(
    statusFor(RegistryErrorCode.E_UNAUTHORIZED),
    RegistryErrorCode.E_UNAUTHORIZED,
    'registry writes require the write token',
    { 'www-authenticate': 'Bearer realm="qianmo-registry"' },
  )
}

function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/**
 * `true` when the request may write: no token is configured (the registry's
 * behaviour before P15.8), or it presents the configured one.
 */
type WriteGate = (request: Request) => boolean

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function handleCollection(
  request: Request,
  registry: InMemoryRegistry,
  mayWrite: WriteGate,
): Promise<Response> {
  if (request.method === 'GET') {
    return json({ agents: registry.list().map(agentBody) })
  }
  if (request.method !== 'POST') {
    return methodNotAllowed(['GET', 'POST'])
  }
  if (!mayWrite(request)) return unauthorized()

  const body = await readJsonObject(request)
  if (body === null) {
    return fail(
      400,
      RegistryErrorCode.E_BAD_REQUEST,
      'body must be a JSON object',
    )
  }

  const result: RegisterResult = registry.register(
    body['address'],
    body['endpoint'],
    {
      capabilities: body['capabilities'],
      publicKey: body['publicKey'],
      certificate: body['certificate'],
      status: body['status'],
    },
  )
  if (!result.ok) {
    return fail(statusFor(result.code), result.code, result.message)
  }
  return json(agentBody(result.entry), result.created ? 201 : 200)
}

function handleItem(
  request: Request,
  registry: InMemoryRegistry,
  address: string,
  mayWrite: WriteGate,
): Response {
  if (request.method === 'GET') {
    const entry = registry.resolve(address)
    return entry === null
      ? notFound(`no live agent at ${address}`)
      : json(agentBody(entry))
  }
  if (request.method === 'DELETE') {
    if (!mayWrite(request)) return unauthorized()
    return registry.deregister(address)
      ? new Response(null, { status: 204 })
      : notFound(`no live agent at ${address}`)
  }
  return methodNotAllowed(['GET', 'DELETE'])
}

function handleHeartbeat(
  request: Request,
  registry: InMemoryRegistry,
  address: string,
  mayWrite: WriteGate,
): Response {
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  if (!mayWrite(request)) return unauthorized()
  const entry = registry.heartbeat(address)
  return entry === null
    ? notFound(`no live agent at ${address}`)
    : json(agentBody(entry))
}

/**
 * `/v0/revocation-list` — the same courier the agent table is
 * (key-distribution.md §5.2), carrying the CA's signed RL instead of a
 * certificate. `GET` for every node's hourly poll (§6.4); `PUT` for the CA
 * operator's `qm ca refresh-rl` to publish a fresh one, and a write like any
 * other once a write token is configured. No `DELETE`: an
 * RL is superseded by publishing a newer one, never withdrawn to nothing —
 * an absent list and a stale one must stay distinguishable (§6.4's two rows).
 */
async function handleRevocationList(
  request: Request,
  registry: InMemoryRegistry,
  mayWrite: WriteGate,
): Promise<Response> {
  if (request.method === 'GET') {
    const list = registry.revocationList
    return list === null
      ? notFound('no revocation list has been published')
      : json(list)
  }
  if (request.method !== 'PUT') {
    return methodNotAllowed(['GET', 'PUT'])
  }
  if (!mayWrite(request)) return unauthorized()
  const body = await readJsonObject(request)
  let accepted: boolean
  try {
    accepted = body !== null && registry.publishRevocationList(body)
  } catch {
    // Not persisted, so not published: the previous list is still the one
    // served, and the publisher is told to try again rather than handed a
    // 200 the next restart would quietly take back.
    return fail(
      statusFor(RegistryErrorCode.E_STORAGE),
      RegistryErrorCode.E_STORAGE,
      'the revocation list could not be stored; nothing was published',
    )
  }
  if (!accepted) {
    return fail(
      400,
      RegistryErrorCode.E_BAD_REQUEST,
      'body must be a signed revocation list: {payload, signature}',
    )
  }
  return json(registry.revocationList)
}

/** Options for {@link createRegistryHandler}. */
interface RegistryHandlerOptions {
  /**
   * The write token (tenancy-m1.md P15.8). Given, every write —
   * `POST /v0/agents`, `DELETE /v0/agents/<address>`,
   * `POST /v0/agents/<address>/heartbeat`, `PUT /v0/revocation-list` — must
   * carry `Authorization: Bearer <token>` or is answered 401 with the table
   * untouched. Reads never need it.
   *
   * Omitted, the registry behaves exactly as it did before the token existed.
   * That is what lets a fleet turn it on in two steps: writers first learn to
   * send it (an older registry ignores the header), then the registry starts
   * requiring it.
   */
  readonly writeToken?: string
}

/**
 * Build the request handler for the registry HTTP API v0.
 *
 * Exposed separately from {@link startRegistryServer} so it can be exercised
 * with a plain `Request` object, without binding a port.
 */
export function createRegistryHandler(
  registry: InMemoryRegistry,
  options: RegistryHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const writeToken = options.writeToken
  if (writeToken !== undefined) {
    assertRegistryWriteToken(writeToken, 'registry write token')
  }
  const mayWrite: WriteGate =
    writeToken === undefined
      ? () => true
      : request => registryWriteTokenMatches(bearerOf(request), writeToken)
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    const segments = pathname.split('/').filter(s => s.length > 0)

    if (segments[0] !== 'v0') return notFound(`unknown path: ${pathname}`)

    if (segments.length === 2 && segments[1] === 'health') {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      return json({ status: 'ok', agents: registry.size })
    }

    if (segments.length === 2 && segments[1] === 'revocation-list') {
      return await handleRevocationList(request, registry, mayWrite)
    }

    if (segments[1] !== 'agents') return notFound(`unknown path: ${pathname}`)

    if (segments.length === 2) {
      return await handleCollection(request, registry, mayWrite)
    }

    // The address rides in one path segment, percent-encoded by the client
    // (`qianmo%3A%2F%2Fnode-b%2Freviewer`): `URL` leaves the escapes alone, so
    // the split still yields 3 segments and the decode hands back the address.
    let address: string
    try {
      address = decodeURIComponent(segments[2] ?? '')
    } catch {
      return fail(
        400,
        RegistryErrorCode.E_BAD_REQUEST,
        'address contains invalid percent encoding',
      )
    }

    if (segments.length === 3) {
      return handleItem(request, registry, address, mayWrite)
    }
    if (segments.length === 4 && segments[3] === 'heartbeat') {
      return handleHeartbeat(request, registry, address, mayWrite)
    }
    return notFound(`unknown path: ${pathname}`)
  }
}

export interface RegistryServerOptions extends RegistryHandlerOptions {
  /** Registry to serve; a fresh {@link InMemoryRegistry} by default. */
  readonly registry?: InMemoryRegistry
  readonly hostname?: string
}

/** Live server handle returned by {@link startRegistryServer}. */
export interface RegistryServerHandle {
  /** Port actually bound — meaningful when starting on port `0`. */
  readonly port: number
  /** Base URL, without a trailing slash. */
  readonly url: string
  readonly registry: InMemoryRegistry
  stop(): Promise<void>
}

/**
 * Start the registry HTTP API. Pass `0` to let the OS pick a free port and
 * read the real one back from the handle.
 */
export function startRegistryServer(
  port = 0,
  options: RegistryServerOptions = {},
): RegistryServerHandle {
  const registry = options.registry ?? new InMemoryRegistry()
  // Built before the clock is observed or a port bound: a short token is a
  // configuration error, and it should leave nothing running behind it.
  const fetchHandler = createRegistryHandler(
    registry,
    options.writeToken === undefined ? {} : { writeToken: options.writeToken },
  )
  registry.observeClock(10_000)
  const hostname = options.hostname ?? '127.0.0.1'
  const server = Bun.serve({
    port,
    hostname,
    fetch: fetchHandler,
  })
  const clockPulse = setInterval(() => {
    registry.observeClock(10_000)
  }, 10_000)
  clockPulse.unref?.()

  return {
    // Bun types `Server.port` as `number | undefined` because unix-socket
    // servers have no port. This server always binds TCP, so it is a number.
    port: server.port as number,
    url: `http://${hostname}:${server.port}`,
    registry,
    stop: async (): Promise<void> => {
      clearInterval(clockPulse)
      await server.stop(true)
    },
  }
}
