// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGE_ROOT = join(import.meta.dir, '..')

describe('@qianmo/providers stays a zero-dependency leaf', () => {
  test('package.json declares no runtime dependencies of any kind', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as Record<string, unknown>
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
      'bundledDependencies',
    ]) {
      expect(manifest[field]).toBeUndefined()
    }
  })

  test('sources import only each other and node: builtins — never src/', () => {
    const sourceDir = join(PACKAGE_ROOT, 'src')
    const offenders: string[] = []
    for (const file of readdirSync(sourceDir)) {
      if (!file.endsWith('.ts')) continue
      const body = readFileSync(join(sourceDir, file), 'utf8')
      for (const match of body.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? ''
        if (specifier.startsWith('./') || specifier.startsWith('node:'))
          continue
        offenders.push(`${file}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
