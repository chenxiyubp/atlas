// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm ca` — the offline certificate authority (`key-distribution.md` §6.1, P12.1).
 *
 *   qm ca init
 *   qm ca issue <node> --csr <file> --pop <sig> --nodekey <key> --host <host>
 *   qm ca refresh-rl [--revoke <node>=<fingerprint>] [--import-from <dir>]
 *   qm ca ledger [--node <node>]
 *
 * Three signing commands because §6.1 lists three actions that happen on the
 * CA machine, and nothing else happens there; `ledger` only reads back what
 * `issue` recorded. Everything a *node* does with
 * certificates — loading them, checking them, reading a peer's public key out
 * of one — needs no CA and no openssl (F-2), and lands in P12.2.
 *
 * ## Why this is a host-side command and not a `@qianmo/*` API
 *
 * §6.1's first hard constraint: the signing tool is host-side and openssl is
 * an external command on one operator's machine, not a runtime dependency of
 * the network. `__tests__/caScan.test.ts` is what keeps that true — it fails
 * if any package or node-side module reaches for the CA directory or openssl.
 *
 * Options are parsed here rather than by Commander, exactly as `audit` does:
 * the subcommand registration in `cli/program/commands/qianmo.tsx` deliberately
 * does not replicate option tables, so this file is the only place the flags
 * exist and therefore the only honest place for the help text.
 */

import { readFileSync } from 'node:fs'
import { invokedBinName } from '../../constants/brand.js'
import {
  formatIssuanceRecord,
  readIssuanceLedger,
} from '../../services/qianmo/ca/ledger.js'
import {
  CA_ROOT_DAYS,
  NODE_CERT_DAYS,
  initCa,
  issueCertificate,
  refreshRevocationList,
  type RevocationRequest,
} from '../../services/qianmo/ca/operations.js'
import {
  OPENSSL_BIN_ENV_VAR,
  OpensslError,
} from '../../services/qianmo/ca/openssl.js'
import {
  CA_DIR_DEFAULT_DISPLAY,
  CA_DIR_ENV_VAR,
  caDirectory,
} from '../../services/qianmo/ca/paths.js'
import { REVOCATION_LIST_VALID_MS } from '../../services/qianmo/ca/revocationList.js'
import { residentOptionValue } from './residentArgs.js'

const RL_VALID_DAYS = REVOCATION_LIST_VALID_MS / (24 * 60 * 60 * 1000)

/** `--help` anywhere means help, matching `audit` (whole-token, so `--x=--help` is a value). */
export function isQianmoCaHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

export const QIANMO_CA_HELP_TEXT = `Usage: ${invokedBinName()} ca <command> [options]

The offline certificate authority: one root, one certificate per node, one
signed revocation list. Runs on the operator's machine, never on a node --
the CA private key is not supposed to exist anywhere a node can reach
(key-distribution.md §3.3).

Commands:

  init                     Create the root key and self-signed certificate.
  issue <node>             Sign one node certificate from a CSR.
  refresh-rl               Re-sign the revocation list, adding entries first.
  ledger                   List every certificate issue has recorded.

Common options:

  --ca-dir <path>          CA root. Default $${CA_DIR_ENV_VAR}, else ${CA_DIR_DEFAULT_DISPLAY}.
                           Refused if it resolves inside any identity's config
                           root -- the CA key does not belong there (§3.3).
  -h, --help               Print this and exit.

init:

  --cn <name>              Subject CN of the root. Default qianmo-ca-<UTC
                           yyyymmdd>, the day it is made. Identity is in the
                           SANs, but TLS picks a root by this name.
  --days <n>               Root lifetime, default ${CA_ROOT_DAYS} (10 years, §6.2).
                           That is the backstop, not the plan: rotate every
                           3 years with a 90-day overlap.

  A new root for a rotation goes in a new --ca-dir and must not share the old
  root's name: during the overlap nodes hold both roots in one --trust-ca
  file, and a file with two roots of the same name is refused. The dated
  default already differs from any root made on another day, including the
  first production root (CN=qianmo-ca).

  Prints the root's SHA-256 fingerprint. Record it in the runbook -- it is the
  one thing distributed out of band, and comparing it is what makes the first
  install of ca.pem not a trust-on-first-use (§5.1, §5.3).

issue <node>:

  --csr <file>             The node's certificate request. Its key must be EC:
                           Bun refuses an Ed25519 leaf outright (F-5).
  --nodekey <key>          The node's Ed25519 public key, 43 base64url chars,
                           as it appears in its identity file. Goes into the
                           certificate as URI:qianmo-nodekey: (§4.2).
  --pop <signature>        Proof of possession: an Ed25519 signature by
                           --nodekey over this CSR (§4.3). Without it a node
                           could certify somebody else's public key under its
                           own name. Refused means nothing was signed.
  --host <host>            Address peers dial this node at. Repeatable; IP
                           literals become IP: SANs and everything else DNS:.
                           REQUIRED -- a certificate whose SANs miss the dialed
                           host is refused by every client (F-9), and this is
                           the SAN people forget because it has nothing to do
                           with Qianmo's identity model.
  --days <n>               Certificate lifetime, default ${NODE_CERT_DAYS} (§6.2).
  --out <file>             Where to write the certificate. Default
                           <ca-dir>/issued/<node>.crt, which is written either
                           way. Never inside the CA directory itself.
  --replace                Allow replacing the node's existing
                           <ca-dir>/issued/<node>.crt (a re-issue) or an
                           existing --out file. Without it, either one existing
                           is refused before anything is signed.

  Every certificate issued is first appended to <ca-dir>/issued-ledger.jsonl
  (node, serial, fingerprint, validity, time of issue). That file keeps the
  fingerprints a re-issue replaces, for a later --revoke. A ledger that does not
  read cleanly stops issue before signing; restore it from the backup.

refresh-rl:

  --revoke <node>=<fp>     Add a revocation. <fp> is the certificate's SHA-256
                           fingerprint, colons optional. Repeatable, and
                           idempotent -- re-adding a known fingerprint is a
                           no-op. Keyed on the certificate, not the node: a
                           compromised node returns as a new identity (§6.5).
  --reason <text>          Reason recorded for the entries added in this run.
  --import-from <dir>      Take over every revocation in another CA directory
                           (the previous root's, during a rotation) before
                           signing. Merged by fingerprint, idempotent, and each
                           entry keeps its node, reason and time. Needed before
                           a new root signs its first list: nodes refuse a list
                           that drops an entry they already hold (§6.4).
  --valid-days <n>         nextUpdate, default ${RL_VALID_DAYS} (§6.2). Past it,
                           nodes fail closed to their explicit --trust entries
                           rather than opening up or going dark (§6.4).
  --out <file>             Where to write the signed list. Default
                           <ca-dir>/revocation-list.json. Publish it to the
                           registry: the signature is what makes a zero-auth
                           courier safe (§5.2).

ledger:

  --node <node>            Only this node's certificates.

  Checks the whole ledger and prints one line per certificate, oldest first.
  Exits 1 on a line it cannot read.

Environment:

  ${CA_DIR_ENV_VAR}             CA root, overridden by --ca-dir.
  ${OPENSSL_BIN_ENV_VAR}       openssl executable, when the one on PATH is not
                           OpenSSL (macOS ships LibreSSL under that name).
`

interface InitConfig {
  readonly directory: string
  readonly commonName?: string
  readonly days?: number
}

interface IssueConfig {
  readonly directory: string
  readonly node: string
  readonly csrPath: string
  readonly popSignature: string
  readonly publicKey: string
  readonly hosts: readonly string[]
  readonly days?: number
  readonly outPath?: string
  readonly replace: boolean
}

interface RefreshConfig {
  readonly directory: string
  readonly revoke: readonly RevocationRequest[]
  readonly importFrom?: string
  readonly validMs?: number
  readonly outPath?: string
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return value
}

function unknownOption(command: string, arg: unknown): never {
  throw new Error(
    `unknown ${command} option ${String(arg)}` +
      ` (run \`${invokedBinName()} ca --help\` for the list)`,
  )
}

export function parseCaInitArgs(args: readonly string[]): InitConfig {
  let caDir: string | undefined
  let commonName: string | undefined
  let days: number | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--ca-dir' || arg?.startsWith('--ca-dir=')) {
      const parsed = residentOptionValue(args, index, '--ca-dir')
      caDir = parsed.value
      index = parsed.next
    } else if (arg === '--cn' || arg?.startsWith('--cn=')) {
      const parsed = residentOptionValue(args, index, '--cn')
      commonName = parsed.value
      index = parsed.next
    } else if (arg === '--days' || arg?.startsWith('--days=')) {
      const parsed = residentOptionValue(args, index, '--days')
      days = positiveInteger(parsed.value, '--days')
      index = parsed.next
    } else {
      unknownOption('ca init', arg)
    }
  }
  return {
    directory: caDirectory(caDir),
    ...(commonName === undefined ? {} : { commonName }),
    ...(days === undefined ? {} : { days }),
  }
}

export function parseCaIssueArgs(args: readonly string[]): IssueConfig {
  let caDir: string | undefined
  let node: string | undefined
  let csrPath: string | undefined
  let popSignature: string | undefined
  let publicKey: string | undefined
  let days: number | undefined
  let outPath: string | undefined
  let replace = false
  const hosts: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--ca-dir' || arg?.startsWith('--ca-dir=')) {
      const parsed = residentOptionValue(args, index, '--ca-dir')
      caDir = parsed.value
      index = parsed.next
    } else if (arg === '--node' || arg?.startsWith('--node=')) {
      const parsed = residentOptionValue(args, index, '--node')
      node = parsed.value
      index = parsed.next
    } else if (arg === '--csr' || arg?.startsWith('--csr=')) {
      const parsed = residentOptionValue(args, index, '--csr')
      csrPath = parsed.value
      index = parsed.next
    } else if (arg === '--pop' || arg?.startsWith('--pop=')) {
      const parsed = residentOptionValue(args, index, '--pop')
      popSignature = parsed.value
      index = parsed.next
    } else if (arg === '--nodekey' || arg?.startsWith('--nodekey=')) {
      const parsed = residentOptionValue(args, index, '--nodekey')
      publicKey = parsed.value
      index = parsed.next
    } else if (arg === '--host' || arg?.startsWith('--host=')) {
      const parsed = residentOptionValue(args, index, '--host')
      hosts.push(parsed.value)
      index = parsed.next
    } else if (arg === '--days' || arg?.startsWith('--days=')) {
      const parsed = residentOptionValue(args, index, '--days')
      days = positiveInteger(parsed.value, '--days')
      index = parsed.next
    } else if (arg === '--out' || arg?.startsWith('--out=')) {
      const parsed = residentOptionValue(args, index, '--out')
      outPath = parsed.value
      index = parsed.next
    } else if (arg === '--replace') {
      replace = true
    } else if (
      arg !== undefined &&
      !arg.startsWith('-') &&
      node === undefined
    ) {
      // Positional node, because §6.1 and §10.2 both write the command that
      // way (`qm ca issue <node> …`) and the console's copyable line follows
      // them. `--node` stays available for scripts that prefer flags.
      node = arg
    } else {
      unknownOption('ca issue', arg)
    }
  }

  if (node === undefined) throw new Error('ca issue needs a <node>')
  if (csrPath === undefined) throw new Error('ca issue needs --csr')
  if (popSignature === undefined) throw new Error('ca issue needs --pop')
  if (publicKey === undefined) throw new Error('ca issue needs --nodekey')
  if (hosts.length === 0) {
    throw new Error(
      'ca issue needs at least one --host: a certificate whose SANs do not ' +
        'cover the dialed address is refused by every client (F-9)',
    )
  }

  return {
    directory: caDirectory(caDir),
    node,
    csrPath,
    popSignature,
    publicKey,
    hosts,
    ...(days === undefined ? {} : { days }),
    ...(outPath === undefined ? {} : { outPath }),
    replace,
  }
}

export function parseCaRefreshArgs(args: readonly string[]): RefreshConfig {
  let caDir: string | undefined
  let reason: string | undefined
  let importFrom: string | undefined
  let validMs: number | undefined
  let outPath: string | undefined
  const pending: { node: string; fingerprint256: string }[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--ca-dir' || arg?.startsWith('--ca-dir=')) {
      const parsed = residentOptionValue(args, index, '--ca-dir')
      caDir = parsed.value
      index = parsed.next
    } else if (arg === '--revoke' || arg?.startsWith('--revoke=')) {
      const parsed = residentOptionValue(args, index, '--revoke')
      const split = parsed.value.indexOf('=')
      if (split <= 0) {
        throw new Error('--revoke takes <node>=<fingerprint256>')
      }
      pending.push({
        node: parsed.value.slice(0, split),
        fingerprint256: parsed.value.slice(split + 1),
      })
      index = parsed.next
    } else if (arg === '--reason' || arg?.startsWith('--reason=')) {
      const parsed = residentOptionValue(args, index, '--reason')
      reason = parsed.value
      index = parsed.next
    } else if (arg === '--import-from' || arg?.startsWith('--import-from=')) {
      const parsed = residentOptionValue(args, index, '--import-from')
      importFrom = parsed.value
      index = parsed.next
    } else if (arg === '--valid-days' || arg?.startsWith('--valid-days=')) {
      const parsed = residentOptionValue(args, index, '--valid-days')
      validMs =
        positiveInteger(parsed.value, '--valid-days') * 24 * 60 * 60 * 1000
      index = parsed.next
    } else if (arg === '--out' || arg?.startsWith('--out=')) {
      const parsed = residentOptionValue(args, index, '--out')
      outPath = parsed.value
      index = parsed.next
    } else {
      unknownOption('ca refresh-rl', arg)
    }
  }

  return {
    directory: caDirectory(caDir),
    revoke: pending.map(entry => ({
      ...entry,
      ...(reason === undefined ? {} : { reason }),
    })),
    ...(importFrom === undefined ? {} : { importFrom }),
    ...(validMs === undefined ? {} : { validMs }),
    ...(outPath === undefined ? {} : { outPath }),
  }
}

function runInit(args: readonly string[]): void {
  const result = initCa(parseCaInitArgs(args))
  process.stdout.write(
    `CA created in ${result.directory}\n` +
      `  root certificate  ${result.certificatePath}\n` +
      `  fingerprint256    ${result.fingerprint256}\n` +
      `  public key        ${result.publicKey}\n` +
      `  not after         ${result.notAfter}\n` +
      '\nRecord the fingerprint in the runbook. Every node compares it by ' +
      'hand when it installs\nthe root certificate -- that comparison is the ' +
      'only reason the first install is not\ntrust-on-first-use (§5.1).\n',
  )
}

function runIssue(args: readonly string[]): void {
  const config = parseCaIssueArgs(args)
  const result = issueCertificate({
    directory: config.directory,
    node: config.node,
    publicKey: config.publicKey,
    csrPem: readFileSync(config.csrPath, 'utf8'),
    popSignature: config.popSignature,
    hosts: config.hosts,
    ...(config.days === undefined ? {} : { days: config.days }),
    ...(config.outPath === undefined ? {} : { outPath: config.outPath }),
    replace: config.replace,
  })
  const hosts = [
    ...result.binding.dnsNames.map(name => `DNS:${name}`),
    ...result.binding.ipAddresses.map(address => `IP:${address}`),
  ].join(', ')
  process.stdout.write(
    `Issued a certificate for ${result.binding.node}\n` +
      `  certificate       ${result.certificatePath}\n` +
      `  fingerprint256    ${result.fingerprint256}\n` +
      `  not after         ${result.notAfter}\n` +
      `  hosts             ${hosts}\n` +
      `  node key          ${result.binding.publicKey}\n` +
      `  ledger            ${result.ledgerPath}\n` +
      (result.replacedFingerprint256 === undefined
        ? ''
        : `  replaced          ${result.replacedFingerprint256}\n`),
  )
}

function parseCaLedgerArgs(args: readonly string[]): {
  readonly directory: string
  readonly node?: string
} {
  let caDir: string | undefined
  let node: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--ca-dir' || arg?.startsWith('--ca-dir=')) {
      const parsed = residentOptionValue(args, index, '--ca-dir')
      caDir = parsed.value
      index = parsed.next
    } else if (arg === '--node' || arg?.startsWith('--node=')) {
      const parsed = residentOptionValue(args, index, '--node')
      node = parsed.value
      index = parsed.next
    } else {
      unknownOption('ca ledger', arg)
    }
  }
  return {
    directory: caDirectory(caDir),
    ...(node === undefined ? {} : { node }),
  }
}

function runLedger(args: readonly string[]): void {
  const config = parseCaLedgerArgs(args)
  const ledger = readIssuanceLedger(config.directory)
  const records = ledger.records.filter(
    record => config.node === undefined || record.node === config.node,
  )
  process.stdout.write(
    `${ledger.path}: ${String(records.length)} of ` +
      `${String(ledger.records.length)} certificate(s)\n`,
  )
  for (const record of records) {
    process.stdout.write(`  ${formatIssuanceRecord(record)}\n`)
  }
}

function runRefresh(args: readonly string[]): void {
  const config = parseCaRefreshArgs(args)
  const result = refreshRevocationList(config)
  process.stdout.write(
    `Signed a revocation list with ${String(result.list.revoked.length)} ` +
      `entrie(s), ${String(result.added)} new\n` +
      (config.importFrom === undefined
        ? ''
        : `  imported          ${String(result.imported)} from ${config.importFrom}\n`) +
      `  list              ${result.path}\n` +
      `  issued at         ${new Date(result.list.issuedAt).toISOString()}\n` +
      `  next update       ${new Date(result.list.nextUpdate).toISOString()}\n` +
      `  CA public key     ${result.caPublicKey}\n`,
  )
  for (const entry of result.list.revoked) {
    process.stdout.write(
      `  revoked ${entry.node} ${entry.fingerprint256} ` +
        `(${entry.reason}, ${new Date(entry.at).toISOString()})\n`,
    )
  }
}

/** Entry point. Errors become one line on stderr plus exit 1, never a stack. */
export function runQianmoCa(args: readonly string[]): void {
  if (args.length === 0 || isQianmoCaHelpRequest(args)) {
    process.stdout.write(QIANMO_CA_HELP_TEXT)
    return
  }
  const [command, ...rest] = args
  try {
    switch (command) {
      case 'init':
        runInit(rest)
        return
      case 'issue':
        runIssue(rest)
        return
      case 'refresh-rl':
        runRefresh(rest)
        return
      case 'ledger':
        runLedger(rest)
        return
      default:
        throw new Error(
          `unknown ca command ${String(command)}` +
            ` (expected init, issue, refresh-rl or ledger)`,
        )
    }
  } catch (error) {
    // An operator running this is following a runbook on a machine that is
    // deliberately not provisioned like a node; a stack trace tells them
    // nothing they can act on, and OpensslError already carries the fix.
    const message =
      error instanceof OpensslError || error instanceof Error
        ? error.message
        : String(error)
    process.stderr.write(
      `${invokedBinName()} ca ${String(command)}: ${message}\n`,
    )
    process.exitCode = 1
  }
}
