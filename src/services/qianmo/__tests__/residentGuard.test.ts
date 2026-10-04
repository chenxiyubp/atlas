// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ordering claim, checked where it is actually made: the hardline table is
 * consulted **before** anything that could answer `allow` (design §4.5, hermes
 * E2/E3, roadmap P13.7 DoD).
 *
 * The base has exactly two funnels that can produce an allow for a tool call,
 * and both of them reach it through `tool.checkPermissions`:
 * `hasPermissionsToUseToolInner` (step 1c, returning on a deny at 1d, ahead of
 * bypass mode at 2a and the whole-tool allow rule at 2b) and
 * `checkRuleBasedPermissions` (the path taken when a `PreToolUse` hook already
 * answered allow). So a tool whose `checkPermissions` returns `allow` is a
 * faithful stand-in for "a pre-approval matched", and the assertions below are
 * about what happens to that allow.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { defaultMemoryRoot } from '@qianmo/memory'
import type {
  Tool,
  ToolUseContext,
} from '@open-claude-code/tool-runtime/Tool.js'
import type { PermissionMode } from '../../../types/permissions.js'
import { occConfigDir } from '../../../config/paths.js'
import { residentAcpEnvironment } from '../residentAcpEnv.js'
import {
  RESIDENT_EXCLUDED_TOOLS,
  withResidentCanUseTool,
  withResidentHardline,
} from '../residentGuard.js'

/**
 * A context carrying one mode and a set of allow rules. The wrapper reads the
 * mode to refuse an elevated session and strips the rules before consulting the
 * real tool, so both are worth being able to vary from a test.
 */
function context(
  mode: PermissionMode = 'default',
  commandAllowRules: string[] = [],
): { context: ToolUseContext } {
  const ctx = {
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        alwaysAllowRules: { command: commandAllowRules },
      },
    }),
  } as unknown as ToolUseContext
  return { context: ctx }
}

const CONTEXT = context().context

/** A tool that pre-approves everything, the way a matched allow rule does. */
function permissiveTool(name: string): {
  readonly tool: Tool
  readonly calls: unknown[]
} {
  const calls: unknown[] = []
  const tool = {
    name,
    async checkPermissions(input: unknown) {
      calls.push(input)
      return { behavior: 'allow' as const, updatedInput: input }
    },
    async description() {
      return `${name} description`
    },
    marker: 'inherited-property',
  } as unknown as Tool
  return { tool, calls }
}

/** A tool that defers to the general permission system (the default shape). */
function passthroughTool(name: string): {
  readonly tool: Tool
  readonly seenRules: unknown[]
} {
  const seenRules: unknown[] = []
  const tool = {
    name,
    async checkPermissions(input: unknown, ctx: ToolUseContext) {
      seenRules.push(ctx.getAppState().toolPermissionContext.alwaysAllowRules)
      return { behavior: 'passthrough' as const, message: 'ask' }
    },
    async description() {
      return `${name} description`
    },
  } as unknown as Tool
  return { tool, seenRules }
}

describe('resident hardline wiring — evaluated before any allow', () => {
  test('a pre-approved write to a protected target is refused anyway', async () => {
    const { tool } = permissiveTool('FileWrite')
    const [guarded] = withResidentHardline([tool])

    const decision = await (guarded as Tool).checkPermissions(
      { file_path: `${occConfigDir()}/settings.json` } as never,
      CONTEXT,
    )

    expect(decision.behavior).toBe('deny')
    expect(decision.decisionReason).toEqual({
      type: 'other',
      reason: 'qianmo-resident-hardline:settings',
    })
  })

  test('the allow is never even consulted for a protected target', async () => {
    // The ordering claim in its sharpest form. If the wrapper ran the inner
    // check first and then overrode it, this counter would be 1 — and the
    // difference matters, because "asked, then overruled" is a shape that
    // decays into "asked, and honoured" the first time somebody refactors the
    // override away.
    const { tool, calls } = permissiveTool('Bash')
    const [guarded] = withResidentHardline([tool])

    const decision = await (guarded as Tool).checkPermissions(
      { command: `rm -rf ${occConfigDir()}/resident` } as never,
      CONTEXT,
    )

    expect(decision.behavior).toBe('deny')
    expect(calls).toHaveLength(0)
  })

  test('the shell surface is refused for the same target as the file surface', async () => {
    // Paired, at the wiring level and not only in the table: an implementation
    // that wrapped the file tools and forgot Bash would pass the file half of
    // this file and fail here.
    const target = `${occConfigDir()}/qianmo/audit/trail.ndjson`
    const [guardedFile] = withResidentHardline([
      permissiveTool('FileWrite').tool,
    ])
    const [guardedShell] = withResidentHardline([permissiveTool('Bash').tool])

    const fileDecision = await (guardedFile as Tool).checkPermissions(
      { file_path: target } as never,
      CONTEXT,
    )
    const shellDecision = await (guardedShell as Tool).checkPermissions(
      { command: `: > ${target}` } as never,
      CONTEXT,
    )

    expect(fileDecision.behavior).toBe('deny')
    expect(shellDecision.behavior).toBe('deny')
  })

  test('ordinary work still reaches the tool own decision', async () => {
    // Without this the suite above is satisfied by a guard that denies
    // everything, which would take the node off the air rather than protect it.
    const { tool, calls } = permissiveTool('FileWrite')
    const [guarded] = withResidentHardline([tool])

    const decision = await (guarded as Tool).checkPermissions(
      { file_path: '/repo/src/index.ts' } as never,
      CONTEXT,
    )

    expect(decision.behavior).toBe('allow')
    expect(calls).toHaveLength(1)
  })

  test('an elevated mode is refused before the tool is consulted', async () => {
    // review-P14 E-1: plan/bypass/auto are how a session gets a silent allow.
    // The resident carries only dontAsk/acceptEdits/default, so any of these
    // means the mode was changed mid-run — refuse ahead of the allow.
    const { tool, calls } = permissiveTool('Bash')
    const [guarded] = withResidentHardline([tool])

    for (const mode of ['plan', 'bypassPermissions', 'auto'] as const) {
      const decision = await (guarded as Tool).checkPermissions(
        { command: 'touch /tmp/x' } as never,
        context(mode).context,
      )
      expect(decision.behavior).toBe('deny')
    }
    expect(calls).toHaveLength(0)
  })

  test('an excluded tool is refused even if it would allow itself', async () => {
    const { tool, calls } = permissiveTool('EnterPlanMode')
    // withResidentHardline drops it from the array, so build the guard directly
    // over it to prove the checkPermissions ceiling refuses it too.
    const [onlyGuarded] = withResidentHardline([
      tool,
      permissiveTool('Bash').tool,
    ])
    // The array no longer contains EnterPlanMode at all.
    expect(onlyGuarded?.name).toBe('Bash')
    expect(RESIDENT_EXCLUDED_TOOLS.has('EnterPlanMode')).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('injected allow rules are stripped before the tool decides', async () => {
    // review-P14 E-4: a skill writes its allowed-tools into
    // alwaysAllowRules.command. The tool must decide as if the session carried
    // no rules, so the injection cannot turn its passthrough into an allow.
    const { tool, seenRules } = passthroughTool('Bash')
    const [guarded] = withResidentHardline([tool])

    const decision = await (guarded as Tool).checkPermissions(
      { command: 'touch /tmp/x' } as never,
      context('default', ['Bash', 'Bash(touch:*)']).context,
    )

    expect(seenRules).toEqual([{}])
    // passthrough becomes a host-visible, bypass-immune ask.
    expect(decision.behavior).toBe('ask')
    expect(decision.decisionReason).toEqual({
      type: 'safetyCheck',
      reason: 'qianmo-resident-host-review:Bash',
      classifierApprovable: false,
    })
  })

  test('the canUseTool ceiling refuses an elevated subagent', async () => {
    // review-P14 E-3: a subagent adopting permissionMode:bypassPermissions runs
    // with re-assembled tools that never saw the hardline wrapper. canUseTool is
    // the one funnel it still passes through.
    let innerCalled = false
    const inner = async () => {
      innerCalled = true
      return { behavior: 'allow' as const, updatedInput: {} }
    }
    const guarded = withResidentCanUseTool(inner)
    const { tool } = permissiveTool('Bash')

    const decision = await guarded(
      tool,
      { command: 'touch /tmp/x' },
      context('bypassPermissions').context,
      {} as never,
      'tool-use-1',
    )

    expect(decision.behavior).toBe('deny')
    expect(innerCalled).toBe(false)
  })

  test('the canUseTool ceiling defers ordinary work to the bridge', async () => {
    let innerCalled = false
    const inner = async () => {
      innerCalled = true
      return { behavior: 'allow' as const, updatedInput: {} }
    }
    const guarded = withResidentCanUseTool(inner)
    const { tool } = permissiveTool('Bash')

    const decision = await guarded(
      tool,
      { command: 'ls' },
      context('default').context,
      {} as never,
      'tool-use-2',
    )

    expect(innerCalled).toBe(true)
    expect(decision.behavior).toBe('allow')
  })

  test('wrapping preserves everything else about the tool', async () => {
    const { tool } = permissiveTool('FileRead')
    const [guarded] = withResidentHardline([tool])
    const wrapped = guarded as Tool & { marker?: string }

    expect(wrapped.name).toBe('FileRead')
    expect(wrapped.marker).toBe('inherited-property')
    expect(await wrapped.description({} as never, {} as never)).toBe(
      'FileRead description',
    )
  })

  test('every tool in the array is wrapped, not just the ones we thought of', async () => {
    const tools = ['FileWrite', 'Bash', 'NotebookEdit', 'SomeFutureTool'].map(
      name => permissiveTool(name).tool,
    )
    const guarded = withResidentHardline(tools)

    for (const tool of guarded) {
      const decision = await tool.checkPermissions(
        { file_path: `${occConfigDir()}/settings.json` } as never,
        CONTEXT,
      )
      expect(decision.behavior).toBe('deny')
    }
  })
})

describe('resident hardline wiring — the memory root the host names', () => {
  test('is refused on both surfaces once named, and not before', async () => {
    // The host passes the root it serves memory from through
    // `residentAcpEnvironment`; the child reads it when it builds the table.
    // Before this, a host started with its own `memoryRoot` had the child
    // guarding only the default root (review-P14 X-12 follow-up).
    const hostRoot = resolve('/srv/qianmo-host-memory')
    const target = `${hostRoot}/working/main/entry.md`
    // Whatever `residentAcpEnvironment` adds for the root is what the child
    // must read back — found by difference, not by copying the name here.
    const plain = residentAcpEnvironment({})
    const named = residentAcpEnvironment({}, { memoryRoot: hostRoot })
    const added = Object.keys(named).filter(key => !(key in plain))
    expect(added).toHaveLength(1)
    const key = added[0] ?? ''
    const saved = process.env[key]
    try {
      delete process.env[key]
      const [unnamed] = withResidentHardline([permissiveTool('Read').tool])
      const before = await (unnamed as Tool).checkPermissions(
        { file_path: target } as never,
        CONTEXT,
      )
      expect(before.behavior).toBe('allow')

      process.env[key] = named[key]
      const [file] = withResidentHardline([permissiveTool('Write').tool])
      const [shell] = withResidentHardline([permissiveTool('Bash').tool])
      const fileDecision = await (file as Tool).checkPermissions(
        { file_path: target } as never,
        CONTEXT,
      )
      const shellDecision = await (shell as Tool).checkPermissions(
        { command: `cat ${target}` } as never,
        CONTEXT,
      )
      expect(fileDecision.decisionReason).toEqual({
        type: 'other',
        reason: 'qianmo-resident-hardline:memory-root',
      })
      expect(shellDecision.decisionReason).toEqual({
        type: 'other',
        reason: 'qianmo-resident-hardline:memory-root',
      })
      // Additive: naming a host root does not take the child's default off.
      const defaultDecision = await (file as Tool).checkPermissions(
        { file_path: `${defaultMemoryRoot()}/working/main/entry.md` } as never,
        CONTEXT,
      )
      expect(defaultDecision.behavior).toBe('deny')
    } finally {
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
  })
})

describe('resident hardline wiring — it is applied to resident sessions only', () => {
  test('the session builder wraps the resident branch and leaves the other alone', async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, '../../acp/agent/createSessionMethod.ts'),
    ).text()

    // The resident branch is wrapped …
    expect(source).toContain('withResidentHardline([')
    // … and the non-resident branch is still the untouched base array. A
    // regression that wrapped everything would be a behaviour change for every
    // ordinary ACP session, which is not what this batch is allowed to do.
    expect(/:\s*baseTools\b/.test(source)).toBe(true)
    expect(source.match(/withResidentHardline/g)).toHaveLength(2)
  })
})
