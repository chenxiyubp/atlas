// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm cert request` — the node-side half of §6.1's certificate row 3.
 *
 * §6.1's table draws the line precisely: "生成节点 EC 密钥 + CSR + PoP" runs
 * **on the node itself**, and its whole output is a CSR plus a proof of
 * possession that get handed to the CA operator (`qm ca issue`, P12.1) — the
 * EC private key never leaves this machine. This file is that half.
 *
 * ## Why this shells out to openssl, and why not to `ca/openssl.ts`
 *
 * F-5 forces the TLS leaf onto an EC key, and `node:crypto` has no CSR
 * (PKCS#10) builder at all — generating one needs an external tool either
 * way, so this reaches for the same one `qm ca` does. It does **not** import
 * `ca/openssl.ts` to do it: `caScan.test.ts`'s reach pattern deliberately
 * names only `ca/pop.ts` and `ca/revocationList.ts` as nodes-may-reach-this
 * modules (its own header says so), and `ca/openssl.ts` is not one of them —
 * on purpose, the same way the CA directory itself is walled off (§3.3). A
 * node process shelling to openssl for its *own* CSR is a different, much
 * smaller privilege than a node process being able to reach the CA's signing
 * plumbing, and keeping them as two separate wrappers is what makes that
 * boundary mechanically checkable rather than a matter of not importing the
 * wrong thing today.
 *
 * ## What does get reached from `ca/`
 *
 * `popMessage` (`ca/pop.ts`) — deliberately node-reachable, per its own
 * module header: "P12.2's `qm cert request` builds its proof of possession
 * with popMessage". Nothing else.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isValidSegment } from '@qianmo/protocol'
import { signBytes, type NodeKeyPair } from '@qianmo/capability'
import { popMessage } from './ca/pop.js'
import {
  loadOrCreateNodeKeys,
  nodeTlsCsrPath,
  nodeTlsKeyPath,
} from './nodeIdentity.js'

/**
 * Override for the openssl executable used by `qm cert request`.
 *
 * A separate variable from `ca/openssl.ts`'s `QIANMO_OPENSSL_BIN`, on
 * purpose: the two commands run on different machines in the model this
 * package assumes (a node, versus the CA operator's offline box), and an
 * operator who symlinks one to a specific build should not be forced to
 * symlink the other identically. The *value* an operator types is typically
 * the same string either way — that is a coincidence of the fix, not a
 * reason to make it one setting behind the CA isolation boundary.
 */
export const CERT_REQUEST_OPENSSL_BIN_ENV_VAR = 'QIANMO_CERT_OPENSSL_BIN'

const DEFAULT_OPENSSL_BIN = 'openssl'

/** Raised when openssl is absent, unusable, or exits non-zero. */
export class CertRequestOpensslError extends Error {}

function opensslBin(): string {
  const configured = process.env[CERT_REQUEST_OPENSSL_BIN_ENV_VAR]
  return configured === undefined || configured.length === 0
    ? DEFAULT_OPENSSL_BIN
    : configured
}

/** `openssl <args>`, stdin optional, stdout captured as text. */
function runOpenssl(
  args: readonly string[],
  options: { readonly input?: string } = {},
): string {
  const bin = opensslBin()
  const result = spawnSync(bin, [...args], {
    encoding: 'utf8',
    ...(options.input === undefined ? {} : { input: options.input }),
    timeout: 60_000,
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    throw new CertRequestOpensslError(
      code === 'ENOENT'
        ? `\`${bin}\` was not found on PATH. \`qm cert request\` needs ` +
            `openssl to build a CSR — install it, or point ` +
            `${CERT_REQUEST_OPENSSL_BIN_ENV_VAR} at one.`
        : `could not run \`${bin}\`: ${result.error.message}`,
    )
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim()
    throw new CertRequestOpensslError(
      `\`${bin} ${args.join(' ')}\` failed with status ` +
        `${String(result.status)}${detail.length === 0 ? '' : `: ${detail}`}`,
    )
  }
  return result.stdout ?? ''
}

/**
 * What `generateNodeCertificateRequest` produced, ready for handoff to the CA.
 *
 * Deliberately not exported: it is this module's return shape, and every
 * consumer reaches it through the function rather than by name. Exporting a
 * type nobody imports is the dead surface `check:unused` ratchets on, and the
 * same reasoning `ca/` applies to its own option interfaces.
 */
interface NodeCertificateRequest {
  /** Where the EC private key was written. Never handed to anyone. */
  readonly keyPath: string
  /** Where the CSR was written, for the operator to attach to `qm ca issue`. */
  readonly csrPath: string
  readonly csrPem: string
  /** Ed25519 signature over `popMessage(node, csrPem)` (§4.3). */
  readonly popSignature: string
  /** This node's Ed25519 public key — `qm ca issue --nodekey` wants exactly this. */
  readonly publicKey: string
  readonly hosts: readonly string[]
}

/**
 * Generate a fresh EC key and CSR for `node`, and prove this node holds its
 * own Ed25519 identity key over that CSR (§4.3's PoP).
 *
 * The EC key is **not** the identity key: unlike `loadOrCreateNodeKeys`'s
 * write-once file, this one is overwritten on every run without ceremony.
 * §6.2 says as much — "每次重签用新 EC 密钥" — a fresh CSR is the normal way
 * to ask for a certificate, whether this is the node's first one or its
 * fifth quarterly rotation. What must never be silently replaced is the
 * Ed25519 identity (`loadOrCreateNodeKeys`, unchanged here), because that is
 * what every past and future certificate is *about*.
 */
export function generateNodeCertificateRequest(options: {
  readonly node: string
  readonly hosts: readonly string[]
  /** Injected for tests; production always uses the node's real identity. */
  readonly keys?: NodeKeyPair
}): NodeCertificateRequest {
  const { node, hosts } = options
  if (!isValidSegment(node)) {
    throw new Error(`invalid node segment: ${String(node)}`)
  }
  if (hosts.length === 0) {
    // Same F-9 reasoning `qm ca issue` enforces, caught one step earlier: a
    // CSR built for no host at all would only fail later, on the CA
    // operator's machine, with no context about which node asked for it.
    throw new Error(
      '--host is required: the certificate issued from this CSR would have ' +
        'no DNS:/IP: SAN and no client could ever dial it (key-distribution.md F-9)',
    )
  }

  const keys = options.keys ?? loadOrCreateNodeKeys(node)
  const keyPath = nodeTlsKeyPath(node)
  const csrPath = nodeTlsCsrPath(node)

  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  const ecKeyPem = runOpenssl([
    'ecparam',
    '-name',
    'prime256v1',
    '-genkey',
    '-noout',
  ])
  writeFileSync(keyPath, ecKeyPem, { encoding: 'utf8', mode: 0o600 })

  const csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    keyPath,
    '-subj',
    `/CN=${node}`,
  ])
  writeFileSync(csrPath, csrPem, { encoding: 'utf8', mode: 0o644 })

  const popSignature = signBytes(keys, popMessage(node, csrPem))

  return {
    keyPath,
    csrPath,
    csrPem,
    popSignature,
    publicKey: keys.publicKey,
    hosts,
  }
}
