// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One line of the network's audit trail.
 *
 * ## Why every layer writes the same record shape
 *
 * The question P7.2 has to answer is "take one cross-node task and show me
 * everything that happened to it — **including the messages that were dropped,
 * rate-limited or deduplicated**". Those three live in three different packages
 * with three different event enums, and a reconstruction that had to join across
 * three shapes would be a reconstruction nobody runs at three in the morning.
 *
 * So the trail is one file of one shape, and each layer's own audit log stays
 * where it is — the ring buffers are for a running process, this is for the
 * question asked later. `source` says which layer wrote the line; `kind` is that
 * layer's own event name, verbatim, so nothing is lost in translation.
 *
 * ## The correlation keys, and the one that actually works
 *
 * `traceId` is the chain key (§7.1): its trace-id segment survives every hop,
 * which is exactly what "reconstruct the chain" needs. `taskId` is the
 * request/reply correlation key (C-1) and `msgId` identifies one transmission.
 * All three are optional because plenty of real events have only one of them —
 * a rate-limited message never got a task, a keepalive tick never had either.
 */

import { createHash } from 'node:crypto'

/** Which layer wrote the line. */
export enum AuditSource {
  Transport = 'transport',
  Router = 'router',
  Capability = 'capability',
  Activator = 'activator',
  Adapter = 'adapter',
  Resident = 'resident',
  Negotiation = 'negotiation',
  Tunnel = 'tunnel',
  Backup = 'backup',
  Diagnosis = 'diagnosis',
  Registry = 'registry',
  Capacity = 'capacity',
  /**
   * The hub's watch-job scheduler (P13.6).
   *
   * A source of its own rather than folded into `Resident`, because the two
   * sit on opposite ends of the same watch job: this one records *deciding* to
   * fire (and refusing to, when a slot was already claimed or ESTOP was
   * pulled), while `Resident` records what the node did about it. Reading a
   * seven-day run means separating "the hub never asked" from "the node never
   * answered", and one shared source name makes that the one distinction the
   * trail cannot express.
   */
  Scheduler = 'scheduler',
}

/** The chain value of the first record: sha-256 of the empty string is not it. */
export const GENESIS_PREVIOUS = '0'.repeat(64)

/** One audit line, as it lands on disk. */
export interface AuditRecord {
  /** Position in this file, from 1. Written by the trail, never by a caller. */
  readonly seq: number
  /** Epoch ms. */
  readonly at: number
  readonly source: AuditSource
  /** The writing layer's own event name, unchanged. */
  readonly kind: string
  /** W3C traceparent, when the event had one. The chain key (§7.1). */
  readonly traceId?: string
  readonly taskId?: string
  readonly msgId?: string
  /** The node that wrote this line. */
  readonly node?: string
  /** The other end, when there was one. */
  readonly peer?: string
  /**
   * Whether the thing being recorded went ahead. Deliberately three-valued:
   * "refused" is the state a reconstruction most needs to see, and folding it
   * into a boolean is how a dropped message disappears from the story.
   */
  readonly outcome: 'ok' | 'refused' | 'dropped'
  /** Protocol code when the event carried one. */
  readonly code?: string
  readonly detail?: Readonly<Record<string, string | number | boolean>>
  /**
   * sha-256 of the previous record's canonical form, {@link GENESIS_PREVIOUS}
   * for the first. This is what makes an edit **detectable** — see `chain.ts`
   * for the careful version of that claim.
   */
  readonly prev: string
}

/** What a caller supplies; `seq` and `prev` are the trail's to fill in. */
export type AuditInput = Omit<AuditRecord, 'seq' | 'prev'>

/**
 * The bytes a record hashes as.
 *
 * Field order is fixed here rather than left to `JSON.stringify` over an object
 * built elsewhere: two writers producing the same record in a different key
 * order would produce a different hash and a chain that fails to verify for no
 * reason anyone could find. Same lesson as the fingerprint in §7.2, same
 * answer — pin the order in one place.
 */
export function canonicalize(record: AuditRecord): string {
  return JSON.stringify([
    record.seq,
    record.at,
    record.source,
    record.kind,
    record.traceId ?? null,
    record.taskId ?? null,
    record.msgId ?? null,
    record.node ?? null,
    record.peer ?? null,
    record.outcome,
    record.code ?? null,
    record.detail ?? null,
    record.prev,
  ])
}

/** sha-256 of a record's canonical form, hex. */
export function digestOf(record: AuditRecord): string {
  return createHash('sha256').update(canonicalize(record), 'utf8').digest('hex')
}

/** The trace-id segment of a traceparent — what stays constant across hops. */
export function traceIdSegment(traceparent: string | undefined): string | null {
  if (traceparent === undefined) return null
  const parts = traceparent.split('-')
  return parts.length === 4 ? (parts[1] ?? null) : traceparent
}
