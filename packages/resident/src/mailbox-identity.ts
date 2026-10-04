// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ResidentMailboxMessage } from './contracts.js'

export function residentMailboxIdentity(
  message: ResidentMailboxMessage,
): string {
  return JSON.stringify([message.from, message.timestamp, message.text])
}

export function readCountsByIdentity(
  messages: readonly ResidentMailboxMessage[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (!message.read) continue
    const identity = residentMailboxIdentity(message)
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return counts
}

export function messageCountsByIdentity(
  messages: readonly ResidentMailboxMessage[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const identity = residentMailboxIdentity(message)
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return counts
}
