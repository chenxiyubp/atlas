// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import { AuditSource, type AuditRecord, type MessageChain } from '@qianmo/audit'
import type { ConsoleTokens } from '../src/auth.js'
import type {
  AuditFilter,
  AuditPage,
  AuditPort,
  CertificatePort,
  ConsoleAgent,
  ConsoleAuditSource,
  ConsoleDeps,
  ConsoleFailure,
  ConsoleResult,
  LimitsSnapshot,
  NodeServer,
  RegisterAgentInput,
  RegistryPort,
  ServerNote,
  ServerNotesPort,
  WakeInput,
  WakeOutcome,
  WakePort,
  WakeTarget,
} from '../src/deps.js'
import { MAX_SERVER_NOTE_LENGTH } from '../src/view/servers.js'
import {
  MAX_AUDIT_LIMIT,
  createConsoleHandler,
  parseAuditFilter,
  startConsoleServer,
  type ConsoleServerHandle,
} from '../src/http.js'

const VIEW = 'view-token-000000000001'
const ADMIN = 'admin-token-00000000001'
const WRONG = 'wrong-token-00000000001'
const TOKENS: ConsoleTokens = { view: VIEW, admin: ADMIN }

const NOW = 1_700_000_000_000
const ADDRESS = 'qianmo://tokyo-1/planner'
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

const AGENT: ConsoleAgent = {
  address: ADDRESS,
  endpoint: 'wss://tokyo-1.example.com/planner',
  capabilities: ['plan'],
  status: 'online',
  registeredAt: NOW - 60_000,
  lastHeartbeatAt: NOW - 1_000,
  expiresAt: NOW + 89_000,
}

const RECORD: AuditRecord = {
  seq: 1,
  at: NOW - 5_000,
  source: AuditSource.Router,
  kind: 'forwarded',
  traceId: TRACE,
  outcome: 'ok',
  prev: '0'.repeat(64),
}

const PAGE: AuditPage = {
  records: [RECORD],
  chain: 'intact',
  intact: true,
  issueCount: 0,
  total: 1,
}

const CHAIN: MessageChain = {
  traceId: TRACE,
  records: [RECORD],
  taskIds: [],
  msgIds: [],
  sources: [AuditSource.Router],
  refused: 0,
  dropped: 0,
  firstAt: RECORD.at,
  lastAt: RECORD.at,
}

const LIMITS: LimitsSnapshot = {
  protocol: {
    maxMessageBytes: 262_144,
    maxHops: 8,
    defaultTtlMs: 30_000,
    defaultTaskTtlMs: 600_000,
    ratePerMinute: 60,
  },
  runtime: { capacity: 20, windowMs: 1_000 },
  registryTtlMs: 90_000,
}

const OUTCOME: WakeOutcome = {
  msgId: 'msg-1',
  taskId: 'task-1',
  receipt: 'accepted',
}

function okResult<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

function failResult(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<never> {
  return { ok: false, failure: { code, message } }
}

/**
 * Hand-written fakes rather than `mock.module`: every port in `ConsoleDeps` is
 * an interface for exactly this reason, and the repo treats module mocking as
 * a zero-tolerance ratchet (root CLAUDE.md, "Mock 卫生").
 */
class FakeRegistry implements RegistryPort {
  listResult: ConsoleResult<readonly ConsoleAgent[]> = okResult([AGENT])
  registerResult: ConsoleResult<ConsoleAgent> = okResult(AGENT)
  deregisterResult: ConsoleResult<void> = okResult(undefined)
  heartbeatResult: ConsoleResult<ConsoleAgent> = okResult(AGENT)
  readonly registered: RegisterAgentInput[] = []
  readonly deregistered: string[] = []
  readonly beats: string[] = []
  listCalls = 0

  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
    this.listCalls += 1
    return Promise.resolve(this.listResult)
  }

  register(input: RegisterAgentInput): Promise<ConsoleResult<ConsoleAgent>> {
    this.registered.push(input)
    return Promise.resolve(this.registerResult)
  }

  deregister(address: string): Promise<ConsoleResult<void>> {
    this.deregistered.push(address)
    return Promise.resolve(this.deregisterResult)
  }

  heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>> {
    this.beats.push(address)
    return Promise.resolve(this.heartbeatResult)
  }
}

class FakeAudit implements AuditPort {
  readResult: ConsoleResult<AuditPage> = okResult(PAGE)
  chainResult: ConsoleResult<MessageChain | null> = okResult(CHAIN)
  readonly filters: AuditFilter[] = []
  readonly traces: string[] = []

  read(filter: AuditFilter): Promise<ConsoleResult<AuditPage>> {
    this.filters.push(filter)
    return Promise.resolve(this.readResult)
  }

  chain(traceId: string): Promise<ConsoleResult<MessageChain | null>> {
    this.traces.push(traceId)
    return Promise.resolve(this.chainResult)
  }
}

class FakeWake implements WakePort {
  result: ConsoleResult<WakeOutcome> = okResult(OUTCOME)
  readonly sent: WakeInput[] = []

  send(input: WakeInput): Promise<ConsoleResult<WakeOutcome>> {
    this.sent.push(input)
    return Promise.resolve(this.result)
  }
}

interface Harness {
  readonly registry: FakeRegistry
  readonly audit: FakeAudit
  readonly wake: FakeWake
  readonly deps: ConsoleDeps
  readonly handle: (request: Request) => Promise<Response>
}

function setup(options: { readonly withWake?: boolean } = {}): Harness {
  const registry = new FakeRegistry()
  const audit = new FakeAudit()
  const wake = new FakeWake()
  const deps: ConsoleDeps = {
    registry,
    audit,
    limits: LIMITS,
    now: () => NOW,
    label: 'tokyo-1',
    ...(options.withWake === false ? {} : { wake }),
  }
  return {
    registry,
    audit,
    wake,
    deps,
    handle: createConsoleHandler(deps, TOKENS),
  }
}

function setupMulti(
  audits: readonly ConsoleAuditSource[],
  wakeTargets?: readonly WakeTarget[],
): Harness {
  const harness = setup({ withWake: false })
  const deps: ConsoleDeps = {
    ...harness.deps,
    audit: audits[0]?.audit ?? harness.audit,
    audits,
    ...(wakeTargets === undefined ? {} : { wakeTargets }),
  }
  return {
    ...harness,
    deps,
    handle: createConsoleHandler(deps, TOKENS),
  }
}

const BASE = 'http://console.test'

function req(
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {}
  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`
  }
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body =
      typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
  }
  return new Request(`${BASE}${path}`, init)
}

function get(path: string, token?: string): Request {
  return token === undefined ? req('GET', path) : req('GET', path, { token })
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json()
  return parsed as Record<string, unknown>
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  const parsed = await body(response)
  return parsed['error'] as Record<string, unknown>
}

function itemPath(address: string): string {
  return `/v0/agents/${encodeURIComponent(address)}`
}

describe('public routes', () => {
  test('health needs no credential', async () => {
    const { handle } = setup()
    const response = await handle(get('/v0/health'))
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ status: 'ok' })
  })

  test('the stylesheet is public and never cached', async () => {
    const { handle } = setup()
    const response = await handle(get('/assets/app.css'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.text()).length).toBeGreaterThan(0)
  })

  test('the client script is public', async () => {
    const { handle } = setup()
    const response = await handle(get('/assets/app.js'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
  })

  test('an unknown asset is a 404, not a 401', async () => {
    const { handle } = setup()
    expect((await handle(get('/assets/nope.css'))).status).toBe(404)
  })
})

describe('the page', () => {
  test('renders for a view token', async () => {
    const { handle, registry, audit } = setup()
    const response = await handle(get('/', VIEW))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await response.text()).length).toBeGreaterThan(0)
    expect(registry.listCalls).toBe(1)
    expect(audit.filters).toHaveLength(1)
  })

  test('opens from a plain browser navigation with ?token=', async () => {
    const { handle } = setup()
    const response = await handle(get(`/?token=${VIEW}`))
    expect(response.status).toBe(200)
  })

  test('the audit filter on the page URL reaches the port', async () => {
    const { handle, audit } = setup()
    await handle(get(`/?token=${VIEW}&source=router&limit=7`))
    expect(audit.filters[0]).toEqual({ source: 'router', limit: 7 })
  })

  test('still opens when the registry is unreachable', async () => {
    const { handle, registry } = setup()
    registry.listResult = failResult('unreachable', '注册中心不可达')
    const response = await handle(get('/', VIEW))
    expect(response.status).toBe(200)
    expect((await response.text()).length).toBeGreaterThan(0)
  })

  test('still opens when every port is down', async () => {
    const { handle, registry, audit } = setup()
    registry.listResult = failResult('unreachable', '注册中心不可达')
    audit.readResult = failResult('unreachable', '审计文件读不到')
    expect((await handle(get('/', VIEW))).status).toBe(200)
  })

  test('keeps the page open when the witness endpoint is unreachable', async () => {
    const { handle, audit } = setup()
    audit.readResult = failResult('unreachable', '见证端点不可达：连接被拒绝')
    const response = await handle(get('/', VIEW))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('审计日志不可达 · 见证端点不可达')
  })

  test('renders every audit source independently with explicit mirror status', async () => {
    const intact = new FakeAudit()
    const broken = new FakeAudit()
    broken.readResult = okResult({
      ...PAGE,
      chain: 'broken',
      intact: false,
      issueCount: 2,
    })
    const { handle } = setupMulti([
      { node: 'beta-1', audit: intact, kind: 'authoritative' },
      {
        node: 'beta-2',
        audit: broken,
        kind: 'mirror',
        maxLagMinutes: 5,
      },
    ])

    const response = await handle(get('/', VIEW))
    const markup = await response.text()
    expect(response.status).toBe(200)
    expect(markup).toContain('data-audit-node="beta-1"')
    expect(markup).toContain('data-audit-node="beta-2"')
    expect(markup).toContain('权威链')
    expect(markup).toContain('镜像 · 滞后 ≤ 5 分钟')
    expect(markup).toContain('断裂 2')
    expect(intact.filters).toHaveLength(1)
    expect(broken.filters).toHaveLength(1)
  })

  test('keeps a started-but-quiet source distinct from a missing one', async () => {
    const healthy = new FakeAudit()
    const quiet = new FakeAudit()
    // The chain file exists and holds nothing: a node that has done no
    // protocol work yet, which is a normal state and not a finding.
    quiet.readResult = okResult({
      records: [],
      chain: 'empty',
      intact: true,
      issueCount: 0,
      total: 0,
    })
    const absent = new FakeAudit()
    // No chain file at all: either end of the pipe may owe it, and the page
    // must not summarise this as an intact chain.
    absent.readResult = okResult({
      records: [],
      chain: 'absent',
      intact: false,
      issueCount: 0,
      total: 0,
    })
    const { handle } = setupMulti([
      { node: 'beta-1', audit: healthy, kind: 'authoritative' },
      { node: 'beta-2', audit: quiet, kind: 'authoritative' },
      { node: 'beta-3', audit: absent, kind: 'authoritative' },
    ])

    const markup = await (await handle(get('/fragments/audit', VIEW))).text()
    expect(markup).toContain('data-audit-node="beta-1"')
    expect(markup).toContain('data-audit-node="beta-2"')
    expect(markup).toContain('data-audit-node="beta-3"')
    expect(markup).toContain('这条链还没有记录')
    expect(markup).toContain('审计链未建立')
    expect(markup).toContain('未建立')
    // One missing source is enough to take the whole view out of 完整.
    expect(markup).toContain('data-audit-state="absent"')
    expect(healthy.filters).toHaveLength(1)
    expect(quiet.filters).toHaveLength(1)
    expect(absent.filters).toHaveLength(1)
  })
})

describe('fragments', () => {
  test.each(['roster', 'audit', 'limits'])('%s renders HTML', async name => {
    const { handle } = setup()
    const response = await handle(get(`/fragments/${name}`, VIEW))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    expect((await response.text()).length).toBeGreaterThan(0)
  })

  test('a failing port still yields a fragment, not a 503', async () => {
    const { handle, registry } = setup()
    registry.listResult = failResult('unreachable', '注册中心不可达')
    const response = await handle(get('/fragments/roster', VIEW))
    expect(response.status).toBe(200)
  })

  test('the roster draws the CA roots even when the certificate read fails', async () => {
    // The roots come from `roots()`, the console's own trust file; the
    // registry being down is `read()`'s problem, not theirs.
    const certificates: CertificatePort = {
      read: () => Promise.resolve(failResult('unreachable', '连接被拒绝')),
      roots: () => [
        {
          subject: 'CN=qianmo-ca',
          notAfter: NOW + 5 * 24 * 60 * 60 * 1000,
          status: 'expiring-urgent',
        },
      ],
    }
    const handle = createConsoleHandler(
      { ...setup().deps, certificates },
      TOKENS,
    )
    const markup = await (await handle(get('/fragments/roster', VIEW))).text()
    expect(markup).toContain('吊销清单未读到 · 连接被拒绝')
    expect(markup).toContain(
      '<p class="bar bar-critical">CA 根 CN=qianmo-ca · 7 天内到期 · 剩余 5d</p>',
    )
  })

  test('the chain fragment decodes the traceId and renders markup', async () => {
    const { handle, audit } = setup()
    const traceparent = `00-${TRACE}-0102030405060708-01`
    const response = await handle(
      get(`/fragments/chain/${encodeURIComponent(traceparent)}`, VIEW),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    expect(audit.traces).toEqual([traceparent])
  })

  test('a missing chain is still markup, not a 404', async () => {
    const { handle, audit } = setup()
    audit.chainResult = okResult(null)
    const response = await handle(get(`/fragments/chain/${TRACE}`, VIEW))
    expect(response.status).toBe(200)
    expect((await response.text()).length).toBeGreaterThan(0)
  })

  test('an unreadable trail renders inside the chain fragment', async () => {
    const { handle, audit } = setup()
    audit.chainResult = failResult('unreachable', '审计文件读不到')
    const response = await handle(get(`/fragments/chain/${TRACE}`, VIEW))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
  })

  test('an unknown fragment is a 404', async () => {
    const { handle } = setup()
    for (const path of [
      '/fragments/nope',
      '/fragments/chain',
      '/fragments/roster/extra',
      '/fragments/chain/a/b',
    ]) {
      expect(`${path} -> ${(await handle(get(path, VIEW))).status}`).toBe(
        `${path} -> 404`,
      )
    }
  })

  test('fragments need a credential', async () => {
    const { handle } = setup()
    expect((await handle(get('/fragments/roster'))).status).toBe(401)
    expect((await handle(get(`/fragments/chain/${TRACE}`))).status).toBe(401)
  })
})

describe('agents', () => {
  test('GET lists', async () => {
    const { handle } = setup()
    const response = await handle(get('/v0/agents', VIEW))
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ agents: [AGENT] })
  })

  test('POST registers with the parsed input', async () => {
    const { handle, registry } = setup()
    const response = await handle(
      req('POST', '/v0/agents', {
        token: ADMIN,
        body: {
          address: ADDRESS,
          endpoint: 'wss://tokyo-1.example.com/planner',
          capabilities: ['plan'],
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual(
      AGENT as unknown as Record<string, unknown>,
    )
    expect(registry.registered).toEqual([
      {
        address: ADDRESS,
        endpoint: 'wss://tokyo-1.example.com/planner',
        capabilities: ['plan'],
      },
    ])
  })

  test('POST with a broken body is a 400 and never reaches the port', async () => {
    const { handle, registry } = setup()
    const cases: unknown[] = [
      'not json at all',
      JSON.stringify([1, 2]),
      { endpoint: 'wss://x/y' },
      { address: ADDRESS },
      { address: ADDRESS, endpoint: 'wss://x/y', capabilities: [1] },
      { address: ADDRESS, endpoint: 'wss://x/y', publicKey: 7 },
    ]
    for (const payload of cases) {
      const response = await handle(
        req('POST', '/v0/agents', { token: ADMIN, body: payload }),
      )
      expect(response.status).toBe(400)
      expect((await errorOf(response))['code']).toBe('invalid')
    }
    expect(registry.registered).toHaveLength(0)
  })

  test('DELETE round-trips a percent-encoded address and answers 204', async () => {
    const { handle, registry } = setup()
    const response = await handle(
      req('DELETE', itemPath(ADDRESS), { token: ADMIN }),
    )
    expect(response.status).toBe(204)
    expect(registry.deregistered).toEqual([ADDRESS])
  })

  test('DELETE of an unknown address is the port failure, not a 500', async () => {
    const { handle, registry } = setup()
    registry.deregisterResult = failResult('not_found', '没有这个 agent')
    const response = await handle(
      req('DELETE', itemPath(ADDRESS), { token: ADMIN }),
    )
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toEqual({
      code: 'not_found',
      message: '没有这个 agent',
    })
  })

  test('heartbeat decodes the address and returns the record', async () => {
    const { handle, registry } = setup()
    const response = await handle(
      req('POST', `${itemPath(ADDRESS)}/heartbeat`, { token: ADMIN }),
    )
    expect(response.status).toBe(200)
    expect(registry.beats).toEqual([ADDRESS])
    expect((await body(response))['address']).toBe(ADDRESS)
  })

  test('an unreachable registry is a 503 carrying the message', async () => {
    const { handle, registry } = setup()
    registry.listResult = failResult(
      'unreachable',
      '注册中心不可达：ECONNREFUSED',
    )
    const response = await handle(get('/v0/agents', VIEW))
    expect(response.status).toBe(503)
    expect(await errorOf(response)).toEqual({
      code: 'unreachable',
      message: '注册中心不可达：ECONNREFUSED',
    })
  })

  test('a rejected registration is a 400 carrying the message', async () => {
    const { handle, registry } = setup()
    registry.registerResult = failResult('rejected', '地址已被占用')
    const response = await handle(
      req('POST', '/v0/agents', {
        token: ADMIN,
        body: { address: ADDRESS, endpoint: 'wss://x/y' },
      }),
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response))['message']).toBe('地址已被占用')
  })
})

describe('audit', () => {
  test('GET returns the page and passes the parsed filter', async () => {
    const { handle, audit } = setup()
    const response = await handle(
      get('/v0/audit?source=router&outcome=refused&limit=10', VIEW),
    )
    expect(response.status).toBe(200)
    expect((await body(response))['total']).toBe(1)
    expect(audit.filters[0]).toEqual({
      source: 'router',
      outcome: 'refused',
      limit: 10,
    })
  })

  test('a chain lookup decodes the traceId', async () => {
    const { handle, audit } = setup()
    const traceparent = `00-${TRACE}-0102030405060708-01`
    const response = await handle(
      get(`/v0/audit/chain/${encodeURIComponent(traceparent)}`, VIEW),
    )
    expect(response.status).toBe(200)
    expect(audit.traces).toEqual([traceparent])
    const parsed = await body(response)
    expect((parsed['chain'] as Record<string, unknown>)['traceId']).toBe(TRACE)
  })

  test('a missing chain is a 200 with null, not a 404', async () => {
    const { handle, audit } = setup()
    audit.chainResult = okResult(null)
    const response = await handle(get(`/v0/audit/chain/${TRACE}`, VIEW))
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ chain: null })
  })

  test('an unreadable trail is a 503, not a 500', async () => {
    const { handle, audit } = setup()
    audit.readResult = failResult('unreachable', '审计文件读不到')
    expect((await handle(get('/v0/audit', VIEW))).status).toBe(503)
  })

  test('multi-source JSON returns the configured collection and node reads stay scoped', async () => {
    const first = new FakeAudit()
    const second = new FakeAudit()
    second.readResult = okResult({ ...PAGE, total: 7 })
    const { handle } = setupMulti([
      { node: 'beta-1', audit: first, kind: 'authoritative' },
      { node: 'beta-2', audit: second, kind: 'mirror', maxLagMinutes: 5 },
    ])

    const all = await handle(get('/v0/audit?limit=3', VIEW))
    expect(all.status).toBe(200)
    const allBody = await body(all)
    expect((allBody['audits'] as readonly unknown[]).length).toBe(2)
    expect(first.filters[0]).toEqual({ limit: 3 })
    expect(second.filters[0]).toEqual({ limit: 3 })

    const one = await handle(get('/v0/audit?node=beta-2', VIEW))
    expect(one.status).toBe(200)
    expect((await body(one))['total']).toBe(7)
    expect((await handle(get('/v0/audit?node=unknown', VIEW))).status).toBe(404)
  })

  test('multi-source trace details require and honour the selected node', async () => {
    const first = new FakeAudit()
    const second = new FakeAudit()
    first.chainResult = okResult({ ...CHAIN, traceId: 'first' })
    second.chainResult = okResult({ ...CHAIN, traceId: 'second' })
    const { handle } = setupMulti([
      { node: 'beta-1', audit: first, kind: 'authoritative' },
      { node: 'beta-2', audit: second, kind: 'authoritative' },
    ])

    const scoped = await handle(get('/v0/audit/chain/shared?node=beta-2', VIEW))
    expect(scoped.status).toBe(200)
    expect(second.traces).toEqual(['shared'])
    expect(first.traces).toEqual([])
    expect((await body(scoped))['chain']).toMatchObject({ traceId: 'second' })
    expect((await handle(get('/v0/audit/chain/shared', VIEW))).status).toBe(400)
  })
})

describe('limits', () => {
  test('GET returns the snapshot verbatim', async () => {
    const { handle } = setup()
    const response = await handle(get('/v0/limits', VIEW))
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual(
      LIMITS as unknown as Record<string, unknown>,
    )
  })
})

/**
 * C-1 (validation report 2026-09-08): the page printed the package default as
 * the registry lease in three places, and judged every row by it, while the
 * registry ran an hour-long one.
 */
describe('the registry lease on the page (C-1)', () => {
  const HOUR = 3_600_000
  const beat = NOW - 120_000
  const HOUR_AGENT: ConsoleAgent = {
    ...AGENT,
    lastHeartbeatAt: beat,
    expiresAt: beat + HOUR,
  }

  test('roster, limits strip and overview card all state the registry lease', async () => {
    const { handle, registry } = setup()
    registry.listResult = okResult([HOUR_AGENT])
    const page = await (await handle(get('/', VIEW))).text()
    expect(page).toContain('data-health="live"')
    expect(page).toContain('租约 1 小时')
    expect(page).toContain('data-ttl-ms="3600000"')
    expect(page).toContain('<div class="stat-num">1 小时</div>')
    expect(page).not.toContain('1 分 30 秒')
    // Still one registry read: the limits reuse the roster's.
    expect(registry.listCalls).toBe(1)
  })

  test('the limits fragment says what the page says', async () => {
    const { handle, registry } = setup()
    registry.listResult = okResult([HOUR_AGENT])
    const fragment = await (await handle(get('/fragments/limits', VIEW))).text()
    expect(fragment).toContain('data-ttl-ms="3600000"')
    expect(fragment).not.toContain('1 分 30 秒')
  })

  test('with nothing to read a lease from, the default stands in', async () => {
    const { handle, registry } = setup()
    registry.listResult = failResult('unreachable', '注册中心不可达')
    const response = await handle(get('/fragments/limits', VIEW))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-ttl-ms="90000"')

    registry.listResult = okResult([])
    const empty = await (await handle(get('/', VIEW))).text()
    expect(empty).toContain('data-ttl-ms="90000"')
  })

  test('/v0/limits keeps reporting the package snapshot', async () => {
    const { handle, registry } = setup()
    registry.listResult = okResult([HOUR_AGENT])
    const response = await handle(get('/v0/limits', VIEW))
    expect((await body(response))['registryTtlMs']).toBe(LIMITS.registryTtlMs)
  })
})

describe('wake', () => {
  test('sends the parsed input and returns the outcome', async () => {
    const { handle, wake } = setup()
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: {
          from: 'qianmo://tokyo-1/planner',
          to: 'qianmo://osaka-2/worker',
          prompt: '把昨天的报告补完',
          url: 'https://example.com/task/1',
          afterMs: 5_000,
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual(
      OUTCOME as unknown as Record<string, unknown>,
    )
    expect(wake.sent[0]?.afterMs).toBe(5_000)
  })

  test('a console without a wake port answers 501 with the reason', async () => {
    const { handle } = setup({ withWake: false })
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b', prompt: 'c', url: 'd' },
      }),
    )
    expect(response.status).toBe(501)
    const error = await errorOf(response)
    expect(error['code']).toBe('unsupported')
    expect(String(error['message'])).toContain('PSK')
  })

  test('selects only a configured named wake target and discards a client URL', async () => {
    const nodeOne = new FakeWake()
    const { handle } = setupMulti(
      [{ node: 'beta-1', audit: new FakeAudit(), kind: 'authoritative' }],
      [
        {
          node: 'beta-1',
          url: 'ws://127.0.0.1:38631/',
          wake: nodeOne,
        },
        {
          node: 'beta-2',
          url: 'ws://127.0.0.1:38632/',
          unavailableReason: 'missing per-node PSK',
        },
      ],
    )
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: {
          node: 'beta-1',
          from: 'qianmo://console/operator',
          to: 'qianmo://beta-1/reviewer',
          prompt: 'wake',
          url: 'ws://attacker.invalid:1/',
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(nodeOne.sent[0]?.url).toBe('ws://127.0.0.1:38631/')
  })

  test('locally degrades one missing named PSK without opening another target', async () => {
    const nodeOne = new FakeWake()
    const { handle } = setupMulti(
      [{ node: 'beta-1', audit: new FakeAudit(), kind: 'authoritative' }],
      [
        {
          node: 'beta-1',
          url: 'ws://127.0.0.1:38631/',
          wake: nodeOne,
        },
        {
          node: 'beta-2',
          url: 'ws://127.0.0.1:38632/',
          unavailableReason: 'missing per-node PSK',
        },
      ],
    )
    const unavailable = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: {
          node: 'beta-2',
          from: 'qianmo://console/operator',
          to: 'qianmo://beta-2/reviewer',
          prompt: 'wake',
        },
      }),
    )
    expect(unavailable.status).toBe(501)
    expect(nodeOne.sent).toHaveLength(0)
  })

  test('rejects unknown and mismatched named wake targets before dialing', async () => {
    const nodeOne = new FakeWake()
    const { handle } = setupMulti(
      [{ node: 'beta-1', audit: new FakeAudit(), kind: 'authoritative' }],
      [
        {
          node: 'beta-1',
          url: 'ws://127.0.0.1:38631/',
          wake: nodeOne,
        },
      ],
    )
    const unknown = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: {
          node: 'attacker',
          from: 'qianmo://console/operator',
          to: 'qianmo://attacker/reviewer',
          prompt: 'wake',
        },
      }),
    )
    expect(unknown.status).toBe(403)
    const mismatch = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: {
          node: 'beta-1',
          from: 'qianmo://console/operator',
          to: 'qianmo://beta-2/reviewer',
          prompt: 'wake',
        },
      }),
    )
    expect(mismatch.status).toBe(403)
    expect(nodeOne.sent).toHaveLength(0)
  })

  test('a malformed wake never reaches the port', async () => {
    // `url` used to be the field this case left out. It is optional now — the
    // form stopped asking for it because the port pins the receipt endpoint —
    // so the missing-field case moved to `prompt`, which is still required.
    const { handle, wake } = setup()
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b' },
      }),
    )
    expect(response.status).toBe(400)
    expect(wake.sent).toHaveLength(0)
  })

  test('a wake with no url reaches the port, which uses the pinned one', async () => {
    // The 回调 box is gone from the form: `createWakePort` only ever accepts
    // the URL the console was started with, so an absent field means "that
    // one" rather than a bad request.
    const { handle, wake } = setup()
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b', prompt: 'c' },
      }),
    )
    expect(response.status).toBe(200)
    expect(wake.sent).toHaveLength(1)
    expect(wake.sent[0]?.url).toBe('')
  })

  test('a url of the wrong type is still refused', async () => {
    const { handle, wake } = setup()
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b', prompt: 'c', url: 7 },
      }),
    )
    expect(response.status).toBe(400)
    expect(wake.sent).toHaveLength(0)
  })

  test('a negative delay is refused', async () => {
    const { handle } = setup()
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b', prompt: 'c', url: 'd', afterMs: -1 },
      }),
    )
    expect(response.status).toBe(400)
  })

  test('a refused wake keeps the port message', async () => {
    const { handle, wake } = setup()
    wake.result = failResult('rejected', '对端拒绝：超出速率预算')
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b', prompt: 'c', url: 'd' },
      }),
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response))['message']).toBe('对端拒绝：超出速率预算')
  })

  test('a node that refuses by policy is 403, never 503', async () => {
    // The status is the half of this answer a retry loop reads, and it is the
    // half that was wrong: 503 says "away, come back" about a node that read
    // the request and declined it (issue #29). Pinned here rather than only in
    // `statusFor` because the route is what a caller actually sees.
    const { handle, wake } = setup()
    wake.result = failResult(
      'refused',
      '节点拒绝了这条唤醒 · E_CAP_INSUFFICIENT · wake from console needs write-limited, presented read',
    )
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b', prompt: 'c', url: 'd' },
      }),
    )
    expect(response.status).toBe(403)
    const error = await errorOf(response)
    expect(error['code']).toBe('refused')
    expect(String(error['message'])).toContain('E_CAP_INSUFFICIENT')
  })

  test('an unreachable node stays 503, so the two never collapse', async () => {
    const { handle, wake } = setup()
    wake.result = failResult('unreachable', '连接被拒绝')
    const response = await handle(
      req('POST', '/v0/wake', {
        token: ADMIN,
        body: { from: 'a', to: 'b', prompt: 'c', url: 'd' },
      }),
    )
    expect(response.status).toBe(503)
    expect((await errorOf(response))['code']).toBe('unreachable')
  })
})

describe('servers', () => {
  const NODE_SERVERS: readonly NodeServer[] = [
    { node: 'tokyo-1', server: 'p11' },
    { node: 'tokyo-2', server: 'p11' },
    { node: 'osaka-1', server: '203.0.113.7' },
  ]

  /** Notes live in memory here; the file half is `consoleServerNotes.test.ts`. */
  class FakeNotes implements ServerNotesPort {
    readonly stored = new Map<string, ServerNote>()
    setResult: ConsoleResult<ServerNote> | null = null
    listResult: ConsoleResult<readonly ServerNote[]> | null = null

    list(): Promise<ConsoleResult<readonly ServerNote[]>> {
      return Promise.resolve(
        this.listResult ?? okResult([...this.stored.values()]),
      )
    }

    set(server: string, note: string): Promise<ConsoleResult<ServerNote>> {
      if (this.setResult !== null) return Promise.resolve(this.setResult)
      const record: ServerNote = { server, note, updatedAt: NOW }
      this.stored.set(server, record)
      return Promise.resolve(okResult(record))
    }
  }

  interface ServerHarness extends Harness {
    readonly notes: FakeNotes
  }

  function setupServers(
    options: {
      readonly nodeServers?: readonly NodeServer[]
      readonly withNotes?: boolean
    } = {},
  ): ServerHarness {
    const base = setup()
    const notes = new FakeNotes()
    const nodeServers = options.nodeServers ?? NODE_SERVERS
    const deps: ConsoleDeps = {
      ...base.deps,
      ...(nodeServers.length === 0 ? {} : { nodeServers }),
      ...(options.withNotes === false ? {} : { serverNotes: notes }),
    }
    return {
      ...base,
      notes,
      deps,
      handle: createConsoleHandler(deps, TOKENS),
    }
  }

  const notePath = (server: string): string =>
    `/v0/servers/${encodeURIComponent(server)}/note`

  test('lists each machine with the nodes it carries', async () => {
    const { handle } = setupServers()
    const response = await handle(get('/v0/servers', VIEW))
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({
      servers: [
        { server: 'p11', nodes: ['tokyo-1', 'tokyo-2'], note: null },
        { server: '203.0.113.7', nodes: ['osaka-1'], note: null },
      ],
    })
  })

  test('carries the note back on the machine it belongs to', async () => {
    const { handle, notes } = setupServers()
    notes.stored.set('p11', { server: 'p11', note: '香港', updatedAt: 5 })
    const listed = (await body(await handle(get('/v0/servers', VIEW))))[
      'servers'
    ] as readonly Record<string, unknown>[]
    expect(listed[0]?.['note']).toEqual({
      server: 'p11',
      note: '香港',
      updatedAt: 5,
    })
    // 备注挂在机器上，不是挂在每个节点上：另一台不该被带上。
    expect(listed[1]?.['note']).toBeNull()
  })

  test('ignores a stored note whose machine is no longer configured', async () => {
    // 旧的 --node-server 行留下的记录还在文件里，但这个控制台已经不认它了。
    const { handle, notes } = setupServers()
    notes.stored.set('retired-box', {
      server: 'retired-box',
      note: '早就下线了',
      updatedAt: 1,
    })
    const text = await (await handle(get('/v0/servers', VIEW))).text()
    expect(text).not.toContain('retired-box')
    expect(text).not.toContain('早就下线了')
  })

  test('writes a note with the admin token and reads it straight back', async () => {
    const { handle, notes } = setupServers()
    const response = await handle(
      req('PUT', notePath('p11'), {
        token: ADMIN,
        body: { note: '香港 · 演示' },
      }),
    )
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({
      server: 'p11',
      note: '香港 · 演示',
      updatedAt: NOW,
    })
    expect(notes.stored.get('p11')?.note).toBe('香港 · 演示')
  })

  test('lets a view token read but never write', async () => {
    const { handle, notes } = setupServers()
    expect((await handle(get('/v0/servers', VIEW))).status).toBe(200)
    const refused = await handle(
      req('PUT', notePath('p11'), {
        token: VIEW,
        body: { note: '不该写进去' },
      }),
    )
    expect(refused.status).toBe(403)
    expect((await errorOf(refused))['code']).toBe('forbidden')
    expect(notes.stored.size).toBe(0)
  })

  test('refuses a machine that is not on the startup list', async () => {
    // 与 handleWake 的白名单同一条：客户端不能凭一个任意字符串让服务端多出一条
    // 记录来。查不到就 403，而且**不写**。
    const { handle, notes } = setupServers()
    const response = await handle(
      req('PUT', notePath('somebody-elses-box'), {
        token: ADMIN,
        body: { note: '凭空造一台' },
      }),
    )
    expect(response.status).toBe(403)
    expect((await errorOf(response))['code']).toBe('rejected')
    expect(notes.stored.size).toBe(0)
  })

  test('refuses a note past the ceiling, and takes the one at it', async () => {
    const { handle, notes } = setupServers()
    const tooLong = await handle(
      req('PUT', notePath('p11'), {
        token: ADMIN,
        body: { note: 'x'.repeat(MAX_SERVER_NOTE_LENGTH + 1) },
      }),
    )
    expect(tooLong.status).toBe(400)
    expect((await errorOf(tooLong))['code']).toBe('invalid')
    expect(notes.stored.size).toBe(0)

    const atCeiling = await handle(
      req('PUT', notePath('p11'), {
        token: ADMIN,
        body: { note: 'x'.repeat(MAX_SERVER_NOTE_LENGTH) },
      }),
    )
    expect(atCeiling.status).toBe(200)
  })

  test('takes an empty note, which is how one is cleared', async () => {
    const { handle, notes } = setupServers()
    notes.stored.set('p11', { server: 'p11', note: '旧的', updatedAt: 1 })
    const response = await handle(
      req('PUT', notePath('p11'), { token: ADMIN, body: { note: '' } }),
    )
    expect(response.status).toBe(200)
    expect(notes.stored.get('p11')?.note).toBe('')
  })

  test('refuses a note that is not a string', async () => {
    const { handle } = setupServers()
    const response = await handle(
      req('PUT', notePath('p11'), { token: ADMIN, body: { note: 42 } }),
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response))['code']).toBe('invalid')
  })

  test('answers 501 on both routes when no mapping was configured', async () => {
    // 「没被告知任何东西在哪跑」与「哪里都没东西在跑」是两件事。
    const { handle } = setupServers({ nodeServers: [] })
    const listed = await handle(get('/v0/servers', VIEW))
    expect(listed.status).toBe(501)
    expect((await errorOf(listed))['code']).toBe('unsupported')
    const written = await handle(
      req('PUT', notePath('p11'), { token: ADMIN, body: { note: 'x' } }),
    )
    expect(written.status).toBe(501)
  })

  test('still lists the machines when there is no note store', async () => {
    const { handle } = setupServers({ withNotes: false })
    const listed = await handle(get('/v0/servers', VIEW))
    expect(listed.status).toBe(200)
    expect((await body(listed))['servers'] as readonly unknown[]).toHaveLength(
      2,
    )
    const written = await handle(
      req('PUT', notePath('p11'), { token: ADMIN, body: { note: 'x' } }),
    )
    expect(written.status).toBe(501)
  })

  test('reports a failed note read rather than inventing an empty one', async () => {
    const { handle, notes } = setupServers()
    notes.listResult = failResult('unreachable', '备注文件读不到')
    const response = await handle(get('/v0/servers', VIEW))
    expect(response.status).toBe(503)
    expect((await errorOf(response))['message']).toBe('备注文件读不到')
  })

  test('passes a failed write through as the status that describes it', async () => {
    const { handle, notes } = setupServers()
    notes.setResult = failResult('unreachable', '备注写入失败：ENOSPC')
    const response = await handle(
      req('PUT', notePath('p11'), { token: ADMIN, body: { note: 'x' } }),
    )
    expect(response.status).toBe(503)
    expect((await errorOf(response))['code']).toBe('unreachable')
  })

  test('answers 405 for a verb the note route does not take', async () => {
    const { handle } = setupServers()
    const response = await handle(
      req('POST', notePath('p11'), { token: ADMIN, body: { note: 'x' } }),
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('PUT')
  })

  test('401s an anonymous caller before it learns anything else', async () => {
    const { handle } = setupServers()
    expect((await handle(get('/v0/servers'))).status).toBe(401)
    expect(
      (await handle(req('PUT', notePath('p11'), { body: { note: 'x' } })))
        .status,
    ).toBe(401)
    // 白名单外的 id 对匿名调用者也只能是 401：403 会变成一个「这台机器存在吗」
    // 的探针。
    expect(
      (
        await handle(
          req('PUT', notePath('somebody-elses-box'), { body: { note: 'x' } }),
        )
      ).status,
    ).toBe(401)
  })

  test('takes an IPv6 literal through one encoded path segment', async () => {
    const { handle, notes } = setupServers({
      nodeServers: [{ node: 'tokyo-1', server: '2001:db8::5' }],
    })
    const response = await handle(
      req('PUT', notePath('2001:db8::5'), {
        token: ADMIN,
        body: { note: '冒号也要能过' },
      }),
    )
    expect(response.status).toBe(200)
    expect(notes.stored.get('2001:db8::5')?.note).toBe('冒号也要能过')
  })

  test('renders the section on the page, editable only for admin', async () => {
    // 路由那一侧拒收是一回事，页面别给出一个按下去必定 403 的按钮是另一回事。
    // 这条钉的是 http.ts 把角色映射成 editable 的那一步。
    const { handle } = setupServers()
    // 判据要卡在 textarea 那个标签上：内联样式表里有 `input[readonly]` 选择器，
    // 整篇文档因此永远含有 readonly 这个词，光找它是一条永真的断言。
    const READONLY_BOX = 'spellcheck="false" readonly>'
    const asAdmin = await (await handle(get('/', ADMIN))).text()
    expect(asAdmin).toContain('id="servers-section"')
    expect(asAdmin).toContain('data-action="server-note"')
    expect(asAdmin).not.toContain(READONLY_BOX)

    const asView = await (await handle(get('/', VIEW))).text()
    expect(asView).toContain('id="servers-section"')
    expect(asView).not.toContain('data-action="server-note"')
    expect(asView).toContain(READONLY_BOX)
  })

  test('leaves the section off the page when nothing was configured', async () => {
    const { handle } = setupServers({ nodeServers: [] })
    const html = await (await handle(get('/', ADMIN))).text()
    expect(html).not.toContain('id="servers-section"')
    // 名册照旧在——降级只该拿掉归属那一块。
    expect(html).toContain('id="nodes-section"')
  })

  test('puts the attribution on the roster the page and the fragment share', async () => {
    const { handle } = setupServers()
    for (const path of ['/', '/fragments/roster']) {
      const html = await (await handle(get(path, ADMIN))).text()
      expect(
        `${path} -> ${html.includes('服务器 <span class="mono">p11')}`,
      ).toBe(`${path} -> true`)
    }
  })

  test('404s an unknown shape under /v0/servers', async () => {
    const { handle } = setupServers()
    expect((await handle(get('/v0/servers/p11', VIEW))).status).toBe(404)
    expect((await handle(get('/v0/servers/p11/label', VIEW))).status).toBe(404)
  })
})

describe('the role matrix', () => {
  const viewRoutes: readonly (readonly [string, string])[] = [
    ['GET', '/'],
    ['GET', '/v0/agents'],
    ['GET', '/v0/audit'],
    ['GET', `/v0/audit/chain/${TRACE}`],
    ['GET', '/v0/limits'],
    ['GET', '/fragments/roster'],
    ['GET', '/fragments/audit'],
    ['GET', '/fragments/limits'],
    ['GET', `/fragments/chain/${TRACE}`],
  ]

  const adminRoutes: readonly (readonly [string, string])[] = [
    ['POST', '/v0/agents'],
    ['DELETE', itemPath(ADDRESS)],
    ['POST', `${itemPath(ADDRESS)}/heartbeat`],
    ['POST', '/v0/wake'],
  ]

  const registerBody = { address: ADDRESS, endpoint: 'wss://x/y' }
  const wakeBody = { from: 'a', to: 'b', prompt: 'c', url: 'd' }

  function payloadFor(path: string): unknown {
    if (path === '/v0/agents') return registerBody
    if (path === '/v0/wake') return wakeBody
    return undefined
  }

  test('no credential is 401 everywhere', async () => {
    const { handle } = setup()
    for (const [method, path] of [...viewRoutes, ...adminRoutes]) {
      const response = await handle(
        req(method, path, { body: payloadFor(path) }),
      )
      expect(`${method} ${path} -> ${response.status}`).toBe(
        `${method} ${path} -> 401`,
      )
      expect((await errorOf(response))['code']).toBe('unauthorized')
    }
  })

  test('a wrong credential is 401 everywhere', async () => {
    const { handle } = setup()
    for (const [method, path] of [...viewRoutes, ...adminRoutes]) {
      const response = await handle(
        req(method, path, { token: WRONG, body: payloadFor(path) }),
      )
      expect(`${method} ${path} -> ${response.status}`).toBe(
        `${method} ${path} -> 401`,
      )
    }
  })

  test('the view token opens every read route', async () => {
    const { handle } = setup()
    for (const [method, path] of viewRoutes) {
      const response = await handle(req(method, path, { token: VIEW }))
      expect(`${method} ${path} -> ${response.status}`).toBe(
        `${method} ${path} -> 200`,
      )
    }
  })

  test('the view token is 403 on every admin route', async () => {
    const { handle, registry, wake } = setup()
    for (const [method, path] of adminRoutes) {
      const response = await handle(
        req(method, path, { token: VIEW, body: payloadFor(path) }),
      )
      expect(`${method} ${path} -> ${response.status}`).toBe(
        `${method} ${path} -> 403`,
      )
      expect((await errorOf(response))['code']).toBe('forbidden')
    }
    // 403 means refused, not "refused after doing it".
    expect(registry.registered).toHaveLength(0)
    expect(registry.deregistered).toHaveLength(0)
    expect(registry.beats).toHaveLength(0)
    expect(wake.sent).toHaveLength(0)
  })

  test('the admin token also opens the read routes', async () => {
    const { handle } = setup()
    for (const [method, path] of viewRoutes) {
      const response = await handle(req(method, path, { token: ADMIN }))
      expect(`${method} ${path} -> ${response.status}`).toBe(
        `${method} ${path} -> 200`,
      )
    }
  })

  test('a view token is 403 on wake even without a wake port', async () => {
    // The role is decided before the capability: otherwise "501" would tell a
    // read-only caller what this console can do.
    const { handle } = setup({ withWake: false })
    const response = await handle(
      req('POST', '/v0/wake', { token: VIEW, body: wakeBody }),
    )
    expect(response.status).toBe(403)
  })

  test('401 and 403 never echo the token they were given', async () => {
    const { handle } = setup()
    const unauthorized = await handle(get('/v0/agents', WRONG))
    expect(await unauthorized.text()).not.toContain(WRONG)
    const forbidden = await handle(
      req('POST', '/v0/wake', { token: VIEW, body: wakeBody }),
    )
    const text = await forbidden.text()
    expect(text).not.toContain(VIEW)
    expect(text).not.toContain(ADMIN)
  })
})

describe('routing edges', () => {
  test('an unknown path is a 404 without a credential', async () => {
    const { handle } = setup()
    for (const path of ['/nope', '/v0', '/v0/nope', '/v0/agents/a/b/c']) {
      expect((await handle(get(path))).status).toBe(404)
    }
  })

  test('a wrong method is a 405 with Allow', async () => {
    const { handle } = setup()
    const response = await handle(req('PUT', '/v0/agents', { token: ADMIN }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
    expect((await errorOf(response))['code']).toBe('method_not_allowed')
  })

  test.each([
    ['DELETE', '/v0/health', 'GET'],
    ['POST', '/assets/app.css', 'GET'],
    ['POST', '/', 'GET'],
    ['GET', '/v0/wake', 'POST'],
    ['POST', '/v0/audit', 'GET'],
    ['POST', '/fragments/roster', 'GET'],
  ])('%s %s is 405 allowing %s', async (method, path, allow) => {
    const { handle } = setup()
    const response = await handle(req(method, path, { token: ADMIN }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe(allow)
  })

  test('a port that breaks its contract and throws is a 500', async () => {
    const registry: RegistryPort = {
      list: () => {
        throw new Error('boom')
      },
      register: () => Promise.resolve(okResult(AGENT)),
      deregister: () => Promise.resolve(okResult(undefined)),
      heartbeat: () => Promise.resolve(okResult(AGENT)),
    }
    const handle = createConsoleHandler(
      { registry, audit: new FakeAudit(), limits: LIMITS, now: () => NOW },
      TOKENS,
    )
    const response = await handle(get('/v0/agents', VIEW))
    expect(response.status).toBe(500)
    const error = await errorOf(response)
    expect(error['code']).toBe('internal')
    expect(String(error['message'])).toContain('boom')
  })
})

describe('parseAuditFilter', () => {
  const NOW = 1_760_000_000_000

  function filterOf(query: string): AuditFilter {
    return parseAuditFilter(new URL(`${BASE}/v0/audit${query}`), NOW)
  }

  test('an empty query string is an empty filter', () => {
    expect(filterOf('')).toEqual({})
    expect(filterOf('?')).toEqual({})
  })

  test('blank parameters are treated as absent', () => {
    expect(filterOf('?source=&outcome=%20&traceId=&limit=&from=')).toEqual({})
  })

  test('text parameters are trimmed', () => {
    expect(filterOf('?source=%20router%20&agent=%20a%20')).toEqual({
      source: 'router',
      agent: 'a',
    })
  })

  test('every field parses', () => {
    expect(
      filterOf(
        '?source=router&outcome=refused&traceId=t&taskId=k&agent=a&limit=3&from=1000&to=2000',
      ),
    ).toEqual({
      source: 'router',
      outcome: 'refused',
      traceId: 't',
      taskId: 'k',
      agent: 'a',
      limit: 3,
      from: 1_000,
      to: 2_000,
    })
  })

  test.each([
    ['?limit=1000', MAX_AUDIT_LIMIT],
    ['?limit=501', MAX_AUDIT_LIMIT],
    ['?limit=0', MAX_AUDIT_LIMIT],
    ['?limit=-3', MAX_AUDIT_LIMIT],
    ['?limit=abc', MAX_AUDIT_LIMIT],
    ['?limit=12.5', MAX_AUDIT_LIMIT],
    ['?limit=500', 500],
    ['?limit=1', 1],
  ])('%s clamps to %s', (query, expected) => {
    expect(filterOf(query).limit).toBe(expected)
  })

  test('ISO timestamps are accepted', () => {
    const iso = '2026-08-17T00:00:00.000Z'
    expect(filterOf(`?from=${encodeURIComponent(iso)}`).from).toBe(
      Date.parse(iso),
    )
  })

  test('an unparseable timestamp reads as absent instead of failing', () => {
    expect(filterOf('?from=yesterday&to=soon')).toEqual({})
  })

  test('all-digit input is epoch ms, never a year', () => {
    expect(filterOf('?from=2026').from).toBe(2026)
  })

  test('an out-of-range epoch reads as absent', () => {
    expect(filterOf('?from=99999999999999999999').from).toBeUndefined()
  })

  test.each([
    ['1h', 3_600_000],
    ['24h', 86_400_000],
    ['7d', 604_800_000],
  ])('window=%s resolves to a from, server-side', (name, span) => {
    // The trail filter is a plain GET form that has to work with script
    // disabled, and a radio cannot compute now - 24h. So the segment submits
    // a name and this resolves it.
    expect(filterOf(`?window=${name}`)).toEqual({
      window: name,
      from: NOW - span,
    })
  })

  test('an unknown window is ignored rather than refused', () => {
    // It arrives from a URL somebody may have edited by hand; a 400 on a
    // filter is a filter nobody finishes typing.
    expect(filterOf('?window=fortnight')).toEqual({})
    expect(filterOf('?window=')).toEqual({})
  })

  test('an explicit instant wins over a window — that is what 自定义 means', () => {
    expect(filterOf('?window=24h&from=1000')).toEqual({ from: 1_000 })
    expect(filterOf('?window=24h&to=2000')).toEqual({ to: 2_000 })
  })

  test('the window survives the round trip the poller replays', async () => {
    // The page echoes `window=24h` back into `data-query`, not the instant it
    // resolved to: "the last 24 hours" has to keep meaning that on the next
    // poll rather than freezing at page load.
    const { handle } = setup()
    const html = await (await handle(get('/?window=24h', ADMIN))).text()
    expect(html).toContain('data-query="window=24h"')
    expect(html).toContain('name="window" value="24h" checked')
  })
})

describe('startConsoleServer', () => {
  let server: ConsoleServerHandle | null = null

  afterAll(async () => {
    await server?.stop()
  })

  test('binds an ephemeral port and serves the same handler', async () => {
    const { deps } = setup()
    server = startConsoleServer(deps, undefined, { tokens: TOKENS })
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    expect(server.url).not.toContain(VIEW)

    const health = await fetch(`${server.url}/v0/health`)
    expect(health.status).toBe(200)

    const anonymous = await fetch(`${server.url}/v0/agents`)
    expect(anonymous.status).toBe(401)

    const authorized = await fetch(`${server.url}/v0/agents`, {
      headers: { authorization: `Bearer ${VIEW}` },
    })
    expect(authorized.status).toBe(200)
  })
})
