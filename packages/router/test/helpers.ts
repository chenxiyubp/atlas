// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'

export const NODE_A = 'node-a'
export const NODE_B = 'node-b'
export const PLANNER = 'qianmo://node-a/planner'
export const REVIEWER = 'qianmo://node-b/reviewer'
/** A second handler on node A — the legitimate spiral's destination. */
export const ARCHIVIST = 'qianmo://node-a/archivist'

/** One well-formed envelope, with only the fields a router test cares about. */
export function makeMessage(
  overrides: Partial<{
    from: string
    to: string
    type: MessageType
    payload: unknown
    taskId: string
    traceId: string
    createdAt: number
    deliverTtlMs: number
    hops: readonly string[]
  }> = {},
): QianmoMessage {
  return createMessage({
    from: overrides.from ?? PLANNER,
    to: overrides.to ?? REVIEWER,
    type: overrides.type ?? MessageType.TaskRequest,
    payload: overrides.payload ?? { do: 'review' },
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    ...(overrides.traceId === undefined ? {} : { traceId: overrides.traceId }),
    ...(overrides.createdAt === undefined
      ? {}
      : { createdAt: overrides.createdAt }),
    ...(overrides.deliverTtlMs === undefined
      ? {}
      : { deliverTtlMs: overrides.deliverTtlMs }),
    ...(overrides.hops === undefined ? {} : { hops: overrides.hops }),
  })
}
