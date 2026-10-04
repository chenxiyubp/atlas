// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E-1 ~ E-6 bypass corpus, run against a real `--acp` child (design
 * `authorization-m1.md` I-11, P14.2).
 *
 * Three things are pinned here, each with its red direction:
 *
 * 1. **Every case in `fixtures/resident-bypass-corpus.ts` stays closed** in the
 *    shipped child. The host of that child names its own memory root, the way
 *    `QianmoResident` now does, so the E-6 memory cases cover both the child's
 *    default root and the one the host actually serves.
 * 2. **The host-named memory root is protected only because it is named**: a
 *    child that is not told refuses the default root and nothing else. This is
 *    the control that shows (1) is not passing by accident.
 * 3. **Safe mode is what keeps hook, agent and skill definitions from loading**:
 *    one measurement, run with safe mode on (nothing takes effect) and off
 *    (all three do). The "off" half is the same case going red.
 *
 * And one cheap, process-free check that the corpus sits on the path an
 * upstream sync runs — `bun run verify` → `scripts/test-shards.sh` →
 * `tests/integration` — so a base change that reopens a route is caught by
 * the sync's full ratchet run rather than by luck.
 *
 * Nothing is mocked; only the model and the host are scripted.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  ResidentAcpHarness,
  type ScenarioResult,
} from './fixtures/resident-acp-harness.js'
import {
  BYPASS_CORPUS,
  type BypassCase,
  type BypassContext,
  type BypassId,
  plantBypassFixture,
} from './fixtures/resident-bypass-corpus.js'

const TEST_TIMEOUT_MS = 300_000
/**
 * Room for what outlives a turn — an async subagent (E-3), a background
 * monitor (E-5) — to do what it would do. Absence checks are only meaningful
 * after it.
 */
const SETTLE_MS = 20_000

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const ALL_BYPASSES: readonly BypassId[] = [
  'E-1',
  'E-2',
  'E-3',
  'E-4',
  'E-5',
  'E-6',
]

const REFUSAL =
  /denied|Refused|not available|cancelled|No such tool|not found|Unknown skill/i

function probeText(result: ScenarioResult, step: number): string {
  return result.toolResults[step] ?? ''
}

async function eventually(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return predicate()
}

function judge(
  entry: BypassCase,
  result: ScenarioResult,
  ctx: BypassContext,
): void {
  const escapes = entry.escapes(ctx)
  const lastStep = entry.steps(ctx).length - 1
  if (entry.refusedAt !== undefined) {
    expect(probeText(result, entry.refusedAt.step)).toMatch(
      entry.refusedAt.pattern,
    )
  }
  switch (entry.expect.kind) {
    case 'contained': {
      for (const path of escapes) expect(existsSync(path)).toBe(false)
      const askedOrRefused =
        result.hostRequests.length > 0 ||
        [...result.toolResults, ...result.subToolResults].some(text =>
          REFUSAL.test(text),
        )
      expect(askedOrRefused).toBe(true)
      return
    }
    case 'hardline': {
      expect(result.hostRequests).toHaveLength(0)
      expect(probeText(result, lastStep)).toContain(
        `Refused by the Qianmo resident hardline (${entry.expect.target})`,
      )
      for (const path of escapes) expect(existsSync(path)).toBe(false)
      return
    }
    case 'single-ask': {
      expect(result.hostRequests).toHaveLength(1)
      const request = result.hostRequests[0]
      expect(request?.answered).toBe(
        entry.expect.approved ? 'allow' : 'cancelled',
      )
      // What P14.5 has to render: the inner tool and its parameters are in
      // the one request the host gets.
      expect(request?.rawInput).toContain(
        `"tool_name":"${entry.expect.innerTool}"`,
      )
      for (const path of escapes) {
        expect(request?.rawInput).toContain(path)
        expect(existsSync(path)).toBe(entry.expect.approved)
      }
      return
    }
  }
}

describe('the bypass corpus is on the full ratchet an upstream sync runs', () => {
  test('verify → test-shards.sh → tests/integration → this file', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(pkg.scripts.verify).toContain('./scripts/test-shards.sh')

    const shards = readFileSync(
      join(REPO_ROOT, 'scripts', 'test-shards.sh'),
      'utf8',
    )
    const loop = /^for d in (.+); do$/m.exec(shards)?.[1] ?? ''
    expect(loop.split(/\s+/)).toContain('tests/integration')

    const ci = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8',
    )
    expect(ci).toContain('./scripts/test-shards.sh')

    const here = relative(REPO_ROOT, import.meta.path)
    expect(here.startsWith('tests/integration/')).toBe(true)
    expect(here.endsWith('.test.ts')).toBe(true)
  })

  test('no case of the corpus is skipped or singled out', () => {
    const self = readFileSync(import.meta.path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(self).not.toMatch(
      /\b(test|describe|it)\.(skip|only|todo|if|skipIf|todoIf|onlyIf)\b/,
    )
  })

  test('each of E-1 ~ E-6 has at least one case, and ids are unique', () => {
    for (const bypass of ALL_BYPASSES) {
      expect(BYPASS_CORPUS.some(entry => entry.bypass === bypass)).toBe(true)
    }
    const ids = BYPASS_CORPUS.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('every bypass case stays closed in the shipped resident child', () => {
  let root = ''
  let ctx: BypassContext
  let harness: ResidentAcpHarness
  const results = new Map<string, ScenarioResult>()

  beforeAll(async () => {
    const fixture = plantBypassFixture()
    root = fixture.root
    ctx = fixture.context
    // Shipped environment (safe mode on), and the host names a memory root of
    // its own — what `QianmoResident` hands its child after this change.
    harness = new ResidentAcpHarness(ctx.config, {
      memoryRoot: ctx.hostMemory,
    })
    await harness.start()
    for (const entry of BYPASS_CORPUS) {
      const result = await harness.run({
        id: entry.id,
        mode: entry.mode,
        cwd: ctx[entry.cwd],
        steps: entry.steps(ctx),
        ...(entry.subSteps === undefined
          ? {}
          : { subSteps: entry.subSteps(ctx) }),
        ...(entry.hostPolicy === undefined
          ? {}
          : { hostPolicy: entry.hostPolicy }),
      })
      results.set(entry.id, result)
    }
    // An approved E-5 monitor writes asynchronously; wait for it before the
    // settle so its presence is not a race, then give everything else time.
    const approved = BYPASS_CORPUS.filter(
      entry => entry.expect.kind === 'single-ask' && entry.expect.approved,
    ).flatMap(entry => entry.escapes(ctx))
    await eventually(() => approved.every(path => existsSync(path)), SETTLE_MS)
    await new Promise(r => setTimeout(r, SETTLE_MS))
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await harness?.stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  for (const entry of BYPASS_CORPUS) {
    test(`${entry.bypass} ${entry.id}: ${entry.note}`, () => {
      const result = results.get(entry.id)
      expect(result).toBeDefined()
      judge(entry, result as ScenarioResult, ctx)
    })
  }

  test('the hook that E-2 plants never ran', () => {
    expect(existsSync(ctx.hookMarker)).toBe(false)
  })
})

describe("the host's memory root is refused only because the host names it", () => {
  let root = ''
  let harness: ResidentAcpHarness

  afterAll(async () => {
    await harness?.stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test(
    'a child not told about it refuses its own default root and nothing more',
    async () => {
      const fixture = plantBypassFixture()
      root = fixture.root
      const ctx = fixture.context
      harness = new ResidentAcpHarness(ctx.config)
      await harness.start()
      const hostRoot = await harness.run({
        id: 'control-host-memory',
        mode: 'acceptEdits',
        cwd: ctx.workspace,
        steps: [
          {
            name: 'Read',
            input: {
              file_path: join(ctx.hostMemory, 'working', 'main', 'entry.md'),
            },
          },
        ],
      })
      // Not the hardline: it is an ordinary outside-the-workspace read, so it
      // asks. That gap is what `residentAcpEnvironment({ memoryRoot })` closes.
      expect(hostRoot.toolResults[0]).not.toContain('resident hardline')
      expect(hostRoot.hostRequests).toHaveLength(1)

      const defaultRoot = await harness.run({
        id: 'control-default-memory',
        mode: 'acceptEdits',
        cwd: ctx.workspace,
        steps: [
          {
            name: 'Read',
            input: {
              file_path: join(ctx.memory, 'working', 'main', 'entry.md'),
            },
          },
        ],
      })
      expect(defaultRoot.toolResults[0]).toContain(
        'Refused by the Qianmo resident hardline (memory-root)',
      )
    },
    TEST_TIMEOUT_MS,
  )
})

interface CustomizationEffect {
  readonly hook: boolean
  readonly agent: boolean
  readonly skill: boolean
}

const NOTHING_IN_EFFECT: CustomizationEffect = {
  hook: false,
  agent: false,
  skill: false,
}

/**
 * Does each planted definition take effect in this child? Harmless calls
 * only — the hook sees an `ls`, the agent gets no escaping steps, the skill
 * is approved and does nothing — so the same measurement can run in a child
 * with safe mode off without trying a bypass there.
 */
async function customizationInEffect(
  harness: ResidentAcpHarness,
  ctx: BypassContext,
  tag: string,
): Promise<CustomizationEffect> {
  rmSync(ctx.hookMarker, { force: true })
  await harness.run({
    id: `${tag}-hook`,
    mode: 'acceptEdits',
    cwd: ctx.workspace,
    steps: [{ name: 'Bash', input: { command: 'ls', description: 'probe' } }],
  })
  const agent = await harness.run({
    id: `${tag}-agent`,
    mode: 'acceptEdits',
    cwd: ctx.workspace,
    steps: [
      {
        name: 'Agent',
        input: { description: 'probe', subagent_type: 'esc', prompt: 'hello' },
      },
    ],
  })
  const skill = await harness.run({
    id: `${tag}-skill`,
    mode: 'acceptEdits',
    cwd: ctx.workspace,
    steps: [{ name: 'Skill', input: { skill: 'helper' } }],
    hostPolicy: request =>
      /skill/i.test(
        String((request as { toolCall?: { title?: unknown } }).toolCall?.title),
      ),
  })
  return {
    hook: existsSync(ctx.hookMarker),
    agent: /launched/i.test(agent.toolResults[0] ?? ''),
    skill:
      skill.hostRequests.some(r => r.answered === 'allow') &&
      !/Unknown skill|tool_use_error/.test(skill.toolResults[0] ?? ''),
  }
}

describe('safe mode keeps hook, agent and skill definitions from taking effect', () => {
  const roots: string[] = []
  const harnesses: ResidentAcpHarness[] = []

  async function child(safeMode: boolean) {
    const fixture = plantBypassFixture()
    roots.push(fixture.root)
    const harness = new ResidentAcpHarness(fixture.context.config, {
      safeMode,
    })
    harnesses.push(harness)
    await harness.start()
    return { harness, ctx: fixture.context }
  }

  afterAll(async () => {
    for (const harness of harnesses) await harness.stop()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  test(
    'safe mode on: none of the three takes effect',
    async () => {
      const { harness, ctx } = await child(true)
      expect(await customizationInEffect(harness, ctx, 'on')).toEqual(
        NOTHING_IN_EFFECT,
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'safe mode off: the same measurement goes red — all three take effect',
    async () => {
      const { harness, ctx } = await child(false)
      expect(await customizationInEffect(harness, ctx, 'off')).toEqual({
        hook: true,
        agent: true,
        skill: true,
      })
    },
    TEST_TIMEOUT_MS,
  )
})
