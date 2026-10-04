// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the transport records about itself.
 *
 * A refused handshake has to leave a trace — that is half of P2.2's third
 * acceptance criterion, and an operator with no record of rejected dials
 * cannot tell a misconfigured peer from an attack. The records live in this
 * package instead of the base's telemetry for two reasons: the base's logging
 * is wired to session analytics (a cross-node dial is not a session event),
 * and a leaf package with no `src/` imports cannot pull the CLI's module graph
 * into a headless node.
 *
 * Nothing here may carry a secret or payload content: records are meant to be
 * printable.
 */

export enum TransportEventType {
  /** A socket was accepted, before any handshake. */
  ConnectionOpened = 'connection_opened',
  /** A socket went away, for any reason. */
  ConnectionClosed = 'connection_closed',
  /** Handshake passed. */
  AuthAccepted = 'auth_accepted',
  /** Handshake refused — wrong key, replayed nonce, malformed frame. */
  AuthRejected = 'auth_rejected',
  /** An envelope was taken in for the first time. */
  MessageAccepted = 'message_accepted',
  /** An envelope was recognised as a duplicate and not handled again. */
  MessageDuplicate = 'message_duplicate',
  /** An envelope was refused (validation, or the handler threw). */
  MessageRejected = 'message_rejected',
  /** A retry was scheduled. */
  ReconnectScheduled = 'reconnect_scheduled',
  /** The retry budget ran out. */
  ReconnectGaveUp = 'reconnect_gave_up',
  /** A gap in the wall clock was read as a freeze; the budget was reset. */
  TimeJumpDetected = 'time_jump_detected',
  /**
   * A disconnected logical channel was reclaimed with envelopes still
   * unreceipted, because nobody came back for them inside the retention window.
   */
  ChannelReclaimed = 'channel_reclaimed',
  /**
   * A dialer abandoned its channel id because the listener holds a channel of
   * that id under a different identity, and dialled again under a fresh one.
   *
   * This is a **loss** record, not a progress one: whatever the listener had
   * queued on the old channel for the old identity stays there until its
   * retention clock runs out, and is never delivered to this client. The
   * dialer's own unreceipted envelopes are not lost — they replay on the new
   * channel — but a reply that was already in flight the other way is. A
   * rotation that left no trace would make that loss unattributable.
   */
  ChannelRotated = 'channel_rotated',
  /**
   * A caller-supplied event sink threw and was contained.
   *
   * Recorded rather than rethrown: `record` runs inside the websocket
   * `open`/`close` handlers, so letting it escape would kill the server over a
   * fault in observability code.
   */
  SinkFailed = 'sink_failed',
}

/** Values a record may carry. Deliberately narrow — no objects, no payloads. */
export type EventDetail = Record<string, string | number | boolean>

export interface TransportEvent {
  readonly type: TransportEventType
  /** Epoch ms, from the owner's injected clock. */
  readonly at: number
  readonly detail: EventDetail
}

/** Where records go. */
export type TransportEventSink = (event: TransportEvent) => void

/** Default retained records, per server or client. */
export const DEFAULT_EVENT_CAPACITY = 256

/**
 * A bounded in-memory record of what happened.
 *
 * Bounded because a node under a dial flood must not answer it by exhausting
 * its own heap; the oldest records are the ones an operator needs least.
 */
export class EventRecorder {
  private readonly events: TransportEvent[] = []

  constructor(
    private readonly capacity: number = DEFAULT_EVENT_CAPACITY,
    private readonly sink?: TransportEventSink,
  ) {}

  record(event: TransportEvent): void {
    this.events.push(event)
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity)
    }
    // The sink is caller-supplied, and `record` runs inside Bun's websocket
    // `open`/`close` handlers — so a sink that throws does not merely lose one
    // record, it propagates out of the handler and takes the server down. Found
    // that way: a cross-machine probe passed `{record: fn}` where a function
    // was expected, and the first connection killed the listener. Observability
    // must never be able to do that, so the throw is contained and reported on
    // the same channel everything else uses.
    try {
      this.sink?.(event)
    } catch (error) {
      this.events.push({
        type: TransportEventType.SinkFailed,
        at: event.at,
        detail: {
          reason: error instanceof Error ? error.name : 'unknown',
          of: event.type,
        },
      })
    }
  }

  /** Every retained record, oldest first. */
  all(): readonly TransportEvent[] {
    return [...this.events]
  }

  /** Retained records of one kind, oldest first. */
  byType(type: TransportEventType): readonly TransportEvent[] {
    return this.events.filter(event => event.type === type)
  }

  clear(): void {
    this.events.length = 0
  }
}
