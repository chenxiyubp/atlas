// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Citation verification — the structural half of AC-4's negative test.
 *
 * AC-4 asks that three decisions that were never written produce no
 * hallucinated citation. Prompt wording cannot promise that, and charter §6.1
 * T-7 says outright that "the model was persuaded" is not an acceptable basis
 * for a verdict. So every id a model emits is resolved against the store before
 * the answer is allowed out: `getEntry(id)` either hands back the record or it
 * does not exist, and an id that does not exist cannot be cited. The guarantee
 * comes from the lookup, not from the instructions.
 *
 * SIX OUTCOMES, NOT TWO
 *
 * The interesting design work is in refusing to collapse them:
 *
 *   ok            resolves, still live, and was in the injected block
 *   unknown       resolves to nothing — a fabricated id, the AC-4 case
 *   malformed     not even a well-formed id — fabricated, differently
 *   retired       resolves but was revoked or archived; live entries only, so
 *                 this is the guard behind 「废止后必须重投」
 *   not-injected  real and live, but not in what the model was shown — a real
 *                 id from somewhere else is still an ungrounded citation
 *   unreadable    the file exists and cannot be parsed
 *
 * That last one is the reason this file catches rather than trusting a `null`.
 * `@qianmo/memory`'s `getEntry` **throws** on a corrupt target instead of
 * returning `null` precisely so this check cannot mistake a damaged genuine
 * record for a fabricated one. Folding the two together here would undo that
 * and produce the worst possible error: a true memory reported as a
 * hallucination.
 */

import {
  formatCitation,
  MemoryValidationError,
  type FileMemoryStore,
  type MemoryEntry,
} from '@qianmo/memory'
import { injectedIds, type RecallResult } from './recall.js'
import { parseMemoryAnswerArgs, type MemoryAnswerArgs } from './tool.js'

export type CitationStatus =
  | 'ok'
  | 'unknown'
  | 'malformed'
  | 'retired'
  | 'not-injected'
  | 'unreadable'

export type CitationCheck = {
  /** The id as checked, after {@link normaliseCitationId}. */
  readonly id: string
  /** Exactly as the model emitted it. */
  readonly raw: string
  readonly status: CitationStatus
  readonly entry: MemoryEntry | null
  /** Present for `unreadable`: the failure, for an operator to act on. */
  readonly detail?: string
}

export type CitationReport = {
  /** `accepted` only when every check is `ok`. An empty list is acceptable. */
  readonly verdict: 'accepted' | 'rejected'
  readonly checks: readonly CitationCheck[]
  /** The entries behind the `ok` checks, in citation order. */
  readonly accepted: readonly MemoryEntry[]
  readonly problems: readonly CitationCheck[]
  /** True when the answer rests on at least one verified entry. */
  readonly grounded: boolean
}

/**
 * Recover the bare id from whatever the model put in the field.
 *
 * Models copy the whole `citation:` line about as often as they copy the
 * `entry_id:` value, and rejecting the former as malformed would report a
 * formatting slip as a fabrication. Lenient about shape, unchanged about
 * substance: whatever comes out of here still has to resolve in the store.
 */
export function normaliseCitationId(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('[')) {
    text = text.slice(1)
  }
  const close = text.indexOf(']')
  if (close !== -1) {
    text = text.slice(0, close)
  }
  // `formatCitation` joins with ' · '; a model may also hand back
  // "id (written 2026-…)" or just the id followed by stray words.
  const [head = ''] = text.split(/[·\s]/)
  return head.trim()
}

function checkOne(
  store: FileMemoryStore,
  raw: string,
  shown: ReadonlySet<string>,
): CitationCheck {
  const id = normaliseCitationId(raw)
  if (id.length === 0) {
    return { id, raw, status: 'malformed', entry: null }
  }
  let entry: MemoryEntry | null
  try {
    entry = store.getEntry(id)
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      // Not a legal id at all: it never named a record, so nothing was lost.
      return { id, raw, status: 'malformed', entry: null }
    }
    return {
      id,
      raw,
      status: 'unreadable',
      entry: null,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (entry === null) {
    return { id, raw, status: 'unknown', entry: null }
  }
  if (entry.expiredAt !== null) {
    return { id, raw, status: 'retired', entry }
  }
  if (!shown.has(entry.id)) {
    return { id, raw, status: 'not-injected', entry }
  }
  return { id, raw, status: 'ok', entry }
}

/**
 * Resolve every cited id.
 *
 * Duplicates are collapsed to their first occurrence — a model repeating an id
 * is not a second claim — and order is preserved so the rendered source list
 * matches the order the answer referred to them in.
 */
export function verifyCitations(
  store: FileMemoryStore,
  citations: readonly string[],
  shown: ReadonlySet<string>,
): CitationReport {
  const checks: CitationCheck[] = []
  const seen = new Set<string>()
  for (const raw of citations) {
    const check = checkOne(store, raw, shown)
    if (seen.has(check.id)) {
      continue
    }
    seen.add(check.id)
    checks.push(check)
  }
  const problems = checks.filter(check => check.status !== 'ok')
  const accepted = checks.flatMap(check =>
    check.status === 'ok' && check.entry !== null ? [check.entry] : [],
  )
  return {
    verdict: problems.length === 0 ? 'accepted' : 'rejected',
    checks,
    accepted,
    problems,
    grounded: accepted.length > 0,
  }
}

/**
 * The answer with its sources attached — AC-4's 「在输出中标注记忆条目来源 ID
 * 与写入时间」.
 *
 * Rendered from the store's own records via `formatCitation`, never from the
 * model's text. A model that mangles a write time therefore cannot put a wrong
 * one in front of a user: the id it cited is verified, and the timestamp beside
 * it is read back off disk.
 */
export function renderCitedAnswer(
  answer: string,
  report: CitationReport,
): string {
  if (report.accepted.length === 0) {
    return answer.trim()
  }
  const lines = report.accepted.map(entry => `- ${formatCitation(entry)}`)
  return `${answer.trim()}\n\n来源 / sources:\n${lines.join('\n')}`
}

export type MemoryAnswerOptions = {
  /**
   * Reject an answer that cites nothing.
   *
   * Off by default, because "no entry covers this" is a correct answer and the
   * AC-4 negative test depends on the model being able to give it. A caller
   * that already knows the question must be answered from memory turns it on.
   */
  readonly requireCitation?: boolean
}

export type MemoryAnswer = {
  readonly ok: boolean
  /** The answer with sources appended when `ok`; the raw text otherwise. */
  readonly answer: string
  readonly args: MemoryAnswerArgs
  readonly report: CitationReport
  /**
   * Why the answer was refused, phrased for the model. Feed it back as the
   * tool result and the same turn can correct itself; that loop is what makes
   * the citation requirement *enforced* rather than merely requested.
   */
  readonly rejection: string | null
}

const REASONS: Readonly<Record<CitationStatus, string>> = {
  ok: 'accepted',
  unknown: 'no memory entry has this id — it was not written by this store',
  malformed: 'not a well-formed memory entry id',
  retired: 'this entry was retired and may no longer be cited',
  'not-injected': 'this entry was not in the memory block you were given',
  unreadable: 'this entry exists but could not be read',
}

/**
 * Handle one `qianmo_memory_answer` tool call: the enforcement point.
 *
 * Everything the model asserted about provenance is re-derived here from the
 * store. `ok: false` means the answer must not be shown to a user as-is.
 */
export function handleMemoryAnswer(
  store: FileMemoryStore,
  result: RecallResult,
  input: unknown,
  options: MemoryAnswerOptions = {},
): MemoryAnswer {
  const args = parseMemoryAnswerArgs(input)
  const report = verifyCitations(store, args.citations, injectedIds(result))
  const failures = report.problems.map(
    check => `  - ${check.raw}: ${REASONS[check.status]}`,
  )
  if (options.requireCitation === true && report.accepted.length === 0) {
    failures.push(
      '  - the answer cites no memory entry, and this question must be ' +
        'answered from memory',
    )
  }
  if (failures.length === 0) {
    return {
      ok: true,
      answer: renderCitedAnswer(args.answer, report),
      args,
      report,
      rejection: null,
    }
  }
  return {
    ok: false,
    answer: args.answer,
    args,
    report,
    rejection: [
      'The answer was rejected because these citations did not verify:',
      ...failures,
      'Cite only `entry_id` values copied from the <qianmo-memory> block, or ' +
        'answer that memory does not record this and cite nothing.',
    ].join('\n'),
  }
}
