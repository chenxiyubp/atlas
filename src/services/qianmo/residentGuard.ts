// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the resident hardline table meets the base's permission chain
 * (design `resident-botization.md` §4.5 and `authorization-m1.md`; hermes
 * E2 / E3, review-P14 E-1 ~ E-6).
 *
 * THREE THINGS THIS FILE DOES, ALL LOCAL
 *
 *   1. It removes the tools a resident turn must never be handed —
 *      `EnterPlanMode`/`ExitPlanMode` (whose plan mode, on a non-root child,
 *      is a whole-session bypass), and the schedulers `Cron*`/`Team*` (which
 *      let one unattended turn arrange more). Removed from the array the model
 *      sees *and* from the array `ExecuteExtraTool`/`SearchExtraTools` resolve
 *      against, so the indirect route to them is closed with the direct one.
 *
 *   2. It wraps every tool's `checkPermissions` with a ceiling: the hardline
 *      table (below), a refusal of any elevated mode, and — for anything the
 *      tool itself would not allow under the carried posture — a
 *      `safetyCheck` ask. `safetyCheck` is the one ask the base honours ahead
 *      of the bypass-permissions fast path (step 2a), the whole-tool allow
 *      rule (2b) and the `PreToolUse`-hook-already-said-allow path, so a
 *      skill-injected allow rule (E-4) or a hook `allow` (E-2) cannot route
 *      around it: the call either reaches the host or, under `dontAsk`, is
 *      denied. A tool that legitimately allows under the posture — a workspace
 *      edit in `acceptEdits`, a read-only `ls` — still allows.
 *
 *   3. It wraps the session `canUseTool` so the same ceiling applies to every
 *      nested query the turn can open — subagents, workflow workers, skill
 *      forks — where the tools are re-assembled by the base and never see the
 *      wrapper in (2). A subagent whose definition set `permissionMode:
 *      bypassPermissions` (E-3) is caught here, because `canUseTool` is the one
 *      funnel `resolveHookPermissionDecision` calls for every execution that a
 *      hook did not already wave through.
 *
 * WHY NOT AN EDIT TO `permissions.ts`
 *
 * The requirement is that the ceiling is evaluated **before any allow**. A
 * wrapper around `checkPermissions` sits at step 1c, ahead of every path that
 * can answer `allow`; a wrapper around `canUseTool` is the single gate the
 * execution funnel calls. Both are base semantics we lean on rather than
 * change: `permissions.ts` is core on the hot path of every tool call in the
 * product, and an edit there would be re-merged by hand at every upstream sync
 * for a rule that concerns only resident sessions.
 *
 * WHY THE TABLE IS NOT READ FROM CONFIGURATION
 *
 * `ResidentHardline` holds a frozen literal in `@qianmo/resident`. The only
 * things supplied from outside are absolute roots, and those come from the
 * process's own path derivation (`occConfigDir()`, `defaultMemoryRoot()`,
 * `hostMemoryRoot()`), not anything a session can set. Nothing here reads
 * `settings.json`, and that is the point: the first entry on the table is
 * `settings.json` itself.
 */

import { ResidentHardline } from '@qianmo/resident'
import { defaultMemoryRoot } from '@qianmo/memory'
import type {
  Tool,
  Tools,
  ToolPermissionContext,
  ToolUseContext,
} from '@open-claude-code/tool-runtime/Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type {
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionMode,
} from '../../types/permissions.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { occConfigDir } from '../../config/paths.js'
import { hostMemoryRoot } from './residentAcpEnv.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/ExitPlanModeTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/TeamDeleteTool/constants.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from '@open-claude-code/builtin-tools/tools/ScheduleCronTool/prompt.js'

/**
 * Tools a resident turn is never handed.
 *
 * `EnterPlanMode`/`ExitPlanMode`: plan mode plus the ACP child's ambient
 * bypass availability is a whole-session allow (review-P14 E-1). `Cron*` and
 * `Team*`: an unattended turn that can schedule work or spin up teammates can
 * arrange more unattended turns, and the teammate path also re-enters plan
 * mode outside this file's reach (E-1b). A frozen set rather than a predicate
 * so `notifyTool.test.ts`-style assertions can pin it.
 */
export const RESIDENT_EXCLUDED_TOOLS: ReadonlySet<string> = Object.freeze(
  new Set([
    ENTER_PLAN_MODE_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    CRON_CREATE_TOOL_NAME,
    CRON_DELETE_TOOL_NAME,
    CRON_LIST_TOOL_NAME,
    TEAM_CREATE_TOOL_NAME,
    TEAM_DELETE_TOOL_NAME,
  ]),
)

/**
 * Permission modes a resident session must never be in. The carried posture is
 * only ever `dontAsk`, `acceptEdits` or `default` (see `acp-client.ts`); any of
 * these means something changed the mode mid-run — `EnterPlanMode`, an agent
 * definition, a resumed teammate — and every one of them is a bypass in
 * disguise. `auto` would hand approval to a model classifier, which a headless
 * node has no operator behind.
 */
const ELEVATED_MODES: ReadonlySet<PermissionMode> = Object.freeze(
  new Set<PermissionMode>(['plan', 'bypassPermissions', 'auto']),
)

/**
 * The hardline instance for this process.
 *
 * Built from the identity config root (where the key material and node state
 * live) and given the memory store as a protected subtree. The memory root is
 * additive and can sit outside the config root
 * (`CLAUDE_CODE_REMOTE_MEMORY_DIR`); a resident turn never reaches it through
 * the filesystem because the host reads and injects memory for it, so the whole
 * tree is off limits and no single approval can plant an entry a later turn
 * would trust (design X-12).
 *
 * The host's own memory root joins it when the host named one
 * (`residentAcpEnv.ts`): a host running on a non-default root would otherwise
 * serve memory from a directory this child never refuses. Additive only — the
 * child's default stays on the list, and a relative value is dropped by
 * `ResidentHardline` like any other.
 */
function residentHardline(): ResidentHardline {
  const named = hostMemoryRoot()
  return new ResidentHardline({
    stateRoots: [occConfigDir()],
    protectedRoots: [
      defaultMemoryRoot(),
      ...(named === undefined ? [] : [named]),
    ],
  })
}

function hardlineDenial(
  hardline: ResidentHardline,
  toolName: string,
  input: unknown,
): PermissionDenyDecision | null {
  const denial = hardline.verdict(toolName, input)
  if (denial === null) return null
  return {
    behavior: 'deny',
    message:
      `Refused by the Qianmo resident hardline (${denial.target.id}): ` +
      `${denial.target.reason}. Matched ${JSON.stringify(denial.matched)} on the ` +
      `${denial.surface} surface. This target cannot be pre-approved — no ` +
      'allow rule, permission mode or hook grants access to it.',
    decisionReason: {
      type: 'other',
      reason: `qianmo-resident-hardline:${denial.target.id}`,
    },
  }
}

function excludedDenial(toolName: string): PermissionDenyDecision {
  return {
    behavior: 'deny',
    message:
      `The tool ${toolName} is not available to a Qianmo resident turn: it can ` +
      'change the session permission mode or schedule further unattended work, ' +
      'neither of which an unattended turn may do.',
    decisionReason: {
      type: 'other',
      reason: `qianmo-resident-excluded:${toolName}`,
    },
  }
}

function elevatedModeDenial(mode: PermissionMode): PermissionDenyDecision {
  return {
    behavior: 'deny',
    message:
      `A Qianmo resident turn may not run in ${mode} mode — it carries only ` +
      'dontAsk, acceptEdits or default. The call is refused rather than ' +
      'auto-approved.',
    decisionReason: {
      type: 'other',
      reason: `qianmo-resident-mode:${mode}`,
    },
  }
}

/**
 * A copy of the context whose permission state carries no allow rules.
 *
 * The tool's own `checkPermissions` reads these — a skill's `allowed-tools`
 * lands in `alwaysAllowRules.command` and would make `Bash`'s check answer
 * allow (E-4). Stripping them restores the empty-rule posture the session was
 * created with, so the tool's verdict reflects the carried mode alone.
 */
function withoutAllowRules(context: ToolUseContext): ToolUseContext {
  const readAppState = context.getAppState
  return {
    ...context,
    getAppState: () => {
      const state = readAppState()
      const permissionContext: ToolPermissionContext = {
        ...state.toolPermissionContext,
        alwaysAllowRules: {},
      }
      return { ...state, toolPermissionContext: permissionContext }
    },
  }
}

function currentMode(context: ToolUseContext): PermissionMode {
  return context.getAppState().toolPermissionContext.mode
}

/**
 * The `safetyCheck` ask the base honours ahead of every allow path. `ask` on
 * its own is not enough — the bypass fast path and the whole-tool allow rule
 * both sit past it — but a `safetyCheck` that is not classifier-approvable is
 * returned by step 1g and by `checkRuleBasedPermissions`, so it reaches the
 * host (or, under `dontAsk`, becomes a deny at the end of the chain).
 */
function hostReviewAsk(toolName: string): PermissionAskDecision {
  return {
    behavior: 'ask',
    message:
      `The Qianmo resident node routes ${toolName} to its operator: no rule, ` +
      'permission mode or hook may pre-approve it.',
    decisionReason: {
      type: 'safetyCheck',
      reason: `qianmo-resident-host-review:${toolName}`,
      classifierApprovable: false,
    },
  }
}

function guardTool(tool: Tool, hardline: ResidentHardline): Tool {
  // Prototype delegation rather than a spread: a spread would copy own
  // enumerable properties only, dropping getters and anything the tool defines
  // on a prototype, and would silently change behaviour for tools that have
  // either. Here every read that is not `checkPermissions` falls through to the
  // real tool untouched.
  const guarded = Object.create(tool) as Tool
  guarded.checkPermissions = async (input, context) => {
    if (RESIDENT_EXCLUDED_TOOLS.has(tool.name)) return excludedDenial(tool.name)

    const mode = currentMode(context)
    if (ELEVATED_MODES.has(mode)) return elevatedModeDenial(mode)

    const denial = hardlineDenial(hardline, tool.name, input)
    if (denial !== null) return denial

    // The tool's honest verdict under the carried mode, with injected allow
    // rules removed. allow/deny stand; anything else becomes a host-visible,
    // bypass-immune ask so no allow path downstream can turn it into a silent
    // execution.
    const real = await tool.checkPermissions(input, withoutAllowRules(context))
    if (real.behavior === 'allow' || real.behavior === 'deny') return real
    return hostReviewAsk(tool.name)
  }
  return guarded
}

/**
 * Filter the resident tool surface, then apply the hardline to every tool left.
 *
 * Every tool, not a chosen few: the file tools and `Bash` are the two surfaces
 * hermes E3 names, but a list of "the dangerous ones" is a list that goes stale
 * the next time a tool grows a path argument, and it goes stale silently.
 */
export function withResidentHardline(tools: Tools): Tools {
  const hardline = residentHardline()
  return tools
    .filter(tool => !RESIDENT_EXCLUDED_TOOLS.has(tool.name))
    .map(tool => guardTool(tool, hardline))
}

/**
 * Wrap the session `canUseTool` with the same ceiling, for the nested queries
 * whose tools never pass through {@link withResidentHardline}.
 *
 * `resolveHookPermissionDecision` calls `canUseTool` for every execution a
 * `PreToolUse` hook did not already allow — including, in a subagent, one
 * running under a definition-supplied `bypassPermissions` mode (E-3). Denying
 * the elevated mode here catches it before the base bypass fast path returns
 * allow. Excluded tools and hardline targets are refused too, as a belt for a
 * re-assembled subagent pool that never saw the surface filter.
 */
export function withResidentCanUseTool(inner: CanUseToolFn): CanUseToolFn {
  const hardline = residentHardline()
  return async (tool, input, context, assistantMessage, toolUseID, force) => {
    if (RESIDENT_EXCLUDED_TOOLS.has(tool.name)) return excludedDenial(tool.name)

    const mode = currentMode(context)
    if (ELEVATED_MODES.has(mode)) return elevatedModeDenial(mode)

    const denial = hardlineDenial(hardline, tool.name, input)
    if (denial !== null) return denial

    return inner(tool, input, context, assistantMessage, toolUseID, force)
  }
}
