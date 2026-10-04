// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The preregistered values of `docs/dev/memory-m1.md` §9, read from
 * `prereg.toml` next to this file.
 *
 * Two properties are the point of this module:
 *
 *   1. **No defaults.** A key that is not in the file is `null`, and a gate
 *      that needs it throws {@link PreregistrationMissing}. A threshold that
 *      silently fell back to a value in code would be a threshold chosen by
 *      whoever last edited the code, which is exactly what preregistration
 *      exists to prevent.
 *   2. **No overrides.** The command-line tools read the file at its fixed
 *      path and take no flag that changes a value. Tests use
 *      {@link parsePreregistration} on their own text.
 *
 * Unknown keys are rejected rather than ignored: a misspelt key would
 * otherwise read as "not generated" and the value next to it would never be
 * used.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PREREGISTRATION_PATH = fileURLToPath(
  new URL('./prereg.toml', import.meta.url),
)

type E1Inference = 'bootstrap' | 'signflip'

/**
 * A run plan of the answer layer: which corpus tiers, arms and providers,
 * and how many calls per question per provider. Corpus ids and tiers are
 * checked against the corpora by the executor; this module checks shapes.
 */
export type RunPlan = {
  readonly arms: readonly ('m0' | 'm1')[]
  readonly repetitions: number
  readonly providers: readonly string[]
  /** The corpus seed the answer layer runs under. */
  readonly seed: number
  /** Tiers per corpus; a corpus with no tiers is not in the plan. */
  readonly tiers: Readonly<
    Record<'synthetic-v1' | 'docs-dev-v1', readonly number[]>
  >
  /** The corpus E1, E2, A0 and A4 are judged on. */
  readonly primaryCorpus: 'synthetic-v1' | 'docs-dev-v1'
}

export type Preregistration = {
  readonly retrieval: {
    readonly alphaPrimary: number | null
    /** R3 / R4 sign-test unit on the held-out set: each question, or each gold. */
    readonly signTestUnit: 'question' | 'gold' | null
  }
  readonly answer: {
    readonly alphaPrimary: number | null
    readonly noninferiorityDelta: number | null
    readonly aaAlpha: number | null
    readonly bootstrapIterations: number | null
    readonly bootstrapSeed: number | null
    readonly e1Inference: E1Inference | null
  }
  readonly corpus: {
    readonly syntheticV1Sha256: string | null
    readonly docsDevV1Sha256: string | null
    readonly heldoutIdsSha256: string | null
    readonly shuffleSeed: number | null
    readonly m0BaselineSha256: string | null
  }
  /** P16.12's comparison: the only plan the executor accepts for it. */
  readonly plan: RunPlan | null
  /** P16.4's trial default. Not a judgment value; the trial may be narrowed. */
  readonly trial: RunPlan | null
}

/** A gate needed a value the preregistration does not (yet) hold. */
class PreregistrationMissing extends Error {
  constructor(readonly key: string) {
    super(
      `preregistration: ${key} is not generated yet (docs/dev/memory-m1.md §9); ` +
        'refusing to judge without it',
    )
    this.name = 'PreregistrationMissing'
  }
}

/** The value, or a {@link PreregistrationMissing} naming its key. */
export function required<T>(value: T | null, key: string): T {
  if (value === null) throw new PreregistrationMissing(key)
  return value
}

type Table = Readonly<Record<string, unknown>>

const PLAN_KEYS = [
  'arms',
  'repetitions',
  'providers',
  'seed',
  'synthetic_v1_tiers',
  'docs_dev_v1_tiers',
  'primary_corpus',
] as const

const SECTIONS: Readonly<Record<string, readonly string[]>> = {
  retrieval: ['alpha_primary', 'sign_test_unit'],
  answer: [
    'alpha_primary',
    'noninferiority_delta',
    'aa_alpha',
    'bootstrap_iterations',
    'bootstrap_seed',
    'e1_inference',
  ],
  corpus: [
    'synthetic_v1_sha256',
    'docs_dev_v1_sha256',
    'heldout_ids_sha256',
    'shuffle_seed',
    'm0_baseline_sha256',
  ],
  plan: PLAN_KEYS,
  trial: PLAN_KEYS,
}

function tableOf(root: Table, name: string): Table {
  const value = root[name]
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`preregistration: [${name}] must be a table`)
  }
  const table = value as Table
  for (const key of Object.keys(table)) {
    if (!(SECTIONS[name] ?? []).includes(key)) {
      throw new Error(`preregistration: unknown key ${name}.${key}`)
    }
  }
  return table
}

function probability(table: Table, section: string, key: string) {
  const value = table[key]
  if (value === undefined) return null
  if (typeof value !== 'number' || !(value > 0 && value < 1)) {
    throw new Error(`preregistration: ${section}.${key} must be in (0, 1)`)
  }
  return value
}

function integer(table: Table, section: string, key: string, min: number) {
  const value = table[key]
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(
      `preregistration: ${section}.${key} must be an integer ≥ ${min}`,
    )
  }
  return value
}

function sha256(table: Table, section: string, key: string) {
  const value = table[key]
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`preregistration: ${section}.${key} must be a SHA-256 hex`)
  }
  return value
}

function signTestUnitOf(value: unknown): 'question' | 'gold' | null {
  if (value === undefined) return null
  if (value !== 'question' && value !== 'gold') {
    throw new Error(
      'preregistration: retrieval.sign_test_unit must be "question" or "gold"',
    )
  }
  return value
}

function integerList(table: Table, section: string, key: string): number[] {
  const value = table[key]
  if (
    !Array.isArray(value) ||
    value.some(item => typeof item !== 'number' || !Number.isInteger(item))
  ) {
    throw new Error(
      `preregistration: ${section}.${key} must be a list of integers`,
    )
  }
  return value as number[]
}

/** A plan table: absent means not generated; present means every key. */
function planOf(table: Table, section: string): RunPlan | null {
  if (Object.keys(table).length === 0) return null
  for (const key of PLAN_KEYS) {
    if (table[key] === undefined) {
      throw new Error(`preregistration: [${section}] is missing ${key}`)
    }
  }
  const arms = table['arms']
  if (
    !Array.isArray(arms) ||
    !(
      (arms.length === 1 && arms[0] === 'm0') ||
      (arms.length === 2 && arms[0] === 'm0' && arms[1] === 'm1')
    )
  ) {
    throw new Error(
      `preregistration: ${section}.arms must be ["m0"] or ["m0", "m1"]`,
    )
  }
  const providers = table['providers']
  if (
    !Array.isArray(providers) ||
    providers.length === 0 ||
    providers.some(p => typeof p !== 'string' || p.length === 0) ||
    new Set(providers).size !== providers.length
  ) {
    throw new Error(
      `preregistration: ${section}.providers must be distinct provider ids`,
    )
  }
  const primary = table['primary_corpus']
  if (primary !== 'synthetic-v1' && primary !== 'docs-dev-v1') {
    throw new Error(
      `preregistration: ${section}.primary_corpus must be "synthetic-v1" or "docs-dev-v1"`,
    )
  }
  return {
    arms: arms as ('m0' | 'm1')[],
    repetitions: integer(table, section, 'repetitions', 1) ?? 1,
    providers: providers as string[],
    seed: integer(table, section, 'seed', 0) ?? 0,
    tiers: {
      'synthetic-v1': integerList(table, section, 'synthetic_v1_tiers'),
      'docs-dev-v1': integerList(table, section, 'docs_dev_v1_tiers'),
    },
    primaryCorpus: primary,
  }
}

/** Parse and validate preregistration TOML. */
export function parsePreregistration(text: string): Preregistration {
  const root = Bun.TOML.parse(text) as Table
  for (const key of Object.keys(root)) {
    if (!(key in SECTIONS)) {
      throw new Error(`preregistration: unknown section [${key}]`)
    }
  }
  const retrieval = tableOf(root, 'retrieval')
  const answer = tableOf(root, 'answer')
  const corpus = tableOf(root, 'corpus')
  const inference = answer['e1_inference']
  if (
    inference !== undefined &&
    inference !== 'bootstrap' &&
    inference !== 'signflip'
  ) {
    throw new Error(
      'preregistration: answer.e1_inference must be "bootstrap" or "signflip"',
    )
  }
  return {
    retrieval: {
      alphaPrimary: probability(retrieval, 'retrieval', 'alpha_primary'),
      signTestUnit: signTestUnitOf(retrieval['sign_test_unit']),
    },
    answer: {
      alphaPrimary: probability(answer, 'answer', 'alpha_primary'),
      noninferiorityDelta: probability(
        answer,
        'answer',
        'noninferiority_delta',
      ),
      aaAlpha: probability(answer, 'answer', 'aa_alpha'),
      bootstrapIterations: integer(answer, 'answer', 'bootstrap_iterations', 1),
      bootstrapSeed: integer(answer, 'answer', 'bootstrap_seed', 0),
      e1Inference: inference ?? null,
    },
    corpus: {
      syntheticV1Sha256: sha256(corpus, 'corpus', 'synthetic_v1_sha256'),
      docsDevV1Sha256: sha256(corpus, 'corpus', 'docs_dev_v1_sha256'),
      heldoutIdsSha256: sha256(corpus, 'corpus', 'heldout_ids_sha256'),
      shuffleSeed: integer(corpus, 'corpus', 'shuffle_seed', 0),
      m0BaselineSha256: sha256(corpus, 'corpus', 'm0_baseline_sha256'),
    },
    plan: planOf(tableOf(root, 'plan'), 'plan'),
    trial: planOf(tableOf(root, 'trial'), 'trial'),
  }
}

/** The checked-in preregistration. */
export function loadPreregistration(): Preregistration {
  return parsePreregistration(readFileSync(PREREGISTRATION_PATH, 'utf8'))
}
