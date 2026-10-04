// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MessageOrigin,
  NoticeTrust,
  QianmoMessage,
} from '@qianmo/protocol'
import {
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  deliveryExpiresAt,
  firstErrorCode,
  formatAddress,
  parseAddress,
  taskExpiresAt,
  validateMessage,
} from '@qianmo/protocol'
import { MAX_MAILBOX_MESSAGE_TEXT_BYTES } from 'src/utils/agents/teammateMailbox.js'
import { writeToMailbox } from 'src/utils/agents/teammateMailbox.js'

import type { BlobRef } from './blob.js'
import { BlobStore } from './blob.js'
import { assertTeamName, isReservedDeviceName } from './names.js'
import type { MailboxEntryIdentity } from './observer.js'
import type { QianmoWrapper } from './wrapper.js'
import {
  QIANMO_WRAPPER_TYPE,
  assertWrapperTypeIsNotReserved,
  buildNotice,
  buildWrapper,
  serializeWrapper,
  textBytes,
} from './wrapper.js'

/**
 * The inbound adapter: the last hop of a cross-node delivery (protocol.md §9).
 *
 * ## Rule M-1 — call the exported function, never the tool
 *
 * Delivery goes straight to `teammateMailbox.writeToMailbox`
 * (`src/utils/agents/teammateMailbox.ts:362-366`). Not through
 * `SendMessageTool`, and the reason is *not* that the tool would refuse a
 * `qianmo://` address. It would not: `to` is typed `z.string()` with no format
 * constraint (`SendMessageTool.ts:69-73`) and the only character check is
 * `input.to.includes('@')` (`:599-606`), which a `qianmo://` address passes.
 * It would then reach `getInboxPath` → `sanitizePathComponent`
 * (`teammateMailbox.ts:285-295`), whose regex rewrites
 * `qianmo://node-b/reviewer` into the filename `qianmo---node-b-reviewer`.
 *
 * The real consequence of routing through the tool is therefore not rejection
 * but a silent misdelivery into a local inbox nobody reads — strictly harder
 * to diagnose than an error.
 *
 * ## Rule E-1 — `from` is re-rendered, never copied
 *
 * The base decides identity by string-comparing `from` in several places:
 * `isLeaderIdentity` is `sender === security.leadAgentId || sender ===
 * security.leadName` (`src/hooks/useInboxPoller.ts:145-153`), gating
 * permission responses, plan approval and shutdown approval (`:324`, `:542`,
 * `:648`); the in-process runner jumps `m.from === TEAM_LEAD_NAME` ahead of
 * every peer message (`src/utils/swarm/inProcessRunner.ts:837`). A bare name
 * in `from` would let a remote node claim `team-lead` and get both. A full
 * address cannot collide: it contains `:` and `/`, and every local identity is
 * a bare name. So the adapter re-renders the address from its parse rather
 * than trusting the string it was handed, and rejects outright on failure —
 * no best-effort repair.
 */

/**
 * What the routing layer verified about one message, as the adapter receives
 * it (issue #28).
 *
 * One type rather than an inline shape at four call sites: adding a field to a
 * structural literal repeated down a call chain is how the tier came to stop
 * one layer short of the notice in the first place.
 */
export interface InboundVerification {
  /** `iss` of the token that verified, absent when none was presented. */
  readonly capIss?: string
  /** Tier the capability gate assigned. Absent means `untrusted`. */
  readonly trust?: NoticeTrust
}

/** A message the adapter refused, with the wire code to reply with. */
export interface InboundRejection {
  readonly status: 'rejected'
  readonly code: ProtocolErrorCode
  readonly reason: string
}

/** A message written into the target mailbox. */
export interface InboundDelivered {
  readonly status: 'delivered'
  /** Base agent name the entry was written under (`to`'s agent segment). */
  readonly recipient: string
  /** Normalized team name used for the inbox path. */
  readonly team: string
  /** `[from, timestamp, text]` — hand this to the observer. */
  readonly identity: MailboxEntryIdentity
  /** Exactly what was serialized into `text`. */
  readonly wrapper: QianmoWrapper
  /** Delivery deadline after excluding local freeze overlap. */
  readonly deadlineAt: number
  /** Present when the payload was spilled to the staging area (§9.3). */
  readonly blob?: BlobRef
}

export type InboundResult = InboundDelivered | InboundRejection

/** Construction options for {@link InboundAdapter}. */
export interface InboundAdapterOptions {
  /** This node's own `node` segment; messages addressed elsewhere are refused. */
  readonly node: string
  /** Team whose inboxes this node writes into. Must satisfy rule A-2. */
  readonly team: string
  /** Staging area. Defaults to one rooted at `occConfigPath()`. */
  readonly blobs?: BlobStore
  /** Injected wall clock for provenance and mailbox timestamps. */
  readonly now?: () => number
  /** Rule T-2 clock used only for envelope deadline validation. */
  readonly deadlineNow?: (createdAt: number) => number
  /**
   * Mailbox `text` ceiling. Defaults to the base's own exported constant —
   * production must never pass this, and must never copy the number (§9.3.3).
   */
  readonly maxTextBytes?: number
}

function reject(code: ProtocolErrorCode, reason: string): InboundRejection {
  return { status: 'rejected', code, reason }
}

export class InboundAdapter {
  readonly node: string
  readonly team: string
  readonly blobs: BlobStore
  private readonly now: () => number
  private readonly deadlineNow: (createdAt: number) => number
  private readonly maxTextBytes: number

  constructor(options: InboundAdapterOptions) {
    if (isReservedDeviceName(options.node)) {
      throw new Error(
        `node name ${JSON.stringify(options.node)} is a reserved Windows device name (rule A-1)`,
      )
    }
    this.node = options.node
    this.team = assertTeamName(options.team)
    this.blobs = options.blobs ?? new BlobStore()
    this.now = options.now ?? Date.now
    this.deadlineNow = options.deadlineNow ?? (() => this.now())
    this.maxTextBytes = options.maxTextBytes ?? MAX_MAILBOX_MESSAGE_TEXT_BYTES
    assertWrapperTypeIsNotReserved(QIANMO_WRAPPER_TYPE)
  }

  /**
   * Validate, label, size and write one inbound message.
   *
   * Checks run in the order rule S-2 fixes, and the mailbox write is last on
   * purpose: it is the only step with a persistent side effect, so anything
   * that ran after authorization would be an attack surface. Capability
   * verification, the inbound rate budget and loop detection are the routing
   * layer's steps (`@qianmo/router`, `@qianmo/capability`) and run ahead of
   * this call; this class owns the structural checks, the TTL check and the
   * write itself.
   *
   * `verified` is what the routing layer established and this layer could not:
   * `capIss` names who signed, `trust` says what that signature was worth here
   * (issue #28). Both are passed in rather than read off the envelope precisely
   * because §10.2 says provenance is what the *receiver* established, never
   * what the message said about itself — and `trust` additionally could not be
   * computed here at all, since deciding it needs a key directory and a trust
   * list that this package deliberately has no access to.
   *
   * Both default to the safe value. An omitted `trust` is `untrusted`, so a
   * caller that has not been updated downgrades rather than guesses.
   */
  async deliver(
    message: QianmoMessage,
    verified: InboundVerification = {},
  ): Promise<InboundResult> {
    const receivedAt = this.now()

    // 1. Envelope structure, size, hop count and the DELIVERY deadline.
    //
    //    Passing the arrival clock is what makes this rule T-1's second
    //    checkpoint: `validateMessage` judges `createdAt + deliverTtlMs`
    //    against `receivedAt` and returns `E_TTL_EXPIRED`, so an already-void
    //    message is refused here and never written. That matters beyond
    //    tidiness — writing it would consume the recipient's mailbox quota and
    //    squeeze out somebody else's unread message.
    //
    //    `options.node` is deliberately *not* passed: node-granular loop
    //    detection kills legitimate spirals, and the real check is keyed on
    //    `(handler address, taskId)` in the routing layer (§6.2).
    const deadlineNow = this.deadlineNow(message.createdAt)
    const validation = validateMessage(message, { now: deadlineNow })
    if (!validation.ok) {
      return reject(
        firstErrorCode(validation) ?? ProtocolErrorCode.E_BAD_ENVELOPE,
        validation.issues[0]?.message ?? 'envelope failed validation',
      )
    }
    const envelope = validation.message

    // 2. Addresses: parse both, re-render `from` (E-1), forbid device names (A-1).
    const from = parseAddress(envelope.from)
    const to = parseAddress(envelope.to)
    if (from === null) {
      return reject(ProtocolErrorCode.E_BAD_ADDRESS, 'from is not an address')
    }
    if (to === null) {
      return reject(ProtocolErrorCode.E_BAD_ADDRESS, 'to is not an address')
    }
    for (const [field, segment] of [
      ['from.node', from.node],
      ['from.agent', from.agent],
      ['to.node', to.node],
      ['to.agent', to.agent],
    ] as const) {
      if (isReservedDeviceName(segment)) {
        return reject(
          ProtocolErrorCode.E_BAD_ADDRESS,
          `${field} is a reserved Windows device name (rule A-1)`,
        )
      }
    }
    if (to.node !== this.node) {
      return reject(
        ProtocolErrorCode.E_UNKNOWN_AGENT,
        `${envelope.to} is not hosted on node ${this.node}`,
      )
    }
    const renderedFrom = formatAddress(from)

    // 3. Provenance, written by the receiver — the envelope's own account of
    //    where it came from is never taken at face value (§10.2). `capIss` is
    //    present only when the routing layer *verified* a token and tells us
    //    who signed it; an absent one stays absent, because "we could not tell"
    //    and "nobody signed for this" must not look alike downstream.
    const origin: MessageOrigin = {
      node: from.node,
      agent: from.agent,
      receivedAt,
      ...(verified.capIss === undefined ? {} : { capIss: verified.capIss }),
    }
    const trust = verified.trust ?? TRUST_UNTRUSTED
    const labelled: QianmoMessage = { ...envelope, origin }

    // 4. Size, by measurement of the final string (rule M-5, §9.3.4).
    let wrapper = buildWrapper(labelled, buildNotice(origin, trust))
    let text = serializeWrapper(wrapper)
    let blob: BlobRef | undefined

    if (textBytes(text) > this.maxTextBytes) {
      try {
        blob = await this.blobs.put(labelled.payload, {
          taskId: labelled.taskId,
          expiresAt: taskExpiresAt(labelled),
        })
      } catch (error) {
        return reject(
          ProtocolErrorCode.E_UNDELIVERABLE,
          `payload could not be staged: ${String(error)}`,
        )
      }
      wrapper = buildWrapper(
        { ...labelled, payload: blob },
        buildNotice(origin, trust),
      )
      // Measure again: the reference is a different string, not an estimate.
      text = serializeWrapper(wrapper)
      if (textBytes(text) > this.maxTextBytes) {
        return reject(
          ProtocolErrorCode.E_UNDELIVERABLE,
          `envelope shell is ${textBytes(text)} bytes, over the ${this.maxTextBytes}-byte mailbox limit even after staging the payload`,
        )
      }
    }

    // 5. Write. `color` is deliberately omitted: it is optional
    //    (`teammateMailbox.ts:51-58`) and the adapter does not go anywhere
    //    near `findTeammateColor`.
    const identity: MailboxEntryIdentity = {
      from: renderedFrom,
      timestamp: new Date(receivedAt).toISOString(),
      text,
    }
    try {
      await writeToMailbox(
        to.agent,
        {
          from: identity.from,
          text: identity.text,
          timestamp: identity.timestamp,
        },
        this.team,
      )
    } catch (error) {
      return reject(
        ProtocolErrorCode.E_UNDELIVERABLE,
        `mailbox write failed: ${String(error)}`,
      )
    }

    return {
      status: 'delivered',
      recipient: to.agent,
      team: this.team,
      identity,
      wrapper,
      deadlineAt:
        deliveryExpiresAt(wrapper.envelope) + receivedAt - deadlineNow,
      ...(blob === undefined ? {} : { blob }),
    }
  }
}
