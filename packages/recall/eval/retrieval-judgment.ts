// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retrieval-layer verdict of D-1 R2–R5 (`docs/dev/memory-m1.md` §9),
 * on the held-out set.
 *
 * R5 is the reason this is a separate function from the gates in
 * `retrieval-gates.ts`: those take any questions, this one takes only the
 * held-out set, checked against its preregistered hash, and so cannot be
 * pointed at the development questions that hyperparameters were tuned on.
 *
 *   R2   no regression: on every ranked tier (500, 2000) and seed, every
 *        held-out question whose gold M0 injected is still injected by M1.
 *   R3   primary endpoint ①: at 2000, the exact one-sided sign test of M1
 *        against M0, p < α on every seed, each seed tested on its own;
 *        counted per question or per gold decision as preregistered
 *        (`retrieval.sign_test_unit`; per gold, a gold's paired difference
 *        is the mean over its questions — see `signGate`).
 *   R4   query-shuffle control: the same test of M1 against the same fusion
 *        fed the query of π(q) = derangement(held-out ids, shuffle_seed).
 *
 * Every seed of the corpus is judged; there is no option to pick seeds. A
 * missing or mismatched preregistered value, or a set with problems, makes
 * the verdict `not-evaluable` with the reason — never a default.
 */

import {
  buildHardenedDataset,
  HARDENED_SEEDS,
  hardenedSourceId,
} from './hardened.js'
import {
  HELDOUT_KIND,
  type HeldoutSet,
  heldoutDigest,
  heldoutProblems,
  heldoutQueries,
} from './heldout.js'
import type { Preregistration } from './prereg.js'
import {
  type ArmSet,
  derangement,
  noRegression,
  type PairedCell,
  pairCells,
  signGate,
} from './retrieval-gates.js'
import { type BaselineDataset, type Materialised, materialise } from './run.js'

/** §9 D-1: R2 covers the ranked tiers; R3 and R4 are judged at 2000. */
const RANKED_TIERS: readonly number[] = [500, 2000]
const ENDPOINT_TIER = 2000

/**
 * The M1 arm (and its shuffled control) for one materialised dataset. P16.6
 * supplies the real one; the tests use the reference fusion.
 */
export type HeldoutArms = (
  materialised: Materialised,
  dataset: BaselineDataset,
  permutation: ReadonlyMap<string, string>,
) => ArmSet

type Verdict<T> = { readonly pass: boolean } & T

export type RetrievalJudgment = {
  readonly status: 'judged' | 'not-evaluable'
  readonly reason: string | null
  readonly heldout: {
    readonly questions: number
    readonly sha256: string | null
    readonly preregistered: string | null
  }
  readonly R2: Verdict<{
    readonly failures: ReturnType<typeof noRegression>
  }> | null
  readonly R3: Verdict<{ readonly perSeed: ReturnType<typeof signGate> }> | null
  readonly R4: Verdict<{ readonly perSeed: ReturnType<typeof signGate> }> | null
}

/**
 * Paired cells of the held-out questions under the given seeds and tiers:
 * M0 against M1 (`real`) and the shuffled control against M1 (`shuffled`).
 */
export function heldoutCells(
  set: HeldoutSet,
  arms: HeldoutArms,
  options: {
    readonly seeds: readonly number[]
    readonly tiers: readonly number[]
    readonly shuffleSeed: number
  },
): { real: PairedCell[]; shuffled: PairedCell[] } {
  const queries = heldoutQueries(set)
  const permutation = derangement(
    queries.map(q => q.id),
    options.shuffleSeed,
  )
  const real: PairedCell[] = []
  const shuffled: PairedCell[] = []
  for (const seed of options.seeds) {
    for (const tier of options.tiers) {
      const dataset: BaselineDataset = {
        ...buildHardenedDataset(tier, seed),
        queries,
      }
      const materialised = materialise(dataset, {
        sourceIdOf: hardenedSourceId,
      })
      try {
        const set = arms(materialised, dataset, permutation)
        real.push(...pairCells(dataset, set.m0, set.m1))
        shuffled.push(...pairCells(dataset, set.shuffledM1, set.m1))
      } finally {
        materialised.dispose()
      }
    }
  }
  return { real, shuffled }
}

function refuse(
  reason: string,
  heldout: RetrievalJudgment['heldout'],
): RetrievalJudgment {
  return {
    status: 'not-evaluable',
    reason,
    heldout,
    R2: null,
    R3: null,
    R4: null,
  }
}

/** R2–R4 on the held-out set, or why they cannot be judged yet. */
export function judgeRetrieval(options: {
  readonly prereg: Preregistration
  readonly heldout: HeldoutSet | null
  readonly arms: HeldoutArms
}): RetrievalJudgment {
  const { prereg, heldout } = options
  const preregistered = prereg.corpus.heldoutIdsSha256
  const summary = {
    questions: heldout?.questions.length ?? 0,
    sha256: heldout === null ? null : heldoutDigest(heldout),
    preregistered,
  }
  if (heldout === null) {
    return refuse('held-out set not delivered', summary)
  }
  if (preregistered === null) {
    return refuse(
      'preregistration: corpus.heldout_ids_sha256 not generated',
      summary,
    )
  }
  if (summary.sha256 !== preregistered) {
    return refuse(
      'held-out set differs from its preregistered id-list hash',
      summary,
    )
  }
  const problems = heldoutProblems(heldout)
  if (problems.length > 0) {
    return refuse(`held-out set has problems: ${problems.join('; ')}`, summary)
  }
  const alpha = prereg.retrieval.alphaPrimary
  const shuffleSeed = prereg.corpus.shuffleSeed
  const unit = prereg.retrieval.signTestUnit
  if (unit === null) {
    return refuse(
      'preregistration: retrieval.sign_test_unit not generated',
      summary,
    )
  }
  if (alpha === null) {
    return refuse(
      'preregistration: retrieval.alpha_primary not generated',
      summary,
    )
  }
  if (shuffleSeed === null) {
    return refuse('preregistration: corpus.shuffle_seed not generated', summary)
  }
  const cells = heldoutCells(heldout, options.arms, {
    seeds: HARDENED_SEEDS,
    tiers: RANKED_TIERS,
    shuffleSeed,
  })
  const ids = new Set(heldout.questions.map(q => q.id))
  const goldOf = new Map(heldout.questions.map(q => [q.id, q.gold]))
  const gate = {
    tier: ENDPOINT_TIER,
    queryIds: ids,
    alpha,
    ...(unit === 'gold'
      ? { clusterOf: (id: string) => goldOf.get(id) ?? id }
      : {}),
  }
  const failures = noRegression(
    cells.real.filter(c => c.kind === HELDOUT_KIND),
    { tiers: RANKED_TIERS },
  )
  const r3 = signGate(cells.real, gate)
  const r4 = signGate(cells.shuffled, gate)
  return {
    status: 'judged',
    reason: null,
    heldout: summary,
    R2: { pass: failures.length === 0, failures },
    R3: { pass: r3.length > 0 && r3.every(v => v.pass), perSeed: r3 },
    R4: { pass: r4.length > 0 && r4.every(v => v.pass), perSeed: r4 },
  }
}
