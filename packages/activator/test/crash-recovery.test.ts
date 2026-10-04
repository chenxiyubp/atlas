// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DoD ④: `kill -9` mid-forward, then restart.
 *
 * The criterion is not "the process comes back" — a supervisor gives you that
 * for free. It is that a request the activator had already taken in ends up
 * **forwarded or explicitly failed, and never silently dropped**. So the test
 * has to kill in the one window where a drop is possible: after the request was
 * accepted, before it was forwarded. The child writes a marker from inside the
 * forward and then hangs, which is precisely that window.
 *
 * Everything here is real: a real child process, a real SIGKILL with no
 * unwinding and no flush, a real journal file on disk, and a real local HTTP
 * server standing in for the daemon. What is *not* real is the daemon — see
 * `stub-daemon.ts`. This file is evidence about crash recovery, not about the
 * sandbox supervisor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from '../src/audit.js'
import { FileRequestJournal } from '../src/journal.js'
import { makeMessage } from './helpers.js'
import { STUB_TOKEN, type StubDaemon, startStubDaemon } from './stub-daemon.js'

const CHILD = join(import.meta.dir, 'fixtures', 'crash-child.ts')

let directory: string
let stub: StubDaemon
let paths: {
  journal: string
  forwardLog: string
  failureLog: string
  marker: string
}
const children: { kill(signal?: number): void; exited: Promise<number> }[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-activator-crash-'))
  paths = {
    journal: join(directory, 'inflight.ndjson'),
    forwardLog: join(directory, 'forwarded.log'),
    failureLog: join(directory, 'failed.log'),
    marker: join(directory, 'forwarding.marker'),
  }
  writeFileSync(paths.forwardLog, '')
  writeFileSync(paths.failureLog, '')
  // The sandbox is already running: this test is about *our* crash, not about
  // waking anything.
  stub = startStubDaemon({
    initialState: 'active',
    sandboxes: ['sandbox-crash'],
  })
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill(9)
    await child.exited
  }
  await stub.stop()
  rmSync(directory, { recursive: true, force: true })
})

function spawnChild(
  mode: 'catch' | 'recover',
  envelopeJson?: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      CHILD,
      mode,
      paths.journal,
      stub.url,
      paths.forwardLog,
      paths.failureLog,
      paths.marker,
      ...(envelopeJson === undefined ? [] : [envelopeJson]),
    ],
    env: {
      ...process.env,
      // Injected, never stored: the child reads it from the environment only.
      QIANMO_SANDBOX_DAEMON_TOKEN: STUB_TOKEN,
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.push(child)
  return child
}

/** Read a piped child's stdout to the end. */
async function readStdout(
  child: ReturnType<typeof Bun.spawn>,
): Promise<string> {
  const stream = child.stdout
  if (!(stream instanceof ReadableStream)) {
    throw new Error('child stdout was not piped')
  }
  return await new Response(stream).text()
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`${path} never appeared within ${timeoutMs}ms`)
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

/** Take one request in, then die inside the forward. */
async function crashMidForward(msgId: string): Promise<void> {
  // A marker left by an earlier crash would satisfy the wait instantly and get
  // the next child killed *before* it accepted anything — which would make the
  // test pass by testing nothing.
  rmSync(paths.marker, { force: true })
  const envelope = makeMessage({
    msgId,
    taskId: msgId,
    deliverTtlMs: 600_000,
  })
  const child = spawnChild('catch', JSON.stringify(envelope))
  await waitForFile(paths.marker)
  child.kill(9)
  await child.exited
}

describe('a request caught before a SIGKILL is not lost', () => {
  test('the journal holds it, and nothing was forwarded', async () => {
    await crashMidForward('msg-crash-1')

    expect(lines(paths.forwardLog)).toEqual([])
    expect(lines(paths.failureLog)).toEqual([])

    const journal = new FileRequestJournal(paths.journal, new AuditLog())
    const pending = journal.pending()
    journal.close()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.envelope.msgId).toBe('msg-crash-1')
  })

  test('restarting forwards it, and the journal comes out clean', async () => {
    await crashMidForward('msg-crash-2')

    const recovery = spawnChild('recover')
    const stdout = await readStdout(recovery)
    const code = await recovery.exited
    expect(code).toBe(0)

    const report = JSON.parse(stdout.trim()) as {
      replayed: number
      forwarded: number
      failed: number
    }
    expect(report).toEqual({ replayed: 1, forwarded: 1, failed: 0 })
    expect(lines(paths.forwardLog)).toEqual(['msg-crash-2'])

    const journal = new FileRequestJournal(paths.journal, new AuditLog())
    const pending = journal.pending()
    journal.close()
    expect(pending).toEqual([])
  })

  test('when the replay cannot forward either, the sender is told explicitly', async () => {
    // The other half of "forwarded or explicitly failed": a recovery that
    // cannot deliver must not answer with silence either.
    await crashMidForward('msg-crash-3')

    const recovery = spawnChild('recover', undefined, {
      QIANMO_TEST_FORWARD: 'broken',
    })
    const stdout = await readStdout(recovery)
    expect(await recovery.exited).toBe(0)

    const report = JSON.parse(stdout.trim()) as {
      replayed: number
      failed: number
    }
    expect(report.replayed).toBe(1)
    expect(report.failed).toBe(1)

    expect(lines(paths.forwardLog)).toEqual([])
    expect(lines(paths.failureLog)).toEqual(['msg-crash-3 E_UNDELIVERABLE'])

    const journal = new FileRequestJournal(paths.journal, new AuditLog())
    const pending = journal.pending()
    journal.close()
    expect(pending).toEqual([])
  })

  test('every accepted request reached exactly one terminal state', async () => {
    // The property, stated directly: accepted == forwarded + failed, with no
    // remainder. A remainder is what "silently dropped" looks like on disk.
    await crashMidForward('msg-crash-4')

    const recovery = spawnChild('recover')
    await readStdout(recovery)
    await recovery.exited

    const forwarded = lines(paths.forwardLog)
    const failed = lines(paths.failureLog)
    const journal = new FileRequestJournal(paths.journal, new AuditLog())
    const stillOwed = journal.pending()
    journal.close()

    expect(forwarded.length + failed.length).toBe(1)
    expect(stillOwed).toEqual([])
  })

  test('a second crash and a second restart behave the same', async () => {
    // Recovery must be re-entrant: crashing during recovery is the ordinary
    // case for a component whose job is to be restarted.
    await crashMidForward('msg-crash-5a')
    await crashMidForward('msg-crash-5b')

    const journal = new FileRequestJournal(paths.journal, new AuditLog())
    expect(journal.pending()).toHaveLength(2)
    journal.close()

    const recovery = spawnChild('recover')
    const stdout = await readStdout(recovery)
    await recovery.exited
    expect(JSON.parse(stdout.trim())).toEqual({
      replayed: 2,
      forwarded: 2,
      failed: 0,
    })
    expect(lines(paths.forwardLog).sort()).toEqual([
      'msg-crash-5a',
      'msg-crash-5b',
    ])

    const after = new FileRequestJournal(paths.journal, new AuditLog())
    expect(after.pending()).toEqual([])
    after.close()
  })

  test('a restart with nothing owed is a no-op', async () => {
    const recovery = spawnChild('recover')
    const stdout = await readStdout(recovery)
    expect(await recovery.exited).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({
      replayed: 0,
      forwarded: 0,
      failed: 0,
    })
  })

  test('the killed process never reached a destructive call either', () => {
    // A crash is not an excuse: the surface is the same on the way down.
    expect(stub.hits.destroySandbox).toBe(0)
  })
})
