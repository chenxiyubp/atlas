// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import {
  AgentStatus,
  InMemoryRegistry,
  ManualClock,
  RegistryErrorCode,
  startRegistryServer,
  type RegistryServerHandle,
} from '../src/index.js'

const TTL = 90_000

const PLANNER = 'qianmo://tokyo-1/planner'
const WORKER = 'qianmo://osaka-2/worker'
const ENDPOINT = 'wss://tokyo-1.example.com/planner'
const WORKER_ENDPOINT = 'wss://osaka-2.example.com/worker'
const NODE_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'

let clock: ManualClock
let registry: InMemoryRegistry
let server: RegistryServerHandle

beforeAll(() => {
  clock = new ManualClock(1_000)
  registry = new InMemoryRegistry({ ttlMs: TTL, clock })
  // Port 0: let the OS pick a free port so tests never collide.
  server = startRegistryServer(0, { registry })
})

afterAll(async () => {
  await server.stop()
})

beforeEach(() => {
  registry.clear()
  clock.set(1_000)
})

async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json()
  return parsed as Record<string, unknown>
}

/**
 * Item path for an address. The whole `qianmo://…` address rides in one path
 * segment, percent-encoded — that is the client's entire share of the
 * composite-key change (protocol.md §2.4).
 */
function itemPath(address: string): string {
  return `/v0/agents/${encodeURIComponent(address)}`
}

function post(path: string, payload?: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? '' : JSON.stringify(payload),
  })
}

describe('registry http api v0', () => {
  test('a failed bind leaves no clock interval behind', () => {
    const interval = spyOn(globalThis, 'setInterval')
    try {
      expect(() => startRegistryServer(server.port)).toThrow()
      expect(interval).not.toHaveBeenCalled()
    } finally {
      for (const result of interval.mock.results) {
        if (result.type === 'return') clearInterval(result.value)
      }
      interval.mockRestore()
    }
  })

  test.each([
    '%',
    '%GG',
    '%E0%A4',
    '%FF',
  ])('returns the existing bad-request response for malformed path escape %s', async address => {
    const response = await fetch(`${server.url}/v0/agents/${address}`)
    expect(response.status).toBe(400)
    expect(await body(response)).toMatchObject({
      error: { code: RegistryErrorCode.E_BAD_REQUEST },
    })
    expect((await fetch(`${server.url}/v0/health`)).status).toBe(200)
  })

  test('binds a real, non-zero port', () => {
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toContain(String(server.port))
  })

  test('POST /v0/agents creates an agent (201) then refreshes it (200)', async () => {
    const created = await post('/v0/agents', {
      address: PLANNER,
      endpoint: ENDPOINT,
      capabilities: ['plan'],
      publicKey: NODE_KEY,
    })
    expect(created.status).toBe(201)
    const createdBody = await body(created)
    expect(createdBody['address']).toBe(PLANNER)
    expect(createdBody['endpoint']).toBe(ENDPOINT)
    expect(createdBody['capabilities']).toEqual(['plan'])
    expect(createdBody['publicKey']).toBe(NODE_KEY)
    expect(createdBody['status']).toBe(AgentStatus.Online)
    expect(createdBody['expiresAt']).toBe(1_000 + TTL)

    const refreshed = await post('/v0/agents', {
      address: PLANNER,
      endpoint: ENDPOINT,
      status: AgentStatus.Dormant,
    })
    expect(refreshed.status).toBe(200)
    expect((await body(refreshed))['status']).toBe(AgentStatus.Dormant)
  })

  test('POST /v0/agents rejects a bad body with 400', async () => {
    const noJson = await post('/v0/agents')
    expect(noJson.status).toBe(400)

    const badAddress = await post('/v0/agents', {
      address: 'qianmo://Bad Node/planner',
      endpoint: ENDPOINT,
    })
    expect(badAddress.status).toBe(400)
    const errorBody = await body(badAddress)
    const error = errorBody['error'] as Record<string, unknown>
    expect(error['code']).toBe(RegistryErrorCode.E_BAD_REQUEST)

    // A bare agent name is no longer an identity — the wire takes addresses.
    const bareName = await post('/v0/agents', {
      address: 'planner',
      endpoint: ENDPOINT,
    })
    expect(bareName.status).toBe(400)

    const badEndpoint = await post('/v0/agents', {
      address: PLANNER,
      endpoint: 'nope',
    })
    expect(badEndpoint.status).toBe(400)

    const badKey = await post('/v0/agents', {
      address: PLANNER,
      endpoint: ENDPOINT,
      publicKey: 'not-a-key',
    })
    expect(badKey.status).toBe(400)

    const badStatus = await post('/v0/agents', {
      address: PLANNER,
      endpoint: ENDPOINT,
      status: AgentStatus.Offline,
    })
    expect(badStatus.status).toBe(400)
  })

  test('POST /v0/agents wires the certificate field through to register()', async () => {
    // A real, CA-issued certificate is exercised end to end in
    // `certificate.test.ts` against `InMemoryRegistry.register()` directly —
    // this only needs to prove the HTTP body reaches that same validation
    // rather than being silently dropped, so a certificate-shaped garbage
    // string is enough: it must be refused, not ignored.
    const rejected = await post('/v0/agents', {
      address: PLANNER,
      endpoint: ENDPOINT,
      certificate: 'not a certificate',
    })
    expect(rejected.status).toBe(400)
    const error = (await body(rejected))['error'] as Record<string, unknown>
    expect(error['code']).toBe(RegistryErrorCode.E_BAD_REQUEST)
    expect(registry.resolve(PLANNER)).toBeNull()
  })

  test('POST /v0/agents returns 409 on an endpoint clash', async () => {
    await post('/v0/agents', { address: PLANNER, endpoint: ENDPOINT })
    const clash = await post('/v0/agents', {
      address: PLANNER,
      endpoint: 'wss://impostor.example.com/planner',
    })
    expect(clash.status).toBe(409)
    const error = (await body(clash))['error'] as Record<string, unknown>
    expect(error['code']).toBe(RegistryErrorCode.E_CONFLICT)
  })

  // The routing is unchanged from the bare-name era: `URL` leaves `%2F` and
  // `%3A` escaped, so an encoded address is still a single path segment.
  test('the same agent name on two nodes round-trips over HTTP', async () => {
    const a = await post('/v0/agents', {
      address: 'qianmo://node-a/reviewer',
      endpoint: 'wss://node-a.example.com/reviewer',
    })
    const b = await post('/v0/agents', {
      address: 'qianmo://node-b/reviewer',
      endpoint: 'wss://node-b.example.com/reviewer',
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)

    const fromA = await fetch(
      `${server.url}${itemPath('qianmo://node-a/reviewer')}`,
    )
    const fromB = await fetch(
      `${server.url}${itemPath('qianmo://node-b/reviewer')}`,
    )
    expect(fromA.status).toBe(200)
    expect(fromB.status).toBe(200)
    expect((await body(fromA))['endpoint']).toBe(
      'wss://node-a.example.com/reviewer',
    )
    expect((await body(fromB))['endpoint']).toBe(
      'wss://node-b.example.com/reviewer',
    )

    const health = await body(await fetch(`${server.url}/v0/health`))
    expect(health['agents']).toBe(2)
  })

  test('GET /v0/agents lists live agents', async () => {
    await post('/v0/agents', { address: PLANNER, endpoint: ENDPOINT })
    await post('/v0/agents', { address: WORKER, endpoint: WORKER_ENDPOINT })

    const response = await fetch(`${server.url}/v0/agents`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')

    const agents = (await body(response))['agents'] as ReadonlyArray<
      Record<string, unknown>
    >
    expect(agents).toHaveLength(2)
    expect(agents.map(a => a['address'])).toEqual([WORKER, PLANNER])
  })

  test('GET /v0/agents/:address resolves or 404s', async () => {
    await post('/v0/agents', { address: PLANNER, endpoint: ENDPOINT })

    const hit = await fetch(`${server.url}${itemPath(PLANNER)}`)
    expect(hit.status).toBe(200)
    expect((await body(hit))['endpoint']).toBe(ENDPOINT)

    const miss = await fetch(
      `${server.url}${itemPath('qianmo://tokyo-1/ghost')}`,
    )
    expect(miss.status).toBe(404)
    const error = (await body(miss))['error'] as Record<string, unknown>
    expect(error['code']).toBe(RegistryErrorCode.E_NOT_FOUND)

    // A bare name is not an address, so it cannot resolve to anything.
    const bare = await fetch(`${server.url}/v0/agents/planner`)
    expect(bare.status).toBe(404)
  })

  test('POST /v0/agents/:address/heartbeat extends the lease, 404 when unknown', async () => {
    await post('/v0/agents', { address: PLANNER, endpoint: ENDPOINT })
    clock.advance(30_000)

    const beat = await post(`${itemPath(PLANNER)}/heartbeat`)
    expect(beat.status).toBe(200)
    const beatBody = await body(beat)
    expect(beatBody['address']).toBe(PLANNER)
    expect(beatBody['lastHeartbeatAt']).toBe(31_000)
    expect(beatBody['expiresAt']).toBe(31_000 + TTL)

    const missing = await post(
      `${itemPath('qianmo://tokyo-1/ghost')}/heartbeat`,
    )
    expect(missing.status).toBe(404)
  })

  test('DELETE /v0/agents/:address returns 204 then 404', async () => {
    await post('/v0/agents', { address: PLANNER, endpoint: ENDPOINT })

    const gone = await fetch(`${server.url}${itemPath(PLANNER)}`, {
      method: 'DELETE',
    })
    expect(gone.status).toBe(204)

    const again = await fetch(`${server.url}${itemPath(PLANNER)}`, {
      method: 'DELETE',
    })
    expect(again.status).toBe(404)
  })

  test('expired agents disappear from the HTTP surface too', async () => {
    await post('/v0/agents', { address: PLANNER, endpoint: ENDPOINT })
    clock.advance(TTL + 1)

    const resolved = await fetch(`${server.url}${itemPath(PLANNER)}`)
    expect(resolved.status).toBe(404)

    const listed = (await body(await fetch(`${server.url}/v0/agents`)))[
      'agents'
    ]
    expect(listed).toEqual([])
  })

  test('unknown routes 404 and wrong methods 405', async () => {
    expect((await fetch(`${server.url}/v1/agents`)).status).toBe(404)
    expect((await fetch(`${server.url}/v0/nodes`)).status).toBe(404)
    expect(
      (await fetch(`${server.url}${itemPath(PLANNER)}/unknown`)).status,
    ).toBe(404)

    const wrongMethod = await fetch(`${server.url}/v0/agents`, {
      method: 'DELETE',
    })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toContain('POST')

    const wrongHeartbeat = await fetch(
      `${server.url}${itemPath(PLANNER)}/heartbeat`,
    )
    expect(wrongHeartbeat.status).toBe(405)
  })

  test('GET /v0/health reports the live agent count', async () => {
    await post('/v0/agents', { address: PLANNER, endpoint: ENDPOINT })
    const health = await body(await fetch(`${server.url}/v0/health`))
    expect(health['status']).toBe('ok')
    expect(health['agents']).toBe(1)
  })
})

describe('GET/PUT /v0/revocation-list (§6.4 — the same zero-auth courier)', () => {
  test('404s until something has been published', async () => {
    const before = await fetch(`${server.url}/v0/revocation-list`)
    expect(before.status).toBe(404)
  })

  test('PUT publishes, GET reads it back verbatim', async () => {
    const document = { payload: 'cGF5bG9hZA', signature: 'c2ln' }
    const put = await fetch(`${server.url}/v0/revocation-list`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document),
    })
    expect(put.status).toBe(200)
    expect(await body(put)).toEqual(document)

    const get = await fetch(`${server.url}/v0/revocation-list`)
    expect(get.status).toBe(200)
    expect(await body(get)).toEqual(document)
  })

  test('a later PUT replaces the earlier document, never merges', async () => {
    await fetch(`${server.url}/v0/revocation-list`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'a', signature: 'a' }),
    })
    await fetch(`${server.url}/v0/revocation-list`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'b', signature: 'b' }),
    })
    const get = await body(await fetch(`${server.url}/v0/revocation-list`))
    expect(get).toEqual({ payload: 'b', signature: 'b' })
  })

  test('PUT rejects a body that is not {payload, signature}', async () => {
    const bad = await fetch(`${server.url}/v0/revocation-list`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'a' }),
    })
    expect(bad.status).toBe(400)
    const error = (await body(bad))['error'] as Record<string, unknown>
    expect(error['code']).toBe(RegistryErrorCode.E_BAD_REQUEST)
  })

  test('no DELETE, and GET/PUT are the only allowed methods', async () => {
    const wrong = await fetch(`${server.url}/v0/revocation-list`, {
      method: 'DELETE',
    })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('GET, PUT')
  })
})
