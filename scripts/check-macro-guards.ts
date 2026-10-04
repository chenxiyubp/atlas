#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bans the one spelling of a MACRO read that is wrong in every shipped bundle.
 *
 * `MACRO.*` is a compile-time substitution: the bundler (and `bun -d`) rewrites
 * the *member expression* `MACRO.VERSION` into a literal and leaves the bare
 * identifier `MACRO` exactly as written. Nothing ever defines that identifier,
 * so a guard written as
 *
 *     typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'
 *
 * survives minification as a live runtime test on a global that does not
 * exist. The irony is that the substitution succeeded — the literal is sitting
 * right there in the branch the test refuses to enter.
 *
 * Four call sites arrived at that spelling independently (issue #75): the
 * `version` field of every transcript entry, `doctor`'s reported version, the
 * Sentry release tag, and the API log's build age. Nothing caught them,
 * because under `bun test` MACRO is genuinely absent and the fallback branch
 * is genuinely correct — the tests and the artifact disagree about which
 * branch is live, and only the artifact ships. Three of the four were then
 * saved by luck: `entrypoints/cli.tsx` used to install a `globalThis.MACRO`
 * fallback before it loaded anything lazily, so late-loading modules found the
 * guard true. Anything in the entry's static import graph would not have — and
 * that fallback is gone since issue #81, which is what it was hiding.
 *
 * The spelling that works on both sides is `try`/`catch`, because it does not
 * ask a question at all — substituted, the body is a literal; unsubstituted,
 * the ReferenceError is caught. `src/constants/buildProvenance.ts` implements
 * it once per define; call those instead of reaching for MACRO yourself.
 *
 * Hard zero, no budget file. A ratchet would be the wrong instrument: there is
 * no legitimate use to grandfather, and every instance is a define silently
 * lost in production. Same posture as the extension rule in
 * check-mock-hygiene.ts.
 *
 * Usage:
 *   bun run scripts/check-macro-guards.ts
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')

/** Directories walked. Everything else in the repo is not compiled source. */
const SCAN_ROOTS = ['src', 'packages', 'scripts', 'demo', 'tests'] as const

/** Never descended into: generated output, vendored blobs, dependencies. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.git',
  '.vite',
  '__snapshots__',
])

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']

/**
 * `typeof MACRO`, with or without the parenthesised call-looking form.
 *
 * Deliberately does NOT match `typeof globalThis.MACRO`: that one reads a real
 * property of a real object, which is the only correct question anyone asks
 * about MACRO at runtime. Roughly fifteen test files ask it before installing
 * their own MACRO, since `bun test` substitutes nothing.
 *
 * This file is not exempt from its own rule and does not need to be: the
 * pattern below is a regex literal, so the character after `typeof` in it is a
 * backslash, and the rule requires whitespace or `(` there.
 */
const TYPEOF_MACRO_RE = /\btypeof\s*\(*\s*MACRO\b/g

export interface MacroGuardOffense {
  /** 1-based, so it lines up with an editor jump. */
  line: number
  /** The offending line as written, trimmed. */
  text: string
}

/**
 * Blanks out comments and string/template literals, keeping every byte's
 * position so reported line numbers stay true.
 *
 * Needed because the correct spelling has to be *documented*, and the docs
 * necessarily quote the wrong one — this very file does it a dozen times
 * above, and so do buildProvenance.ts and its test. A grep-level check would
 * flag its own explanation and get itself deleted.
 *
 * Template literals keep their `${…}` expressions live: a substitution hole is
 * ordinary code and could hide the idiom.
 *
 * Regex literals are not tracked, so a quote inside one (`/['"]/`) opens a
 * string the scanner then closes at end of line. The blast radius is that one
 * line, and it can only ever hide an offense, never invent one — the trade for
 * not carrying a real tokenizer here.
 */
function blankNonCode(source: string): string {
  const out = source.split('')
  const templateStack: number[] = []
  let i = 0

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  while (i < source.length) {
    const two = source.slice(i, i + 2)

    if (two === '//') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      blank(i, stop)
      i = stop
      continue
    }

    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }

    const char = source[i]

    if (char === "'" || char === '"') {
      const quote = char
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === quote || source[j] === '\n') break
        j++
      }
      blank(i, Math.min(j + 1, source.length))
      i = Math.min(j + 1, source.length)
      continue
    }

    if (char === '`') {
      templateStack.push(0)
      out[i] = ' '
      i++
      // Walk the literal text, blanking it, until the closing backtick or the
      // start of a `${` hole — whose contents are left alone as real code.
      while (i < source.length) {
        if (source[i] === '\\') {
          blank(i, i + 2)
          i += 2
          continue
        }
        if (source[i] === '`') {
          out[i] = ' '
          i++
          templateStack.pop()
          break
        }
        if (source.slice(i, i + 2) === '${') {
          blank(i, i + 2)
          i += 2
          break
        }
        if (source[i] !== '\n') out[i] = ' '
        i++
      }
      continue
    }

    if (char === '}' && templateStack.length > 0) {
      // Closing a `${` hole puts us back inside literal text. Re-enter by
      // rewinding to the backtick handler with the brace consumed.
      out[i] = ' '
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          blank(i, i + 2)
          i += 2
          continue
        }
        if (source[i] === '`') {
          out[i] = ' '
          i++
          templateStack.pop()
          break
        }
        if (source.slice(i, i + 2) === '${') {
          blank(i, i + 2)
          i += 2
          break
        }
        if (source[i] !== '\n') out[i] = ' '
        i++
      }
      continue
    }

    i++
  }

  return out.join('')
}

/** Every `typeof MACRO` in real code, comments and strings excluded. */
export function findMacroGuardOffenses(source: string): MacroGuardOffense[] {
  const code = blankNonCode(source)
  const originalLines = source.split('\n')
  const offenses: MacroGuardOffense[] = []

  for (const match of code.matchAll(TYPEOF_MACRO_RE)) {
    const index = match.index ?? 0
    const line = code.slice(0, index).split('\n').length
    offenses.push({
      line,
      text: (originalLines[line - 1] ?? '').trim(),
    })
  }

  return offenses
}

function* walk(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // a scan root that does not exist in this checkout
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(absolute)
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
      continue
    }
    yield absolute
  }
}

function main(): void {
  let scanned = 0
  let failed = false

  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(PROJECT_ROOT, root))) {
      scanned++
      const offenses = findMacroGuardOffenses(readFileSync(file, 'utf8'))
      if (offenses.length === 0) continue
      failed = true
      const shown = relative(PROJECT_ROOT, file)
      for (const offense of offenses) {
        console.error(`  ${shown}:${offense.line}`)
        console.error(`    ${offense.text}`)
      }
    }
  }

  console.log(`[macro-guards] scanned ${scanned} source files`)

  if (failed) {
    console.error(
      '\n[macro-guards] FAIL: `typeof MACRO` is false in every bundle.',
    )
    console.error(
      '[macro-guards] The bundler substitutes `MACRO.FIELD` and leaves the bare',
    )
    console.error(
      '[macro-guards] `MACRO` identifier alone, so this guard tests a global that',
    )
    console.error(
      '[macro-guards] does not exist and the define it protects is silently lost.',
    )
    console.error(
      '[macro-guards] Call src/constants/buildProvenance.ts instead, or add a field',
    )
    console.error(
      '[macro-guards] there using the same try/catch shape. See issue #75.',
    )
    process.exit(1)
  }

  console.log('[macro-guards] OK: no `typeof MACRO` guards.')
}

if (import.meta.main) main()
