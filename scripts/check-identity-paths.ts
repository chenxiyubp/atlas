// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Identity-path bypass ratchet (M1 P10.1).
 *
 * The whole three-way isolation story (official Claude Code `.claude` / occ
 * `.occ` / Qianmo node `.qianmo`) rests on one invariant from CLAUDE.md §1.1②:
 * every identity-bearing path is derived in `src/config/paths.ts` (plus the
 * identity/brand constants it builds on). A single hard-coded literal anywhere
 * else silently ignores `OCC_IDENTITY` / `OCC_CONFIG_DIR` and is therefore the
 * ONLY way the isolation can fail. Twelve such call sites existed before the
 * derivation module; two of them caused real incidents.
 *
 * This script is the machine check for "zero bypasses": it scans production
 * sources (src/ plus every package's src/) for the forbidden literals below,
 * with comments stripped so documentation may keep mentioning them. Test files are
 * out of scope on purpose — tests assert against the literals deliberately
 * (identityIsolation.test.ts pins `.occ`/`.qianmo`/`.claude` by design).
 *
 * Forbidden in production code outside the allowlist:
 *   - '.claude' / '.occ' / '.qianmo' (and their '.json' global-file forms)
 *   - the exact string literal 'claude-cli' (the pre-isolation env-paths
 *     cache namespace)
 *   - join(homedir(), '.claude' | '.occ' | '.qianmo')
 *
 * Deliberately OUT of scope (verified legitimate on first sweep):
 *   - third-party dot-directories (`.bun`, `.codex`, `.config`, `.ccr`, …) —
 *     they belong to other tools, not to the three-identity namespace;
 *   - `claude-cli/<version>` inside the User-Agent template and the
 *     `claude-cli-internal` repo name — protocol-bearing strings on the
 *     CLAUDE.md §1.1③ "明确不改" list, plus the `claude-cli-native-` legacy
 *     artifact prefix that old-install cleanup must keep recognising.
 *
 * Allowlist (the derivation modules themselves):
 *   - src/config/paths.ts
 *   - src/constants/identity.ts
 *   - src/constants/brand.ts
 *
 * Zero tolerance in both directions; there is no budget file because the
 * correct number is exactly zero.
 */

import { Glob } from 'bun'

const ALLOWLIST = new Set([
  'src/config/paths.ts',
  'src/constants/identity.ts',
  'src/constants/brand.ts',
  // 这一条不是「派生模块」，是**故意的反向例外**。
  //
  // `guard.ts` 里那张 `IDENTITY_DIRS` 必须是字面量表，且必须同时列出全部三个
  // 身份目录（`.occ` / `.qianmo` / `.claude`）—— 它是准入判定的安全硬线：
  // 从 `paths.ts` 派生就会变成「只保护当前身份」，因为那边要读 `OCC_IDENTITY`
  // / `OCC_CONFIG_DIR`。守卫只挡住自己这一个身份，恰好废掉它自己。
  // 文件头注把这条讲得更细（"A hardline list that a session could edit would be
  // protecting the file that edits it"）。
  //
  // 换句话说：这三行**正确**，改成派生才是缺陷。
  'packages/resident/src/guard.ts',
])

const FORBIDDEN: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /['"]\.(?:claude|occ|qianmo)(?:\.json)?['"]/,
    label: 'identity dir/global-file literal',
  },
  { pattern: /['"]claude-cli['"]/, label: 'pre-isolation cache namespace' },
  {
    pattern: /join\(\s*homedir\(\)\s*,\s*['"]\.(?:claude|occ|qianmo)['"]/,
    label: 'homedir()-joined identity path',
  },
]

/**
 * Strip comments so prose may mention the literals. Line comments are only
 * recognised when `//` is not preceded by `:` (keeps `https://…` intact);
 * block comments are tracked across lines.
 */
function stripComments(lines: string[]): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of lines) {
    let line = raw
    let result = ''
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end === -1) {
          line = ''
        } else {
          line = line.slice(end + 2)
          inBlock = false
        }
        continue
      }
      const block = line.indexOf('/*')
      const lineComment = line.search(/(?<!:)\/\//)
      if (block !== -1 && (lineComment === -1 || block < lineComment)) {
        result += line.slice(0, block)
        line = line.slice(block + 2)
        inBlock = true
      } else if (lineComment !== -1) {
        result += line.slice(0, lineComment)
        line = ''
      } else {
        result += line
        line = ''
      }
    }
    out.push(result)
  }
  return out
}

const GLOBS = ['src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}']
const files: string[] = []
for (const g of GLOBS) {
  for await (const file of new Glob(g).scan({ cwd: process.cwd() })) {
    files.push(file)
  }
}

const violations: string[] = []
let scanned = 0

for (const file of files.sort()) {
  if (ALLOWLIST.has(file)) continue
  if (
    file.includes('__tests__/') ||
    file.includes('.test.') ||
    file.endsWith('.d.ts')
  ) {
    continue
  }
  scanned++
  const text = await Bun.file(file).text()
  const stripped = stripComments(text.split('\n'))
  stripped.forEach((line, i) => {
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(line)) {
        violations.push(`${file}:${i + 1} [${label}] ${line.trim()}`)
      }
    }
  })
}

if (violations.length > 0) {
  console.error(
    `identity-path bypasses found (${violations.length}) — derive these from src/config/paths.ts instead:`,
  )
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log(
  `check:identity-paths OK — ${scanned} production files scanned, 0 bypasses`,
)
