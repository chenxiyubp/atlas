#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Check a held-out paraphrase set (`packages/recall/eval/heldout.ts`) and
 * print the hash that gets preregistered.
 *
 * Meant for the set's author as much as for the freeze: it says, per
 * question, which ranking tokens it still shares with its gold decision — by
 * the corpus's own tokeniser and scorer — and whether the set has the right
 * shape. It prints nothing about how entries are ranked beyond that.
 *
 * Usage:
 *   bun run scripts/qianmo-recall-heldout-check.ts <file.heldout.toml>
 *
 * Exit codes: 0 the set is usable, 1 it has problems (listed), 2 the file
 * cannot be read as a held-out set.
 */

import { readFileSync } from 'node:fs'
import {
  HELDOUT_PER_GOLD,
  goldDecisions,
  heldoutDigest,
  heldoutProblems,
  overlapWithGold,
  parseHeldout,
} from '../packages/recall/eval/heldout.js'

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined || process.argv.length > 3) {
    console.error(
      'usage: bun run scripts/qianmo-recall-heldout-check.ts <file.heldout.toml>',
    )
    process.exit(2)
  }
  let set: ReturnType<typeof parseHeldout>
  try {
    set = parseHeldout(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(
      `[heldout-check] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(2)
  }
  const overlap = overlapWithGold(set.questions)
  for (const [index, q] of set.questions.entries()) {
    const matched = overlap[index] ?? null
    console.log(
      matched === null
        ? `FAIL ${q.id} → ${q.gold}  not one of the gold decisions`
        : `${matched.length === 0 ? 'ok  ' : 'FAIL'} ${q.id} → ${q.gold}` +
            (matched.length === 0 ? '' : `  shared: ${matched.join(' ')}`),
    )
  }
  const counts = goldDecisions().map(
    d => `${d.id}=${set.questions.filter(q => q.gold === d.id).length}`,
  )
  console.log(
    `per decision (expected ${HELDOUT_PER_GOLD}): ${counts.join(' ')}`,
  )
  const problems = heldoutProblems(set)
  for (const problem of problems) console.log(`problem: ${problem}`)
  console.log(`questions: ${set.questions.length}`)
  console.log(`heldout_ids_sha256 = ${heldoutDigest(set)}`)
  process.exit(problems.length === 0 ? 0 : 1)
}
