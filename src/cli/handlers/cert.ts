// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm cert` — the node-side half of §6.1's certificate row 3.
 *
 *   qm cert request --node <node> --host <host> [--host <host> ...]
 *
 * One command, because §6.1 lists exactly one action that happens on a node:
 * build an EC key and a CSR, prove this node holds the Ed25519 identity that
 * CSR should be certified under (§4.3), and hand both to the CA operator.
 * Everything else in the certificate lifecycle — signing (`qm ca issue`,
 * P12.1), loading a peer's certificate out of the registry, checking it
 * against a CA root and a revocation list — is `CertificateDirectory`
 * (`src/services/qianmo/certificateDirectory.ts`) or `qm ca`, not this file.
 *
 * Options are parsed here rather than by Commander, matching `ca.ts`/`audit`:
 * the subcommand registration in `cli/program/commands/qianmo.tsx`
 * deliberately does not replicate option tables, so this file is the only
 * place the flags exist and therefore the only honest place for the help text.
 */

import { invokedBinName } from '../../constants/brand.js'
import {
  CERT_REQUEST_OPENSSL_BIN_ENV_VAR,
  generateNodeCertificateRequest,
  CertRequestOpensslError,
} from '../../services/qianmo/certRequest.js'
import { nodeTlsCertificatePath } from '../../services/qianmo/nodeIdentity.js'
import { residentOptionValue } from './residentArgs.js'

/** `--help` anywhere means help, matching `ca`/`audit` (whole-token). */
export function isQianmoCertHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

export const QIANMO_CERT_HELP_TEXT = `Usage: ${invokedBinName()} cert <command> [options]

The node-side half of the certificate lifecycle: build a CSR for this node
and prove it holds the Ed25519 identity the certificate should back (§4.3).
The EC private key this generates never leaves this machine — only the CSR
and a proof-of-possession signature are meant to travel, to the CA operator.

Commands:

  request                  Generate an EC key + CSR for this node.

Common options:

  -h, --help                Print this and exit.

request:

  --node <segment>          This node's name — must match the identity file
                            already created by \`resident\`/\`resident-wake\`
                            (or created here, on first use).
  --host <host>             Address peers will dial this node at. Repeatable;
                            REQUIRED — a certificate whose SANs miss the
                            dialed host is refused by every client (F-9).

  Writes the EC key and CSR under this node's identity directory and prints
  the exact \`qm ca issue\` command line to run on the CA operator's machine.
  Re-running replaces the EC key and CSR (never the Ed25519 identity) — that
  is the normal way to ask for a certificate, including a quarterly rotation
  (key-distribution.md §6.2).

Environment:

  ${CERT_REQUEST_OPENSSL_BIN_ENV_VAR}   openssl executable, when the one on PATH is not
                            OpenSSL (macOS ships LibreSSL under that name).
  OCC_CONFIG_DIR            Config root the node identity and the written
                            CSR/key are derived from.
`

interface RequestConfig {
  readonly node: string
  readonly hosts: readonly string[]
}

function unknownOption(command: string, arg: unknown): never {
  throw new Error(
    `unknown ${command} option ${String(arg)}` +
      ` (run \`${invokedBinName()} cert --help\` for the list)`,
  )
}

export function parseCertRequestArgs(args: readonly string[]): RequestConfig {
  let node: string | undefined
  const hosts: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--node' || arg?.startsWith('--node=')) {
      const parsed = residentOptionValue(args, index, '--node')
      node = parsed.value
      index = parsed.next
    } else if (arg === '--host' || arg?.startsWith('--host=')) {
      const parsed = residentOptionValue(args, index, '--host')
      hosts.push(parsed.value)
      index = parsed.next
    } else {
      unknownOption('cert request', arg)
    }
  }

  if (node === undefined) throw new Error('cert request needs --node')
  if (hosts.length === 0) {
    throw new Error(
      'cert request needs at least one --host: a certificate whose SANs do ' +
        'not cover the dialed host is refused by every client (F-9)',
    )
  }

  return { node, hosts }
}

function runRequest(args: readonly string[]): void {
  const config = parseCertRequestArgs(args)
  const result = generateNodeCertificateRequest(config)
  const hostFlags = result.hosts.map(host => `--host ${host}`).join(' ')
  process.stdout.write(
    `Wrote a certificate request for ${config.node}\n` +
      `  EC key (never leaves this node)  ${result.keyPath}\n` +
      `  CSR                               ${result.csrPath}\n` +
      `  node public key                   ${result.publicKey}\n\n` +
      'Hand the CSR to the CA operator, who runs (from the CA machine):\n\n' +
      `  ${invokedBinName()} ca issue ${config.node} --csr ${result.csrPath} ` +
      `--pop ${result.popSignature} --nodekey ${result.publicKey} ${hostFlags}\n\n` +
      'The CSR file travels however is convenient (it is not secret); the ' +
      '--pop value above is the proof of possession this command computed ' +
      'and must travel with it unmodified (§4.3).\n\n' +
      // Where the answer goes, named rather than described: §6.1's row 2
      // ends with "交付给该节点", and the operator carrying that file back is
      // the person reading this. The path is derived, never typed twice —
      // `--cert` accepts any path, but this is the one the identity
      // directory expects, next to the key and the CSR above.
      'Copy the certificate the CA hands back to:\n\n' +
      `  ${nodeTlsCertificatePath(config.node)}\n\n` +
      `and start the node with --cert <that path> --key ${result.keyPath}.\n`,
  )
}

/** Entry point. Errors become one line on stderr plus exit 1, never a stack. */
export function runQianmoCert(args: readonly string[]): void {
  if (args.length === 0 || isQianmoCertHelpRequest(args)) {
    process.stdout.write(QIANMO_CERT_HELP_TEXT)
    return
  }
  const [command, ...rest] = args
  try {
    switch (command) {
      case 'request':
        runRequest(rest)
        return
      default:
        throw new Error(
          `unknown cert command ${String(command)} (expected request)`,
        )
    }
  } catch (error) {
    const message =
      error instanceof CertRequestOpensslError || error instanceof Error
        ? error.message
        : String(error)
    process.stderr.write(
      `${invokedBinName()} cert ${String(command)}: ${message}\n`,
    )
    process.exitCode = 1
  }
}
