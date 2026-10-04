// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the store records about its own scans.
 *
 * WHY THIS EXISTS — a scan and a lookup want opposite failure behaviour.
 *
 * The first cut of this package let every read throw. A file that had been
 * hand-edited under the memory root therefore took down `query()` entirely,
 * and with it every *healthy* record beside it. Measured, not predicted: three
 * good entries, one file replaced with `this is not valid frontmatter at all`,
 * and the recall for all three was gone. On the P3.3 wake path that is a
 * resident node coming back with no memory at all — a single bad byte
 * escalating into subsystem-wide failure, which is precisely the blast radius
 * AC-6 exists to bound.
 *
 * Swinging to the other extreme — swallow the failure, skip the file — is the
 * wrong repair for an audit store: the one event an audit exists to catch is
 * the record that quietly stopped being there. So neither. A scan returns
 * every record it *can* read and reports every record it *cannot*, on this
 * channel. A lookup by id keeps throwing, because the caller named that one
 * record and a `null` would read as "no such memory" — which would turn AC-4's
 * citation check into a false negative.
 *
 * The recorder is always present, with or without a caller-supplied sink.
 * A channel nobody is required to subscribe to is still a channel; a failure
 * with nowhere to be written down is silence.
 *
 * Nothing here may carry a secret. Detail values are meant to be printable.
 */

export enum MemoryEventType {
  /**
   * A file under a layer directory could not be read or parsed during a scan.
   * Carries the path and the failure, because "something is corrupt" that does
   * not say *what* is not actionable.
   */
  EntryUnreadable = 'entry_unreadable',
  /**
   * A layer directory could not be listed for a reason other than "it does not
   * exist yet". A missing directory is an empty table; an unreadable one is a
   * table that silently looks empty, which is far worse.
   */
  LayerUnreadable = 'layer_unreadable',
  /**
   * A caller-supplied sink threw and was contained.
   *
   * Recorded rather than rethrown: the sink runs inside `query()`, so letting
   * it escape would put recall back where this whole channel exists to move it
   * away from — a fault in observability code breaking memory retrieval.
   * `@qianmo/transport` learned this the expensive way (a probe passed the
   * wrong shape and the first connection killed the listener); the lesson
   * transfers unchanged.
   */
  SinkFailed = 'sink_failed',
}

/** Values a record may carry. Deliberately narrow — no objects, no entries. */
export type MemoryEventDetail = Record<string, string | number | boolean>

export interface MemoryEvent {
  readonly type: MemoryEventType
  /** Epoch ms, from the store's injected clock. */
  readonly at: number
  readonly detail: MemoryEventDetail
}

/** Where records go, in addition to the recorder. */
export type MemoryEventSink = (event: MemoryEvent) => void

/** Default retained records per store. */
export const DEFAULT_EVENT_CAPACITY = 256

/**
 * A bounded in-memory record of what a scan could not read.
 *
 * Bounded because a store whose root has been filled with junk must not answer
 * that by exhausting its own heap; the oldest records are the ones an operator
 * needs least.
 */
export class MemoryEventRecorder {
  readonly #events: MemoryEvent[] = []
  readonly #capacity: number
  readonly #sink: MemoryEventSink | undefined

  constructor(
    capacity: number = DEFAULT_EVENT_CAPACITY,
    sink?: MemoryEventSink,
  ) {
    this.#capacity = capacity
    this.#sink = sink
  }

  record(event: MemoryEvent): void {
    this.#push(event)
    try {
      this.#sink?.(event)
    } catch (error) {
      // Pushed directly rather than through `record`, or a sink that throws on
      // every event would recurse until the stack gives out.
      this.#push({
        type: MemoryEventType.SinkFailed,
        at: event.at,
        detail: {
          reason: error instanceof Error ? error.name : 'unknown',
          of: event.type,
        },
      })
    }
  }

  /** Every retained record, oldest first. */
  all(): readonly MemoryEvent[] {
    return [...this.#events]
  }

  /** Retained records of one kind, oldest first. */
  byType(type: MemoryEventType): readonly MemoryEvent[] {
    return this.#events.filter(event => event.type === type)
  }

  clear(): void {
    this.#events.length = 0
  }

  #push(event: MemoryEvent): void {
    this.#events.push(event)
    if (this.#events.length > this.#capacity) {
      this.#events.splice(0, this.#events.length - this.#capacity)
    }
  }
}

/** Longest error text carried on an event, so one bad file cannot flood a log. */
const MAX_REASON_LENGTH = 200

/** Renders a thrown value into the printable pair an operator can act on. */
export function describeFailure(error: unknown): MemoryEventDetail {
  if (error instanceof Error) {
    return {
      reason: error.name,
      message: error.message.slice(0, MAX_REASON_LENGTH),
    }
  }
  return {
    reason: 'unknown',
    message: String(error).slice(0, MAX_REASON_LENGTH),
  }
}
