// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P11.4 —— 审计见证端点的长驻入口。
 *
 *   bun run demo/lib/witness-endpoint.ts --store <绝对路径> \
 *     --write-token-file <绝对路径> --read-token-file <绝对路径> \
 *     --key <节点>=<公钥> [--key …] [--host 127.0.0.1] [--port 38640] [--ready <绝对路径>]
 *
 * 规矩与理由见 `witness-endpoint-core.ts`；由 `demo/env/beta/ops/witness-endpoint.sh`
 * 经 `demo_entry` 调起（投出去的树上走 `dist/demo/witness-endpoint.js`）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  parseWitnessEndpointArgs,
  startWitnessEndpoint,
} from './witness-endpoint-core.js'

const config = parseWitnessEndpointArgs(process.argv.slice(2))
const service = startWitnessEndpoint(config)
const nodes = config.keys.map(([node]) => node).join(',')
process.stdout.write(
  `[witness-endpoint] listening ${service.url} store=${config.store} nodes=${nodes}\n`,
)
if (config.ready !== undefined) {
  mkdirSync(dirname(config.ready), { recursive: true })
  writeFileSync(
    config.ready,
    `${JSON.stringify({ url: service.url, pid: process.pid, nodes: config.keys.map(([node]) => node) })}\n`,
  )
}

const shutdown = (): void => {
  void service.stop().then(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
