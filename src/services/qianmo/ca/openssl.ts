// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one place this repository shells out to `openssl`.
 *
 * §6.1 fixes the shape: the signing tool is host-side and openssl is an
 * external command on the CA operator's machine, NOT a runtime dependency of
 * any `@qianmo/*` package. Node-side verification needs none of this — F-2
 * showed `node:crypto` can already answer "is this certificate ours" with zero
 * dependencies, so the asymmetry is deliberate: the expensive tool lives where
 * exactly one person runs it, and the cheap check lives everywhere.
 *
 * ## Why a missing binary gets a paragraph instead of ENOENT
 *
 * This command is run by an operator following a runbook, on a machine that is
 * deliberately not a node and therefore has no reason to have been provisioned
 * like one. `spawn openssl ENOENT` tells that person nothing they can act on.
 */

import { spawnSync } from 'node:child_process'

/**
 * Override for the openssl executable.
 *
 * Not paranoia: macOS ships LibreSSL under the name `openssl` on some systems,
 * and LibreSSL's `genpkey -algorithm ed25519` is not the same command. When
 * the default binary turns out not to be OpenSSL, pointing this at
 * `/opt/homebrew/opt/openssl@3/bin/openssl` is the fix, and it is a great deal
 * easier to explain than "edit your PATH".
 */
export const OPENSSL_BIN_ENV_VAR = 'QIANMO_OPENSSL_BIN'

const DEFAULT_OPENSSL_BIN = 'openssl'

/** What the CA tool needs and where to get it, per platform. */
function installHint(): string {
  switch (process.platform) {
    case 'darwin':
      return (
        'install it with `brew install openssl@3` and, if the system binary ' +
        `still wins, point ${OPENSSL_BIN_ENV_VAR} at ` +
        '`/opt/homebrew/opt/openssl@3/bin/openssl`'
      )
    case 'win32':
      return (
        'install it with `winget install ShiningLight.OpenSSL` or use the ' +
        `openssl shipped with Git for Windows, then point ${OPENSSL_BIN_ENV_VAR} at it`
      )
    default:
      return (
        'install it with `apt-get install openssl` / `dnf install openssl` ' +
        '(or your distribution’s equivalent)'
      )
  }
}

/** The executable this process will run. */
function opensslBin(): string {
  const configured = process.env[OPENSSL_BIN_ENV_VAR]
  return configured === undefined || configured.length === 0
    ? DEFAULT_OPENSSL_BIN
    : configured
}

/** Raised when openssl is absent, unusable, or exits non-zero. */
export class OpensslError extends Error {}

/**
 * `openssl <args>`, with stdout captured.
 *
 * `input` is written to stdin, which is how a CSR reaches `req -verify`
 * without a temporary file. Output is text in every call site here (PEM and
 * openssl's own reports), so the encoding is fixed rather than a parameter.
 */
export function runOpenssl(
  args: readonly string[],
  options: { readonly input?: string; readonly cwd?: string } = {},
): string {
  const bin = opensslBin()
  const result = spawnSync(bin, [...args], {
    encoding: 'utf8',
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // A CA run that hangs is worse than one that fails: the operator is at a
    // terminal waiting for a certificate, and openssl only ever blocks here
    // when it is prompting for something we failed to pass.
    timeout: 60_000,
  })

  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new OpensslError(
        `\`${bin}\` was not found on PATH. The Qianmo CA tool signs ` +
          `certificates with openssl — ${installHint()}.`,
      )
    }
    throw new OpensslError(`could not run \`${bin}\`: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim()
    throw new OpensslError(
      `\`${bin} ${args.join(' ')}\` failed with status ` +
        `${String(result.status)}${detail.length === 0 ? '' : `: ${detail}`}`,
    )
  }

  return result.stdout ?? ''
}

/**
 * openssl's version banner, or `null` when it cannot be run at all.
 *
 * Exists so a test can skip itself with a printed reason instead of failing on
 * a machine that has no openssl — the CA tool is the only thing in this
 * repository that needs one, and a CI image is not required to carry it.
 */
export function opensslVersion(): string | null {
  try {
    return runOpenssl(['version']).trim()
  } catch {
    return null
  }
}
