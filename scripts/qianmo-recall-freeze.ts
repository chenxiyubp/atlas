#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Freeze the preregistration of `docs/dev/memory-m1.md` §9: recompute every
 * value that can be computed, and write the ones still empty into
 * `packages/recall/eval/prereg.toml`.
 *
 *   synthetic_v1_sha256 / docs_dev_v1_sha256   the corpus hashes
 *   m0_baseline_sha256    SHA-256 of `qianmo:recall-baseline --corpus
 *                         synthetic-v1 --decay default,off --json`
 *   heldout_ids_sha256    once the held-out set is delivered and clean
 *   bootstrap_seed, e1_inference, shuffle_seed
 *                         the values ruled on 2026-09-27 (item 9)
 *   sign_test_unit        ruled "gold" on 2026-09-27, but written only
 *                         together with heldout_ids_sha256, so that both
 *                         land in the same freeze commit
 *
 * A value already in the file is never overwritten. If recomputing it gives
 * something else — the corpus or the baseline changed after the freeze —
 * that is reported and the exit code is 1. So the same command is the R0
 * check of a later run: `--check` verifies and never writes.
 *
 * Usage:
 *   bun run scripts/qianmo-recall-freeze.ts           # fill empty keys, verify set ones
 *   bun run scripts/qianmo-recall-freeze.ts --check   # verify only
 *
 * Exit codes: 0 every set value agrees (a held-out hash still to come is
 * listed as pending), 1 a set value disagrees, the held-out set has
 * problems, or — under `--check` — a computable key is still empty; 2 usage.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { CORPORA } from '../packages/recall/eval/corpora.js'
import {
  corpusBaselineJson,
  runCorpusBaseline,
} from '../packages/recall/eval/corpus-baseline.js'
import {
  heldoutDigest,
  heldoutProblems,
  loadHeldout,
} from '../packages/recall/eval/heldout.js'
import {
  PREREGISTRATION_PATH,
  parsePreregistration,
  type Preregistration,
} from '../packages/recall/eval/prereg.js'

type Section = 'retrieval' | 'answer' | 'corpus'

type FrozenValue = {
  readonly section: Section
  readonly key: string
  /** `null`: cannot be computed yet (the held-out set is not delivered). */
  readonly value: string | number | null
}

/** Ruling of 2026-09-27 (m1-design-rulings.md, P16.3 item 9). */
const RULED: readonly FrozenValue[] = [
  { section: 'answer', key: 'bootstrap_seed', value: 20260927 },
  { section: 'answer', key: 'e1_inference', value: 'signflip' },
  { section: 'corpus', key: 'shuffle_seed', value: 20261003 },
]

/**
 * Ruled on 2026-09-27 (after the P16.3 follow-up report, item 1), frozen in
 * the same commit as the held-out hash: pending until that hash is known.
 */
const RULED_WITH_HELDOUT: readonly FrozenValue[] = [
  { section: 'retrieval', key: 'sign_test_unit', value: 'gold' },
]

function current(prereg: Preregistration, key: string): string | number | null {
  const table: Readonly<Record<string, string | number | null>> = {
    sign_test_unit: prereg.retrieval.signTestUnit,
    bootstrap_seed: prereg.answer.bootstrapSeed,
    e1_inference: prereg.answer.e1Inference,
    shuffle_seed: prereg.corpus.shuffleSeed,
    synthetic_v1_sha256: prereg.corpus.syntheticV1Sha256,
    docs_dev_v1_sha256: prereg.corpus.docsDevV1Sha256,
    m0_baseline_sha256: prereg.corpus.m0BaselineSha256,
    heldout_ids_sha256: prereg.corpus.heldoutIdsSha256,
  }
  const value = table[key]
  if (value === undefined) throw new Error(`freeze: unknown key ${key}`)
  return value
}

type FreezeOutcome = {
  readonly text: string
  readonly filled: readonly string[]
  readonly agreed: readonly string[]
  readonly pending: readonly string[]
  readonly conflicts: readonly string[]
}

/**
 * Apply computed values to the file's text. Pure: fills a key only where the
 * file has its `# key =` placeholder in the right section; never rewrites a
 * key that is set.
 */
export function applyFreeze(
  text: string,
  values: readonly FrozenValue[],
): FreezeOutcome {
  const prereg = parsePreregistration(text)
  const lines = text.split('\n')
  const filled: string[] = []
  const agreed: string[] = []
  const pending: string[] = []
  const conflicts: string[] = []
  for (const { section, key, value } of values) {
    const existing = current(prereg, key)
    if (existing !== null) {
      if (value === null || existing === value) agreed.push(key)
      else conflicts.push(`${key}: file has ${existing}, recomputed ${value}`)
      continue
    }
    if (value === null) {
      pending.push(key)
      continue
    }
    let inSection = false
    let at = -1
    for (const [index, line] of lines.entries()) {
      const header = /^\[([^\]]+)\]\s*$/.exec(line)
      if (header !== null) inSection = header[1] === section
      else if (inSection && new RegExp(`^#\\s*${key}\\s*=\\s*$`).test(line)) {
        at = index
      }
    }
    if (at === -1) {
      conflicts.push(`${key}: no "# ${key} =" placeholder in [${section}]`)
      continue
    }
    lines[at] =
      `${key} = ${typeof value === 'number' ? value : JSON.stringify(value)}`
    filled.push(key)
  }
  const next = lines.join('\n')
  parsePreregistration(next)
  return { text: next, filled, agreed, pending, conflicts }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Every value the freeze writes, given the hashes it recomputed. */
export function frozenValues(computed: {
  readonly syntheticV1: string
  readonly docsDevV1: string
  readonly m0Baseline: string
  /** `null` until the held-out set is delivered and has no problems. */
  readonly heldout: string | null
}): FrozenValue[] {
  return [
    ...RULED,
    ...RULED_WITH_HELDOUT.map(ruled => ({
      ...ruled,
      value: computed.heldout === null ? null : ruled.value,
    })),
    {
      section: 'corpus',
      key: 'synthetic_v1_sha256',
      value: computed.syntheticV1,
    },
    { section: 'corpus', key: 'docs_dev_v1_sha256', value: computed.docsDevV1 },
    {
      section: 'corpus',
      key: 'm0_baseline_sha256',
      value: computed.m0Baseline,
    },
    { section: 'corpus', key: 'heldout_ids_sha256', value: computed.heldout },
  ]
}

/** Everything the freeze recomputes. The M0 baseline takes a few minutes. */
function computedValues(): { values: FrozenValue[]; problems: string[] } {
  const baseline = runCorpusBaseline('synthetic-v1', {
    decay: ['default', 'off'],
  })
  const heldout = loadHeldout()
  const problems = heldout === null ? [] : heldoutProblems(heldout)
  return {
    values: frozenValues({
      syntheticV1: CORPORA['synthetic-v1'].digest(),
      docsDevV1: CORPORA['docs-dev-v1'].digest(),
      m0Baseline: sha256(corpusBaselineJson(baseline)),
      heldout:
        heldout === null || problems.length > 0 ? null : heldoutDigest(heldout),
    }),
    problems,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--check')) {
    console.error('usage: bun run scripts/qianmo-recall-freeze.ts [--check]')
    process.exit(2)
  }
  const check = args.includes('--check')
  const started = performance.now()
  const { values, problems } = computedValues()
  const outcome = applyFreeze(
    readFileSync(PREREGISTRATION_PATH, 'utf8'),
    values,
  )
  for (const value of values) {
    console.log(`computed ${value.key} = ${value.value ?? '(not yet)'}`)
  }
  for (const problem of problems) {
    console.log(`held-out problem: ${problem}`)
  }
  console.log(`agreed: ${outcome.agreed.join(', ') || '-'}`)
  console.log(
    `${check ? 'would fill' : 'filled'}: ${outcome.filled.join(', ') || '-'}`,
  )
  console.log(`pending: ${outcome.pending.join(', ') || '-'}`)
  for (const conflict of outcome.conflicts) {
    console.log(`CONFLICT ${conflict}`)
  }
  if (!check && outcome.filled.length > 0 && outcome.conflicts.length === 0) {
    writeFileSync(PREREGISTRATION_PATH, outcome.text)
    console.log(`wrote ${PREREGISTRATION_PATH}`)
  }
  console.error(
    `[freeze] done in ${Math.round(performance.now() - started)} ms`,
  )
  // Under --check a key that could be filled means the file is not frozen.
  const unfrozen = check && outcome.filled.length > 0
  process.exit(
    outcome.conflicts.length > 0 || problems.length > 0 || unfrozen ? 1 : 0,
  )
}
