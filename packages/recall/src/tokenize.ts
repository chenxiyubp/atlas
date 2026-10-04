// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic tokenisation for the keyword half of charter N-8's retrieval.
 *
 * No model, no stemmer, no dictionary: the same string produces the same token
 * list on every machine and every run, because a ranking a reviewer cannot
 * reproduce is not evidence for AC-4.
 *
 * TWO SCRIPTS, TWO RULES
 *
 * Whitespace splitting is an alphabet-only assumption, and the memory this
 * package retrieves is largely Chinese. So Latin/digit runs become whole
 * tokens, while CJK runs become **character bigrams**: 「统一用 Bun」 yields
 * `统一`, `一用`, which lets 「本项目用什么运行时」 overlap 「统一用 Bun」
 * without a dictionary. Bigrams over-match (they will happily match across a
 * word boundary) — that is the intended trade. Over-matching costs ranking
 * precision; under-matching costs a *missing* entry, and D-6 recorded the
 * measured version of that failure: asking about 「语义搜索」 while the entry
 * says 「向量数据库」 returned zero results.
 *
 * Which is also why nothing here is allowed to *filter* candidates. These
 * tokens feed `rank.ts` only. Candidate selection is scope-based
 * (`recall.ts`), so a question whose wording overlaps nothing still gets every
 * entry injected when the store is small enough — the structural half of D-6.
 */

/**
 * CJK ideographs plus kana. Deliberately a fixed range list rather than
 * `\p{Script=Han}`: the ranges are stable across engine Unicode versions, so a
 * Node/Bun upgrade cannot quietly change how a stored entry tokenises and with
 * it the order of an injected block.
 */
export const CJK_CLASS =
  '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'

/** Runs of CJK characters. */
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, 'gu')

/**
 * Runs of anything that is neither CJK, whitespace, punctuation nor a symbol —
 * i.e. Latin letters (accented included), digits and the like.
 */
const WORD_RUN = new RegExp(`[^${CJK_CLASS}\\s\\p{P}\\p{S}\\p{C}]+`, 'gu')

/** Single letters carry no signal and match nearly everything. */
const MIN_WORD_LENGTH = 2

/**
 * Kept deliberately tiny. Every word removed here is a word that can no longer
 * connect a question to an entry, and this package's failure mode of record is
 * *missing* a match, not returning a weak one.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'which',
  'does',
  'did',
  'was',
  'were',
  'are',
  'our',
  'you',
  'your',
  'how',
  'why',
  'when',
  'who',
  'into',
  'about',
])

/**
 * Split text into ranking tokens: first-seen order, no duplicates.
 *
 * Order is preserved rather than sorted so that a caller printing the tokens
 * (the recall result carries them, for explainability) sees them in the order
 * they were written, which is what makes a ranking decision readable.
 */
export function tokenize(text: string): readonly string[] {
  const lower = text.toLowerCase()
  const seen = new Set<string>()
  const tokens: string[] = []
  const push = (token: string): void => {
    if (!seen.has(token)) {
      seen.add(token)
      tokens.push(token)
    }
  }

  for (const match of lower.matchAll(WORD_RUN)) {
    const run = match[0]
    if (run.length >= MIN_WORD_LENGTH && !STOPWORDS.has(run)) {
      push(run)
    }
  }

  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      push(run.slice(i, i + 2))
    }
  }

  return tokens
}
