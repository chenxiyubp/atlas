// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm cert` argument parsing, plus one real end-to-end run of `request`.
 *
 * Parsing tests need no openssl (they stop before a subprocess would start,
 * same discipline as `ca.test.ts`); the end-to-end test does, and skips
 * itself when none is on PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { opensslVersion } from '../../../services/qianmo/ca/openssl.js'
import { verifyCsrPop } from '../../../services/qianmo/ca/pop.js'
import { loadOrCreateNodeKeys } from '../../../services/qianmo/nodeIdentity.js'
import {
  QIANMO_CERT_HELP_TEXT,
  isQianmoCertHelpRequest,
  parseCertRequestArgs,
  runQianmoCert,
} from '../cert.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

const ORIGINAL_EXIT_CODE = process.exitCode

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE ?? 0
})

describe('qm cert argument parsing', () => {
  test('help is answered before anything else, from anywhere in argv', () => {
    expect(isQianmoCertHelpRequest(['request', '--help'])).toBe(true)
    expect(isQianmoCertHelpRequest(['-h'])).toBe(true)
    // A value that happens to look like the flag is a value.
    expect(isQianmoCertHelpRequest(['--node=--help'])).toBe(false)
    for (const fragment of [
      'cert <command>',
      'request',
      '--node <segment>',
      '--host <host>',
      'never leaves this machine',
    ]) {
      expect(QIANMO_CERT_HELP_TEXT).toContain(fragment)
    }
  })

  test('request takes --node and repeatable --host', () => {
    const parsed = parseCertRequestArgs([
      '--node',
      'node-a',
      '--host',
      'node-a.example.com',
      '--host',
      '10.0.0.4',
    ])
    expect(parsed).toEqual({
      node: 'node-a',
      hosts: ['node-a.example.com', '10.0.0.4'],
    })
    expect(
      parseCertRequestArgs(['--node=node-b', '--host=b.example']).node,
    ).toBe('node-b')
  })

  test('refuses to run without --node or without --host (F-9)', () => {
    expect(() => parseCertRequestArgs(['--host', 'a.example'])).toThrow(
      /needs --node/,
    )
    expect(() => parseCertRequestArgs(['--node', 'node-a'])).toThrow(
      /needs at least one --host/,
    )
  })

  test('an unknown option is named, not silently ignored', () => {
    expect(() => parseCertRequestArgs(['--bogus'])).toThrow(
      /unknown cert request option --bogus/,
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
      runQianmoCert(['bogus'])
    } finally {
      process.stderr.write = original
    }
    expect(process.exitCode).toBe(1)
    expect(written.join('')).toContain('unknown cert command bogus')
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
      runQianmoCert([])
    } finally {
      process.stdout.write = original
    }
    expect(written.join('')).toBe(QIANMO_CERT_HELP_TEXT)
    expect(process.exitCode).toBe(0)
  })
})

describe('qm cert request, end to end', () => {
  let root: string
  let previousConfigDir: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-cert-cli-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  })

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(root, { recursive: true, force: true })
  })

  itNeedsOpenssl(
    'prints a ready-to-run `ca issue` line carrying a verifiable PoP',
    () => {
      const keys = loadOrCreateNodeKeys('node-a')
      const written: string[] = []
      const original = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string) => {
        written.push(String(chunk))
        return true
      }) as typeof process.stdout.write
      try {
        runQianmoCert([
          'request',
          '--node',
          'node-a',
          '--host',
          'node-a.example.com',
        ])
      } finally {
        process.stdout.write = original
      }
      const output = written.join('')
      expect(process.exitCode).toBe(0)
      expect(output).toContain('ca issue node-a')
      expect(output).toContain(`--nodekey ${keys.publicKey}`)
      expect(output).toContain('--host node-a.example.com')

      const popMatch = output.match(/--pop (\S+)/)
      const csrPathMatch = output.match(/CSR\s+(\S+)/)
      expect(popMatch).not.toBeNull()
      expect(csrPathMatch).not.toBeNull()
      const csrPem = readFileSync(csrPathMatch?.[1] as string, 'utf8')
      expect(
        verifyCsrPop({
          node: 'node-a',
          publicKey: keys.publicKey,
          csrPem,
          signature: popMatch?.[1] as string,
        }),
      ).toBe(true)
    },
  )
})
