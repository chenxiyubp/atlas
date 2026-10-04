// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stage instrumentation for the forwarding path.
 *
 * P2.5's deliverable list asks for per-stage timings on the wake path — caught
 * → wake issued → ready → first byte forwarded — and names the consumers:
 * P3.1's dormancy work and P4.1's cross-node benchmark. The stages are cut
 * where they are because E2 showed the cost is wildly uneven across them:
 * `unpause` itself is 46.6–55.5 ms, while bringing a 400 MiB working set back
 * to full speed took another 9.0–10.2 s. A single end-to-end number averages
 * those together and hides the only thing worth knowing, which is *which* of
 * them a given deployment is paying.
 *
 * Percentiles rather than means, and reported out of band. Per D-3 the latency
 * numbers belong in a standalone benchmark job, not in a blocking CI gate —
 * a blocking percentile gate on a shared runner measures the runner.
 */

/** Where a request's clock stopped. */
export type ActivationOutcomeKind = 'forwarded' | 'failed' | 'in-flight'

/** One request's timeline, in epoch milliseconds. */
export interface StageTimings {
  readonly requestId: string
  readonly sandboxName: string
  readonly msgId: string
  readonly taskId: string
  /** The request was caught and journalled. */
  readonly acceptedAt: number
  /** A wake was issued. Absent when the target was already running. */
  readonly wakeStartedAt?: number
  /** The target answered a readiness probe. */
  readonly readyAt?: number
  /** The envelope was handed to the forward target. */
  readonly forwardedAt?: number
  readonly outcome: ActivationOutcomeKind
  readonly reason?: string
}

/** Derived spans. `undefined` where the timeline never reached that stage. */
export interface StageDurations {
  /** Caught → wake issued. Our own overhead; should be small. */
  readonly acceptToWakeMs?: number
  /** Wake issued → target ready. Where E2's working-set warm-up lands. */
  readonly wakeToReadyMs?: number
  /** Ready → first byte forwarded. */
  readonly readyToForwardMs?: number
  /** Caught → first byte forwarded. */
  readonly totalMs?: number
}

/** Spans implied by one timeline. */
export function durationsOf(timings: StageTimings): StageDurations {
  const { acceptedAt, wakeStartedAt, readyAt, forwardedAt } = timings
  // `readyAt` is measured from the wake when there was one, and from acceptance
  // when the target was already running — otherwise an already-running target
  // would report an undefined wake span and a total that skips it.
  const readyFrom = wakeStartedAt ?? acceptedAt
  return {
    ...(wakeStartedAt === undefined
      ? {}
      : { acceptToWakeMs: wakeStartedAt - acceptedAt }),
    ...(readyAt === undefined ? {} : { wakeToReadyMs: readyAt - readyFrom }),
    ...(forwardedAt === undefined || readyAt === undefined
      ? {}
      : { readyToForwardMs: forwardedAt - readyAt }),
    ...(forwardedAt === undefined ? {} : { totalMs: forwardedAt - acceptedAt }),
  }
}

/**
 * A timeline being filled in as a request moves.
 *
 * Marks are idempotent-by-first-write: a retry inside one acceptance must not
 * rewrite the moment the wake was issued, or the wake span shrinks every time
 * a readiness probe is retried.
 */
export class StageTimeline {
  readonly requestId: string
  readonly sandboxName: string
  readonly msgId: string
  readonly taskId: string
  readonly acceptedAt: number
  #wakeStartedAt: number | undefined
  #readyAt: number | undefined
  #forwardedAt: number | undefined
  #outcome: ActivationOutcomeKind = 'in-flight'
  #reason: string | undefined

  constructor(init: {
    requestId: string
    sandboxName: string
    msgId: string
    taskId: string
    acceptedAt: number
  }) {
    this.requestId = init.requestId
    this.sandboxName = init.sandboxName
    this.msgId = init.msgId
    this.taskId = init.taskId
    this.acceptedAt = init.acceptedAt
  }

  markWakeStarted(at: number): void {
    this.#wakeStartedAt ??= at
  }

  markReady(at: number): void {
    this.#readyAt ??= at
  }

  markForwarded(at: number): void {
    this.#forwardedAt ??= at
    this.#outcome = 'forwarded'
  }

  markFailed(reason: string): void {
    this.#outcome = 'failed'
    this.#reason = reason
  }

  snapshot(): StageTimings {
    return {
      requestId: this.requestId,
      sandboxName: this.sandboxName,
      msgId: this.msgId,
      taskId: this.taskId,
      acceptedAt: this.acceptedAt,
      ...(this.#wakeStartedAt === undefined
        ? {}
        : { wakeStartedAt: this.#wakeStartedAt }),
      ...(this.#readyAt === undefined ? {} : { readyAt: this.#readyAt }),
      ...(this.#forwardedAt === undefined
        ? {}
        : { forwardedAt: this.#forwardedAt }),
      outcome: this.#outcome,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
    }
  }
}

/** Distribution of one span across the recorded samples. */
export interface StageStats {
  readonly count: number
  readonly minMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
}

/** What the benchmark job reads. */
export interface TimingReport {
  readonly samples: number
  readonly forwarded: number
  readonly failed: number
  /** How many samples needed a wake; the rest found the target already running. */
  readonly wakes: number
  readonly acceptToWake: StageStats
  readonly wakeToReady: StageStats
  readonly readyToForward: StageStats
  readonly total: StageStats
}

const EMPTY_STATS: StageStats = {
  count: 0,
  minMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  maxMs: 0,
}

/**
 * Nearest-rank percentile on a sorted array.
 *
 * Nearest-rank rather than interpolated: every value it reports is a
 * measurement that actually happened, which is the property you want when a
 * number ends up in an acceptance report.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] ?? 0
}

export function statsOf(values: readonly number[]): StageStats {
  if (values.length === 0) return EMPTY_STATS
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

/** How many finished timelines {@link TimingRecorder} keeps. */
export const DEFAULT_TIMING_CAPACITY = 256

/** Ring of finished timelines, plus the report derived from them. */
export class TimingRecorder {
  readonly #samples: StageTimings[] = []
  readonly #capacity: number

  constructor(capacity: number = DEFAULT_TIMING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `timing capacity must be a positive integer, got ${capacity}`,
      )
    }
    this.#capacity = capacity
  }

  record(timings: StageTimings): void {
    this.#samples.push(timings)
    if (this.#samples.length > this.#capacity) this.#samples.shift()
  }

  samples(): readonly StageTimings[] {
    return [...this.#samples]
  }

  report(): TimingReport {
    const durations = this.#samples.map(durationsOf)
    const pick = (key: keyof StageDurations): number[] =>
      durations
        .map(duration => duration[key])
        .filter((value): value is number => value !== undefined)
    return {
      samples: this.#samples.length,
      forwarded: this.#samples.filter(sample => sample.outcome === 'forwarded')
        .length,
      failed: this.#samples.filter(sample => sample.outcome === 'failed')
        .length,
      wakes: this.#samples.filter(sample => sample.wakeStartedAt !== undefined)
        .length,
      acceptToWake: statsOf(pick('acceptToWakeMs')),
      wakeToReady: statsOf(pick('wakeToReadyMs')),
      readyToForward: statsOf(pick('readyToForwardMs')),
      total: statsOf(pick('totalMs')),
    }
  }
}
