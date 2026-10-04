// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台的登记簿与续租者（`consoleRegistrations.ts`）。
 *
 * **零 `mock.module`**：注册中心是真的 `InMemoryRegistry`，外面套真的 HTTP v0
 * 处理函数（`createRegistryHandler`），控制台那一侧是真的 `createRegistryPort`，
 * 只把它的 `fetch` 接到处理函数上、不绑端口。时间用 `ManualClock` 推，续租的
 * 定时器换成手动触发的那一个，所以「推过三个租约」不用真等 270 s。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AgentStatus,
  DEFAULT_RENEW_INTERVAL_MS,
  DEFAULT_TTL_MS,
  InMemoryRegistry,
  ManualClock,
  createRegistryHandler,
  renewIntervalFor,
} from '@qianmo/registry'
import { consoleRegistrationsPath } from '../consoleArgs.js'
import { createRegistryPort } from '../consolePorts.js'
import {
  ConsoleRegistrations,
  REGISTRATION_LEDGER_VERSION,
  type RenewScheduler,
} from '../consoleRegistrations.js'

const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'
const ENDPOINT = 'ws://127.0.0.1:38611'
const OTHER_ENDPOINT = 'ws://127.0.0.1:38699'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** 一个还不存在的登记簿路径，父目录也还不存在。 */
function freshLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-console-registrations-'))
  roots.push(dir)
  return join(dir, 'qianmo', 'console', 'registrations.json')
}

/**
 * 一个可以「重启」的注册中心：`restart()` 换一张新表（同一个时钟、同一个 TTL），
 * 控制台那一侧的端口不变 —— 与真实部署里同一个 URL 背后的进程被重起是一回事。
 */
function harness(ttlMs = DEFAULT_TTL_MS) {
  const clock = new ManualClock(1_000_000)
  let registry = new InMemoryRegistry({ ttlMs, clock })
  const port = createRegistryPort({
    baseUrl: 'http://registry.test',
    fetch: async (input, init) =>
      await createRegistryHandler(registry)(new Request(input, init)),
  })
  return {
    clock,
    port,
    get registry(): InMemoryRegistry {
      return registry
    },
    restart(): void {
      registry = new InMemoryRegistry({ ttlMs, clock })
    },
  }
}

/** 手动触发的定时器：记下最近一次排的任务与延时，由用例决定何时「到点」。 */
function manualScheduler() {
  let pending: { task: () => Promise<void>; delayMs: number } | null = null
  let cancelled = 0
  const schedule: RenewScheduler = (task, delayMs) => {
    const entry = { task, delayMs }
    pending = entry
    return () => {
      if (pending === entry) pending = null
      cancelled += 1
    }
  }
  return {
    schedule,
    get delayMs(): number | undefined {
      return pending?.delayMs
    },
    get cancelled(): number {
      return cancelled
    },
    /** 把时钟推到排定的时刻并跑那一轮（跑完它会排下一轮）。 */
    async fire(clock: ManualClock): Promise<void> {
      const entry = pending
      if (entry === null) throw new Error('nothing scheduled')
      pending = null
      clock.advance(entry.delayMs)
      await entry.task()
    },
  }
}

/**
 * `start()` 的第一轮是当场发出、不等周期的异步一轮；等它跑完、排上下一轮再往下走。
 * 让出的是宏任务：那一轮要穿过 HTTP 处理函数里的好几层 await。
 */
async function started(
  ledger: ConsoleRegistrations,
  timer: ReturnType<typeof manualScheduler>,
): Promise<void> {
  ledger.start()
  for (let turn = 0; turn < 50 && timer.delayMs === undefined; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (timer.delayMs === undefined) throw new Error('first round never armed')
}

function listed(registry: InMemoryRegistry): string[] {
  return registry.list().map(entry => entry.address)
}

describe('ConsoleRegistrations', () => {
  test('keeps a page registration listed across several leases', async () => {
    const h = harness()
    const timer = manualScheduler()
    const ledger = new ConsoleRegistrations({
      path: freshLedgerPath(),
      registry: h.port,
      schedule: timer.schedule,
      now: () => h.clock.now(),
    })
    await started(ledger, timer)
    // 空登记簿的第一轮什么都不做，下一轮按默认租约排：20 s，与 p81 同一个出处。
    expect(timer.delayMs).toBe(DEFAULT_RENEW_INTERVAL_MS)

    const registered = await ledger.port.register({
      address: PLANNER,
      endpoint: ENDPOINT,
      capabilities: ['task.request'],
    })
    expect(registered.ok).toBe(true)
    // 对照组：同一张表上、没人续租的一条。它就是修复之前页面上那条的命运。
    h.registry.register(REVIEWER, OTHER_ENDPOINT)

    const start = h.clock.now()
    while (h.clock.now() - start <= 3 * DEFAULT_TTL_MS) {
      await timer.fire(h.clock)
      expect(timer.delayMs).toBe(renewIntervalFor(DEFAULT_TTL_MS))
    }

    expect(h.clock.now() - start).toBeGreaterThan(3 * DEFAULT_TTL_MS)
    expect(listed(h.registry)).toEqual([PLANNER])
    const entry = h.registry.resolve(PLANNER)
    expect(entry?.capabilities).toEqual(['task.request'])
    expect(entry?.lastHeartbeatAt).toBeGreaterThan(start)
    ledger.stop()
  })

  test('stops renewing once the page deregisters', async () => {
    const h = harness()
    const timer = manualScheduler()
    const ledger = new ConsoleRegistrations({
      path: freshLedgerPath(),
      registry: h.port,
      schedule: timer.schedule,
      now: () => h.clock.now(),
    })
    await started(ledger, timer)
    await ledger.port.register({ address: PLANNER, endpoint: ENDPOINT })
    await timer.fire(h.clock)
    expect(listed(h.registry)).toEqual([PLANNER])

    const removed = await ledger.port.deregister(PLANNER)
    expect(removed).toEqual({ ok: true, value: undefined })
    expect(ledger.addresses).toEqual([])
    // 现有 DELETE 语义：立即从表上删掉，不等租约。
    expect(listed(h.registry)).toEqual([])

    for (let round = 0; round < 10; round++) await timer.fire(h.clock)
    expect(listed(h.registry)).toEqual([])
    ledger.stop()
  })

  test('treats a ledger entry the registry has already lost as deregistered', async () => {
    const h = harness()
    const ledger = new ConsoleRegistrations({
      path: freshLedgerPath(),
      registry: h.port,
      now: () => h.clock.now(),
    })
    await ledger.port.register({ address: PLANNER, endpoint: ENDPOINT })
    h.restart()

    // 表上没有（注册中心刚重启），但撤销续租这件事做成了，不是「没找到」。
    expect(await ledger.port.deregister(PLANNER)).toEqual({
      ok: true,
      value: undefined,
    })
    // 不在簿里的地址照旧透传注册中心的回答。
    const unknown = await ledger.port.deregister(REVIEWER)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.failure.code).toBe('not_found')
  })

  test('brings entries back after the registry restarts with an empty table', async () => {
    const h = harness()
    const timer = manualScheduler()
    const ledger = new ConsoleRegistrations({
      path: freshLedgerPath(),
      registry: h.port,
      schedule: timer.schedule,
      now: () => h.clock.now(),
    })
    await started(ledger, timer)
    await ledger.port.register({ address: PLANNER, endpoint: ENDPOINT })

    h.restart()
    expect(listed(h.registry)).toEqual([])
    await timer.fire(h.clock)
    expect(listed(h.registry)).toEqual([PLANNER])
    ledger.stop()
  })

  /**
   * 续租是整条重新注册，而注册中心那边「缺省即清空」：续租声明里一旦少了公钥，
   * 每 20 s 就把页面上发布的公钥抹掉一次。控制台带 `--anchors` 时只从名册取节点公钥
   * （2026-09-26 D9b），所以这一格丢了，审计页就对该节点报「名册没有节点的公钥」。
   */
  test('keeps the published public key through renewals, a registry restart and a console rebuild', async () => {
    const KEY = 'Inyg1lW5K3Tsc1VrzZ5-ifdAyfXrFzzBirnDnVsVsvQ'
    const h = harness()
    const path = freshLedgerPath()
    const timer = manualScheduler()
    const first = new ConsoleRegistrations({
      path,
      registry: h.port,
      schedule: timer.schedule,
      now: () => h.clock.now(),
    })
    await started(first, timer)
    const registered = await first.port.register({
      address: PLANNER,
      endpoint: ENDPOINT,
      publicKey: KEY,
    })
    expect(registered.ok).toBe(true)

    await timer.fire(h.clock)
    expect(h.registry.resolve(PLANNER)?.publicKey).toBe(KEY)
    h.restart()
    await timer.fire(h.clock)
    expect(h.registry.resolve(PLANNER)?.publicKey).toBe(KEY)
    first.stop()

    // 控制台自己重建：公钥得从登记簿里读回来，而不是只活在上一个进程的内存里。
    h.restart()
    const rebuiltTimer = manualScheduler()
    const rebuilt = new ConsoleRegistrations({
      path,
      registry: h.port,
      schedule: rebuiltTimer.schedule,
      now: () => h.clock.now(),
    })
    await started(rebuilt, rebuiltTimer)
    expect(h.registry.resolve(PLANNER)?.publicKey).toBe(KEY)
    rebuilt.stop()
  })

  test('brings entries back when the console itself is rebuilt from the same ledger', async () => {
    const h = harness()
    const path = freshLedgerPath()
    const first = new ConsoleRegistrations({
      path,
      registry: h.port,
      now: () => h.clock.now(),
    })
    await first.port.register({
      address: PLANNER,
      endpoint: ENDPOINT,
      capabilities: ['task.request'],
      status: 'dormant',
    })
    first.stop()

    // 控制台停机超过一个租约：没人续，条目按租约消失。
    h.clock.advance(DEFAULT_TTL_MS + 1)
    expect(listed(h.registry)).toEqual([])

    // 重建 = 重启：除了那个文件，什么都不共享。
    const timer = manualScheduler()
    const second = new ConsoleRegistrations({
      path,
      registry: h.port,
      schedule: timer.schedule,
      now: () => h.clock.now(),
    })
    expect(second.addresses).toEqual([PLANNER])
    const outcomes = await second.renewNow()
    expect(outcomes).toEqual([{ kind: 'renewed', address: PLANNER }])
    const entry = h.registry.resolve(PLANNER)
    expect(entry?.endpoint).toBe(ENDPOINT)
    expect(entry?.capabilities).toEqual(['task.request'])
    expect(entry?.status).toBe(AgentStatus.Dormant)
  })

  test('re-announces the ledger immediately on start', async () => {
    const h = harness()
    const path = freshLedgerPath()
    const first = new ConsoleRegistrations({ path, registry: h.port })
    await first.port.register({ address: PLANNER, endpoint: ENDPOINT })
    h.restart()

    const timer = manualScheduler()
    const second = new ConsoleRegistrations({
      path,
      registry: h.port,
      schedule: timer.schedule,
      now: () => h.clock.now(),
    })
    // 第一轮不等周期：`start()` 当场发出，排下一轮之前就已经回到表上。
    await started(second, timer)
    expect(h.clock.now()).toBe(1_000_000)
    expect(listed(h.registry)).toEqual([PLANNER])
    second.stop()
    expect(timer.delayMs).toBeUndefined()
  })

  test('does not take an address another endpoint holds', async () => {
    const h = harness()
    const lines: string[] = []
    const ledger = new ConsoleRegistrations({
      path: freshLedgerPath(),
      registry: h.port,
      log: line => lines.push(line),
    })
    await ledger.port.register({ address: PLANNER, endpoint: ENDPOINT })
    h.restart()
    h.registry.register(PLANNER, OTHER_ENDPOINT)

    const first = await ledger.renewNow()
    const second = await ledger.renewNow()
    expect(first[0]?.kind).toBe('failed')
    expect(second[0]?.kind).toBe('failed')
    expect(h.registry.resolve(PLANNER)?.endpoint).toBe(OTHER_ENDPOINT)
    // 仍在簿里：别人让出这个地址之后，下一轮就把它拿回来。
    expect(ledger.addresses).toEqual([PLANNER])
    // 同一个失败只出声一次，恢复时再出声一次。
    expect(lines.filter(line => line.includes('failed'))).toHaveLength(1)
    expect(lines[0]).toContain(PLANNER)

    h.registry.deregister(PLANNER)
    expect(await ledger.renewNow()).toEqual([
      { kind: 'renewed', address: PLANNER },
    ])
    expect(h.registry.resolve(PLANNER)?.endpoint).toBe(ENDPOINT)
    expect(lines.at(-1)).toContain('recovered')
  })

  test('records only what the registry accepted', async () => {
    const h = harness()
    const path = freshLedgerPath()
    const ledger = new ConsoleRegistrations({ path, registry: h.port })
    const refused = await ledger.port.register({
      address: PLANNER,
      endpoint: 'not a url',
    })
    expect(refused.ok).toBe(false)
    expect(ledger.addresses).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  test('writes an owner-only, versioned document of declarations', async () => {
    const h = harness()
    const path = freshLedgerPath()
    const ledger = new ConsoleRegistrations({ path, registry: h.port })
    await ledger.port.register({
      address: PLANNER,
      endpoint: ENDPOINT,
      capabilities: ['task.request'],
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: REGISTRATION_LEDGER_VERSION,
      registrations: [
        {
          address: PLANNER,
          endpoint: ENDPOINT,
          capabilities: ['task.request'],
        },
      ],
    })
    // 原子写：目录里不留临时文件。
    expect(readdirSync(dirname(path))).toEqual(['registrations.json'])

    await ledger.port.deregister(PLANNER)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: REGISTRATION_LEDGER_VERSION,
      registrations: [],
    })
  })

  test('moves an unreadable ledger aside instead of overwriting it', async () => {
    const h = harness()
    const path = freshLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{"version": 1, "registrations": [')
    const lines: string[] = []
    const ledger = new ConsoleRegistrations({
      path,
      registry: h.port,
      log: line => lines.push(line),
      now: () => Date.UTC(2026, 8, 26, 1, 2, 3),
    })
    expect(ledger.addresses).toEqual([])
    const aside = `${path}.unreadable-2026-09-26T01-02-03-000Z`
    expect(readFileSync(aside, 'utf8')).toBe(
      '{"version": 1, "registrations": [',
    )
    expect(existsSync(path)).toBe(false)
    expect(lines[0]).toContain(aside)
  })

  test('skips malformed entries and keeps the rest', () => {
    const h = harness()
    const path = freshLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        version: REGISTRATION_LEDGER_VERSION,
        registrations: [
          { address: PLANNER, endpoint: ENDPOINT },
          { address: REVIEWER },
          { address: REVIEWER, endpoint: ENDPOINT, capabilities: [1] },
        ],
      }),
    )
    const lines: string[] = []
    const ledger = new ConsoleRegistrations({
      path,
      registry: h.port,
      log: line => lines.push(line),
    })
    expect(ledger.addresses).toEqual([PLANNER])
    expect(lines[0]).toContain('skipped 2 malformed entries')
  })

  test('paces itself by the lease the registry grants and pulls a later round forward', async () => {
    const shortLease = 3_000
    const h = harness(shortLease)
    const timer = manualScheduler()
    const ledger = new ConsoleRegistrations({
      path: freshLedgerPath(),
      registry: h.port,
      schedule: timer.schedule,
      now: () => h.clock.now(),
    })
    await started(ledger, timer)
    // 还没见过注册中心的回执：按默认租约排。
    expect(timer.delayMs).toBe(DEFAULT_RENEW_INTERVAL_MS)

    await ledger.port.register({ address: PLANNER, endpoint: ENDPOINT })
    // 回执说租约只有 3 s：已排的 20 s 那一轮会让这条在第一次续租前过期，所以提前。
    expect(ledger.leaseMs).toBe(shortLease)
    expect(timer.delayMs).toBe(renewIntervalFor(shortLease))

    const start = h.clock.now()
    while (h.clock.now() - start <= 5 * shortLease) await timer.fire(h.clock)
    expect(listed(h.registry)).toEqual([PLANNER])
    ledger.stop()
  })

  test('cleans up a registration a renewal round re-created after deregistration', async () => {
    const h = harness()
    const ledger = new ConsoleRegistrations({
      path: freshLedgerPath(),
      registry: h.port,
    })
    await ledger.port.register({ address: PLANNER, endpoint: ENDPOINT })
    // 一轮续租已经发出、还没回来时，页面注销了它。
    const round = ledger.renewNow()
    await ledger.port.deregister(PLANNER)
    // 注销是同步出簿的，这一轮回来时它已不在簿里：无论 POST 与 DELETE 哪个先到
    // 注册中心，这一轮都补一次 DELETE，表上不留它。
    expect(await round).toEqual([{ kind: 'withdrawn', address: PLANNER }])
    expect(listed(h.registry)).toEqual([])
  })
})

describe('consoleRegistrationsPath', () => {
  test('derives the ledger path from the config root, never from $HOME', () => {
    // CLAUDE.md §1.1②，与转录、备注同一条：OCC_CONFIG_DIR 必须对它有效。
    expect(
      consoleRegistrationsPath().endsWith('/qianmo/console/registrations.json'),
    ).toBe(true)
  })
})
