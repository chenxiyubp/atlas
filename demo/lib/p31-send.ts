// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatAddress } from '@qianmo/protocol'
import { executeResidentWake } from '../../src/cli/handlers/residentWake.js'
import { arg, emit, intArg } from './cli-args.js'
import { activatorUrl, psk, targetAddress } from './ac2-env.js'

const round = intArg('round', 1)
const timeoutMs = intArg('timeout-ms', 90_000)
const prompt =
  arg('prompt') ?? `P3.1 wake benchmark round ${round}. Reply with OK.`
const startedAt = Date.now()

try {
  const result = await executeResidentWake(
    {
      url: activatorUrl(),
      from: formatAddress({
        node: arg('from-node') ?? 'node-a',
        agent: arg('from-agent') ?? 'operator',
      }),
      to: targetAddress(),
      prompt,
      afterMs: 0,
      timeoutMs,
      deliverTtlMs: intArg('deliver-ttl-ms', timeoutMs),
    },
    psk(),
  )
  emit({
    round,
    verdict: 'accepted',
    wallMs: Date.now() - startedAt,
    ...result,
  })
} catch (error) {
  emit({
    round,
    verdict: 'failed',
    wallMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
}
