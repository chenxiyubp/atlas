// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS } from '@qianmo/protocol'
import type { BackoffOptions } from '../src/backoff.js'
import { type FireDispatch, SchedulerRunner } from '../src/fire.js'
import { dedupKeyOf } from '../src/job.js'
import { SchedulerStore } from '../src/store.js'

const MINUTE = 60_000
const ANCHOR = 1_700_000_000_000

/**
 * A backoff wide enough to bite inside a one-minute schedule.
 *
 * The 30 s default is shorter than this test job's period, so with it the
 * penalty is always served before the next slot arrives and the hold is never
 * observable. `backoff.test.ts` pins the default; this pins the mechanism.
 */
const SLOW_BACKOFF: BackoffOptions = { baseMs: 5 * MINUTE, capMs: 60 * MINUTE }

let directory: string
/** Injected wall clock — nothing in this file waits on a real one. */
let clock = ANCHOR

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-scheduler-fire-'))
  clock = ANCHOR
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const JOB = {
  id: 'watch-ci',
  title: 'watch the build',
  target: 'qianmo://beta-1/planner',
  prompt: 'summarise anything red',
  schedule: { everyMs: MINUTE, anchorMs: ANCHOR },
  taskTtlMs: 900_000,
  notifyPolicy: 'agent-initiated' as const,
}

/** A dispatch spy. No mocks anywhere in this package — this is a closure. */
function spy(behaviour?: (input: FireDispatch) => void) {
  const seen: FireDispatch[] = []
  return {
    seen,
    dispatch: async (input: FireDispatch): Promise<void> => {
      seen.push(input)
      behaviour?.(input)
    },
  }
}

function makeStore(): SchedulerStore {
  return new SchedulerStore(directory, { now: () => clock })
}

function runner(options: {
  readonly store?: SchedulerStore
  readonly dispatch: (input: FireDispatch) => Promise<void>
  readonly paused?: () => boolean
  readonly onError?: (error: unknown) => void
  readonly backoff?: BackoffOptions
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
}): SchedulerRunner {
  return new SchedulerRunner({
    store: options.store ?? makeStore(),
    dispatch: options.dispatch,
    jobs: [JOB],
    now: () => clock,
    paused: options.paused,
    onError: options.onError,
    backoff: options.backoff,
    schedule: options.schedule,
  })
}

/** Advance the injected clock and drive one pass explicitly. */
async function tick(scheduler: SchedulerRunner, now: number): Promise<void> {
  clock = now
  await scheduler.runDue(now)
}

/** Let every pending microtask settle. A zero timer, never a real wait. */
function flush(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

describe('the dedup key makes a reservation idempotent', () => {
  test('reserving one (jobId, fireAtMs) repeatedly fires exactly once', async () => {
    const dispatcher = spy()
    const scheduler = runner({ dispatch: dispatcher.dispatch })
    for (let pass = 0; pass < 10; pass++) {
      await tick(scheduler, ANCHOR + MINUTE + pass)
    }
    expect(dispatcher.seen).toHaveLength(1)
    expect(dispatcher.seen[0]?.dedupKey).toBe(
      dedupKeyOf('watch-ci', ANCHOR + MINUTE),
    )
  })

  test('the key the host receives is the one job.ts builds, never a second spelling', async () => {
    const dispatcher = spy()
    const scheduler = runner({ dispatch: dispatcher.dispatch })
    await tick(scheduler, ANCHOR + MINUTE)
    const fired = dispatcher.seen[0]
    expect(fired?.dedupKey).toBe(dedupKeyOf(JOB.id, fired?.fireAtMs ?? -1))
  })
})

describe('at most once across two schedulers sharing one store', () => {
  test('two instances racing one slot produce one claim and one dispatch', async () => {
    // Roadmap F7's scenario: an operator started a second `qm console`. Two
    // stores, two runners, one directory — the kernel picks the winner inside
    // the `wx` syscall, so neither runner has to know the other exists.
    const first = spy()
    const second = spy()
    const alpha = runner({ store: makeStore(), dispatch: first.dispatch })
    const beta = runner({ store: makeStore(), dispatch: second.dispatch })

    const now = ANCHOR + MINUTE
    clock = now
    await Promise.all([alpha.runDue(now), beta.runDue(now)])

    expect(first.seen.length + second.seen.length).toBe(1)
  })

  test('the loser moves on instead of losing the same race on every pass', async () => {
    const winner = spy()
    const loser = spy()
    const alpha = runner({ store: makeStore(), dispatch: winner.dispatch })
    const beta = runner({ store: makeStore(), dispatch: loser.dispatch })

    await tick(alpha, ANCHOR + MINUTE)
    await tick(beta, ANCHOR + MINUTE)
    expect(winner.seen).toHaveLength(1)
    expect(loser.seen).toHaveLength(0)
    expect(beta.status().jobs[0]?.lastOutcome).toBe('preempted')

    // The next slot: whoever gets there first takes it, and it is still one
    // fire in total rather than one per hub.
    await tick(beta, ANCHOR + 2 * MINUTE)
    await tick(alpha, ANCHOR + 2 * MINUTE)
    expect(winner.seen.length + loser.seen.length).toBe(2)
  })

  test('a restart that lost its state file still cannot re-fire a claimed slot', async () => {
    // The claim, not the state file, is what at-most-once rests on.
    const before = spy()
    await tick(runner({ dispatch: before.dispatch }), ANCHOR + MINUTE)
    expect(before.seen).toHaveLength(1)

    rmSync(join(directory, 'state.json'), { force: true })

    const after = spy()
    await tick(runner({ dispatch: after.dispatch }), ANCHOR + MINUTE)
    expect(after.seen).toHaveLength(0)
  })
})

describe('catch-up after downtime', () => {
  test('five missed periods produce one make-up run, and the loss is counted', async () => {
    // Both halves of the DoD: a dispatch count of one alone would also pass for
    // an implementation that silently lost all five.
    const dispatcher = spy()
    const store = makeStore()
    const scheduler = runner({ store, dispatch: dispatcher.dispatch })

    await tick(scheduler, ANCHOR + MINUTE) // the last run before the outage
    expect(dispatcher.seen).toHaveLength(1)

    // The hub is gone for five periods and comes back.
    await tick(scheduler, ANCHOR + 6 * MINUTE + 1_000)
    expect(dispatcher.seen).toHaveLength(2)
    expect(dispatcher.seen[1]?.fireAtMs).toBe(ANCHOR + 6 * MINUTE)
    expect(store.stateOf('watch-ci').lastFiredAt).toBe(ANCHOR + 6 * MINUTE)
  })

  test('a make-up run does not also replay the periods it skipped', async () => {
    const dispatcher = spy()
    const scheduler = runner({ dispatch: dispatcher.dispatch })
    await tick(scheduler, ANCHOR + MINUTE)
    await tick(scheduler, ANCHOR + 6 * MINUTE + 1_000)
    // Another pass a second later: nothing is left over waiting to run.
    await tick(scheduler, ANCHOR + 6 * MINUTE + 2_000)
    expect(dispatcher.seen.map(fire => fire.fireAtMs)).toEqual([
      ANCHOR + MINUTE,
      ANCHOR + 6 * MINUTE,
    ])
  })
})

describe('failure backoff holds a failing job off the grid', () => {
  test('a failing job waits out an increasing penalty and a success clears it', async () => {
    let failing = true
    const dispatcher = spy(() => {
      if (failing) throw new Error('target unreachable')
    })
    const errors: unknown[] = []
    const store = makeStore()
    const scheduler = runner({
      store,
      dispatch: dispatcher.dispatch,
      backoff: SLOW_BACKOFF,
      onError: error => errors.push(error),
    })

    await tick(scheduler, ANCHOR + MINUTE)
    expect(dispatcher.seen).toHaveLength(1)
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(1)
    expect(errors).toHaveLength(1)

    // The next slot is due, but the five-minute penalty is not served.
    await tick(scheduler, ANCHOR + 2 * MINUTE)
    expect(dispatcher.seen).toHaveLength(1)
    expect(scheduler.status().jobs[0]?.nextFireAt).toBe(ANCHOR + 6 * MINUTE)

    // Penalty served: it tries again, and fails again.
    await tick(scheduler, ANCHOR + 6 * MINUTE)
    expect(dispatcher.seen).toHaveLength(2)
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(2)

    // The second penalty is longer than the first — the divergence from hermes
    // cron, which has no backoff at all, because a watch job has real side
    // effects and hammering a dead target burns a node's serialized turns.
    await tick(scheduler, ANCHOR + 7 * MINUTE)
    expect(dispatcher.seen).toHaveLength(2)
    expect(scheduler.status().jobs[0]?.nextFireAt).toBe(ANCHOR + 16 * MINUTE)

    failing = false
    await tick(scheduler, ANCHOR + 16 * MINUTE)
    expect(dispatcher.seen).toHaveLength(3)
    expect(store.stateOf('watch-ci').consecutiveFailures).toBe(0)
    expect(store.stateOf('watch-ci').lastOutcome).toBe('completed')

    // And the penalty is gone: the very next slot runs.
    await tick(scheduler, ANCHOR + 17 * MINUTE)
    expect(dispatcher.seen).toHaveLength(4)
  })

  test('the attempt number the host sees counts the failures before it', async () => {
    let failing = true
    const dispatcher = spy(() => {
      if (failing) throw new Error('down')
    })
    const scheduler = runner({
      dispatch: dispatcher.dispatch,
      backoff: SLOW_BACKOFF,
      onError: () => undefined,
    })
    await tick(scheduler, ANCHOR + MINUTE)
    await tick(scheduler, ANCHOR + 6 * MINUTE)
    failing = false
    await tick(scheduler, ANCHOR + 16 * MINUTE)
    expect(dispatcher.seen.map(fire => fire.attempt)).toEqual([1, 2, 3])
  })

  test('a dispatch that throws never escapes runDue', async () => {
    const scheduler = runner({
      dispatch: async () => {
        throw new Error('boom')
      },
      onError: () => undefined,
    })
    clock = ANCHOR + MINUTE
    await expect(scheduler.runDue(ANCHOR + MINUTE)).resolves.toBeUndefined()
  })
})

describe('there is no periodic ticker', () => {
  test('start arms exactly one timer and re-arms only after a run completes', async () => {
    // The whole of hermes A6 in one assertion. A cadence that kept firing
    // regardless of completion is the thing this design does not have — on the
    // hub because it is unnecessary, on the node because it would abolish the
    // freeze charter R-3 asks for.
    const armed: number[] = []
    let pending: (() => void) | undefined
    const dispatcher = spy()
    const scheduler = runner({
      dispatch: dispatcher.dispatch,
      schedule: (delayMs, callback) => {
        armed.push(delayMs)
        pending = callback
        return {
          cancel: () => {
            pending = undefined
          },
        }
      },
    })

    scheduler.start()
    expect(armed).toEqual([0])
    expect(pending).toBeDefined()

    // Nothing fires until that single armed callback is invoked.
    clock = ANCHOR + MINUTE
    expect(dispatcher.seen).toHaveLength(0)
    const fire = pending
    pending = undefined
    fire?.()
    await flush()

    expect(dispatcher.seen).toHaveLength(1)
    // Exactly one new timer, armed from the plan the completed run produced.
    expect(armed).toHaveLength(2)
    expect(armed[1]).toBe(MINUTE)
    scheduler.stop()
  })

  test('stop cancels the outstanding reservation and arms nothing more', () => {
    let armed = 0
    let cancelled = 0
    const scheduler = runner({
      dispatch: spy().dispatch,
      schedule: () => {
        armed++
        return {
          cancel: () => {
            cancelled++
          },
        }
      },
    })
    scheduler.start()
    expect(armed).toBe(1)
    scheduler.stop()
    expect(cancelled).toBe(1)
    expect(scheduler.running).toBe(false)
    scheduler.stop()
    expect(armed).toBe(1)
  })

  test('overlapping runDue calls do not both plan from the same state', async () => {
    let release: (() => void) | undefined
    const dispatcher = spy()
    const scheduler = runner({
      dispatch: async input => {
        await dispatcher.dispatch(input)
        await new Promise<void>(resolve => {
          release = resolve
        })
      },
    })
    clock = ANCHOR + MINUTE
    const first = scheduler.runDue(ANCHOR + MINUTE)
    const second = scheduler.runDue(ANCHOR + MINUTE)
    await second
    expect(dispatcher.seen).toHaveLength(1)
    await flush()
    release?.()
    await first
    expect(dispatcher.seen).toHaveLength(1)
  })
})

describe('the ESTOP hook', () => {
  test('a pause is consulted before every fire and takes no claim', async () => {
    // Design §3.B6 names the scheduler's fire as one of ESTOP's three
    // checkpoints. Taking a claim while paused would suppress the run that
    // should happen once the brake comes off.
    let paused = true
    const dispatcher = spy()
    const store = makeStore()
    const scheduler = runner({
      store,
      dispatch: dispatcher.dispatch,
      paused: () => paused,
    })

    await tick(scheduler, ANCHOR + MINUTE)
    expect(dispatcher.seen).toHaveLength(0)
    expect(store.claimed('watch-ci', ANCHOR + MINUTE)).toBe(false)

    paused = false
    await tick(scheduler, ANCHOR + MINUTE + 1_000)
    expect(dispatcher.seen).toHaveLength(1)
  })

  test('a pause is a skip, not a stop: lastTickAt keeps moving', async () => {
    const scheduler = runner({ dispatch: spy().dispatch, paused: () => true })
    await tick(scheduler, ANCHOR + MINUTE)
    expect(scheduler.lastTickAt).toBe(ANCHOR + MINUTE)
  })

  test('a predicate that throws fails open and is reported', async () => {
    // Mirrors the resident poller. A sentinel this runner cannot evaluate must
    // not be the thing that silently stops a week-long watch job.
    const errors: unknown[] = []
    const dispatcher = spy()
    const scheduler = runner({
      dispatch: dispatcher.dispatch,
      paused: () => {
        throw new Error('sentinel unreadable')
      },
      onError: error => errors.push(error),
    })
    await tick(scheduler, ANCHOR + MINUTE)
    expect(dispatcher.seen).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})

describe('what the host is handed', () => {
  test('carries the job, so contextId and taskTtlMs come from it and not from LIMITS', async () => {
    // §4.1 points 3 and 4. The runner does not build the envelope — the host
    // does — so what matters here is that both facts travel to where the host
    // cannot help but see them.
    const dispatcher = spy()
    await tick(runner({ dispatch: dispatcher.dispatch }), ANCHOR + MINUTE)
    const fired = dispatcher.seen[0]
    expect(fired?.job.id).toBe('watch-ci')
    expect(fired?.job.taskTtlMs).toBe(900_000)
    expect(fired?.job.taskTtlMs).not.toBe(LIMITS.defaultTaskTtlMs)
    expect(fired?.job.target).toBe('qianmo://beta-1/planner')
  })

  test('status reports the tick, the next instant and the failure state', async () => {
    // §4.1 point 6: the hub is a single point for timing (the A7 divergence),
    // so its absence has to be visible rather than inferred from silence.
    const dispatcher = spy()
    const scheduler = runner({ dispatch: dispatcher.dispatch })
    expect(scheduler.status().lastTickAt).toBeUndefined()

    await tick(scheduler, ANCHOR + MINUTE)
    const status = scheduler.status()
    expect(status.lastTickAt).toBe(ANCHOR + MINUTE)
    expect(status.jobs).toEqual([
      {
        jobId: 'watch-ci',
        nextFireAt: ANCHOR + 2 * MINUTE,
        consecutiveFailures: 0,
        lastOutcome: 'completed',
        lastFiredAt: ANCHOR + MINUTE,
      },
    ])
  })

  test('an unregistered job stops being scheduled but keeps its memory', async () => {
    const dispatcher = spy()
    const store = makeStore()
    const scheduler = runner({ store, dispatch: dispatcher.dispatch })
    await tick(scheduler, ANCHOR + MINUTE)
    scheduler.unregister('watch-ci')
    await tick(scheduler, ANCHOR + 2 * MINUTE)
    expect(dispatcher.seen).toHaveLength(1)
    expect(scheduler.status().jobs).toEqual([])

    // Re-adding inside the same period must not re-run the slot already run.
    scheduler.register(JOB)
    await tick(scheduler, ANCHOR + MINUTE + 1)
    expect(dispatcher.seen).toHaveLength(1)
    expect(store.stateOf('watch-ci').lastFiredAt).toBe(ANCHOR + MINUTE)
  })

  test('registering an invalid job throws instead of scheduling it', () => {
    const scheduler = runner({ dispatch: spy().dispatch })
    expect(() => scheduler.register({ ...JOB, target: 'http://x/y' })).toThrow()
    expect(scheduler.jobs).toHaveLength(1)
  })
})
