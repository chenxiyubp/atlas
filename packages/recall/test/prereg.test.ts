// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The preregistration file: its shape rules, and that the committed plans
 * are the ones ruled on 2026-09-27 — 1 460 comparison calls, 202 trial calls,
 * the answer layer asking 40 positives + 61 negatives per synthetic tier.
 */

import { describe, expect, test } from 'bun:test'
import { answerPlanOf } from '../eval/answer/runner.js'
import { CORPORA } from '../eval/corpora.js'
import {
  loadPreregistration,
  parsePreregistration,
  type RunPlan,
} from '../eval/prereg.js'

const PLAN_LINES = [
  'arms = ["m0", "m1"]',
  'repetitions = 1',
  'providers = ["a", "b"]',
  'seed = 20260926',
  'synthetic_v1_tiers = [30]',
  'docs_dev_v1_tiers = []',
  'primary_corpus = "synthetic-v1"',
]

function calls(plan: RunPlan): number {
  const run = answerPlanOf(plan, {
    runId: 'count',
    phase: 'trial',
    concurrency: 1,
  })
  return (
    run.corpora.reduce((sum, { id, tiers }) => {
      const corpus = CORPORA[id]
      const asked = new Set(corpus.answerKinds)
      return (
        sum +
        tiers.reduce(
          (inner, tier) =>
            inner +
            corpus.build(tier, plan.seed).queries.filter(q => asked.has(q.kind))
              .length,
          0,
        )
      )
    }, 0) *
    plan.arms.length *
    plan.providers.length *
    plan.repetitions
  )
}

describe('shape', () => {
  test('absent keys are "not generated"; a plan is all or nothing', () => {
    const empty = parsePreregistration('')
    expect(empty.plan).toBeNull()
    expect(empty.answer.bootstrapSeed).toBeNull()
    expect(() =>
      parsePreregistration(['[plan]', ...PLAN_LINES.slice(1)].join('\n')),
    ).toThrow(/\[plan\] is missing arms/)
    expect(() =>
      parsePreregistration(['[plan]', ...PLAN_LINES, 'extra = 1'].join('\n')),
    ).toThrow(/unknown key plan.extra/)
    expect(() =>
      parsePreregistration(
        ['[plan]', 'arms = ["m1"]', ...PLAN_LINES.slice(1)].join('\n'),
      ),
    ).toThrow(/arms must be/)
    expect(() =>
      parsePreregistration(
        [
          '[trial]',
          ...PLAN_LINES.slice(0, 2),
          'providers = ["a", "a"]',
          ...PLAN_LINES.slice(3),
        ].join('\n'),
      ),
    ).toThrow(/distinct provider ids/)
  })
})

describe('the committed file', () => {
  const prereg = loadPreregistration()

  test('the answer layer asks 40 positives and 61 negatives per synthetic tier', () => {
    const corpus = CORPORA['synthetic-v1']
    const asked = new Set(corpus.answerKinds)
    for (const tier of corpus.tiers) {
      const queries = corpus
        .build(tier, corpus.seeds[0] ?? 0)
        .queries.filter(q => asked.has(q.kind))
      expect(queries.length).toBe(101)
      expect(queries.filter(q => q.kind.startsWith('positive-')).length).toBe(
        40,
      )
      expect(queries.some(q => q.kind.endsWith('-batch'))).toBe(false)
    }
  })

  test('the comparison plan is the ruled one: 1 460 calls', () => {
    const plan = prereg.plan
    if (plan === null) throw new Error('[plan] missing')
    expect(plan).toEqual({
      arms: ['m0', 'm1'],
      repetitions: 1,
      providers: ['qianmo-deepseek', 'qianmo-alt'],
      seed: 20260926,
      tiers: { 'synthetic-v1': [30, 500, 2000], 'docs-dev-v1': [599] },
      primaryCorpus: 'synthetic-v1',
    })
    expect(calls(plan)).toBe(1460)
  })

  test('the trial default is the ruled one: 202 calls', () => {
    const trial = prereg.trial
    if (trial === null) throw new Error('[trial] missing')
    expect(trial.arms).toEqual(['m0'])
    expect(trial.tiers).toEqual({ 'synthetic-v1': [30], 'docs-dev-v1': [] })
    expect(calls(trial)).toBe(202)
  })
})
