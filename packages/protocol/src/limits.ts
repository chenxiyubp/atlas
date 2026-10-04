// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Hard boundaries of the v0 protocol. Shared by every node on the network. */
export const LIMITS = {
  /** Maximum size of one serialized envelope, in bytes (256 KiB). */
  maxMessageBytes: 256 * 1024,
  /** Maximum number of nodes a message may traverse. */
  maxHops: 8,
  /**
   * Default DELIVERY deadline when the sender does not set one (30s).
   *
   * Bounds `created → acked` only. It is not the task deadline: one field used
   * to carry both meanings, which is why a 30s default appeared to contradict
   * AC-2's 60s ack line. `defaultTaskTtlMs` below carries the other half.
   */
  defaultTtlMs: 30_000,
  /**
   * Default TASK deadline when the sender does not set one (5 min).
   *
   * Bounds `created → completed / failed`. Set to exactly AC-2's result line:
   * a task that outruns this has already failed acceptance, so the protocol
   * must not still count it alive. Wake-time is excluded by the time-jump
   * gate, so a frozen node does not burn its task budget while paused.
   */
  defaultTaskTtlMs: 300_000,
  /** Per-sender inbound budget enforced by a receiving node. */
  ratePerMinute: 600,
  /**
   * Default DELIVERY deadline for `notify` (2 min), protocol.md §14.
   *
   * Wider than `defaultTtlMs` because the peer on the other end is a hub that
   * may be restarting, not an agent that is already running. Narrower than
   * `defaultTaskTtlMs` because a notification that has not landed within two
   * minutes reaches its reader as history rather than as an alert. Re-delivery
   * is the sender ledger's job, so this window does not have to be generous.
   */
  defaultNotifyTtlMs: 120_000,
  /**
   * Per-node **outbound** `notify` ceiling, over a sliding minute.
   *
   * An order of magnitude under `ratePerMinute` on purpose: the inbound budget
   * defends this node against a peer, while this one defends a *person* against
   * this node — an unattended watch job that starts producing more than one
   * notification a second has found a bug, not a story.
   *
   * Enforced as a sliding window rather than a token bucket. A bucket is a
   * burst allowance and admits up to twice this number inside one minute
   * (a full bucket plus a minute of refill); a window is a promise to the
   * human that no minute ever carries more than this.
   */
  notifyRatePerMinute: 60,
  /**
   * Upper bound of a node's turn queue; a fuller queue refuses rather than
   * queues (`E_BUSY`).
   *
   * Node-level serial execution (charter H-9 stands) at minutes per turn puts a
   * 32-deep queue half an hour out — already past any sender's `taskTtlMs`.
   * A larger bound would only hold messages that are certain to time out.
   */
  maxQueuedTurns: 32,
} as const

export type Limits = typeof LIMITS
