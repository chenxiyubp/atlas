// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'

/**
 * A fixed, obviously-fake secret. Long enough to clear `PSK_MIN_LENGTH`;
 * short of anything anyone could mistake for a real key.
 */
export const TEST_PSK = 'test-psk-not-a-real-secret-0000'

/** A second one, for "the peer holds a different key" cases. */
export const WRONG_PSK = 'test-psk-not-a-real-secret-9999'

export const SENDER = 'qianmo://node-a/planner'
export const RECIPIENT = 'qianmo://node-b/reviewer'

/** One well-formed envelope. Overrides let a test pin ids or deadlines. */
export function makeMessage(
  overrides: Partial<{
    payload: unknown
    taskId: string
    msgId: string
    createdAt: number
    deliverTtlMs: number
  }> = {},
): QianmoMessage {
  return createMessage({
    from: SENDER,
    to: RECIPIENT,
    type: MessageType.TaskRequest,
    payload: overrides.payload ?? { do: 'review' },
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    ...(overrides.msgId === undefined ? {} : { msgId: overrides.msgId }),
    ...(overrides.createdAt === undefined
      ? {}
      : { createdAt: overrides.createdAt }),
    ...(overrides.deliverTtlMs === undefined
      ? {}
      : { deliverTtlMs: overrides.deliverTtlMs }),
  })
}

/**
 * A throwaway directory plus a unix socket path inside it.
 *
 * Single-machine integration runs over a unix socket by roadmap P2.2's own
 * test rule: two TCP servers can bind the same port without either erroring
 * and Linux then splits traffic between them non-deterministically. A socket
 * path in a private directory cannot collide with anything.
 */
export function makeSocketPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-transport-'))
  return {
    path: join(dir, 'hop.sock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Await `ms` of wall clock. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll `predicate` until it holds or `timeoutMs` runs out. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(stepMs)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}
