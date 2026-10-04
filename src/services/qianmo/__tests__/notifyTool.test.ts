// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E4: an unattended turn must not be able to create more unattended turns.
 *
 * The structural half of that lives in what the resident hands an ACP session,
 * so this file asserts that list. Two halves, and both are needed: the exact
 * surface (one tool, named), and a decoy proving the pattern that recognizes a
 * scheduling capability can actually see one — a rule that only knows the
 * words we thought of today would wave through `qianmo_watch_every_hour`.
 */

import { describe, expect, test } from 'bun:test'
import { NOTIFY_KINDS, NOTIFY_SEVERITIES } from '@qianmo/protocol'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import { QIANMO_NOTIFY_TOOL_NAME, residentToolSurface } from '../notifyTool.js'
import type { QianmoNotifyRequest, QianmoNotifyVerdict } from '../notifyWire.js'

/**
 * What a scheduling capability looks like, whatever it gets called.
 *
 * Names AND the intent behind them: "every N minutes" is a schedule even when
 * the word schedule does not appear, which is exactly the tool a well-meaning
 * future batch would add without noticing it had reopened E4.
 */
const SCHEDULING_SHAPES: readonly RegExp[] = [
  // Boundaries are "not a letter" rather than `\b`: a tool name is
  // `qianmo_schedule_job`, and `_` is a word character, so `\b` would find no
  // boundary at all and the rule would silently match nothing.
  /(^|[^a-z])(schedule|scheduler|cron|reserve|reservation)([^a-z]|$)/i,
  /(^|[^a-z])jobs?([^a-z]|$)/i,
  /(^|[^a-z])(timer|interval|recurring)([^a-z]|$)/i,
  /every[\s_-]*\d*[\s_-]*(minute|hour|day|week)/i,
]

function bridgeReturning(verdict: QianmoNotifyVerdict) {
  const seen: QianmoNotifyRequest[] = []
  return {
    seen,
    bridge: {
      sessionId: 'session-7',
      announce: async (request: QianmoNotifyRequest) => {
        seen.push(request)
        return verdict
      },
    },
  }
}

const NOOP_CONTEXT = {} as unknown as Parameters<
  ReturnType<typeof residentToolSurface>[number]['call']
>[1]
const NOOP_CAN_USE = (async () => ({})) as unknown as Parameters<
  ReturnType<typeof residentToolSurface>[number]['call']
>[2]
const NOOP_PARENT = undefined as unknown as Parameters<
  ReturnType<typeof residentToolSurface>[number]['call']
>[3]

describe('the tool surface injected into a resident ACP session', () => {
  test('is exactly one tool, and it is qianmo_notify', () => {
    const { bridge } = bridgeReturning({ status: 'sent' })
    const surface = residentToolSurface(bridge)

    expect(surface.map(tool => tool.name)).toEqual([QIANMO_NOTIFY_TOOL_NAME])
    expect(QIANMO_NOTIFY_TOOL_NAME).toBe('qianmo_notify')
  })

  test('carries no scheduling capability, by name or by description', async () => {
    // Positive control first: the rule has to be able to fail.
    const bait = ['qianmo_schedule_job', 'run this every 15 minutes', 'cron']
    for (const sample of bait) {
      expect(SCHEDULING_SHAPES.some(shape => shape.test(sample))).toBe(true)
    }

    const { bridge } = bridgeReturning({ status: 'sent' })
    for (const tool of residentToolSurface(bridge)) {
      expect(SCHEDULING_SHAPES.some(shape => shape.test(tool.name))).toBe(false)
      const description = await tool.description(
        {
          kind: 'watch',
          severity: 'info',
          summary: 'x',
        },
        {
          isNonInteractiveSession: true,
          toolPermissionContext: getEmptyToolPermissionContext(),
          tools: [],
        },
      )
      expect(SCHEDULING_SHAPES.some(shape => shape.test(description))).toBe(
        false,
      )
    }
  })

  test('the qianmo_ prefix rule holds for everything on the surface (E8)', () => {
    const { bridge } = bridgeReturning({ status: 'sent' })
    for (const tool of residentToolSurface(bridge)) {
      expect(tool.name.startsWith('qianmo_')).toBe(true)
    }
  })

  test('the kinds and severities it offers come from the protocol', () => {
    const { bridge } = bridgeReturning({ status: 'sent' })
    const tool = residentToolSurface(bridge)[0]
    const schema = tool?.inputSchema as unknown as {
      shape: Record<string, { options?: readonly string[] }>
    }
    // Not a second spelling of the closed sets: if the protocol adds a kind,
    // this tool offers it without anyone editing it.
    expect(schema.shape.kind?.options).toEqual([...NOTIFY_KINDS])
    expect(schema.shape.severity?.options).toEqual([...NOTIFY_SEVERITIES])
  })
})

describe('what the tool does with the host verdict', () => {
  test('it names its own session, so the host can attribute the turn', async () => {
    const { bridge, seen } = bridgeReturning({ status: 'sent' })
    const tool = residentToolSurface(bridge)[0]

    await tool?.call(
      {
        kind: 'watch',
        severity: 'error',
        summary: 'the queue stopped draining',
        detail: 'depth 32 for 10 minutes',
        dedupKey: 'queue:stalled',
      },
      NOOP_CONTEXT,
      NOOP_CAN_USE,
      NOOP_PARENT,
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBe('session-7')
    expect(seen[0]?.summary).toBe('the queue stopped draining')
    expect(seen[0]?.dedupKey).toBe('queue:stalled')
    // The agent supplies no address and no peer — the host derives both.
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      'dedupKey',
      'detail',
      'kind',
      'sessionId',
      'severity',
      'summary',
    ])
  })

  test('a held notification reads as held, not as delivered', async () => {
    const { bridge } = bridgeReturning({
      status: 'queued',
      retryAfterMs: 4_000,
    })
    const tool = residentToolSurface(bridge)[0]

    const result = await tool?.call(
      { kind: 'health', severity: 'warn', summary: 'noisy' },
      NOOP_CONTEXT,
      NOOP_CAN_USE,
      NOOP_PARENT,
    )
    const block = tool?.mapToolResultToToolResultBlockParam(
      result?.data,
      'use-1',
    ) as { content: string }

    // The model has to be able to tell "it went" from "it is waiting", or the
    // sensible reaction to a closed window (say it once, stop) is unavailable
    // to it.
    expect(block.content).toContain('held')
    expect(block.content).not.toContain('sent to the operator')
    expect(block.content).toContain('Do not send it again')
  })

  test('an unsupported peer tells the agent to put it in the answer instead', async () => {
    const { bridge } = bridgeReturning({ status: 'unsupported' })
    const tool = residentToolSurface(bridge)[0]

    const result = await tool?.call(
      { kind: 'task', severity: 'info', summary: 'done' },
      NOOP_CONTEXT,
      NOOP_CAN_USE,
      NOOP_PARENT,
    )
    const block = tool?.mapToolResultToToolResultBlockParam(
      result?.data,
      'use-1',
    ) as { content: string }

    expect(block.content).toContain('Not sent')
    expect(block.content).toContain('answer')
  })
})
