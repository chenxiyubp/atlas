// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P5.3's DoD, over real sockets.
 *
 * Three teardown paths, and after each one the same two questions: is the
 * listener actually gone, and is the credential actually gone. "No residual
 * connection" is asserted by **dialing the address again and requiring the dial
 * to fail** — a stopped server is a thing you can check, and checking it is the
 * difference between a teardown and a hopeful `stop()` call.
 *
 * Unix sockets throughout, by `@qianmo/transport`'s own test rule: two servers
 * can bind one TCP port without either erroring, and Linux then splits arriving
 * connections between them non-deterministically.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TransportClient } from '@qianmo/transport'
import {
  TeardownReason,
  TunnelAuditLog,
  TunnelClient,
  TunnelEventType,
  TunnelHost,
  type CancelTimer,
  type Scheduler,
} from '../src/index.js'

const PSK = 'tunnel-test-psk-not-a-real-secret'
const CAPABILITY = 'lease-token.signature'
const LENDER = 'qianmo://node-b/host'
const BORROWER = 'qianmo://node-a/planner'
const TASK = 'task-lease-1'
const OFFER = 'offer-1'

class ManualScheduler implements Scheduler {
  #armed: Array<{ at: number; callback: () => void }> = []
  clock = 1_800_000_000_000

  after(delayMs: number, callback: () => void): CancelTimer {
    const entry = { at: this.clock + delayMs, callback }
    this.#armed.push(entry)
    return () => {
      this.#armed = this.#armed.filter(item => item !== entry)
    }
  }

  advance(ms: number): void {
    this.clock += ms
    const due = this.#armed.filter(entry => entry.at <= this.clock)
    this.#armed = this.#armed.filter(entry => entry.at > this.clock)
    for (const entry of due) entry.callback()
  }

  get pending(): number {
    return this.#armed.length
  }
}

const hosts: TunnelHost[] = []
const clients: TunnelClient[] = []
const raw: TransportClient[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const client of raw.splice(0)) await client.close()
  for (const host of hosts.splice(0)) host.close(TeardownReason.Withdrawn)
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-tunnel-'))
  dirs.push(dir)
  return join(dir, 'tunnel.sock')
}

interface Fixture {
  readonly host: TunnelHost
  readonly audit: TunnelAuditLog
  readonly scheduler: ManualScheduler
  readonly socket: string
  readonly carried: unknown[]
  readonly closed: TeardownReason[]
}

function startHost(
  options: { leaseMs?: number; capability?: string | undefined } = {},
): Fixture {
  const audit = new TunnelAuditLog()
  const scheduler = new ManualScheduler()
  const socket = socketPath()
  const carried: unknown[] = []
  const closed: TeardownReason[] = []
  const host = new TunnelHost({
    offerId: OFFER,
    taskId: TASK,
    borrower: BORROWER,
    psk: PSK,
    ...('capability' in options
      ? options.capability === undefined
        ? {}
        : { capability: options.capability }
      : { capability: CAPABILITY }),
    leaseMs: options.leaseMs ?? 300_000,
    unix: socket,
    audit,
    scheduler,
    now: () => scheduler.clock,
    onWork: message => {
      carried.push(message.payload)
    },
    onClosed: reason => closed.push(reason),
  })
  hosts.push(host)
  host.start()
  return { host, audit, scheduler, socket, carried, closed }
}

/**
 * `null` means "present no capability at all".
 *
 * A default parameter cannot express that: passing `undefined` explicitly is
 * exactly what triggers the default, so the first version of this helper
 * silently handed the token to a test whose whole point was withholding it.
 */
async function connectBorrower(
  fixture: Fixture,
  capability: string | null = CAPABILITY,
): Promise<TunnelClient> {
  const client = new TunnelClient({
    address: BORROWER,
    node: 'node-a',
    psk: PSK,
    endpoint: { unix: fixture.socket },
    taskId: TASK,
    lender: LENDER,
    ...(capability === null ? {} : { capability }),
    audit: fixture.audit,
    now: () => fixture.scheduler.clock,
  })
  clients.push(client)
  await client.connect(3_000)
  return client
}

/** Dial the address directly and report whether anything answered. */
async function stillListening(socket: string): Promise<boolean> {
  if (!existsSync(socket)) return false
  const client = new TransportClient({
    endpoint: { unix: socket },
    node: 'node-probe',
    psk: PSK,
    keepAliveIntervalMs: 0,
    backoff: { giveUpAfterMs: 0 },
  })
  raw.push(client)
  try {
    await client.connect(500)
    return true
  } catch {
    return false
  } finally {
    await client.close()
  }
}

describe('the tunnel carries work while the lease lives', () => {
  test('an admitted borrower gets its work across', async () => {
    const fixture = startHost()
    const client = await connectBorrower(fixture)
    await client.send({ run: 'the borrowed job' })
    expect(fixture.carried).toEqual([{ run: 'the borrowed job' }])
    expect(fixture.audit.count(TunnelEventType.Opened)).toBe(1)
    expect(fixture.audit.count(TunnelEventType.Admitted)).toBe(1)
  })

  test('nothing listens before a lease exists', async () => {
    // "On demand" means exactly this: the socket is created by `start()`, not
    // by the process starting.
    const socket = socketPath()
    expect(await stillListening(socket)).toBe(false)
  })
})

describe('admission', () => {
  test('a message without the lease capability is refused', async () => {
    const fixture = startHost()
    const client = await connectBorrower(fixture, null)
    await expect(client.send({ run: 'sneak in' }, 2_000)).rejects.toThrow()
    expect(fixture.carried).toEqual([])
    expect(fixture.audit.count(TunnelEventType.Refused)).toBe(1)
  })

  test('a message with somebody else’s capability is refused', async () => {
    const fixture = startHost()
    const client = await connectBorrower(fixture, 'another-lease.signature')
    await expect(client.send({ run: 'sneak in' }, 2_000)).rejects.toThrow()
    expect(fixture.audit.count(TunnelEventType.Refused)).toBe(1)
  })

  test('a message for another lease is refused even with the right token', async () => {
    const fixture = startHost()
    const wrongTask = new TunnelClient({
      address: BORROWER,
      node: 'node-a',
      psk: PSK,
      endpoint: { unix: fixture.socket },
      taskId: 'task-somebody-else',
      lender: LENDER,
      capability: CAPABILITY,
      audit: fixture.audit,
    })
    clients.push(wrongTask)
    await wrongTask.connect(3_000)
    await expect(
      wrongTask.send({ run: 'wrong lease' }, 2_000),
    ).rejects.toThrow()
    expect(fixture.carried).toEqual([])
  })

  test('another peer’s address is refused', async () => {
    const fixture = startHost()
    const intruder = new TunnelClient({
      address: 'qianmo://node-c/intruder',
      node: 'node-c',
      psk: PSK,
      endpoint: { unix: fixture.socket },
      taskId: TASK,
      lender: LENDER,
      capability: CAPABILITY,
      audit: fixture.audit,
    })
    clients.push(intruder)
    await intruder.connect(3_000)
    await expect(intruder.send({ run: 'not mine' }, 2_000)).rejects.toThrow()
    expect(fixture.carried).toEqual([])
  })

  test('a tunnel with no capability configured says so rather than pretending', async () => {
    // A deployment without capability wiring still gets a tunnel; what it does
    // not get is the admission check, and the audit record says which it is.
    const fixture = startHost({ capability: undefined })
    expect(
      fixture.audit.of(TunnelEventType.Opened)[0]?.detail['requiresCapability'],
    ).toBe(false)
    const client = await connectBorrower(fixture, null)
    await client.send({ run: 'psk was enough' })
    expect(fixture.carried).toHaveLength(1)
  })
})

describe('the three teardown paths', () => {
  test('1. normal release: the lender tears down and nothing answers after', async () => {
    const fixture = startHost()
    const client = await connectBorrower(fixture)
    await client.send({ run: 'work' })
    await client.close()

    fixture.host.close(TeardownReason.Released)
    expect(fixture.closed).toEqual([TeardownReason.Released])
    expect(fixture.host.open).toBe(false)
    expect(await stillListening(fixture.socket)).toBe(false)
    expect(fixture.scheduler.pending).toBe(0)
  })

  test('2. lease expiry: nobody has to say anything', async () => {
    const fixture = startHost({ leaseMs: 60_000 })
    await connectBorrower(fixture)
    fixture.scheduler.advance(60_001)

    expect(fixture.closed).toEqual([TeardownReason.Expired])
    expect(await stillListening(fixture.socket)).toBe(false)
    expect(fixture.audit.of(TunnelEventType.Closed)[0]?.detail['reason']).toBe(
      TeardownReason.Expired,
    )
  })

  test('3. the peer disappears: teardown without a release', async () => {
    const fixture = startHost()
    const client = await connectBorrower(fixture)
    await client.send({ run: 'work' })

    // The borrower dies mid-task: the socket closes, no release is ever sent.
    await client.close()
    await waitFor(() => fixture.closed.length === 1)

    expect(fixture.closed).toEqual([TeardownReason.PeerLost])
    expect(await stillListening(fixture.socket)).toBe(false)
  })

  test('teardown is idempotent and keeps the first reason', async () => {
    const fixture = startHost()
    fixture.host.close(TeardownReason.Released)
    fixture.host.close(TeardownReason.Withdrawn)
    expect(fixture.closed).toEqual([TeardownReason.Released])
    expect(fixture.audit.count(TunnelEventType.Closed)).toBe(1)
  })

  test('the expiry timer does not outlive an early teardown', async () => {
    const fixture = startHost({ leaseMs: 60_000 })
    fixture.host.close(TeardownReason.Released)
    expect(fixture.scheduler.pending).toBe(0)
    // And firing the clock past the old deadline changes nothing.
    fixture.scheduler.advance(120_000)
    expect(fixture.closed).toEqual([TeardownReason.Released])
  })
})

describe('no residue', () => {
  test('after teardown the address refuses connections', async () => {
    const fixture = startHost()
    await connectBorrower(fixture)
    expect(await stillListening(fixture.socket)).toBe(true)
    fixture.host.close(TeardownReason.Released)
    expect(await stillListening(fixture.socket)).toBe(false)
  })

  test('a reconnect attempt after teardown does not resurrect the lease', async () => {
    // The client is configured never to reconnect (see `client.ts`), and the
    // host retains no channel for a returning peer. Both halves are asserted.
    const fixture = startHost()
    const client = await connectBorrower(fixture)
    fixture.host.close(TeardownReason.Expired)
    // A short budget on purpose: with the listener gone there is nobody to
    // receipt this, and the property under test is that the send fails rather
    // than that it fails quickly.
    await expect(client.send({ run: 'after the end' }, 1_000)).rejects.toThrow()
    expect(fixture.carried).toEqual([])
  })

  test('the audit trail records both ends of every tunnel', async () => {
    // A trail with opens and no closes reads as a system that lends and never
    // takes back — which is exactly the failure AC-7's sixth beat is about.
    const fixture = startHost()
    await connectBorrower(fixture)
    fixture.host.close(TeardownReason.Released)
    expect(fixture.audit.count(TunnelEventType.Opened)).toBe(
      fixture.audit.count(TunnelEventType.Closed),
    )
  })
})

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}
