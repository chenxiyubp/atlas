// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AckPayload, ErrorPayload, QianmoMessage } from '@qianmo/protocol'
import { createAck, errorReply, formatAddress } from '@qianmo/protocol'

import type {
  InboundAdapter,
  InboundDelivered,
  InboundRejection,
  InboundVerification,
} from './inbound.js'
import type { ObserveOptions } from './observer.js'
import { observeReadFlip } from './observer.js'

export type ErrorReplyPayload = ErrorPayload

/**
 * The reply the last hop hands back to the transport, and the terminal state
 * it corresponds to (protocol.md §8.2 rows 16 / 17 / 18, plus the pre-write
 * refusals of rows 10-15).
 */
export type DeliveryReply =
  | {
      readonly outcome: 'acked'
      readonly reply: QianmoMessage<AckPayload>
      readonly delivered: InboundDelivered
    }
  | {
      readonly outcome: 'dropped' | 'expired'
      readonly reply: QianmoMessage<ErrorReplyPayload>
      readonly delivered: InboundDelivered
    }
  | {
      readonly outcome: 'rejected'
      readonly reply: QianmoMessage<ErrorReplyPayload>
      readonly rejection: InboundRejection
    }

/** Timing knobs passed through to {@link observeReadFlip}. */
export type DeliveryObserveOptions = Omit<
  ObserveOptions,
  'agent' | 'team' | 'identity' | 'deadlineAt'
>

/**
 * Deliver one inbound message and produce the reply its fate calls for.
 *
 * This is where "the ack is end-to-end" stops being a convention and becomes
 * structure: {@link createAck} is called in exactly one branch of one
 * `switch`, the one reached only after {@link observeReadFlip} has seen the
 * base flip `read` to `true`. There is no code path from "the write returned"
 * to an ack. An eviction and a timeout each get their own error code instead,
 * which is the substantive difference from write-time acking — that variant
 * cannot tell an evicted message from a delivered one at all, and reports the
 * first as the second.
 */
export async function deliverAndAck(
  adapter: InboundAdapter,
  message: QianmoMessage,
  observe: DeliveryObserveOptions = {},
  /** What the routing layer verified about this message, if anything. */
  verified: InboundVerification = {},
): Promise<DeliveryReply> {
  const result = await adapter.deliver(message, verified)
  if (result.status === 'rejected') {
    return {
      outcome: 'rejected',
      rejection: result,
      reply: errorReply(message, result.code, result.reason),
    }
  }

  const outcome = await observeReadFlip({
    ...observe,
    agent: result.recipient,
    team: result.team,
    identity: result.identity,
    deadlineAt: result.deadlineAt,
  })

  switch (outcome.state) {
    case 'acked': {
      // The only `createAck` call site in the package. Every field comes off
      // the acked envelope, this node's own address, or the clock — nothing
      // reads prior session state, which is what keeps the ack A-class (K-1).
      const handler = formatAddress({
        node: adapter.node,
        agent: result.recipient,
      })
      return {
        outcome: 'acked',
        delivered: result,
        reply: createAck(result.wrapper.envelope, handler, outcome.ackAt),
      }
    }
    case 'dropped':
      return {
        outcome: 'dropped',
        delivered: result,
        reply: errorReply(message, outcome.code, outcome.reason),
      }
    case 'expired':
      return {
        outcome: 'expired',
        delivered: result,
        reply: errorReply(message, outcome.code, outcome.reason),
      }
  }
}
