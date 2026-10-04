// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A throwing event sink must not be able to kill the transport.
 *
 * `EventRecorder.record` runs inside Bun's websocket `open`/`close` handlers,
 * so an exception there does not merely lose one record — it propagates out of
 * the handler and takes the listener down. Found exactly that way: a
 * cross-machine probe passed `{record: fn}` where a function was expected, and
 * the first inbound connection killed the server on the far host.
 *
 * Observability is the least important thing in the process and must never be
 * able to stop the most important one.
 */

import { describe, expect, test } from 'bun:test'
import { EventRecorder, TransportEventType } from '../src/events.js'

const at = 1_800_000_000_000

function event(type: TransportEventType) {
  return { type, at, detail: {} }
}

describe('a sink that throws', () => {
  test('does not escape record()', () => {
    const recorder = new EventRecorder(16, () => {
      throw new Error('sink is broken')
    })
    expect(() =>
      recorder.record(event(TransportEventType.ConnectionOpened)),
    ).not.toThrow()
  })

  test('leaves the original record in place and adds a sink_failed beside it', () => {
    const recorder = new EventRecorder(16, () => {
      throw new TypeError('not a function')
    })
    recorder.record(event(TransportEventType.AuthAccepted))

    const types = recorder.all().map(e => e.type)
    expect(types).toEqual([
      TransportEventType.AuthAccepted,
      TransportEventType.SinkFailed,
    ])
    const failure = recorder.all()[1]
    expect(failure?.detail.of).toBe(TransportEventType.AuthAccepted)
    expect(failure?.detail.reason).toBe('TypeError')
  })

  test('keeps recording after the sink has failed once', () => {
    let calls = 0
    const recorder = new EventRecorder(16, () => {
      calls += 1
      throw new Error('always')
    })
    recorder.record(event(TransportEventType.ConnectionOpened))
    recorder.record(event(TransportEventType.MessageAccepted))
    expect(calls).toBe(2)
    expect(
      recorder.all().filter(e => e.type === TransportEventType.SinkFailed),
    ).toHaveLength(2)
  })

  test('a healthy sink still sees every event', () => {
    const seen: TransportEventType[] = []
    const recorder = new EventRecorder(16, e => seen.push(e.type))
    recorder.record(event(TransportEventType.ConnectionOpened))
    recorder.record(event(TransportEventType.ConnectionClosed))
    expect(seen).toEqual([
      TransportEventType.ConnectionOpened,
      TransportEventType.ConnectionClosed,
    ])
    expect(
      recorder.all().some(e => e.type === TransportEventType.SinkFailed),
    ).toBe(false)
  })
})
