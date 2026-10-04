// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fault-injection MCP server for the P6.3 conformance suite.
 *
 * **This is a test fixture, not one of the two third-party MCP servers the
 * task package delivers.** Those are `@modelcontextprotocol/server-filesystem`
 * and `@modelcontextprotocol/server-memory`, pinned in the root
 * `package.json`. This file exists only because no well-behaved server can be
 * made to fail on demand: the degradation cases (D3 "killed mid-call" and the
 * per-server `request_timeout_ms` case) need a peer that dies or stalls at a
 * moment the test chooses. Everything it does is a fault; nothing about it is
 * evidence that occ can talk to real MCP servers.
 *
 * Tools:
 *  - `ping` — replies `pong`. The liveness probe both before and after a crash.
 *  - `die`  — exits the process without answering, so the caller's in-flight
 *             request must surface as a connection-closed error rather than
 *             hanging until the tool timeout.
 *  - `hang` — never resolves. Only the caller's timeout can end it.
 *
 * Spawned as `<bun> <this file>` by the suite; Bun runs TypeScript directly,
 * so there is no build step to keep in sync.
 */

import {
  type CallToolResult,
  type ListToolsResult,
  Server,
  type Tool,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

/** MCP requires an object-typed input schema even for zero-argument tools. */
const NO_ARGS: Tool['inputSchema'] = { type: 'object', properties: {} }

const TOOLS: Tool[] = [
  { name: 'ping', description: 'Replies with pong.', inputSchema: NO_ARGS },
  {
    name: 'die',
    description: 'Exits the server process without answering the call.',
    inputSchema: NO_ARGS,
  },
  {
    name: 'hang',
    description: 'Never answers the call.',
    inputSchema: NO_ARGS,
  },
]

serveStdio(() => {
  const server = new Server(
    { name: 'qianmo-mcp-crash-fixture', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(
    'tools/list',
    async (): Promise<ListToolsResult> => ({ tools: TOOLS }),
  )

  server.setRequestHandler(
    'tools/call',
    async ({ params: { name } }): Promise<CallToolResult> => {
      switch (name) {
        case 'ping':
          return { content: [{ type: 'text', text: 'pong' }] }
        case 'die':
          // No reply, no clean shutdown: the client sees EOF on a request it
          // is still waiting for. That is the shape a real crashed server has.
          // `process.exit` returns `never`, so nothing falls through to `hang`.
          process.exit(1)
        case 'hang':
          return await new Promise<CallToolResult>(() => {})
        default:
          throw new Error(`Unknown tool: ${name}`)
      }
    },
  )

  return server
})
