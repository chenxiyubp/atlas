// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * §5.2's "certificate vs publicKey" bulletin-board rule, end to end.
 *
 * Zero mocks: a real offline CA (`src/services/qianmo/ca/operations.ts`,
 * P12.1) issues real certificates with real openssl, and this file registers
 * them against a real {@link InMemoryRegistry}. Reaching into host `src/` from
 * a *test* file is not the isolation `caScan.test.ts` polices — that scan
 * explicitly exempts test files (its own header says so) precisely so setup
 * code can build the real artefacts the production code is not allowed to
 * reach for. `store.ts` already reaches `src/config/paths.js` from production
 * code in this same package, so a test doing the analogous thing for `ca/`
 * is the lesser reach, not a new one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  initCa,
  issueCertificate,
} from '../../../src/services/qianmo/ca/operations.js'
import {
  opensslVersion,
  runOpenssl,
} from '../../../src/services/qianmo/ca/openssl.js'
import { popMessage } from '../../../src/services/qianmo/ca/pop.js'
import {
  InMemoryRegistry,
  ManualClock,
  RegistryErrorCode,
  type RegistryAuditEvent,
} from '../src/index.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test
if (OPENSSL === null) {
  console.error(
    '[registry certificate] skipping: no usable openssl on PATH — these ' +
      'tests need real certificates, the same requirement `ca.test.ts` has.',
  )
}

const NODE_A = 'node-a'
const ADDRESS_A = `qianmo://${NODE_A}/planner`
const ENDPOINT_A = `wss://${NODE_A}.example.com/planner`

let root: string
let nodeKeys: NodeKeyPair
let certificatePem: string

beforeAll(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-registry-cert-test-'))
  const caDir = join(root, 'ca')
  initCa({ directory: caDir })

  nodeKeys = generateNodeKeyPair()
  const tlsKeyPath = join(root, `${NODE_A}.tls.key`)
  writeFileSync(
    tlsKeyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  const csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    tlsKeyPath,
    '-subj',
    `/CN=${NODE_A}`,
  ])
  const issued = issueCertificate({
    directory: caDir,
    node: NODE_A,
    publicKey: nodeKeys.publicKey,
    csrPem,
    popSignature: signBytes(nodeKeys, popMessage(NODE_A, csrPem)),
    hosts: [`${NODE_A}.example.com`],
  })
  certificatePem = issued.certificatePem
})

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

let clock: ManualClock
let registry: InMemoryRegistry
let audits: RegistryAuditEvent[]

function freshRegistry(): void {
  clock = new ManualClock(1_000)
  audits = []
  registry = new InMemoryRegistry({
    clock,
    onAudit: event => audits.push(event),
  })
}

describe('registering a certificate alongside publicKey (§5.2)', () => {
  itNeedsOpenssl('a consistent certificate is stored on the record', () => {
    freshRegistry()
    const result = registry.register(ADDRESS_A, ENDPOINT_A, {
      publicKey: nodeKeys.publicKey,
      certificate: certificatePem,
    })
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
    expect(result.entry.certificate).toBe(certificatePem)
    expect(result.entry.publicKey).toBe(nodeKeys.publicKey)
    expect(registry.resolve(ADDRESS_A)?.certificate).toBe(certificatePem)
    expect(audits).toEqual([])
  })

  itNeedsOpenssl(
    'a certificate with no publicKey alongside it fills the key in',
    () => {
      freshRegistry()
      const result = registry.register(ADDRESS_A, ENDPOINT_A, {
        certificate: certificatePem,
      })
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
      expect(result.entry.publicKey).toBe(nodeKeys.publicKey)
      expect(audits).toEqual([])
    },
  )

  itNeedsOpenssl(
    'publicKey disagreeing with the certificate is refused and audited',
    () => {
      freshRegistry()
      const impostor = generateNodeKeyPair()
      const result = registry.register(ADDRESS_A, ENDPOINT_A, {
        publicKey: impostor.publicKey,
        certificate: certificatePem,
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected refusal')
      expect(result.code).toBe(RegistryErrorCode.E_BAD_REQUEST)
      expect(registry.resolve(ADDRESS_A)).toBeNull()
      expect(audits).toHaveLength(1)
      expect(audits[0]?.node).toBe(NODE_A)
      expect(audits[0]?.reason).toContain('publicKey does not match')
    },
  )

  itNeedsOpenssl(
    'a certificate bound to a different node is refused and audited',
    () => {
      freshRegistry()
      // The same real certificate, registered under a name it does not name.
      const result = registry.register(
        'qianmo://node-b/planner',
        'wss://node-b.example.com/planner',
        { certificate: certificatePem },
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected refusal')
      expect(audits).toHaveLength(1)
      expect(audits[0]?.node).toBe('node-b')
      expect(audits[0]?.reason).toContain('names node node-a')
    },
  )

  test('a malformed certificate string is refused and audited', () => {
    freshRegistry()
    const result = registry.register(ADDRESS_A, ENDPOINT_A, {
      certificate: 'not a certificate',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.code).toBe(RegistryErrorCode.E_BAD_REQUEST)
    expect(audits).toHaveLength(1)
    expect(audits[0]?.reason).toContain('does not carry a valid node binding')
  })

  test('an oversized certificate is refused before it is even parsed', () => {
    freshRegistry()
    const result = registry.register(ADDRESS_A, ENDPOINT_A, {
      certificate: 'x'.repeat(10_000),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    // Too large to be a real certificate — refused on shape, not audited:
    // this is routine client-error territory, not a forgery signal.
    expect(audits).toEqual([])
  })

  itNeedsOpenssl(
    'the mismatch never partially lands — the record is dropped whole',
    () => {
      freshRegistry()
      registry.register(ADDRESS_A, ENDPOINT_A, {
        publicKey: nodeKeys.publicKey,
      })
      const impostor = generateNodeKeyPair()
      registry.register(ADDRESS_A, ENDPOINT_A, {
        publicKey: impostor.publicKey,
        certificate: certificatePem,
      })
      // The endpoint conflict check runs before the certificate check, so the
      // first, honest registration is untouched.
      expect(registry.resolve(ADDRESS_A)?.publicKey).toBe(nodeKeys.publicKey)
      expect(registry.resolve(ADDRESS_A)?.certificate).toBeUndefined()
    },
  )
})

describe('restoring a certificate from disk (the same trust boundary)', () => {
  itNeedsOpenssl('round-trips a consistent record', () => {
    freshRegistry()
    let store: unknown = null
    const withStore = new InMemoryRegistry({
      clock,
      store: {
        read: () => store,
        write: document => {
          store = document
        },
      },
    })
    withStore.register(ADDRESS_A, ENDPOINT_A, {
      publicKey: nodeKeys.publicKey,
      certificate: certificatePem,
    })

    const restored = new InMemoryRegistry({
      clock,
      store: { read: () => store, write: () => {} },
    })
    expect(restored.resolve(ADDRESS_A)?.certificate).toBe(certificatePem)
    expect(restored.resolve(ADDRESS_A)?.publicKey).toBe(nodeKeys.publicKey)
  })

  itNeedsOpenssl(
    'a record whose stored fields were tampered into disagreement is dropped and audited',
    () => {
      const impostor = generateNodeKeyPair()
      const tampered = {
        version: 1,
        agents: [
          {
            address: ADDRESS_A,
            endpoint: ENDPOINT_A,
            capabilities: [],
            publicKey: impostor.publicKey,
            certificate: certificatePem,
            status: 'online',
            registeredAt: 1_000,
            lastHeartbeatAt: 1_000,
          },
        ],
      }
      const auditsOnRestore: RegistryAuditEvent[] = []
      const restored = new InMemoryRegistry({
        clock: new ManualClock(1_000),
        onAudit: event => auditsOnRestore.push(event),
        store: { read: () => tampered, write: () => {} },
      })
      expect(restored.resolve(ADDRESS_A)).toBeNull()
      expect(restored.size).toBe(0)
      expect(auditsOnRestore).toHaveLength(1)
      expect(auditsOnRestore[0]?.reason).toContain('does not match')
    },
  )
})

describe('revocation list storage (§6.4 — a courier, not a verifier)', () => {
  test('accepts and returns the {payload, signature} shape', () => {
    freshRegistry()
    expect(registry.revocationList).toBeNull()
    const document = { payload: 'ZmFrZQ', signature: 'ZmFrZQ' }
    expect(registry.publishRevocationList(document)).toBe(true)
    expect(registry.revocationList).toEqual(document)
  })

  test('a later publish replaces the earlier one', () => {
    freshRegistry()
    registry.publishRevocationList({ payload: 'a', signature: 'a' })
    registry.publishRevocationList({ payload: 'b', signature: 'b' })
    expect(registry.revocationList).toEqual({ payload: 'b', signature: 'b' })
  })

  test('rejects anything that is not exactly {payload, signature}', () => {
    freshRegistry()
    for (const bad of [
      null,
      42,
      'a string',
      {},
      { payload: 'a' },
      { payload: 'a', signature: 'a', extra: 1 },
      { payload: '', signature: 'a' },
      { payload: 1, signature: 'a' },
    ]) {
      expect(registry.publishRevocationList(bad)).toBe(false)
    }
    expect(registry.revocationList).toBeNull()
  })
})
