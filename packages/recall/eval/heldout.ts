// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The held-out paraphrase set of `docs/dev/memory-m1.md` §2.4 item 2 and D-1
 * R5: zero-overlap questions on the 20 gold decisions of `synthetic-v1`,
 * written by an author who has not seen the retrieval or fusion code, and
 * frozen before any tuning. R2–R4 are judged on this set only; the
 * development set (`hardened.ts`) is where hyperparameters may be tuned.
 *
 * This module defines the file, reads it, and says what is wrong with it. It
 * holds no question: the set was delivered by its author (an independent
 * agent, see `prereg.toml`) into {@link HELDOUT_PATH}. Without the file
 * {@link loadHeldout} returns `null` and every judgment that needs it refuses.
 *
 * FILE FORMAT (TOML, so it carries the licence header as a comment)
 *
 *   schema = "qianmo-recall-heldout/v1"
 *   corpus = "synthetic-v1"
 *   author = "…"                  who wrote it, as delivered
 *
 *   [[questions]]
 *   id = "ho-<anything>"          unique, [a-z0-9-] after the prefix
 *   gold = "<decision id>"        one of the 20 gold decisions
 *   question = "…"                zero overlap with that decision
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scoreEntry, tokensOf } from '../src/rank.js'
import { DECISIONS } from './dataset.js'
import {
  buildHardenedDataset,
  HARDENED_CORPUS_ID,
  HARDENED_SEEDS,
  hardenedSourceId,
} from './hardened.js'
import { idListDigest } from './retrieval-gates.js'
import { type BaselineQuery, materialise } from './run.js'

const HELDOUT_SCHEMA = 'qianmo-recall-heldout/v1'

/** Where the delivered set lives; its id-list hash is preregistered. */
export const HELDOUT_PATH = fileURLToPath(
  new URL('./heldout/synthetic-v1.heldout.toml', import.meta.url),
)

/** Questions per gold decision: 2 × 20 = 40 (see the P16.3 report for why). */
export const HELDOUT_PER_GOLD = 2

/** The query kind held-out questions carry in a dataset. */
export const HELDOUT_KIND = 'positive-heldout'

const ID_PATTERN = /^ho-[a-z0-9][a-z0-9-]*$/

export type HeldoutQuestion = {
  readonly id: string
  readonly gold: string
  readonly question: string
}

export type HeldoutSet = {
  readonly corpus: typeof HARDENED_CORPUS_ID
  readonly author: string
  readonly questions: readonly HeldoutQuestion[]
}

/** The 20 gold decisions, as the author sees them. */
export function goldDecisions(): readonly {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly body: string
}[] {
  return DECISIONS.map(decision => ({
    id: decision.key,
    title: decision.title,
    summary: decision.summary,
    tags: decision.tags,
    body: decision.body,
  }))
}

/** Parse the file's shape; what the questions say is {@link heldoutProblems}'s job. */
export function parseHeldout(text: string): HeldoutSet {
  const root = Bun.TOML.parse(text) as Record<string, unknown>
  for (const key of Object.keys(root)) {
    if (!['schema', 'corpus', 'author', 'questions'].includes(key)) {
      throw new Error(`held-out set: unknown key ${key}`)
    }
  }
  if (root['schema'] !== HELDOUT_SCHEMA) {
    throw new Error(`held-out set: schema must be "${HELDOUT_SCHEMA}"`)
  }
  if (root['corpus'] !== HARDENED_CORPUS_ID) {
    throw new Error(`held-out set: corpus must be "${HARDENED_CORPUS_ID}"`)
  }
  const author = root['author']
  if (typeof author !== 'string' || author.trim().length === 0) {
    throw new Error('held-out set: author must name who wrote it')
  }
  const questions = root['questions']
  if (!Array.isArray(questions)) {
    throw new Error('held-out set: [[questions]] is missing')
  }
  return {
    corpus: HARDENED_CORPUS_ID,
    author,
    questions: questions.map((raw, index) => {
      const item = raw as Record<string, unknown>
      const extra = Object.keys(item).filter(
        key => !['id', 'gold', 'question'].includes(key),
      )
      if (
        typeof item['id'] !== 'string' ||
        typeof item['gold'] !== 'string' ||
        typeof item['question'] !== 'string' ||
        extra.length > 0
      ) {
        throw new Error(
          `held-out set: questions[${index}] needs exactly id, gold and question (strings)`,
        )
      }
      return { id: item['id'], gold: item['gold'], question: item['question'] }
    }),
  }
}

/** The delivered set, or `null` when it has not been delivered. */
export function loadHeldout(path: string = HELDOUT_PATH): HeldoutSet | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null
    throw error
  }
  return parseHeldout(text)
}

/** The preregistration hash: `idListDigest` of the question ids. */
export function heldoutDigest(set: HeldoutSet): string {
  return idListDigest(set.questions.map(q => q.id))
}

const normalise = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')

/**
 * The ranking tokens each question shares with its gold decision, by the
 * shipped scorer over the stored entry (title, summary and tags as the head;
 * the body), in question order. Zero overlap is an empty list; a question
 * whose gold is not a decision gets `null`.
 *
 * The question is tokenised as written and after NFKC as well: the tokeniser
 * does not fold width, so `ｐ９５` would slip past `P95` while still being the
 * same word to any semantic ranker — a lexical overlap in disguise.
 */
export function overlapWithGold(
  questions: readonly HeldoutQuestion[],
): readonly (readonly string[] | null)[] {
  const seed = HARDENED_SEEDS[0] ?? 0
  const dataset = buildHardenedDataset(30, seed)
  const materialised = materialise(dataset, { sourceIdOf: hardenedSourceId })
  try {
    const golds = new Set(DECISIONS.map(d => d.key))
    return questions.map(q => {
      if (!golds.has(q.gold)) return null
      const entry = materialised.store.getEntry(materialised.idOf(q.gold))
      if (entry === null) throw new Error(`held-out: ${q.gold} not written`)
      const tokens = new Set([
        ...tokensOf(q.question),
        ...tokensOf(q.question.normalize('NFKC')),
      ])
      return scoreEntry(entry, {
        tokens: [...tokens],
        asOf: dataset.asOf,
      }).matchedTokens
    })
  } finally {
    materialised.dispose()
  }
}

/**
 * Everything that disqualifies the set; empty when it is usable.
 *
 * Checks: ids well-formed and unique; every gold one of the 20 decisions and
 * given exactly {@link HELDOUT_PER_GOLD} questions; every question has
 * ranking tokens and none is repeated; zero ranking-token overlap with its
 * gold; and no question equal to one of the development set's (R5: the two
 * sets are disjoint).
 */
export function heldoutProblems(set: HeldoutSet): string[] {
  const problems: string[] = []
  const golds = DECISIONS.map(d => d.key)
  const ids = new Set<string>()
  const texts = new Map<string, string>()
  const perGold = new Map(golds.map(key => [key, 0]))
  const development = new Map(
    buildHardenedDataset(30, HARDENED_SEEDS[0] ?? 0).queries.flatMap(query =>
      [query.question, ...(query.messages ?? [])].map(
        text => [normalise(text), query.id] as const,
      ),
    ),
  )
  for (const q of set.questions) {
    if (!ID_PATTERN.test(q.id))
      problems.push(`${q.id}: id must match ho-[a-z0-9-]+`)
    if (ids.has(q.id)) problems.push(`${q.id}: duplicate id`)
    ids.add(q.id)
    const count = perGold.get(q.gold)
    if (count === undefined) {
      problems.push(`${q.id}: gold ${q.gold} is not one of the 20 decisions`)
    } else {
      perGold.set(q.gold, count + 1)
    }
    const text = normalise(q.question)
    if (tokensOf(q.question).length === 0) {
      // Zero overlap by having no ranking tokens at all is not a paraphrase.
      problems.push(`${q.id}: the question has no ranking tokens`)
    }
    const twin = texts.get(text)
    if (twin !== undefined) problems.push(`${q.id}: same question as ${twin}`)
    texts.set(text, q.id)
    if (development.has(text)) {
      problems.push(`${q.id}: same question as a development-set question`)
    }
  }
  for (const [gold, count] of perGold) {
    if (count !== HELDOUT_PER_GOLD) {
      problems.push(
        `gold ${gold}: ${count} questions, expected ${HELDOUT_PER_GOLD}`,
      )
    }
  }
  for (const [index, matched] of overlapWithGold(set.questions).entries()) {
    if (matched !== null && matched.length > 0) {
      const id = set.questions[index]?.id ?? ''
      problems.push(`${id}: shares tokens with its gold: ${matched.join(' ')}`)
    }
  }
  return problems
}

/** The set as retrieval queries: one gold each, nothing forbidden. */
export function heldoutQueries(set: HeldoutSet): BaselineQuery[] {
  return set.questions.map(q => ({
    id: q.id,
    kind: HELDOUT_KIND,
    question: q.question,
    gold: [q.gold],
    forbidden: [],
    mustMention: [],
  }))
}
