// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { ResidentActivityReporter } from '@qianmo/resident/activity'
import { AuditLog } from '../src/audit.js'
import {
  ResidentActivityController,
  startResidentActivityServer,
} from '../src/activity.js'
import { KeepaliveLoop } from '../src/keepalive.js'
import type { KeepalivePort } from '../src/keepalive.js'
import { ManualScheduler } from './helpers.js'
import type { TransportServerHandle } from '@qianmo/transport'

const PSK = 'activity-test-not-a-real-secret-0000'

function makeSocketPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-activity-'))
  return {
    path: join(dir, 'activity.sock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
const servers: TransportServerHandle[] = []
const reporters: ResidentActivityReporter[] = []
const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const reporter of reporters.splice(0)) await reporter.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('resident activity keepalive bridge', () => {
  test('busy starts host keepalive and idle stops it', async () => {
    let acquireCalls = 0
    const daemon: KeepalivePort = {
      acquire: async sandboxName => {
        acquireCalls += 1
        return { sandboxName, state: 'active' }
      },
    }
    // Timers fire only when this test says so. With the real scheduler the
    // zero-delay beat that `start()` schedules races the socket round trip and
    // the explicit beat below, so the acquire count depended on the runner.
    const scheduler = new ManualScheduler()
    const loop = new KeepaliveLoop({
      sandboxName: 'sandbox-node-b',
      daemon,
      policy: { freezeAfterSeconds: 60, stopAfterSeconds: 600 },
      audit: new AuditLog(),
      scheduler,
    })
    const controller = new ResidentActivityController(loop)
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)
    servers.push(
      startResidentActivityServer({
        node: 'node-b',
        psk: PSK,
        listen: { unix: socket.path },
        controller,
      }),
    )
    const reporter = new ResidentActivityReporter({
      node: 'node-b',
      endpoint: { unix: socket.path },
      psk: PSK,
    })
    reporters.push(reporter)
    await reporter.connect()

    await reporter.report(true)
    expect(controller.active).toBe(true)
    expect(loop.running).toBe(true)
    // Busy starts the loop, which schedules an immediate beat.
    expect(scheduler.delays).toEqual([0])
    await loop.beat()
    expect(acquireCalls).toBe(1)

    await reporter.report(false)
    expect(controller.active).toBe(false)
    expect(loop.running).toBe(false)
    // Idle stops it: the pending beat is cancelled, not left to fire.
    expect(scheduler.size).toBe(0)

    await reporter.report(true)
    expect(loop.running).toBe(true)
    expect(scheduler.delays).toEqual([0])
    await reporter.close()
    reporters.splice(reporters.indexOf(reporter), 1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.active).toBe(false)
    expect(loop.running).toBe(false)
  })

  test('closing an old connection does not override a newer busy connection', async () => {
    const loop = new KeepaliveLoop({
      sandboxName: 'sandbox-node-b',
      daemon: {
        acquire: async sandboxName => ({ sandboxName, state: 'active' }),
      },
      policy: { freezeAfterSeconds: 60, stopAfterSeconds: 600 },
      audit: new AuditLog(),
    })
    const controller = new ResidentActivityController(loop)
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)
    servers.push(
      startResidentActivityServer({
        node: 'node-b',
        psk: PSK,
        listen: { unix: socket.path },
        controller,
      }),
    )
    const oldReporter = new ResidentActivityReporter({
      node: 'node-b',
      endpoint: { unix: socket.path },
      psk: PSK,
    })
    const newReporter = new ResidentActivityReporter({
      node: 'node-b',
      endpoint: { unix: socket.path },
      psk: PSK,
    })
    reporters.push(oldReporter, newReporter)
    await oldReporter.connect()
    await newReporter.connect()
    await newReporter.report(true)

    await oldReporter.close()
    reporters.splice(reporters.indexOf(oldReporter), 1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.active).toBe(true)
    expect(loop.running).toBe(true)

    await newReporter.close()
    reporters.splice(reporters.indexOf(newReporter), 1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.active).toBe(false)
    expect(loop.running).toBe(false)
  })

  test('a different authenticated node cannot control the target keepalive', async () => {
    const loop = new KeepaliveLoop({
      sandboxName: 'sandbox-node-b',
      daemon: {
        acquire: async sandboxName => ({ sandboxName, state: 'active' }),
      },
      policy: { freezeAfterSeconds: 60, stopAfterSeconds: 600 },
      audit: new AuditLog(),
    })
    const controller = new ResidentActivityController(loop)
    const socket = makeSocketPath()
    cleanups.push(socket.cleanup)
    servers.push(
      startResidentActivityServer({
        node: 'node-b',
        psk: PSK,
        listen: { unix: socket.path },
        controller,
      }),
    )
    const reporter = new ResidentActivityReporter({
      node: 'node-a',
      endpoint: { unix: socket.path },
      psk: PSK,
    })
    reporters.push(reporter)
    await reporter.connect()

    await expect(reporter.report(true)).rejects.toThrow()
    expect(controller.active).toBe(false)
    expect(loop.running).toBe(false)
  })
})
