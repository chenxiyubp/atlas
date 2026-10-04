// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentStatus,
  FileRegistryStore,
  InMemoryRegistry,
  ManualClock,
  REGISTRY_SNAPSHOT_VERSION,
  defaultRegistryStatePath,
  type RegistryStore,
} from '../src/index.js'

const TTL = 90_000
const T0 = 1_000_000

const PLANNER = 'qianmo://tokyo-1/planner'
const WORKER = 'qianmo://osaka-2/worker'
const PLANNER_ENDPOINT = 'wss://tokyo-1.example.com/planner'
const WORKER_ENDPOINT = 'wss://osaka-2.example.com/worker'

// Ed25519 public key, base64url unpadded (RFC 8037 A.1 test vector).
const NODE_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'

/**
 * Every test writes inside a fresh temp directory. Nothing here may touch the
 * real config root: `~/.qianmo/registry/agents.json` belongs to whatever node
 * the developer is actually running.
 */
let directory: string
let statePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-registry-'))
  statePath = join(directory, 'registry', 'agents.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** A registry backed by the temp-directory state file. */
function boot(clock: ManualClock, ttlMs = TTL): InMemoryRegistry {
  return new InMemoryRegistry({
    ttlMs,
    clock,
    store: new FileRegistryStore(statePath),
  })
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
}

describe('state file location', () => {
  test('default path is derived from the occ config root, not hand-assembled', () => {
    const previous = process.env['OCC_CONFIG_DIR']
    process.env['OCC_CONFIG_DIR'] = directory
    try {
      // Proves the path follows `occConfigPath`: overriding the config root
      // moves the state file with it. A `join(homedir(), '.occ')` literal
      // would ignore the override and keep pointing at the real home.
      expect(defaultRegistryStatePath()).toBe(statePath)
    } finally {
      if (previous === undefined) delete process.env['OCC_CONFIG_DIR']
      else process.env['OCC_CONFIG_DIR'] = previous
    }
  })

  test('exposes the path it was given', () => {
    expect(new FileRegistryStore(statePath).path).toBe(statePath)
  })

  test('persistence is opt-in: no store means no file', () => {
    const registry = new InMemoryRegistry({
      ttlMs: TTL,
      clock: new ManualClock(T0),
    })
    expect(registry.register(PLANNER, PLANNER_ENDPOINT).ok).toBe(true)
    expect(readdirSync(directory)).toEqual([])
  })
})

describe('restart (roadmap P2.1 DoD: 注册中心重启后节点可自动重新注册)', () => {
  test('registrations survive a new process and still resolve', () => {
    const first = boot(new ManualClock(T0))
    expect(
      first.register(PLANNER, PLANNER_ENDPOINT, {
        capabilities: ['plan', 'review'],
        publicKey: NODE_KEY,
      }).ok,
    ).toBe(true)
    expect(
      first.register(WORKER, WORKER_ENDPOINT, {
        capabilities: ['build'],
        status: AgentStatus.Dormant,
      }).ok,
    ).toBe(true)

    // The restart: a brand new registry and store, sharing nothing but the file.
    const restarted = boot(new ManualClock(T0 + 1_000))

    expect(restarted.size).toBe(2)
    expect(restarted.list().map(entry => entry.address)).toEqual([
      WORKER,
      PLANNER,
    ])

    const planner = restarted.resolve(PLANNER)
    expect(planner).not.toBeNull()
    expect(planner?.endpoint).toBe(PLANNER_ENDPOINT)
    expect(planner?.capabilities).toEqual(['plan', 'review'])
    expect(planner?.publicKey).toBe(NODE_KEY)
    expect(planner?.status).toBe(AgentStatus.Online)
    expect(planner?.registeredAt).toBe(T0)
    expect(planner?.lastHeartbeatAt).toBe(T0)
    expect(planner?.expiresAt).toBe(T0 + TTL)
    expect(restarted.statusOf(PLANNER)).toBe(AgentStatus.Online)

    // The declared status is part of the record, not re-defaulted to online.
    expect(restarted.statusOf(WORKER)).toBe(AgentStatus.Dormant)
    expect(restarted.resolve(WORKER)?.capabilities).toEqual(['build'])
    expect(restarted.resolve(WORKER)?.publicKey).toBeUndefined()
  })

  test('a lease that expired while the registry was down is not online again', () => {
    const first = boot(new ManualClock(T0))
    first.register(PLANNER, PLANNER_ENDPOINT)
    first.register(WORKER, WORKER_ENDPOINT)
    expect(first.size).toBe(2)

    // Both records really are on disk before the restart — otherwise the
    // assertions below would pass for the wrong reason.
    expect((readState()['agents'] as readonly unknown[]).length).toBe(2)

    // The registry comes back one millisecond past the leases it wrote.
    const restarted = boot(new ManualClock(T0 + TTL + 1))

    expect(restarted.list()).toEqual([])
    expect(restarted.size).toBe(0)
    expect(restarted.resolve(PLANNER)).toBeNull()
    expect(restarted.statusOf(PLANNER)).toBe(AgentStatus.Offline)
    expect(restarted.statusOf(WORKER)).toBe(AgentStatus.Offline)

    // And the recovery path works: re-registering brings the agent straight
    // back, as a fresh registration rather than a refresh of the dead lease.
    expect(restarted.register(PLANNER, PLANNER_ENDPOINT)).toMatchObject({
      ok: true,
      created: true,
    })
    expect(restarted.statusOf(PLANNER)).toBe(AgentStatus.Online)
  })

  test('only the leases that actually expired are dropped', () => {
    const clock = new ManualClock(T0)
    const first = boot(clock)
    first.register(PLANNER, PLANNER_ENDPOINT)

    // The worker registers past the planner's lease; the planner fell silent.
    clock.advance(TTL + 1)
    first.register(WORKER, WORKER_ENDPOINT)

    const restarted = boot(new ManualClock(T0 + TTL + 1))
    expect(restarted.list().map(entry => entry.address)).toEqual([WORKER])
    expect(restarted.statusOf(PLANNER)).toBe(AgentStatus.Offline)
    expect(restarted.statusOf(WORKER)).toBe(AgentStatus.Online)
  })

  test('a heartbeat, not just the registration, is what survives', () => {
    const clock = new ManualClock(T0)
    const first = boot(clock)
    first.register(PLANNER, PLANNER_ENDPOINT)
    clock.advance(TTL - 1)
    expect(first.heartbeat(PLANNER)).not.toBeNull()

    // Past the original lease, inside the renewed one.
    const restarted = boot(new ManualClock(T0 + TTL + 1))
    expect(restarted.statusOf(PLANNER)).toBe(AgentStatus.Online)
    expect(restarted.resolve(PLANNER)?.lastHeartbeatAt).toBe(T0 + TTL - 1)
    // registeredAt is preserved across the heartbeat and the restart alike.
    expect(restarted.resolve(PLANNER)?.registeredAt).toBe(T0)
  })

  test('the deadline is recomputed from the TTL in force, not read off disk', () => {
    const first = boot(new ManualClock(T0))
    first.register(PLANNER, PLANNER_ENDPOINT)
    expect(first.resolve(PLANNER)?.expiresAt).toBe(T0 + TTL)

    // Restart configured with a shorter lease: the stored deadline must not
    // keep a silent agent listed for longer than the new policy allows.
    const restarted = boot(new ManualClock(T0), 1_000)
    expect(restarted.resolve(PLANNER)?.expiresAt).toBe(T0 + 1_000)
    expect(boot(new ManualClock(T0 + 2_000), 1_000).statusOf(PLANNER)).toBe(
      AgentStatus.Offline,
    )
  })

  test('deregistration survives the restart too', () => {
    const first = boot(new ManualClock(T0))
    first.register(PLANNER, PLANNER_ENDPOINT)
    first.register(WORKER, WORKER_ENDPOINT)
    expect(first.deregister(PLANNER)).toBe(true)

    const restarted = boot(new ManualClock(T0))
    expect(restarted.list().map(entry => entry.address)).toEqual([WORKER])
  })

  test('prune and clear are written through', () => {
    const clock = new ManualClock(T0)
    const first = boot(clock)
    first.register(PLANNER, PLANNER_ENDPOINT)
    clock.advance(TTL + 1)
    expect(first.prune()).toBe(1)
    expect(readState()['agents']).toEqual([])

    first.register(WORKER, WORKER_ENDPOINT)
    first.clear()
    expect(readState()['agents']).toEqual([])
    expect(boot(new ManualClock(clock.now())).size).toBe(0)
  })
})

describe('crash safety', () => {
  test('a completed write leaves the target valid and no temp files behind', () => {
    const registry = boot(new ManualClock(T0))
    registry.register(PLANNER, PLANNER_ENDPOINT)
    registry.register(WORKER, WORKER_ENDPOINT)
    registry.heartbeat(PLANNER)

    expect(readdirSync(join(directory, 'registry'))).toEqual(['agents.json'])
    expect(readState()['version']).toBe(REGISTRY_SNAPSHOT_VERSION)
  })

  test('a truncated file does not brick startup, and the next write repairs it', () => {
    const registry = boot(new ManualClock(T0))
    registry.register(PLANNER, PLANNER_ENDPOINT)

    // What a process killed by a naive in-place writer would leave behind.
    writeFileSync(statePath, '{"version":1,"agents":[{"address":"qianmo:/')

    const restarted = boot(new ManualClock(T0))
    expect(restarted.size).toBe(0)

    restarted.register(WORKER, WORKER_ENDPOINT)
    expect(readState()['version']).toBe(REGISTRY_SNAPSHOT_VERSION)
    expect(boot(new ManualClock(T0)).statusOf(WORKER)).toBe(AgentStatus.Online)
  })

  test('a leftover temp file is ignored and cleaned up by the next write', () => {
    const registry = boot(new ManualClock(T0))
    registry.register(PLANNER, PLANNER_ENDPOINT)
    writeFileSync(`${statePath}.999.abandoned.tmp`, 'garbage')

    expect(boot(new ManualClock(T0)).statusOf(PLANNER)).toBe(AgentStatus.Online)
    expect(readdirSync(join(directory, 'registry')).sort()).toEqual([
      'agents.json',
      'agents.json.999.abandoned.tmp',
    ])
  })

  test('a write that dies partway leaves the previous document intact', () => {
    const registry = boot(new ManualClock(T0))
    registry.register(PLANNER, PLANNER_ENDPOINT)
    const before = readFileSync(statePath, 'utf8')

    // Fails inside `write`, after the temp file exists but before the rename —
    // the exact window a killed process would die in. `JSON.stringify` refuses
    // a BigInt, which is the cheapest way to stop there deterministically.
    const store = new FileRegistryStore(statePath)
    expect(() => {
      store.write({ version: REGISTRY_SNAPSHOT_VERSION, agents: 1n })
    }).toThrow()

    expect(readFileSync(statePath, 'utf8')).toBe(before)
    expect(readdirSync(join(directory, 'registry'))).toEqual(['agents.json'])
    expect(boot(new ManualClock(T0)).statusOf(PLANNER)).toBe(AgentStatus.Online)
  })

  test('a missing file is simply an empty registry', () => {
    expect(existsSync(statePath)).toBe(false)
    expect(boot(new ManualClock(T0)).size).toBe(0)
  })
})

describe('reading untrusted state', () => {
  function seed(document: unknown): void {
    new FileRegistryStore(statePath).write(document)
  }

  test('a document from an unknown schema version is ignored wholesale', () => {
    seed({
      version: REGISTRY_SNAPSHOT_VERSION + 1,
      agents: [
        {
          address: PLANNER,
          endpoint: PLANNER_ENDPOINT,
          capabilities: [],
          status: AgentStatus.Online,
          registeredAt: T0,
          lastHeartbeatAt: T0,
        },
      ],
    })
    expect(boot(new ManualClock(T0)).size).toBe(0)
  })

  test('individually malformed records are dropped, the rest survive', () => {
    const good = {
      address: PLANNER,
      endpoint: PLANNER_ENDPOINT,
      capabilities: ['plan'],
      status: AgentStatus.Online,
      registeredAt: T0,
      lastHeartbeatAt: T0,
    }
    seed({
      version: REGISTRY_SNAPSHOT_VERSION,
      agents: [
        good,
        { ...good, address: 'qianmo://tokyo-1' },
        { ...good, address: 'not-an-address' },
        { ...good, address: 'qianmo://kyoto-3/a', endpoint: 'ftp://x/y' },
        { ...good, address: 'qianmo://kyoto-3/b', publicKey: 'too-short' },
        { ...good, address: 'qianmo://kyoto-3/c', status: AgentStatus.Offline },
        { ...good, address: 'qianmo://kyoto-3/d', lastHeartbeatAt: 'soon' },
        { ...good, address: 'qianmo://kyoto-3/e', capabilities: [42] },
        'not even an object',
        null,
      ],
    })

    const registry = boot(new ManualClock(T0))
    expect(registry.list().map(entry => entry.address)).toEqual([PLANNER])
  })

  test('a document that is not a snapshot at all is ignored', () => {
    for (const document of [[], 'nope', 42, null, { version: 1 }]) {
      rmSync(statePath, { force: true })
      seed(document)
      expect(boot(new ManualClock(T0)).size).toBe(0)
    }
  })

  test('a record missing registeredAt falls back to its heartbeat', () => {
    seed({
      version: REGISTRY_SNAPSHOT_VERSION,
      agents: [
        {
          address: PLANNER,
          endpoint: PLANNER_ENDPOINT,
          capabilities: [],
          status: AgentStatus.Online,
          lastHeartbeatAt: T0,
        },
      ],
    })
    expect(boot(new ManualClock(T0)).resolve(PLANNER)?.registeredAt).toBe(T0)
  })
})

describe('persistence failures', () => {
  test('a failing store costs durability, not availability', () => {
    const failure = new Error('disk full')
    const seen: unknown[] = []
    const broken: RegistryStore = {
      read: () => null,
      write: () => {
        throw failure
      },
    }
    const registry = new InMemoryRegistry({
      ttlMs: TTL,
      clock: new ManualClock(T0),
      store: broken,
      onPersistError: error => seen.push(error),
    })

    expect(registry.register(PLANNER, PLANNER_ENDPOINT).ok).toBe(true)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Online)
    expect(seen).toEqual([failure])
  })

  test('a write failure is swallowed even with no error hook installed', () => {
    const registry = new InMemoryRegistry({
      ttlMs: TTL,
      clock: new ManualClock(T0),
      store: {
        read: () => null,
        write: () => {
          throw new Error('read-only filesystem')
        },
      },
    })
    expect(registry.register(PLANNER, PLANNER_ENDPOINT).ok).toBe(true)
  })
})
