// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The child process `crash-recovery.test.ts` kills.
 *
 * DoD ④ is about what survives `kill -9`, and `kill -9` is not something a
 * mock can express: there is no unwinding, no `finally`, no flush. So the
 * activator really runs in its own process, really writes its journal to a real
 * file, and is really killed mid-forward. This file is that process.
 *
 * Two modes:
 *
 *   `catch`   — take one request in and then hang inside the forward, having
 *               first written a marker so the parent knows exactly which window
 *               it is killing in: after the journal record, before the forward
 *               completes.
 *   `recover` — start up, replay whatever the journal still owes, and print the
 *               report as JSON.
 *
 * Side effects go to files rather than stdout because a `kill -9` takes any
 * buffered stdout with it, and the parent needs to be able to prove that
 * nothing was forwarded — which requires evidence that survives the kill.
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import type { QianmoMessage } from '@qianmo/protocol'
import {
  Activator,
  AuditLog,
  FileRequestJournal,
  HttpSandboxDaemon,
  type ForwardTarget,
  type ReadyProbe,
} from '../../src/index.js'

const [
  mode,
  journalPath,
  daemonUrl,
  forwardLog,
  failureLog,
  markerPath,
  envelopeJson,
] = process.argv.slice(2)

if (
  mode === undefined ||
  journalPath === undefined ||
  daemonUrl === undefined ||
  forwardLog === undefined ||
  failureLog === undefined ||
  markerPath === undefined
) {
  console.error(
    'usage: crash-child.ts <mode> <journal> <daemonUrl> <fwd> <fail> <marker> [env]',
  )
  process.exit(2)
}

const token = process.env.QIANMO_SANDBOX_DAEMON_TOKEN
if (token === undefined || token === '') {
  console.error('QIANMO_SANDBOX_DAEMON_TOKEN is not set')
  process.exit(2)
}

const audit = new AuditLog()
const journal = new FileRequestJournal(journalPath, audit)
const daemon = new HttpSandboxDaemon({
  baseUrl: daemonUrl,
  token: () => token,
  audit,
})

/** Ready as soon as the daemon says the sandbox is running. */
const readyProbe: ReadyProbe = {
  isReady: async sandboxName =>
    (await daemon.status(sandboxName)).state === 'active',
}

/** Appends every forwarded id to a file, so the record outlives the process. */
const recordingForward: ForwardTarget = {
  forward: async (envelope: QianmoMessage) => {
    appendFileSync(forwardLog, `${envelope.msgId}\n`)
    await Promise.resolve()
  },
}

/** Writes the marker, then never returns. The parent kills us here. */
const hangingForward: ForwardTarget = {
  forward: async () => {
    writeFileSync(markerPath, 'forwarding')
    await new Promise<never>(() => {
      // Deliberately never settles.
    })
  },
}

/** Fails every forward, so recovery has to take the explicit-failure path. */
const brokenForward: ForwardTarget = {
  forward: async () => {
    await Promise.resolve()
    throw new Error('peer unreachable during recovery')
  },
}

const forwardMode = process.env.QIANMO_TEST_FORWARD ?? 'record'
const forward =
  mode === 'catch'
    ? hangingForward
    : forwardMode === 'broken'
      ? brokenForward
      : recordingForward

const activator = new Activator({
  daemon,
  readyProbe,
  forward,
  failures: {
    fail: async reply => {
      const payload = reply.payload as { code?: string }
      appendFileSync(failureLog, `${reply.taskId} ${payload.code ?? ''}\n`)
      await Promise.resolve()
    },
  },
  journal,
  audit,
  readyPollIntervalMs: 5,
  readyTimeoutMs: 10_000,
})

if (mode === 'catch') {
  if (envelopeJson === undefined) {
    console.error('catch mode needs an envelope')
    process.exit(2)
  }
  const envelope = JSON.parse(envelopeJson) as QianmoMessage
  // Not awaited: the point is to be killed while this is still in flight.
  void activator.handle({ envelope, sandboxName: 'sandbox-crash' })
  // Keep the process alive until the parent kills it.
  setInterval(() => undefined, 1_000)
} else if (mode === 'recover') {
  const report = await activator.recover()
  process.stdout.write(`${JSON.stringify(report)}\n`)
  journal.close()
  process.exit(0)
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
