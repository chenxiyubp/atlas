// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The node-certificate binding format (`key-distribution.md` §4.2).
 *
 * A node certificate carries three classes of `subjectAltName`, and each one
 * answers a different question:
 *
 *   DNS:<host> [, IP:<addr>]              what TLS itself demands (F-9)
 *   URI:qianmo://<node>                   which node this is
 *   URI:qianmo-nodekey:<43 chars>         which Ed25519 key that node signs with
 *
 * §4.2 says this format is fixed and "两处不得各写一份", so both halves live
 * here: the host-side CA tool builds the openssl `subjectAltName=` line with
 * {@link formatNodeSanEntries}, and the node side reads it back out of
 * `node:crypto`'s `X509Certificate.subjectAltName` with
 * {@link parseNodeCertificateBinding}. One writer, one reader, one shape.
 *
 * ## Why it lives in this package rather than beside the CA tool
 *
 * §4.2's closing rule: the 43-character base64url public-key encoding has
 * exactly one definition (`PUBLIC_KEY_PATTERN`, protocol.md §10.1), and the
 * certificate is not allowed to grow a second regex for it. Putting the format
 * next to `isNodePublicKey` is what makes that structurally true instead of a
 * convention. Nothing here touches openssl, the CA directory or the file
 * system — this is a string format, and the tooling that issues certificates
 * stays host-side (§6.1).
 *
 * ## The host classes are not classified here
 *
 * Deciding whether `10.0.0.4` is an IP literal or a hostname needs `node:net`,
 * and this package deliberately imports nothing. The caller passes the two
 * lists already separated; getting that wrong is a local mistake with a loud
 * failure (openssl rejects `IP:not-an-ip`), not a silent one.
 */

import { ADDRESS_SCHEME, isValidSegment } from './address.js'
import { isNodePublicKey } from './capability.js'

/**
 * URI scheme carrying the node's Ed25519 public key.
 *
 * Deliberately NOT `qianmo://` with a path: an address names a handler
 * (`qianmo://<node>/<agent>`), and a key is not a handler. A distinct scheme
 * means a parser can never mistake one for the other, and `parseAddress` can
 * never be handed a key by accident.
 */
export const NODE_KEY_URI_SCHEME = 'qianmo-nodekey:'

/** What a node certificate's SAN set asserts. */
export interface NodeCertificateBinding {
  /** The `node` segment — the identity that does not change when a box moves. */
  readonly node: string
  /** The node's Ed25519 public key, the same 43 chars `AgentRecord` publishes. */
  readonly publicKey: string
  /** Hostnames the certificate is valid for. May be empty when IPs are given. */
  readonly dnsNames: readonly string[]
  /** IP addresses the certificate is valid for. May be empty when DNS is given. */
  readonly ipAddresses: readonly string[]
}

/**
 * `node:crypto` renders an IP entry as `IP Address:`, while openssl's config
 * syntax spells the same thing `IP:`. Both are accepted on the way in; only
 * openssl's spelling is ever produced.
 */
const SAN_IP_LABELS: readonly string[] = ['IP Address:', 'IP:']

const SAN_DNS_LABEL = 'DNS:'
const SAN_URI_LABEL = 'URI:'

/**
 * Entries as `X509Certificate.subjectAltName` joins them.
 *
 * A hostile certificate can put `, ` inside a value and thereby fabricate an
 * entry that this naive split will see. That is not defended against by
 * escaping (there is no unambiguous unescape for the string Node hands back) —
 * it is defended against by {@link parseNodeCertificateBinding} refusing any
 * SAN set with more than one node URI or more than one key URI. A smuggled
 * second copy is therefore a rejection, never a substitution.
 */
const SAN_SEPARATOR = ', '

/** Hostnames worth putting in a certificate: no spaces, no commas, bounded. */
const DNS_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?$/

/** Loose on purpose — openssl is the authority on what parses as an address. */
const IP_LITERAL_PATTERN = /^[0-9A-Fa-f.:]{2,45}$/

/**
 * Render the `subjectAltName=` value for `binding`, in §4.2's written order.
 *
 * Throws rather than returning null: this runs on the CA operator's own input
 * at issuance time, where a malformed argument must stop the run, not produce
 * a certificate that is quietly missing the thing it exists to carry.
 */
export function formatNodeSanEntries(binding: NodeCertificateBinding): string {
  if (!isValidSegment(binding.node)) {
    throw new Error(`invalid node segment: ${String(binding.node)}`)
  }
  if (!isNodePublicKey(binding.publicKey)) {
    throw new Error('node public key must be 43 base64url characters')
  }
  if (binding.dnsNames.length === 0 && binding.ipAddresses.length === 0) {
    // F-9: a certificate with only URI SANs is refused by every dialer, so an
    // issuance with no host at all produces a certificate nobody can connect
    // to. Failing here beats failing 90 days later on someone else's machine.
    throw new Error('a node certificate needs at least one DNS or IP host')
  }
  for (const name of binding.dnsNames) {
    if (!DNS_NAME_PATTERN.test(name)) {
      throw new Error(`invalid DNS host: ${String(name)}`)
    }
  }
  for (const address of binding.ipAddresses) {
    if (!IP_LITERAL_PATTERN.test(address)) {
      throw new Error(`invalid IP host: ${String(address)}`)
    }
  }
  return [
    ...binding.dnsNames.map(name => `${SAN_DNS_LABEL}${name}`),
    ...binding.ipAddresses.map(address => `IP:${address}`),
    `${SAN_URI_LABEL}${ADDRESS_SCHEME}${binding.node}`,
    `${SAN_URI_LABEL}${NODE_KEY_URI_SCHEME}${binding.publicKey}`,
  ].join(',')
}

/**
 * Read a certificate's SAN string back into a binding, or `null` when the set
 * is not a well-formed node certificate.
 *
 * §4.2: all three classes must be present, so a certificate missing any of
 * them is refused here rather than half-accepted. Returns `null` instead of
 * throwing because this runs on certificates handed over by peers, and a
 * verifier that throws on garbage turns "someone published nonsense" into an
 * exception at whatever boundary happens to sit above it (same reasoning as
 * `verifyBytes` in `@qianmo/capability`).
 */
export function parseNodeCertificateBinding(
  subjectAltName: unknown,
): NodeCertificateBinding | null {
  if (typeof subjectAltName !== 'string') return null

  const dnsNames: string[] = []
  const ipAddresses: string[] = []
  const nodes: string[] = []
  const publicKeys: string[] = []

  for (const raw of subjectAltName.split(SAN_SEPARATOR)) {
    const entry = raw.trim()
    if (entry.startsWith(SAN_DNS_LABEL)) {
      const value = entry.slice(SAN_DNS_LABEL.length)
      if (DNS_NAME_PATTERN.test(value)) dnsNames.push(value)
      continue
    }
    const ipLabel = SAN_IP_LABELS.find(label => entry.startsWith(label))
    if (ipLabel !== undefined) {
      const value = entry.slice(ipLabel.length)
      if (IP_LITERAL_PATTERN.test(value)) ipAddresses.push(value)
      continue
    }
    if (!entry.startsWith(SAN_URI_LABEL)) continue
    const uri = entry.slice(SAN_URI_LABEL.length)
    if (uri.startsWith(ADDRESS_SCHEME)) {
      nodes.push(uri.slice(ADDRESS_SCHEME.length))
    } else if (uri.startsWith(NODE_KEY_URI_SCHEME)) {
      publicKeys.push(uri.slice(NODE_KEY_URI_SCHEME.length))
    }
  }

  // Exactly one of each: two node URIs (or two key URIs) means the set is
  // ambiguous about the one thing it exists to state, and picking either is a
  // guess. See SAN_SEPARATOR on why this is the defence that matters.
  if (nodes.length !== 1 || publicKeys.length !== 1) return null
  const node = nodes[0]
  const publicKey = publicKeys[0]
  if (!isValidSegment(node) || !isNodePublicKey(publicKey)) return null
  if (dnsNames.length === 0 && ipAddresses.length === 0) return null

  return { node, publicKey, dnsNames, ipAddresses }
}
