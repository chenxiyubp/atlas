/**
 * Single source of truth for every path open-claude-code (occ) reads or writes.
 *
 * WHY THIS EXISTS
 *
 * occ is a separate product from Anthropic's official Claude Code, and the two
 * must be able to run on the same machine without touching each other's state.
 * Before this module the fork shared essentially the whole official namespace:
 * `~/.claude/`, `~/.claude.json`, the `claude-cli` cache tree, the XDG
 * `claude/` install tree, and — worst of all — the same macOS keychain entry,
 * so logging into one CLI could overwrite the other's OAuth token.
 *
 * Every path must be derived here. Do not write `join(homedir(), '.claude')`
 * or `join(homedir(), '.occ')` anywhere else: nine such call sites existed
 * before this module and every one of them silently ignored the config-dir
 * override, which is why `CLAUDE_CONFIG_DIR` isolation was already leaky.
 *
 * ENV PRECEDENCE
 *
 * `OCC_CONFIG_DIR` is the canonical override. `CLAUDE_CONFIG_DIR` is still
 * honoured as a deprecated fallback so that existing scripts, CI jobs and the
 * ~50 test files that set it keep working; it will be dropped in a later
 * release. Neither is consulted if the caller passes an explicit path.
 */

import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join, resolve } from 'path'
import {
  acrossIdentities,
  byIdentity,
  type IdentityValues,
} from '../constants/identity.js'

/**
 * The directory, cache and global-file basenames below are identity-scoped:
 * `.occ` / `occ` by default, `.qianmo` / `qianmo` when `OCC_IDENTITY=qianmo`.
 * `byIdentity` (src/constants/identity.ts) resolves the active value once at
 * load, so occConfigDir()'s ~140 callers switch namespaces without any edit.
 * The `LEGACY_*` names below are NOT switched — they always name the official
 * Claude Code directory, which every identity reads (read-only) for migration.
 *
 * TWO KINDS OF ANSWER, AND THEY ARE NOT THE SAME
 *
 * "Which directory do I own?" is `byIdentity` — one value, the active one.
 * "Which directories must nothing here ever clobber?" is `acrossIdentities`
 * plus the legacy name — the UNION of all three products' namespaces. Getting
 * that second question wrong is invisible in single-identity testing and
 * defeats the isolation entirely: a Qianmo node whose protection list holds
 * only `.qianmo` and `.claude` will let a sandboxed command rewrite `~/.occ`
 * (which stores `.credentials.json`) and `~/.occ.json`. Both flavours below
 * are derived from the SAME literal pair, so they cannot drift.
 */

/** Per-identity project-config directory basename. Source for both exports below. */
const PROJECT_DIR_NAMES: IdentityValues<string> = {
  occ: '.occ',
  qianmo: '.qianmo',
}

/**
 * Directory name for project-level assets (settings, skills, agents,
 * commands, workflows, mcp.json) discovered by walking up from the cwd.
 *
 * The ACTIVE identity's own directory — use it to read and write our own
 * project state, never to decide what is protected.
 */
export const PROJECT_DIR_NAME = byIdentity(PROJECT_DIR_NAMES)

/**
 * Directory name the official Claude Code uses for the same purpose. Read-only:
 * used by the first-run migration and by compatibility fallbacks, never written.
 */
export const LEGACY_PROJECT_DIR_NAME = '.claude'

/**
 * EVERY project-config root that must stay protected from writes — all
 * identities' plus the official CLI's (`.occ`, `.qianmo`, `.claude`), not just
 * the active one's. All three are executable config (settings, hooks, agents,
 * commands), so writing into any of them is code execution in whichever
 * product owns it, whether or not that product is the one running.
 */
export const PROJECT_CONFIG_DIR_NAMES: readonly string[] = [
  ...acrossIdentities(PROJECT_DIR_NAMES),
  LEGACY_PROJECT_DIR_NAME,
]

/** Per-identity user-level config root basename. Source for both exports below. */
const CONFIG_DIR_BASENAMES: IdentityValues<string> = {
  occ: '.occ',
  qianmo: '.qianmo',
}

/** Basename of the user-level config root, under the home directory. */
export const CONFIG_DIR_BASENAME = byIdentity(CONFIG_DIR_BASENAMES)

/**
 * Re-exported from `src/constants/brand.ts` so path code has one import.
 *
 * The binary name is an isolation concern, not just cosmetics: installing occ
 * under the name `claude` would overwrite the official CLI's binary on PATH.
 * brand.ts imports only the zero-import identity module (identity.ts), so
 * pulling it in here stays safe for the startup keychain prefetch (see
 * macOsKeychainHelpers.ts).
 */
export { BIN_NAME } from '../constants/brand.js'

/**
 * Namespace for the `env-paths` cache tree (`~/.cache/occ-nodejs` on Linux).
 * Was `claude-cli`, i.e. shared with the official CLI.
 */
export const CACHE_NAMESPACE = byIdentity({ occ: 'occ', qianmo: 'qianmo' })

/** Subdirectory used inside the XDG data/cache/state roots. */
export const XDG_SUBDIR = byIdentity({ occ: 'occ', qianmo: 'qianmo' })

/** The official Claude Code config root basename. Read-only, for migration. */
export const LEGACY_CONFIG_DIR_BASENAME = '.claude'

/**
 * The official Claude Code global state file name (`.claude.json`). Read-only:
 * consulted by the first-run migration, never written. Derived from the same
 * literal as the directory basename so the two cannot drift.
 */
export const LEGACY_GLOBAL_CONFIG_FILENAME = `${LEGACY_CONFIG_DIR_BASENAME}.json`

function configDirKey(): string {
  // Memo key must cover both vars, or a test that swaps one would read a
  // stale value cached under the other.
  return `${process.env.OCC_CONFIG_DIR ?? ''}\u0000${process.env.CLAUDE_CONFIG_DIR ?? ''}`
}

/**
 * User-level config root: `~/.occ` unless overridden.
 *
 * Holds settings.json, .credentials.json, projects/, skills/, agents/,
 * commands/, plugins/, mcp.json, logs/, todos/, shell-snapshots/.
 *
 * Memoized because this sits on hot startup paths with ~120 callers.
 */
export const occConfigDir = memoize((): string => {
  const configured = process.env.OCC_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  return (
    configured ? resolve(configured) : join(homedir(), CONFIG_DIR_BASENAME)
  ).normalize('NFC')
}, configDirKey)

/**
 * The official Claude Code config root. Only the first-run migration and
 * `occ doctor` may read this; nothing may ever write to it.
 */
export function legacyClaudeConfigDir(): string {
  return join(homedir(), LEGACY_CONFIG_DIR_BASENAME).normalize('NFC')
}

/** Resolve a path inside the occ config root. */
export function occConfigPath(...segments: string[]): string {
  return join(occConfigDir(), ...segments)
}

/**
 * EVERY user-level config root that must stay protected — this process's own
 * (honouring the config-dir override) plus every other identity's and the
 * official CLI's default root.
 *
 * The other identities' roots are taken at their DEFAULT location under the
 * home directory: an override only ever redirects the process that reads it,
 * so a co-installed occ or Claude Code still keeps its state in `~/.occ` /
 * `~/.claude`. Deduplicated, so the common case (no override) does not list
 * the active root twice.
 */
export function getProtectedUserConfigDirectories(): string[] {
  return [
    ...new Set([
      occConfigDir(),
      ...acrossIdentities(CONFIG_DIR_BASENAMES).map(basename =>
        join(homedir(), basename).normalize('NFC'),
      ),
      legacyClaudeConfigDir(),
    ]),
  ]
}

/** Config roots that sandboxed shell commands must never modify. */
export function getProtectedConfigDirectories(
  workingDirectories: readonly string[],
): string[] {
  const projectDirectories = workingDirectories.flatMap(directory =>
    PROJECT_CONFIG_DIR_NAMES.map(projectConfigDirectory =>
      resolve(directory, projectConfigDirectory),
    ),
  )
  return [
    ...new Set([...getProtectedUserConfigDirectories(), ...projectDirectories]),
  ]
}

/** Per-identity global state file basename. Source for both exports below. */
const GLOBAL_CONFIG_BASENAMES: IdentityValues<string> = {
  occ: '.occ',
  qianmo: '.qianmo',
}

/** Basename of the global state file, without the `.json` extension. */
export const GLOBAL_CONFIG_BASENAME = byIdentity(GLOBAL_CONFIG_BASENAMES)

/**
 * EVERY identity's global state file name — `.occ.json`, `.qianmo.json` and
 * the official CLI's `.claude.json`. These hold mcpServers, per-project state
 * and the OAuth account record, so an edit to any one of them reconfigures
 * whichever product owns it. Protected as a union for the same reason as
 * PROJECT_CONFIG_DIR_NAMES.
 */
export const PROTECTED_GLOBAL_CONFIG_FILENAMES: readonly string[] = [
  ...acrossIdentities(GLOBAL_CONFIG_BASENAMES),
  LEGACY_CONFIG_DIR_BASENAME,
].map(basename => `${basename}.json`)

/**
 * Global state file: `~/.occ.json`, holding mcpServers, per-project state,
 * cached Statsig gates and the OAuth account record.
 *
 * Note the deliberately odd shape, inherited from the original: when no config
 * dir is set this file is a SIBLING of the config directory (`~/.occ.json`
 * next to `~/.occ/`), but when one is set it lives INSIDE it. Preserved so a
 * caller who overrides the dir gets everything in one place.
 *
 * `oauthSuffix` is passed in rather than imported so this module stays free of
 * `src/constants/oauth.ts` — `macOsKeychainHelpers.ts` pulls this file during
 * the startup keychain prefetch and must not drag in extra module init.
 */
export function occGlobalConfigFile(oauthSuffix: string = ''): string {
  const configured = process.env.OCC_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR
  const base = configured ? resolve(configured) : homedir()
  return join(base, `${GLOBAL_CONFIG_BASENAME}${oauthSuffix}.json`)
}
