// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a node's Ed25519 key pair lives, and how it gets there (P4.3).
 *
 * `@qianmo/capability` deliberately owns no path convention, so this is the
 * file that does — and it derives every byte of the path from
 * `src/config/paths.ts` rather than joining `~/.occ` by hand (CLAUDE.md §1.1②).
 * That is not ceremony here: the Qianmo node identity is exactly the thing that
 * must not leak into the base's or the official CLI's config root, and a
 * hardcoded path is the one mechanism by which that isolation has actually
 * failed before.
 *
 * ## Load-or-create, and why the first writer wins
 *
 * A node's key *is* its identity: replacing it silently would invalidate every
 * capability it has issued and every published copy of its public key. So the
 * file is created exclusively (`wx`) and never overwritten. Two processes
 * racing to create one end with the same key, because the loser re-reads the
 * winner's file instead of clobbering it.
 *
 * ## Permissions
 *
 * Directory `0700`, file `0600`, and the mode is passed at creation rather than
 * chmod-ed afterwards — a window in which a private key is world-readable is
 * still a window. Same discipline as the acceptance artefacts in P1.3/P3.1.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isNodePublicKey } from '@qianmo/protocol'
import {
  generateNodeKeyPair,
  isNodeKeyPair,
  type NodeKeyPair,
} from '@qianmo/capability'
import { occConfigPath } from '../../config/paths.js'

/** On-disk shape. Versioned so a future format is a migration, not a surprise. */
interface StoredIdentity {
  readonly version: 1
  readonly node: string
  readonly publicKey: string
  readonly privateKey: string
  readonly createdAt: number
}

/** Absolute path of `node`'s identity file, derived from the config root. */
export function nodeIdentityPath(node: string): string {
  return occConfigPath('qianmo', 'identity', `${node}.json`)
}

/**
 * Where `qm cert request` writes the node's TLS material (key-distribution.md
 * §4.1's table): same directory as the Ed25519 identity file, `.tls.key` /
 * `.tls.crt` / `.tls.csr` siblings rather than a second directory. The three
 * pieces are not one lifecycle — the key and CSR are generated together and
 * never re-read once the CSR is handed to the CA, while the certificate
 * arrives later, out of band, once `qm ca issue` has run — but they are all
 * "this node's TLS identity", and putting them beside `<node>.json` is what
 * keeps that legible on disk rather than scattered across two trees.
 */
export function nodeTlsKeyPath(node: string): string {
  return occConfigPath('qianmo', 'identity', `${node}.tls.key`)
}

/** Where `qm cert request` writes the CSR it generated, for handoff to the CA. */
export function nodeTlsCsrPath(node: string): string {
  return occConfigPath('qianmo', 'identity', `${node}.tls.csr`)
}

/**
 * Where a resident node's own issued certificate lives once the operator has
 * copied it back from the CA (§6.1's "certificate ... 交付给该节点"). Not
 * written by `qm cert request` — that command only gets as far as the CSR;
 * this path is where `--cert` points by convention when nothing else is given.
 */
export function nodeTlsCertificatePath(node: string): string {
  return occConfigPath('qianmo', 'identity', `${node}.tls.crt`)
}

function parseStored(raw: string, node: string): NodeKeyPair | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const stored = parsed as Partial<StoredIdentity>
  if (stored.version !== 1 || stored.node !== node) return null
  const pair = { publicKey: stored.publicKey, privateKey: stored.privateKey }
  return isNodeKeyPair(pair) ? pair : null
}

/**
 * Read this node's key pair, creating one on first run.
 *
 * A file that exists but does not parse is an error rather than a reason to
 * mint a replacement: overwriting it would turn "the identity file got
 * corrupted" into "this node quietly became a different node", and the second
 * failure is far harder to see from the outside.
 */
export function loadOrCreateNodeKeys(node: string): NodeKeyPair {
  const path = nodeIdentityPath(node)
  let existing: string | null = null
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = null
  }
  if (existing !== null) {
    const parsed = parseStored(existing, node)
    if (parsed === null) {
      throw new Error(
        `node identity at ${path} is unreadable or belongs to another node; refusing to replace it`,
      )
    }
    return parsed
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const created = generateNodeKeyPair()
  const document: StoredIdentity = {
    version: 1,
    node,
    publicKey: created.publicKey,
    privateKey: created.privateKey,
    createdAt: Date.now(),
  }
  try {
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    return created
  } catch {
    // Lost the race, or the file appeared between the read and the write. The
    // winner's key is the node's key; ours was never published to anyone.
    const raced = parseStored(readFileSync(path, 'utf8'), node)
    if (raced === null) {
      throw new Error(`node identity at ${path} could not be created or read`)
    }
    return raced
  }
}

/**
 * Read a node's already-established public key without ever creating or
 * replacing an identity. Verification must not turn a missing identity into a
 * new trust root.
 */
export function readNodePublicKey(node: string): string | null {
  try {
    return (
      parseStored(readFileSync(nodeIdentityPath(node), 'utf8'), node)
        ?.publicKey ?? null
    )
  } catch {
    return null
  }
}

/**
 * Parse `--trust node=publicKey` pairs into directory entries.
 *
 * Explicit and repeatable, with no trust-on-first-use anywhere behind it:
 * learning a key from the first peer that claims it would let whoever speaks
 * first *become* that node.
 */
export function parseTrustedKey(raw: string): readonly [string, string] {
  const equals = raw.indexOf('=')
  if (equals <= 0) {
    throw new Error(`--trust expects <node>=<publicKey>, got ${raw}`)
  }
  const node = raw.slice(0, equals)
  const publicKey = raw.slice(equals + 1)
  if (!isNodePublicKey(publicKey)) {
    throw new Error(`--trust public key for ${node} is not a valid Ed25519 key`)
  }
  return [node, publicKey]
}
