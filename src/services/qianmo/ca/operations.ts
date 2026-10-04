// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three CA actions of §6.1: build the root, sign a node certificate,
 * re-sign the revocation list.
 *
 * All three are host-side, all three run on the operator's offline machine,
 * and none of them is reachable from a node process or the console (§10.2
 * decided that deliberately: an HTTP surface in front of the CA private key
 * would cancel the "CA is offline" premise that two of §3.3's three benefits
 * rest on, and a console with no accounts cannot attribute a signature to a
 * person anyway).
 *
 * Parsing and printing live in `src/cli/handlers/ca.ts`; this file is the part
 * that can be called from a test without going through argv.
 *
 * ## Issuing never destroys a record
 *
 * Every certificate `issue` signs is appended to the issuance ledger
 * (`ledger.ts`) before any certificate file is written, and `issue` refuses to
 * overwrite an existing file unless told to with `replace`. The two together
 * are what keep a re-issue from erasing the only copy of the previous
 * certificate's fingerprint.
 */

import { X509Certificate, createPublicKey } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  formatNodeSanEntries,
  isNodePublicKey,
  isValidSegment,
  parseNodeCertificateBinding,
  type NodeCertificateBinding,
} from '@qianmo/protocol'
import { NODE_IDENTITY_MODE } from '../../../constants/identity.js'
import {
  caKeyPairFromPem,
  caPublicKeyFromCertificate,
  normalizeFingerprint256,
} from './caKeys.js'
import {
  appendIssuanceRecords,
  issuanceRecordOf,
  readIssuanceLedger,
  replaceFileAtomically,
} from './ledger.js'
import { runOpenssl } from './openssl.js'
import { verifyCsrPop } from './pop.js'
import {
  CA_DIR_MODE,
  CA_PRIVATE_FILE_MODE,
  CA_PUBLIC_FILE_MODE,
  caCertPath,
  caKeyPath,
  caSerialPath,
  isInsideCaDirectory,
  issueLockPath,
  issuedCertPath,
  revocationListPath,
  revocationStatePath,
} from './paths.js'
import {
  REVOCATION_LIST_VALID_MS,
  REVOCATION_LIST_VERSION,
  isRevocationList,
  signRevocationList,
  verifyRevocationList,
  type RevocationEntry,
  type RevocationList,
} from './revocationList.js'

/**
 * Root lifetime: 10 years (§6.2).
 *
 * Not the planned life — §3.3 says the root is rotated every 3 years with a
 * 90-day overlap. Ten years is the backstop against "nobody remembered to
 * rotate and the whole network stopped", which is a worse failure than a root
 * that outlived its intended schedule.
 */
export const CA_ROOT_DAYS = 3650

/**
 * Node certificate lifetime: 90 days (§6.2).
 *
 * Paired with the RL's 30-day `nextUpdate`; §6.2 argues the pair explicitly
 * (quarterly batch issuance plus monthly RL re-signing is a schedule people
 * actually keep) and §12 K-14 records the reviewer accepting both numbers.
 */
export const NODE_CERT_DAYS = 90

/**
 * Default subject CN of a root: `qianmo-ca-<UTC yyyymmdd>`.
 *
 * The prefix comes from the identity roster so the network's name is spelled
 * in exactly one place (CLAUDE.md §2.3). Nothing in Qianmo reads a CN for
 * identity (§4.2 puts that in the SANs), but the TLS layer does pick a root by
 * name, so a `--trust-ca` file refuses two roots that share one
 * (`trustAnchors.ts`). The date is what keeps a rotation's new root from
 * inheriting its predecessor's name by default. The first production root
 * predates it and is `CN=qianmo-ca`.
 */
function defaultCaCommonName(now: number): string {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
  return `${NODE_IDENTITY_MODE}-ca-${day}`
}

/** Split `--host` values into the two SAN classes openssl wants (§4.2). */
function classifyHosts(hosts: readonly string[]): {
  dnsNames: string[]
  ipAddresses: string[]
} {
  const dnsNames: string[] = []
  const ipAddresses: string[] = []
  for (const host of hosts) {
    if (isIP(host) === 0) dnsNames.push(host)
    else ipAddresses.push(host)
  }
  return { dnsNames, ipAddresses }
}

function writeNew(path: string, data: string, mode: number): void {
  // `wx`: never overwrite. For the CA key this is the same rule
  // `nodeIdentity.ts` applies to a node's identity — silently replacing a key
  // turns "I ran the wrong command" into "the whole network's trust root
  // changed", and the second failure is the one nobody notices in time.
  writeFileSync(path, data, { mode, flag: 'wx' })
}

function writeReplacing(path: string, data: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: CA_DIR_MODE })
  writeFileSync(path, data, { mode })
}

/**
 * Write a certificate file: `wx` when it must not exist yet, an atomic
 * replace when the caller has already decided it may.
 */
function writeCertificateFile(
  path: string,
  pem: string,
  replace: boolean,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: CA_DIR_MODE })
  if (replace) replaceFileAtomically(path, pem)
  else writeNew(path, pem, CA_PUBLIC_FILE_MODE)
}

/**
 * Run `body` holding the CA directory's issue lock.
 *
 * One `issue` reads the ledger, signs, then appends: two interleaved runs
 * would each append to the ledger they read and one record would be lost.
 * `wx` makes taking the lock atomic. An interrupted run can leave the file
 * behind; the refusal says so rather than guessing whether it is stale.
 */
function withIssueLock<T>(directory: string, body: () => T): T {
  const lockPath = issueLockPath(directory)
  try {
    writeFileSync(lockPath, `${String(process.pid)}\n`, {
      mode: CA_PUBLIC_FILE_MODE,
      flag: 'wx',
    })
  } catch (error) {
    if (existsSync(lockPath)) {
      throw new Error(
        `another \`ca issue\` holds ${lockPath}. If none is running (an ` +
          'earlier run was interrupted), delete that file and run again.',
      )
    }
    throw error
  }
  try {
    return body()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

/** The certificate at `path`, when this CA issued it; `null` otherwise. */
function ownIssuedCertificate(
  path: string,
  caCertificate: X509Certificate,
): X509Certificate | null {
  try {
    const certificate = new X509Certificate(readFileSync(path, 'utf8'))
    return certificate.checkIssued(caCertificate) &&
      certificate.verify(caCertificate.publicKey)
      ? certificate
      : null
  } catch {
    return null
  }
}

/** What `qm ca init` produced. */
export interface CaInitResult {
  readonly directory: string
  readonly certificatePath: string
  /** The value the runbook records and operators compare out of band (§5.1). */
  readonly fingerprint256: string
  /** The CA's Ed25519 public key — what verifies an RL signature. */
  readonly publicKey: string
  readonly notAfter: string
}

/** Build the offline root (§6.1 row 1). */
export function initCa(options: {
  readonly directory: string
  readonly commonName?: string
  readonly days?: number
  /** Picks the date in the default CN; the certificate's validity is openssl's clock. */
  readonly now?: number
}): CaInitResult {
  const directory = options.directory
  const commonName =
    options.commonName ?? defaultCaCommonName(options.now ?? Date.now())
  const days = options.days ?? CA_ROOT_DAYS

  mkdirSync(directory, { recursive: true, mode: CA_DIR_MODE })
  const mode = statSync(directory).mode & 0o777
  if ((mode & 0o077) !== 0) {
    // Only reachable when the directory already existed with looser
    // permissions. Refusing beats chmod-ing: the key is about to be written
    // there, and a directory somebody else can already read is a fact about
    // that machine the operator should hear, not one this tool should paper over.
    throw new Error(
      `${directory} is mode ${mode.toString(8)}; the CA directory must be ` +
        `0${CA_DIR_MODE.toString(8)} (key-distribution.md §3.3). ` +
        `Fix it with \`chmod 700 ${directory}\` and re-run.`,
    )
  }

  const keyPath = caKeyPath(directory)
  const certificatePath = caCertPath(directory)
  if (existsSync(keyPath)) {
    throw new Error(
      `a CA already exists at ${directory}. A CA private key is never ` +
        'overwritten (key-distribution.md §3.3); rotating the root is a ' +
        'deliberate out-of-band action with a 90-day overlap (§6.2), so make ' +
        'the new root in a new directory.',
    )
  }

  writeNew(
    keyPath,
    runOpenssl(['genpkey', '-algorithm', 'ed25519']),
    CA_PRIVATE_FILE_MODE,
  )
  writeNew(
    certificatePath,
    runOpenssl([
      'req',
      '-x509',
      '-new',
      '-key',
      keyPath,
      '-days',
      String(days),
      '-subj',
      `/CN=${commonName}`,
    ]),
    CA_PUBLIC_FILE_MODE,
  )

  const certificatePem = readFileSync(certificatePath, 'utf8')
  const certificate = new X509Certificate(certificatePem)
  return {
    directory,
    certificatePath,
    fingerprint256: certificate.fingerprint256,
    publicKey: caPublicKeyFromCertificate(certificatePem),
    notAfter: certificate.validTo,
  }
}

/** What `qm ca issue` produced. Not exported: only the printer consumes it. */
interface CaIssueResult {
  readonly certificatePath: string
  readonly certificatePem: string
  readonly fingerprint256: string
  readonly notAfter: string
  /** Read back out of the signed certificate, not echoed from the request. */
  readonly binding: NodeCertificateBinding
  /** The ledger this issuance was appended to. */
  readonly ledgerPath: string
  /** Fingerprint of the `issued/<node>.crt` copy this run replaced, if any. */
  readonly replacedFingerprint256?: string
}

/**
 * Sign one node certificate (§6.1 row 2).
 *
 * Refuses, before signing anything, to overwrite `issued/<node>.crt` or
 * `outPath` unless `replace` is set, and refuses an `outPath` inside the CA
 * directory outright. The signed certificate is recorded in the issuance
 * ledger before either file is written.
 */
export function issueCertificate(options: {
  readonly directory: string
  readonly node: string
  readonly publicKey: string
  readonly csrPem: string
  readonly popSignature: string
  readonly hosts: readonly string[]
  readonly days?: number
  readonly outPath?: string
  /** Allow replacing an existing `issued/<node>.crt` or `outPath`. */
  readonly replace?: boolean
  /** Signing time as the ledger records it. Defaults to the wall clock. */
  readonly now?: number
}): CaIssueResult {
  const { directory, node, publicKey, csrPem } = options
  const days = options.days ?? NODE_CERT_DAYS
  const replace = options.replace === true

  if (!isValidSegment(node)) {
    throw new Error(`invalid node segment: ${String(node)}`)
  }
  if (!isNodePublicKey(publicKey)) {
    throw new Error(
      '--nodekey must be the node’s Ed25519 public key: 43 base64url ' +
        'characters, exactly as it appears in its identity file',
    )
  }
  if (options.hosts.length === 0) {
    // F-9, and it is the mistake §4.2 says is easiest to make: the host SANs
    // have nothing to do with Qianmo's identity model, so they are the ones
    // that get forgotten — and a certificate without them is one nobody can
    // dial, on every path, with an error that does not mention SANs.
    throw new Error(
      '--host is required: a certificate whose SANs do not cover the address ' +
        'peers dial is refused by the TLS client (key-distribution.md F-9)',
    )
  }

  const keyPath = caKeyPath(directory)
  const certificatePath = caCertPath(directory)
  if (!existsSync(keyPath) || !existsSync(certificatePath)) {
    throw new Error(`no CA at ${directory}; run \`ca init\` there first`)
  }

  // The CSR's own signature first: everything after this treats the request as
  // a well-formed request, and a garbled file should say so in those words
  // rather than as a proof-of-possession failure.
  runOpenssl(['req', '-verify', '-noout'], { input: csrPem })

  const csrKeyType = createPublicKey(
    runOpenssl(['req', '-noout', '-pubkey'], { input: csrPem }),
  ).asymmetricKeyType
  if (csrKeyType !== 'ec') {
    // F-5: Bun refuses an Ed25519 leaf outright, in all four TLS combinations
    // tried, `rejectUnauthorized:false` included. Signing one here would
    // produce a certificate that verifies fine with `node:crypto` and cannot
    // carry a single connection — the most expensive kind of valid.
    throw new Error(
      `the CSR carries a ${String(csrKeyType)} key; a node's TLS leaf must be ` +
        'EC (key-distribution.md F-5 — Bun does not accept an Ed25519 leaf). ' +
        'Generate it with `openssl ecparam -name prime256v1 -genkey -noout`.',
    )
  }

  // §4.3: the CSR proves the requester holds the EC key, and nothing else.
  // This is the step that stops a node asking for a certificate that binds its
  // own name to somebody else's Ed25519 key.
  if (
    !verifyCsrPop({ node, publicKey, csrPem, signature: options.popSignature })
  ) {
    throw new Error(
      'proof of possession failed: --pop is not a signature by --nodekey over ' +
        'this CSR (key-distribution.md §4.3). Nothing was signed.',
    )
  }

  const issuedPath = issuedCertPath(directory, node)
  const outPath = options.outPath ?? issuedPath
  if (outPath !== issuedPath && isInsideCaDirectory(outPath, directory)) {
    // Not even with `replace`: this is how a certificate lands on `ca.key`,
    // on another node's copy, or on the ledger.
    throw new Error(
      `--out ${outPath} is inside the CA directory ${directory}; write the ` +
        'certificate somewhere else (the CA keeps its own copy in issued/)',
    )
  }

  return withIssueLock(directory, () => {
    // Read before signing: a ledger that cannot be read cannot be appended
    // to, and a certificate that cannot be recorded must not be signed.
    const ledger = readIssuanceLedger(directory)
    const caCertificate = new X509Certificate(
      readFileSync(certificatePath, 'utf8'),
    )

    let replaced: X509Certificate | undefined
    if (existsSync(issuedPath)) {
      if (!replace) {
        throw new Error(
          `${node} already has a certificate at ${issuedPath}. Re-issuing ` +
            'replaces that copy (its fingerprint stays in the ledger); pass ' +
            '--replace to do that. Nothing was signed.',
        )
      }
      const previous = ownIssuedCertificate(issuedPath, caCertificate)
      if (previous === null) {
        throw new Error(
          `${issuedPath} does not hold a certificate this CA issued, so ` +
            'replacing it would lose something the ledger cannot account ' +
            'for; move it aside and run again. Nothing was signed.',
        )
      }
      replaced = previous
    }
    if (outPath !== issuedPath && existsSync(outPath) && !replace) {
      throw new Error(
        `${outPath} already exists; pass --replace to overwrite it. ` +
          'Nothing was signed.',
      )
    }

    const { dnsNames, ipAddresses } = classifyHosts(options.hosts)
    const requested: NodeCertificateBinding = {
      node,
      publicKey,
      dnsNames,
      ipAddresses,
    }
    const extensions =
      `subjectAltName=${formatNodeSanEntries(requested)}\n` +
      'basicConstraints=CA:FALSE\n' +
      // Both, because a node is both ends: it serves inbound connections and
      // dials outbound ones, and L0's mTLS (F-7) needs the client half too.
      'extendedKeyUsage=serverAuth,clientAuth\n'

    const scratch = mkdtempSync(join(tmpdir(), `${NODE_IDENTITY_MODE}-ca-`))
    let certificatePem: string
    try {
      const extensionsPath = join(scratch, 'ext.cnf')
      writeFileSync(extensionsPath, extensions, { mode: CA_PRIVATE_FILE_MODE })
      certificatePem = runOpenssl(
        [
          'x509',
          '-req',
          '-CA',
          certificatePath,
          '-CAkey',
          keyPath,
          '-CAcreateserial',
          '-CAserial',
          caSerialPath(directory),
          '-days',
          String(days),
          '-extfile',
          extensionsPath,
        ],
        { input: csrPem },
      )
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }

    // Read the binding back out of the signed bytes rather than trusting what we
    // asked for. This is the same check every node will run (F-1/F-3), done once
    // here so a certificate that cannot be parsed by a peer never leaves the CA.
    const certificate = new X509Certificate(certificatePem)
    const binding = parseNodeCertificateBinding(certificate.subjectAltName)
    if (binding === null) {
      throw new Error(
        'the signed certificate does not parse as a node certificate; refusing ' +
          `to hand it over. SANs were: ${String(certificate.subjectAltName)}`,
      )
    }
    if (binding.node !== node || binding.publicKey !== publicKey) {
      throw new Error(
        'the signed certificate does not carry the requested binding',
      )
    }
    if (!certificate.verify(caCertificate.publicKey)) {
      throw new Error('the signed certificate does not verify against this CA')
    }

    // The record first, then the files: a crash in between leaves a ledger
    // line for a certificate nobody received, which is harmless. The other
    // order could leave a delivered certificate the ledger never heard of.
    const records = [
      ...(replaced !== undefined &&
      !ledger.records.some(
        record => record.fingerprint256 === replaced.fingerprint256,
      )
        ? [
            // Signed before the ledger existed. Recorded now, because this run
            // is about to overwrite the only other place its fingerprint lives.
            issuanceRecordOf(
              replaced,
              node,
              'import',
              Date.parse(replaced.validFrom),
            ),
          ]
        : []),
      issuanceRecordOf(certificate, node, 'issue', options.now ?? Date.now()),
    ]
    appendIssuanceRecords(ledger, records)

    writeCertificateFile(issuedPath, certificatePem, replaced !== undefined)
    if (outPath !== issuedPath) {
      writeCertificateFile(outPath, certificatePem, replace)
    }

    return {
      certificatePath: outPath,
      certificatePem,
      fingerprint256: certificate.fingerprint256,
      notAfter: certificate.validTo,
      binding,
      ledgerPath: ledger.path,
      ...(replaced === undefined
        ? {}
        : { replacedFingerprint256: replaced.fingerprint256 }),
    }
  })
}

/** One revocation asked for on the command line. */
export interface RevocationRequest {
  readonly node: string
  readonly fingerprint256: string
  readonly reason?: string
}

/** What `qm ca refresh-rl` produced. Not exported: only the printer consumes it. */
interface RefreshRlResult {
  readonly path: string
  readonly list: RevocationList
  /** Entries this run's `--revoke` added — zero on a plain monthly re-sign. */
  readonly added: number
  /** Entries `importFrom` added; zero when every one was already here. */
  readonly imported: number
  readonly caPublicKey: string
}

function readRevocationState(path: string): RevocationEntry[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is not JSON`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} is not a list of revocation entries`)
  }
  // Validated through the same structural check the signed document uses, so
  // the state file cannot hold something that would fail at signing time.
  const candidate = {
    version: REVOCATION_LIST_VERSION,
    issuedAt: 1,
    nextUpdate: 2,
    revoked: parsed,
  }
  if (!isRevocationList(candidate)) {
    throw new Error(`${path} holds a malformed revocation entry`)
  }
  return [...candidate.revoked]
}

/**
 * The revocation state of another CA directory, for a root rotation.
 *
 * Nodes keep the revocation list append-only (§6.4): once they hold the old
 * root's list, a list from the new root that lacks any of its entries is
 * refused, and the new root's own revocations never reach them. So the new
 * directory takes the old one's entries over before it signs its first list —
 * merged by fingerprint, never copied over the top, because the new directory
 * may already have revocations of its own.
 */
function importedRevocationState(
  from: string,
  directory: string,
): RevocationEntry[] {
  if (isInsideCaDirectory(from, directory)) {
    throw new Error(
      `--import-from ${from} is this CA's own directory; name the previous ` +
        "root's directory. Nothing was signed.",
    )
  }
  const path = revocationStatePath(from)
  if (!existsSync(path)) {
    throw new Error(
      `--import-from: no ${path}. Point it at the previous root's CA ` +
        'directory, the one its refresh-rl ran in. Nothing was signed.',
    )
  }
  return readRevocationState(path)
}

/** Re-sign the revocation list, optionally adding entries first (§6.1 row 4). */
export function refreshRevocationList(options: {
  readonly directory: string
  readonly revoke?: readonly RevocationRequest[]
  /** Another CA directory whose revocations this list must carry (§3.3 rotation). */
  readonly importFrom?: string
  readonly validMs?: number
  readonly outPath?: string
  readonly now?: number
}): RefreshRlResult {
  const directory = options.directory
  const now = options.now ?? Date.now()
  const validMs = options.validMs ?? REVOCATION_LIST_VALID_MS

  const keyPath = caKeyPath(directory)
  const certificatePath = caCertPath(directory)
  if (!existsSync(keyPath) || !existsSync(certificatePath)) {
    throw new Error(`no CA at ${directory}; run \`ca init\` there first`)
  }
  const caKeys = caKeyPairFromPem(readFileSync(keyPath, 'utf8'))
  const caPublicKey = caPublicKeyFromCertificate(
    readFileSync(certificatePath, 'utf8'),
  )
  if (caKeys.publicKey !== caPublicKey) {
    // The two files disagree about which CA this is. Signing anyway would
    // produce an RL that every node rejects as forged, which is a confusing
    // way to learn that somebody copied one file and not the other.
    throw new Error(
      `${keyPath} and ${certificatePath} are not the same CA; refusing to sign`,
    )
  }

  const statePath = revocationStatePath(directory)
  const entries = readRevocationState(statePath)
  const known = new Set(entries.map(entry => entry.fingerprint256))

  let imported = 0
  if (options.importFrom !== undefined) {
    for (const entry of importedRevocationState(
      options.importFrom,
      directory,
    )) {
      // Kept as the previous root recorded it — node, reason and the time the
      // revocation was decided are history, not something this run decides.
      if (known.has(entry.fingerprint256)) continue
      known.add(entry.fingerprint256)
      entries.push(entry)
      imported++
    }
  }

  let added = 0
  for (const request of options.revoke ?? []) {
    if (!isValidSegment(request.node)) {
      throw new Error(`invalid node segment in --revoke: ${request.node}`)
    }
    const fingerprint256 = normalizeFingerprint256(request.fingerprint256)
    if (known.has(fingerprint256)) continue
    known.add(fingerprint256)
    entries.push({
      node: request.node,
      fingerprint256,
      // Free text, but never empty: an entry nobody can explain later is an
      // entry somebody will eventually remove because they cannot explain it.
      reason: request.reason ?? 'unspecified',
      at: now,
    })
    added++
  }

  entries.sort((left, right) =>
    left.at === right.at
      ? left.fingerprint256.localeCompare(right.fingerprint256)
      : left.at - right.at,
  )

  const list: RevocationList = {
    version: REVOCATION_LIST_VERSION,
    issuedAt: now,
    nextUpdate: now + validMs,
    revoked: entries,
  }
  const signed = signRevocationList(caKeys, list)
  if (verifyRevocationList(caPublicKey, signed) === null) {
    throw new Error('the freshly signed revocation list does not verify')
  }

  writeReplacing(
    statePath,
    `${JSON.stringify(entries, null, 2)}\n`,
    CA_PUBLIC_FILE_MODE,
  )
  const outPath = options.outPath ?? revocationListPath(directory)
  writeReplacing(
    outPath,
    `${JSON.stringify(signed, null, 2)}\n`,
    CA_PUBLIC_FILE_MODE,
  )

  return { path: outPath, list, added, imported, caPublicKey }
}
