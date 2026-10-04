// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  NODE_KEY_URI_SCHEME,
  formatNodeSanEntries,
  parseNodeCertificateBinding,
  type NodeCertificateBinding,
} from '../src/node-certificate.js'

const KEY = 'MrHp_KUVbldSTjSKV1ADV8ilbRRJxt-DRlltN54bGWY'
const OTHER_KEY = 'ZrHp_KUVbldSTjSKV1ADV8ilbRRJxt-DRlltN54bGWY'

const BINDING: NodeCertificateBinding = {
  node: 'node-a',
  publicKey: KEY,
  dnsNames: ['node-a.example'],
  ipAddresses: ['127.0.0.1'],
}

/** How `node:crypto` renders the same set: `, ` joined, `IP Address:` for IPs. */
const AS_READ_BACK =
  `DNS:node-a.example, IP Address:127.0.0.1, URI:qianmo://node-a, ` +
  `URI:${NODE_KEY_URI_SCHEME}${KEY}`

describe('node certificate binding (§4.2)', () => {
  test('formats the three SAN classes in the order §4.2 writes them', () => {
    expect(formatNodeSanEntries(BINDING)).toBe(
      `DNS:node-a.example,IP:127.0.0.1,URI:qianmo://node-a,` +
        `URI:${NODE_KEY_URI_SCHEME}${KEY}`,
    )
  })

  test('reads back what node:crypto renders, IP Address: spelling included', () => {
    expect(parseNodeCertificateBinding(AS_READ_BACK)).toEqual(BINDING)
  })

  test('accepts openssl’s own IP: spelling too', () => {
    expect(
      parseNodeCertificateBinding(
        formatNodeSanEntries(BINDING).split(',').join(', '),
      ),
    ).toEqual(BINDING)
  })

  test('a host-only certificate is not a node certificate', () => {
    // F-9's other half: TLS is happy with DNS-only SANs, Qianmo is not — the
    // certificate would carry no node and no key, which is all it exists for.
    expect(parseNodeCertificateBinding('DNS:node-a.example')).toBeNull()
  })

  test('URI-only is refused: nobody could dial it (F-9)', () => {
    expect(
      parseNodeCertificateBinding(
        `URI:qianmo://node-a, URI:${NODE_KEY_URI_SCHEME}${KEY}`,
      ),
    ).toBeNull()
    expect(() =>
      formatNodeSanEntries({ ...BINDING, dnsNames: [], ipAddresses: [] }),
    ).toThrow(/at least one DNS or IP host/)
  })

  test('missing either URI class is refused', () => {
    expect(
      parseNodeCertificateBinding('DNS:a.example, URI:qianmo://node-a'),
    ).toBeNull()
    expect(
      parseNodeCertificateBinding(
        `DNS:a.example, URI:${NODE_KEY_URI_SCHEME}${KEY}`,
      ),
    ).toBeNull()
  })

  test('a smuggled second binding is a rejection, never a substitution', () => {
    // The attack the `, ` split invites: hide an extra entry inside a value.
    // Refusing the whole set is the defence — picking either copy is a guess.
    expect(
      parseNodeCertificateBinding(
        `DNS:a.example, URI:qianmo://node-a, URI:qianmo://node-b, ` +
          `URI:${NODE_KEY_URI_SCHEME}${KEY}`,
      ),
    ).toBeNull()
    expect(
      parseNodeCertificateBinding(
        `DNS:a.example, URI:qianmo://node-a, ` +
          `URI:${NODE_KEY_URI_SCHEME}${KEY}, ` +
          `URI:${NODE_KEY_URI_SCHEME}${OTHER_KEY}`,
      ),
    ).toBeNull()
  })

  test('rejects a malformed node segment or key rather than passing it on', () => {
    expect(
      parseNodeCertificateBinding(
        `DNS:a.example, URI:qianmo://Node_A!, URI:${NODE_KEY_URI_SCHEME}${KEY}`,
      ),
    ).toBeNull()
    expect(
      parseNodeCertificateBinding(
        `DNS:a.example, URI:qianmo://node-a, URI:${NODE_KEY_URI_SCHEME}short`,
      ),
    ).toBeNull()
    expect(parseNodeCertificateBinding(undefined)).toBeNull()
    expect(() =>
      formatNodeSanEntries({ ...BINDING, publicKey: 'short' }),
    ).toThrow(/43 base64url/)
    expect(() => formatNodeSanEntries({ ...BINDING, node: 'Node A' })).toThrow(
      /invalid node segment/,
    )
    expect(() =>
      formatNodeSanEntries({ ...BINDING, ipAddresses: ['not an ip'] }),
    ).toThrow(/invalid IP host/)
    expect(() =>
      formatNodeSanEntries({ ...BINDING, dnsNames: ['bad host,name'] }),
    ).toThrow(/invalid DNS host/)
  })
})
