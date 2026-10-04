// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { findLatestMessage } from '../logAssembly.js'

describe('findLatestMessage tie-breaking', () => {
  // transcriptWriter stamps `timestamp` after the `...message` spread, so every
  // entry from one recordTranscript call shares a millisecond. The anchor must
  // land on the LAST of a tied run, or every message after it falls off the
  // rebuilt chain — silent tail loss on --resume, accumulating on every wake.
  test('ties resolve to the last entry in iteration order', () => {
    const t = '2026-08-12T00:00:00.000Z'
    const msgs = [
      { uuid: 'a', timestamp: t },
      { uuid: 'b', timestamp: t },
      { uuid: 'c', timestamp: t },
    ]
    expect(findLatestMessage(msgs, () => true)?.uuid).toBe('c')
  })

  test('a strictly newer entry still wins regardless of position', () => {
    const msgs = [
      { uuid: 'old', timestamp: '2026-08-12T00:00:00.000Z' },
      { uuid: 'new', timestamp: '2026-08-12T00:00:01.000Z' },
      { uuid: 'old2', timestamp: '2026-08-12T00:00:00.000Z' },
    ]
    expect(findLatestMessage(msgs, () => true)?.uuid).toBe('new')
  })

  test('predicate still filters', () => {
    const t = '2026-08-12T00:00:00.000Z'
    const msgs = [
      { uuid: 'keep', timestamp: t },
      { uuid: 'skip', timestamp: t },
    ]
    expect(findLatestMessage(msgs, m => m.uuid !== 'skip')?.uuid).toBe('keep')
  })
})
