// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm ca` argument parsing and the failure surface an operator actually meets.
 *
 * No openssl here on purpose: everything below stops before a subprocess would
 * start, which is what makes it the right place to pin the messages.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QIANMO_CA_HELP_TEXT,
  isQianmoCaHelpRequest,
  parseCaInitArgs,
  parseCaIssueArgs,
  parseCaRefreshArgs,
  runQianmoCa,
} from '../ca.js'

const CA_DIR = '/tmp/qianmo-ca-arg-tests'
const KEY = 'MrHp_KUVbldSTjSKV1ADV8ilbRRJxt-DRlltN54bGWY'

const ORIGINAL_EXIT_CODE = process.exitCode

afterEach(() => {
  // `process.exitCode = undefined` does not reliably clear a set code, so the
  // baseline is normalised to 0 rather than to whatever it was at import.
  process.exitCode = ORIGINAL_EXIT_CODE ?? 0
})

describe('qm ca argument parsing', () => {
  test('help is answered before anything else, from anywhere in argv', () => {
    expect(isQianmoCaHelpRequest(['issue', '--help'])).toBe(true)
    expect(isQianmoCaHelpRequest(['-h'])).toBe(true)
    // A value that happens to look like the flag is a value.
    expect(isQianmoCaHelpRequest(['--pop=--help'])).toBe(false)
    for (const fragment of [
      'ca <command>',
      'issue <node>',
      'refresh-rl',
      '--host <host>',
      '--pop <signature>',
      '--nodekey <key>',
      '--replace',
      'ledger',
      'issued-ledger.jsonl',
      '--import-from <dir>',
      'qianmo-ca-<UTC',
    ]) {
      expect(QIANMO_CA_HELP_TEXT).toContain(fragment)
    }
  })

  test('init takes the CA directory, a CN and a lifetime', () => {
    expect(parseCaInitArgs(['--ca-dir', CA_DIR])).toEqual({ directory: CA_DIR })
    expect(
      parseCaInitArgs([`--ca-dir=${CA_DIR}`, '--cn=my-ca', '--days=30']),
    ).toEqual({ directory: CA_DIR, commonName: 'my-ca', days: 30 })
    expect(() => parseCaInitArgs(['--days=0', '--ca-dir', CA_DIR])).toThrow(
      /--days must be a positive integer/,
    )
    expect(() => parseCaInitArgs(['--nope'])).toThrow(/unknown ca init option/)
  })

  test('issue takes the node positionally, and --host repeats', () => {
    const parsed = parseCaIssueArgs([
      'node-a',
      '--ca-dir',
      CA_DIR,
      '--csr',
      '/tmp/node-a.csr',
      '--pop',
      'A'.repeat(86),
      '--nodekey',
      KEY,
      '--host',
      'node-a.example',
      '--host',
      '10.0.0.4',
    ])
    expect(parsed.node).toBe('node-a')
    expect(parsed.hosts).toEqual(['node-a.example', '10.0.0.4'])
    expect(parsed.publicKey).toBe(KEY)
    expect(parsed.csrPath).toBe('/tmp/node-a.csr')
    // Overwriting is opt-in: absent means refuse.
    expect(parsed.replace).toBe(false)

    // `--node` stays available for scripts that prefer flags to positions.
    expect(
      parseCaIssueArgs([
        '--node=node-b',
        `--ca-dir=${CA_DIR}`,
        '--csr=/tmp/b.csr',
        '--pop=' + 'A'.repeat(86),
        `--nodekey=${KEY}`,
        '--host=b.example',
      ]).node,
    ).toBe('node-b')
  })

  test('--replace is a bare flag that opts into overwriting', () => {
    expect(
      parseCaIssueArgs([
        'node-a',
        '--ca-dir',
        CA_DIR,
        '--csr',
        '/tmp/node-a.csr',
        '--pop',
        'A'.repeat(86),
        '--nodekey',
        KEY,
        '--host',
        'node-a.example',
        '--replace',
      ]).replace,
    ).toBe(true)
  })

  test('issue refuses to run without a host (F-9)', () => {
    expect(() =>
      parseCaIssueArgs([
        'node-a',
        '--ca-dir',
        CA_DIR,
        '--csr',
        '/tmp/a.csr',
        '--pop',
        'A'.repeat(86),
        '--nodekey',
        KEY,
      ]),
    ).toThrow(/needs at least one --host/)
  })

  test('issue names the missing flag rather than failing generically', () => {
    const base = ['node-a', '--ca-dir', CA_DIR, '--host', 'a.example']
    expect(() => parseCaIssueArgs(base)).toThrow(/needs --csr/)
    expect(() => parseCaIssueArgs([...base, '--csr', '/tmp/a.csr'])).toThrow(
      /needs --pop/,
    )
    expect(() =>
      parseCaIssueArgs([...base, '--csr', '/tmp/a.csr', '--pop', 'x']),
    ).toThrow(/needs --nodekey/)
    expect(() =>
      parseCaIssueArgs(['--ca-dir', CA_DIR, '--host', 'a.example']),
    ).toThrow(/needs a <node>/)
  })

  test('refresh-rl parses repeated revocations and shares one reason', () => {
    const parsed = parseCaRefreshArgs([
      '--ca-dir',
      CA_DIR,
      '--revoke',
      'node-a=AA:BB',
      '--revoke=node-b=ccdd',
      '--reason',
      'drill',
      '--valid-days',
      '7',
      '--out',
      '/tmp/rl.json',
    ])
    expect(parsed.revoke).toEqual([
      { node: 'node-a', fingerprint256: 'AA:BB', reason: 'drill' },
      { node: 'node-b', fingerprint256: 'ccdd', reason: 'drill' },
    ])
    expect(parsed.validMs).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parsed.outPath).toBe('/tmp/rl.json')
    expect(() =>
      parseCaRefreshArgs(['--ca-dir', CA_DIR, '--revoke', 'node-a']),
    ).toThrow(/<node>=<fingerprint256>/)
  })

  test('refresh-rl --import-from names the previous CA directory', () => {
    expect(
      parseCaRefreshArgs(['--ca-dir', CA_DIR, '--import-from', '/tmp/old-ca'])
        .importFrom,
    ).toBe('/tmp/old-ca')
    expect(
      parseCaRefreshArgs([`--ca-dir=${CA_DIR}`, '--import-from=/tmp/old-ca'])
        .importFrom,
    ).toBe('/tmp/old-ca')
    // Absent means a plain re-sign, not an import from somewhere implied.
    expect(parseCaRefreshArgs(['--ca-dir', CA_DIR])).not.toHaveProperty(
      'importFrom',
    )
  })

  test('an unknown command exits 1 with one line, not a stack', () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      runQianmoCa(['bogus'])
    } finally {
      process.stderr.write = original
    }
    expect(process.exitCode).toBe(1)
    expect(written.join('')).toContain('unknown ca command bogus')
    expect(written.join('')).not.toContain('at ')
  })

  test('no arguments prints the help rather than an error', () => {
    process.exitCode = 0
    const written: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      runQianmoCa([])
    } finally {
      process.stdout.write = original
    }
    expect(written.join('')).toBe(QIANMO_CA_HELP_TEXT)
    expect(process.exitCode).toBe(0)
  })
})

/** Capture what one `runQianmoCa` call writes, on both streams. */
function capture(args: readonly string[]): { out: string; err: string } {
  const out: string[] = []
  const err: string[] = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    runQianmoCa(args)
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
  return { out: out.join(''), err: err.join('') }
}

describe('qm ca ledger', () => {
  const FP = (byte: string) => `${`${byte}:`.repeat(31)}${byte}`
  const line = (node: string, fingerprint: string, issuedAt: string) =>
    `${JSON.stringify({
      v: 1,
      node,
      serial: '1CC6235D',
      fingerprint256: fingerprint,
      notBefore: issuedAt,
      notAfter: '2027-01-02T08:00:00.000Z',
      issuedAt,
      source: 'issue',
    })}\n`

  test('lists one node’s certificates, superseded ones included', () => {
    process.exitCode = 0
    const dir = mkdtempSync(join(tmpdir(), 'qianmo-ca-ledger-cli-'))
    try {
      writeFileSync(
        join(dir, 'issued-ledger.jsonl'),
        line('node-a', FP('AA'), '2026-10-04T08:00:00.000Z') +
          line('node-b', FP('BB'), '2026-10-04T08:05:00.000Z') +
          line('node-a', FP('CC'), '2027-01-01T08:00:00.000Z'),
      )
      const { out } = capture(['ledger', '--ca-dir', dir, '--node', 'node-a'])
      expect(out).toContain('2 of 3 certificate(s)')
      // The replaced one is the reason this command exists.
      expect(out).toContain(FP('AA'))
      expect(out).toContain(FP('CC'))
      expect(out).not.toContain(FP('BB'))
      expect(process.exitCode).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a line it cannot read exits 1 and names the line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qianmo-ca-ledger-cli-'))
    try {
      writeFileSync(
        join(dir, 'issued-ledger.jsonl'),
        `${line('node-a', FP('AA'), '2026-10-04T08:00:00.000Z')}not json\n`,
      )
      const { out, err } = capture(['ledger', '--ca-dir', dir])
      expect(process.exitCode).toBe(1)
      expect(err).toContain('line 2 is not a ledger record')
      expect(out).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
