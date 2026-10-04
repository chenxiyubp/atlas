// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Closing a client while its socket is still mid-handshake must not throw.
 *
 * `close()` and `onClose()` both call `removeAllListeners()` — which takes the
 * `error` handler with it — and then keep touching the socket (`close()`,
 * `terminate()`). On an EventEmitter an `'error'` with no listener is
 * **rethrown**, so a socket that fails while being torn down turned a routine
 * shutdown into an unhandled `ErrorEvent`. Under Bun that surfaced as
 * `error: Unhandled error. (ErrorEvent …)` attributed to whichever test
 * happened to be running, which is why it read as an unrelated flake in the
 * end-to-end suite (roughly two runs in three before the fix; zero in eight
 * after).
 *
 * In production the same path takes the process down, so these cases guard
 * behaviour, not tidiness. There is no assertion on an error object: an
 * unhandled `'error'` fails the test by killing the run, so *reaching the end*
 * is the assertion.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TransportClient } from '../src/index.js'

const TEST_PSK = 'test-psk-not-a-real-secret-0123456789'

function unusedSocketPath(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-shutdown-'))
  return {
    path: join(root, 'nobody-listening.sock'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function clientFor(path: string): TransportClient {
  return new TransportClient({
    endpoint: { unix: path },
    node: 'node-a',
    psk: TEST_PSK,
    backoff: {
      baseDelayMs: 5,
      maxDelayMs: 20,
      jitterRatio: 0,
      giveUpAfterMs: 200,
    },
    keepAliveIntervalMs: 0,
  })
}

describe('closing a client that never finished dialling', () => {
  test('close() during an in-flight dial does not raise an unhandled error', async () => {
    const socket = unusedSocketPath()
    try {
      const client = clientFor(socket.path)
      // Deliberately not awaited: close() lands while the dial is still in
      // flight, which is the window removeAllListeners() opened.
      // 200 ms, not the 30 s default: this test is about teardown, and
      // awaiting the default would outlive the harness budget.
      const dialing = client.connect(200).catch(() => undefined)
      await client.close()
      await dialing
      // Give the socket a tick to emit anything it still owes.
      await Bun.sleep(50)
      expect(true).toBe(true)
    } finally {
      socket.cleanup()
    }
  })

  test('a dial that fails on its own does not raise one either', async () => {
    const socket = unusedSocketPath()
    try {
      const client = clientFor(socket.path)
      await client.connect(200).catch(() => undefined)
      // The retry budget expires against a socket nobody is listening on; every
      // attempt fails, and each failure runs the same teardown path.
      await Bun.sleep(300)
      await client.close()
      expect(true).toBe(true)
    } finally {
      socket.cleanup()
    }
  })

  test('close() is idempotent and stays quiet on the second call', async () => {
    const socket = unusedSocketPath()
    try {
      const client = clientFor(socket.path)
      await client.connect(200).catch(() => undefined)
      await client.close()
      await client.close()
      await Bun.sleep(50)
      expect(true).toBe(true)
    } finally {
      socket.cleanup()
    }
  })
})
