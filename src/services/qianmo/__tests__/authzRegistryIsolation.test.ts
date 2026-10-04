// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P14 takes no authorization material from the registry (tenancy-m1.md
 * P15.8 DoD; authorization-m1.md D-6).
 *
 * The registry is a discovery courier: its reads are open, and even with the
 * P15.8 write token a row only says that somebody holding the token wrote it.
 * So nothing P14 decides with — a node public key, an approver key, an
 * approval delivery endpoint — may be looked up there. This scan makes that a
 * test instead of a convention.
 *
 * ## What counts as P14 code
 *
 * Selected by file name inside the Qianmo-owned trees, so modules P14 has
 * not written yet are covered the day they land: any non-test `.ts` / `.tsx`
 * whose name contains `authz`, `grant-store` / `grantStore`, `approval` or
 * `approver`, under `src/` of an `@qianmo/*` package, `src/services/qianmo/`
 * or `src/cli/handlers/`. The base's own permission dialogs (`ApproveApiKey`,
 * `classifierApprovals`, …) are not P14 and are not in those trees. On the
 * base this branch was cut from the set is empty; on the P14 branch
 * (`feat/p14-grantstore`) it is `packages/capability/src/authz.ts` and
 * `packages/resident/src/grant-store.ts`.
 *
 * ## What counts as a registry client
 *
 * An import of `@qianmo/registry` or of anything under `packages/registry`;
 * the console's registry port and renewer (`consolePorts`,
 * `consoleRegistrations`); `certificateDirectory`, which fetches
 * `/v0/agents` itself; and the registry's route literals, which is how a
 * hand-rolled `fetch` would give itself away. Comments are stripped first.
 *
 * A fixture that breaks each rule proves the scan fires.
 */

import { describe, expect, test } from 'bun:test'
import { type Dirent, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

const P14_FILE_NAME = /(?:authz|grant-?store|approv(?:al|er))/i

const REGISTRY_CLIENT: readonly { readonly pattern: RegExp; label: string }[] =
  [
    {
      pattern: /from\s+['"]@qianmo\/registry(?:\/[^'"]*)?['"]/,
      label: '@qianmo/registry import',
    },
    {
      pattern: /from\s+['"][^'"]*packages\/registry\/[^'"]*['"]/,
      label: 'packages/registry import',
    },
    {
      pattern:
        /from\s+['"][^'"]*\/(?:consolePorts|consoleRegistrations)(?:\.js)?['"]/,
      label: 'console registry port import',
    },
    {
      pattern: /from\s+['"][^'"]*\/certificateDirectory(?:\.js)?['"]/,
      label: 'certificateDirectory import (reads /v0/agents)',
    },
    {
      pattern: /import\s*\(\s*['"]@qianmo\/registry['"]\s*\)/,
      label: 'dynamic @qianmo/registry import',
    },
    { pattern: /\/v0\/agents\b/, label: 'registry route literal /v0/agents' },
    {
      pattern: /\/v0\/revocation-list\b/,
      label: 'registry route literal /v0/revocation-list',
    },
  ]

/** Line and block comments out; `https://` survives (same rule as caScan). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n')
}

function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|test|tests)\//.test(path) ||
    /\.test\.tsx?$/.test(path)
  )
}

/** Where Qianmo code lives: `@qianmo/*` packages and the two host trees. */
function qianmoRoots(root: string): string[] {
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, 'packages', entry.name))
    .filter(dir => {
      try {
        const manifest = JSON.parse(
          readFileSync(join(dir, 'package.json'), 'utf8'),
        ) as { name?: unknown }
        return (
          typeof manifest.name === 'string' &&
          manifest.name.startsWith('@qianmo/')
        )
      } catch {
        return false
      }
    })
    .map(dir => join(dir, 'src'))
  return [
    ...packages,
    join(root, 'src', 'services', 'qianmo'),
    join(root, 'src', 'cli', 'handlers'),
  ]
}

/** Every P14 source file under `root`, repository-relative. */
function p14Files(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const rel = relative(root, path)
      if (entry.isDirectory()) {
        walk(path)
      } else if (
        /\.tsx?$/.test(entry.name) &&
        P14_FILE_NAME.test(entry.name) &&
        !isTestPath(rel)
      ) {
        out.push(rel)
      }
    }
  }
  for (const dir of qianmoRoots(root)) walk(dir)
  return out.sort()
}

/** Every rule a source text breaks. */
function registryClientUses(source: string): string[] {
  const code = stripComments(source)
  return REGISTRY_CLIENT.filter(rule => rule.pattern.test(code)).map(
    rule => rule.label,
  )
}

describe('P14 code imports no registry client', () => {
  test('no P14 source file reaches the registry', () => {
    const files = p14Files(REPO_ROOT)
    const violations = files.flatMap(file =>
      registryClientUses(readFileSync(join(REPO_ROOT, file), 'utf8')).map(
        label => `${file}: ${label}`,
      ),
    )
    console.log(
      `[authz-registry-isolation] scanned ${String(files.length)} P14 file(s): ${
        files.join(', ') || '(none on this tree)'
      }`,
    )
    expect(violations).toEqual([])
  })

  test('the file selector picks up P14 modules and skips their tests', () => {
    expect(P14_FILE_NAME.test('authz.ts')).toBe(true)
    expect(P14_FILE_NAME.test('grant-store.ts')).toBe(true)
    expect(P14_FILE_NAME.test('grantStore.ts')).toBe(true)
    expect(P14_FILE_NAME.test('approvalPage.ts')).toBe(true)
    expect(P14_FILE_NAME.test('consoleApprover.ts')).toBe(true)
    expect(P14_FILE_NAME.test('residentGuard.ts')).toBe(false)
    expect(P14_FILE_NAME.test('preapproved.ts')).toBe(false)
    expect(isTestPath('packages/resident/test/grant-store.test.ts')).toBe(true)
    expect(isTestPath('src/services/qianmo/__tests__/authz.test.ts')).toBe(true)
    expect(isTestPath('packages/capability/src/authz.ts')).toBe(false)
  })

  test.each([
    [`import { InMemoryRegistry } from '@qianmo/registry'`],
    [`import type { AgentRecord } from '@qianmo/registry'`],
    [`import { x } from '../../../packages/registry/src/http.js'`],
    [`import { createRegistryPort } from '../../cli/handlers/consolePorts.js'`],
    [`import { ConsoleRegistrations } from './consoleRegistrations.js'`],
    [`import { CertificateDirectory } from '../certificateDirectory.js'`],
    [`const m = await import('@qianmo/registry')`],
    [`const response = await fetch(base + '/v0/agents/' + address)`],
    [`await fetch(url + '/v0/revocation-list')`],
  ])('fires on: %s', source => {
    expect(registryClientUses(source)).not.toEqual([])
  })

  test('stays quiet on prose and on code that is not a registry client', () => {
    expect(
      registryClientUses(
        [
          '// the registry (`/v0/agents`) is never consulted here',
          '/* @qianmo/registry is a discovery courier */',
          `import { verifyBytes } from '@qianmo/capability'`,
          `const url = 'https://example.test/v0/anchor'`,
        ].join('\n'),
      ),
    ).toEqual([])
  })
})
