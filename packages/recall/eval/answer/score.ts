// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Judging one model call (`docs/dev/memory-m1.md` §2.2): the six citation
 * statuses come from `handleMemoryAnswer`, the same enforcement point the
 * AC-4 leg uses; this module turns them into the §2.2 metrics.
 *
 *   H          first round accepted, a gold entry among the accepted, and
 *              every `mustMention` present (NFKC, lower case, no whitespace;
 *              any of a requirement's alternatives counts). Also reported
 *              without the `mustMention` condition.
 *   HR_mis     an accepted — user-visible — citation outside S(q) = gold ∪
 *              acceptable. A rejected answer is not shown, so its citations
 *              are not misattributions.
 *   HR_fab     `unknown` + `malformed` citations, before interception.
 *   out of     `retired` + `not-injected`: real ids from outside the evidence.
 *   bounds
 *
 * `unreadable` is not a metric: a synthetic store written by the harness
 * cannot hold a damaged entry, so seeing one means the instrument is broken,
 * and the whole round is void (D-2). {@link judgeRound} throws.
 */

import { handleMemoryAnswer, type CitationStatus } from '../../src/citation.js'
import type { RecallResult } from '../../src/recall.js'
import { MEMORY_ANSWER_TOOL_NAME, RecallToolError } from '../../src/tool.js'
import type { FileMemoryStore } from '@qianmo/memory'
import type { AnswerResponse, ToolCall } from './types.js'

/** The answer text kept per round in the call log (§4 「answer 前 200 字」). */
const ANSWER_HEAD_CODE_POINTS = 200

/** An `unreadable` citation or a degraded recall: the round is void. */
export class InvalidRound extends Error {
  constructor(
    readonly callKey: string,
    readonly reason: string,
  ) {
    super(`answer eval: round invalid at ${callKey}: ${reason}`)
    this.name = 'InvalidRound'
  }
}

export type CitedCheck = {
  readonly raw: string
  readonly id: string
  readonly status: CitationStatus
  /** The corpus key of the entry, when the id names one. */
  readonly key: string | null
}

/**
 * accepted       the tool was called and every citation verified
 * rejected       the tool was called and some citation did not verify
 * no-tool        the model answered without calling the tool
 * bad-arguments  the tool was called with arguments that do not parse
 */
export type RoundVerdict = 'accepted' | 'rejected' | 'no-tool' | 'bad-arguments'

export type RoundOutcome = {
  readonly verdict: RoundVerdict
  readonly checks: readonly CitedCheck[]
  /** Keys of the accepted entries; empty unless the verdict is `accepted`. */
  readonly acceptedKeys: readonly string[]
  /** The whole answer, for scoring. Not persisted beyond its head. */
  readonly answer: string
  /** Fed back as the tool result when the verdict is `rejected`. */
  readonly rejection: string | null
  /** The call the rejection answers. */
  readonly toolCall: ToolCall | null
}

export type AnswerLabels = {
  readonly kind: string
  readonly gold: readonly string[]
  readonly acceptable: readonly string[]
  /** One inner list per requirement; any alternative satisfies it. */
  readonly mentions: readonly (readonly string[])[]
}

export type CallScore = {
  readonly hit: boolean
  readonly hitWithoutMention: boolean
  readonly misattributed: boolean
  readonly citations: number
  readonly fabricated: number
  readonly outOfBounds: number
  /** Citations a user would see: the accepted ones of an accepted answer. */
  readonly acceptedCitations: number
}

export function normaliseForMention(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

/** Every requirement met by at least one of its alternatives. */
export function mentionsAll(
  answer: string,
  requirements: readonly (readonly string[])[],
): boolean {
  const haystack = normaliseForMention(answer)
  return requirements.every(options =>
    options.some(option => haystack.includes(normaliseForMention(option))),
  )
}

/** The code-point prefix kept in the call log. */
export function answerHead(answer: string): string {
  return [...answer].slice(0, ANSWER_HEAD_CODE_POINTS).join('')
}

/**
 * Judge one response against the recall result that was shown.
 *
 * @param keyOf maps a store id to its corpus key.
 */
export function judgeRound(params: {
  readonly store: FileMemoryStore
  readonly result: RecallResult
  readonly response: AnswerResponse
  readonly keyOf: (id: string) => string
  readonly callKey: string
}): RoundOutcome {
  const { store, result, response, keyOf, callKey } = params
  const call =
    response.toolCalls.find(c => c.name === MEMORY_ANSWER_TOOL_NAME) ?? null
  if (call === null) {
    return {
      verdict: 'no-tool',
      checks: [],
      acceptedKeys: [],
      answer: response.text,
      rejection: null,
      toolCall: null,
    }
  }
  let handled: ReturnType<typeof handleMemoryAnswer>
  try {
    // `requireCitation` stays off, as on every production path: whether a
    // question has an answer in memory is exactly what is being measured.
    handled = handleMemoryAnswer(store, result, call.input)
  } catch (error) {
    if (!(error instanceof RecallToolError)) throw error
    return {
      verdict: 'bad-arguments',
      checks: [],
      acceptedKeys: [],
      answer: response.text,
      rejection: null,
      toolCall: call,
    }
  }
  const checks = handled.report.checks.map(
    (check): CitedCheck => ({
      raw: check.raw,
      id: check.id,
      status: check.status,
      key: check.entry === null ? null : keyOf(check.entry.id),
    }),
  )
  const unreadable = handled.report.checks.find(c => c.status === 'unreadable')
  if (unreadable !== undefined) {
    throw new InvalidRound(
      callKey,
      `citation ${unreadable.id} is unreadable: ${unreadable.detail ?? ''}`,
    )
  }
  return {
    verdict: handled.ok ? 'accepted' : 'rejected',
    checks,
    acceptedKeys: handled.ok
      ? handled.report.accepted.map(entry => keyOf(entry.id))
      : [],
    answer: handled.args.answer,
    rejection: handled.rejection,
    toolCall: call,
  }
}

/** The §2.2 metrics of one round. */
export function scoreRound(
  outcome: RoundOutcome,
  labels: AnswerLabels,
): CallScore {
  const allowed = new Set([...labels.gold, ...labels.acceptable])
  const accepted = outcome.verdict === 'accepted'
  const goldCited = outcome.acceptedKeys.some(key => labels.gold.includes(key))
  const count = (statuses: readonly CitationStatus[]) =>
    outcome.checks.filter(check => statuses.includes(check.status)).length
  return {
    hitWithoutMention: accepted && goldCited,
    hit: accepted && goldCited && mentionsAll(outcome.answer, labels.mentions),
    misattributed:
      accepted && outcome.acceptedKeys.some(key => !allowed.has(key)),
    citations: outcome.checks.length,
    fabricated: count(['unknown', 'malformed']),
    outOfBounds: count(['retired', 'not-injected']),
    acceptedCitations: outcome.acceptedKeys.length,
  }
}
