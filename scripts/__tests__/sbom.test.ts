// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for the license classifier behind `bun run sbom`.
 *
 * The classifier is the only part of the SBOM script that makes a judgement
 * rather than copying a field, and P8.4's DoD ("no contagious licenses, or
 * isolated and recorded") is decided by its output. The cases below are the
 * ones where a naive substring scan gets the wrong answer:
 *
 *   - `(MIT OR GPL-2.0)` is NOT a contagion finding — the MIT branch is ours
 *     to take. Flagging it would bury the real hits under dual-licensed noise.
 *   - `GPL-2.0 WITH Classpath-exception-2.0` does not infect a linking
 *     consumer; the exception exists precisely to say so.
 *   - `Unlicense` (public domain) and `UNLICENSED` (no grant at all) differ by
 *     two characters and by everything else.
 */

import { describe, expect, test } from 'bun:test'
import { classifyLicense, type LicenseTier, readLicenseField } from '../sbom.ts'

const COPYLEFT_CASES: Array<[string, LicenseTier]> = [
  ['GPL-3.0-only', 'strong-copyleft'],
  ['GPL-2.0', 'strong-copyleft'],
  ['LGPL-3.0-or-later', 'weak-copyleft'],
  ['AGPL-3.0-only', 'network-copyleft'],
  ['SSPL-1.0', 'network-copyleft'],
  ['EUPL-1.2', 'network-copyleft'],
  ['OSL-3.0', 'network-copyleft'],
  ['CDDL-1.0', 'weak-copyleft'],
  ['MPL-2.0', 'weak-copyleft'],
  ['EPL-2.0', 'weak-copyleft'],
  ['CC-BY-SA-4.0', 'strong-copyleft'],
]

describe('classifyLicense — permissive', () => {
  test.each([
    'MIT',
    'ISC',
    'Apache-2.0',
    '0BSD',
    'BSD-3-Clause',
    'CC0-1.0',
  ])('%s is permissive and not contagious', id => {
    const verdict = classifyLicense(id)
    expect(verdict.tier).toBe('permissive')
    expect(verdict.contagious).toBe(false)
    expect(verdict.issues).toEqual([])
  })

  test('Unlicense is public domain, not a missing grant', () => {
    const verdict = classifyLicense('Unlicense')
    expect(verdict.tier).toBe('permissive')
  })
})

describe('classifyLicense — copyleft families', () => {
  test.each(
    COPYLEFT_CASES,
  )('%s classifies as %s and is contagious', (id, tier) => {
    const verdict = classifyLicense(id)
    expect(verdict.tier).toBe(tier)
    expect(verdict.contagious).toBe(true)
  })

  test('CC-BY-4.0 is attribution-only, not share-alike', () => {
    const verdict = classifyLicense('CC-BY-4.0')
    expect(verdict.tier).toBe('permissive')
    expect(verdict.contagious).toBe(false)
  })
})

describe('classifyLicense — SPDX expressions', () => {
  test('OR takes the most permissive branch', () => {
    const verdict = classifyLicense('(MIT OR GPL-2.0)')
    expect(verdict.tier).toBe('permissive')
    expect(verdict.contagious).toBe(false)
    expect(verdict.ids).toEqual(['MIT', 'GPL-2.0'])
  })

  test('OR order does not matter', () => {
    expect(classifyLicense('GPL-2.0 OR MIT').tier).toBe('permissive')
  })

  test('AND takes the most restrictive branch', () => {
    const verdict = classifyLicense('MIT AND GPL-3.0-only')
    expect(verdict.tier).toBe('strong-copyleft')
    expect(verdict.contagious).toBe(true)
  })

  test('nested parentheses are respected', () => {
    // Every branch of the OR carries a GPL obligation, so nothing is escapable.
    expect(classifyLicense('(MIT AND GPL-2.0) OR AGPL-3.0-only').tier).toBe(
      'strong-copyleft',
    )
  })

  test('multi-way OR still finds the permissive branch', () => {
    expect(classifyLicense('(BSD-2-Clause OR MIT OR Apache-2.0)').tier).toBe(
      'permissive',
    )
  })

  test('lowercase operators still parse', () => {
    expect(classifyLicense('MIT or GPL-2.0').tier).toBe('permissive')
  })

  test('a linking exception downgrades one tier', () => {
    const verdict = classifyLicense('GPL-2.0 WITH Classpath-exception-2.0')
    expect(verdict.tier).toBe('weak-copyleft')
  })

  test('an unknown exception leaves the tier alone', () => {
    const verdict = classifyLicense('GPL-3.0-only WITH Some-unknown-exception')
    expect(verdict.tier).toBe('strong-copyleft')
  })
})

describe('classifyLicense — problem fields', () => {
  test('a missing field is unknown, and flagged as missing', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const verdict = classifyLicense(raw)
      expect(verdict.tier).toBe('unknown')
      expect(verdict.issues).toContain('missing')
    }
  })

  test('SEE LICENSE IN is unknown and flagged, not silently permissive', () => {
    const verdict = classifyLicense('SEE LICENSE IN LICENSE.md')
    expect(verdict.tier).toBe('unknown')
    expect(verdict.issues).toContain('see-license-in')
    expect(verdict.issues).toContain('non-spdx')
  })

  test('UNLICENSED is restricted — the opposite of Unlicense', () => {
    const verdict = classifyLicense('UNLICENSED')
    expect(verdict.tier).toBe('restricted')
    expect(classifyLicense('Unlicense').tier).toBe('permissive')
  })

  test('an unrecognized id stays unknown rather than being guessed', () => {
    const verdict = classifyLicense('Totally-Made-Up-1.0')
    expect(verdict.tier).toBe('unknown')
    expect(verdict.unrecognized).toEqual(['Totally-Made-Up-1.0'])
    expect(verdict.issues).toContain('unrecognized')
  })

  test('a legacy alias is resolved but marked non-SPDX', () => {
    const verdict = classifyLicense('BSD')
    expect(verdict.tier).toBe('permissive')
    expect(verdict.issues).toContain('non-spdx')
  })

  test('unknown is treated as worse than permissive under AND', () => {
    expect(classifyLicense('MIT AND Totally-Made-Up-1.0').tier).toBe('unknown')
  })

  test('unknown loses to permissive under OR', () => {
    expect(classifyLicense('MIT OR Totally-Made-Up-1.0').tier).toBe(
      'permissive',
    )
  })
})

describe('readLicenseField', () => {
  test('reads the modern string field', () => {
    expect(readLicenseField({ license: 'MIT' })).toBe('MIT')
  })

  test('reads the legacy object form', () => {
    expect(readLicenseField({ license: { type: 'ISC' } })).toBe('ISC')
  })

  test('joins the legacy licenses array as an OR expression', () => {
    expect(
      readLicenseField({
        licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
      }),
    ).toBe('(MIT OR Apache-2.0)')
  })

  test('returns empty string when there is no license field at all', () => {
    expect(readLicenseField({ name: 'x' })).toBe('')
    expect(readLicenseField(null)).toBe('')
  })
})
