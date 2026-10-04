// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type { QianmoMessage } from '@qianmo/protocol'
import { EnvelopeOutbox } from '../src/outbox.js'
import { makeMessage } from './helpers.js'

function outbox(options: { canWrite?: boolean } = {}): {
  readonly outbox: EnvelopeOutbox
  readonly written: QianmoMessage[]
} {
  const written: QianmoMessage[] = []
  return {
    written,
    outbox: new EnvelopeOutbox({
      canWrite: () => options.canWrite ?? true,
      isClosed: () => false,
      write: message => {
        written.push(message)
      },
    }),
  }
}

describe('EnvelopeOutbox close', () => {
  test('a caller waiting for drain is told why it will never drain', async () => {
    const { outbox: queue } = outbox()
    queue.send(makeMessage())
    const draining = queue.waitForDrain(5_000)
    const reason = new Error('transport server closed before receipt')

    queue.close(reason)

    // Without this the caller waits out its own timeout and is then told
    // "did not drain" — the symptom, with the cause thrown away.
    await expect(draining).rejects.toThrow(
      'transport server closed before receipt',
    )
  })

  test('a closed outbox stops reporting a queue that can no longer move', () => {
    const { outbox: queue } = outbox()
    queue.send(makeMessage())
    expect(queue.pending).toBe(1)

    queue.close(new Error('channel reclaimed'))

    expect(queue.pending).toBe(0)
  })
})
