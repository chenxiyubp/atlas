// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the trail lives, and how each layer's events get onto it (P7.2).
 *
 * `@qianmo/audit` deliberately knows nothing about the layers that write to it —
 * it would otherwise depend on every package in the tree, and the dependency
 * would run the wrong way. So the translation lives here, in the wiring layer,
 * next to the path derivation it also owns.
 *
 * ## One mapping decision, applied everywhere
 *
 * Each layer's own event name goes through **unchanged** as `kind`. The
 * temptation is to normalise them into a tidy vocabulary; the reason not to is
 * that an operator reading the trail is usually holding a log line from one of
 * those layers, and a trail that renamed everything makes them do the
 * translation instead. What is normalised is only `outcome` — `ok` / `refused`
 * / `dropped` — because "did this go ahead" is the one question the trail must
 * answer uniformly, and the per-layer names for refusal are not comparable.
 */

import { AuditSource, AuditTrail, type AuditInput } from '@qianmo/audit'
import type { ShadowRefusal, ShadowRefusalSink } from '@qianmo/capability'
import {
  RouterEventType,
  type RouterAuditEvent,
  type RouterAuditSink,
} from '@qianmo/router'
import {
  HandshakeRejection,
  TransportEventType,
  type TransportEvent,
  type TransportEventSink,
} from '@qianmo/transport'
import {
  ActivatorEventType,
  type AuditEvent as ActivatorAuditEvent,
} from '@qianmo/activator'
import {
  NegotiationEventType,
  type NegotiationAuditSink,
  type NegotiationEvent,
} from '@qianmo/negotiation'
import {
  TunnelEventType,
  type TunnelAuditSink,
  type TunnelEvent,
} from '@qianmo/tunnel'
import {
  BackupEventType,
  type BackupAuditEvent,
  type BackupAuditSink,
} from '@qianmo/backup'
import {
  CapacityEventType,
  type CapacityAuditSink,
  type CapacityEvent,
} from '@qianmo/capacity'
import {
  ResidentNotifyEventType,
  type ResidentNotifyAuditSink,
  type ResidentNotifyEvent,
} from '@qianmo/resident'
import type {
  CertificateDirectoryAuditEvent,
  CertificateDirectoryAuditSink,
  CertificateDirectoryErrorEvent,
  CertificateDirectoryErrorSink,
} from './certificateDirectory.js'
import { occConfigPath } from '../../config/paths.js'

/** Default location of this node's trail, derived from the config root. */
export function auditTrailPath(): string {
  return occConfigPath('qianmo', 'audit', 'trail.ndjson')
}

/**
 * Open (or resume) the node's trail, materialising the file at once.
 *
 * The file is created here rather than on the first record so that a node
 * which has done no protocol work still has an **empty** chain rather than no
 * chain: "nothing has happened here yet" and "the trail never reached me" are
 * different states, and a reader that sees neither file nor records cannot
 * tell them apart (issue #9).
 */
export function openAuditTrail(path: string = auditTrailPath()): AuditTrail {
  const trail = new AuditTrail(path)
  trail.ensure()
  return trail
}

/** One layer's event, as every one of them happens to be shaped. */
interface LayerEvent {
  readonly type: string
  readonly at: number
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

function stringOf(
  detail: LayerEvent['detail'],
  key: string,
): string | undefined {
  const value = detail[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The shared translation: correlation keys out of the detail, the layer's own
 * event name through unchanged, and the caller's verdict on the outcome.
 *
 * Every layer names its peer differently — `from`, `borrower`, `sandboxName` —
 * so the peer key is a parameter rather than a guess. Guessing would put the
 * wrong address on an audit line, which is worse than leaving it empty.
 */
function toRecord(
  event: LayerEvent,
  source: AuditSource,
  node: string,
  outcome: AuditInput['outcome'],
  peerKeys: readonly string[] = ['from'],
): AuditInput {
  const peer = peerKeys
    .map(key => stringOf(event.detail, key))
    .find(value => value !== undefined)
  return {
    at: event.at,
    source,
    kind: event.type,
    outcome,
    node,
    ...(stringOf(event.detail, 'traceId') === undefined
      ? {}
      : { traceId: stringOf(event.detail, 'traceId') as string }),
    ...(stringOf(event.detail, 'taskId') === undefined
      ? {}
      : { taskId: stringOf(event.detail, 'taskId') as string }),
    ...(stringOf(event.detail, 'msgId') === undefined
      ? {}
      : { msgId: stringOf(event.detail, 'msgId') as string }),
    ...(peer === undefined ? {} : { peer }),
    ...(stringOf(event.detail, 'code') === undefined
      ? {}
      : { code: stringOf(event.detail, 'code') as string }),
    detail: event.detail,
  }
}

/** Append without letting a full or unwritable logbook stop the node. */
function safeAppend(trail: AuditTrail, input: AuditInput): void {
  try {
    trail.append(input)
  } catch {
    // The layer's own ring still has the event, and the next write will try
    // again. Losing the node because its logbook is full would be a strictly
    // worse outcome than losing the line.
  }
}

/**
 * Turn the router's events into trail records.
 *
 * Every router event that reaches this sink is a refusal — the router only
 * records loops, rate limits and capability denials, never the messages it
 * waved through. That is worth knowing when reading the trail: the router's
 * lines are the *exceptions*, and the successes are recorded by the layers that
 * did the work.
 */
export function routerTrailSink(
  trail: AuditTrail,
  node: string,
): RouterAuditSink {
  return (event: RouterAuditEvent): void => {
    const source =
      event.type === RouterEventType.CapabilityDenied
        ? AuditSource.Capability
        : AuditSource.Router
    safeAppend(trail, toRecord(event, source, node, 'refused'))
  }
}

/** How each transport event answers "did this message go ahead". */
const TRANSPORT_OUTCOMES: Partial<
  Record<TransportEventType, 'ok' | 'refused' | 'dropped'>
> = {
  [TransportEventType.MessageAccepted]: 'ok',
  [TransportEventType.MessageRejected]: 'refused',
  // A retransmission the receiver absorbed. Recorded as `dropped` rather than
  // omitted: "why did the sender see two receipts" is unanswerable without it,
  // and P7.2's DoD names deduplicated messages explicitly.
  [TransportEventType.MessageDuplicate]: 'dropped',
}

/**
 * The handshake refusals that earn a line on the trail, and what it costs an
 * outsider to provoke one.
 *
 * Handshake events as a class stay in the transport's own ring — the trail is
 * for the life of a *message*, and a file that also carried every keep-alive
 * would bury the lines somebody is looking for. But that ring is process
 * memory, so the one handshake outcome an operator is ever asked to explain
 * afterwards — *somebody turned up holding a credential and was refused* — was
 * the one outcome no persisted surface recorded.
 *
 * Which refusals qualify is a **write-amplification** decision before it is an
 * observability one. Every record here is an `fsync`, on a path an unrefused
 * stranger can reach; a whitelist that admitted a refusal any scanner can
 * produce would hand that stranger a free way to fill the node's disk. So the
 * refusals split into two tiers by what the sender must already possess:
 *
 * - **`credentialed`** — unreachable without credentials that have *already
 *   verified*. {@link HandshakeRejection.ChannelIdentityMismatch} is only
 *   raised after `verifyAuthAttempt` returned `ok`, i.e. by a peer holding a
 *   working PSK or a directory-listed signing key, and only when its channel
 *   id collides with a retained channel under another identity;
 *   {@link HandshakeRejection.BadCredentialProof} is only reached after the
 *   handshake signature itself verified, i.e. by a holder of that node's
 *   private key. Neither is producible by an unauthenticated dialer at any
 *   price.
 * - **`unproven`** — security-relevant *and* cheap.
 *   {@link HandshakeRejection.UnknownSigner},
 *   {@link HandshakeRejection.BadSignature} and
 *   {@link HandshakeRejection.CredentialRequired} all sit **before** any proof
 *   is checked: a stranger who echoes the challenge nonce reaches every one of
 *   them with arbitrary bytes. They are worth recording — "the directory has
 *   no key for you" and "your signature is wrong" are how a rotation gone
 *   wrong is told apart from a probe — but they may never be recorded
 *   one-for-one, so this tier is metered (see {@link HandshakeAuditMeter}).
 *
 * Everything else stays out, and the exclusions are the load-bearing half:
 * `malformed_frame`, `unexpected_frame`, `bad_node`, `bad_channel`,
 * `nonce_mismatch` and `signature_required` are pure grammar or pure policy —
 * they say nothing about who called; `bad_mac` is the wrong-PSK scanner, one
 * line per garbage frame and no information beyond "somebody dialled";
 * `certificate_expired` and `channel_capacity` are this node's own state,
 * which every connection would restate. Version negotiation is not on the
 * list either, for the same reason grammar is not.
 *
 * The dialer's own `ready_*` refusals (the listener failed to prove itself)
 * stay out too: they are a different question — *did I reach who I meant to* —
 * and they are provoked by whatever endpoint the zero-auth registry names, so
 * admitting them would need its own budget rather than a share of this one.
 */
const HANDSHAKE_AUDITED: Readonly<
  Record<string, 'credentialed' | 'unproven' | undefined>
> = {
  [HandshakeRejection.ChannelIdentityMismatch]: 'credentialed',
  [HandshakeRejection.BadCredentialProof]: 'credentialed',
  [HandshakeRejection.UnknownSigner]: 'unproven',
  [HandshakeRejection.BadSignature]: 'unproven',
  [HandshakeRejection.CredentialRequired]: 'unproven',
}

/** How long one distinct refusal holds its slot before it may write again. */
const HANDSHAKE_AUDIT_WINDOW_MS = 60_000

/**
 * Slots per window, per tier. Two meters rather than one shared budget: a
 * stranger flooding `unknown_signer` must not be able to crowd out the
 * identity-conflict line, which is the record this whole path exists for.
 */
const HANDSHAKE_AUDIT_CAPACITY: Readonly<
  Record<'credentialed' | 'unproven', number>
> = { credentialed: 8, unproven: 4 }

interface MeterSlot {
  windowStart: number
  suppressed: number
}

/**
 * A hard ceiling on handshake-refusal records, with nothing counted twice and
 * nothing counted away.
 *
 * One slot per distinct refusal — the rejection, the claimed node and the
 * channel id together — so two genuinely different peers failing in the same
 * minute still get a line each, while one peer failing four hundred times gets
 * one line and a number. A slot lives {@link HANDSHAKE_AUDIT_WINDOW_MS}; at
 * most `capacity` slots exist at once, and a refusal that finds every slot
 * taken is counted rather than written. So the worst case an attacker can buy
 * is `capacity` records per window, whatever rate it dials at.
 *
 * The suppressed tallies are never dropped: they ride out on the `suppressed`
 * field of the next record this meter does write. The one thing that costs is
 * that a burst which stops has its final tally sitting in memory until the
 * next refusal of that tier — the *fact* is on the record either way, only the
 * last count waits. Flushing it on a timer was the alternative and it is
 * worse: a timer inside an event sink outlives the socket that armed it.
 */
class HandshakeAuditMeter {
  readonly #slots = new Map<string, MeterSlot>()
  #carried = 0

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number = HANDSHAKE_AUDIT_WINDOW_MS,
  ) {}

  /**
   * `null` to suppress, otherwise how many earlier refusals this record is
   * also speaking for (`0` when it speaks only for itself).
   */
  admit(key: string, now: number): number | null {
    for (const [name, slot] of this.#slots) {
      if (now - slot.windowStart < this.windowMs) continue
      this.#carried += slot.suppressed
      this.#slots.delete(name)
    }
    const slot = this.#slots.get(key)
    if (slot !== undefined) {
      slot.suppressed += 1
      return null
    }
    if (this.#slots.size >= this.capacity) {
      this.#carried += 1
      return null
    }
    this.#slots.set(key, { windowStart: now, suppressed: 0 })
    const carried = this.#carried
    this.#carried = 0
    return carried
  }
}

/**
 * File a handshake refusal, or decide it is not one of the audited kinds.
 *
 * The record is the same shape a `message_rejected` line has — same `source`,
 * the layer's own event name as `kind`, `refused` as the outcome, the claimed
 * peer in `peer` — with the rejection string as `code`, because that is the
 * field an operator greps and the close code (4003/4004) is deliberately too
 * coarse to tell these apart. `channelId` and `pending` ride through in
 * `detail` untouched: *which channel was reached for* and *how many undelivered
 * envelopes it was holding at that moment* are the whole of the attribution,
 * and they exist on no other surface once the process restarts.
 */
function appendHandshakeRefusal(
  trail: AuditTrail,
  node: string,
  event: TransportEvent,
  meters: Readonly<Record<'credentialed' | 'unproven', HandshakeAuditMeter>>,
): void {
  if (event.type !== TransportEventType.AuthRejected) return
  const rejection = stringOf(event.detail, 'rejection')
  if (rejection === undefined) return
  const tier = HANDSHAKE_AUDITED[rejection]
  if (tier === undefined) return
  const peer = stringOf(event.detail, 'node') ?? ''
  const channelId = stringOf(event.detail, 'channelId') ?? ''
  const suppressed = meters[tier].admit(
    `${rejection} ${peer} ${channelId}`,
    event.at,
  )
  if (suppressed === null) return
  const base = toRecord(
    { type: event.type, at: event.at, detail: event.detail },
    AuditSource.Transport,
    node,
    'refused',
    ['node'],
  )
  safeAppend(trail, {
    ...base,
    code: rejection,
    detail: suppressed === 0 ? event.detail : { ...event.detail, suppressed },
  })
}

/**
 * Turn transport events into trail records: every message-level one, and the
 * handshake refusals {@link HANDSHAKE_AUDITED} admits.
 */
export function transportTrailSink(
  trail: AuditTrail,
  node: string,
): TransportEventSink {
  // Per sink, not per module: two listeners in one process are two nodes'
  // worth of refusals, and one shared budget would let a flood at either of
  // them silence the other.
  const meters = {
    credentialed: new HandshakeAuditMeter(
      HANDSHAKE_AUDIT_CAPACITY.credentialed,
    ),
    unproven: new HandshakeAuditMeter(HANDSHAKE_AUDIT_CAPACITY.unproven),
  }
  return (event: TransportEvent): void => {
    const outcome = TRANSPORT_OUTCOMES[event.type]
    // Keep-alives, reconnects and accepted handshakes stay in the transport's
    // own ring; the refused handshakes that name a credential do not.
    if (outcome === undefined) {
      appendHandshakeRefusal(trail, node, event, meters)
      return
    }
    safeAppend(
      trail,
      toRecord(
        { type: event.type, at: event.at, detail: event.detail },
        AuditSource.Transport,
        node,
        outcome,
        // The transport calls the other end `node`.
        ['node'],
      ),
    )
  }
}

/**
 * The remaining four layers.
 *
 * Each maps its own refusal events onto `refused` and everything else onto
 * `ok`; the one exception is a lease or route that lapsed on a timer, which is
 * `dropped` — nobody refused it, it simply ran out, and an audit that called
 * that a refusal would send the reader looking for a decision nobody made.
 */
export function activatorTrailSink(
  trail: AuditTrail,
  node: string,
): (event: ActivatorAuditEvent) => void {
  const refusals: ReadonlySet<ActivatorEventType> = new Set([
    ActivatorEventType.RequestRefused,
    ActivatorEventType.RequestFailed,
    ActivatorEventType.CapabilityDenied,
    ActivatorEventType.TaskReplyRejected,
  ])
  const lapses: ReadonlySet<ActivatorEventType> = new Set([
    ActivatorEventType.TaskRouteExpired,
    ActivatorEventType.JournalTorn,
  ])
  return (event: ActivatorAuditEvent): void => {
    const outcome = refusals.has(event.type)
      ? 'refused'
      : lapses.has(event.type)
        ? 'dropped'
        : 'ok'
    safeAppend(
      trail,
      toRecord(event, AuditSource.Activator, node, outcome, [
        'from',
        'sandboxName',
      ]),
    )
  }
}

export function negotiationTrailSink(
  trail: AuditTrail,
  node: string,
): NegotiationAuditSink {
  return (event: NegotiationEvent): void => {
    const outcome =
      event.type === NegotiationEventType.Refused ? 'refused' : 'ok'
    safeAppend(
      trail,
      toRecord(event, AuditSource.Negotiation, node, outcome, [
        'borrower',
        'lender',
      ]),
    )
  }
}

export function tunnelTrailSink(
  trail: AuditTrail,
  node: string,
): TunnelAuditSink {
  return (event: TunnelEvent): void => {
    const outcome = event.type === TunnelEventType.Refused ? 'refused' : 'ok'
    safeAppend(
      trail,
      toRecord(event, AuditSource.Tunnel, node, outcome, ['borrower', 'from']),
    )
  }
}

/**
 * The capacity planner's decisions.
 *
 * A suppressed trigger is `dropped`, not `refused` — same distinction the
 * activator's expired routes get, and for the same reason: **no one refused
 * it, it was simply held back by a rule** (the cooldown had not lapsed, or the
 * calendar path had already bought capacity for that window). Filing it as a
 * refusal would send a reader looking for a decision nobody made.
 */
const CAPACITY_DROPPED: ReadonlySet<CapacityEventType> = new Set([
  CapacityEventType.Suppressed,
])

export function capacityTrailSink(
  trail: AuditTrail,
  node: string,
): CapacityAuditSink {
  return (event: CapacityEvent): void => {
    safeAppend(
      trail,
      toRecord(
        event,
        AuditSource.Capacity,
        node,
        CAPACITY_DROPPED.has(event.type) ? 'dropped' : 'ok',
        // The other end of a scale-up is whoever ends up lending the room.
        // Empty until an executor that provisions exists (charter N-7).
        ['lender'],
      ),
    )
  }
}

export function backupTrailSink(
  trail: AuditTrail,
  node: string,
): BackupAuditSink {
  const refusals: ReadonlySet<BackupEventType> = new Set([
    BackupEventType.MutationDenied,
    BackupEventType.ReadDenied,
    BackupEventType.AccessDenied,
  ])
  return (event: BackupAuditEvent): void => {
    safeAppend(
      trail,
      toRecord(
        event,
        AuditSource.Backup,
        node,
        refusals.has(event.type) ? 'refused' : 'ok',
        ['workspace'],
      ),
    )
  }
}

/**
 * Outbound `notify` (P13.6), the only layer whose **successes** are the point.
 *
 * Every other sink here files a refusal or a delivery of somebody else's
 * traffic. This one files the evidence a watch job exists to produce: that at
 * 03:14 this node told a person something, and that the console receipted it.
 * A trail without those lines cannot answer "did anyone actually get told",
 * which is the only question asked of an unattended run after the fact.
 *
 * Three outcomes, and the middle one is why `outcome` is three-valued:
 * `refused` is a peer saying no (it does not implement the type), while a
 * notification merely *held* — no channel, or the sliding window shut — is
 * `dropped`, because nobody refused it and nothing is wrong. Filing a hold as
 * a refusal would send a reader looking for a decision that was never made.
 *
 * The `schemaVersion` the notifier stamps rides through in `detail` untouched
 * (hermes B9): three days from now, a record missing a field has to be
 * separable from a record that was edited, and the hash chain alone cannot
 * tell those apart.
 */
const NOTIFY_OUTCOMES: Readonly<
  Record<ResidentNotifyEventType, 'ok' | 'refused' | 'dropped'>
> = {
  [ResidentNotifyEventType.Sent]: 'ok',
  [ResidentNotifyEventType.Delivered]: 'ok',
  [ResidentNotifyEventType.Held]: 'dropped',
  [ResidentNotifyEventType.Suppressed]: 'dropped',
  [ResidentNotifyEventType.Unsupported]: 'refused',
  [ResidentNotifyEventType.Abandoned]: 'dropped',
}

export function residentNotifyTrailSink(
  trail: AuditTrail,
  node: string,
): ResidentNotifyAuditSink {
  return (event: ResidentNotifyEvent): void => {
    safeAppend(
      trail,
      toRecord(
        event,
        AuditSource.Resident,
        node,
        NOTIFY_OUTCOMES[event.type] ?? 'ok',
        // The other end of a notification is whoever the node is telling.
        ['peer'],
      ),
    )
  }
}

/**
 * The `--trust` / CA-derived key conflict, on the record (§8.2 phase ①).
 *
 * §8.2's coexistence rule has two halves and the second one is the reason
 * this sink exists: an explicit `--trust` entry wins over a CA-derived key
 * for the same node, **and it is audited** — "不是静默覆盖，也不是启动失败".
 * Starting up would turn a routine certificate rotation into an outage;
 * saying nothing would leave the one state where two authorities disagree
 * about a node's key looking exactly like the state where they agree.
 *
 * `outcome` is `dropped` rather than `refused`: nothing was refused — the
 * node kept working, and what happened to the CA-derived key is that it was
 * discarded in favour of the operator's own entry. `refused` would send a
 * reader looking for a rejected message that does not exist.
 *
 * Filed under {@link AuditSource.Capability} because the directory this
 * concerns is the one the capability gate reads: the conflict's whole
 * consequence is which key a peer's tokens get verified against.
 */
export function certificateDirectoryTrailSink(
  trail: AuditTrail,
  node: string,
): CertificateDirectoryAuditSink {
  return (event: CertificateDirectoryAuditEvent): void => {
    safeAppend(trail, {
      at: Date.now(),
      source: AuditSource.Capability,
      kind: 'certificate_directory_conflict',
      outcome: 'dropped',
      node,
      peer: event.node,
      detail: { reason: event.reason },
    })
  }
}

/** Contained directory observer/RL failures, without credential material. */
export function certificateDirectoryErrorTrailSink(
  trail: AuditTrail,
  node: string,
): CertificateDirectoryErrorSink {
  return (event: CertificateDirectoryErrorEvent): void => {
    safeAppend(trail, {
      at: Date.now(),
      source: AuditSource.Capability,
      kind: 'certificate_directory_error',
      outcome: 'refused',
      node,
      detail: { phase: event.phase, reason: event.reason },
    })
  }
}

/**
 * `--audit-signed-tasks`: what the enforcing policy **would** have refused
 * (key-distribution.md §9.2 phase ①).
 *
 * `outcome` is `ok`, and that is not a compromise — the message went ahead.
 * The phase's entire contract is that no message's fate changes, so a line
 * that said `refused` would be a false statement about what this node did,
 * and it would put the count into the same bucket an operator uses to find
 * real refusals.
 *
 * The code the switch *would* have answered with rides in `detail` rather
 * than in the record's own `code` field, for the same reason: `code` means
 * "this message was answered with this error", and this one was not answered
 * with anything.
 *
 * `kind` is what makes the phase countable — seven days of
 * `capability_shadow_refusal` at zero is §9.2's exit criterion, and it is one
 * `grep` on a file that already exists.
 */
export function capabilityShadowTrailSink(
  trail: AuditTrail,
  node: string,
): ShadowRefusalSink {
  return (refusal: ShadowRefusal): void => {
    safeAppend(trail, {
      at: Date.now(),
      source: AuditSource.Capability,
      kind: 'capability_shadow_refusal',
      outcome: 'ok',
      node,
      peer: refusal.from,
      traceId: refusal.traceId,
      taskId: refusal.taskId,
      msgId: refusal.msgId,
      detail: {
        type: refusal.type,
        required: refusal.required,
        presented: refusal.presented,
        wouldRefuseWith: refusal.code,
        reason: refusal.reason,
      },
    })
  }
}
