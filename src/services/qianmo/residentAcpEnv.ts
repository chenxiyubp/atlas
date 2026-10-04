// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The environment a resident node hands to its ACP child.
 *
 * Its own module, rather than an inline literal inside `defaultSpawnAcp`, so
 * that the regression suite which boots a real `--acp` child can boot it with
 * *this* environment instead of a hand-copied one. A copy would keep passing
 * after this function changed, which is exactly the failure a regression test
 * exists to catch.
 */

import {
  IDENTITY_ENV_VAR,
  NODE_IDENTITY_MODE,
} from '../../constants/identity.js'

/**
 * The memory root the host serves memory from, as handed to its ACP child.
 * Set by {@link residentAcpEnvironment}; read back by {@link hostMemoryRoot}.
 */
const RESIDENT_MEMORY_ROOT_ENV = 'QIANMO_RESIDENT_MEMORY_ROOT'

/**
 * The memory root the host named for this child, or `undefined`.
 *
 * A path derivation in the same sense as `occConfigDir()` and
 * `defaultMemoryRoot()`, which read `OCC_CONFIG_DIR` and
 * `CLAUDE_CODE_REMOTE_MEMORY_DIR` the same way: the value is fixed when the
 * host spawns the child, and the only other writer is the node's own
 * `settings.json` `env` block, which the hardline refuses to every resident
 * turn. It is only ever *added* to the protected roots, so no value of it can
 * make the table refuse less.
 */
export function hostMemoryRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const root = env[RESIDENT_MEMORY_ROOT_ENV]
  return root === undefined || root === '' ? undefined : root
}

/**
 * `parent` plus what every resident ACP child needs regardless of how the
 * node was started. Keys set here win over the same keys in `parent`.
 *
 * ## Why safe mode is on
 *
 * `CLAUDE_CODE_SAFE_MODE=1` turns off every *user* customization surface in the
 * child: user/project/local `PreToolUse` hooks, custom agent and skill
 * definitions, plugins, custom slash commands, output styles and workflows.
 * That closes three permission bypasses at the load site, before any of them
 * can reach a permission decision:
 *
 *   - a `PreToolUse` hook that answers `allow` skips the host prompt entirely
 *     (review-P14 E-2). Its config snapshot is process-level, so one workspace's
 *     hook would also apply to another agent's session in the same child;
 *   - a custom agent definition carrying `permissionMode: bypassPermissions` is
 *     adopted by the subagent it spawns (E-3);
 *   - a skill's `allowed-tools` injects allow rules into the running session
 *     (E-4).
 *
 * Safe mode keeps everything the node actually needs: auth and model selection,
 * the built-in tool set, the permission system, `CLAUDE.md`, and — because they
 * load from `policySettings`, not user settings — any admin-managed hooks. It
 * does **not** touch the provider credentials or endpoints the node reads from
 * its own `settings.json` `env` block (`applySafeConfigEnvironmentVariables`
 * runs regardless), nor the host-side memory sidecar, notify tool or MCP wiring,
 * none of which are user-customization surfaces. Measured: a child booted with
 * this env still reads its `settings.json` provider and its workspace
 * `CLAUDE.md`, and still auto-accepts workspace edits under `acceptEdits`.
 *
 * The tool-surface trims, the hardline and the `canUseTool` ceiling in
 * `residentGuard.ts` are the defence in depth for the case where a definition
 * is admin-managed (safe mode keeps those) or a future base change moves one of
 * these load sites — they hold with safe mode off.
 *
 * ## Why the memory root travels with it
 *
 * The child's hardline refuses the node's memory store as a whole subtree. It
 * derives that root itself (`defaultMemoryRoot()`), which agrees with the host
 * only while the host uses the default too. A host started with its own
 * `memoryRoot` would otherwise protect one directory and serve memory out of
 * another. So the host names the root it actually uses, and the child adds it
 * to the protected set — additively: the child's own default stays protected
 * whatever this says.
 */
export function residentAcpEnvironment(
  parent: NodeJS.ProcessEnv,
  options: { readonly memoryRoot?: string } = {},
): NodeJS.ProcessEnv {
  return {
    ...parent,
    [IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE,
    CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
    CLAUDE_CODE_SAFE_MODE: '1',
    ...(options.memoryRoot === undefined
      ? {}
      : { [RESIDENT_MEMORY_ROOT_ENV]: options.memoryRoot }),
  }
}
