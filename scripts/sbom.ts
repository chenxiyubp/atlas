#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Third-party SBOM and license inventory for the WHOLE repository.
 *
 * Scope is deliberately the entire dependency tree — the base's dependencies
 * included, not just `@qianmo/*`. Roadmap P8.4 says so in as many words, and
 * the reason is that the fork ships the base: `vite.config.ts` sets
 * `ssr.noExternal: true`, so every library the CLI touches is bundled into
 * `dist/` regardless of which package.json field declared it.
 *
 * ── Sources of truth ──────────────────────────────────────────────────────
 *
 *   bun.lock       the component set and the dependency graph. It is JSONC
 *                  (trailing commas), so `JSON.parse` cannot read it; we use
 *                  jsonc-parser, already a repository dependency — no new
 *                  third-party code enters the tree for this script.
 *   node_modules   the `license` field only. Bun's isolated linker puts the
 *                  real directories under `node_modules/.bun/<key>/node_modules/`
 *                  and leaves symlinks at the top level, so the scan walks
 *                  both layouts and indexes by `name@version`.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 *
 * The outputs carry NO timestamp. `bun run sbom` on an unchanged tree must
 * rewrite the same bytes, otherwise the "regenerate and diff" review workflow
 * is useless. The lockfile's SHA-256 is recorded instead, which pins the input
 * without dating the output.
 *
 * ── Outputs ───────────────────────────────────────────────────────────────
 *
 *   docs/dev/sbom-m0.json   CycloneDX 1.5-shaped minimal BOM (hand-built; a
 *                           CycloneDX library would be a new dependency for a
 *                           document we emit once)
 *   docs/dev/sbom-m0.md     human-readable audit: license distribution, the
 *                           copyleft scan that P8.4's DoD turns on, the
 *                           missing/non-SPDX backlog, prebuilt-binary
 *                           provenance, and the workspace package roster
 *
 * Usage:
 *   bun run sbom            regenerate both files
 *   bun run sbom --check    regenerate, then exit 1 if any strong/network
 *                           copyleft or field-of-use-restricted component is
 *                           present (the machine-judgeable half of the DoD)
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js'

const REPO_ROOT = resolve(import.meta.dir, '..')
const LOCKFILE = join(REPO_ROOT, 'bun.lock')
const NODE_MODULES = join(REPO_ROOT, 'node_modules')
const JSON_OUT = join(REPO_ROOT, 'docs', 'dev', 'sbom-m0.json')
const MD_OUT = join(REPO_ROOT, 'docs', 'dev', 'sbom-m0.md')

/** Base pin, restated from BASE.md for the BOM metadata. Do not edit BASE.md. */
const BASE_PIN = '848ad8c2c8daca9f5aa2410da555553e07700f5d'
const BASE_TAG = 'v2.38.3'

// ───────────────────────────── license classification ─────────────────────

export type LicenseTier =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'network-copyleft'
  | 'restricted'
  | 'unknown'

/**
 * Severity order. `OR` picks the minimum (we may choose the friendliest
 * branch), `AND` takes the maximum (every obligation applies at once).
 * `unknown` sits above `restricted` on purpose: an unreadable field must never
 * be allowed to look safer than a field that plainly says "no".
 */
const TIER_RANK: Record<LicenseTier, number> = {
  permissive: 0,
  'weak-copyleft': 1,
  'strong-copyleft': 2,
  'network-copyleft': 3,
  restricted: 4,
  unknown: 5,
}

const TIER_BY_RANK: LicenseTier[] = [
  'permissive',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'restricted',
  'unknown',
]

export const CONTAGIOUS_TIERS: ReadonlySet<LicenseTier> = new Set<LicenseTier>([
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
])

type FamilyRule = { match: RegExp; tier: LicenseTier; note?: string }

/**
 * Order matters — the first match wins. Narrow ids come before the family
 * prefixes they would otherwise be swallowed by (CC-BY-SA before CC-BY,
 * LGPL before GPL, CECILL-C before CECILL).
 */
const LICENSE_FAMILIES: FamilyRule[] = [
  // Network copyleft: obligations trigger on network use, not just on
  // shipping bytes. A resident agent network is exactly the deployment shape
  // these were written for, so they are the ones that matter most here.
  { match: /^AGPL(-|$)/i, tier: 'network-copyleft' },
  { match: /^SSPL(-|$)/i, tier: 'network-copyleft' },
  {
    match: /^OSL(-|$)/i,
    tier: 'network-copyleft',
    note: 'OSL 把「对外提供服务」视同分发',
  },
  {
    match: /^EUPL(-|$)/i,
    tier: 'network-copyleft',
    note: 'EUPL-1.2 含网络分发条款',
  },
  { match: /^RPL(-|$)/i, tier: 'network-copyleft' },

  // Strong copyleft.
  { match: /^LGPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^GFDL(-|$)/i, tier: 'strong-copyleft', note: '文档类 copyleft' },
  { match: /^GPL(-|$)/i, tier: 'strong-copyleft' },
  { match: /^CC-BY-SA(-|$)/i, tier: 'strong-copyleft', note: 'share-alike' },
  { match: /^CECILL-C$/i, tier: 'weak-copyleft' },
  { match: /^CECILL(-|$)/i, tier: 'strong-copyleft' },
  { match: /^Sleepycat$/i, tier: 'strong-copyleft' },
  { match: /^QPL(-|$)/i, tier: 'strong-copyleft' },
  { match: /^Parity(-|$)/i, tier: 'strong-copyleft' },

  // Weak / file-level copyleft: obligations stop at the modified file, so an
  // unmodified dependency is normally fine. Still listed — P8.4 asks for the
  // full CDDL/MPL/EPL sweep, not only the GPL family.
  { match: /^MPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^EPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^CPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^CDDL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^MS-RL$/i, tier: 'weak-copyleft' },
  { match: /^APSL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^IPL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^SISSL(-|$)/i, tier: 'weak-copyleft' },
  { match: /^Artistic-1/i, tier: 'weak-copyleft' },
  { match: /^Artistic-2\.0$/i, tier: 'weak-copyleft', note: 'GPL 兼容' },

  // Field-of-use restrictions — not copyleft, but not usable either.
  { match: /^CC-BY-NC/i, tier: 'restricted', note: '禁止商业使用' },
  { match: /^CC-BY-ND/i, tier: 'restricted', note: '禁止演绎' },
  { match: /^UNLICENSED$/i, tier: 'restricted', note: '专有/未授权' },
  { match: /^JSON$/i, tier: 'restricted', note: '含 "Good, not Evil" 条款' },
  { match: /^Commons-Clause$/i, tier: 'restricted' },

  // Permissive.
  { match: /^MIT(-0)?$/i, tier: 'permissive' },
  { match: /^ISC$/i, tier: 'permissive' },
  { match: /^0BSD$/i, tier: 'permissive' },
  { match: /^BSD-\d(-Clause)?/i, tier: 'permissive' },
  { match: /^Apache-\d/i, tier: 'permissive' },
  { match: /^Unlicense$/i, tier: 'permissive' },
  { match: /^CC0-1\.0$/i, tier: 'permissive' },
  { match: /^CC-BY-\d/i, tier: 'permissive', note: '仅署名要求' },
  { match: /^WTFPL$/i, tier: 'permissive' },
  { match: /^Zlib(-|$)/i, tier: 'permissive' },
  { match: /^libpng(-|$)/i, tier: 'permissive' },
  { match: /^X11$/i, tier: 'permissive' },
  { match: /^PostgreSQL$/i, tier: 'permissive' },
  { match: /^(Python-2\.0|PSF-2\.0)$/i, tier: 'permissive' },
  { match: /^BlueOak-/i, tier: 'permissive' },
  { match: /^UPL-/i, tier: 'permissive' },
  { match: /^NCSA$/i, tier: 'permissive' },
  { match: /^BSL-1\.0$/i, tier: 'permissive', note: 'Boost' },
  { match: /^AFL-/i, tier: 'permissive' },
  { match: /^(Ruby|OpenSSL|curl|TCL|Vim|W3C|bzip2-)/i, tier: 'permissive' },
]

/**
 * Non-SPDX strings that npm packages actually ship. Every hit is also flagged
 * as "not SPDX" so the backlog table stays honest about what needed guessing.
 */
const LICENSE_ALIASES: Record<string, string> = {
  BSD: 'BSD-3-Clause',
  'NEW BSD': 'BSD-3-Clause',
  'BSD LICENSE': 'BSD-3-Clause',
  'MIT/X11': 'MIT',
  'MIT LICENSE': 'MIT',
  'THE MIT LICENSE': 'MIT',
  APACHE: 'Apache-2.0',
  'APACHE 2.0': 'Apache-2.0',
  'APACHE-2': 'Apache-2.0',
  'APACHE LICENSE 2.0': 'Apache-2.0',
  'APACHE LICENSE, VERSION 2.0': 'Apache-2.0',
  'PUBLIC DOMAIN': 'Unlicense',
  UNLICENSE: 'Unlicense',
  CC0: 'CC0-1.0',
  ZLIB: 'Zlib',
  EPL: 'EPL-1.0',
  MPL: 'MPL-2.0',
  LGPL: 'LGPL-3.0-or-later',
  GPL: 'GPL-3.0-or-later',
  AGPL: 'AGPL-3.0-or-later',
}

/**
 * Exceptions that specifically defuse the linking obligation. `GPL-2.0 WITH
 * Classpath-exception-2.0` does not infect a linking consumer, and treating it
 * as though it did would put a false positive in front of the reviewers whose
 * time this report is meant to save.
 */
const LINKING_EXCEPTIONS =
  /^(Classpath-exception|GCC-exception|LLVM-exception|Autoconf-exception|Bison-exception|Font-exception|libtool-exception|Universal-FOSS-exception|Linux-syscall-note|WxWindows-exception|GPL-3\.0-linking-exception|GPL-CC-1\.0)/i

export type LicenseIssue =
  | 'missing'
  | 'see-license-in'
  | 'unlicensed'
  | 'non-spdx'
  | 'unrecognized'

export type LicenseVerdict = {
  /** Exactly what package.json said, or '' when the field was absent. */
  raw: string
  tier: LicenseTier
  /** Every licence id seen in the expression, in source order. */
  ids: string[]
  /** Ids no family rule matched — these need a human. */
  unrecognized: string[]
  /** tier is weak/strong/network copyleft after OR-choice resolution. */
  contagious: boolean
  issues: LicenseIssue[]
  notes: string[]
}

type Token = { kind: 'id' | 'lparen' | 'rparen' | 'op'; value: string }

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expression.length) {
    const ch = expression[i] ?? ''
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: '(' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ')' })
      i++
      continue
    }
    let j = i
    while (j < expression.length && !/[\s()]/.test(expression[j] ?? '')) j++
    const word = expression.slice(i, j)
    i = j
    const upper = word.toUpperCase()
    if (upper === 'AND' || upper === 'OR' || upper === 'WITH') {
      tokens.push({ kind: 'op', value: upper })
    } else {
      tokens.push({ kind: 'id', value: word })
    }
  }
  return tokens
}

type Accumulator = {
  ids: string[]
  unrecognized: string[]
  notes: string[]
  aliased: boolean
}

function classifyId(id: string, acc: Accumulator): LicenseTier {
  const aliased = LICENSE_ALIASES[id.toUpperCase()]
  const effective = aliased ?? id.replace(/\+$/, '').replace(/\*$/, '')
  if (aliased !== undefined) {
    acc.aliased = true
    acc.notes.push(`「${id}」按 ${aliased} 归类`)
  }
  acc.ids.push(id)
  for (const rule of LICENSE_FAMILIES) {
    if (!rule.match.test(effective)) continue
    if (rule.note !== undefined) acc.notes.push(`${effective}：${rule.note}`)
    return rule.tier
  }
  acc.unrecognized.push(id)
  return 'unknown'
}

function downgrade(tier: LicenseTier): LicenseTier {
  const rank = TIER_RANK[tier]
  if (rank === 0 || rank > TIER_RANK['network-copyleft']) return tier
  return TIER_BY_RANK[rank - 1] ?? tier
}

/** Recursive descent over `or := and ('OR' and)*` etc. Evaluates as it goes. */
function parseExpression(tokens: Token[], acc: Accumulator): LicenseTier {
  let pos = 0

  function parseAtom(): LicenseTier {
    const token = tokens[pos]
    if (token === undefined) return 'unknown'
    if (token.kind === 'lparen') {
      pos++
      const inner = parseOr()
      if (tokens[pos]?.kind === 'rparen') pos++
      return inner
    }
    if (token.kind === 'id') {
      pos++
      return classifyId(token.value, acc)
    }
    // A stray operator: consume it so the loop terminates.
    pos++
    return 'unknown'
  }

  function parseWith(): LicenseTier {
    let tier = parseAtom()
    while (tokens[pos]?.kind === 'op' && tokens[pos]?.value === 'WITH') {
      pos++
      const exception = tokens[pos]
      if (exception?.kind === 'id') {
        pos++
        if (LINKING_EXCEPTIONS.test(exception.value)) {
          acc.notes.push(`例外 ${exception.value} 解除链接传染，降一档`)
          tier = downgrade(tier)
        } else {
          acc.notes.push(`例外 ${exception.value} 未识别，按原档保留`)
        }
      }
    }
    return tier
  }

  function parseAnd(): LicenseTier {
    let tier = parseWith()
    while (tokens[pos]?.kind === 'op' && tokens[pos]?.value === 'AND') {
      pos++
      const right = parseWith()
      tier = TIER_RANK[right] > TIER_RANK[tier] ? right : tier
    }
    return tier
  }

  function parseOr(): LicenseTier {
    let tier = parseAnd()
    while (tokens[pos]?.kind === 'op' && tokens[pos]?.value === 'OR') {
      pos++
      const right = parseAnd()
      tier = TIER_RANK[right] < TIER_RANK[tier] ? right : tier
    }
    return tier
  }

  return parseOr()
}

/**
 * Classify a package.json `license` string.
 *
 * Handles SPDX expressions (`(MIT OR Apache-2.0)`, `GPL-2.0 WITH
 * Classpath-exception-2.0`), the legacy free-text strings npm is full of, and
 * the two special values that mean "there is no usable grant here":
 * `UNLICENSED` and `SEE LICENSE IN <file>`.
 *
 * The OR handling is the part that keeps the copyleft scan usable: a dual
 * `(MIT OR GPL-2.0)` grant is NOT a contagion finding, because we can take the
 * MIT branch. Reporting it as one would bury the real hits.
 */
export function classifyLicense(
  raw: string | null | undefined,
): LicenseVerdict {
  const text = (raw ?? '').trim()
  const acc: Accumulator = {
    ids: [],
    unrecognized: [],
    notes: [],
    aliased: false,
  }

  if (text === '') {
    return {
      raw: '',
      tier: 'unknown',
      ids: [],
      unrecognized: [],
      contagious: false,
      issues: ['missing'],
      notes: [],
    }
  }

  if (/^SEE LICENSE IN\b/i.test(text)) {
    return {
      raw: text,
      tier: 'unknown',
      ids: [],
      unrecognized: [],
      contagious: false,
      issues: ['see-license-in', 'non-spdx'],
      notes: ['授权正文在包内文件中，需人工阅读'],
    }
  }

  if (/^UNLICENSED$/i.test(text)) {
    return {
      raw: text,
      tier: 'restricted',
      ids: ['UNLICENSED'],
      unrecognized: [],
      contagious: false,
      issues: ['unlicensed'],
      notes: ['显式声明未授权'],
    }
  }

  const tier = parseExpression(tokenize(text), acc)
  const issues: LicenseIssue[] = []
  if (acc.unrecognized.length > 0) issues.push('unrecognized')
  if (acc.aliased || acc.unrecognized.length > 0) issues.push('non-spdx')

  return {
    raw: text,
    tier,
    ids: acc.ids,
    unrecognized: acc.unrecognized,
    contagious: CONTAGIOUS_TIERS.has(tier),
    issues,
    notes: acc.notes,
  }
}

/** package.json may carry the modern `license` or the legacy `licenses` array. */
export function readLicenseField(pkg: unknown): string {
  if (!isRecord(pkg)) return ''
  const license = pkg['license']
  if (typeof license === 'string') return license
  if (isRecord(license) && typeof license['type'] === 'string') {
    return license['type']
  }
  const legacy = pkg['licenses']
  if (Array.isArray(legacy)) {
    const types = legacy
      .map(entry =>
        isRecord(entry) && typeof entry['type'] === 'string'
          ? entry['type']
          : typeof entry === 'string'
            ? entry
            : '',
      )
      .filter(value => value !== '')
    if (types.length === 1) return types[0] ?? ''
    if (types.length > 1) return `(${types.join(' OR ')})`
  }
  return ''
}

// ───────────────────────────── lockfile model ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type LockMeta = {
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  os: string[]
  cpu: string[]
}

const EMPTY_META: LockMeta = {
  dependencies: {},
  optionalDependencies: {},
  peerDependencies: {},
  os: [],
  cpu: [],
}

type Origin =
  | 'registry'
  | 'workspace'
  | 'root'
  | 'git'
  | 'tarball'
  | 'link'
  | 'alias'
  | 'other'

type Component = {
  key: string
  name: string
  version: string
  spec: string
  origin: Origin
  meta: LockMeta
  workspacePath: string | null
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string')
  return []
}

function readMeta(tuple: unknown[]): LockMeta {
  const found = tuple.find(isRecord)
  if (found === undefined) return EMPTY_META
  return {
    dependencies: stringMap(found['dependencies']),
    optionalDependencies: stringMap(found['optionalDependencies']),
    peerDependencies: stringMap(found['peerDependencies']),
    os: stringList(found['os']),
    cpu: stringList(found['cpu']),
  }
}

/** `@scope/name@spec` and `name@spec` both split at the first `@` after 0. */
function splitId(id: string): { name: string; spec: string } {
  const at = id.indexOf('@', id.startsWith('@') ? 1 : 0)
  if (at === -1) return { name: id, spec: '' }
  return { name: id.slice(0, at), spec: id.slice(at + 1) }
}

function classifyOrigin(spec: string): Origin {
  if (spec.startsWith('workspace:')) return 'workspace'
  if (spec.startsWith('root:')) return 'root'
  if (spec.startsWith('npm:')) return 'alias'
  if (spec.startsWith('git+') || spec.startsWith('github:')) return 'git'
  if (spec.startsWith('link:') || spec.startsWith('file:')) return 'link'
  if (spec.startsWith('http://') || spec.startsWith('https://'))
    return 'tarball'
  if (/^\d/.test(spec)) return 'registry'
  return 'other'
}

function versionOf(spec: string, origin: Origin): string {
  if (origin === 'registry') return spec
  if (origin === 'alias') {
    const target = spec.slice('npm:'.length)
    return splitId(target).spec || spec
  }
  return spec
}

/**
 * Lockfile keys mirror the node_modules tree: `a/b/c` is `c` nested under
 * `a/b`. Scoped names occupy two path parts but one segment.
 */
function splitKeySegments(key: string): string[] {
  if (key === '') return []
  const parts = key.split('/')
  const segments: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (part.startsWith('@') && i + 1 < parts.length) {
      segments.push(`${part}/${parts[i + 1]}`)
      i++
    } else {
      segments.push(part)
    }
  }
  return segments
}

/** Node-style lookup: nearest enclosing scope first, then outward to root. */
function resolveDependency(
  fromKey: string,
  depName: string,
  packages: Map<string, Component>,
): string | null {
  const segments = splitKeySegments(fromKey)
  for (let depth = segments.length; depth >= 0; depth--) {
    const candidate = [...segments.slice(0, depth), depName].join('/')
    if (packages.has(candidate)) return candidate
  }
  return null
}

type Workspace = {
  path: string
  name: string
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

type Lockfile = {
  workspaces: Workspace[]
  packages: Map<string, Component>
  sha256: string
}

async function readLockfile(): Promise<Lockfile> {
  const text = await readFile(LOCKFILE, 'utf8')
  const sha256 = createHash('sha256').update(text).digest('hex')
  const parsed: unknown = parseJsonc(text)
  if (!isRecord(parsed)) throw new Error('bun.lock did not parse to an object')

  const rawWorkspaces = parsed['workspaces']
  const workspaces: Workspace[] = []
  if (isRecord(rawWorkspaces)) {
    for (const [path, entry] of Object.entries(rawWorkspaces)) {
      if (!isRecord(entry)) continue
      const name = entry['name']
      const version = entry['version']
      workspaces.push({
        path,
        name: typeof name === 'string' ? name : '(root)',
        version: typeof version === 'string' ? version : '0.0.0',
        dependencies: stringMap(entry['dependencies']),
        devDependencies: stringMap(entry['devDependencies']),
        optionalDependencies: stringMap(entry['optionalDependencies']),
      })
    }
  }

  const packages = new Map<string, Component>()
  const rawPackages = parsed['packages']
  if (isRecord(rawPackages)) {
    for (const [key, tuple] of Object.entries(rawPackages)) {
      if (!Array.isArray(tuple)) continue
      const id = tuple[0]
      if (typeof id !== 'string') continue
      const { name, spec } = splitId(id)
      const origin = classifyOrigin(spec)
      const workspacePath =
        origin === 'workspace' ? spec.slice('workspace:'.length) : null
      const workspaceVersion = workspaces.find(
        w => w.path === workspacePath,
      )?.version
      packages.set(key, {
        key,
        name,
        version: workspaceVersion ?? versionOf(spec, origin),
        spec,
        origin,
        meta: readMeta(tuple),
        workspacePath,
      })
    }
  }

  return { workspaces, packages, sha256 }
}

// ───────────────────────────── reachability ───────────────────────────────

type Reach = 'runtime' | 'dev' | 'unreached'

type Reachability = {
  reach: Map<string, Reach>
  /** Shortest seed→component path, for the "who pulled this in" column. */
  path: Map<string, string[]>
}

function walk(
  seeds: Array<{ from: string; name: string; label: string }>,
  packages: Map<string, Component>,
): { seen: Set<string>; path: Map<string, string[]> } {
  const seen = new Set<string>()
  const path = new Map<string, string[]>()
  const queue: string[] = []

  for (const seed of seeds) {
    const key = resolveDependency(seed.from, seed.name, packages)
    if (key === null || seen.has(key)) continue
    seen.add(key)
    path.set(key, [seed.label, key])
    queue.push(key)
  }

  while (queue.length > 0) {
    const key = queue.shift()
    if (key === undefined) continue
    const node = packages.get(key)
    if (node === undefined) continue
    const deps = {
      ...node.meta.dependencies,
      ...node.meta.optionalDependencies,
      ...node.meta.peerDependencies,
    }
    for (const depName of Object.keys(deps)) {
      const next = resolveDependency(key, depName, packages)
      if (next === null || seen.has(next)) continue
      seen.add(next)
      path.set(next, [...(path.get(key) ?? [key]), next])
      queue.push(next)
    }
  }

  return { seen, path }
}

/**
 * Two passes, runtime first.
 *
 * "runtime" = reachable from the root package's `dependencies` /
 * `optionalDependencies`, or from any workspace package's own
 * `dependencies` — workspace packages are first-party code that ships.
 *
 * The split is reported because P8.4 asks for it, but see the report's own
 * warning: this fork bundles with `ssr.noExternal`, so `dev` here does NOT
 * mean "not distributed".
 */
function computeReachability(lock: Lockfile): Reachability {
  const runtimeSeeds: Array<{ from: string; name: string; label: string }> = []
  const devSeeds: Array<{ from: string; name: string; label: string }> = []

  for (const ws of lock.workspaces) {
    const from = ws.path === '' ? '' : ws.name
    const label = ws.path === '' ? '(root)' : ws.name
    for (const name of Object.keys(ws.dependencies)) {
      runtimeSeeds.push({ from, name, label })
    }
    for (const name of Object.keys(ws.optionalDependencies)) {
      runtimeSeeds.push({ from, name, label })
    }
    for (const name of Object.keys(ws.devDependencies)) {
      devSeeds.push({ from, name, label })
    }
  }

  const runtime = walk(runtimeSeeds, lock.packages)
  const dev = walk(devSeeds, lock.packages)

  const reach = new Map<string, Reach>()
  const path = new Map<string, string[]>()
  for (const key of lock.packages.keys()) {
    if (runtime.seen.has(key)) {
      reach.set(key, 'runtime')
      path.set(key, runtime.path.get(key) ?? [key])
    } else if (dev.seen.has(key)) {
      reach.set(key, 'dev')
      path.set(key, dev.path.get(key) ?? [key])
    } else {
      reach.set(key, 'unreached')
      path.set(key, [key])
    }
  }
  return { reach, path }
}

// ───────────────────────────── node_modules scan ──────────────────────────

type Installed = { license: string; dir: string }

/**
 * Index every installed package by `name@version`.
 *
 * Bun's isolated linker means the top-level `node_modules/<pkg>` entries are
 * symlinks into `node_modules/.bun/<key>/node_modules/<pkg>`. Following those
 * symlinks would visit each package many times, so the store is walked
 * directly and realpaths are deduplicated. The hoisted layout still works —
 * both are just "a node_modules directory" to this walk.
 */
async function indexInstalled(): Promise<Map<string, Installed>> {
  const index = new Map<string, Installed>()
  const visited = new Set<string>()

  async function readPackageJson(dir: string): Promise<void> {
    let text: string
    try {
      text = await readFile(join(dir, 'package.json'), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    const name = parsed['name']
    const version = parsed['version']
    if (typeof name !== 'string' || typeof version !== 'string') return
    const key = `${name}@${version}`
    if (index.has(key)) return
    index.set(key, { license: readLicenseField(parsed), dir })
  }

  async function walkPackageDir(dir: string, depth: number): Promise<void> {
    await readPackageJson(dir)
    if (depth > 6) return
    const nested = join(dir, 'node_modules')
    if (await isDirectory(nested)) await walkNodeModules(nested, depth + 1)
  }

  async function walkNodeModules(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry)
      if (entry === '.bun') {
        // The isolated store: each child holds one more node_modules.
        let stores: string[]
        try {
          stores = await readdir(full)
        } catch {
          continue
        }
        for (const store of stores.sort()) {
          await walkNodeModules(join(full, store, 'node_modules'), depth + 1)
        }
        continue
      }
      if (entry.startsWith('.')) continue
      // Top-level entries are symlinks into .bun under the isolated linker;
      // dedupe on the real path so each package is read exactly once.
      let real: string
      try {
        real = await realpath(full)
      } catch {
        continue
      }
      if (visited.has(real)) continue
      visited.add(real)
      if (!(await isDirectory(full))) continue
      if (entry.startsWith('@')) {
        let scoped: string[]
        try {
          scoped = await readdir(full)
        } catch {
          continue
        }
        for (const child of scoped.sort()) {
          await walkPackageDir(join(full, child), depth)
        }
        continue
      }
      await walkPackageDir(full, depth)
    }
  }

  await walkNodeModules(NODE_MODULES, 0)
  return index
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

// ───────────────────────────── prebuilt binaries ──────────────────────────

type BinaryAudit = {
  location: string
  what: string
  tracked: string
  licenseFile: string
  provenance: string
}

async function auditPrebuiltBinaries(): Promise<BinaryAudit[]> {
  const rows: BinaryAudit[] = []

  const vendorRoot = join(REPO_ROOT, 'vendor', 'audio-capture')
  const triples = (await isDirectory(vendorRoot))
    ? (await readdir(vendorRoot)).sort()
    : []
  rows.push({
    location: 'vendor/audio-capture/',
    what: `${triples.length} 个平台三元组的 audio-capture.node 预编译 N-API 插件`,
    tracked: '入库（git 跟踪）',
    licenseFile: (await findLicenseFile(join(REPO_ROOT, 'vendor'))) ?? '无',
    provenance: await audioCaptureProvenance(),
  })

  const ripgrepRoot = join(REPO_ROOT, 'src', 'utils', 'vendor', 'ripgrep')
  rows.push({
    location: 'src/utils/vendor/ripgrep/',
    what: 'ripgrep 可执行文件（rg）',
    tracked: '不入库（.gitignore 第 12 行），由 postinstall 下载',
    licenseFile:
      (await findLicenseFile(join(REPO_ROOT, 'src', 'utils', 'vendor'))) ??
      '无',
    provenance: (await isDirectory(ripgrepRoot))
      ? 'scripts/postinstall.cjs：microsoft/ripgrep-prebuilt v15.0.1，逐档案 SHA-256 硬编码校验'
      : 'scripts/postinstall.cjs（本机尚未下载）',
  })

  for (const dir of (await readdir(join(REPO_ROOT, 'packages'))).sort()) {
    if (!dir.endsWith('-napi')) continue
    const pkgDir = join(REPO_ROOT, 'packages', dir)
    const pkg = await readJson(join(pkgDir, 'package.json'))
    const license = readLicenseField(pkg)
    const files = await listFiles(pkgDir)
    const natives = files.filter(
      f => f.endsWith('.node') || f.endsWith('.dylib'),
    )
    const crateLicense = await readCargoLicense(
      join(pkgDir, 'native', 'Cargo.toml'),
    )
    rows.push({
      location: `packages/${dir}/`,
      what:
        natives.length > 0
          ? `${natives.length} 个原生产物 + TS 装载层`
          : crateLicense !== ''
            ? 'TS 装载层 + 原生 Rust 源码 crate（native/），包内无预编译产物'
            : '纯 TypeScript 装载层，包内无原生产物',
      tracked: '入库',
      licenseFile: (await findLicenseFile(pkgDir)) ?? '无',
      provenance: await napiPackageProvenance(pkgDir, license, crateLicense),
    })
  }

  return rows
}

/**
 * 装载层归哪一边——**判据是基座快照比对，不是 SPDX 文件头**。
 *
 * `NOTICE` 一、许可的现行口径是：两层的权威判据是文件在不在基座快照里，不是文件头；
 * 「带头 ⇒ 属于 AGPL 层」成立，反向不成立。无头文件既可能是基座文件，也可能是不在
 * 基座快照里的阡陌文件；另有一批带着阡陌改动的基座文件有意不加头，这是独立限制、
 * 不是反例。具体个数与拆分现跑现算，命令与口径见 `NOTICE` 一、许可。
 * 第三类「形态上带得了却漏加的」当天由一批补头提交清零，其中就有
 * `src/constants/identity.ts`（CLAUDE.md §2.3 点名的身份 roster 唯一真源）
 * ——**并且从此有一道覆盖全仓的门禁盯着这件事**：
 * `scripts/check-license-headers.ts`（`bun run check:license-headers`，接在
 * precheck / verify / CI 三处），三向硬零：正向查阡陌自有文件漏加头，反向查
 * AGPL 头被误贴到基座快照树里的文件上，第三向查那几个「有意不加头」的具名豁免
 * 文件（`LICENSE.base` 等）有没有反过来被盖上章。章程 §5.5 原先那句「不为此新增 CI
 * 断言，漏加由 PR 评审兜」已由章程 v2.18 反转——那条决定作出时判据覆盖 15 个
 * 文件，反转时覆盖 647 个，而「PR 评审兜」这一道在 2026-08-30 一次漏了 66 个。
 *
 * 那道门禁与 `packages/activator/test/surface-invariant.test.ts` 的
 * `test('every source file carries the two-line copyright header', …)`
 * **分工不同、故意不统一**：后者是包内更强的不变式（恰好第 1–2 行、恰好 `//`
 * 形式、只扫 `packages/activator/src` 下非递归的 `.ts`，随建包提交 `6f30c45c`
 * 一起加入），前者是全仓地板（前 5 行、任意注释语法、路径判据 + 豁免表）。
 * **盘点门禁时别只数 `package.json` 的 `check:*`**，单测本身也是门禁的一部分。
 *
 * 需要核对个数与拆分时跑 `bun run check:license-headers --report`：它报出带头
 * 文件数、阡陌自有总数、无头数（按豁免扩展名与具名路径拆开）、快照树文件数与
 * 所用标签名。这里**不再复写**那条手写的 shell 管道——本仓库「指针不复制」，
 * 而且那条管道取的是「哪些扩展名必须带头」的**白名单**形态，漏掉了 `.rs` /
 * `.in` / `.toml` / `.yml` / `.service` 共 20 个；门禁取的是**豁免名单**形态，
 * 明天新增一个不带头的 `.rs` 会红而不是被静默跳过。豁免的逐条理由写在那个脚本
 * 的 `EXEMPT_EXTENSIONS` / `EXEMPT_PATHS` 与 `NOTICE` 一、许可里，两边同步改。
 *
 * 门禁在这里并不改变结论：把「没头 ⇒ 基座 MIT」写进生成器，等于让
 * 它可复现地给未来任何一个漏加头的阡陌新包盖上「随 LICENSE.base（MIT）」——
 * 那正是本轮要修掉的失效模式（原先硬编码的「随仓库 MIT」），只是从写死结论
 * 变成了动态推导出同一句假话。无头文件依旧既可能是基座件，也可能是豁免表里的
 * 阡陌件，这条推断本身不成立，与有没有门禁无关。
 *
 * 所以归属由 `baseSnapshotVerdict()` 用成果边界标签（CLAUDE.md §2.5 的
 * `base-snapshot/*`）判定；文件头这里只作为**观察到的事实**报出来，不参与
 * 定性。快照标签取不到时（浅克隆、未拉 tag）明说「归属未核实」，不退回推断。
 */
async function napiPackageProvenance(
  pkgDir: string,
  license: string,
  crateLicense: string,
): Promise<string> {
  const parts: string[] = []
  parts.push(
    license === ''
      ? 'package.json 无 license 字段（private:true）'
      : `package.json license = ${license}`,
  )
  const { ok, total } = await countAgplHeaders(pkgDir)
  if (total > 0) {
    parts.push(`TS 装载层 ${total} 个 .ts，带阡陌版权头 ${ok} 个（观察值）`)
    parts.push(await baseSnapshotVerdict(pkgDir, ok, total))
  }
  if (crateLicense !== '') {
    parts.push(
      `native/ 为阡陌自研 Rust crate（Cargo.toml license = ${crateLicense}，源文件带 SPDX 头）`,
    )
  }
  return parts.join('；')
}

/**
 * 用成果边界标签断归属：`base-snapshot/*` 是无父提交的基座零改动快照，
 * 「这个文件在不在那棵树里」是本仓库里唯一权威的「基座 / 阡陌」判据
 * （CLAUDE.md §2.5、BASE.md 上游同步记录）。
 *
 * 取不到标签就**只报事实、不下结论**——浅克隆和没拉 tag 的检出上这条查询
 * 必然失败，那时退回文件头推断就等于在最可能出错的环境里给出最不可靠的结论。
 */
async function baseSnapshotVerdict(
  pkgDir: string,
  headered: number,
  total: number,
): Promise<string> {
  const tag = latestBaseSnapshotTag()
  if (tag === '') {
    return '归属未核实（本地没有 base-snapshot/* 标签，无法比对基座快照；文件头不是判据——没有文件头既可能是基座文件，也可能是带不了或不该带注释头、或有意不加头的阡陌自有文件）'
  }
  const pkgRel = toPosixRelative(pkgDir)
  const snapshot = gitLsTree(tag, pkgRel)
  if (snapshot === null) {
    return `归属未核实（git ls-tree ${tag} 查询失败，无法比对基座快照）`
  }
  const tsFiles = (await listFiles(pkgDir))
    .filter(f => f.endsWith('.ts'))
    .map(toPosixRelative)
  const inSnapshot = tsFiles.filter(f => snapshot.has(f)).length
  if (inSnapshot === tsFiles.length) {
    return `TS 装载层 ${inSnapshot}/${tsFiles.length} 见于基座快照 ${tag} = 基座导入层，随 LICENSE.base（MIT）`
  }
  if (inSnapshot === 0) {
    const gap =
      headered < total
        ? `；其中 ${total - headered} 个缺章程 §5.5 要求的版权头，需补`
        : ''
    return `TS 装载层 0/${tsFiles.length} 见于基座快照 ${tag}（即快照之后新增）= 阡陌自有，随 LICENSE（AGPL-3.0-or-later）${gap}`
  }
  return `TS 装载层 ${inSnapshot}/${tsFiles.length} 见于基座快照 ${tag}，基座与阡陌混杂，需人工复核`
}

/** 仓库最新的成果边界快照标签；没有（或没装 git）时返回空串。 */
let baseSnapshotTagCache: string | null = null
function latestBaseSnapshotTag(): string {
  if (baseSnapshotTagCache !== null) return baseSnapshotTagCache
  const out = runGit(['tag', '--list', 'base-snapshot/*', '--sort=-v:refname'])
  baseSnapshotTagCache = out === null ? '' : (out.split('\n')[0]?.trim() ?? '')
  return baseSnapshotTagCache
}

/** `<tag>` 那棵树下 `pathRel` 里的全部文件路径；查询失败返回 null。 */
function gitLsTree(tag: string, pathRel: string): Set<string> | null {
  const out = runGit(['ls-tree', '-r', '--name-only', tag, '--', pathRel])
  if (out === null) return null
  return new Set(
    out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== ''),
  )
}

/** 跑一条 git，非零退出或 git 不可用时返回 null（调用方据此降级）。 */
function runGit(args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(['git', ...args], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode !== 0) return null
    return proc.stdout.toString()
  } catch {
    return null
  }
}

function toPosixRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join('/')
}

/**
 * `vendor/audio-capture/` 的 Corresponding Source 现状——三项全部现读现算：
 * D-9 收口前这里硬编码的「仓库内无构建脚本、无源码、无 LICENSE」在源码入库
 * 当天就整条变假，而 NOTICE 恰恰把本文件立成「可随时复现核对」的证据。
 */
async function audioCaptureProvenance(): Promise<string> {
  const crateRel = 'packages/audio-capture-napi/native/'
  const crateLicense = await readCargoLicense(
    join(REPO_ROOT, 'packages', 'audio-capture-napi', 'native', 'Cargo.toml'),
  )
  const buildScriptRel = 'scripts/build-audio-capture.sh'
  const hasBuildScript = await isFile(join(REPO_ROOT, buildScriptRel))
  const parts: string[] = []
  parts.push(
    crateLicense !== ''
      ? `源码 ${crateRel}（Rust crate，Cargo.toml license = ${crateLicense}）`
      : '仓库内无源码',
  )
  parts.push(hasBuildScript ? `构建脚本 ${buildScriptRel}` : '仓库内无构建脚本')
  parts.push('由 build.ts / post-build.ts 复制进 dist/vendor/')
  return parts.join('；')
}

/** Cargo.toml 的 `license = "..."`（顶层 [package] 段），读不到返回空串。 */
async function readCargoLicense(path: string): Promise<string> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return ''
  }
  const hit = /^\s*license\s*=\s*"([^"]*)"/m.exec(text)
  return hit?.[1] ?? ''
}

async function findLicenseFile(dir: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const hit = entries.find(e => /^(LICENSE|COPYING|NOTICE)/i.test(e))
  return hit ?? null
}

async function listFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (await isDirectory(full)) {
      // Rust 构建输出目录（native/.gitignore 里的 `target/`）不入库，里面躺的
      // 是本机刚构建出来的 libaudio_capture.dylib 之类。扫进来会让「包内有几个
      // 原生产物」随本机构建过没有而变，并把未入库的产物标成「入库」——
      // 与 NOTICE 承诺的「可随时复现核对」直接冲突。
      if (entry === 'target' && (await isFile(join(dir, 'Cargo.toml'))))
        continue
      out.push(...(await listFiles(full, depth + 1)))
    } else out.push(full)
  }
  return out
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

// ───────────────────────────── workspace roster ───────────────────────────

type WorkspaceRow = {
  name: string
  path: string
  license: string
  private: boolean
  headerCoverage: string
}

const COPYRIGHT_HEADER = '// Copyright 2026 Qianmo AgentNest Team'
const SPDX_HEADER = '// SPDX-License-Identifier: AGPL-3.0-or-later'

async function auditWorkspaces(lock: Lockfile): Promise<WorkspaceRow[]> {
  const rows: WorkspaceRow[] = []
  for (const ws of lock.workspaces) {
    if (ws.path === '') continue
    const dir = join(REPO_ROOT, ws.path)
    const pkg = await readJson(join(dir, 'package.json'))
    const license = readLicenseField(pkg)
    const isPrivate = isRecord(pkg) && pkg['private'] === true
    const coverage = ws.name.startsWith('@qianmo/')
      ? await headerCoverage(dir)
      : '—'
    rows.push({
      name: ws.name,
      path: ws.path,
      license: license === '' ? '(缺失)' : license,
      private: isPrivate,
      headerCoverage: coverage,
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** Charter §5.5 requires the two-line header on every @qianmo/* source file. */
async function headerCoverage(dir: string): Promise<string> {
  const { ok, total } = await countAgplHeaders(dir)
  return `${ok}/${total}`
}

async function countAgplHeaders(
  dir: string,
): Promise<{ ok: number; total: number }> {
  const files = (await listFiles(dir)).filter(f => f.endsWith('.ts'))
  let ok = 0
  for (const file of files) {
    // 口径与 NOTICE 一、许可一致：shebang 后的文件头可能从第 3 行开始，故扫描前 5 行而非前两行。
    const head = (await readFile(file, 'utf8')).split('\n', 5)
    if (
      head.some(line => line.trim() === COPYRIGHT_HEADER) &&
      head.some(line => line.trim() === SPDX_HEADER)
    ) {
      ok++
    }
  }
  return { ok, total: files.length }
}

// ───────────────────────────── report assembly ────────────────────────────

type Row = {
  component: Component
  reach: Reach
  path: string[]
  verdict: LicenseVerdict
  installed: boolean
  installedDir: string | null
  platformGated: boolean
  /** Filled only for rows with a license-field problem — see annotate(). */
  licenseFiles: string[] | null
}

const HOST_OS = process.platform
const HOST_CPU = process.arch

function buildRows(
  lock: Lockfile,
  reachability: Reachability,
  installed: Map<string, Installed>,
  workspaceLicenses: Map<string, string>,
): Row[] {
  const rows: Row[] = []
  for (const component of lock.packages.values()) {
    const hit = installed.get(`${component.name}@${component.version}`)
    const gated =
      (component.meta.os.length > 0 && !component.meta.os.includes(HOST_OS)) ||
      (component.meta.cpu.length > 0 && !component.meta.cpu.includes(HOST_CPU))
    // Workspace packages are read straight from their package.json — the
    // node_modules index sees them only through symlinks and their version
    // ('0.0.0' for every @qianmo/* package) is not a unique key.
    const raw =
      component.origin === 'workspace'
        ? workspaceLicenses.get(component.name)
        : hit?.license
    rows.push({
      component,
      reach: reachability.reach.get(component.key) ?? 'unreached',
      path: reachability.path.get(component.key) ?? [component.key],
      verdict: classifyLicense(raw),
      installed: component.origin === 'workspace' || hit !== undefined,
      installedDir: hit?.dir ?? null,
      platformGated: gated,
      licenseFiles: null,
    })
  }
  return rows.sort(
    (a, b) =>
      a.component.name.localeCompare(b.component.name) ||
      a.component.version.localeCompare(b.component.version) ||
      a.component.key.localeCompare(b.component.key),
  )
}

/**
 * For every component whose `license` field is missing or unparseable, look on
 * disk for an actual licence file. `SEE LICENSE IN LICENSE` where no LICENSE
 * file shipped is a different (and worse) finding than one where it did.
 */
async function annotateLicenseFiles(rows: Row[]): Promise<void> {
  for (const row of rows) {
    if (row.verdict.issues.length === 0 || row.installedDir === null) continue
    let entries: string[]
    try {
      entries = await readdir(row.installedDir)
    } catch {
      row.licenseFiles = []
      continue
    }
    row.licenseFiles = entries
      .filter(e => /^(LICEN[CS]E|COPYING)/i.test(e))
      .sort()
  }
}

function licenseFileNote(row: Row): string {
  if (row.licenseFiles === null) return '—'
  if (row.licenseFiles.length === 0) return '**无**'
  return row.licenseFiles.map(f => `\`${f}\``).join(', ')
}

function purlOf(component: Component): string {
  const encoded = component.name.startsWith('@')
    ? `%40${component.name.slice(1)}`
    : component.name
  return `pkg:npm/${encoded}@${component.version}`
}

type CycloneLicense =
  | { license: { id: string } }
  | { license: { name: string } }
  | { expression: string }

function licensesFor(verdict: LicenseVerdict): CycloneLicense[] | null {
  if (verdict.raw === '') return null
  if (verdict.ids.length === 1 && verdict.unrecognized.length === 0) {
    const id = verdict.ids[0]
    if (id !== undefined && verdict.raw === id) return [{ license: { id } }]
  }
  if (/\b(AND|OR|WITH)\b/i.test(verdict.raw) || verdict.raw.includes('(')) {
    return [{ expression: verdict.raw }]
  }
  return [{ license: { name: verdict.raw } }]
}

function buildBom(lock: Lockfile, rows: Row[]): unknown {
  // One component per purl. The lockfile lists the same name@version once per
  // place it resolves (1419 entries collapse to ~1056 packages), and a BOM
  // with duplicate purls is a malformed BOM. `runtime` wins over `dev` when
  // the same package is reachable both ways.
  const byPurl = new Map<string, Row>()
  for (const row of rows) {
    const purl = purlOf(row.component)
    const existing = byPurl.get(purl)
    if (
      existing === undefined ||
      (existing.reach !== 'runtime' && row.reach === 'runtime')
    ) {
      byPurl.set(purl, row)
    }
  }

  const components = [...byPurl.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([purl, row]) => {
      const licenses = licensesFor(row.verdict)
      const properties: Array<{ name: string; value: string }> = [
        { name: 'qianmo:reach', value: row.reach },
        { name: 'qianmo:licenseTier', value: row.verdict.tier },
        { name: 'qianmo:origin', value: row.component.origin },
      ]
      if (!row.installed) {
        properties.push({
          name: 'qianmo:installed',
          value: row.platformGated ? 'no (platform-gated)' : 'no',
        })
      }
      return {
        type: row.component.origin === 'workspace' ? 'application' : 'library',
        'bom-ref': purl,
        name: row.component.name,
        version: row.component.version,
        scope: row.reach === 'runtime' ? 'required' : 'optional',
        purl,
        ...(licenses === null ? {} : { licenses }),
        properties,
      }
    })

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': 'qianmo-agentnest',
        name: 'qianmo-agentnest',
        version: 'M0',
        licenses: [{ license: { id: 'MIT' } }],
        properties: [
          { name: 'qianmo:basePin', value: BASE_PIN },
          { name: 'qianmo:baseTag', value: BASE_TAG },
          {
            name: 'qianmo:rootPackage',
            value: `${lock.workspaces.find(w => w.path === '')?.name ?? '?'}`,
          },
        ],
      },
      tools: [
        {
          vendor: 'Qianmo AgentNest Team',
          name: 'scripts/sbom.ts',
          version: '1',
        },
      ],
      properties: [
        { name: 'qianmo:source', value: 'bun.lock + node_modules' },
        { name: 'qianmo:lockfileSha256', value: lock.sha256 },
        {
          name: 'qianmo:deterministic',
          value: 'no timestamp by design; regenerate with `bun run sbom`',
        },
      ],
    },
    components,
  }
}

// ───────────────────────────── markdown ───────────────────────────────────

function tierLabel(tier: LicenseTier): string {
  switch (tier) {
    case 'permissive':
      return '宽松'
    case 'weak-copyleft':
      return '弱传染（文件级）'
    case 'strong-copyleft':
      return '强传染'
    case 'network-copyleft':
      return '网络传染'
    case 'restricted':
      return '受限/非自由'
    default:
      return '未判定'
  }
}

/** Who pulled this in — the last hop before the component itself. */
function parentLabel(path: string[]): string {
  const parent = path[path.length - 2] ?? path[0] ?? '—'
  const segments = splitKeySegments(parent)
  return segments[segments.length - 1] ?? parent
}

function pathLabel(path: string[]): string {
  if (path.length <= 1) return path[0] ?? '—'
  const trimmed = path.length > 5 ? [path[0], '…', ...path.slice(-3)] : path
  return trimmed.filter(p => p !== undefined).join(' → ')
}

function buildMarkdown(
  lock: Lockfile,
  rows: Row[],
  binaries: BinaryAudit[],
  workspaces: WorkspaceRow[],
): string {
  const out: string[] = []
  const total = rows.length
  const runtime = rows.filter(r => r.reach === 'runtime').length
  const dev = rows.filter(r => r.reach === 'dev').length
  const unreached = rows.filter(r => r.reach === 'unreached').length
  const workspaceRows = rows.filter(r => r.component.origin === 'workspace')
  const external = rows.filter(r => r.component.origin !== 'workspace')

  // 这两行必须由生成器写出来，不能只存在于 docs/dev/sbom-m0.md 里：那个文件
  // 每次 `bun run sbom` 都被整体覆盖，手加的文件头会被无声抹掉，而抹掉之后
  // NOTICE 一、许可那条「前 5 行内带两行头」的判据就少数一个文件——一次纯粹
  // 由再生成造成的计数漂移，且不会有任何门禁报错。JSON 那半边不需要（也无法
  // 加）：`sbom-m0.json` 是严格 JSON，语法里没有注释。**这条只对严格 JSON 成立，
  // 不能推广到全部 `.json`**——同批统计里的 `tsconfig.json` 按 JSONC 解析、是接受
  // `//` 的，只是不该带（见本文件顶部 napiPackageProvenance 的注释）。
  out.push('<!-- Copyright 2026 Qianmo AgentNest Team -->')
  out.push('<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->')
  out.push('')
  out.push('# M0 第三方依赖 SBOM 与许可证清单')
  out.push('')
  out.push(
    '> **本文件由 `bun run sbom` 生成，不要手改。**改判据请改 `scripts/sbom.ts`。',
  )
  out.push('>')
  out.push(
    `> 输入：\`bun.lock\`（SHA-256 \`${lock.sha256.slice(0, 16)}…\`）+ \`node_modules\` 的 \`license\` 字段。机器可读版本见同目录 [\`sbom-m0.json\`](./sbom-m0.json)（CycloneDX 1.5 形状）。`,
  )
  out.push('')
  out.push(
    '对应 roadmap **P8.4** 交付物①，章程 §5 与风险 L-2 的证据链见 [`license-chain-m0.md`](./license-chain-m0.md)。',
  )
  out.push('')

  out.push('## 0. 三条读表须知')
  out.push('')
  out.push(
    '**① `dev` 不等于「不分发」。**`vite.config.ts` 设 `ssr.noExternal: true`（仅 `doubaoime-asr` / `opus-encdec` 例外），构建把依赖整体打进 `dist/`；而基座把绝大多数运行时库放在 `devDependencies` 里——根 `package.json` 的 `dependencies` 只有 5 项。**因此本表的 runtime/dev 划分反映的是 package.json 字段归属，不是产物边界。传染性许可的处置不得以「它是 dev 依赖」为由放行。**',
  )
  out.push('')
  out.push(
    '**② 本仓库不发 npm 包**（章程 N-14）。分发形态是演示与竞赛材料随附的源码/产物，不是 registry 上的包。许可义务按「分发」评估仍然成立。',
  )
  out.push('')
  out.push(
    '**③ 平台受限的 optional 依赖在本机不装**，因而读不到 `license` 字段。它们单列一节，不混进「许可缺失」清单。',
  )
  out.push('')

  out.push('## 1. 统计总览')
  out.push('')
  out.push('| 项 | 数 |')
  out.push('|---|---|')
  out.push(`| 组件总数（lockfile 条目，含重复解析） | ${total} |`)
  out.push(`| ├ 第三方组件 | ${external.length} |`)
  out.push(`| └ workspace 自有包 | ${workspaceRows.length} |`)
  out.push(`| 唯一 name@version（第三方） | ${uniqueCount(external)} |`)
  out.push(`| runtime 可达 | ${runtime} |`)
  out.push(`| dev 可达 | ${dev} |`)
  out.push(`| 未被任何根可达（解析遗漏或纯 peer） | ${unreached} |`)
  out.push(
    `| 本机未安装（去重，平台受限 optional） | ${dedupe(rows.filter(r => !r.installed && r.platformGated)).length} |`,
  )
  out.push('')

  const installedExternal = dedupe(external.filter(r => r.installed))
  out.push('## 2. 许可分布')
  out.push('')
  out.push(
    `按归一化后的许可表达式统计，范围为**本机已安装的第三方组件**（去重到 name@version，共 ${installedExternal.length} 项）。未安装的 ${uniqueCount(external) - installedExternal.length} 项读不到字段，单列在 §5，不计入本表。`,
  )
  out.push('')
  out.push(
    '「分类」按 §3 的 SPDX 求值口径给出：`(A OR B)` 取较宽松的一支，所以 `(BSD-3-Clause OR GPL-2.0)` 显示为宽松。',
  )
  out.push('')
  const dist = new Map<string, { count: number; tier: LicenseTier }>()
  for (const row of installedExternal) {
    const label = row.verdict.raw === '' ? '(缺失)' : row.verdict.raw
    const entry = dist.get(label) ?? { count: 0, tier: row.verdict.tier }
    entry.count++
    dist.set(label, entry)
  }
  out.push('| 许可表达式 | 分类 | 组件数 |')
  out.push('|---|---|---|')
  for (const [label, entry] of [...dist.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  )) {
    out.push(`| \`${label}\` | ${tierLabel(entry.tier)} | ${entry.count} |`)
  }
  out.push('')

  out.push('## 3. 传染性许可扫描（P8.4 DoD 判据）')
  out.push('')
  out.push(
    '判定口径：SPDX 表达式按 `OR` 取最宽松分支、`AND` 取最严格分支求值——`(MIT OR GPL-2.0)` **不算命中**，因为可以取 MIT 那一支；`GPL-2.0 WITH Classpath-exception-2.0` 降一档，因为该例外正是为解除链接传染而写的。扫描覆盖 GPL / LGPL / AGPL / SSPL / EUPL / CC-BY-SA / OSL / CDDL / MPL / EPL / CPL / MS-RL / APSL / GFDL / Sleepycat / QPL / CECILL / Artistic 等族。',
  )
  out.push('')

  const hits = dedupe(
    external.filter(r => CONTAGIOUS_TIERS.has(r.verdict.tier)),
  ).sort(
    (a, b) =>
      TIER_RANK[b.verdict.tier] - TIER_RANK[a.verdict.tier] ||
      a.component.name.localeCompare(b.component.name),
  )
  const strong = hits.filter(r => TIER_RANK[r.verdict.tier] >= 2)
  const restricted = dedupe(
    external.filter(r => r.verdict.tier === 'restricted'),
  )

  out.push(
    `**结论：强传染 / 网络传染命中 ${strong.length} 项；弱传染（文件级）命中 ${hits.length - strong.length} 项；受限/非自由 ${restricted.length} 项。**`,
  )
  out.push('')
  if (hits.length === 0 && restricted.length === 0) {
    out.push('无命中。DoD「无 GPL 类传染性许可项」满足。')
  } else {
    out.push('| 包 | 版本 | 许可 | 分类 | 引入路径 | 字段归属 | 处置建议 |')
    out.push('|---|---|---|---|---|---|---|')
    for (const row of [...hits, ...restricted]) {
      out.push(
        `| \`${row.component.name}\` | ${row.component.version} | \`${row.verdict.raw}\` | ${tierLabel(row.verdict.tier)} | ${pathLabel(row.path)} | ${row.reach} | ${disposition(row)} |`,
      )
    }
  }
  out.push('')

  out.push('## 4. 许可字段缺失 / 非 SPDX / `SEE LICENSE IN`')
  out.push('')
  const problems = dedupe(
    external.filter(r => r.installed && r.verdict.issues.length > 0),
  ).sort((a, b) => a.component.name.localeCompare(b.component.name))
  if (problems.length === 0) {
    out.push('无。所有已安装的第三方组件都带可解析的 SPDX 许可字段。')
  } else {
    out.push(
      '「包内许可文件」列直接看磁盘：`SEE LICENSE IN <file>` 指向的文件**未必随包发布**，那种情况下授权正文在本机根本不存在，必须回到上游仓库取。',
    )
    out.push('')
    out.push('| 包 | 版本 | `license` 字段 | 问题 | 包内许可文件 | 引入路径 |')
    out.push('|---|---|---|---|---|---|')
    for (const row of problems) {
      out.push(
        `| \`${row.component.name}\` | ${row.component.version} | ${row.verdict.raw === '' ? '（无）' : `\`${row.verdict.raw}\``} | ${row.verdict.issues.join(', ')} | ${licenseFileNote(row)} | ${pathLabel(row.path)} |`,
      )
    }
    out.push('')
    out.push(
      '本脚本只读字段、不读授权正文。**上表每一项的人工核读结论记在 [`license-chain-m0.md`](./license-chain-m0.md) §4**，其中包含本次审计查到的非开源授权项的定性与其影响面判定。',
    )
  }
  out.push('')

  const notInstalled = dedupe(external.filter(r => !r.installed)).sort((a, b) =>
    a.component.name.localeCompare(b.component.name),
  )
  const gated = notInstalled.filter(r => r.platformGated)
  const ungated = notInstalled.filter(r => !r.platformGated)

  out.push('## 5. 本机未安装的组件（许可待补）')
  out.push('')
  out.push(
    `本机 \`${HOST_OS}-${HOST_CPU}\`。共 ${notInstalled.length} 项在 lockfile 里但本机 \`node_modules\` 中不存在，因而读不到 \`license\` 字段；其中 ${gated.length} 项是被 \`os\`/\`cpu\` 过滤掉的平台原生包。**结项材料若要覆盖全平台，须在各目标平台分别跑一次本脚本再并表。**`,
  )
  out.push('')
  out.push(
    '按引入者归组。「同族已安装样本的许可」是同一引入者下已装组件的许可集合——平台变体包通常与同族一致，可据此预判，但**不构成判定**。',
  )
  out.push('')
  const groups = new Map<string, { count: number; sample: string[] }>()
  for (const row of gated) {
    const parent = parentLabel(row.path)
    const entry = groups.get(parent) ?? { count: 0, sample: [] }
    entry.count++
    groups.set(parent, entry)
  }
  for (const row of installedExternal) {
    const parent = parentLabel(row.path)
    const entry = groups.get(parent)
    if (entry === undefined) continue
    const label = row.verdict.raw === '' ? '(缺失)' : row.verdict.raw
    if (!entry.sample.includes(label)) entry.sample.push(label)
  }
  out.push('| 引入者 | 未安装项数 | 同族已安装样本的许可 |')
  out.push('|---|---|---|')
  for (const [parent, entry] of [...groups.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
  )) {
    out.push(
      `| \`${parent}\` | ${entry.count} | ${entry.sample.length === 0 ? '（无已装同族）' : entry.sample.map(s => `\`${s}\``).join('、')} |`,
    )
  }
  out.push('')
  if (ungated.length > 0) {
    out.push(
      `另有 ${ungated.length} 项**不受平台限制却仍未安装**（多为未被选中的 optional / peer 分支），逐项列出：`,
    )
    out.push('')
    out.push('| 包 | 版本 | 引入路径 |')
    out.push('|---|---|---|')
    for (const row of ungated) {
      out.push(
        `| \`${row.component.name}\` | ${row.component.version} | ${pathLabel(row.path)} |`,
      )
    }
    out.push('')
  }

  out.push('## 6. 预编译原生二进制的许可来源核对')
  out.push('')
  out.push('| 位置 | 内容 | 入库状态 | 目录内 LICENSE | 溯源 |')
  out.push('|---|---|---|---|---|')
  for (const bin of binaries) {
    out.push(
      `| \`${bin.location}\` | ${bin.what} | ${bin.tracked} | ${bin.licenseFile} | ${bin.provenance} |`,
    )
  }
  out.push('')

  out.push('## 7. workspace 自有包')
  out.push('')
  out.push(
    '「版权头」列 = 该包 `.ts` 文件中首两行为 `// Copyright 2026 Qianmo AgentNest Team` + `// SPDX-License-Identifier: AGPL-3.0-or-later` 的比例（章程 §5.5 要求 `@qianmo/*` 全覆盖）。',
  )
  out.push('')
  out.push('### 7.1 阡陌自有（`@qianmo/*`）')
  out.push('')
  out.push('| 包 | 路径 | `license` | private | 版权头 |')
  out.push('|---|---|---|---|---|')
  for (const ws of workspaces.filter(w => w.name.startsWith('@qianmo/'))) {
    out.push(
      `| \`${ws.name}\` | \`${ws.path}\` | ${ws.license} | ${ws.private ? '是' : '否'} | ${ws.headerCoverage} |`,
    )
  }
  out.push('')
  out.push('### 7.2 基座既有 workspace 包')
  out.push('')
  out.push(
    '基座包普遍不写 `license` 字段。它们 `private: true` 且不单独发布，由 `LICENSE.base`（MIT，基座层）覆盖——见 `NOTICE` 一、许可。**根 `LICENSE` 是阡陌自有层的 AGPL-3.0，不覆盖它们**：两层的权威判据是文件在不在基座快照 `base-snapshot/*` 里，不是文件头——**带头 ⇒ 属于 AGPL 层**成立，反向不成立：无头文件既可能是基座文件，也可能是不在基座快照里的阡陌文件；另有一批带着阡陌改动的基座文件有意不加头，这是独立限制、不是反例。具体个数与拆分现跑现算，命令与口径见 `NOTICE` 一、许可。**不建议在本任务里补字段**：那是基座发布面（CLAUDE.md §0）。',
  )
  out.push('')
  out.push('| 包 | 路径 | `license` | private |')
  out.push('|---|---|---|---|')
  for (const ws of workspaces.filter(w => !w.name.startsWith('@qianmo/'))) {
    out.push(
      `| \`${ws.name}\` | \`${ws.path}\` | ${ws.license} | ${ws.private ? '是' : '否'} |`,
    )
  }
  out.push('')

  return `${out.join('\n')}\n`
}

function uniqueCount(rows: Row[]): number {
  return new Set(rows.map(r => `${r.component.name}@${r.component.version}`))
    .size
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>()
  const out: Row[] = []
  for (const row of rows) {
    const id = `${row.component.name}@${row.component.version}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(row)
  }
  return out
}

function disposition(row: Row): string {
  const isLgpl = row.verdict.ids.some(id => /^LGPL/i.test(id))
  switch (row.verdict.tier) {
    case 'network-copyleft':
      return '**阻断**：常驻节点对外提供服务即触发义务，须替换或彻底隔离为独立进程并记录'
    case 'strong-copyleft':
      return '**阻断**：`ssr.noExternal` 会把它打进 `dist/`，须替换、或改为运行时外部依赖并单独分发'
    case 'weak-copyleft':
      return isLgpl
        ? '可留用（预编译共享库，非 JS，不进 `dist/` 的 JS bundle，随 `node_modules` 以独立文件形式存在）：未修改其源码即不传染到本仓库代码；分发时须随附其许可与版权声明，并保留使用者替换该库的可能（LGPL §4）'
        : '可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明'
    case 'restricted':
      return '**阻断**：无有效授权或含使用限制，须替换'
    default:
      return '人工复核'
  }
}

// ───────────────────────────── main ───────────────────────────────────────

async function main(): Promise<void> {
  const check = process.argv.includes('--check')

  const lock = await readLockfile()
  const installed = await indexInstalled()
  const reachability = computeReachability(lock)
  const binaries = await auditPrebuiltBinaries()
  const workspaces = await auditWorkspaces(lock)
  const workspaceLicenses = new Map(
    workspaces.map(ws => [ws.name, ws.license === '(缺失)' ? '' : ws.license]),
  )
  const rows = buildRows(lock, reachability, installed, workspaceLicenses)
  await annotateLicenseFiles(rows)

  const bom = buildBom(lock, rows)
  await Bun.write(JSON_OUT, `${JSON.stringify(bom, null, 2)}\n`)
  await Bun.write(MD_OUT, buildMarkdown(lock, rows, binaries, workspaces))

  const external = rows.filter(r => r.component.origin !== 'workspace')
  const blocking = dedupe(
    external.filter(
      r =>
        TIER_RANK[r.verdict.tier] >= TIER_RANK['strong-copyleft'] &&
        r.verdict.tier !== 'unknown',
    ),
  )
  const weak = dedupe(external.filter(r => r.verdict.tier === 'weak-copyleft'))
  const unknown = dedupe(
    external.filter(r => r.verdict.tier === 'unknown' && r.installed),
  )

  console.log(`✓ sbom: ${rows.length} lockfile entries → docs/dev/sbom-m0.json`)
  console.log(`✓ sbom: 人读摘要 → docs/dev/sbom-m0.md`)
  console.log(
    `  强/网络传染 ${blocking.length} · 弱传染 ${weak.length} · 未判定（已安装）${unknown.length}`,
  )
  for (const row of blocking) {
    console.log(
      `  ✗ ${row.component.name}@${row.component.version}  ${row.verdict.raw}`,
    )
  }

  if (check && blocking.length > 0) {
    console.error(
      '✗ sbom --check: 存在强传染 / 网络传染 / 受限许可组件，P8.4 DoD 不满足。',
    )
    process.exit(1)
  }
}

// Guarded: `scripts/__tests__/sbom.test.ts` imports the classifier from this
// module, and an unguarded call would make `bun test` rewrite docs/dev/.
if (import.meta.main) {
  await main()
}
