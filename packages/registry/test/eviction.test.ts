// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Retired nodes leave the table — memory and state file — within one clock
 * pulse, and a time jump never brings them back.
 *
 * The field report this pins (2026-09, M1 backlog): four rows for nodes whose
 * machines had been terminated stayed in the registry's state file marked
 * `online`. Two defects produced that shape, and each test below is red on
 * the code before the fix:
 *
 * 1. Nothing in production evicted an expired row. Reads hid it, but only a
 *    write to that same key, `prune()` (no caller) or a restart removed it,
 *    and every renewal of *another* row rewrote the whole map to disk — the
 *    dead row included, with the `status` it last declared.
 * 2. The time-jump grace window let `list()` and `resolve()` answer with every
 *    row in the map, including ones that had expired long before the jump.
 *
 * The pulse is driven here by calling `observeClock` the way
 * `startRegistryServer`'s 10 s timer does, on a `ManualClock`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentStatus,
  FileRegistryStore,
  InMemoryRegistry,
  ManualClock,
} from '../src/index.js'

const TTL = 90_000
const PULSE = 10_000
const RETIRED = 'qianmo://beta-2/planner'
const LIVE = 'qianmo://beta-1/planner'

let directory: string
let statePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-registry-eviction-'))
  statePath = join(directory, 'agents.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function stateRows(): { address: string; status: string }[] {
  const document = JSON.parse(readFileSync(statePath, 'utf8')) as {
    agents: { address: string; status: string }[]
  }
  return document.agents
}

/** Advance `ms` in pulse steps, renewing `LIVE` every other pulse. */
function run(registry: InMemoryRegistry, clock: ManualClock, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += PULSE) {
    clock.advance(PULSE)
    registry.observeClock(PULSE)
    if ((elapsed / PULSE) % 2 === 0) registry.heartbeat(LIVE)
  }
}

describe('a retired node leaves the table', () => {
  test('its row is gone from the state file within one pulse of expiry, while another node keeps renewing', () => {
    const clock = new ManualClock(1_000_000)
    const registry = new InMemoryRegistry({
      ttlMs: TTL,
      clock,
      store: new FileRegistryStore(statePath),
    })
    registry.observeClock(PULSE)
    registry.register(RETIRED, 'ws://127.0.0.1:38632')
    registry.register(LIVE, 'ws://127.0.0.1:38631')

    run(registry, clock, TTL)
    // Still inside its lease: on the roster and on disk.
    expect(stateRows().map(row => row.address)).toContain(RETIRED)

    run(registry, clock, 2 * PULSE)
    expect(registry.list().map(entry => entry.address)).toEqual([LIVE])
    expect(stateRows()).toEqual([
      expect.objectContaining({ address: LIVE, status: 'online' }),
    ])

    // And it stays gone however long the other node keeps renewing.
    run(registry, clock, 30 * 60_000)
    expect(stateRows().map(row => row.address)).toEqual([LIVE])
  })

  test('a time jump does not put a long-expired row back on the roster', () => {
    const clock = new ManualClock(1_000_000)
    const registry = new InMemoryRegistry({ ttlMs: TTL, clock })
    registry.observeClock(PULSE)
    registry.register(RETIRED, 'ws://127.0.0.1:38632')
    registry.register(LIVE, 'ws://127.0.0.1:38631')
    run(registry, clock, 10 * 60_000)

    clock.advance(60_000) // the process was suspended for a minute
    expect(registry.observeClock(PULSE).jumped).toBe(true)

    expect(registry.list().map(entry => entry.address)).toEqual([LIVE])
    expect(registry.statusOf(RETIRED)).toBe(AgentStatus.Offline)
    expect(registry.resolve(RETIRED)).toBeNull()
  })

  test('a lease that ran out during one grace window is not carried across the next jump', () => {
    const clock = new ManualClock(1_000_000)
    const registry = new InMemoryRegistry({ ttlMs: TTL, clock })
    registry.observeClock(PULSE)
    registry.register(RETIRED, 'ws://127.0.0.1:38632')
    // Alive at the last tick before the first jump (expires 10 s later).
    run(registry, clock, 80_000)

    clock.advance(30_000)
    expect(registry.observeClock(PULSE).jumped).toBe(true)
    // Carried across the first jump, as a lease whose renewer was frozen too.
    expect(registry.statusOf(RETIRED)).toBe(AgentStatus.Online)

    // Its rebased deadline passes inside the grace window (pruning is off
    // there), and nothing renews it. Then the clock jumps again.
    clock.advance(11_000)
    registry.observeClock(PULSE)
    clock.advance(40_000)
    expect(registry.observeClock(PULSE).jumped).toBe(true)

    expect(registry.list()).toEqual([])
    expect(registry.statusOf(RETIRED)).toBe(AgentStatus.Offline)
  })

  test('a lease that was alive when the clock was last seen still survives the jump', () => {
    const clock = new ManualClock(1_000_000)
    const registry = new InMemoryRegistry({ ttlMs: TTL, clock })
    registry.observeClock(PULSE)
    registry.register(LIVE, 'ws://127.0.0.1:38631')

    clock.advance(97_000)
    expect(registry.observeClock(PULSE).jumped).toBe(true)
    expect(registry.statusOf(LIVE)).toBe(AgentStatus.Online)
    expect(registry.heartbeat(LIVE)).not.toBeNull()
  })
})
