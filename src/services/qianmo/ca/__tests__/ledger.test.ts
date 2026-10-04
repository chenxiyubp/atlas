// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The issuance ledger and `issue`'s refusal to overwrite.
 *
 * What is being pinned: a re-issue no longer erases the previous
 * certificate's fingerprint; an overwrite nobody asked for is refused before
 * anything is signed; and a ledger that does not read cleanly stops issuance
 * rather than being appended to.
 *
 * "Nothing was signed" is checked through `ca.srl`: openssl rewrites the
 * serial file on every signature, so an unchanged serial file is the evidence
 * that the refusal came before the signing step, not after it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { X509Certificate, createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  appendIssuanceRecords,
  issuanceRecordOf,
  readIssuanceLedger,
} from '../ledger.js'
import { initCa, issueCertificate } from '../operations.js'
import { opensslVersion, runOpenssl } from '../openssl.js'
import {
  caKeyPath,
  caSerialPath,
  issuanceLedgerPath,
  issueLockPath,
  issuedCertPath,
} from '../paths.js'
import { popMessage } from '../pop.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

const T0 = Date.parse('2026-10-04T08:00:00.000Z')

let root: string
let caDir: string
let nodeKeys: NodeKeyPair

beforeEach(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-ca-ledger-'))
  caDir = join(root, 'ca')
  initCa({ directory: caDir })
  nodeKeys = generateNodeKeyPair()
})

afterEach(() => {
  if (root === undefined) return
  // A test below makes the CA directory read-only; give it back first.
  if (existsSync(caDir)) chmodSync(caDir, 0o700)
  rmSync(root, { recursive: true, force: true })
})

let csrCounter = 0

function issue(overrides: Record<string, unknown> = {}) {
  csrCounter += 1
  const keyPath = join(root, `node-a-${String(csrCounter)}.key`)
  writeFileSync(
    keyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  const csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    keyPath,
    '-subj',
    '/CN=node-a',
  ])
  return issueCertificate({
    directory: caDir,
    node: 'node-a',
    publicKey: nodeKeys.publicKey,
    csrPem,
    popSignature: signBytes(nodeKeys, popMessage('node-a', csrPem)),
    hosts: ['localhost'],
    ...overrides,
  })
}

/** A well-formed record for a certificate that was never issued here. */
function anotherRecord(fingerprint256: string) {
  return {
    ...issuanceRecordOf(
      new X509Certificate(readFileSync(issuedCertPath(caDir, 'node-a'))),
      'node-b',
      'issue',
      T0,
    ),
    fingerprint256,
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('every issuance is recorded', () => {
  itNeedsOpenssl('the first issue writes one line with all six facts', () => {
    const issued = issue({ now: T0 })
    const certificate = new X509Certificate(issued.certificatePem)
    const ledger = readIssuanceLedger(caDir)
    expect(ledger.path).toBe(issuanceLedgerPath(caDir))
    expect(issued.ledgerPath).toBe(ledger.path)
    expect(ledger.records).toEqual([
      {
        v: 1,
        node: 'node-a',
        serial: certificate.serialNumber.toUpperCase(),
        fingerprint256: certificate.fingerprint256,
        notBefore: new Date(Date.parse(certificate.validFrom)).toISOString(),
        notAfter: new Date(Date.parse(certificate.validTo)).toISOString(),
        issuedAt: '2026-10-04T08:00:00.000Z',
        source: 'issue',
      },
    ])
    // Public material, like every certificate next to it.
    expect(statSync(ledger.path).mode & 0o777).toBe(0o644)
    // The lock is gone once the run is.
    expect(existsSync(issueLockPath(caDir))).toBe(false)
  })

  itNeedsOpenssl(
    'a re-issue with --replace keeps the old fingerprint findable',
    () => {
      const first = issue({ now: T0 })
      const second = issue({ now: T0 + 60_000, replace: true })
      expect(second.fingerprint256).not.toBe(first.fingerprint256)
      expect(second.replacedFingerprint256).toBe(first.fingerprint256)
      // The CA's own copy is now the new certificate…
      expect(
        new X509Certificate(readFileSync(issuedCertPath(caDir, 'node-a')))
          .fingerprint256,
      ).toBe(second.fingerprint256)
      // …and the one it replaced is still on record, in order.
      const forNode = readIssuanceLedger(caDir).records.filter(
        record => record.node === 'node-a',
      )
      expect(forNode.map(record => record.fingerprint256)).toEqual([
        first.fingerprint256,
        second.fingerprint256,
      ])
      expect(forNode.map(record => record.source)).toEqual(['issue', 'issue'])
    },
  )

  itNeedsOpenssl(
    'a certificate from before the ledger is imported before it is replaced',
    () => {
      // A CA that issued before this change: a copy in issued/, no ledger.
      const legacy = issue({ now: T0 })
      rmSync(issuanceLedgerPath(caDir))
      const next = issue({ now: T0 + 60_000, replace: true })
      const records = readIssuanceLedger(caDir).records
      expect(
        records.map(record => [record.fingerprint256, record.source]),
      ).toEqual([
        [legacy.fingerprint256, 'import'],
        [next.fingerprint256, 'issue'],
      ])
      // No better record of when it was signed than its own notBefore.
      expect(records[0]?.issuedAt).toBe(
        new Date(
          Date.parse(new X509Certificate(legacy.certificatePem).validFrom),
        ).toISOString(),
      )
    },
  )
})

describe('an overwrite nobody asked for is refused before signing', () => {
  itNeedsOpenssl('re-issuing without --replace', () => {
    const first = issue({ now: T0 })
    const serialBefore = digest(caSerialPath(caDir))
    const ledgerBefore = digest(issuanceLedgerPath(caDir))
    expect(() => issue({ now: T0 + 60_000 })).toThrow(
      /node-a already has a certificate .*pass --replace.*Nothing was signed/s,
    )
    expect(digest(caSerialPath(caDir))).toBe(serialBefore)
    expect(digest(issuanceLedgerPath(caDir))).toBe(ledgerBefore)
    expect(
      new X509Certificate(readFileSync(issuedCertPath(caDir, 'node-a')))
        .fingerprint256,
    ).toBe(first.fingerprint256)
  })

  itNeedsOpenssl('an existing --out file, without --replace', () => {
    const out = join(root, 'delivered.crt')
    writeFileSync(out, 'somebody else’s file\n')
    expect(() => issue({ outPath: out })).toThrow(
      /already exists; pass --replace/,
    )
    expect(readFileSync(out, 'utf8')).toBe('somebody else’s file\n')
    expect(existsSync(issuanceLedgerPath(caDir))).toBe(false)
    expect(existsSync(caSerialPath(caDir))).toBe(false)
  })

  itNeedsOpenssl(
    '--out inside the CA directory, even with --replace (ca.key survives)',
    () => {
      const keyBefore = digest(caKeyPath(caDir))
      expect(() => issue({ outPath: caKeyPath(caDir), replace: true })).toThrow(
        /is inside the CA directory/,
      )
      expect(() =>
        issue({ outPath: issuanceLedgerPath(caDir), replace: true }),
      ).toThrow(/is inside the CA directory/)
      expect(digest(caKeyPath(caDir))).toBe(keyBefore)
      expect(existsSync(caSerialPath(caDir))).toBe(false)
    },
  )

  itNeedsOpenssl(
    '--replace over a file this CA did not issue is refused too',
    () => {
      issue({ now: T0 })
      writeFileSync(issuedCertPath(caDir, 'node-a'), 'not a certificate\n')
      const serialBefore = digest(caSerialPath(caDir))
      expect(() => issue({ replace: true })).toThrow(
        /does not hold a certificate this CA issued/,
      )
      expect(digest(caSerialPath(caDir))).toBe(serialBefore)
    },
  )

  itNeedsOpenssl(
    'a held lock refuses a second run and says how to clear it',
    () => {
      writeFileSync(issueLockPath(caDir), '12345\n')
      expect(() => issue()).toThrow(/holds .*issue\.lock.*delete that file/s)
      expect(existsSync(caSerialPath(caDir))).toBe(false)
      // The refusal does not take someone else's lock away.
      expect(readFileSync(issueLockPath(caDir), 'utf8')).toBe('12345\n')
    },
  )
})

describe('a ledger that does not read cleanly stops issuance (fail-closed)', () => {
  const cases: readonly [string, (bytes: string) => string, RegExp][] = [
    [
      'a line that is not a record',
      bytes => `${bytes}{"v":1,"node":"node-b"}\n`,
      /line 2 is not a ledger record/,
    ],
    [
      'a hand-edited line (same fields, reordered)',
      bytes => {
        const record = JSON.parse(bytes.trim()) as Record<string, unknown>
        const { v, ...rest } = record
        return `${JSON.stringify({ ...rest, v })}\n`
      },
      /line 1 is not a ledger record/,
    ],
    [
      'a torn last line',
      bytes => `${bytes}{"v":1,"node":"no`,
      /last line is incomplete/,
    ],
    [
      'one fingerprint recorded twice',
      bytes => `${bytes}${bytes}`,
      /line 2 records .* a second time/,
    ],
    ['a blank line', bytes => `${bytes}\n`, /line 2 is not a ledger record/],
  ]

  for (const [label, corrupt, message] of cases) {
    itNeedsOpenssl(label, () => {
      issue({ now: T0 })
      const path = issuanceLedgerPath(caDir)
      writeFileSync(path, corrupt(readFileSync(path, 'utf8')))
      const serialBefore = digest(caSerialPath(caDir))
      const certBefore = digest(issuedCertPath(caDir, 'node-a'))

      expect(() => readIssuanceLedger(caDir)).toThrow(message)
      expect(() => issue({ replace: true })).toThrow(message)
      // Refused before openssl ran, and nothing on disk moved.
      expect(digest(caSerialPath(caDir))).toBe(serialBefore)
      expect(digest(issuedCertPath(caDir, 'node-a'))).toBe(certBefore)
    })
  }
})

describe('the write is atomic', () => {
  itNeedsOpenssl(
    'an append replaces the file in one rename and leaves no temporary',
    () => {
      issue({ now: T0 })
      const path = issuanceLedgerPath(caDir)
      const before = readFileSync(path, 'utf8')
      const inodeBefore = statSync(path).ino
      issue({ now: T0 + 60_000, replace: true })
      const after = readFileSync(path, 'utf8')
      // Append-only: the old bytes are a prefix of the new ones…
      expect(after.startsWith(before)).toBe(true)
      expect(after.split('\n').filter(line => line !== '')).toHaveLength(2)
      // …and they arrived as a new file renamed over the old, not as bytes
      // written into it: a reader never sees half a line.
      expect(statSync(path).ino).not.toBe(inodeBefore)
      expect(readdirSync(caDir).filter(name => name.endsWith('.tmp'))).toEqual(
        [],
      )
    },
  )

  itNeedsOpenssl(
    'a write that fails leaves the previous ledger byte for byte',
    () => {
      if (process.getuid?.() === 0) return // root ignores directory modes
      issue({ now: T0 })
      const path = issuanceLedgerPath(caDir)
      const ledger = readIssuanceLedger(caDir)
      const bytesBefore = readFileSync(path, 'utf8')
      // No temporary file can be created in a read-only directory, which is
      // the first step of the write.
      chmodSync(caDir, 0o500)
      expect(() =>
        appendIssuanceRecords(ledger, [anotherRecord(`${'00:'.repeat(31)}00`)]),
      ).toThrow()
      chmodSync(caDir, 0o700)
      expect(readFileSync(path, 'utf8')).toBe(bytesBefore)
      expect(readdirSync(caDir).filter(name => name.endsWith('.tmp'))).toEqual(
        [],
      )
    },
  )

  itNeedsOpenssl('a ledger changed underneath a run is not appended to', () => {
    issue({ now: T0 })
    const ledger = readIssuanceLedger(caDir)
    const path = issuanceLedgerPath(caDir)
    const tampered = readFileSync(path, 'utf8').replace('node-a', 'node-z')
    writeFileSync(path, tampered)
    expect(() =>
      appendIssuanceRecords(ledger, [anotherRecord(`${'11:'.repeat(31)}11`)]),
    ).toThrow(/changed while this issue was running/)
    expect(readFileSync(path, 'utf8')).toBe(tampered)
  })
})
