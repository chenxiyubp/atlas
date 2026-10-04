// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hardened synthetic corpus, `synthetic-v1` (`docs/dev/memory-m1.md`
 * §2.4, work package P16.2b).
 *
 * WHAT CHANGED FROM v0.1, AND WHY EACH ONE
 *
 * The v0.1 corpus let a ranker that never reads the question pass the v0.1
 * retrieval criteria: gold entries were the only hand-written decisions in
 * scope, the filler came out of one template, so "is this entry unusual?"
 * was enough to find gold. Every change below removes one such signal or
 * fills one gap the review listed:
 *
 *   - six hand-written siblings per gold decision (`hardened-data.ts`), so
 *     decision-shaped entries number 141, far more than the 25 free slots
 *     of the §5.1 fusion;
 *   - filler phrased eight ways in title and summary, with a larger reason
 *     pool and an optional second sentence, tagged from the decision
 *     families' own tag vocabulary;
 *   - opaque `source.id`s: v0.1 wrote `eval-<key>`, so `eval-filler-0001`
 *     sat in the rendered block next to `eval-runtime` — a label, printed;
 *   - batch-shaped variants of every positive question, rendered the way the
 *     resident renders a mailbox batch;
 *   - a working-layer `(agent, context)` twin case, the partition the
 *     resident actually recalls from;
 *   - 30 fabricated and 20 "related but unsupported" questions per tier;
 *   - five fixed seeds.
 *
 * The v0.1 corpus is untouched (`dataset.ts`); its questions, gold texts and
 * retired / other-scope entries are reused through `fixedEntries` and
 * `fixedQueries`, so a v0.1 question means the same thing here.
 *
 * NOT HERE
 *
 * The held-out paraphrase set (§2.4 item 2) must be written by someone other
 * than the implementer, so this module does not contain one. The retrieval
 * gates (`retrieval-gates.ts`) take it as an input and report R3 / R5 as not
 * evaluable while it is missing.
 */

import { createHash } from 'node:crypto'
import type { MemoryScope } from '@qianmo/memory'
import type { RecallScope } from '../src/recall.js'
import {
  ageFrom,
  DECISIONS,
  EVAL_AS_OF,
  EVAL_SCOPE,
  FILLER_REASONS,
  FILLER_SETTINGS,
  FILLER_SUBJECTS,
  fillerCombinations,
  fixedEntries,
  fixedQueries,
  mulberry32,
  shuffled,
  TARGET_PROJECT,
} from './dataset.js'
import {
  BATCH_CHATTER,
  BATCH_LAYOUTS,
  CONTEXT_A_SEGMENT,
  CONTEXT_B_SEGMENT,
  CONTEXT_ENTRIES,
  CONTEXT_QUERIES,
  FILLER_FOLLOW_UPS,
  FILLER_SUMMARY_FORMS,
  FILLER_TAG_BY_SUBJECT,
  FILLER_TITLE_FORMS,
  MORE_FABRICATED,
  MORE_FILLER_REASONS,
  MUST_MENTION_ANY,
  RESIDENT_AGENT_SEGMENT,
  SIBLINGS,
  UNSUPPORTED,
} from './hardened-data.js'
import type { BaselineEntry, BaselineQuery } from './run.js'

export const HARDENED_CORPUS_ID = 'synthetic-v1'

/**
 * Five fixed seeds (§2.4 item 5): the v0.1 seed and the four integers after
 * it. Consecutive rather than chosen, and fixed before any measurement on
 * this corpus, so nothing about them was picked for a result.
 */
export const HARDENED_SEEDS: readonly number[] = [
  20260926, 20260927, 20260928, 20260929, 20260930,
]

export const HARDENED_TIERS: readonly number[] = [30, 500, 2000]

export const HARDENED_KINDS = [
  'positive-lexical',
  'positive-mismatch',
  'positive-lexical-batch',
  'positive-mismatch-batch',
  'negative-fabricated',
  'negative-unsupported',
  'negative-retired',
  'negative-cross-scope',
  'negative-cross-context',
] as const

type HardenedQueryKind = (typeof HARDENED_KINDS)[number]

/** The plain positives: the pooled row, and the v0.1-comparable one. */
export const HARDENED_POOLED_KINDS: readonly HardenedQueryKind[] = [
  'positive-lexical',
  'positive-mismatch',
]

/**
 * The answer layer's question set: §2.2's P is the 40 plain positives, and
 * the batch variants stay in the retrieval layer (ruling of 2026-09-27, item
 * 2). 40 positives + 61 negatives = 101 questions per tier.
 */
export const HARDENED_ANSWER_KINDS: readonly HardenedQueryKind[] =
  HARDENED_KINDS.filter(kind => !kind.endsWith('-batch'))

type HardenedEntryRole =
  | 'gold'
  | 'sibling'
  | 'filler'
  | 'retired'
  | 'distractor'
  | 'context'

export type HardenedEntry = BaselineEntry & {
  readonly role: HardenedEntryRole
}

export type HardenedQuery = BaselineQuery & {
  readonly kind: HardenedQueryKind
  /**
   * The answer-layer `mustMention`, one inner list per requirement, any
   * spelling of which satisfies it.
   */
  readonly mustMentionAny: readonly (readonly string[])[]
  /**
   * Entries it is acceptable to cite beyond gold: `S(q) = gold ∪ acceptable`
   * (§2.2). Frozen with the corpus, so it is fixed before any model call.
   */
  readonly acceptable: readonly string[]
  /** The individual messages of a batch-shaped question, in order. */
  readonly messages?: readonly string[]
}

export type HardenedDataset = {
  readonly corpus: typeof HARDENED_CORPUS_ID
  readonly seed: number
  readonly liveInScope: number
  readonly asOf: Date
  readonly scope: RecallScope
  readonly entries: readonly HardenedEntry[]
  readonly queries: readonly HardenedQuery[]
}

/** Gold decisions plus `ndjson`: live in scope in every tier. */
const GOLD_IN_SCOPE = DECISIONS.length + 1

const SIBLING_COUNT = Object.values(SIBLINGS).reduce(
  (total, family) => total + family.length,
  0,
)

/** Hand-written, decision-shaped, live, in scope — gold and siblings. */
export const DECISION_ENTRY_COUNT = GOLD_IN_SCOPE + SIBLING_COUNT

const HARDENED_MAX_LIVE_IN_SCOPE =
  DECISION_ENTRY_COUNT + fillerCombinations().length

/** The resident's recall scope for context A of the twin case. */
export const CONTEXT_A_SCOPE: RecallScope = {
  layers: ['working'],
  projectKey: RESIDENT_AGENT_SEGMENT,
  taskId: CONTEXT_A_SEGMENT,
}

const projectScope = (): MemoryScope => ({
  layer: 'project',
  projectKey: TARGET_PROJECT,
})

const ALL_REASONS: readonly string[] = [
  ...FILLER_REASONS,
  ...MORE_FILLER_REASONS,
]

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)]
  if (item === undefined) throw new Error('hardened: empty pick list')
  return item
}

/**
 * One mailbox batch, rendered the way `formatTeammateMessages`
 * (`src/utils/agents/teammateMailbox.ts`) renders it for the resident: one
 * `<teammate-message>` element per message, joined by a blank line. The
 * resident passes that whole string to recall as the ranking question
 * (`src/services/qianmo/resident.ts`, `#assemblePrompt`).
 */
export function renderTeammateBatch(messages: readonly string[]): string {
  return messages
    .map(
      text =>
        `<teammate-message teammate_id="peer-a">\n${text}\n</teammate-message>`,
    )
    .join('\n\n')
}

/** Code points an embedding input may hold (§2.4 item 3). */
export const EMBEDDING_INPUT_MAX_CODE_POINTS = 2000

const TEAMMATE_ELEMENT =
  /<teammate-message\b[^>]*>\n([\s\S]*?)\n<\/teammate-message>/g

/**
 * The text a query embedding is computed from — frozen with the corpus so
 * P16.6 does not choose it after seeing results.
 *
 * The wrapper tags are dropped (they are the same in every batch and would
 * pull every query towards every other), message bodies are joined in order
 * with a newline, and when the result is longer than
 * {@link EMBEDDING_INPUT_MAX_CODE_POINTS} whole messages are dropped from the
 * oldest end first — the newest message is the one being answered. A single
 * message still too long keeps its last code points.
 */
export function embeddingInputOf(query: string): string {
  const bodies = [...query.matchAll(TEAMMATE_ELEMENT)].map(
    match => match[1] ?? '',
  )
  const messages = bodies.length === 0 ? [query] : bodies
  const length = (texts: readonly string[]): number =>
    [...texts.join('\n')].length
  let kept = messages.map(text => text.trim())
  while (kept.length > 1 && length(kept) > EMBEDDING_INPUT_MAX_CODE_POINTS) {
    kept = kept.slice(1)
  }
  const joined = [...kept.join('\n')]
  return joined.length > EMBEDDING_INPUT_MAX_CODE_POINTS
    ? joined.slice(joined.length - EMBEDDING_INPUT_MAX_CODE_POINTS).join('')
    : joined.join('')
}

/**
 * The `source.id` a hardened entry is written with: its write position,
 * which the seed shuffles. Same length for every entry, so neither the text
 * nor the length of the line says anything about the entry's role.
 */
export function hardenedSourceId(_entry: unknown, writeIndex: number): string {
  return `eval-${String(writeIndex + 1).padStart(4, '0')}`
}

function siblingEntries(random: () => number): HardenedEntry[] {
  const tagOf = new Map(DECISIONS.map(d => [d.key, d.tags]))
  const entries: HardenedEntry[] = []
  for (const decision of DECISIONS) {
    const family = SIBLINGS[decision.key] ?? []
    for (const [index, [title, summary, body]] of family.entries()) {
      entries.push({
        key: `sib-${decision.key}-${index + 1}`,
        role: 'sibling',
        scope: projectScope(),
        title,
        summary,
        body,
        tags: tagOf.get(decision.key) ?? [],
        createdAt: ageFrom(random),
      })
    }
  }
  return entries
}

function contextEntries(random: () => number): HardenedEntry[] {
  return CONTEXT_ENTRIES.map(entry => ({
    key: entry.key,
    role: 'context',
    scope: {
      layer: 'working',
      projectKey: RESIDENT_AGENT_SEGMENT,
      taskId: entry.context === 'a' ? CONTEXT_A_SEGMENT : CONTEXT_B_SEGMENT,
    },
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: [],
    createdAt: ageFrom(random, 1, 30),
  }))
}

function fillerEntries(count: number, random: () => number): HardenedEntry[] {
  const picks = shuffled(fillerCombinations(), random).slice(0, count)
  return picks.map(([s, k, v], index) => {
    const [subject] = FILLER_SUBJECTS[s] ?? ['']
    const [setting, values] = FILLER_SETTINGS[k] ?? ['', []]
    const value = values[v] ?? ''
    const title = pick(FILLER_TITLE_FORMS, random)(subject, setting, value)
    const summary = pick(FILLER_SUMMARY_FORMS, random)(subject, setting, value)
    const reason = pick(ALL_REASONS, random)
    const followUp = random() < 0.5 ? pick(FILLER_FOLLOW_UPS, random) : ''
    return {
      key: `filler-${String(index + 1).padStart(4, '0')}`,
      role: 'filler',
      scope: projectScope(),
      title,
      summary,
      body: followUp.length === 0 ? reason : `${reason}${followUp}`,
      tags: [FILLER_TAG_BY_SUBJECT[subject] ?? 'ops'],
      createdAt: ageFrom(random),
    }
  })
}

function mustMentionFor(gold: readonly string[]): readonly string[][] {
  const [first] = gold
  if (first === undefined) return []
  return (MUST_MENTION_ANY[first] ?? []).map(options => [...options])
}

function hardenedQueries(): HardenedQuery[] {
  const base = fixedQueries().map(
    (query): HardenedQuery => ({
      ...query,
      mustMentionAny: mustMentionFor(query.gold),
      acceptable: [],
    }),
  )
  const positives = base.filter(query => query.kind.startsWith('positive-'))
  const batch = positives.map((query, index): HardenedQuery => {
    const layout = BATCH_LAYOUTS[index % BATCH_LAYOUTS.length] ?? ['q']
    const messages = layout.map(slot =>
      slot === 'q' ? query.question : (BATCH_CHATTER[slot] ?? ''),
    )
    return {
      ...query,
      id: `b${query.id}`,
      kind:
        query.kind === 'positive-lexical'
          ? 'positive-lexical-batch'
          : 'positive-mismatch-batch',
      question: renderTeammateBatch(messages),
      messages,
    }
  })
  const fabricated = MORE_FABRICATED.map(
    (fake): HardenedQuery => ({
      id: `fab-${fake.key}`,
      kind: 'negative-fabricated',
      question: fake.question,
      gold: [],
      forbidden: [],
      mustMention: [],
      mustMentionAny: [],
      acceptable: [],
    }),
  )
  const unsupported = DECISIONS.map(
    (decision): HardenedQuery => ({
      id: `uns-${decision.key}`,
      kind: 'negative-unsupported',
      question: UNSUPPORTED[decision.key] ?? '',
      gold: [],
      forbidden: [],
      mustMention: [],
      mustMentionAny: [],
      acceptable: [decision.key],
    }),
  )
  const context = CONTEXT_QUERIES.map(
    (query): HardenedQuery => ({
      id: query.id,
      kind: 'negative-cross-context',
      question: query.question,
      gold: query.gold,
      forbidden: query.forbidden,
      mustMention: query.mustMentionAny.map(options => options[0] ?? ''),
      mustMentionAny: query.mustMentionAny,
      acceptable: [],
      scope: CONTEXT_A_SCOPE,
    }),
  )
  const byKind = (kind: HardenedQueryKind): HardenedQuery[] =>
    [...base, ...batch, ...fabricated, ...unsupported, ...context].filter(
      query => query.kind === kind,
    )
  return HARDENED_KINDS.flatMap(byKind)
}

/**
 * Build the hardened corpus for one tier and seed.
 *
 * At or above {@link DECISION_ENTRY_COUNT} every sibling is present and the
 * rest is filler; below it (the 30 tier, which exists to stay under the
 * injection threshold) the tier is gold plus a seeded choice of siblings and
 * holds no filler at all.
 */
export function buildHardenedDataset(
  liveInScope: number,
  seed: number,
): HardenedDataset {
  if (
    !Number.isInteger(liveInScope) ||
    liveInScope < GOLD_IN_SCOPE ||
    liveInScope > HARDENED_MAX_LIVE_IN_SCOPE
  ) {
    throw new RangeError(
      `liveInScope must be an integer in [${GOLD_IN_SCOPE}, ${HARDENED_MAX_LIVE_IN_SCOPE}] (got ${liveInScope})`,
    )
  }
  const random = mulberry32(seed)
  const fixed: HardenedEntry[] = fixedEntries(random).map(entry => ({
    ...entry,
  }))
  const siblings = siblingEntries(random)
  const context = contextEntries(random)
  const chosenSiblings =
    liveInScope >= DECISION_ENTRY_COUNT
      ? siblings
      : shuffled(siblings, random).slice(0, liveInScope - GOLD_IN_SCOPE)
  const filler = fillerEntries(
    Math.max(0, liveInScope - DECISION_ENTRY_COUNT),
    random,
  )
  return {
    corpus: HARDENED_CORPUS_ID,
    seed,
    liveInScope,
    asOf: EVAL_AS_OF,
    scope: EVAL_SCOPE,
    entries: shuffled(
      [...fixed, ...chosenSiblings, ...context, ...filler],
      random,
    ),
    queries: hardenedQueries(),
  }
}

/** SHA-256 of one dataset, over its canonical JSON. */
function datasetDigest(dataset: unknown): string {
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex')
}

/**
 * The corpus hash of §9's preregistration table: every tier under every
 * seed, digested in a fixed order, then digested together with the corpus
 * id, seeds and tiers. Any change to text, labels, ages or write order
 * changes it.
 */
export function hardenedCorpusDigest(): string {
  const parts = HARDENED_SEEDS.flatMap(seed =>
    HARDENED_TIERS.map(
      tier =>
        `${seed}/${tier}/${datasetDigest(buildHardenedDataset(tier, seed))}`,
    ),
  )
  return createHash('sha256')
    .update(
      JSON.stringify({
        corpus: HARDENED_CORPUS_ID,
        seeds: HARDENED_SEEDS,
        tiers: HARDENED_TIERS,
        parts,
      }),
    )
    .digest('hex')
}
