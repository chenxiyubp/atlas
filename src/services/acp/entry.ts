import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type { Stream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { AcpAgent } from './agent.js'
import { enableConfigs } from '../../utils/config/config.js'
import { applySafeConfigEnvironmentVariables } from '../../utils/config/managedEnv.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../utils/session/sessionActivity.js'
import {
  registerEmptyModelResponseCallback,
  registerUpstreamStatusCallback,
  unregisterEmptyModelResponseCallback,
  unregisterUpstreamStatusCallback,
} from '../api/upstreamStatus.js'
import { getConnection, isQianmoResident } from './agent/internalAccessors.js'

/**
 * Creates an ACP Stream from a pair of Node.js streams.
 */
export function createAcpStream(
  nodeReadable: NodeJS.ReadableStream,
  nodeWritable: NodeJS.WritableStream,
): Stream {
  const readableFromClient = Readable.toWeb(
    nodeReadable as typeof process.stdin,
  ) as unknown as ReadableStream<Uint8Array>
  const writableToClient = Writable.toWeb(
    nodeWritable as typeof process.stdout,
  ) as unknown as WritableStream<Uint8Array>
  return ndJsonStream(writableToClient, readableFromClient)
}

/**
 * Entry point for the ACP (Agent Client Protocol) agent mode.
 */
export async function runAcpAgent(): Promise<void> {
  enableConfigs()

  // Apply environment variables from settings.json (ANTHROPIC_BASE_URL,
  // ANTHROPIC_AUTH_TOKEN, model overrides, etc.) so the API client can
  // authenticate. Without this, Zed-launched processes won't have these
  // env vars in process.env.
  applySafeConfigEnvironmentVariables()

  const stream = createAcpStream(process.stdin, process.stdout)

  let agent!: AcpAgent
  const connection = new AgentSideConnection(conn => {
    agent = new AcpAgent(conn)
    return agent
  }, stream)

  registerSessionActivityCallback(active => {
    if (!isQianmoResident(agent)) return
    void getConnection(agent)
      .extNotification('qianmo/session-activity', { active })
      .catch(error => {
        console.error('[ACP] Failed to send Qianmo activity update:', error)
      })
  })

  // What the model endpoint said, for the one observer that cannot see it.
  //
  // A resident node's inactivity watchdog runs in the parent process and only
  // knows that this child stopped speaking. A refused credential is answered
  // in tens of milliseconds and then retried quietly by the ladders in
  // services/api, so from out there it is indistinguishable from a slow model
  // — which is exactly how a dead API key came back as "produced no activity
  // for 120000ms" on the beta fleet (issue #37). Forwarding the status closes
  // that gap without the parent ever holding a credential of its own.
  //
  // Resident sessions only: an editor speaking ACP has its own error surface
  // and no use for this, and a notification it did not ask for is noise on a
  // wire it has to parse.
  registerUpstreamStatusCallback(report => {
    if (!isQianmoResident(agent)) return
    void getConnection(agent)
      .extNotification('qianmo/upstream-status', {
        status: report.status,
        ...(report.detail === undefined ? {} : { detail: report.detail }),
      })
      .catch(() => {
        // Best effort by construction: this is the diagnosis channel for a
        // request that is already failing, and logging a failure to report a
        // failure only doubles the noise on a broken link.
      })
  })

  // Every empty model response, retried or given up on, as one line on this
  // process's stderr — which is a resident node's `.err`. All sessions, not
  // only residents: stderr is the log channel here, never the protocol.
  registerEmptyModelResponseCallback(line => {
    console.error(line)
  })

  // stdout is used for ACP messages — redirect console to stderr
  console.log = console.error
  console.info = console.error
  console.warn = console.error
  console.debug = console.error

  async function shutdown(): Promise<void> {
    unregisterSessionActivityCallback()
    unregisterUpstreamStatusCallback()
    unregisterEmptyModelResponseCallback()
    // Clean up all active sessions
    for (const [sessionId] of agent.sessions) {
      try {
        await agent.unstable_closeSession({ sessionId })
      } catch {
        // Best-effort cleanup
      }
    }
    process.exit(0)
  }

  // Exit cleanly when the ACP connection closes
  connection.closed.then(shutdown).catch(shutdown)

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })

  // Keep process alive while connection is open
  process.stdin.resume()
}
