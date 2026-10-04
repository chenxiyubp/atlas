// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The C_tool ask snapshot (design `authorization-m1.md` §1.1, P14.2).
 *
 * One real `--acp` child in the carried posture — `acceptEdits`, the shipped
 * environment (safe mode on), empty rules, no hooks — runs every call in
 * `fixtures/resident-ask-corpus.ts` against a host that refuses everything,
 * and records what became of each call:
 *
 *   host      the call reached `requestPermission`: it is in C_tool;
 *   allowed   it ran without the host being asked;
 *   refused   the child turned it down on its own (hardline, not offered);
 *   invalid   it failed its own input check before any permission step.
 *
 * The result is compared with the file pinned for this platform under
 * `fixtures/resident-ask-snapshot/`. **Any difference is red**: this is where
 * an upstream sync that changes what the base asks about shows up, and where a
 * new tool on the resident surface has to be looked at before it ships.
 * Platform-split because the base's answer is (PowerShell exists only on
 * Windows, the sandbox only on Linux); Linux is the CI platform and must always
 * have a file.
 *
 * To re-pin after an intended change, run this file with
 * `QIANMO_ASK_SNAPSHOT=write` and review the diff like any other change to
 * the permission surface.
 *
 * The same run answers the ordering question the host's future grant lookup
 * rests on (§3.2, F-21): a permission request carries no tool name, the
 * `tool_call` update that precedes it does.
 *
 * Only the model and the host are scripted; nothing is mocked. Egress from the
 * child is pointed at a dead loopback proxy, so a call the node lets through
 * cannot reach the internet.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTHZ_LEDGER_FILE } from '@qianmo/resident'
import {
  type HostEvent,
  ResidentAcpHarness,
  type ScenarioResult,
} from './fixtures/resident-acp-harness.js'
import {
  ASK_CORPUS,
  type AskProbe,
  type ProbeContext,
  plantAskFixture,
} from './fixtures/resident-ask-corpus.js'

const TEST_TIMEOUT_MS = 300_000

const SNAPSHOT_DIR = join(import.meta.dir, 'fixtures', 'resident-ask-snapshot')
/** The CI runner's platform; its file must exist whatever machine runs this. */
const CI_PLATFORM = 'linux'

/**
 * The 22 tools the review saw a resident model offered (F-26). Two of them
 * are gone since P14.0; the corpus still has to show what calling them does.
 */
const REVIEW_F26_TOOLS = [
  'Agent',
  'TaskOutput',
  'Bash',
  'Glob',
  'Grep',
  'ExitPlanMode',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'TodoWrite',
  'WebSearch',
  'TaskStop',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'SendMessage',
  'Workflow',
  'SearchExtraTools',
  'ExecuteExtraTool',
  'qianmo_notify',
] as const

/** A dead loopback proxy: whatever tries to leave gets ECONNREFUSED. */
const OFFLINE_ENV = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
}

type Verdict = 'host' | 'allowed' | 'refused' | 'invalid'

interface Measured {
  readonly tool: string
  readonly via?: string
  readonly effect: string
  readonly verdict: Verdict
  /** For `refused`: which rule. */
  readonly cause?: string
  /** For `host`: the ACP `kind` the request carried. */
  readonly kind?: string
  /** For `host`: how many requests the probe call raised. */
  readonly requests?: number
  /** For a host-approved `ExecuteExtraTool`: what the inner tool did. */
  readonly inner?: 'ran' | 'missing' | 'denied'
  /**
   * The call produced no `tool_call` update at all (the bridge turns
   * `TodoWrite` into a `plan` update), so a request from it could not be named.
   */
  readonly unnamed?: true
}

interface Snapshot {
  readonly platform: string
  readonly posture: { readonly mode: 'acceptEdits'; readonly safeMode: true }
  readonly offeredTools: readonly string[]
  readonly deferredTools: readonly string[]
  /** Probes the node ran with no host request although they change something. */
  readonly sideEffectsAllowedWithoutHost: readonly string[]
  readonly probes: Readonly<Record<string, Measured>>
}

/** Main-turn `tool_call` updates, in order — one per scripted step. */
function mainCalls(events: readonly HostEvent[]) {
  return events.filter(
    (event): event is Extract<HostEvent, { type: 'tool_call' }> =>
      event.type === 'tool_call' && event.parentToolUseId === null,
  )
}

function refusalCause(text: string): string | null {
  const hardline = /Refused by the Qianmo resident hardline \(([\w-]+)\)/.exec(
    text,
  )
  if (hardline) return `hardline:${hardline[1]}`
  if (/No such tool available/.test(text)) return 'not-offered'
  if (/not available to a Qianmo resident turn/.test(text)) return 'excluded'
  if (/may not run in \w+ mode/.test(text)) return 'mode'
  return null
}

function classify(probe: AskProbe, result: ScenarioResult): Measured {
  const stepCount = probe.steps(PLACEHOLDER_CONTEXT).length
  const calls = mainCalls(result.events)
  const probeCall = calls[stepCount - 1]
  const expectedName = probe.via ?? probe.tool
  const unnamed = probeCall === undefined && calls.length === stepCount - 1
  if (!unnamed && probeCall?.toolName !== expectedName) {
    throw new Error(
      `probe ${probe.id}: expected call ${stepCount} to be ${expectedName}, ` +
        `saw ${JSON.stringify(calls.map(c => c.toolName))}`,
    )
  }
  const text = result.toolResults[stepCount - 1] ?? ''
  const base = {
    tool: probe.tool,
    ...(probe.via === undefined ? {} : { via: probe.via }),
    effect: probe.effect,
    ...(unnamed ? { unnamed: true as const } : {}),
  }
  const earlier = new Set(calls.map(c => c.toolCallId))
  const requests = result.hostRequests.filter(request =>
    probeCall === undefined
      ? !earlier.has(request.toolCallId)
      : request.toolCallId === probeCall.toolCallId,
  )
  if (requests.length > 0) {
    const approved = requests.some(request => request.answered === 'allow')
    const inner =
      approved && probe.via === 'ExecuteExtraTool'
        ? /not found/.test(text)
          ? ('missing' as const)
          : /Permission denied for tool/.test(text)
            ? ('denied' as const)
            : ('ran' as const)
        : undefined
    return {
      ...base,
      verdict: 'host',
      kind: requests[0]?.kind ?? '',
      requests: requests.length,
      ...(inner === undefined ? {} : { inner }),
    }
  }
  const cause = refusalCause(text)
  if (cause !== null) return { ...base, verdict: 'refused', cause }
  if (text.includes('<tool_use_error>')) return { ...base, verdict: 'invalid' }
  return { ...base, verdict: 'allowed' }
}

/** Steps are only counted through this; no path in it is ever touched. */
const PLACEHOLDER_CONTEXT: ProbeContext = {
  workspace: '/w',
  outside: '/o',
  config: '/c',
  consoleConfig: '/cc',
  loopbackUrl: 'http://127.0.0.1:1/',
  memory: '/c/memory',
}

function snapshotOf(
  platform: string,
  harness: ResidentAcpHarness,
  measured: Readonly<Record<string, Measured>>,
): Snapshot {
  return {
    platform,
    posture: { mode: 'acceptEdits', safeMode: true },
    offeredTools: [...harness.offeredTools].sort(),
    deferredTools: [...harness.deferredTools].sort(),
    sideEffectsAllowedWithoutHost: Object.entries(measured)
      .filter(
        ([, entry]) =>
          entry.verdict === 'allowed' &&
          entry.effect !== 'none' &&
          // Workspace edits under acceptEdits are outside C by definition
          // (§1.1); the posture, not an approval, is what admits them.
          entry.effect !== 'workspace',
      )
      .map(([id]) => id)
      .sort(),
    probes: measured,
  }
}

function snapshotPath(platform: string): string {
  return join(SNAPSHOT_DIR, `${platform}.json`)
}

function render(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

describe('C_tool ask snapshot, acceptEdits, shipped resident child', () => {
  let harness: ResidentAcpHarness
  let fixture: ReturnType<typeof plantAskFixture>
  let context: ProbeContext
  const results = new Map<string, ScenarioResult>()
  const measured: Record<string, Measured> = {}

  beforeAll(async () => {
    fixture = plantAskFixture(port => `http://127.0.0.1:${port}/`)
    harness = new ResidentAcpHarness(fixture.config, { extraEnv: OFFLINE_ENV })
    await harness.start()
    context = fixture.context(harness.modelPort)
    for (const probe of ASK_CORPUS) {
      const result = await harness.run({
        id: probe.id,
        mode: 'acceptEdits',
        cwd: fixture.workspace,
        steps: probe.steps(context),
        ...(probe.hostPolicy === undefined
          ? {}
          : { hostPolicy: probe.hostPolicy }),
      })
      results.set(probe.id, result)
      measured[probe.id] = classify(probe, result)
    }
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await harness?.stop()
    if (fixture) rmSync(fixture.root, { recursive: true, force: true })
  })

  test('a Bash write outside the workspace reaches the host requestPermission', () => {
    const result = results.get('bash-touch-outside')
    expect(result?.hostRequests).toHaveLength(1)
    expect(result?.hostRequests[0]?.kind).toBe('execute')
    expect(result?.hostRequests[0]?.rawInput).toContain(
      join(context.outside, 'touched.txt'),
    )
    // Refused by the host, so it did not happen.
    expect(existsSync(join(context.outside, 'touched.txt'))).toBe(false)
  })

  test('the corpus covers the F-26 tools, the offered surface and every deferred tool', () => {
    const probed = new Set(
      ASK_CORPUS.flatMap(probe =>
        probe.via === undefined ? [probe.tool] : [probe.tool, probe.via],
      ),
    )
    // Guards against a vacuous comparison: an empty surface would cover itself.
    expect(harness.offeredTools.length).toBeGreaterThan(10)
    expect(harness.deferredTools.length).toBeGreaterThan(0)
    const missing = [
      ...REVIEW_F26_TOOLS,
      ...harness.offeredTools,
      ...harness.deferredTools,
    ].filter(tool => !probed.has(tool))
    expect(missing).toEqual([])
    // Every deferred tool is probed on the route the base offers for it.
    for (const tool of harness.deferredTools) {
      expect(
        ASK_CORPUS.some(
          probe => probe.tool === tool && probe.via === 'ExecuteExtraTool',
        ),
      ).toBe(true)
    }
  })

  test('each permission request is preceded by a tool_call naming the tool', () => {
    let checked = 0
    for (const probe of ASK_CORPUS) {
      const events = results.get(probe.id)?.events ?? []
      const named = new Map<string, string | null>()
      for (const event of events) {
        if (event.type === 'tool_call') {
          named.set(event.toolCallId, event.toolName)
          continue
        }
        if (event.type !== 'permission') continue
        checked += 1
        // Present, and present *before*: `named` only holds what came earlier.
        expect({
          probe: probe.id,
          toolName: named.get(event.toolCallId),
        }).toEqual({
          probe: probe.id,
          toolName: expect.any(String),
        })
      }
      // For the probe call itself, the name is the one the model used.
      const probeCall = mainCalls(events).at(-1)
      if (
        measured[probe.id]?.verdict === 'host' &&
        !measured[probe.id]?.unnamed
      ) {
        expect(probeCall?.toolName).toBe(probe.via ?? probe.tool)
      }
    }
    // Enough samples that "always" means something across tools and kinds.
    expect(checked).toBeGreaterThanOrEqual(20)
  })

  test('P14.3 pending and grant rows under <config>/resident/ are refused on both surfaces', () => {
    expect(measured['hardline-read-authz-ledger']).toMatchObject({
      verdict: 'refused',
      cause: 'hardline:node-state',
    })
    expect(measured['hardline-bash-authz-ledger']).toMatchObject({
      verdict: 'refused',
      cause: 'hardline:node-state',
    })
    // The shell probe appends; the file is still the empty one planted.
    expect(
      readFileSync(join(fixture.config, 'resident', AUTHZ_LEDGER_FILE), 'utf8'),
    ).toBe('')
  })

  test('the snapshot matches the one pinned for this platform', () => {
    const platform = process.platform
    const actual = snapshotOf(platform, harness, measured)
    const path = snapshotPath(platform)
    if (process.env.QIANMO_ASK_SNAPSHOT === 'write') {
      writeFileSync(path, render(actual))
    }
    if (!existsSync(path)) {
      throw new Error(
        `no ask snapshot is pinned for ${platform}. C_tool on this platform ` +
          'is unmeasured; generate it with QIANMO_ASK_SNAPSHOT=write and review it.',
      )
    }
    const pinned = JSON.parse(readFileSync(path, 'utf8')) as Snapshot
    expect(actual).toEqual(pinned)
  })

  test('the CI platform has a pinned snapshot', () => {
    expect(existsSync(snapshotPath(CI_PLATFORM))).toBe(true)
  })
})
