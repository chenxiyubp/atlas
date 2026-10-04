// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  AgentStatus,
  DEFAULT_RENEW_INTERVAL_MS,
  DEFAULT_TTL_MS,
  InMemoryRegistry,
  ManualClock,
  RegistryErrorCode,
  isValidEndpoint,
  isValidPublicKey,
  renewIntervalFor,
} from '../src/index.js'

const TTL = 90_000

const PLANNER = 'qianmo://tokyo-1/planner'
const WORKER = 'qianmo://osaka-2/worker'
const ENDPOINT = 'wss://tokyo-1.example.com/planner'
const OTHER_ENDPOINT = 'wss://osaka-2.example.com/planner'

// Ed25519 public keys, base64url unpadded (RFC 8037 A.1 / A.2 test vectors).
const NODE_KEY = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'
const OTHER_KEY = 'hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR8'

let clock: ManualClock
let registry: InMemoryRegistry

beforeEach(() => {
  clock = new ManualClock(1_000)
  registry = new InMemoryRegistry({ ttlMs: TTL, clock })
})

describe('endpoint validation', () => {
  test('accepts qianmo addresses and http(s) urls', () => {
    expect(isValidEndpoint('qianmo://tokyo-1/planner')).toBe(true)
    expect(isValidEndpoint('http://127.0.0.1:8080/agent')).toBe(true)
    expect(isValidEndpoint('https://nest.example.com/a')).toBe(true)
  })

  // `dialUrl({unix})` emits exactly this shape, and roadmap P2.2 fixes unix
  // sockets as the transport for single-machine integration runs — so a node
  // that cannot publish it cannot be resolved at all in that topology.
  test('accepts the ws+unix url dialUrl emits for same-host topologies', () => {
    expect(isValidEndpoint('ws+unix:///tmp/qianmo/node-b.sock:/')).toBe(true)
  })

  // The node-to-node transport is a single wss long connection, so a node that
  // cannot register a wss endpoint cannot be dialled at all.
  test('accepts ws(s) urls — the transport nodes actually dial', () => {
    expect(isValidEndpoint('wss://nest.example.com/agent')).toBe(true)
    expect(isValidEndpoint('ws://127.0.0.1:8787/agent')).toBe(true)
  })

  test('rejects anything else', () => {
    expect(isValidEndpoint('ftp://example.com')).toBe(false)
    expect(isValidEndpoint('tokyo-1/planner')).toBe(false)
    expect(isValidEndpoint('')).toBe(false)
    expect(isValidEndpoint(42)).toBe(false)
  })
})

describe('public key validation', () => {
  test('accepts a 32-byte base64url key', () => {
    expect(isValidPublicKey(NODE_KEY)).toBe(true)
    expect(isValidPublicKey(OTHER_KEY)).toBe(true)
  })

  test('rejects wrong length, wrong alphabet and non-strings', () => {
    expect(isValidPublicKey(`${NODE_KEY}x`)).toBe(false)
    expect(isValidPublicKey(NODE_KEY.slice(0, 42))).toBe(false)
    // Standard base64 rather than base64url: `+`, `/` and padding are out.
    expect(
      isValidPublicKey('11qYAYKxCrfVS+7TyWQHOg7hcvPapiMlrwIaaPcHURo'),
    ).toBe(false)
    expect(isValidPublicKey(`${NODE_KEY.slice(0, 42)}=`)).toBe(false)
    expect(isValidPublicKey('')).toBe(false)
    expect(isValidPublicKey(42)).toBe(false)
  })
})

describe('renewal period', () => {
  test('is 20s against the default lease', () => {
    expect(DEFAULT_RENEW_INTERVAL_MS).toBe(20_000)
    expect(renewIntervalFor(DEFAULT_TTL_MS)).toBe(DEFAULT_RENEW_INTERVAL_MS)
  })

  test('keeps 4.5 renewals per lease whatever the lease', () => {
    expect(renewIntervalFor(3_000)).toBe(666)
    expect(renewIntervalFor(3_600_000)).toBe(800_000)
    for (const ttl of [3_000, 12_000, 90_000, 3_600_000]) {
      // Three renewals may be lost in a row and the fourth still lands in time.
      expect(renewIntervalFor(ttl) * 4).toBeLessThan(ttl)
    }
  })

  test('never drops to a zero-length timer', () => {
    expect(renewIntervalFor(1)).toBe(1)
    expect(renewIntervalFor(0)).toBe(1)
  })
})

describe('register', () => {
  test('defaults to a 90s lease', () => {
    expect(DEFAULT_TTL_MS).toBe(90_000)
    expect(new InMemoryRegistry().ttlMs).toBe(90_000)
  })

  test('creates an entry and stamps the lease', () => {
    const result = registry.register(PLANNER, ENDPOINT, {
      capabilities: ['plan', 'summarise'],
    })
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)
    expect(result.created).toBe(true)
    expect(result.entry.address).toBe(PLANNER)
    expect(result.entry.endpoint).toBe(ENDPOINT)
    expect(result.entry.capabilities).toEqual(['plan', 'summarise'])
    expect(result.entry.registeredAt).toBe(1_000)
    expect(result.entry.expiresAt).toBe(1_000 + TTL)
  })

  test('defaults capabilities to an empty list and status to online', () => {
    const result = registry.register(PLANNER, ENDPOINT)
    if (!result.ok) throw new Error('expected ok')
    expect(result.entry.capabilities).toEqual([])
    expect(result.entry.status).toBe(AgentStatus.Online)
    expect(result.entry.publicKey).toBeUndefined()
  })

  test('re-registering the same endpoint refreshes instead of creating', () => {
    registry.register(PLANNER, ENDPOINT, { capabilities: ['plan'] })
    clock.advance(5_000)
    const again = registry.register(PLANNER, ENDPOINT, {
      capabilities: ['plan', 'review'],
    })
    if (!again.ok) throw new Error('expected ok')
    expect(again.created).toBe(false)
    expect(again.entry.registeredAt).toBe(1_000)
    expect(again.entry.expiresAt).toBe(6_000 + TTL)
    expect(again.entry.capabilities).toEqual(['plan', 'review'])
    expect(registry.size).toBe(1)
  })

  test('rejects a different endpoint for a live address with E_CONFLICT', () => {
    registry.register(PLANNER, ENDPOINT)
    const clash = registry.register(PLANNER, OTHER_ENDPOINT)
    expect(clash.ok).toBe(false)
    if (clash.ok) throw new Error('expected conflict')
    expect(clash.code).toBe(RegistryErrorCode.E_CONFLICT)
    // The incumbent keeps the slot.
    expect(registry.resolve(PLANNER)?.endpoint).toBe(ENDPOINT)
  })

  test('allows a new endpoint once the old lease expired', () => {
    registry.register(PLANNER, ENDPOINT)
    clock.advance(TTL + 1)
    const retaken = registry.register(PLANNER, OTHER_ENDPOINT)
    if (!retaken.ok) throw new Error('expected ok')
    expect(retaken.created).toBe(true)
    expect(retaken.entry.endpoint).toBe(OTHER_ENDPOINT)
  })

  test('rejects invalid input with E_BAD_REQUEST', () => {
    for (const bad of [
      registry.register('qianmo://Bad Node/planner', ENDPOINT),
      registry.register(PLANNER, 'nope'),
      registry.register(PLANNER, ENDPOINT, { capabilities: ['ok', 5] }),
      registry.register(PLANNER, ENDPOINT, { publicKey: 'too-short' }),
      registry.register(PLANNER, ENDPOINT, { status: 'napping' }),
    ]) {
      expect(bad.ok).toBe(false)
      if (bad.ok) throw new Error('expected failure')
      expect(bad.code).toBe(RegistryErrorCode.E_BAD_REQUEST)
    }
    expect(registry.size).toBe(0)
  })
})

describe('composite <node>/<agent> key', () => {
  const REVIEWER_A = 'qianmo://node-a/reviewer'
  const REVIEWER_B = 'qianmo://node-b/reviewer'
  const ENDPOINT_A = 'wss://node-a.example.com/reviewer'
  const ENDPOINT_B = 'wss://node-b.example.com/reviewer'

  // AC-2 stands on this one. Under the old bare-name key the second register()
  // came back E_CONFLICT — wrong semantics: these are two different agents.
  test('the same agent name on two nodes coexists, each resolving to its own endpoint', () => {
    const a = registry.register(REVIEWER_A, ENDPOINT_A, {
      capabilities: ['review'],
    })
    const b = registry.register(REVIEWER_B, ENDPOINT_B, {
      capabilities: ['review'],
    })

    if (!a.ok) throw new Error(`node-a: ${a.code} ${a.message}`)
    if (!b.ok) throw new Error(`node-b: ${b.code} ${b.message}`)
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)

    expect(registry.size).toBe(2)
    expect(registry.resolve(REVIEWER_A)?.endpoint).toBe(ENDPOINT_A)
    expect(registry.resolve(REVIEWER_B)?.endpoint).toBe(ENDPOINT_B)
    expect(registry.list().map(e => e.address)).toEqual([
      REVIEWER_A,
      REVIEWER_B,
    ])
  })

  test('deregistering one node leaves the other node untouched', () => {
    registry.register(REVIEWER_A, ENDPOINT_A)
    registry.register(REVIEWER_B, ENDPOINT_B)

    expect(registry.deregister(REVIEWER_A)).toBe(true)
    expect(registry.resolve(REVIEWER_A)).toBeNull()
    expect(registry.resolve(REVIEWER_B)?.endpoint).toBe(ENDPOINT_B)
    expect(registry.size).toBe(1)
  })

  test('heartbeat extends only its own key', () => {
    registry.register(REVIEWER_A, ENDPOINT_A)
    registry.register(REVIEWER_B, ENDPOINT_B)

    clock.advance(TTL - 10)
    expect(registry.heartbeat(REVIEWER_B)?.expiresAt).toBe(clock.now() + TTL)

    clock.advance(11)
    expect(registry.resolve(REVIEWER_A)).toBeNull()
    expect(registry.resolve(REVIEWER_B)).not.toBeNull()
  })

  test('a conflict on one node does not disturb the same name elsewhere', () => {
    registry.register(REVIEWER_A, ENDPOINT_A)
    registry.register(REVIEWER_B, ENDPOINT_B)

    const clash = registry.register(REVIEWER_A, 'wss://impostor.example.com/r')
    expect(clash.ok).toBe(false)
    expect(registry.resolve(REVIEWER_A)?.endpoint).toBe(ENDPOINT_A)
    expect(registry.resolve(REVIEWER_B)?.endpoint).toBe(ENDPOINT_B)
  })

  test('only full qianmo addresses are accepted — one canonical form', () => {
    registry.register(REVIEWER_A, ENDPOINT_A)

    for (const notAnAddress of ['reviewer', 'node-a/reviewer', '', 42]) {
      const result = registry.register(notAnAddress, ENDPOINT_A)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.code).toBe(RegistryErrorCode.E_BAD_REQUEST)
    }

    // Lookups on a non-address miss rather than throw: a junk path must 404,
    // not 500.
    expect(registry.resolve('reviewer')).toBeNull()
    expect(registry.resolve('node-a/reviewer')).toBeNull()
    expect(registry.heartbeat('node-a/reviewer')).toBeNull()
    expect(registry.deregister('node-a/reviewer')).toBe(false)
    expect(registry.resolve(REVIEWER_A)?.endpoint).toBe(ENDPOINT_A)
  })
})

describe('public key on the record', () => {
  test('stores and returns the node public key', () => {
    const result = registry.register(PLANNER, ENDPOINT, {
      publicKey: NODE_KEY,
    })
    if (!result.ok) throw new Error('expected ok')
    expect(result.entry.publicKey).toBe(NODE_KEY)
    expect(registry.resolve(PLANNER)?.publicKey).toBe(NODE_KEY)
  })

  // §10.1 keys the pair to the node, not the agent, so every agent on one
  // node republishes the same key.
  test('agents on one node publish that one node key', () => {
    registry.register(
      'qianmo://node-a/planner',
      'wss://node-a.example.com/planner',
      { publicKey: NODE_KEY },
    )
    registry.register(
      'qianmo://node-a/reviewer',
      'wss://node-a.example.com/reviewer',
      { publicKey: NODE_KEY },
    )
    expect(registry.resolve('qianmo://node-a/planner')?.publicKey).toBe(
      NODE_KEY,
    )
    expect(registry.resolve('qianmo://node-a/reviewer')?.publicKey).toBe(
      NODE_KEY,
    )
  })

  test('re-registration replaces the key rather than merging it', () => {
    registry.register(PLANNER, ENDPOINT, { publicKey: NODE_KEY })
    registry.register(PLANNER, ENDPOINT, { publicKey: OTHER_KEY })
    expect(registry.resolve(PLANNER)?.publicKey).toBe(OTHER_KEY)

    // Every register() is a complete declaration, so an omitted key clears it.
    registry.register(PLANNER, ENDPOINT)
    expect(registry.resolve(PLANNER)?.publicKey).toBeUndefined()
  })

  test('heartbeat preserves the key', () => {
    registry.register(PLANNER, ENDPOINT, { publicKey: NODE_KEY })
    clock.advance(1_000)
    expect(registry.heartbeat(PLANNER)?.publicKey).toBe(NODE_KEY)
  })
})

describe('status marking', () => {
  test('an agent may declare itself dormant and flip back', () => {
    const parked = registry.register(PLANNER, ENDPOINT, {
      status: AgentStatus.Dormant,
    })
    if (!parked.ok) throw new Error('expected ok')
    expect(parked.entry.status).toBe(AgentStatus.Dormant)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Dormant)

    const woken = registry.register(PLANNER, ENDPOINT, {
      status: AgentStatus.Online,
    })
    if (!woken.ok) throw new Error('expected ok')
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Online)
  })

  test('a dormant agent is still live — listed, counted, resolvable', () => {
    registry.register(PLANNER, ENDPOINT, { status: AgentStatus.Dormant })
    expect(registry.size).toBe(1)
    expect(registry.list().map(e => e.address)).toEqual([PLANNER])
    expect(registry.resolve(PLANNER)).not.toBeNull()
  })

  test('heartbeat keeps the declared status', () => {
    registry.register(PLANNER, ENDPOINT, { status: AgentStatus.Dormant })
    clock.advance(1_000)
    expect(registry.heartbeat(PLANNER)?.status).toBe(AgentStatus.Dormant)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Dormant)
  })

  // roadmap P2.1 DoD: 心跳超时后状态自动转 offline.
  test('a missed heartbeat turns the status offline on its own', () => {
    registry.register(PLANNER, ENDPOINT)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Online)

    clock.advance(TTL)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Online)

    clock.advance(1)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Offline)
  })

  test('a dormant agent also falls offline when its lease runs out', () => {
    registry.register(PLANNER, ENDPOINT, { status: AgentStatus.Dormant })
    clock.advance(TTL + 1)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Offline)
  })

  test('unknown and malformed addresses read as offline', () => {
    expect(registry.statusOf('qianmo://tokyo-1/ghost')).toBe(
      AgentStatus.Offline,
    )
    expect(registry.statusOf('planner')).toBe(AgentStatus.Offline)
  })

  test('offline cannot be declared — it is derived from the lease', () => {
    const claimed = registry.register(PLANNER, ENDPOINT, {
      status: AgentStatus.Offline,
    })
    expect(claimed.ok).toBe(false)
    if (claimed.ok) throw new Error('expected failure')
    expect(claimed.code).toBe(RegistryErrorCode.E_BAD_REQUEST)
    expect(registry.size).toBe(0)
  })
})

describe('resolve / list / deregister', () => {
  test('resolves a live agent and misses an unknown one', () => {
    registry.register(PLANNER, ENDPOINT)
    expect(registry.resolve(PLANNER)?.endpoint).toBe(ENDPOINT)
    expect(registry.resolve('qianmo://tokyo-1/ghost')).toBeNull()
  })

  test('lists live agents sorted by address, not insertion order', () => {
    registry.register(PLANNER, ENDPOINT)
    registry.register(WORKER, 'wss://osaka-2.example.com/worker')
    expect(registry.list().map(a => a.address)).toEqual([WORKER, PLANNER])
  })

  test('deregister removes the entry and reports whether it existed', () => {
    registry.register(PLANNER, ENDPOINT)
    expect(registry.deregister(PLANNER)).toBe(true)
    expect(registry.resolve(PLANNER)).toBeNull()
    expect(registry.deregister(PLANNER)).toBe(false)
  })
})

describe('ttl expiry', () => {
  test('an entry stays live up to its deadline and drops out after it', () => {
    registry.register(PLANNER, ENDPOINT)
    clock.advance(TTL - 1)
    expect(registry.resolve(PLANNER)).not.toBeNull()
    clock.advance(1)
    expect(registry.resolve(PLANNER)).not.toBeNull()
    clock.advance(1)
    expect(registry.resolve(PLANNER)).toBeNull()
    expect(registry.list()).toEqual([])
  })

  test('heartbeat extends the lease', () => {
    registry.register(PLANNER, ENDPOINT)
    clock.advance(TTL - 10)
    const beat = registry.heartbeat(PLANNER)
    expect(beat).not.toBeNull()
    expect(beat?.lastHeartbeatAt).toBe(clock.now())
    expect(beat?.expiresAt).toBe(clock.now() + TTL)

    clock.advance(TTL)
    expect(registry.resolve(PLANNER)).not.toBeNull()
    clock.advance(1)
    expect(registry.resolve(PLANNER)).toBeNull()
  })

  test('a thaw rebases leases and lets heartbeat recover', () => {
    registry.observeClock(10_000)
    registry.register(PLANNER, ENDPOINT)

    clock.advance(97_000)
    const observation = registry.observeClock(10_000)

    expect(observation.jumped).toBe(true)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Online)
    expect(registry.heartbeat(PLANNER)).not.toBeNull()
    clock.advance(15_000)
    expect(registry.statusOf(PLANNER)).toBe(AgentStatus.Online)
  })

  test('ordinary elapsed time still expires after time-jump protection is enabled', () => {
    registry.observeClock(10_000)
    registry.register(PLANNER, ENDPOINT)
    for (let elapsed = 0; elapsed <= TTL; elapsed += 10_000) {
      clock.advance(10_000)
      registry.observeClock(10_000)
    }

    expect(registry.resolve(PLANNER)).toBeNull()
  })

  test('heartbeat on an expired or unknown agent returns null', () => {
    registry.register(PLANNER, ENDPOINT)
    clock.advance(TTL + 1)
    expect(registry.heartbeat(PLANNER)).toBeNull()
    expect(registry.heartbeat('qianmo://tokyo-1/ghost')).toBeNull()
  })

  test('full lifecycle: register -> resolve -> heartbeat -> expire', () => {
    registry.register(PLANNER, ENDPOINT, { capabilities: ['plan'] })
    expect(registry.resolve(PLANNER)?.capabilities).toEqual(['plan'])

    clock.advance(TTL / 2)
    expect(registry.heartbeat(PLANNER)).not.toBeNull()

    clock.advance(TTL / 2)
    expect(registry.resolve(PLANNER)).not.toBeNull()

    clock.advance(TTL)
    expect(registry.resolve(PLANNER)).toBeNull()
    expect(registry.size).toBe(0)
  })

  test('prune drops expired entries eagerly', () => {
    registry.register(PLANNER, ENDPOINT)
    registry.register(WORKER, 'wss://osaka-2.example.com/worker')
    clock.advance(TTL + 1)
    expect(registry.prune()).toBe(2)
    expect(registry.prune()).toBe(0)
  })

  test('clear empties the table', () => {
    registry.register(PLANNER, ENDPOINT)
    registry.clear()
    expect(registry.size).toBe(0)
  })
})

describe('one node, one key (protocol.md §10.1, closed in P4.3)', () => {
  test('a second agent on the same node must publish the same key', () => {
    const registry = new InMemoryRegistry({ clock, ttlMs: TTL })
    expect(
      registry.register(PLANNER, ENDPOINT, { publicKey: NODE_KEY }).ok,
    ).toBe(true)

    const conflicting = registry.register(
      'qianmo://tokyo-1/reviewer',
      'wss://tokyo-1.example.com/reviewer',
      { publicKey: OTHER_KEY },
    )
    expect(conflicting.ok).toBe(false)
    if (conflicting.ok) return
    expect(conflicting.code).toBe(RegistryErrorCode.E_CONFLICT)

    // The same key is fine — that is what "the key belongs to the node" means.
    expect(
      registry.register(
        'qianmo://tokyo-1/reviewer',
        'wss://tokyo-1.example.com/reviewer',
        { publicKey: NODE_KEY },
      ).ok,
    ).toBe(true)
  })

  test('a different node is unaffected', () => {
    const registry = new InMemoryRegistry({ clock, ttlMs: TTL })
    registry.register(PLANNER, ENDPOINT, { publicKey: NODE_KEY })
    expect(
      registry.register(WORKER, OTHER_ENDPOINT, { publicKey: OTHER_KEY }).ok,
    ).toBe(true)
  })

  test('an agent may republish its own record with its own key', () => {
    const registry = new InMemoryRegistry({ clock, ttlMs: TTL })
    registry.register(PLANNER, ENDPOINT, { publicKey: NODE_KEY })
    expect(
      registry.register(PLANNER, ENDPOINT, { publicKey: NODE_KEY }).ok,
    ).toBe(true)
  })

  test('once every agent on the node has expired, a new key is accepted', () => {
    // Key rotation is out of scope (N-3), but a node that lost its config and
    // regenerated an identity must not be locked out forever by a lease that
    // ran out long ago.
    const registry = new InMemoryRegistry({ clock, ttlMs: TTL })
    registry.register(PLANNER, ENDPOINT, { publicKey: NODE_KEY })
    clock.advance(TTL + 1)
    expect(
      registry.register(PLANNER, ENDPOINT, { publicKey: OTHER_KEY }).ok,
    ).toBe(true)
  })
})
