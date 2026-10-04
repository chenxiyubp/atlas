// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test-only doubles for the things this package injects.
 *
 * Two of them replace a *clock* and a *timer*, not a collaborator: that is what
 * makes a 97-second freeze or a two-hour heartbeat run in microseconds without
 * anybody sleeping. The rest are the ports at this package's own boundary
 * (forward target, failure sink, readiness probe), implemented in the simplest
 * honest way so that what a test observes is our logic and nothing else.
 *
 * Nothing here is a `mock.module`. The package under test takes every
 * collaborator as a constructor argument, so there is nothing to intercept.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  type ProtocolErrorCode,
  type QianmoMessage,
  createMessage,
} from '@qianmo/protocol'
import type { Clock, Scheduler } from '../src/clock.js'
import type {
  FailureSink,
  ForwardTarget,
  ReadyProbe,
} from '../src/activator.js'

export const SENDER = 'qianmo://node-a/planner'
export const RECIPIENT = 'qianmo://node-b/reviewer'
export const SANDBOX = 'sandbox-node-b'

/** Clock a test drives by hand. */
export class ManualClock implements Clock {
  #current: number

  constructor(start = 1_000_000) {
    this.#current = start
  }

  now(): number {
    return this.#current
  }

  advance(ms: number): number {
    this.#current += ms
    return this.#current
  }

  set(instant: number): void {
    this.#current = instant
  }
}

/**
 * A scheduler whose timers only fire when a test says so.
 *
 * Deliberately does not advance any clock by itself: a test that wants time to
 * move says so on the {@link ManualClock}, which keeps "what the code waited
 * for" and "what the clock did" independent — the only way to write a test
 * where the clock jumps *without* the wait having happened, which is exactly
 * the freeze/thaw case (E4).
 */
export class ManualScheduler implements Scheduler {
  #pending: { delayMs: number; callback: () => void }[] = []

  after(delayMs: number, callback: () => void): () => void {
    const entry = { delayMs, callback }
    this.#pending.push(entry)
    return () => {
      this.#pending = this.#pending.filter(item => item !== entry)
    }
  }

  /** Delays of the timers waiting to fire, in registration order. */
  get delays(): readonly number[] {
    return this.#pending.map(entry => entry.delayMs)
  }

  get size(): number {
    return this.#pending.length
  }

  /** Fire the oldest pending timer. Returns false when there was none. */
  fireNext(): boolean {
    const entry = this.#pending.shift()
    if (entry === undefined) return false
    entry.callback()
    return true
  }

  /** Fire everything currently pending (not what those callbacks schedule). */
  fireAll(): number {
    const batch = this.#pending
    this.#pending = []
    for (const entry of batch) entry.callback()
    return batch.length
  }
}

/** Scheduler that runs every timer on the microtask queue, ignoring delays. */
export const immediateScheduler: Scheduler = {
  after(_delayMs, callback) {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) callback()
    })
    return () => {
      cancelled = true
    }
  },
}

/** Collects forwarded envelopes; can be told to fail. */
export class RecordingForwarder implements ForwardTarget {
  readonly forwarded: QianmoMessage[] = []
  failWith: Error | null = null

  async forward(envelope: QianmoMessage): Promise<void> {
    if (this.failWith !== null) throw this.failWith
    this.forwarded.push(envelope)
    await Promise.resolve()
  }
}

/** Collects the explicit failures sent back to senders. */
export class RecordingFailures implements FailureSink {
  readonly replies: QianmoMessage[] = []
  throwOnFail = false

  async fail(reply: QianmoMessage): Promise<void> {
    if (this.throwOnFail) throw new Error('failure sink unavailable')
    this.replies.push(reply)
    await Promise.resolve()
  }

  /** Error codes of the replies, in order. */
  codes(): string[] {
    return this.replies.map(reply => {
      const payload = reply.payload as { code?: ProtocolErrorCode }
      return payload.code ?? ''
    })
  }
}

/** Readiness probe a test drives directly. */
export class ScriptedProbe implements ReadyProbe {
  /** Number of probes still to answer "not ready" before the first `true`. */
  notReadyFor: number
  calls = 0

  constructor(notReadyFor = 0) {
    this.notReadyFor = notReadyFor
  }

  async isReady(_sandboxName: string): Promise<boolean> {
    this.calls += 1
    await Promise.resolve()
    if (this.notReadyFor > 0) {
      this.notReadyFor -= 1
      return false
    }
    return true
  }
}

/**
 * A fixed, obviously-fake pre-shared key, long enough to clear
 * `PSK_MIN_LENGTH` and short of anything anyone could mistake for a real one.
 */
export const TEST_PSK = 'test-psk-not-a-real-secret-0000'

/**
 * A throwaway directory plus socket paths inside it.
 *
 * Unix sockets rather than TCP for the chain tests, by `@qianmo/transport`'s
 * own rule: two servers can bind the same TCP port without either erroring, and
 * Linux then splits arriving connections between them non-deterministically. A
 * path in a private temp directory cannot collide with anything.
 */
export function makeSocketDir(): {
  socket(name: string): string
  cleanup(): void
} {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-activator-'))
  return {
    socket: (name: string) => join(dir, `${name}.sock`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Await `ms` of wall clock. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll `predicate` until it holds or `timeoutMs` runs out. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(stepMs)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

/** One well-formed envelope. */
export function makeMessage(
  overrides: Partial<{
    createdAt: number
    deliverTtlMs: number
    msgId: string
    taskId: string
    taskTtlMs: number
    payload: unknown
  }> = {},
): QianmoMessage {
  return createMessage({
    from: SENDER,
    to: RECIPIENT,
    type: MessageType.TaskRequest,
    payload: overrides.payload ?? { do: 'review' },
    ...(overrides.createdAt === undefined
      ? {}
      : { createdAt: overrides.createdAt }),
    ...(overrides.deliverTtlMs === undefined
      ? {}
      : { deliverTtlMs: overrides.deliverTtlMs }),
    ...(overrides.msgId === undefined ? {} : { msgId: overrides.msgId }),
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    ...(overrides.taskTtlMs === undefined
      ? {}
      : { taskTtlMs: overrides.taskTtlMs }),
  })
}
