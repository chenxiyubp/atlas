/**
 * Single source of truth for this product's identity.
 *
 * Every user-visible name, the npm package the updater targets, and the
 * repository URL come from here. Before this module those strings were spread
 * across ~40 files, which is how `ccb --resume` ended up hardcoded in six
 * different places and how the self-updater came to point at three different
 * packages at once.
 *
 * ── What must NOT be renamed ──────────────────────────────────────────────
 *
 * Some strings look like branding and are load-bearing protocol. Changing them
 * breaks things in ways that are slow to diagnose, so they are deliberately
 * absent from this file:
 *
 *   - The system prompt's "You are Claude Code, Anthropic's official CLI for
 *     Claude" preamble (src/constants/prompts.ts). Anthropic's prompt caching
 *     and behaviour tuning key off that exact text.
 *   - The `claude-code/<version>` User-Agent (src/utils/userAgent.ts, 26 call
 *     sites). Anthropic-side rate limiting and eligibility read it.
 *   - The OTel `service.name: 'claude-code'` used by existing dashboards.
 *   - `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` filenames — an ecosystem
 *     convention shared with other tools.
 *   - `CLAUDECODE=1` in child process env: the cross-tool hints protocol.
 *
 * Path and directory identity lives in `src/config/paths.ts`, not here.
 *
 * ── Identity switching ────────────────────────────────────────────────────
 *
 * The three names below are identity-scoped: they carry occ's default value or
 * the Qianmo node's variant depending on `OCC_IDENTITY`, resolved once at load
 * by `byIdentity` (src/constants/identity.ts, a zero-import module so this file
 * stays lightweight for the keychain prefetch). Every one of BIN_NAME's ~78
 * consumers keeps importing the same symbol and transparently gets the right
 * value. The names below the divider are NOT switched — see their comments.
 *
 * `invokedBinName()` sits alongside BIN_NAME and answers a different question —
 * "what did the user actually type" rather than "what am I" — for help text
 * only. It is NOT an identity input; read its comment before reaching for it.
 */

import { byIdentity } from './identity.js'

/** The command users type. Also the process title and socket prefix. */
export const BIN_NAME = byIdentity({ occ: 'occ', qianmo: 'qm' })

/**
 * Every name package.json's `bin` block installs.
 *
 * A whitelist rather than "whatever argv[1] happens to end with", because this
 * feeds user-facing prose: `node dist/cli-node.js` must not produce
 * "Usage: cli-node.js console", and neither must a wrapper script someone
 * named `deploy.sh`. Only a name we actually ship may be echoed back.
 *
 * A Set rather than an object literal so `constructor` and `toString` cannot
 * masquerade as bin names.
 */
const INSTALLED_BIN_NAMES: ReadonlySet<string> = new Set([
  'occ',
  'occ-bun',
  'open-claude-code',
  'qm',
])

/**
 * The name this process was ACTUALLY invoked as — for display only.
 *
 * `BIN_NAME` answers "which namespace am I", and it must keep answering that:
 * it is the process title and the socket prefix, so letting it follow argv
 * would mean one installation reached through two names produces two socket
 * prefixes and can no longer find itself. This function answers "what did the
 * user type", which is the right question for a usage line and the wrong one
 * for anything else.
 *
 * The two answers differ exactly when the env var and the command disagree:
 * `OCC_IDENTITY=qianmo occ console --help` must say `occ console`, because that
 * is the line the reader can retype. Printing `qm console` there would be an
 * instruction to run a command whose own help text then disagrees with it.
 *
 * NOT an identity input. It used to be — argv[1]'s basename seeded
 * `IDENTITY_MODE` for one revision — and that was withdrawn on purpose: the
 * signal disappears on three separate paths (Bun resolves a symlinked entry
 * before filling argv[1]; a Windows `.cmd` shim passes the .js path; a
 * bundled-mode child gets a CLI arg in that slot), and an identity that is
 * right only sometimes is worse than one that is always explicit. `qm` pins
 * its identity in its own entrypoint file instead — see
 * scripts/entrypoints.ts. Nothing but display may depend on this.
 *
 * Falls back to `BIN_NAME` whenever argv names nothing installed — which now
 * includes `qm` itself, since its entrypoint runs under Bun and argv[1] arrives
 * as `.../dist/cli-qianmo.js`. The fallback is correct there for the same
 * reason it is correct in a dev checkout: the identity's own name is the best
 * available guess, and it is what these strings said before this existed.
 */
export function invokedBinName(): string {
  const entry = process.argv[1]
  if (entry === undefined) return BIN_NAME
  const cut = Math.max(entry.lastIndexOf('/'), entry.lastIndexOf('\\'))
  const base = cut === -1 ? entry : entry.slice(cut + 1)
  return INSTALLED_BIN_NAMES.has(base) ? base : BIN_NAME
}

/** Full product name, for prose and package metadata. */
export const PRODUCT_NAME = byIdentity({
  occ: 'open-claude-code',
  qianmo: 'qianmo',
})

/** Display name, for banners and dialogs. */
export const DISPLAY_NAME = byIdentity({
  occ: 'Open Claude Code',
  qianmo: 'Qianmo Node',
})

/**
 * The npm package the self-updater installs from.
 *
 * This MUST match the `name` field in package.json. Three separate places used
 * to disagree about it — `updateOcc.ts` (né `updateCCB.ts`) said
 * `claude-code-best`, `autoUpdater` read an empty `MACRO.PACKAGE_URL`, and
 * `rollback.ts` hardcoded Anthropic's `@anthropic-ai/claude-code`, meaning
 * "rolling back" installed a different product over the user's binary.
 *
 * NOT switched by identity: M0 Qianmo nodes do not self-update (they are
 * launched programmatically, not installed from npm), so the updater target
 * stays occ's package regardless of `OCC_IDENTITY`.
 */
export const NPM_PACKAGE_NAME = '@sweetcornna/open-claude-code'

/**
 * OS-level deep-link identity owned exclusively by occ.
 *
 * NOT switched by identity: M0 Qianmo nodes register no OS deep-link handler,
 * so these keep occ's values. If a node ever needs its own scheme, add a
 * `byIdentity` variant here rather than a second hardcoded string.
 */
export const DEEP_LINK_PROTOCOL = 'occ-cli'
export const MACOS_DEEP_LINK_BUNDLE_ID =
  'io.github.sweetcornna.open-claude-code-url-handler'
