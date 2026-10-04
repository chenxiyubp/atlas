// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the offline CA keeps its material (`key-distribution.md` §6.1).
 *
 * ## The one deliberate exception to CLAUDE.md §1.1②
 *
 * Every other user-level path in this repository is derived from
 * `src/config/paths.ts`. This one is NOT, and §6.1 spells out why in one
 * sentence: the CA private key must not live in *any* identity's config root.
 * §3.3 lists the places it is forbidden to appear — a node's config root and
 * everything derived from it, `DEMO_ROOT`, the repository, CI secrets, and
 * anything the console process can reach — and "under `occConfigPath(...)`" is
 * the first of those. Deriving this path from `paths.ts` would put it there.
 *
 * So the exception is the point, not an oversight, and the guard below makes
 * it enforceable rather than merely commented: {@link caDirectory} refuses any
 * directory that resolves inside a protected config root. The next person to
 * "顺手统一" this module will get a thrown error, not a silently relocated CA.
 *
 * ## Everything else here is a literal, and that is on purpose too
 *
 * §10.3 asks for a scan in the shape of `check:identity-paths`: CA directory
 * literals must not appear in node-side code. That is only checkable if there
 * is exactly one file where they DO appear — this one. `__tests__/caScan.test.ts`
 * is the scan; the allowlist there names this file.
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { NODE_IDENTITY_MODE } from '../../../constants/identity.js'
import { getProtectedUserConfigDirectories } from '../../../config/paths.js'

/**
 * Override for the CA root.
 *
 * Named alongside the rest of the Qianmo environment surface
 * (`QIANMO_CONSOLE_ADMIN_TOKEN`, `QIANMO_TRANSPORT_PSK`, …) so an operator who
 * knows one knows where to look for this one.
 */
export const CA_DIR_ENV_VAR = 'QIANMO_CA_DIR'

/**
 * Default CA root basename: `.qianmo-ca` under the home directory.
 *
 * Built from the identity roster rather than spelled out, because
 * CLAUDE.md §2.3 allows the network's name to be written exactly once
 * (`src/constants/identity.ts`). The `-ca` suffix keeps it a *sibling* of
 * `~/.qianmo`, never a child: a child would be inside the node's config root,
 * which is precisely what §3.3 forbids.
 */
const CA_DIR_BASENAME = `.${NODE_IDENTITY_MODE}-ca`

/**
 * How the default is written in help text.
 *
 * Exported so the CLI can name it without spelling the basename a second time
 * — §10.3's scan treats a CA directory literal outside this file as a failure,
 * and "it was only in a help string" is exactly the kind of exception that
 * makes a zero-tolerance scan stop being zero-tolerance.
 */
export const CA_DIR_DEFAULT_DISPLAY = `~/${CA_DIR_BASENAME}`

/** Directory mode for everything the CA writes. Private key material lives here. */
export const CA_DIR_MODE = 0o700

/**
 * File mode for private material. Passed at creation, never chmod-ed
 * afterwards — a window in which a private key is world-readable is still a
 * window (§3.3, same discipline as `nodeIdentity.ts`).
 */
export const CA_PRIVATE_FILE_MODE = 0o600

/** File mode for public material: certificates, the signed RL, the serial. */
export const CA_PUBLIC_FILE_MODE = 0o644

/** Comparison key for the host filesystem's path identity rules. */
export function pathComparisonKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

/** True when `candidate` is `root` itself or sits underneath it. */
export function isPathInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Compared with a separator appended, because `~/.qianmo-ca` starts with
  // `~/.qianmo` as a raw string while being a different directory entirely.
  const candidateKey = pathComparisonKey(candidate, platform)
  const rootKey = pathComparisonKey(root, platform)
  const separator = platform === 'win32' ? '\\' : sep
  return (
    candidateKey === rootKey ||
    candidateKey.startsWith(`${rootKey}${separator}`)
  )
}

/**
 * Canonicalize through the closest existing ancestor, then restore missing
 * components. This catches both a symlinked leaf and a symlink hidden higher
 * in a not-yet-created CA path. Failure to resolve an existing ancestor is a
 * refusal: guessing at a physical boundary would turn a permission error into
 * a path-guard bypass.
 *
 * This is a check-time canonicalization, not a promise that another process
 * cannot replace a path after it returns. The offline CA command performs it
 * immediately before its writes and makes no stronger TOCTOU claim.
 */
function physicalPath(path: string): string {
  let existing = resolve(path)
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    missing.unshift(basename(existing))
    existing = parent
  }
  const physicalExisting = realpathSync.native(existing)
  return missing.reduce(
    (current, segment) => join(current, segment),
    physicalExisting,
  )
}

/** Find a checkout around `start`, rather than assuming it is the current cwd. */
function repositoryRoot(start: string): string | undefined {
  let current = physicalPath(start)
  while (true) {
    // `.git` is a directory in a main checkout and a file in a worktree; the
    // existence check intentionally covers both forms. `package.json` keeps a
    // random parent repository from becoming this command's protected root.
    if (
      existsSync(join(current, '.git')) &&
      existsSync(join(current, 'package.json'))
    )
      return physicalPath(current)
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Roots that must never contain an offline CA key besides product config.
 *
 * A configured demo or CI checkout is operationally reachable by the process
 * running this command, so it has the same secret-exposure boundary as the
 * source checkout. Environment values are treated as paths only when nonempty
 * — CI providers commonly export empty placeholders.
 */
function protectedOperationalDirectories(candidate: string): string[] {
  const configured = [
    repositoryRoot(process.cwd()),
    // CA commands may be invoked from another directory. Detect the checkout
    // around the requested destination too, or `cd /tmp && qm ca init
    // --ca-dir <repo>/.ca` would bypass the source-tree boundary.
    repositoryRoot(candidate),
    process.env['QIANMO_DEMO_ROOT'],
    process.env['DEMO_ROOT'],
    process.env['GITHUB_WORKSPACE'],
    process.env['CI_PROJECT_DIR'],
    process.env['BUILDKITE_BUILD_CHECKOUT_PATH'],
    process.env['WORKSPACE'],
    process.env['BUILD_WORKSPACE_DIRECTORY'],
  ]
  return configured
    .filter((root): root is string => root !== undefined && root.length > 0)
    .map(root => physicalPath(root))
}

/**
 * The CA root: `$QIANMO_CA_DIR`, or `~/.qianmo-ca`.
 *
 * Throws when the resolved directory lands inside a protected config root
 * (§3.3). That check is cheap and it is the only mechanical defence against
 * the failure this module is built to prevent — a CA private key sitting
 * inside a directory that a node process, the console, or `occ migrate` walks.
 */
export function caDirectory(explicit?: string): string {
  const configured = explicit ?? process.env[CA_DIR_ENV_VAR]
  const directory = resolve(
    configured === undefined || configured.length === 0
      ? join(homedir(), CA_DIR_BASENAME)
      : configured,
  )
  const physicalDirectory = physicalPath(directory)
  for (const protectedRoot of getProtectedUserConfigDirectories()) {
    if (isPathInside(physicalDirectory, physicalPath(protectedRoot))) {
      throw new Error(
        `refusing a CA directory inside a config root: ${directory} is under ` +
          `${protectedRoot}. The CA private key must not live in any ` +
          `identity's config root (key-distribution.md §3.3).`,
      )
    }
  }
  for (const protectedRoot of protectedOperationalDirectories(directory)) {
    if (isPathInside(physicalDirectory, protectedRoot)) {
      throw new Error(
        `refusing a CA directory inside a repository, demo, or CI workspace: ` +
          `${directory} is under ${protectedRoot}. The CA private key must ` +
          `stay outside paths this process can publish or clean.`,
      )
    }
  }
  return directory
}

/** The CA's Ed25519 private key, PEM. Never leaves this machine. */
export function caKeyPath(directory: string): string {
  return join(directory, 'ca.key')
}

/** The self-signed root certificate, PEM. Public material. */
export function caCertPath(directory: string): string {
  return join(directory, 'ca.crt')
}

/** openssl's serial file, kept beside the key so `-CAcreateserial` is stable. */
export function caSerialPath(directory: string): string {
  return join(directory, 'ca.srl')
}

/**
 * The certificate most recently issued to `node`.
 *
 * Only the latest one: a re-issue (`ca issue --replace`) replaces this file.
 * The fingerprints of the ones it replaced live on in the ledger below, which
 * is what a later revocation or a compromise review actually needs.
 */
export function issuedCertPath(directory: string, node: string): string {
  return join(directory, 'issued', `${node}.crt`)
}

/**
 * Every certificate this CA has handed out, one JSON line each, append-only.
 *
 * The one place a superseded certificate's fingerprint survives, and the list
 * a compromise review compares the registry against (ca-runbook.md §6.3):
 * a certificate the ledger does not name was not issued by this tool.
 */
export function issuanceLedgerPath(directory: string): string {
  return join(directory, 'issued-ledger.jsonl')
}

/** Held for the whole of one `ca issue`, so two runs cannot interleave. */
export function issueLockPath(directory: string): string {
  return join(directory, 'issue.lock')
}

/**
 * True when `path` lands inside the CA directory once symlinks are resolved.
 *
 * `ca issue --out` must never write there: a certificate written over
 * `ca.key` destroys the only copy of the private key, and one written over
 * another node's copy or the ledger loses exactly the record that file keeps.
 */
export function isInsideCaDirectory(path: string, directory: string): boolean {
  return isPathInside(physicalPath(path), physicalPath(directory))
}

/**
 * The operator's accumulated revocation entries — the *input* to `refresh-rl`.
 *
 * Separate from the signed artefact below because they are different things:
 * this one is the CA's memory of what has been revoked, the other is a dated,
 * signed statement about it that expires (§6.2, `nextUpdate` = 30 days).
 */
export function revocationStatePath(directory: string): string {
  return join(directory, 'revoked.json')
}

/** The signed revocation list, published to the registry (§6.4). Public. */
export function revocationListPath(directory: string): string {
  return join(directory, 'revocation-list.json')
}
