#!/usr/bin/env bun
/**
 * Dead-code ratchet over knip.
 *
 * Raw `knip-bun` cannot gate a merge here: it reports ~1900 unused exports and
 * types, and most of them are not deletable. `src/entrypoints/sdk/` alone
 * accounts for ~170 — that is the Agent SDK's public schema surface, with
 * coreTypes.generated.ts generated FROM coreSchemas.ts, so "nothing imports it
 * internally" is the expected state, not a defect. Deleting on knip's word
 * would break the published contract.
 *
 * So the categories are split by how trustworthy they are:
 *
 *   ZERO_CATEGORIES   cleaned to zero and kept there. A regression means a
 *                     real mistake — a file nothing imports, a dependency
 *                     nobody uses, an import that does not resolve. These fail
 *                     the moment they come back.
 *   BUDGET_CATEGORIES the ~1900-item backlog. Two-sided ratchet, same contract
 *                     as check-cycles.ts / check-prompt-purity.ts /
 *                     check-mock-hygiene.ts: going over fails, and going under
 *                     fails too until the lower baseline is committed, so
 *                     progress cannot silently erode.
 *
 * knip's own exit code is ignored on purpose — it is non-zero whenever any
 * issue exists, which is always true while the backlog is non-empty. The
 * verdict comes from the counts below.
 *
 * Usage:
 *   bun run scripts/check-unused.ts
 *   bun run scripts/check-unused.ts --update
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')

/**
 * The budget is split in three so upstream syncs stop conflicting on it
 * (P10.3 ③, born from the sync drill where this file was a guaranteed
 * conflict every time; the third file was added by P10.2, the first real
 * sync, for the reason spelled out below):
 *
 *   unused-budget.json                the BASE baseline — upstream's own
 *                                     numbers, kept byte-identical to the
 *                                     pinned base so an upstream hunk applies
 *                                     cleanly. Never written by --update.
 *   unused-budget.upstream-drift.json how far upstream's committed baseline is
 *                                     from what upstream's OWN tree actually
 *                                     measures. Not our dead surface, and not
 *                                     ours to delete. Re-measured by hand at
 *                                     each sync (recipe below). Never written
 *                                     by --update.
 *   unused-budget.qianmo.json         the Qianmo DELTA on top of those two
 *                                     (negative = we deleted dead surface, or
 *                                     revived something upstream had orphaned).
 *                                     The only file --update rewrites.
 *
 * Effective budget per category = baseline + upstream drift + qianmo delta.
 *
 * Why the drift column exists: at the v2.38.3 → v2.46.0 sync, upstream's
 * committed baseline said 1240/634/9 while upstream's own pristine tree —
 * measured on this machine, same node_modules — measured 1247/665/10. Folding
 * that +7/+31/+1 into the Qianmo column would have booked upstream's stale
 * numbers as our dead code and quietly destroyed the meaning of the split.
 * (Control: pristine v2.38.3 reproduces its committed 1255/638/9 exactly, so
 * the environment is faithful and the gap is upstream's, not ours.)
 *
 * At each upstream sync, in this order:
 *   1. the patch updates unused-budget.json to upstream's new numbers;
 *   2. materialize the pristine upstream tree (`git archive <upstream-sha> |
 *      tar -x -C <scratch>`, clone this repo's node_modules into it — do NOT
 *      use a git worktree, see CLAUDE.md §3.1) and run `bunx knip-bun
 *      --reporter json` there. drift = that measurement − unused-budget.json;
 *      write it to unused-budget.upstream-drift.json by hand;
 *   3. run `--update` to record what is genuinely ours.
 * Skipping step 2 does not break the gate — it just misfiles upstream's
 * staleness as ours.
 */
const BASE_BUDGET_FILE = join(PROJECT_ROOT, 'scripts', 'unused-budget.json')
const UPSTREAM_DRIFT_FILE = join(
  PROJECT_ROOT,
  'scripts',
  'unused-budget.upstream-drift.json',
)
const QIANMO_DELTA_FILE = join(
  PROJECT_ROOT,
  'scripts',
  'unused-budget.qianmo.json',
)

/** How many offending entries to print when the ratchet trips. */
const SAMPLE_SIZE = 12

/**
 * Must stay at zero. Everything here was verified by hand and removed; the
 * remaining reports would be genuine defects.
 */
const ZERO_CATEGORIES = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'unresolved',
  'binaries',
] as const

/** Ratcheted backlog — large, partly undeletable, shrinks over time. */
const BUDGET_CATEGORIES = ['exports', 'types', 'duplicates'] as const

type Category =
  | (typeof ZERO_CATEGORIES)[number]
  | (typeof BUDGET_CATEGORIES)[number]

type KnipIssue = { name?: string; line?: number }
type KnipFileReport = { file: string } & Partial<
  Record<Category, KnipIssue[] | string[]>
>

type Budget = Partial<Record<Category, number>>

function runKnip(): KnipFileReport[] {
  const proc = Bun.spawnSync(['bunx', 'knip-bun', '--reporter', 'json'], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = proc.stdout.toString()
  // knip exits 1 whenever it found anything, which is the normal state here —
  // only a missing/garbled payload is a real failure.
  const start = stdout.indexOf('{')
  if (start === -1) {
    console.error('✗ knip produced no JSON payload.')
    console.error(proc.stderr.toString().slice(0, 2000))
    process.exit(1)
  }
  try {
    return (JSON.parse(stdout.slice(start)) as { issues: KnipFileReport[] })
      .issues
  } catch (error) {
    console.error(`✗ could not parse knip JSON: ${String(error)}`)
    process.exit(1)
  }
}

function tally(issues: KnipFileReport[]): {
  counts: Record<Category, number>
  samples: Record<Category, string[]>
} {
  const counts = {} as Record<Category, number>
  const samples = {} as Record<Category, string[]>
  for (const category of [...ZERO_CATEGORIES, ...BUDGET_CATEGORIES]) {
    counts[category] = 0
    samples[category] = []
  }

  for (const report of issues) {
    for (const category of [...ZERO_CATEGORIES, ...BUDGET_CATEGORIES]) {
      const entries = report[category]
      if (!Array.isArray(entries) || entries.length === 0) continue
      counts[category] += entries.length
      for (const entry of entries) {
        if (samples[category].length >= SAMPLE_SIZE) break
        const name =
          typeof entry === 'string' ? entry : (entry.name ?? '(unnamed)')
        const line = typeof entry === 'string' ? undefined : entry.line
        samples[category].push(
          `${report.file}${line === undefined ? '' : `:${line}`}  ${name}`,
        )
      }
    }
  }

  return { counts, samples }
}

function readJsonBudget(path: string): Budget {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Budget
  } catch {
    return {}
  }
}

/**
 * Effective budget per category: base baseline + upstream drift + qianmo
 * delta. See the three-file comment at the top for what each column means.
 */
function readBudget(): Budget {
  const base = readJsonBudget(BASE_BUDGET_FILE)
  const drift = readJsonBudget(UPSTREAM_DRIFT_FILE)
  const delta = readJsonBudget(QIANMO_DELTA_FILE)
  const budget: Budget = {}
  for (const category of BUDGET_CATEGORIES) {
    const baseline = base[category]
    if (baseline === undefined) continue
    budget[category] =
      baseline + (drift[category] ?? 0) + (delta[category] ?? 0)
  }
  return budget
}

function main(): void {
  const update = process.argv.includes('--update')
  const { counts, samples } = tally(runKnip())

  if (update) {
    // Only the qianmo delta is ever rewritten; the base baseline stays
    // byte-identical to upstream so syncs apply cleanly, and the upstream
    // drift is a hand-measured fact about upstream's own tree.
    const base = readJsonBudget(BASE_BUDGET_FILE)
    const drift = readJsonBudget(UPSTREAM_DRIFT_FILE)
    const delta: Budget = {}
    for (const category of BUDGET_CATEGORIES)
      delta[category] =
        counts[category] - (base[category] ?? 0) - (drift[category] ?? 0)
    writeFileSync(QIANMO_DELTA_FILE, `${JSON.stringify(delta, null, 2)}\n`)
    console.log(
      `Updated scripts/unused-budget.qianmo.json (delta over base+drift): ${BUDGET_CATEGORIES.map(c => `${c}=${counts[c]} (Δ${(delta[c] ?? 0) >= 0 ? '+' : ''}${delta[c]})`).join(', ')}`,
    )
    return
  }

  let failed = false

  for (const category of ZERO_CATEGORIES) {
    if (counts[category] === 0) continue
    failed = true
    console.error(
      `✗ unused: ${counts[category]} ${category} — this category is held at zero.`,
    )
    for (const sample of samples[category]) console.error(`    ${sample}`)
    console.error('')
  }

  const budget = readBudget()
  for (const category of BUDGET_CATEGORIES) {
    const allowed = budget[category]
    if (allowed === undefined) continue
    if (counts[category] > allowed) {
      failed = true
      console.error(
        `✗ unused: ${category} rose ${allowed} → ${counts[category]}. Delete the new dead surface, or raise the budget deliberately.`,
      )
      for (const sample of samples[category]) console.error(`    ${sample}`)
      console.error('')
    } else if (counts[category] < allowed) {
      failed = true
      console.error(
        `✗ unused: ${category} fell ${allowed} → ${counts[category]}. Good — lock it in so it cannot regress:`,
      )
      console.error('')
      console.error('    bun run scripts/check-unused.ts --update')
      console.error('')
    }
  }

  if (failed) process.exit(1)

  console.log(
    `✓ unused: ${ZERO_CATEGORIES.join('/')} all zero; ${BUDGET_CATEGORIES.map(c => `${c}=${counts[c]}`).join(', ')} at budget.`,
  )
}

main()
