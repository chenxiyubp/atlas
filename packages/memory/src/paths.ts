// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from 'node:path'
import { getMemoryBaseDir } from '../../../src/memdir/paths.js'
import { type MemoryScope, validateScope } from './entry.js'

/** Sub-directory of the base memory root that this package owns. */
export const QIANMO_MEMORY_DIRNAME = 'memory'

/**
 * Where the three tables live by default.
 *
 * Derived from the base's own memory-root helper, never assembled by hand. Two
 * things follow from that, and both are the reason the rule exists
 * (`CLAUDE.md` §1.1②):
 *
 *   - The config root is identity-scoped: `~/.occ` normally, `~/.qianmo` under
 *     `OCC_IDENTITY=qianmo`, and either overridable via `OCC_CONFIG_DIR` /
 *     `CLAUDE_CONFIG_DIR`. A literal `join(homedir(), '.occ')` would resolve to
 *     one fixed directory and punch straight through the isolation a Qianmo
 *     node depends on.
 *   - `getMemoryBaseDir()` additionally honours `CLAUDE_CODE_REMOTE_MEMORY_DIR`,
 *     which is how a remote/sandboxed deployment redirects memory onto a
 *     persistent mount. For a resident node whose sandbox can be reset that is
 *     not a nicety: memory that ignored it would not survive a wake.
 *
 * The result is a sibling of the base's own `projects/<slug>/memory/` tree, not
 * a location inside it — see `mapping.ts` §2 for why that separation is load
 * bearing.
 */
export function defaultMemoryRoot(): string {
  return join(getMemoryBaseDir(), QIANMO_MEMORY_DIRNAME)
}

/**
 * The directory holding one scope's entries. The path *is* the primary key of
 * the layer's table, which is what makes the three layers three tables rather
 * than one table with a discriminator column.
 */
export function scopeDir(root: string, scope: MemoryScope): string {
  validateScope(scope)
  switch (scope.layer) {
    case 'working':
      return join(root, 'working', scope.projectKey, scope.taskId)
    case 'project':
      return join(root, 'project', scope.projectKey)
    case 'baseline':
      return join(root, 'baseline', scope.period)
  }
}

export function entryPath(
  root: string,
  scope: MemoryScope,
  id: string,
): string {
  return join(scopeDir(root, scope), `${id}.md`)
}
