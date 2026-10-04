// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { findMacroGuardOffenses } from '../check-macro-guards.ts'

/**
 * The four spellings issue #75 found in the tree, verbatim. Assembled at
 * runtime so this file does not itself contain the banned idiom in code — the
 * gate scans `scripts/` too, and a fixture that trips it would be indexed as a
 * real offense.
 */
const BANNED = `type${'of'} MACRO`

describe('findMacroGuardOffenses', () => {
  test('flags the ternary form and reports its line', () => {
    const source = [
      'const a = 1',
      '',
      `const v = ${BANNED} !== 'undefined'`,
    ].join('\n')

    const offenses = findMacroGuardOffenses(source)

    expect(offenses).toHaveLength(1)
    expect(offenses[0]?.line).toBe(3)
  })

  test('flags the early-return form', () => {
    expect(
      findMacroGuardOffenses(`if (${BANNED} === 'undefined') return`),
    ).toHaveLength(1)
  })

  test('flags the parenthesised spelling', () => {
    expect(
      findMacroGuardOffenses(`if (type${'of'}(MACRO) === 'x') {}`),
    ).toHaveLength(1)
  })

  test('leaves typeof globalThis.MACRO alone', () => {
    // How cli.tsx decides whether to install its fallback: a real property of
    // a real object, which is the only correct runtime question about MACRO.
    const source = `if (type${'of'} globalThis.MACRO === 'undefined') {}`

    expect(findMacroGuardOffenses(source)).toEqual([])
  })

  test('ignores the idiom inside comments', () => {
    const source = [
      `// never write ${BANNED} !== 'undefined'`,
      `/* ${BANNED} is false in every bundle */`,
      '/**',
      ` * ${BANNED} — see issue #75`,
      ' */',
      'const ok = 1',
    ].join('\n')

    expect(findMacroGuardOffenses(source)).toEqual([])
  })

  test('ignores the idiom inside string and template literals', () => {
    const source = [
      `const a = '${BANNED}'`,
      `const b = "${BANNED}"`,
      'const c = `' + BANNED + '`',
    ].join('\n')

    expect(findMacroGuardOffenses(source)).toEqual([])
  })

  test('still sees code hidden in a template substitution hole', () => {
    const source = 'const s = `v=${' + BANNED + " !== 'undefined' ? 1 : 0}`"

    expect(findMacroGuardOffenses(source)).toHaveLength(1)
  })

  test('an escaped quote does not swallow the rest of the file', () => {
    const source = ["const a = 'it\\'s fine'", `const b = ${BANNED}`].join('\n')

    const offenses = findMacroGuardOffenses(source)

    expect(offenses).toHaveLength(1)
    expect(offenses[0]?.line).toBe(2)
  })
})
