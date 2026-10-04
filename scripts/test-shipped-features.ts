#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Run the query-loop and compaction tests with the features a release build
 * compiles in.
 *
 * `feature('X')` is decided at compile time. A build compiles in
 * `resolveBuildFeatures()` from `scripts/defines.ts`; plain `bun test` compiles
 * every feature out. So a branch behind a default-on flag is dead code under
 * the unit suite and live in every artifact, and a test written for it passes
 * without ever reaching it.
 *
 * That is not hypothetical. `REACTIVE_COMPACT` is default-on in every build
 * (the base turned it on in its v2.42.0, see CHANGELOG.md), and `query.ts`
 * passed `assistantMessages.at(-1)` — `undefined` after an empty model
 * response — to `reactiveCompact.isWithheldMediaSizeError`, which read `.type`
 * off it. The unit test for exactly that case,
 * `queryAutonomyProviderBoundary.test.ts › an empty provider stream…`, was green
 * at every gate, because under plain `bun test` `reactiveCompact` is `null` and
 * the optional chain skipped the call. The shipped build crashed the turn
 * (beta-5, 2026-09-27: three watch runs lost as `-32603 Internal error`).
 * Same shape as the MACRO guard in `check-macro-guards.ts`: the tests and the
 * artifact disagree about which branch is live, and only the artifact ships.
 *
 * ## Scope
 *
 * The files named in `GROUPS` exercise the query loop and compaction, where
 * the default-on flags change control flow. The rest of the suite is not run
 * this way, on purpose: several suites pin the compiled-out branch as their
 * subject (the tool-inventory snapshot pins the default tool list; some ACP
 * permission tests state "while TRANSCRIPT_CLASSIFIER is compiled out"). For
 * them a shipped-feature run is a different configuration, not a stricter one,
 * and it goes red by design. Add a file here once it is meant to hold for the
 * shipped build.
 *
 * ## How it runs
 *
 * The feature list is read from `resolveBuildFeatures()`, never copied, so it
 * cannot drift from what `build:vite` and `bun run dev` compile in —
 * `FEATURE_<NAME>` overrides included. One `bun test` process per group, as
 * `test-shards.sh` does per directory, so a group's `mock.module` state stays
 * inside that group. A pattern that matches nothing is a failure: a gate that
 * silently checks zero files is the failure mode this script exists to close.
 * One JUnit report per group lands in `test-reports/`, next to the shard
 * reports CI uploads.
 *
 * Usage:
 *   bun run scripts/test-shipped-features.ts
 */

import { Glob } from 'bun'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBuildFeatures } from './defines.ts'

const PROJECT_ROOT = join(import.meta.dir, '..')
const REPORT_DIR = 'test-reports'

const GROUPS: ReadonlyArray<{
  readonly name: string
  readonly patterns: readonly string[]
}> = [
  { name: 'query', patterns: ['src/__tests__/query*.test.ts'] },
  { name: 'compact', patterns: ['src/services/compact/**/*.test.ts'] },
  {
    // States in its own header that it needs `--feature REACTIVE_COMPACT` to
    // reach the branch it pins.
    name: 'reactive-only-gate',
    patterns: ['src/services/analytics/__tests__/reactiveOnlyGate.test.ts'],
  },
]

function filesFor(patterns: readonly string[]): string[] {
  const files = new Set<string>()
  for (const pattern of patterns) {
    for (const file of new Glob(pattern).scanSync({ cwd: PROJECT_ROOT })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

const features = [...resolveBuildFeatures()].sort()
const featureArgs = features.flatMap(name => ['--feature', name])
console.log(
  `──── shipped features (${features.length}, from scripts/defines.ts): ${features.join(' ')}`,
)

mkdirSync(join(PROJECT_ROOT, REPORT_DIR), { recursive: true })
const failed: string[] = []
for (const group of GROUPS) {
  const files = filesFor(group.patterns)
  if (files.length === 0) {
    console.log(
      `::error title=Shipped-feature tests::${group.name} matched no test files (${group.patterns.join(', ')})`,
    )
    failed.push(group.name)
    continue
  }
  console.log(`──── ${group.name}: ${files.length} file(s)`)
  const proc = Bun.spawnSync(
    [
      process.execPath,
      'test',
      ...featureArgs,
      '--reporter=junit',
      '--reporter-outfile',
      join(REPORT_DIR, `shipped-features-${group.name}.xml`),
      ...files.map(file => `./${file}`),
    ],
    { cwd: PROJECT_ROOT, stdout: 'inherit', stderr: 'inherit' },
  )
  if (proc.exitCode !== 0) {
    console.log(`::error title=Shipped-feature tests failed::${group.name}`)
    failed.push(group.name)
  }
}

if (failed.length > 0) {
  console.log(
    `──── ${failed.length} of ${GROUPS.length} shipped-feature groups failed: ${failed.join(' ')}`,
  )
  process.exit(1)
}
console.log(`──── all ${GROUPS.length} shipped-feature groups passed`)
