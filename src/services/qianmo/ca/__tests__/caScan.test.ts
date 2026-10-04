// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The scan assertion §10.3 asks for, in the shape of `check:identity-paths`.
 *
 * Three separate claims, because they fail in three different ways:
 *
 * 1. **No node-side module knows where the CA lives.** §3.3 lists the places
 *    the CA private key must never appear — any node's config root, the demo
 *    root, the repository, CI, anything the console process can reach. A path
 *    literal is the only mechanism by which that could quietly stop being
 *    true, so exactly one file is allowed to spell one.
 * 2. **No `@qianmo/*` package can reach openssl or the CA.** §6.1's first hard
 *    constraint, restated as a DoD line: the signing tool is host-side, and
 *    node-side verification needs nothing but `node:crypto` (F-2).
 * 3. **The CA tool added no dependency.** §6.4 picked a signed JSON list over
 *    an X.509 CRL precisely to avoid pulling a certificate library into the
 *    runtime; an `import` of anything third-party here would undo that.
 *
 * ## Scope and exemptions, stated rather than implied
 *
 * Scanned: every `.ts` / `.tsx` under `src/` and `packages/`.
 *
 * Not scanned, on purpose:
 *   - `node_modules` and `packages/@ant/` — vendored and decompiled trees that
 *     are not ours to police (same exclusion as the session-key scan);
 *   - test files (`__tests__/`, `test/`, `*.test.ts`) — they assert against
 *     literals deliberately, exactly as `check-identity-paths.ts` reasons
 *     about `identityIsolation.test.ts`;
 *   - comments, which are stripped before matching, so prose may keep
 *     explaining the layout.
 *
 * Allowlisted (this IS the CA tool, not node-side code):
 *   - `src/services/qianmo/ca/**`
 *   - `src/cli/handlers/ca.ts`
 *
 * The reach rule below is narrower than the allowlist on purpose — see
 * {@link CA_REACH_PATTERN} for which two modules P12.2 may import, and why.
 */

import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..')

const ALLOWLIST: readonly string[] = [
  'src/services/qianmo/ca/',
  'src/cli/handlers/ca.ts',
]

/**
 * Literals that name something inside the CA directory.
 *
 * Written against the file and directory names rather than a single regex, so
 * a failure says which one leaked. `QIANMO_CA_DIR` is here too: an env var
 * that redirects the CA is as much a way to reach it as a path is.
 */
const CA_LITERALS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /['"`][^'"`]*\.qianmo-ca[^'"`]*['"`]/,
    label: 'CA directory name',
  },
  { pattern: /['"`]ca\.(?:key|crt|srl)['"`]/, label: 'CA file name' },
  {
    pattern: /['"`]revo(?:ked|cation-list)\.json['"`]/,
    label: 'revocation file name',
  },
  {
    pattern: /['"`][^'"`]*issued-ledger\.jsonl[^'"`]*['"`]/,
    label: 'issuance ledger file name',
  },
  { pattern: /QIANMO_CA_DIR/, label: 'CA directory env var' },
]

/**
 * Ways a node-side module could reach the CA *directory* without naming a path.
 *
 * Deliberately three named modules rather than the whole `ca/` folder. Two of
 * the files in there — `pop.ts` and `revocationList.ts` — are pure format and
 * signature code with no openssl call and no path in them, and the node side
 * is *supposed* to reach them: P12.2's `qm cert request` builds its proof of
 * possession with `popMessage`, and every node checks a published RL with
 * `verifyRevocationList`. Forbidding the folder wholesale would make the next
 * package's correct move look like a violation, which is how a scan teaches
 * people to delete it.
 */
const CA_REACH_PATTERN =
  /from\s+['"][^'"]*qianmo\/ca\/(?:paths|openssl|operations)\.js['"]/

/** Anything at all under `ca/`. Used only for `packages/`, which is a leaf. */
const ANY_CA_IMPORT_PATTERN = /from\s+['"][^'"]*qianmo\/ca\/[^'"]*['"]/

/**
 * The openssl shell-out, which §6.1 keeps out of every runtime package.
 *
 * Matched as a *call*, not as the word: `packages/console` legitimately tells
 * an operator to run `openssl rand -hex 16` when their token is too short, and
 * a scan that cannot tell advice from execution is a scan somebody will
 * eventually silence.
 */
const OPENSSL_CALL_PATTERNS: readonly RegExp[] = [
  /\brunOpenssl\b/,
  /(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*[^)]*openssl/i,
]

function callsOpenssl(source: string): boolean {
  return OPENSSL_CALL_PATTERNS.some(pattern => pattern.test(source))
}

/**
 * Strip comments so prose may mention any of the above.
 *
 * Line comments only when `//` is not preceded by `:`, so `https://…` survives
 * — lifted from `scripts/check-identity-paths.ts` rather than reinvented.
 */
function stripComments(source: string): string {
  const out: string[] = []
  let inBlock = false
  for (const raw of source.split('\n')) {
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
        continue
      }
      if (lineComment !== -1) {
        result += line.slice(0, lineComment)
        line = ''
        continue
      }
      result += line
      line = ''
    }
    out.push(result)
  }
  return out.join('\n')
}

function isTestFile(relative: string): boolean {
  return (
    relative.includes('/__tests__/') ||
    relative.includes('/test/') ||
    relative.endsWith('.test.ts') ||
    relative.endsWith('.test.tsx')
  )
}

interface ScannedFile {
  readonly relative: string
  readonly source: string
}

async function scan(): Promise<readonly ScannedFile[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const files: ScannedFile[] = []
  for (const root of ['src', 'packages']) {
    for await (const file of glob.scan({
      cwd: join(REPO_ROOT, root),
      absolute: true,
    })) {
      if (file.includes('/node_modules/')) continue
      if (file.includes('/packages/@ant/')) continue
      const relative = file.slice(REPO_ROOT.length + 1)
      if (isTestFile(relative)) continue
      files.push({
        relative,
        source: stripComments(await Bun.file(file).text()),
      })
    }
  }
  return files
}

describe('CA isolation scan (§10.3)', () => {
  test('the scan can see what it is looking for', () => {
    // Positive control first: a scan blind to its own patterns would pass
    // forever and prove nothing (the same discipline the session-key scan
    // uses in `packages/resident/test/session-key.test.ts`).
    const bait = [
      "const dir = join(homedir(), '.qianmo-ca')",
      "readFileSync(join(dir, 'ca.key'))",
      "writeFileSync('revocation-list.json', body)",
      "readFileSync(join(dir, 'issued-ledger.jsonl'))",
      'process.env.QIANMO_CA_DIR',
    ]
    for (const [index, sample] of bait.entries()) {
      expect(CA_LITERALS[index]?.pattern.test(sample)).toBe(true)
    }
    expect(
      CA_REACH_PATTERN.test(
        "import { caDirectory } from '../qianmo/ca/paths.js'",
      ),
    ).toBe(true)
    // …and the two modules P12.2 is meant to import must NOT trip it.
    expect(
      CA_REACH_PATTERN.test("import { popMessage } from '../qianmo/ca/pop.js'"),
    ).toBe(false)
    expect(
      ANY_CA_IMPORT_PATTERN.test(
        "import { popMessage } from '../qianmo/ca/pop.js'",
      ),
    ).toBe(true)
    expect(callsOpenssl("runOpenssl(['x509'])")).toBe(true)
    expect(callsOpenssl("spawnSync('openssl', ['x509'])")).toBe(true)
    // Advice is not execution: this must NOT trip the scan.
    expect(callsOpenssl('例如 `openssl rand -hex 16`')).toBe(false)
    expect(stripComments('const a = 1 // ca.key\n')).not.toMatch(/ca\.key/)
    expect(stripComments("const u = 'https://x' // c\n")).toContain('https://x')
  })

  test('no CA directory literal outside the CA tool', async () => {
    const files = await scan()
    expect(files.length).toBeGreaterThan(1_000)

    const offenders: string[] = []
    for (const file of files) {
      if (ALLOWLIST.some(allowed => file.relative.startsWith(allowed))) continue
      for (const { pattern, label } of CA_LITERALS) {
        if (pattern.test(file.source))
          offenders.push(`${file.relative}: ${label}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('no node-side module reaches the CA directory or openssl', async () => {
    // The literals could be avoided while still reaching the CA through its
    // own helpers, which would be the same failure with better manners.
    const files = await scan()
    const offenders = files
      .filter(file => !ALLOWLIST.some(a => file.relative.startsWith(a)))
      .filter(file => CA_REACH_PATTERN.test(file.source))
      .map(file => file.relative)
    expect(offenders).toEqual([])
  })

  test('no @qianmo package mentions openssl or the CA (§6.1)', async () => {
    const files = await scan()
    const offenders = files
      .filter(file => file.relative.startsWith('packages/'))
      .filter(
        file =>
          callsOpenssl(file.source) ||
          // Whole folder here: a `packages/` leaf importing host `src/` at all
          // is already wrong, whichever CA module it picked.
          ANY_CA_IMPORT_PATTERN.test(file.source) ||
          CA_LITERALS.some(({ pattern }) => pattern.test(file.source)),
      )
      .map(file => file.relative)
    expect(offenders).toEqual([])
  })

  test('the CA tool added no third-party dependency', async () => {
    // §6.4 rejected an X.509 CRL to avoid exactly this. Every import must be a
    // node builtin, a workspace package, or a relative file.
    const files = await scan()
    const offenders: string[] = []
    for (const file of files) {
      if (!file.relative.startsWith('src/services/qianmo/ca/')) continue
      for (const match of file.source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? ''
        const allowed =
          specifier.startsWith('node:') ||
          specifier.startsWith('@qianmo/') ||
          specifier.startsWith('.')
        if (!allowed) offenders.push(`${file.relative}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the CA path helpers are defined exactly once', async () => {
    const files = await scan()
    const definitions = files.filter(file =>
      /export function caDirectory\b/.test(file.source),
    )
    expect(definitions.map(file => file.relative)).toEqual([
      'src/services/qianmo/ca/paths.ts',
    ])
  })
})
