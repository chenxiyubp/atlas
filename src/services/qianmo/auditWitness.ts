// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Host-side loading for audit witness anchors.
 *
 * `@qianmo/witness` deliberately owns neither CLI flags nor environment
 * variables. This adapter gives the CLI and console one interpretation of a
 * source while leaving the package responsible only for anchor shape, storage
 * and verification.
 */

import { isAbsolute, resolve } from 'node:path'
import {
  FileWitnessAnchorStore,
  remoteWitnessAnchorReader,
  type WitnessEvidence,
} from '@qianmo/witness'
import type { AuditRecord } from '@qianmo/audit'

/** Read-only credential for the witness HTTP endpoint. Never put it in argv. */
export const WITNESS_READ_TOKEN_ENV_VAR = 'QIANMO_WITNESS_READ_TOKEN'

export type AuditWitnessSource =
  | { readonly kind: 'path'; readonly value: string }
  | { readonly kind: 'url'; readonly value: string }

/** Parse the one source form shared by `occ audit` and `occ console`. */
export function parseAuditWitnessSource(
  raw: string,
  flag: '--witness' | '--anchors',
): AuditWitnessSource {
  if (isAbsolute(raw)) return { kind: 'path', value: resolve(raw) }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${flag} must be an absolute path or http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${flag} must be an absolute path or http(s) URL`)
  }
  return { kind: 'url', value: url.toString() }
}

/**
 * A resident writes one local trail. Refusing a mixed-node file is safer than
 * choosing a public key by whichever record happened to be read first.
 */
export function witnessNodeOf(records: readonly AuditRecord[]): string | null {
  const nodes = new Set(
    records.flatMap(record => (record.node === undefined ? [] : [record.node])),
  )
  if (nodes.size === 0) return null
  if (nodes.size !== 1) {
    throw new Error('audit trail contains records from multiple nodes')
  }
  return nodes.values().next().value ?? null
}

/** Read anchors from either the host-owned directory or the read-only endpoint. */
export async function readAuditWitnessAnchors(
  source: AuditWitnessSource,
  node: string,
  readToken = process.env[WITNESS_READ_TOKEN_ENV_VAR],
): Promise<readonly WitnessEvidence[]> {
  if (source.kind === 'path') {
    return await new FileWitnessAnchorStore({ root: source.value }).list(node)
  }
  if ((readToken ?? '').trim() === '') {
    throw new Error(
      `${WITNESS_READ_TOKEN_ENV_VAR} is required for a witness URL`,
    )
  }
  return await remoteWitnessAnchorReader({
    url: source.value,
    token: readToken as string,
  }).list(node)
}
