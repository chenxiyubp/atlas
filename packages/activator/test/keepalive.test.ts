// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The keepalive face.
 *
 * **What these tests do not show.** Whether a heartbeat at this period actually
 * keeps a real sandbox out of the freezer is DoD ②; it needs a real sandbox and
 * nothing in this file is evidence about it. That measurement was made on the
 * host on 2026-08-12 — control froze at t≈45 s against a 60 s threshold, the
 * experiment stayed `active` for the full 120 s at a 20 s beat — and the
 * numbers live in `keepalive.ts`, next to the code they justify. What is tested
 * here is our own side: that the period is forced under the freeze threshold,
 * that a failed beat retries *sooner* rather than later, that a thaw is
 * recognised instead of being counted as failure, and that the configuration E3
 * showed to be a trap is refused outright.
 *
 * The numbers 110 and 411 in the assertions below are E3's: a 100 %-CPU process
 * frozen 110 s after start, then 411 s with zero progress and no self-recovery.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import { DEFAULT_RESIDENT_KEEPALIVE_TIME_JUMP_FACTOR } from '../src/activity.js'
import { capabilitySurface } from '../src/capability.js'
import type { SandboxStatus } from '../src/daemon.js'
import { HttpSandboxDaemon } from '../src/daemon.js'
import {
  DEFAULT_PERIOD_RATIO,
  KeepaliveLoop,
  MAX_PERIOD_RATIO,
  MIN_RETRY_DELAY_MS,
  ResidencyPolicyError,
  assertResidencyPolicy,
  keepalivePeriodMs,
  type KeepaliveDegraded,
  type KeepalivePort,
} from '../src/keepalive.js'
import { ManualClock, ManualScheduler, SANDBOX } from './helpers.js'
import { STUB_TOKEN, startStubDaemon } from './stub-daemon.js'

/** E3's measured freeze point for a busy sandbox, in seconds. */
const E3_FREEZE_AFTER_SECONDS = 110

const HEALTHY_POLICY = {
  freezeAfterSeconds: E3_FREEZE_AFTER_SECONDS,
  stopAfterSeconds: 600,
}

/**
 * An `acquire`-only daemon a test drives directly. No module is intercepted.
 *
 * `acquire`, not `touch`: the daemon has no `touch` method, and `acquire` is
 * the one call measured to reset the idle clock. See `keepalive.ts` for what
 * that costs in type-level safety.
 */
class ScriptedAcquire implements KeepalivePort {
  calls = 0
  failuresLeft = 0
  /**
   * What the call reports back. Whether the real daemon reports the sandbox as
   * found or as left is not known, so no test here depends on the difference.
   */
  state: SandboxStatus['state'] = 'active'

  async acquire(sandboxName: string): Promise<SandboxStatus> {
    this.calls += 1
    await Promise.resolve()
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1
      throw new Error('daemon unreachable')
    }
    return { sandboxName, state: this.state }
  }
}

describe('the residency policy E3 rejected', () => {
  test('stopAfterSeconds: null is refused, and the refusal explains why', () => {
    expect(() =>
      assertResidencyPolicy({
        freezeAfterSeconds: E3_FREEZE_AFTER_SECONDS,
        stopAfterSeconds: null,
      }),
    ).toThrow(ResidencyPolicyError)

    // The reasoning has to travel with the refusal, or the next person removes
    // the check: the failure it prevents looks nothing like a safety feature.
    let message = ''
    try {
      assertResidencyPolicy({ freezeAfterSeconds: 110, stopAfterSeconds: null })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toContain('110 s')
    expect(message).toContain('411 s')
    expect(message).toContain('forever')
  })

  test('a finite stop threshold with a freeze threshold below it is accepted', () => {
    expect(() => assertResidencyPolicy(HEALTHY_POLICY)).not.toThrow()
  })

  test('freezeAfterSeconds: null is allowed — it is the other honest option', () => {
    expect(() =>
      assertResidencyPolicy({
        freezeAfterSeconds: null,
        stopAfterSeconds: 600,
      }),
    ).not.toThrow()
    expect(
      keepalivePeriodMs({ freezeAfterSeconds: null, stopAfterSeconds: 600 }),
    ).toBeNull()
  })

  test('a freeze threshold at or above the stop threshold is refused', () => {
    // Then the sandbox stops before it ever freezes, and the threshold this
    // heartbeat is sized against does not exist.
    expect(() =>
      assertResidencyPolicy({ freezeAfterSeconds: 600, stopAfterSeconds: 600 }),
    ).toThrow(/must be below stopAfterSeconds/)
  })

  test('non-positive thresholds are refused', () => {
    expect(() =>
      assertResidencyPolicy({ freezeAfterSeconds: 0, stopAfterSeconds: 60 }),
    ).toThrow(ResidencyPolicyError)
    expect(() =>
      assertResidencyPolicy({ freezeAfterSeconds: 10, stopAfterSeconds: 0 }),
    ).toThrow(ResidencyPolicyError)
  })
})

describe('the period is forced under the freeze threshold', () => {
  test('the default period is a third of it', () => {
    const period = keepalivePeriodMs(HEALTHY_POLICY)
    expect(period).toBe(Math.floor(110_000 * DEFAULT_PERIOD_RATIO))
    expect(period).toBeLessThan(110_000)
  })

  test('a ratio above one half is refused', () => {
    expect(() =>
      keepalivePeriodMs(HEALTHY_POLICY, MAX_PERIOD_RATIO + 0.01),
    ).toThrow(ResidencyPolicyError)
  })

  test('an explicit period at or above half the threshold is refused', () => {
    const audit = new AuditLog()
    expect(
      () =>
        new KeepaliveLoop({
          sandboxName: SANDBOX,
          daemon: new ScriptedAcquire(),
          policy: HEALTHY_POLICY,
          audit,
          periodMs: 55_001,
        }),
    ).toThrow(/not safely under the freeze threshold/)
  })

  test('a period a hair under half is accepted', () => {
    const loop = new KeepaliveLoop({
      sandboxName: SANDBOX,
      daemon: new ScriptedAcquire(),
      policy: HEALTHY_POLICY,
      audit: new AuditLog(),
      periodMs: 55_000,
    })
    expect(loop.periodMs).toBe(55_000)
    expect(loop.freezeAfterMs).toBe(110_000)
  })

  test('a never-freezing sandbox gets no loop at all', () => {
    expect(
      () =>
        new KeepaliveLoop({
          sandboxName: SANDBOX,
          daemon: new ScriptedAcquire(),
          policy: { freezeAfterSeconds: null, stopAfterSeconds: 600 },
          audit: new AuditLog(),
        }),
    ).toThrow(/never freezes/)
  })
})

describe('beating', () => {
  const build = (
    daemon: KeepalivePort,
    onDegraded?: (d: KeepaliveDegraded) => void,
  ) => {
    const clock = new ManualClock(1_000_000)
    const audit = new AuditLog()
    const loop = new KeepaliveLoop({
      sandboxName: SANDBOX,
      daemon,
      policy: HEALTHY_POLICY,
      audit,
      clock,
      scheduler: new ManualScheduler(),
      ...(onDegraded === undefined ? {} : { onDegraded }),
    })
    return { clock, audit, loop }
  }

  test('a healthy beat acquires the sandbox and comes back after one period', async () => {
    const daemon = new ScriptedAcquire()
    const { audit, loop } = build(daemon)
    const beat = await loop.beat()
    expect(beat.ok).toBe(true)
    expect(daemon.calls).toBe(1)
    expect(beat.nextDelayMs).toBe(loop.periodMs)
    expect(audit.count(ActivatorEventType.KeepaliveTick)).toBe(1)
  })

  test('the state the daemon reported is recorded, not acted on', async () => {
    // Recorded because a real run should be able to read it back; not acted on
    // because whether acquireSandbox reports the sandbox as found or as left
    // has not been checked against the real daemon.
    const daemon = new ScriptedAcquire()
    daemon.state = 'frozen'
    const { audit, loop } = build(daemon)
    const beat = await loop.beat()
    expect(beat.ok).toBe(true)
    expect(beat.nextDelayMs).toBe(loop.periodMs)
    expect(
      audit.of(ActivatorEventType.KeepaliveTick).at(-1)?.detail.state,
    ).toBe('frozen')
  })

  test('a failed beat retries sooner, not later', async () => {
    // The inverse of ordinary backoff, and the reason is the whole design: the
    // cost of waiting is a freeze nothing recovers from, not load on a peer.
    const daemon = new ScriptedAcquire()
    const { loop } = build(daemon)
    await loop.beat()
    daemon.failuresLeft = 3
    const first = await loop.beat()
    expect(first.ok).toBe(false)
    expect(first.nextDelayMs).toBeLessThan(loop.periodMs)
    expect(first.nextDelayMs).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS)
  })

  test('the retry interval keeps shrinking as the freeze deadline nears', async () => {
    const daemon = new ScriptedAcquire()
    const { clock, loop } = build(daemon)
    await loop.beat()
    daemon.failuresLeft = 10

    const delays: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const beat = await loop.beat()
      delays.push(beat.nextDelayMs)
      // Advance by less than the jump threshold so this reads as elapsed work,
      // not as a freeze.
      clock.advance(loop.periodMs)
    }
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeLessThanOrEqual(delays[i - 1] ?? 0)
    }
    expect(delays.at(-1)).toBeGreaterThanOrEqual(MIN_RETRY_DELAY_MS)
  })

  test('enough consecutive failures raise a degraded signal', async () => {
    const daemon = new ScriptedAcquire()
    const degraded: KeepaliveDegraded[] = []
    const { audit, loop } = build(daemon, detail => degraded.push(detail))
    await loop.beat()
    daemon.failuresLeft = 3
    await loop.beat()
    await loop.beat()
    expect(degraded).toHaveLength(0)
    await loop.beat()
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.consecutiveFailures).toBe(3)
    expect(degraded[0]?.freezeAfterMs).toBe(110_000)
    expect(audit.count(ActivatorEventType.KeepaliveDegraded)).toBe(1)
  })

  test('a beat never rejects, however badly the daemon behaves', async () => {
    const exploding: KeepalivePort = {
      acquire: () => Promise.reject(new Error('connection reset')),
    }
    const { loop } = build(exploding)
    const beat = await loop.beat()
    expect(beat.ok).toBe(false)
    expect(beat.error).toContain('connection reset')
  })

  test('a success clears the failure streak', async () => {
    const daemon = new ScriptedAcquire()
    const { loop } = build(daemon)
    daemon.failuresLeft = 2
    await loop.beat()
    await loop.beat()
    const recovered = await loop.beat()
    expect(recovered.ok).toBe(true)
    expect(recovered.consecutiveFailures).toBe(0)
    expect(recovered.nextDelayMs).toBe(loop.periodMs)
  })
})

describe('a thaw is not a failure', () => {
  test('the 34.7 s E4 gap distinguishes factor 2 from the A/B candidate', async () => {
    const build = (
      factor: number,
    ): { loop: KeepaliveLoop; clock: ManualClock } => {
      const clock = new ManualClock(1_000_000)
      const loop = new KeepaliveLoop({
        sandboxName: SANDBOX,
        daemon: new ScriptedAcquire(),
        policy: HEALTHY_POLICY,
        audit: new AuditLog(),
        clock,
        scheduler: new ManualScheduler(),
        periodMs: 20_000,
        timeJumpFactor: factor,
      })
      return { loop, clock }
    }

    const baseline = build(2)
    await baseline.loop.beat()
    baseline.clock.advance(34_700)
    expect((await baseline.loop.beat()).timeJumpDetected).toBe(false)

    const candidate = build(DEFAULT_RESIDENT_KEEPALIVE_TIME_JUMP_FACTOR)
    await candidate.loop.beat()
    candidate.clock.advance(34_700)
    expect((await candidate.loop.beat()).timeJumpDetected).toBe(true)
  })

  test('a gap past the threshold is audited as a time jump', async () => {
    const daemon = new ScriptedAcquire()
    const clock = new ManualClock(1_000_000)
    const audit = new AuditLog()
    const loop = new KeepaliveLoop({
      sandboxName: SANDBOX,
      daemon,
      policy: HEALTHY_POLICY,
      audit,
      clock,
      scheduler: new ManualScheduler(),
    })

    await loop.beat()
    // The sandbox was frozen for 97 s (E4's long round) while the heartbeat
    // period is 36.6 s: the loop comes back to a clock that moved without it.
    clock.advance(97_000)
    const beat = await loop.beat()

    expect(beat.timeJumpDetected).toBe(true)
    expect(beat.gapMs).toBe(97_000)
    expect(beat.ok).toBe(true)
    const jumps = audit.of(ActivatorEventType.TimeJumpDetected)
    expect(jumps).toHaveLength(1)
    expect(jumps[0]?.detail.face).toBe('keepalive')
  })

  test('a thaw clears an in-progress failure streak instead of adding to it', async () => {
    const daemon = new ScriptedAcquire()
    const clock = new ManualClock(1_000_000)
    const degraded: KeepaliveDegraded[] = []
    const loop = new KeepaliveLoop({
      sandboxName: SANDBOX,
      daemon,
      policy: HEALTHY_POLICY,
      audit: new AuditLog(),
      clock,
      scheduler: new ManualScheduler(),
      onDegraded: detail => degraded.push(detail),
    })

    await loop.beat()
    daemon.failuresLeft = 2
    await loop.beat()
    await loop.beat()
    // Now the process freezes and thaws. Without the gate, the very next
    // failure would be the third in a row and the node would declare itself
    // degraded for having been asleep.
    clock.advance(97_000)
    daemon.failuresLeft = 1
    const afterThaw = await loop.beat()
    expect(afterThaw.timeJumpDetected).toBe(true)
    expect(afterThaw.consecutiveFailures).toBe(1)
    expect(degraded).toHaveLength(0)
  })
})

describe('the guarantee the missing touch verb took with it', () => {
  test('the keepalive port can wake a sandbox, and no type says otherwise', () => {
    // Pinned as a test rather than left in a comment, because this used to be a
    // claim the compiler enforced: the face held `Pick<SandboxDaemon, 'touch'>`,
    // so waking was unreachable from here. The daemon has no `touch`, the beat
    // is `acquire`, and `acquire` wakes. A future reader must not be able to
    // mistake the old promise for the current state of affairs.
    const port: KeepalivePort = new ScriptedAcquire()
    expect(typeof port.acquire).toBe('function')
  })

  test('what survived: nothing destructive is reachable from that port', () => {
    // The property AC-6(c) actually rests on never depended on the narrowing.
    // It is the allowlist, it is unchanged, and it is two entries long.
    const port = new ScriptedAcquire() as unknown as Record<string, unknown>
    expect(port.destroySandbox).toBeUndefined()
    expect(port.execCommand).toBeUndefined()
    expect([...capabilitySurface()].sort()).toEqual([
      'acquireSandbox',
      'listSandboxes',
    ])
  })
})

describe('the loop against a real local server', () => {
  const stubs: { stop: () => Promise<void> }[] = []

  afterEach(async () => {
    for (const stub of stubs.splice(0)) await stub.stop()
  })

  test('start() beats repeatedly over HTTP and stop() ends it', async () => {
    const stub = startStubDaemon({
      initialState: 'active',
      sandboxes: [SANDBOX],
    })
    stubs.push(stub)
    const audit = new AuditLog()
    const daemon = new HttpSandboxDaemon({
      baseUrl: stub.url,
      token: () => STUB_TOKEN,
      audit,
    })
    // A sandbox that freezes after 60 ms is not realistic; it is the smallest
    // configuration that exercises the real timer path in a test.
    const loop = new KeepaliveLoop({
      sandboxName: SANDBOX,
      daemon,
      policy: { freezeAfterSeconds: 0.06, stopAfterSeconds: 600 },
      audit,
      periodMs: 5,
    })
    loop.start()
    const deadline = Date.now() + 2_000
    while (stub.hits.acquireSandbox < 4 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    loop.stop()
    expect(loop.running).toBe(false)
    expect(stub.hits.acquireSandbox).toBeGreaterThanOrEqual(4)
    expect(stub.hits.unauthorized).toBe(0)
    // The heartbeat's vocabulary is still one word — but the word is now the
    // wake verb, so "it cannot wake anything" is no longer among the things
    // this assertion says. What it does still say is that nothing else on the
    // 31-method API was touched, `destroySandbox` least of all.
    expect(stub.hits.listSandboxes).toBe(0)
    expect(stub.hits.destroySandbox).toBe(0)
    expect(stub.hits.unknown).toBe(0)

    const settled = stub.hits.acquireSandbox
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stub.hits.acquireSandbox).toBe(settled)
  })

  test('a beat thaws a sandbox that froze while the loop was down', async () => {
    // The one thing the lost type narrowing bought back. Under the imagined
    // `touch` API a loop that missed enough beats could only keep failing
    // against a frozen sandbox; because the beat *is* the wake verb, the next
    // successful beat brings it back.
    const stub = startStubDaemon({
      initialState: 'frozen',
      sandboxes: [SANDBOX],
    })
    stubs.push(stub)
    const audit = new AuditLog()
    const daemon = new HttpSandboxDaemon({
      baseUrl: stub.url,
      token: () => STUB_TOKEN,
      audit,
    })
    const loop = new KeepaliveLoop({
      sandboxName: SANDBOX,
      daemon,
      policy: { freezeAfterSeconds: 0.06, stopAfterSeconds: 600 },
      audit,
      periodMs: 5,
    })
    expect(stub.stateOf(SANDBOX)).toBe('frozen')
    const beat = await loop.beat()
    expect(beat.ok).toBe(true)
    expect(stub.stateOf(SANDBOX)).toBe('active')
    expect(stub.hits.destroySandbox).toBe(0)
  })

  test('an HTTP failure is a failed beat, not a crash, and the loop recovers', async () => {
    const stub = startStubDaemon({
      initialState: 'active',
      sandboxes: [SANDBOX],
    })
    stubs.push(stub)
    const audit = new AuditLog()
    const daemon = new HttpSandboxDaemon({
      baseUrl: stub.url,
      token: () => STUB_TOKEN,
      audit,
    })
    const loop = new KeepaliveLoop({
      sandboxName: SANDBOX,
      daemon,
      policy: { freezeAfterSeconds: 0.06, stopAfterSeconds: 600 },
      audit,
      periodMs: 5,
    })
    stub.failAcquires(2)
    const first = await loop.beat()
    expect(first.ok).toBe(false)
    const second = await loop.beat()
    expect(second.ok).toBe(false)
    const third = await loop.beat()
    expect(third.ok).toBe(true)
    expect(audit.count(ActivatorEventType.KeepaliveTickFailed)).toBe(2)
    expect(audit.count(ActivatorEventType.KeepaliveTick)).toBe(1)
  })
})
