// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.8: registry writes need the write token; reads do not change.
 *
 * Every case drives the real `createRegistryHandler` over a real
 * `InMemoryRegistry` (with a real file store where "unchanged" has to include
 * the disk). "Unchanged" is checked three ways: the live table, the state
 * file's bytes, and the published revocation list.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileRegistryStore,
  FileRevocationListStore,
  InMemoryRegistry,
  ManualClock,
  RegistryErrorCode,
  createRegistryHandler,
  readRegistryWriteTokenFile,
  startRegistryServer,
} from '../src/index.js'

const TOKEN = 'registry-write-token-not-a-secret'
const PLANNER = 'qianmo://beta-1/planner'
const INTRUDER = 'qianmo://beta-1/intruder'
const ENDPOINT = 'ws://127.0.0.1:38631'
const RL = { payload: 'cGF5bG9hZA', signature: 'c2ln' }
const BASE = 'http://registry.test'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-registry-token-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function item(address: string): string {
  return `${BASE}/v0/agents/${encodeURIComponent(address)}`
}

function request(
  method: string,
  url: string,
  options: { body?: unknown; token?: string } = {},
): Request {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  })
}

/** A registry with one agent and one published list, persisted to disk. */
function seeded() {
  const statePath = join(directory, 'agents.json')
  const registry = new InMemoryRegistry({
    clock: new ManualClock(1_000_000),
    store: new FileRegistryStore(statePath),
    revocationListStore: new FileRevocationListStore(
      join(directory, 'revocation-list.json'),
    ),
  })
  registry.register(PLANNER, ENDPOINT, { capabilities: ['task.request'] })
  registry.publishRevocationList(RL)
  const snapshot = () => ({
    table: JSON.stringify(registry.list()),
    disk: readFileSync(statePath, 'utf8'),
    rl: JSON.stringify(registry.revocationList),
  })
  return { registry, snapshot }
}

/** One of each write the token guards. */
const WRITES: readonly [string, (token?: string) => Request][] = [
  [
    'POST /v0/agents',
    token =>
      request('POST', `${BASE}/v0/agents`, {
        body: { address: INTRUDER, endpoint: 'ws://203.0.113.9:1' },
        ...(token === undefined ? {} : { token }),
      }),
  ],
  [
    'DELETE /v0/agents/<address>',
    token =>
      request('DELETE', item(PLANNER), token === undefined ? {} : { token }),
  ],
  [
    'POST /v0/agents/<address>/heartbeat',
    token =>
      request(
        'POST',
        `${item(PLANNER)}/heartbeat`,
        token === undefined ? {} : { token },
      ),
  ],
  [
    'PUT /v0/revocation-list',
    token =>
      request('PUT', `${BASE}/v0/revocation-list`, {
        body: { payload: 'b3RoZXI', signature: 'b3RoZXI' },
        ...(token === undefined ? {} : { token }),
      }),
  ],
]

describe('with a write token configured', () => {
  test.each(
    WRITES,
  )('%s without the token is 401 and changes nothing', async (_label, build) => {
    const { registry, snapshot } = seeded()
    const handle = createRegistryHandler(registry, { writeToken: TOKEN })
    const before = snapshot()

    const response = await handle(build())

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
    expect(await response.json()).toMatchObject({
      error: { code: RegistryErrorCode.E_UNAUTHORIZED },
    })
    expect(snapshot()).toEqual(before)
  })

  test.each(
    WRITES,
  )('%s with a wrong token is 401 and changes nothing', async (_label, build) => {
    const { registry, snapshot } = seeded()
    const handle = createRegistryHandler(registry, { writeToken: TOKEN })
    const before = snapshot()

    const response = await handle(build(`${TOKEN}-but-not-quite`))

    expect(response.status).toBe(401)
    expect(snapshot()).toEqual(before)
  })

  test('with the token each write goes through', async () => {
    const { registry } = seeded()
    const handle = createRegistryHandler(registry, { writeToken: TOKEN })
    const [post, remove, beat, put] = WRITES.map(([, build]) => build)

    expect((await handle(beat!(TOKEN))).status).toBe(200)
    expect((await handle(post!(TOKEN))).status).toBe(201)
    expect(registry.resolve(INTRUDER)).not.toBeNull()
    expect((await handle(put!(TOKEN))).status).toBe(200)
    expect(registry.revocationList).toEqual({
      payload: 'b3RoZXI',
      signature: 'b3RoZXI',
    })
    expect((await handle(remove!(TOKEN))).status).toBe(204)
    expect(registry.resolve(PLANNER)).toBeNull()
  })

  test('a Bearer token is the only form accepted', async () => {
    const { registry, snapshot } = seeded()
    const handle = createRegistryHandler(registry, { writeToken: TOKEN })
    const before = snapshot()
    for (const authorization of [TOKEN, `bearer ${TOKEN}`, `Basic ${TOKEN}`]) {
      const response = await handle(
        new Request(`${item(PLANNER)}/heartbeat`, {
          method: 'POST',
          headers: { authorization },
        }),
      )
      expect(response.status).toBe(401)
    }
    const viaQuery = await handle(
      request('POST', `${item(PLANNER)}/heartbeat?token=${TOKEN}`),
    )
    expect(viaQuery.status).toBe(401)
    expect(snapshot()).toEqual(before)
  })

  test('methods the registry does not support are still 405, not 401', async () => {
    const { registry } = seeded()
    const handle = createRegistryHandler(registry, { writeToken: TOKEN })
    for (const [method, url] of [
      ['PATCH', `${BASE}/v0/agents`],
      ['GET', `${item(PLANNER)}/heartbeat`],
      ['DELETE', `${BASE}/v0/revocation-list`],
      ['POST', `${BASE}/v0/health`],
    ] as const) {
      expect((await handle(request(method, url))).status).toBe(405)
    }
  })

  test('every read answers byte for byte as it does without a token', async () => {
    const { registry } = seeded()
    const open = createRegistryHandler(registry)
    const gated = createRegistryHandler(registry, { writeToken: TOKEN })
    const reads = [
      `${BASE}/v0/health`,
      `${BASE}/v0/agents`,
      item(PLANNER),
      item('qianmo://beta-9/nobody'),
      `${BASE}/v0/revocation-list`,
      `${BASE}/v0/unknown`,
      `${BASE}/v1/agents`,
    ]
    for (const url of reads) {
      const [a, b] = await Promise.all([
        open(request('GET', url)),
        gated(request('GET', url)),
      ])
      expect({
        url,
        status: b.status,
        type: b.headers.get('content-type'),
        body: await b.text(),
      }).toEqual({
        url,
        status: a.status,
        type: a.headers.get('content-type'),
        body: await a.text(),
      })
    }
  })

  test('a token shorter than 16 characters is refused before anything runs', () => {
    // The clock counts reads: the server observes it once before binding and
    // on every pulse after, so "no reads" means neither happened.
    let reads = 0
    const registry = new InMemoryRegistry({
      clock: {
        now: () => {
          reads += 1
          return 1_000_000
        },
      },
    })
    expect(() =>
      createRegistryHandler(registry, { writeToken: 'short' }),
    ).toThrow('at least 16 characters')

    const probe = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = probe.port as number
    probe.stop(true)
    const before = reads
    expect(() =>
      startRegistryServer(port, { registry, writeToken: 'short' }),
    ).toThrow('at least 16 characters')
    expect(reads).toBe(before)
    // The port is still free: nothing was bound.
    const rebound = Bun.serve({ port, fetch: () => new Response() })
    rebound.stop(true)
  })

  test('over a real port: the same 401, and the token opens the write', async () => {
    const registry = new InMemoryRegistry()
    const server = startRegistryServer(0, { registry, writeToken: TOKEN })
    try {
      const body = JSON.stringify({ address: PLANNER, endpoint: ENDPOINT })
      const headers = { 'content-type': 'application/json' }
      const refused = await fetch(`${server.url}/v0/agents`, {
        method: 'POST',
        headers,
        body,
      })
      expect(refused.status).toBe(401)
      expect(registry.list()).toEqual([])

      const accepted = await fetch(`${server.url}/v0/agents`, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${TOKEN}` },
        body,
      })
      expect(accepted.status).toBe(201)
      expect((await fetch(`${server.url}/v0/agents`)).status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})

describe('without a write token (the default)', () => {
  test.each(
    WRITES,
  )('%s is accepted with no credential, as before P15.8', async (_label, build) => {
    const { registry } = seeded()
    const response = await createRegistryHandler(registry)(build())
    expect(response.status).toBeLessThan(300)
  })
})

describe('readRegistryWriteTokenFile', () => {
  function tokenFile(content: string, mode: number): string {
    const path = join(directory, `token-${mode.toString(8)}`)
    writeFileSync(path, content)
    chmodSync(path, mode)
    return path
  }

  test('reads an owner-only file and drops the trailing newline', () => {
    expect(
      readRegistryWriteTokenFile(tokenFile(`${TOKEN}\n`, 0o600), '--x'),
    ).toBe(TOKEN)
    expect(readRegistryWriteTokenFile(tokenFile(TOKEN, 0o400), '--x')).toBe(
      TOKEN,
    )
  })

  test.each([
    0o640, 0o644, 0o604, 0o660,
  ])('refuses mode %o: readable beyond its owner', mode => {
    if (process.platform === 'win32') return
    expect(() =>
      readRegistryWriteTokenFile(tokenFile(TOKEN, mode), '--write-token-file'),
    ).toThrow(/--write-token-file .* readable beyond its owner/)
  })

  test('refuses a missing file, a directory, an empty file and a short token', () => {
    expect(() =>
      readRegistryWriteTokenFile(join(directory, 'absent'), '--x'),
    ).toThrow('cannot be read')
    const folder = join(directory, 'folder')
    mkdirSync(folder, { mode: 0o700 })
    expect(() => readRegistryWriteTokenFile(folder, '--x')).toThrow(
      'not a regular file',
    )
    expect(() =>
      readRegistryWriteTokenFile(tokenFile('\n', 0o600), '--x'),
    ).toThrow('is empty')
    expect(() =>
      readRegistryWriteTokenFile(tokenFile('short\n', 0o600), '--x'),
    ).toThrow('at least 16 characters')
  })
})
