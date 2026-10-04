// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  analyzeLicenseHeaders,
  carriesAgplSpdxLine,
  checkEnumerationSanity,
  forbiddenMarksIn,
  hasQianmoHeader,
  isExemptByExtension,
  isExemptByPath,
  type LicenseHeaderInputs,
  type LicenseHeaderResult,
  resolveSnapshotTree,
  resolveTrackedFiles,
} from '../check-license-headers.ts'

/**
 * The two header lines, assembled at runtime.
 *
 * Written out literally they would be indistinguishable from this file's own
 * header. The gate only reads the first 5 lines, so a fixture further down is
 * harmless *today* — but the point of the idiom (same one as
 * checkMacroGuards.test.ts) is that it stays harmless no matter where the
 * fixture ends up, and that a repo-wide grep for the header never has to
 * decide whether a hit is a claim or a test case.
 */
const COPY = `Copyright 2026 Qianmo Agent${'Nest'} Team`
const SPDX = `SPDX-License-${'Identifier'}: AGPL-3.0-or-later`

const SLASH_HEAD = `// ${COPY}\n// ${SPDX}\n\nexport const a = 1\n`
const HASH_HEAD = `# ${COPY}\n# ${SPDX}\n\necho hi\n`
const HTML_HEAD = `<!-- ${COPY} -->\n<!-- ${SPDX} -->\n\n# Title\n`
const SHEBANG_HEAD = `#!/usr/bin/env bun\n// ${COPY}\n// ${SPDX}\n\nconst a = 1\n`

const SCRIPT = join(import.meta.dir, '..', 'check-license-headers.ts')

/** `null` body = tracked but gone from the working tree (ENOENT). */
function inputs(
  files: Record<string, string | null>,
  snapshot: readonly string[] = [],
  unreadable: readonly string[] = [],
): LicenseHeaderInputs {
  const prefixes = new Map<string, string>()
  for (const [path, body] of Object.entries(files)) {
    if (body !== null) prefixes.set(path, body)
  }
  return {
    tracked: Object.keys(files),
    snapshot: new Set(snapshot),
    prefixes,
    unreadable: new Set(unreadable),
  }
}

const scratchDirs: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'license-headers-'))
  scratchDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe('hasQianmoHeader — the first-5-lines window', () => {
  test('accepts all three comment syntaxes in the tree', () => {
    expect(hasQianmoHeader(SLASH_HEAD)).toBe(true)
    expect(hasQianmoHeader(HASH_HEAD)).toBe(true)
    expect(hasQianmoHeader(HTML_HEAD)).toBe(true)
  })

  test('accepts a header pushed to lines 2-3 by a shebang', () => {
    // 45 of the 647 headers in the tree look exactly like this; a "lines 1-2"
    // window would reject every one of them.
    expect(hasQianmoHeader(SHEBANG_HEAD)).toBe(true)
  })

  test('accepts the last line of the window and rejects the one after', () => {
    const atFive = `a\nb\n// ${COPY}\nc\n// ${SPDX}\nd\n`
    const atSix = `a\nb\nc\n// ${COPY}\nd\n// ${SPDX}\n`

    expect(hasQianmoHeader(atFive)).toBe(true)
    expect(hasQianmoHeader(atSix)).toBe(false)
  })

  test('needs both lines, not either one', () => {
    expect(hasQianmoHeader(`// ${COPY}\n`)).toBe(false)
    expect(hasQianmoHeader(`// ${SPDX}\n`)).toBe(false)
  })

  test('rejects both marks smuggled onto a single line', () => {
    // The one place this gate is stricter than the NOTICE 一、许可 substring
    // criterion: a string literal cannot pass as a header.
    expect(hasQianmoHeader(`const s = '${COPY} ${SPDX}'\n`)).toBe(false)
  })

  test('still accepts when one line happens to carry both plus a real pair', () => {
    // Order must not matter: the rule is "exists i≠j", not "copyright first".
    const source = `// ${COPY} ${SPDX}\n// ${COPY}\n`

    expect(hasQianmoHeader(source)).toBe(true)
  })

  test('the reverse probe keys on the SPDX line alone', () => {
    // A misapplied header is "an AGPL stamp on MIT code"; whether the
    // copyright line came along does not make it less of a claim.
    expect(carriesAgplSpdxLine(`// ${SPDX}\n`)).toBe(true)
    expect(carriesAgplSpdxLine(`// ${COPY}\n`)).toBe(false)
    expect(carriesAgplSpdxLine(`a\nb\nc\nd\ne\n// ${SPDX}\n`)).toBe(false)
  })
})

describe('forbiddenMarksIn — the two-sided half of a named exemption', () => {
  test("'both' rejects either mark on its own", () => {
    expect(forbiddenMarksIn(`MIT License\n`, 'both')).toEqual([])
    expect(forbiddenMarksIn(`// ${COPY}\nMIT License\n`, 'both')).toEqual([
      COPY,
    ])
    expect(forbiddenMarksIn(`// ${SPDX}\nMIT License\n`, 'both')).toEqual([
      SPDX,
    ])
  })

  test("'spdx' tolerates the copyright line — NOTICE's own line 2", () => {
    expect(forbiddenMarksIn(`阡陌 AgentNest\n${COPY}\n`, 'spdx')).toEqual([])
    expect(forbiddenMarksIn(`${COPY}\n${SPDX}\n`, 'spdx')).toEqual([SPDX])
  })

  test('only the first 5 lines count — NOTICE quotes the id in its body', () => {
    expect(forbiddenMarksIn(`1\n2\n3\n4\n5\n${SPDX}\n`, 'both')).toEqual([])
  })
})

describe('exemption predicates', () => {
  test('the exempt extensions are matched case-insensitively', () => {
    expect(isExemptByExtension('a/b.json')).toBe(true)
    expect(isExemptByExtension('docs/assets/charts/x.JPG')).toBe(true)
    expect(isExemptByExtension('a/b.png')).toBe(true)
    expect(isExemptByExtension('a/b.pdf')).toBe(true)
    expect(isExemptByExtension('a/b.docx')).toBe(true)
  })

  test('extensions that carry headers today are NOT exempt', () => {
    // The deny-list posture: these five are exactly what the old allow-list
    // shape in sbom.ts dropped.
    for (const path of ['a.rs', 'a.in', 'a.toml', 'a.yml', 'a.service']) {
      expect(isExemptByExtension(path)).toBe(false)
    }
  })

  test('the five named paths are exempt and nothing near them is', () => {
    expect(isExemptByPath('BASE.md')).toBe(true)
    expect(isExemptByPath('LICENSE.base')).toBe(true)
    expect(isExemptByPath('NOTICE')).toBe(true)
    expect(
      isExemptByPath('packages/audio-capture-napi/native/Cargo.lock'),
    ).toBe(true)
    expect(
      isExemptByPath('packages/audio-capture-napi/native/.gitignore'),
    ).toBe(true)

    expect(isExemptByPath('docs/BASE.md')).toBe(false)
    expect(isExemptByPath('LICENSE')).toBe(false)
    expect(isExemptByPath('.gitignore')).toBe(false)
  })
})

describe('analyzeLicenseHeaders — forward direction (missing header)', () => {
  test('flags a Qianmo-owned source file that has no header', () => {
    const result: LicenseHeaderResult = analyzeLicenseHeaders(
      inputs(
        {
          'src/tools.ts': '// upstream file\n',
          'packages/protocol/src/limits.ts': 'export const LIMITS = {}\n',
        },
        ['src/tools.ts'],
      ),
    )

    expect(result.missingHeader).toEqual(['packages/protocol/src/limits.ts'])
    expect(result.misappliedHeader).toEqual([])
    expect(result.ownedCount).toBe(1)
  })

  test('a new extension outside the exempt list goes red, not silent', () => {
    // The failure mode of the allow-list shape: `.rs` was not in
    // `.ts|.tsx|.md|.sh|Makefile`, so an unheadered one would be skipped.
    const result = analyzeLicenseHeaders(
      inputs({
        'packages/audio-capture-napi/native/src/lib.rs': 'fn main() {}\n',
        'demo/env/beta/ops/qianmo-console.service.in': '[Unit]\n',
        'ci.yml': 'name: CI\n',
      }),
    )

    expect(result.missingHeader).toEqual([
      'packages/audio-capture-napi/native/src/lib.rs',
      'demo/env/beta/ops/qianmo-console.service.in',
      'ci.yml',
    ])
    expect(result.exemptByExtension).toEqual([])
  })

  test('the same files pass once they carry the header', () => {
    const result = analyzeLicenseHeaders(
      inputs({
        'packages/audio-capture-napi/native/src/lib.rs': SLASH_HEAD,
        'demo/env/beta/ops/qianmo-console.service.in': HASH_HEAD,
        'docs/dev/charter.md': HTML_HEAD,
        'scripts/build.sh': SHEBANG_HEAD,
      }),
    )

    expect(result.missingHeader).toEqual([])
    expect(result.headeredCount).toBe(4)
  })
})

describe('analyzeLicenseHeaders — reverse direction (misapplied)', () => {
  test('flags an AGPL header stamped onto a base-snapshot file', () => {
    // NOTICE 一、许可 says "carries the header ⇒ Qianmo-owned"; this is the
    // only machine check that the converse claim stays true.
    const result = analyzeLicenseHeaders(
      inputs(
        {
          'src/tools.ts': SLASH_HEAD,
          'src/query.ts': '// upstream, untouched\n',
        },
        ['src/tools.ts', 'src/query.ts'],
      ),
    )

    expect(result.misappliedHeader).toEqual(['src/tools.ts'])
    expect(result.missingHeader).toEqual([])
    expect(result.ownedCount).toBe(0)
  })

  test('an SPDX line below the window is not a misapplied header', () => {
    const body = `1\n2\n3\n4\n5\n// ${SPDX}\n`
    const result = analyzeLicenseHeaders(
      inputs({ 'src/tools.ts': body }, ['src/tools.ts']),
    )

    expect(result.misappliedHeader).toEqual([])
  })
})

describe('analyzeLicenseHeaders — third direction (stamped exemption)', () => {
  test('LICENSE.base with an AGPL header is a red, not a pass', () => {
    // The blind spot this closes: outside the snapshot tree (so the reverse
    // direction skips it) AND on the exempt list (so the forward direction
    // skips it). The only symptom used to be the exempt count quietly
    // dropping by one.
    const result = analyzeLicenseHeaders(
      inputs({ 'LICENSE.base': `// ${COPY}\n// ${SPDX}\nMIT License\n` }),
    )

    expect(result.stampedExemptions).toEqual([
      { path: 'LICENSE.base', marks: [COPY, SPDX] },
    ])
    expect(result.missingHeader).toEqual([])
    expect(result.misappliedHeader).toEqual([])
  })

  test('the copyright line alone is enough on a "both" path', () => {
    const result = analyzeLicenseHeaders(
      inputs({ 'BASE.md': `<!-- ${COPY} -->\n# BASE\n` }),
    )

    expect(result.stampedExemptions).toEqual([
      { path: 'BASE.md', marks: [COPY] },
    ])
  })

  test('NOTICE keeps its own copyright line and only the SPDX id is banned', () => {
    // NOTICE line 2 IS `Copyright 2026 Qianmo AgentNest Team` — that is the
    // document's own notice, not a header someone forgot to remove.
    const clean = analyzeLicenseHeaders(
      inputs({
        NOTICE: `阡陌 AgentNest (Qianmo AgentNest)\n${COPY}\n\n本文件…\n`,
      }),
    )
    expect(clean.stampedExemptions).toEqual([])

    const stamped = analyzeLicenseHeaders(
      inputs({ NOTICE: `阡陌 AgentNest\n${COPY}\n${SPDX}\n` }),
    )
    expect(stamped.stampedExemptions).toEqual([
      { path: 'NOTICE', marks: [SPDX] },
    ])
  })

  test('exempt EXTENSIONS are not covered — "cannot carry" is not "must not"', () => {
    // A `.json` containing those bytes is a syntax error, not a licence
    // misstatement; that is not this gate's business.
    const result = analyzeLicenseHeaders(
      inputs({ 'tsconfig.json': `// ${COPY}\n// ${SPDX}\n{}\n` }),
    )

    expect(result.stampedExemptions).toEqual([])
    expect(result.missingHeader).toEqual([])
  })
})

describe('analyzeLicenseHeaders — exemptions and bookkeeping', () => {
  test('exempt files pass and are bucketed by the reason that applied', () => {
    const result = analyzeLicenseHeaders(
      inputs({
        'package.json': '{}\n',
        'tsconfig.json': '{}\n',
        'docs/assets/charts/x.jpg': 'ÿØÿ',
        'docs/阡陌项目计划书.pdf': '%PDF-1.7\n',
        'BASE.md': '# BASE\n',
        'LICENSE.base': 'MIT License\n',
        NOTICE: 'NOTICE\n',
        'packages/audio-capture-napi/native/Cargo.lock': '# auto-generated\n',
        'packages/audio-capture-napi/native/.gitignore': 'target\n',
      }),
    )

    expect(result.missingHeader).toEqual([])
    expect(result.stampedExemptions).toEqual([])
    expect(result.exemptByExtension).toEqual([
      'package.json',
      'tsconfig.json',
      'docs/assets/charts/x.jpg',
      'docs/阡陌项目计划书.pdf',
    ])
    expect(result.exemptByPath).toEqual([
      'BASE.md',
      'LICENSE.base',
      'NOTICE',
      'packages/audio-capture-napi/native/Cargo.lock',
      'packages/audio-capture-napi/native/.gitignore',
    ])
    expect(result.ownedWithoutHeader).toHaveLength(9)
  })

  test('a file gone from the working tree is reported, not judged', () => {
    // `rm` without `git rm`, a half-finished refactor, a branch switch caught
    // mid-flight: precheck runs in exactly those moments, and a file that
    // does not exist cannot be missing a header.
    const result = analyzeLicenseHeaders(
      inputs({ 'packages/protocol/src/gone.ts': null }),
    )

    expect(result.missingFromWorktree).toEqual([
      'packages/protocol/src/gone.ts',
    ])
    expect(result.missingHeader).toEqual([])
    expect(result.ownedCount).toBe(1)
  })

  test('a file the caller could not read is NOT also called missing', () => {
    // EACCES is already a red on the caller's side; saying "the file is gone"
    // on top of it sends whoever reads the output looking for a file that is
    // sitting right where it always was.
    const result = analyzeLicenseHeaders(
      inputs({ 'src/locked.ts': null }, [], ['src/locked.ts']),
    )

    expect(result.missingFromWorktree).toEqual([])
    expect(result.missingHeader).toEqual([])
  })

  test('the counters describe the whole sweep', () => {
    const result = analyzeLicenseHeaders(
      inputs(
        {
          'src/tools.ts': '// upstream\n',
          'src/query.ts': SLASH_HEAD,
          'packages/protocol/src/limits.ts': SLASH_HEAD,
          'package.json': '{}\n',
        },
        ['src/tools.ts', 'src/query.ts'],
      ),
    )

    expect(result.trackedCount).toBe(4)
    expect(result.snapshotCount).toBe(2)
    expect(result.ownedCount).toBe(2)
    // headeredCount is an observation over the whole tree, misapplied ones
    // included — that is what NOTICE quotes as "带头文件数".
    expect(result.headeredCount).toBe(2)
    expect(result.misappliedHeader).toEqual(['src/query.ts'])
  })
})

describe('checkEnumerationSanity — refusing to scan nothing', () => {
  test('an empty enumeration is a failure, not zero violations', () => {
    // Same guard as surface-invariant.test.ts's "the scan has files to scan".
    const reasons = checkEnumerationSanity(0, 0)

    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toContain('git ls-files')
    expect(reasons[1]).toContain('快照树')
  })

  test('either side collapsing on its own is still a failure', () => {
    expect(checkEnumerationSanity(4770, 0)).toHaveLength(1)
    expect(checkEnumerationSanity(0, 4171)).toHaveLength(1)
  })

  test("today's real counts pass", () => {
    expect(checkEnumerationSanity(4770, 4171)).toEqual([])
  })
})

describe('git seams — the failure paths the pure functions cannot see', () => {
  test('a directory that is not a git checkout yields null, not []', () => {
    // null and [] are very different answers: [] would sail past as "zero
    // files, zero violations" if the sanity floor were ever removed.
    const dir = scratchDir()

    expect(resolveSnapshotTree(dir)).toBeNull()
    expect(resolveTrackedFiles(dir)).toBeNull()
  })

  test('a git repo without the pinned tag yields null for the snapshot', () => {
    const dir = scratchDir()
    Bun.spawnSync(['git', 'init', '-q', dir], { stderr: 'ignore' })

    // The tag is pinned, so "shallow / --no-tags clone" and "someone renamed
    // the snapshot" land on the same branch — a red, never a degrade.
    expect(resolveSnapshotTree(dir)).toBeNull()
    // ls-files itself works here; it is the tag that is missing.
    expect(resolveTrackedFiles(dir)).toEqual([])
  })

  test('this checkout resolves both, and the snapshot is the larger half', () => {
    const snapshot = resolveSnapshotTree()
    const tracked = resolveTrackedFiles()

    expect(snapshot).not.toBeNull()
    expect(tracked).not.toBeNull()
    expect(
      checkEnumerationSanity(tracked?.length ?? 0, snapshot?.length ?? 0),
    ).toEqual([])
  })
})

describe('the CLI itself — exit codes, not just pure functions', () => {
  test('an unrecognised flag exits non-zero instead of reporting nothing', () => {
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--repot'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(proc.exitCode).toBe(1)
    expect(proc.stderr.toString()).toContain('不认识的参数')
  })

  test('a clean tree exits 0 and says so', () => {
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(proc.stdout.toString()).toContain('[license-headers] OK')
    expect(proc.exitCode).toBe(0)
  })
})
