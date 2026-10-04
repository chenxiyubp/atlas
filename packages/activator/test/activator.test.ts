// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The activator face: catch → wake → forward.
 *
 * **What these tests do not show.** DoD ① — ten consecutive wake-and-forward
 * round trips against a genuinely dormant node, with the stage timings that go
 * with them — needs a real sandbox and is not covered anywhere in this package.
 * What is covered is every decision on our side of the port: that a wake is
 * issued only when the target is not running, that ten requests for one
 * sleeping target produce one wake, that a target which never wakes produces an
 * explicit failure rather than a hang, that a deadline is judged through the
 * time-jump gate, and that no path exists from a caught request to silence.
 */

import { describe, expect, test } from 'bun:test'
import { LIMITS, ProtocolErrorCode } from '@qianmo/protocol'
import { Activator, type ReadyProbe } from '../src/activator.js'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import type {
  SandboxDaemon,
  SandboxStatus,
  SandboxState,
} from '../src/daemon.js'
import { MemoryRequestJournal, type RequestJournal } from '../src/journal.js'
import { TimingRecorder } from '../src/stages.js'
import {
  ManualClock,
  RecordingFailures,
  RecordingForwarder,
  SANDBOX,
  ScriptedProbe,
  immediateScheduler,
  makeMessage,
} from './helpers.js'

/** A daemon a test drives directly. Counts calls; has no destructive member. */
class ScriptedDaemon implements SandboxDaemon {
  state: SandboxState
  acquires = 0
  statuses = 0
  acquireError: Error | null = null
  statusError: Error | null = null
  /** Resolves the pending acquire, so a stampede can be observed mid-flight. */
  #release: (() => void) | null = null

  constructor(state: SandboxState = 'frozen') {
    this.state = state
  }

  async acquire(sandboxName: string): Promise<SandboxStatus> {
    this.acquires += 1
    if (this.#release !== null) {
      await new Promise<void>(resolve => {
        const previous = this.#release
        this.#release = () => {
          previous?.()
          resolve()
        }
      })
    }
    await Promise.resolve()
    if (this.acquireError !== null) throw this.acquireError
    this.state = 'active'
    return { sandboxName, state: this.state }
  }

  async status(sandboxName: string): Promise<SandboxStatus> {
    this.statuses += 1
    await Promise.resolve()
    if (this.statusError !== null) throw this.statusError
    return { sandboxName, state: this.state }
  }

  /** Make the next acquire hang until {@link release} is called. */
  holdAcquire(): void {
    this.#release = () => {
      // Replaced by the waiter above.
    }
  }

  release(): void {
    const release = this.#release
    this.#release = null
    release?.()
  }
}

interface Rig {
  activator: Activator
  daemon: ScriptedDaemon
  probe: ScriptedProbe
  forwarder: RecordingForwarder
  failures: RecordingFailures
  journal: MemoryRequestJournal
  audit: AuditLog
  clock: ManualClock
  timings: TimingRecorder
}

function rig(
  options: {
    state?: SandboxState
    notReadyFor?: number
    probe?: ReadyProbe
    maxInFlight?: number
    readyTimeoutMs?: number
  } = {},
): Rig {
  const clock = new ManualClock(1_000_000)
  const daemon = new ScriptedDaemon(options.state ?? 'frozen')
  const probe = new ScriptedProbe(options.notReadyFor ?? 0)
  const forwarder = new RecordingForwarder()
  const failures = new RecordingFailures()
  const journal = new MemoryRequestJournal()
  const audit = new AuditLog()
  const timings = new TimingRecorder()
  let counter = 0
  const activator = new Activator({
    daemon,
    readyProbe: options.probe ?? probe,
    forward: forwarder,
    failures,
    journal,
    audit,
    clock,
    scheduler: immediateScheduler,
    timings,
    readyPollIntervalMs: 10,
    newRequestId: () => `req-${(counter += 1)}`,
    ...(options.maxInFlight === undefined
      ? {}
      : { maxInFlight: options.maxInFlight }),
    ...(options.readyTimeoutMs === undefined
      ? {}
      : { readyTimeoutMs: options.readyTimeoutMs }),
  })
  return {
    activator,
    daemon,
    probe,
    forwarder,
    failures,
    journal,
    audit,
    clock,
    timings,
  }
}

describe('the happy path', () => {
  test('a request for a frozen target is caught, wakes it, and is forwarded', async () => {
    const { activator, daemon, forwarder, audit, journal } = rig({
      state: 'frozen',
    })
    const envelope = makeMessage()

    const outcome = await activator.handle({ envelope, sandboxName: SANDBOX })

    expect(outcome.status).toBe('forwarded')
    expect(daemon.acquires).toBe(1)
    expect(forwarder.forwarded).toHaveLength(1)
    expect(forwarder.forwarded[0]?.msgId).toBe(envelope.msgId)
    expect(journal.pending()).toEqual([])
    expect(audit.count(ActivatorEventType.RequestAccepted)).toBe(1)
    expect(audit.count(ActivatorEventType.WakeStarted)).toBe(1)
    expect(audit.count(ActivatorEventType.TargetReady)).toBe(1)
    expect(audit.count(ActivatorEventType.RequestForwarded)).toBe(1)
  })

  test('the envelope arrives byte-identical — the activator is not a rewriter', async () => {
    const { activator, forwarder } = rig()
    const envelope = makeMessage({
      payload: { do: 'review', nested: { n: 1 } },
    })
    await activator.handle({ envelope, sandboxName: SANDBOX })
    expect(forwarder.forwarded[0]).toEqual(envelope)
  })

  test('a running target is not woken', async () => {
    const { activator, daemon, audit } = rig({ state: 'active' })
    const outcome = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(outcome.status).toBe('forwarded')
    expect(daemon.acquires).toBe(0)
    expect(audit.count(ActivatorEventType.WakeStarted)).toBe(0)
  })

  test('readiness is probed even when the target was already running', async () => {
    // "Unpaused" is not "ready" (E2), and neither is "the daemon says running".
    const { activator, probe } = rig({ state: 'active' })
    await activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX })
    expect(probe.calls).toBeGreaterThanOrEqual(1)
  })

  test('the wait for readiness is a wait, not a single look', async () => {
    const { activator, probe, forwarder } = rig({
      state: 'frozen',
      notReadyFor: 4,
    })
    const outcome = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(outcome.status).toBe('forwarded')
    expect(probe.calls).toBe(5)
    expect(forwarder.forwarded).toHaveLength(1)
  })

  test('nothing is left in flight afterwards', async () => {
    const { activator } = rig()
    await activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX })
    expect(activator.inFlight).toBe(0)
  })
})

describe('one wake per sleeping target', () => {
  test('ten simultaneous requests issue one acquire between them', async () => {
    const { activator, daemon, forwarder, audit } = rig({ state: 'frozen' })
    daemon.holdAcquire()

    const pending = Array.from({ length: 10 }, () =>
      activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX }),
    )
    // Let every request reach the wake before any of them completes.
    await Promise.resolve()
    await Promise.resolve()
    daemon.release()
    const outcomes = await Promise.all(pending)

    expect(outcomes.every(outcome => outcome.status === 'forwarded')).toBe(true)
    expect(daemon.acquires).toBe(1)
    expect(forwarder.forwarded).toHaveLength(10)
    expect(audit.count(ActivatorEventType.WakeCoalesced)).toBe(9)
  })

  test('a later request after the wake finished wakes again if it refroze', async () => {
    const { activator, daemon } = rig({ state: 'frozen' })
    await activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX })
    expect(daemon.acquires).toBe(1)
    daemon.state = 'frozen'
    await activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX })
    expect(daemon.acquires).toBe(2)
  })
})

describe('no request ends in silence', () => {
  test('a target that never becomes ready fails explicitly', async () => {
    const { activator, failures, journal, audit } = rig({
      state: 'frozen',
      notReadyFor: Number.MAX_SAFE_INTEGER,
      readyTimeoutMs: 0,
    })
    const envelope = makeMessage()
    const outcome = await activator.handle({ envelope, sandboxName: SANDBOX })

    expect(outcome.status).toBe('failed')
    expect(failures.replies).toHaveLength(1)
    expect(failures.codes()).toEqual([ProtocolErrorCode.E_UNDELIVERABLE])
    expect(failures.replies[0]?.to).toBe(envelope.from)
    expect(failures.replies[0]?.taskId).toBe(envelope.taskId)
    expect(journal.pending()).toEqual([])
    expect(audit.count(ActivatorEventType.RequestFailed)).toBe(1)
  })

  test('a wake the daemon refuses fails explicitly', async () => {
    const { activator, daemon, failures } = rig({ state: 'frozen' })
    daemon.acquireError = new Error('sandbox quota exhausted')
    const outcome = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(outcome.status).toBe('failed')
    expect(failures.codes()).toEqual([ProtocolErrorCode.E_UNDELIVERABLE])
    expect(failures.replies[0]?.payload).toMatchObject({
      reason: 'sandbox quota exhausted',
    })
  })

  test('a forward that throws fails explicitly and settles the journal', async () => {
    const { activator, forwarder, failures, journal } = rig({
      state: 'active',
    })
    forwarder.failWith = new Error('peer closed the connection')
    const outcome = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(outcome.status).toBe('failed')
    expect(failures.replies).toHaveLength(1)
    expect(journal.pending()).toEqual([])
  })

  test('handle() never rejects, even when the failure sink is down too', async () => {
    // A rejection at this boundary is indistinguishable from a drop.
    const { activator, forwarder, failures, audit } = rig({ state: 'active' })
    forwarder.failWith = new Error('peer closed the connection')
    failures.throwOnFail = true
    const outcome = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(outcome.status).toBe('failed')
    expect(
      audit
        .of(ActivatorEventType.RequestFailed)
        .some(event => event.detail.notifyFailed !== undefined),
    ).toBe(true)
  })

  test('a journal that will not write means the request was never accepted', async () => {
    // Accepting on an unwritable journal would be a lie: nothing would survive
    // a crash. Refusing leaves the request with the sender, who still has it.
    const broken: RequestJournal = {
      append: () => {
        throw new Error('no space left on device')
      },
      pending: () => [],
      compact: () => undefined,
    }
    const failures = new RecordingFailures()
    const forwarder = new RecordingForwarder()
    const audit = new AuditLog()
    const activator = new Activator({
      daemon: new ScriptedDaemon('active'),
      readyProbe: new ScriptedProbe(),
      forward: forwarder,
      failures,
      journal: broken,
      audit,
      clock: new ManualClock(1_000_000),
      scheduler: immediateScheduler,
    })

    const outcome = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(outcome).toMatchObject({
      status: 'refused',
      code: ProtocolErrorCode.E_UNDELIVERABLE,
    })
    expect(failures.codes()).toEqual([ProtocolErrorCode.E_UNDELIVERABLE])
    expect(forwarder.forwarded).toEqual([])
    expect(audit.count(ActivatorEventType.RequestAccepted)).toBe(0)
    expect(activator.inFlight).toBe(0)
  })

  test('a journal that breaks after the forward does not un-forward it', async () => {
    // The action already happened; throwing here would turn a settled request
    // into an exception at the caller's boundary, which reads as a drop.
    let appends = 0
    const flaky: RequestJournal = {
      append: () => {
        appends += 1
        if (appends > 1) throw new Error('no space left on device')
      },
      pending: () => [],
      compact: () => undefined,
    }
    const forwarder = new RecordingForwarder()
    const audit = new AuditLog()
    const activator = new Activator({
      daemon: new ScriptedDaemon('active'),
      readyProbe: new ScriptedProbe(),
      forward: forwarder,
      failures: new RecordingFailures(),
      journal: flaky,
      audit,
      clock: new ManualClock(1_000_000),
      scheduler: immediateScheduler,
    })

    const outcome = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(outcome.status).toBe('forwarded')
    expect(forwarder.forwarded).toHaveLength(1)
    expect(audit.count(ActivatorEventType.JournalTorn)).toBe(1)
  })

  test('an already-expired envelope is refused rather than taken in', async () => {
    // Rule T-1 step 2: writing a doomed message into the pipeline only consumes
    // budget that a live message needed.
    const { activator, clock, journal, failures, audit } = rig()
    const envelope = makeMessage({
      createdAt: clock.now() - LIMITS.defaultTtlMs - 1,
      deliverTtlMs: LIMITS.defaultTtlMs,
    })
    const outcome = await activator.handle({ envelope, sandboxName: SANDBOX })

    expect(outcome).toMatchObject({
      status: 'refused',
      code: ProtocolErrorCode.E_TTL_EXPIRED,
    })
    expect(journal.pending()).toEqual([])
    expect(failures.codes()).toEqual([ProtocolErrorCode.E_TTL_EXPIRED])
    expect(audit.count(ActivatorEventType.RequestRefused)).toBe(1)
    expect(audit.count(ActivatorEventType.RequestAccepted)).toBe(0)
  })

  test('a full queue refuses loudly instead of buffering without bound', async () => {
    const { activator, daemon, failures } = rig({
      state: 'frozen',
      maxInFlight: 2,
    })
    daemon.holdAcquire()
    const held = [
      activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX }),
      activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX }),
    ]
    await Promise.resolve()
    expect(activator.inFlight).toBe(2)

    const overflow = await activator.handle({
      envelope: makeMessage(),
      sandboxName: SANDBOX,
    })
    expect(overflow).toMatchObject({
      status: 'refused',
      code: ProtocolErrorCode.E_RATE_LIMITED,
    })
    expect(failures.codes()).toEqual([ProtocolErrorCode.E_RATE_LIMITED])

    daemon.release()
    await Promise.all(held)
  })

  test('the delivery deadline is judged again after the wake', async () => {
    // The target does wake, but slowly enough that the sender's deadline is
    // gone by the time it is ready. Warming up is not an excuse for forwarding
    // a message the sender has already given up on — and the warm-up here is
    // 6 s, well inside E2's measured 9.0–10.2 s for a 400 MiB working set.
    const clock = new ManualClock(1_000_000)
    const warmSlowly: ReadyProbe = {
      isReady: async () => {
        clock.advance(6_000)
        await Promise.resolve()
        return true
      },
    }
    const failures = new RecordingFailures()
    const forwarder = new RecordingForwarder()
    const activator = new Activator({
      daemon: new ScriptedDaemon('frozen'),
      readyProbe: warmSlowly,
      forward: forwarder,
      failures,
      journal: new MemoryRequestJournal(),
      audit: new AuditLog(),
      clock,
      scheduler: immediateScheduler,
      readyPollIntervalMs: 10,
    })

    const outcome = await activator.handle({
      envelope: makeMessage({ createdAt: clock.now(), deliverTtlMs: 5_000 }),
      sandboxName: SANDBOX,
    })

    expect(outcome).toMatchObject({
      status: 'failed',
      code: ProtocolErrorCode.E_TTL_EXPIRED,
    })
    expect(failures.codes()).toEqual([ProtocolErrorCode.E_TTL_EXPIRED])
    expect(forwarder.forwarded).toEqual([])
  })
})

describe('a thaw of the activator itself is not a timeout', () => {
  test('deadlines are rebased across a freeze in the wait loop', async () => {
    // The host process is frozen mid-wait: it asks to sleep 10 ms and comes
    // back 97 s later, E4's long round. On thaw both the wake ceiling and the
    // sender's delivery deadline are already behind us; without the gate every
    // request in flight would be failed at that instant (T-2).
    const clock = new ManualClock(1_000_000)
    let probes = 0
    const probe: ReadyProbe = {
      isReady: async () => {
        probes += 1
        await Promise.resolve()
        return probes > 1
      },
    }
    // The freeze happens where the process was waiting, which is the only place
    // a gap is distinguishable from slow work.
    const freezingScheduler = {
      after(_delayMs: number, callback: () => void) {
        clock.advance(97_000)
        queueMicrotask(callback)
        return () => {
          // Nothing to cancel: the callback is already queued.
        }
      },
    }
    const daemon = new ScriptedDaemon('frozen')
    const failures = new RecordingFailures()
    const forwarder = new RecordingForwarder()
    const audit = new AuditLog()
    const activator = new Activator({
      daemon,
      readyProbe: probe,
      forward: forwarder,
      failures,
      journal: new MemoryRequestJournal(),
      audit,
      clock,
      scheduler: freezingScheduler,
      readyPollIntervalMs: 10,
      readyTimeoutMs: 45_000,
    })

    const outcome = await activator.handle({
      envelope: makeMessage({ createdAt: clock.now(), deliverTtlMs: 30_000 }),
      sandboxName: SANDBOX,
    })

    expect(outcome.status).toBe('forwarded')
    expect(forwarder.forwarded).toHaveLength(1)
    expect(failures.replies).toEqual([])
    const jumps = audit.of(ActivatorEventType.TimeJumpDetected)
    expect(jumps).toHaveLength(1)
    expect(jumps[0]?.detail.face).toBe('activator')
    expect(jumps[0]?.detail.gapMs).toBe(97_000)
  })
})

describe('replaying what a dead process left behind', () => {
  /** Build a rig whose journal already owes one request from `acceptedAt`. */
  function seeded(options: {
    acceptedAt: number
    deliverTtlMs: number
    now: number
    state?: SandboxState
    notReadyFor?: number
  }) {
    const clock = new ManualClock(options.now)
    const daemon = new ScriptedDaemon(options.state ?? 'frozen')
    const forwarder = new RecordingForwarder()
    const failures = new RecordingFailures()
    const journal = new MemoryRequestJournal()
    journal.append({
      kind: 'accepted',
      requestId: 'req-survivor',
      sandboxName: SANDBOX,
      acceptedAt: options.acceptedAt,
      envelope: makeMessage({
        msgId: 'msg-survivor',
        createdAt: options.acceptedAt,
        deliverTtlMs: options.deliverTtlMs,
      }),
    })
    const activator = new Activator({
      daemon,
      readyProbe: new ScriptedProbe(options.notReadyFor ?? 0),
      forward: forwarder,
      failures,
      journal,
      audit: new AuditLog(),
      clock,
      scheduler: immediateScheduler,
      readyPollIntervalMs: 10,
      readyTimeoutMs: 45_000,
    })
    return { activator, daemon, forwarder, failures, journal }
  }

  test('the wake budget restarts at startup, not at the old acceptance', async () => {
    // Ten minutes of downtime must not mean the replay fails on its first
    // probe against a ceiling that expired while nothing was running.
    const { activator, forwarder } = seeded({
      acceptedAt: 1_000_000,
      deliverTtlMs: 3_600_000,
      now: 1_600_000,
      notReadyFor: 3,
    })
    const report = await activator.recover()
    expect(report).toEqual({ replayed: 1, forwarded: 1, failed: 0 })
    expect(forwarder.forwarded[0]?.msgId).toBe('msg-survivor')
  })

  test('a replay past the sender deadline fails explicitly and wakes nothing', async () => {
    // The sender's deadline is absolute; missing it is an expiry, not a pass.
    // And there is no point paying for a wake to deliver work nobody wants.
    const { activator, daemon, failures, forwarder, journal } = seeded({
      acceptedAt: 1_000_000,
      deliverTtlMs: 30_000,
      now: 1_600_000,
    })
    const report = await activator.recover()
    expect(report).toEqual({ replayed: 1, forwarded: 0, failed: 1 })
    expect(failures.codes()).toEqual([ProtocolErrorCode.E_TTL_EXPIRED])
    expect(forwarder.forwarded).toEqual([])
    expect(daemon.acquires).toBe(0)
    expect(daemon.statuses).toBe(0)
    expect(journal.pending()).toEqual([])
  })
})

describe('stage timings', () => {
  test('every stage of a wake path is recorded', async () => {
    const clock = new ManualClock(1_000_000)
    const daemon = new ScriptedDaemon('frozen')
    let probes = 0
    const probe: ReadyProbe = {
      isReady: async () => {
        probes += 1
        await Promise.resolve()
        clock.advance(2_000)
        return probes >= 3
      },
    }
    const activator = new Activator({
      daemon,
      readyProbe: probe,
      forward: new RecordingForwarder(),
      failures: new RecordingFailures(),
      journal: new MemoryRequestJournal(),
      audit: new AuditLog(),
      clock,
      scheduler: immediateScheduler,
      readyPollIntervalMs: 10,
      readyTimeoutMs: 45_000,
    })

    const outcome = await activator.handle({
      envelope: makeMessage({ createdAt: clock.now(), deliverTtlMs: 60_000 }),
      sandboxName: SANDBOX,
    })
    expect(outcome.status).toBe('forwarded')
    if (outcome.status !== 'forwarded') return

    const { timings } = outcome
    expect(timings.wakeStartedAt).toBeDefined()
    expect(timings.readyAt).toBeDefined()
    expect(timings.forwardedAt).toBeDefined()
    expect(timings.readyAt ?? 0).toBeGreaterThan(timings.wakeStartedAt ?? 0)

    const report = activator.report()
    expect(report.samples).toBe(1)
    expect(report.forwarded).toBe(1)
    expect(report.wakes).toBe(1)
    // Three probes at 2 s of simulated warm-up each: the wake-to-ready stage is
    // where E2's working-set cost shows up, and it is reported on its own.
    expect(report.wakeToReady.maxMs).toBe(6_000)
    expect(report.total.maxMs).toBeGreaterThanOrEqual(6_000)
  })

  test('a failed request is recorded too, and marked failed', async () => {
    const { activator } = rig({
      state: 'frozen',
      notReadyFor: Number.MAX_SAFE_INTEGER,
      readyTimeoutMs: 0,
    })
    await activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX })
    const report = activator.report()
    expect(report.samples).toBe(1)
    expect(report.failed).toBe(1)
    expect(activator.samples()[0]?.outcome).toBe('failed')
  })

  test('an already-running target reports no wake stage', async () => {
    const { activator } = rig({ state: 'active' })
    await activator.handle({ envelope: makeMessage(), sandboxName: SANDBOX })
    expect(activator.report().wakes).toBe(0)
    expect(activator.samples()[0]?.wakeStartedAt).toBeUndefined()
  })
})
