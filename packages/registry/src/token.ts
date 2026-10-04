// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The registry write token (tenancy-m1.md P15.8): one shared secret that every
 * write to the HTTP v0 surface must present, held by the registry host and by
 * the console's renewer and nobody else.
 *
 * Reads stay open. The table is discovery, not a secret, and every node polls
 * it; the thing this closes is the other direction — anyone who could reach the
 * loopback port being able to register, deregister or renew any address.
 *
 * Both ends read the token from a file through {@link readRegistryWriteTokenFile},
 * so the two cannot disagree about what a well-formed token file is.
 */

import { timingSafeEqual } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'

/** Same floor as the console tokens and the witness tokens. */
const MIN_REGISTRY_WRITE_TOKEN_LENGTH = 16

/**
 * Group and other get nothing: `0600` and `0400` pass, `0640` and `0644` do
 * not. Owner-execute is not checked — it leaks nothing, and refusing it only
 * makes a host with an odd umask fail to start for no reason.
 */
const FORBIDDEN_MODE_BITS = 0o077

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Throw unless `token` is long enough to be a secret. */
export function assertRegistryWriteToken(token: string, what: string): void {
  if (token.length < MIN_REGISTRY_WRITE_TOKEN_LENGTH) {
    throw new Error(
      `${what} must be at least ${String(MIN_REGISTRY_WRITE_TOKEN_LENGTH)} characters`,
    )
  }
}

/**
 * Read a write-token file, refusing one that anybody but its owner can read.
 *
 * Opened once and checked through the same descriptor it is read from, so the
 * mode check and the read cannot be split across two different files by a
 * symlink swapped in between (the console's token files do the same).
 * Surrounding whitespace, including the trailing newline `printf '%s\n'`
 * leaves, is dropped.
 *
 * `flag` names the option in every error, so the operator is told which of
 * their own arguments to fix.
 */
export function readRegistryWriteTokenFile(path: string, flag: string): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw new Error(`${flag} ${path} cannot be read: ${reasonOf(error)}`)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new Error(`${flag} ${path} is not a regular file`)
    }
    // Windows reports mode bits that do not correspond to its ACLs; checking
    // them there would make this option unusable rather than safer.
    const mode = stat.mode & 0o777
    if (process.platform !== 'win32' && (mode & FORBIDDEN_MODE_BITS) !== 0) {
      throw new Error(
        `${flag} ${path} is readable beyond its owner (mode ${mode
          .toString(8)
          .padStart(4, '0')}); run \`chmod 600\` on it`,
      )
    }
    const token = readFileSync(fd, 'utf8').trim()
    if (token === '') throw new Error(`${flag} ${path} is empty`)
    assertRegistryWriteToken(token, `${flag} ${path}`)
    return token
  } finally {
    closeSync(fd)
  }
}

/** Constant-time comparison of a presented bearer token with the expected one. */
export function registryWriteTokenMatches(
  presented: string,
  expected: string,
): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}
