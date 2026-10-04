// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ProtocolErrorCode, TimeJumpGate } from '@qianmo/protocol'
import type { TeammateMessage } from 'src/utils/agents/teammateMailbox.js'
import { readMailbox } from 'src/utils/agents/teammateMailbox.js'

/**
 * The `read`-flip observer (protocol.md §4.5).
 *
 * ## Why an ack may not be sent when the file write returns
 *
 * The base enforces its mailbox quota **by dropping messages, unread ones
 * included**. Every write compacts first
 * (`src/utils/agents/teammateMailbox.ts:271-279`), keeping in three tiers —
 * unread protocol, unread ordinary, read — and simply stops keeping once
 * `MAX_MAILBOX_RETAINED_BYTES` is reached (`:198-248`). Everything squeezed
 * out leaves a single `logError` behind (`:250-269`); the sender is told
 * nothing.
 *
 * An ack emitted at write time would therefore report an evicted message as
 * delivered, and the failure would surface to the sender as "the ack arrived,
 * the result never did" — precisely the shape that costs AC-2 its 10/10.
 *
 * ## What the flip means
 *
 * `read` flipping to `true` is, in both of the base's delivery shapes, exactly
 * "the message has entered the target agent's input":
 *
 * - in-process teammate: `markMessageAsReadByIdentity`
 *   (`src/utils/swarm/inProcessRunner.ts:854-858`), immediately before
 *   `msg.text` is handed back to the agent loop as the next prompt (`:859-865`);
 * - attachment delivery: `markMessagesAsReadBySnapshot`
 *   (`src/utils/attachments/team.ts:192-197`), deliberately placed *after* the
 *   attachment is built so no step can lose the message (`:181-188`).
 *
 * That is the A-class assertion, no more and no less.
 *
 * ## Mechanism
 *
 * Polling, not `fs.watch`: every mailbox write is a temp-file + `rename`
 * (`teammateMailbox.ts:166-169`) so a watcher *would* see each change, but
 * `fs.watch` behaviour under gVisor and across freeze/thaw is unverified
 * (protocol.md §12.3.2). The protocol therefore fixes the semantics and
 * leaves the mechanism open, with one constraint: the observation period must
 * not exceed the base's own polling period for the shape in use, or it merely
 * adds a base period of latency.
 */

/** In-process teammate poll period (`inProcessRunner.ts:711`). */
export const BASE_INPROCESS_POLL_INTERVAL_MS = 500

/** Pane (tmux / terminal) inbox poll period (`src/hooks/useInboxPoller.ts:261`). */
export const BASE_PANE_POLL_INTERVAL_MS = 1_000

/**
 * Default observation period.
 *
 * Half of the tighter of the two base periods, so the observer never becomes
 * the dominant term in the ack budget (§4.4, row 5).
 */
export const DEFAULT_POLL_INTERVAL_MS = 250

/**
 * The base's identity for a mailbox entry: `[from, timestamp, text]`
 * (`teammateMailbox.ts:84-86`).
 *
 * The adapter keeps the triple it wrote, and that is how it finds its own
 * entry again — the base exposes no message ids.
 */
export interface MailboxEntryIdentity {
  readonly from: string
  readonly timestamp: string
  readonly text: string
}

/** Where a given entry currently stands in the mailbox. */
export type MailboxEntryState = 'read' | 'unread' | 'absent'

/**
 * The three observation results, and there is no fourth (§4.5).
 *
 * Each maps to exactly one terminal state of the message lifecycle (§8.2
 * rows 16 / 17 / 18). `dropped` is the one that write-time acking cannot
 * express at all: it looks identical to `acked` from the writer's side.
 */
export type DeliveryOutcome =
  /** Row 16: the entry is present and `read` — the agent took it in. */
  | { readonly state: 'acked'; readonly ackAt: number }
  /** Row 17: the entry vanished — compaction evicted it. */
  | {
      readonly state: 'dropped'
      readonly code: ProtocolErrorCode.E_EVICTED
      readonly reason: string
    }
  /** Row 18: the DELIVERY deadline passed with the entry still unread. */
  | {
      readonly state: 'expired'
      readonly code: ProtocolErrorCode.E_TTL_EXPIRED
      readonly reason: string
    }

function sameEntry(
  message: TeammateMessage,
  identity: MailboxEntryIdentity,
): boolean {
  return (
    message.from === identity.from &&
    message.timestamp === identity.timestamp &&
    message.text === identity.text
  )
}

/**
 * Locate one entry in a mailbox snapshot. Pure — the whole decision the
 * polling loop makes per tick, isolated so it can be tested without a clock.
 *
 * An entry appearing more than once (the base permits byte-identical
 * duplicates) counts as read as soon as *any* copy is read: the agent has the
 * text either way, which is all an A-class ack claims.
 */
export function classifyMailboxEntry(
  messages: readonly TeammateMessage[],
  identity: MailboxEntryIdentity,
): MailboxEntryState {
  let seen = false
  for (const message of messages) {
    if (!sameEntry(message, identity)) continue
    if (message.read) return 'read'
    seen = true
  }
  return seen ? 'unread' : 'absent'
}

/** Knobs for {@link observeReadFlip}. */
export interface ObserveOptions {
  /** Recipient agent name — the `agent` segment of the envelope's `to`. */
  readonly agent: string
  /** Normalized team name (rule A-2). */
  readonly team: string
  /** The `[from, timestamp, text]` triple the adapter wrote. */
  readonly identity: MailboxEntryIdentity
  /** Epoch ms of the DELIVERY deadline, `deliveryExpiresAt(message)`. */
  readonly deadlineAt: number
  /** Observation period; must not exceed {@link BASE_INPROCESS_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number
  /** Injected clock. */
  readonly now?: () => number
  /** Injected delay, so tests drive the loop without real time. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Aborts the observation; resolves as `expired` when it fires. */
  readonly signal?: AbortSignal
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * Watch one mailbox entry until it reaches a terminal state.
 *
 * ## The time-jump gate (rule T-2, §5.3)
 *
 * E4 measured `CLOCK_MONOTONIC` advancing normally while a sandbox is frozen,
 * and `setInterval` not making up missed ticks — a 34.7 s gap produced one
 * tick. Without a gate, a node that just thawed would find every in-flight
 * deadline crossed at the same instant and declare all of them expired.
 *
 * So: a tick separated from its predecessor by more than `2 × period` is taken
 * as evidence that this node was frozen, and the whole observed gap is added
 * back to the deadline instead of being charged to the delivery budget. That
 * is also why `LIMITS.defaultTtlMs` does not need to grow to cover working-set
 * warm-up: warm-up happens on the target's side of the gate.
 *
 * Note that this function does not catch read failures. A mailbox holding an
 * oversized entry throws on *every* read (`teammateMailbox.ts:96-136`,
 * `:326-335`), and the rejection propagates rather than being folded into a
 * terminal state — the caller has to see a poisoned mailbox, not mistake it
 * for an eviction. The blob staging area exists so this node never creates
 * that condition itself.
 */
export async function observeReadFlip(
  options: ObserveOptions,
): Promise<DeliveryOutcome> {
  const period = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  if (period > BASE_INPROCESS_POLL_INTERVAL_MS) {
    throw new RangeError(
      `observation period ${period}ms exceeds the base in-process poll period ` +
        `${BASE_INPROCESS_POLL_INTERVAL_MS}ms; it would add a base period of latency`,
    )
  }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep

  let deadline = options.deadlineAt
  // The floor stays at its default on purpose. At a 250 ms period, dropping it
  // would put the freeze threshold at 500 ms, so one slow `readMailbox` or GC
  // pause would count as a thaw — and a thaw does not merely rebase the
  // deadline, it opens a 15 s window in which nothing can expire at all.
  // Freezes worth detecting were 34 s and 97 s (E4); none of them need a
  // threshold below the 2 s default.
  const gate = new TimeJumpGate({ periodMs: period })
  gate.observe(now())

  for (;;) {
    const tickAt = now()
    const observation = gate.observe(tickAt)
    deadline = gate.rebase(deadline, observation)

    const messages = await readMailbox(options.agent, options.team)
    switch (classifyMailboxEntry(messages, options.identity)) {
      case 'read':
        return { state: 'acked', ackAt: tickAt }
      case 'absent':
        return {
          state: 'dropped',
          code: ProtocolErrorCode.E_EVICTED,
          reason:
            'mailbox entry vanished before it was read; the base compacted it away',
        }
      case 'unread':
        break
    }

    if (options.signal?.aborted === true) {
      return {
        state: 'expired',
        code: ProtocolErrorCode.E_TTL_EXPIRED,
        reason: 'observation aborted before the read flag flipped',
      }
    }
    if (gate.expired(deadline, tickAt)) {
      return {
        state: 'expired',
        code: ProtocolErrorCode.E_TTL_EXPIRED,
        reason: 'delivery deadline passed with the message still unread',
      }
    }
    await sleep(period)
  }
}
