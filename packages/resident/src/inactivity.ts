// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How long a turn may produce **nothing at all** before it is failed early.
 *
 * Two minutes, chosen against `LIMITS.defaultTaskTtlMs` (five minutes): the
 * point of B10 is to fail *earlier* than the wall clock, and a watchdog set at
 * or above the default task deadline would never be the one to fire.
 *
 * Silence here means silence: every `session/update` counts, including
 * `agent_thought_chunk`, so a model that spends two minutes thinking out loud
 * keeps resetting it. What trips it is an ACP side that has stopped speaking.
 */
export const DEFAULT_RESIDENT_INACTIVITY_MS = 120_000

/**
 * One HTTP status the agent's model endpoint answered with, and when.
 *
 * Reported by the ACP child over `qianmo/upstream-status`, because the status
 * is knowledge only that process has: the resident never speaks to a model
 * endpoint on a turn's behalf, it speaks to an agent that does.
 */
export interface ResidentUpstreamStatus {
  readonly status: number
  /** Epoch milliseconds, on the recording node's clock. */
  readonly at: number
  readonly detail?: string
}

/**
 * Whether an HTTP status means "your credential is the problem".
 *
 * Deliberately three codes and no heuristics. 401 and 403 are the endpoint
 * refusing the credential it was given; 407 is a proxy refusing the one it was
 * not. A 429 is also a 4xx and is emphatically *not* this — telling an
 * operator to check their API key when they are being rate limited sends them
 * to rotate a key that was never broken.
 */
export function isCredentialHttpStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 407
}

/**
 * The last thing this node's model endpoint said, for as long as it is still
 * relevant.
 *
 * Exists because {@link ResidentInactivityError} was pointing in the wrong
 * direction. "produced no activity for 120000ms" describes a model that is
 * slow; the beta fleet's actual fault was an expired API key answering HTTP
 * 401 in 44 milliseconds, and every reader who saw that error went looking at
 * context sizes and gateway latency instead (issue #37). A watchdog that can
 * say "and the last thing upstream said during that silence was 401" turns a
 * two-hour hunt into a one-line answer.
 *
 * Records **failures only**, on purpose: a success notification per API call
 * would put a message on the ACP wire for every request a healthy node makes,
 * to answer a question nothing asks on a healthy node. The staleness rule in
 * {@link recent} does the same job for free — a status that predates the
 * silence being measured is not evidence about it.
 */
export class ResidentUpstreamHealth {
  readonly #now: () => number
  #last: ResidentUpstreamStatus | undefined

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  /**
   * Note one upstream HTTP status.
   *
   * Statuses outside the HTTP range are dropped rather than stored: this is
   * fed from a wire message, and a malformed one must not be able to make the
   * node say something false about its own credentials.
   */
  record(status: number, detail?: string): void {
    if (!Number.isInteger(status) || status < 100 || status > 599) return
    this.#last = {
      status,
      at: this.#now(),
      ...(detail === undefined ? {} : { detail }),
    }
  }

  /** The last status seen, however old. Observation only. */
  get last(): ResidentUpstreamStatus | undefined {
    return this.#last
  }

  /**
   * The last status seen within `windowMs`, or `undefined`.
   *
   * The caller passes the silence it just measured, so what comes back is
   * "what upstream said *while nothing was happening*" rather than "what
   * upstream ever said". A 401 from an hour ago, already fixed, must not be
   * offered as the explanation for a turn that went quiet just now.
   */
  recent(windowMs: number): ResidentUpstreamStatus | undefined {
    const last = this.#last
    if (last === undefined) return undefined
    return this.#now() - last.at <= windowMs ? last : undefined
  }
}

function inactivityReason(
  messageId: string,
  idleMs: number,
  upstream: ResidentUpstreamStatus | undefined,
): string {
  const silence = `resident ACP turn ${messageId} produced no activity for ${idleMs}ms`
  if (upstream === undefined) {
    return `${silence} and was failed for inactivity; the task deadline itself has not expired, so retrying with a longer taskTtlMs is the sender's call`
  }
  const detail = upstream.detail === undefined ? '' : `: ${upstream.detail}`
  if (isCredentialHttpStatus(upstream.status)) {
    // The one case where "retry with a longer taskTtlMs" is actively bad
    // advice, so it is not offered: no deadline is long enough to outlast a
    // rejected credential, and every retry burns another silent budget.
    return `${silence}, and the last upstream response during that silence was HTTP ${upstream.status}${detail} — that is this node's model credential being refused, not a slow model. Fix the credential this process was started with (a longer taskTtlMs will not help)`
  }
  return `${silence} and was failed for inactivity; the last upstream response during that silence was HTTP ${upstream.status}${detail}. The task deadline itself has not expired, so retrying with a longer taskTtlMs is the sender's call`
}

/**
 * A turn was failed because its ACP side went silent, not because it failed.
 *
 * The distinction is the whole deliverable: `reason` has to say "inactivity"
 * so the sender can tell this apart from a refusal or a crash and act on it —
 * the correct action being a retry with a longer `taskTtlMs`, which is a thing
 * only the sender may decide (design §3.B10: the wall clock belongs to the
 * sender and a node has no business quietly extending it).
 *
 * Unless the silence has a known cause, which is the second half of issue #37:
 * when {@link ResidentUpstreamHealth} saw the model endpoint refuse this
 * node's credential during the very silence being reported, the message says
 * so and stops recommending a retry that cannot work.
 */
export class ResidentInactivityError extends Error {
  readonly sessionId: string
  readonly messageId: string
  readonly idleMs: number
  /** The upstream status blamed for the silence, when there was one. */
  readonly upstream: ResidentUpstreamStatus | undefined

  constructor(
    sessionId: string,
    messageId: string,
    idleMs: number,
    upstream?: ResidentUpstreamStatus,
  ) {
    super(inactivityReason(messageId, idleMs, upstream))
    this.name = 'ResidentInactivityError'
    this.sessionId = sessionId
    this.messageId = messageId
    this.idleMs = idleMs
    this.upstream = upstream
  }

  /** Whether this silence was a refused credential rather than a slow model. */
  get isCredentialFailure(): boolean {
    return (
      this.upstream !== undefined &&
      isCredentialHttpStatus(this.upstream.status)
    )
  }
}

export interface ResidentInactivityTurn {
  readonly sessionId: string
  readonly messageId: string
}

export interface ResidentInactivityOptions {
  /** `0` or negative disables the watchdog entirely. */
  readonly timeoutMs?: number
  readonly schedule?: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
  /**
   * Called once, on expiry, before the guarded promise rejects.
   *
   * This is where a caller asks the ACP side to stop — see the class comment
   * for why the watchdog itself does not know how.
   */
  readonly onExpired?: (turn: ResidentInactivityTurn) => void
  /**
   * Where the watchdog asks what upstream said while nothing was happening.
   *
   * Optional, and absent it behaves exactly as it did before issue #37: the
   * failure says "no activity" and nothing more. Present, it is consulted
   * **synchronously at expiry** — the watchdog does not probe, does not wait
   * and does not extend the turn by so much as a tick to find out. Everything
   * it can say has already been reported to it.
   */
  readonly upstreamHealth?: ResidentUpstreamHealth
}

function defaultSchedule(
  delayMs: number,
  callback: () => void,
): { cancel(): void } {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

interface ArmedTurn {
  readonly turn: ResidentInactivityTurn
  timer: { cancel(): void } | null
  settled: boolean
  fire: () => void
}

/**
 * Inactivity-based early failure for a running turn (design §3.B10, hermes B10).
 *
 * hermes uses an inactivity timeout to *replace* a wall clock, so long jobs are
 * not killed. Atlas runs it in the opposite direction: the wall clock is
 * `taskTtlMs`, it belongs to the sender, and the node may not extend it — so
 * this watchdog only ever makes a turn fail **sooner**, and it exists to turn a
 * five-minute silence into a diagnosable answer instead of a bare timeout.
 *
 * ## What this mechanism deliberately does not do
 *
 * - **It does not extend anything.** There is no path here that makes a turn
 *   live longer than `taskTtlMs`. A node that quietly renewed a deadline the
 *   sender set would make every sender's timeout estimate a fiction.
 * - **It does not know what ACP is.** Expiry calls {@link
 *   ResidentInactivityOptions.onExpired} and rejects; asking the agent to stop
 *   is the caller's job, because "how to cancel" is a property of the transport
 *   this package is deliberately not coupled to.
 * - **It cannot un-run work already dispatched.** Rejecting the guarded promise
 *   frees the node's turn gate; the ACP side keeps going until it honours the
 *   cancel. That residual window is the same one every mid-flight turn failure
 *   already has (an ACP protocol error rejects the prompt while the agent keeps
 *   working), so it introduces no new shape — but it is real, and the cancel is
 *   sent precisely to keep it short.
 * - **It writes nothing to disk**, so it is the one member of the reliability
 *   kit with no fail-open story to tell: there is nothing that can fail.
 */
export class ResidentInactivityWatchdog {
  readonly #timeoutMs: number
  readonly #schedule: (
    delayMs: number,
    callback: () => void,
  ) => { cancel(): void }
  readonly #onExpired: ((turn: ResidentInactivityTurn) => void) | undefined
  readonly #upstreamHealth: ResidentUpstreamHealth | undefined
  readonly #armed = new Map<string, ArmedTurn>()

  constructor(options: ResidentInactivityOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_RESIDENT_INACTIVITY_MS
    this.#schedule = options.schedule ?? defaultSchedule
    this.#onExpired = options.onExpired
    this.#upstreamHealth = options.upstreamHealth
  }

  get timeoutMs(): number {
    return this.#timeoutMs
  }

  /** Turns currently being watched. Observation only. */
  get watching(): number {
    return this.#armed.size
  }

  /**
   * Run `work` under the watchdog.
   *
   * Rejects with {@link ResidentInactivityError} if nothing calls
   * {@link touch} for this session within the timeout. Otherwise it is exactly
   * `work()`, including its rejection.
   */
  async guard<T>(
    turn: ResidentInactivityTurn,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.#timeoutMs <= 0) return await work()

    let rejectIdle!: (error: unknown) => void
    const idle = new Promise<never>((_resolve, reject) => {
      rejectIdle = reject
    })
    // Attached up front: once the race settles on `work`, nothing else is
    // listening to this promise, and an unhandled rejection from a watchdog
    // would take the process down over an event that did not matter.
    idle.catch(() => {})

    const armed: ArmedTurn = {
      turn,
      timer: null,
      settled: false,
      fire: () => {
        if (armed.settled) return
        armed.settled = true
        try {
          this.#onExpired?.(turn)
        } catch {
          // Cancelling is best effort; the failure below is the deliverable.
        }
        // The window is the budget: a status older than the silence being
        // reported says nothing about it (see ResidentUpstreamHealth.recent).
        const upstream = this.#upstreamHealth?.recent(this.#timeoutMs)
        rejectIdle(
          new ResidentInactivityError(
            turn.sessionId,
            turn.messageId,
            this.#timeoutMs,
            upstream,
          ),
        )
      },
    }
    const previous = this.#armed.get(turn.sessionId)
    this.#armed.set(turn.sessionId, armed)
    this.#rearm(armed)

    try {
      return await Promise.race([work(), idle])
    } finally {
      armed.settled = true
      armed.timer?.cancel()
      armed.timer = null
      if (this.#armed.get(turn.sessionId) === armed) {
        // Restoring rather than deleting: `guard` is not nested today (the node
        // turn gate serializes), and if that ever changes, dropping the outer
        // watch silently would be the worst possible way to find out.
        if (previous === undefined) this.#armed.delete(turn.sessionId)
        else this.#armed.set(turn.sessionId, previous)
      }
    }
  }

  /** Report activity on a session, restarting its countdown. */
  touch(sessionId: string): void {
    const armed = this.#armed.get(sessionId)
    if (armed === undefined || armed.settled) return
    this.#rearm(armed)
  }

  #rearm(armed: ArmedTurn): void {
    armed.timer?.cancel()
    armed.timer = this.#schedule(this.#timeoutMs, armed.fire)
  }
}
