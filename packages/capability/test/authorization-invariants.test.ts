// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rule S-3 as an assertion instead of a sentence.
 *
 * "A cross-node message must not raise a local agent's permission level" is
 * easy to satisfy today and easy to lose next month: all it takes is one
 * plausible-looking call into the base's permission machinery from code that
 * handles inbound envelopes. So this file scans the Qianmo sources for the base
 * APIs that *change* permission state and fails if one shows up.
 *
 * Two things make the scan worth having rather than decorative:
 *
 * - it names **mutators only**. Reading a permission mode is fine and happens;
 *   what must never happen is writing one from the inbound path. A detector
 *   that also flagged reads would be turned off within a week.
 * - its red direction is pinned by fixtures. A scanner that has never fired is
 *   indistinguishable from one that scans nothing, and this suite has been on
 *   the wrong side of that before (P0.7's bind invariant was green because it
 *   had no files to look at).
 *
 * Same mechanism as `activator/test/surface-invariant.test.ts`; the comment
 * stripping is there for the same reason — prose has to be able to name these
 * functions in order to explain why they are absent.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * Everything Qianmo owns that can see an inbound envelope.
 *
 * Listed rather than globbed: a new base package appearing under `packages/`
 * must not silently enter this scan's scope, and a new Qianmo package that
 * handles envelopes should have to be added here on purpose.
 */
const SCANNED = [
  'packages/adapter/src',
  'packages/activator/src',
  'packages/capability/src',
  'packages/recall/src',
  'packages/registry/src',
  'packages/resident/src',
  'packages/router/src',
  'packages/transport/src',
  'src/services/qianmo',
]

/**
 * Base functions that *mutate* permission state.
 *
 * `permissionSync` is the base's leader↔teammate approval channel; protocol.md
 * §6.5 rules it out of Qianmo's path entirely, so its name appearing at all is
 * a finding rather than a judgement call.
 */
const FORBIDDEN = [
  'permissionSync',
  'setSessionBypassPermissionsMode',
  'addPermissionRulesToSettings',
  'deletePermissionRuleFromSettings',
  'restoreDangerousPermissions',
  'stripDangerousPermissionsForAutoMode',
  'cyclePermissionMode',
  'setPermissionModeChangedListener',
]

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function sourceFiles(dir: string): string[] {
  const absolute = join(REPO_ROOT, dir)
  if (!existsSync(absolute)) return []
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) {
        if (entry === '__tests__' || entry === 'test') continue
        walk(path)
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        found.push(path)
      }
    }
  }
  walk(absolute)
  return found
}

interface Finding {
  readonly file: string
  readonly symbol: string
}

function scan(text: string, file: string): Finding[] {
  const stripped = stripComments(text)
  return FORBIDDEN.filter(symbol => stripped.includes(symbol)).map(symbol => ({
    file,
    symbol,
  }))
}

describe('rule S-3 — nothing in the Qianmo path writes permission state', () => {
  test('the scan covers real files, not an empty set', () => {
    const files = SCANNED.flatMap(sourceFiles)
    expect(files.length).toBeGreaterThan(30)
  })

  test('no Qianmo source calls a permission mutator', () => {
    const findings = SCANNED.flatMap(sourceFiles).flatMap(file =>
      scan(readFileSync(file, 'utf8'), file.slice(REPO_ROOT.length + 1)),
    )
    expect(findings).toEqual([])
  })

  test('the detector fires on code that does call one', () => {
    // The red direction, pinned. Without this, deleting FORBIDDEN's contents
    // would leave the suite green and the invariant gone.
    const guilty = `
      import { addPermissionRulesToSettings } from 'src/utils/permissions/permissionsLoader.js'
      export function grant(): void { addPermissionRulesToSettings([]) }
    `
    expect(scan(guilty, 'fixture.ts')).toEqual([
      { file: 'fixture.ts', symbol: 'addPermissionRulesToSettings' },
    ])
  })

  test('the detector does not fire on prose that discusses one', () => {
    const innocent = `
      // We deliberately do not call permissionSync here: protocol.md §6.5.
      /* Nor setSessionBypassPermissionsMode, for the same reason. */
      export const note = 'see the module header'
    `
    expect(scan(innocent, 'fixture.ts')).toEqual([])
  })
})
