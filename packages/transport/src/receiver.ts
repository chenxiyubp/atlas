// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ProtocolErrorCode,
  firstErrorCode,
  validateMessage,
} from '@qianmo/protocol'
import type { InboundContext, InboundHandler } from './channel.js'
import { DedupTable, DedupVerdict } from './dedup.js'
import {
  TransportEventType,
  type EventDetail,
  type EventRecorder,
} from './events.js'
import {
  FRAME_VERSION,
  FrameType,
  ReceiptStatus,
  type ReceiptFrame,
} from './frames.js'

const MAX_ECHOED_ID_LENGTH = 64

function claimedMsgId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || !('msgId' in raw)) return ''
  const value: unknown = raw.msgId
  return typeof value === 'string' ? value.slice(0, MAX_ECHOED_ID_LENGTH) : ''
}

function receipt(
  msgId: string,
  status: ReceiptStatus,
  code?: ProtocolErrorCode,
  reason?: string,
): ReceiptFrame {
  return {
    t: FrameType.Receipt,
    v: FRAME_VERSION,
    msgId,
    status,
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason }),
  }
}

interface EnvelopeReceiverOptions {
  readonly onMessage?: InboundHandler
  readonly dedup: DedupTable
  readonly recorder: EventRecorder
  readonly now: () => number
  readonly deadlineNow: (createdAt: number) => number
}

/** Validate, deduplicate and dispatch one untrusted envelope in either direction. */
export async function receiveEnvelope(
  raw: unknown,
  context: InboundContext,
  options: EnvelopeReceiverOptions,
): Promise<ReceiptFrame> {
  const record = (type: TransportEventType, detail: EventDetail): void => {
    options.recorder.record({ type, at: options.now(), detail })
  }
  const createdAt =
    typeof raw === 'object' && raw !== null && 'createdAt' in raw
      ? (raw as { createdAt?: unknown }).createdAt
      : undefined
  const validation = validateMessage(raw, {
    now:
      typeof createdAt === 'number'
        ? options.deadlineNow(createdAt)
        : options.deadlineNow(0),
  })
  if (!validation.ok) {
    const code = firstErrorCode(validation) ?? ProtocolErrorCode.E_BAD_ENVELOPE
    record(TransportEventType.MessageRejected, {
      node: context.peerNode ?? '',
      code,
    })
    return receipt(
      claimedMsgId(raw),
      ReceiptStatus.Rejected,
      code,
      'invalid envelope',
    )
  }

  const message = validation.message
  const verdict = options.dedup.admit(message)
  if (verdict !== DedupVerdict.Fresh) {
    record(TransportEventType.MessageDuplicate, {
      node: context.peerNode ?? '',
      msgId: message.msgId,
      // Carried so an audit trail can join this line onto the chain it belongs
      // to: a dedup hit that cannot be correlated is a dedup hit nobody can
      // explain to the sender who saw two receipts (P7.2).
      traceId: message.traceId,
      level: verdict,
    })
    return receipt(message.msgId, ReceiptStatus.Duplicate)
  }

  try {
    if (options.onMessage === undefined) {
      throw new Error('transport endpoint has no inbound envelope handler')
    }
    await options.onMessage(message, context)
  } catch (error) {
    options.dedup.forget(message)
    record(TransportEventType.MessageRejected, {
      node: context.peerNode ?? '',
      msgId: message.msgId,
      traceId: message.traceId,
      code: ProtocolErrorCode.E_UNDELIVERABLE,
      reason: error instanceof Error ? error.name : 'unknown',
    })
    return receipt(
      message.msgId,
      ReceiptStatus.Rejected,
      ProtocolErrorCode.E_UNDELIVERABLE,
      'handler failed',
    )
  }

  record(TransportEventType.MessageAccepted, {
    node: context.peerNode ?? '',
    msgId: message.msgId,
    traceId: message.traceId,
    taskId: message.taskId,
  })
  return receipt(message.msgId, ReceiptStatus.Accepted)
}
