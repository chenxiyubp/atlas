// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turning recalled entries into prompt text — the 小规模全量注入 half of D-6.
 *
 * WHY FULL INJECTION AT ALL
 *
 * Deterministic retrieval alone was measured at 8/10 on adversarial questions,
 * and its worst failure is total: ask about 「语义搜索」 when the entry says
 * 「向量数据库」 and a keyword query returns nothing, so the answer is not
 * "weakly ranked", it is absent. AC-4 wants 5/5. Below the budget in
 * {@link INJECTION_BUDGET} every live entry in scope goes into the prompt and
 * the model does the matching, which turns 5/5 from a probability into a
 * property of the pipeline. Ranking still runs — it decides the *order*, and it
 * decides who survives when the store outgrows the budget.
 *
 * The base does the same thing with its own `MEMORY.md`, which is loaded into
 * every prompt whole. This is that pattern applied to a store that additionally
 * knows what each record's id and write time are.
 *
 * WHY THE BLOCK LOOKS LIKE THIS
 *
 * Each entry prints `entry_id` and `written_at` as their own labelled lines,
 * and a ready-made `citation` line built by `@qianmo/memory`'s own
 * `formatCitation`. AC-4 asks the answer to carry 来源 ID 与写入时间; making the
 * model *copy* a string it can see beats asking it to assemble one, and using
 * the store's formatter means the citation the model reads and the citation the
 * verifier renders can never drift apart.
 */

import { formatCitation, type MemoryEntry } from '@qianmo/memory'
import type { RankedEntry } from './rank.js'
import { MEMORY_ANSWER_TOOL_NAME } from './tool.js'

export type InjectionMode = 'full' | 'ranked'

/**
 * How the injected set was chosen (`docs/dev/memory-m1.md` §5.4).
 *
 * `deterministic` is M0: the semantic layer was off or not applicable (full
 * mode never uses it). `hybrid` is the floor-plus-RRF fusion. `hybrid-degraded`
 * means the overlay was asked for and could not be applied — the entries are
 * then exactly the deterministic ones, and the reason is on the result's
 * events.
 */
export const RETRIEVAL_MODES = [
  'deterministic',
  'hybrid',
  'hybrid-degraded',
] as const

export type RetrievalMode = (typeof RETRIEVAL_MODES)[number]

export type InjectionBudget = {
  readonly maxEntries: number
  readonly maxChars: number
}

/**
 * The line between "inject everything" and "inject the best of it".
 *
 * D-6 put it at < 50 entries / < 20k tokens. The character budget is the
 * deterministic proxy for the token one: CJK runs at roughly one token per
 * character, so 20 000 characters is at the decision's ceiling in the worst
 * case and comfortably under it for Latin text. Counting characters rather than
 * calling a tokeniser keeps the whole path model-free, which is the same reason
 * charter N-8 gives for the retrieval itself.
 *
 * Recall-layer policy, not a protocol limit: nothing here crosses a node
 * boundary, so this is not a value `@qianmo/protocol`'s `LIMITS` owns.
 */
export const INJECTION_BUDGET: InjectionBudget = {
  maxEntries: 50,
  maxChars: 20_000,
}

/** The subset of a recall result that rendering needs. */
export type InjectionView = {
  readonly asOf: string
  readonly mode: InjectionMode
  readonly entries: readonly RankedEntry[]
  readonly omittedCount: number
  /** True when the scan could not read part of the store. */
  readonly degraded: boolean
  /**
   * Printed only when it is `hybrid`. Every other value renders the block
   * exactly as M0 did, which is what makes a degraded recall byte-identical to
   * a deterministic one.
   */
  readonly retrieval?: RetrievalMode
  /** Ids in the block only because the semantic fill put them there. */
  readonly semanticIds?: readonly string[]
}

function scopeLabel(entry: MemoryEntry): string {
  switch (entry.scope.layer) {
    case 'working':
      return `working/${entry.scope.projectKey}/${entry.scope.taskId}`
    case 'project':
      return `project/${entry.scope.projectKey}`
    case 'baseline':
      return `baseline/${entry.scope.period}`
  }
}

/*
 * ENTRY CONTENT IS DATA, NEVER FRAMING
 *
 * Three readers depend on the block's structure: the resident's assembled-
 * prompt scan counts its tags, the citation check trusts `injectedIds`, and
 * the model — or anything that later parses a stored prompt back into
 * entries — reads its lines. An entry whose body said `</qianmo-memory>` used
 * to fail that scan, and a failed scan withholds every remote message of the
 * turn; in full mode the entry is injected on every turn, so one write
 * silenced a partition for good. A body could also print a second
 * `--- entry` with somebody else's real id in it.
 *
 * So every value is neutralized on the way in, and only where it could be
 * read as structure:
 *
 *   - `<` and `>` become `&lt;` / `&gt;` in every field. That removes every
 *     tag spelling at once — any case, any spacing, the teammate tag, CDATA —
 *     without a list of names to walk around, and it is the same convention
 *     `@qianmo/adapter/sanitize` applies to remote text in the same message.
 *   - Fields printed after a `label: ` stay on that line: every line break
 *     becomes a space. Values read back off disk are not re-validated, so this
 *     covers the id, tags and timestamps too, not just the free-text fields.
 *   - A body keeps its lines, but a line that a reader would take for framing
 *     loses its first character to a numeric entity: an entry separator, an
 *     `entry_id:` or `citation:` line (the two that bind an id), or a code
 *     fence, which could otherwise swallow the entries after it. Leading
 *     whitespace and letter case do not hide one.
 *
 * "Line" means any break JavaScript or Python would split on, not just `\n`.
 *
 * Left alone, on purpose: quotes (no entry field reaches an attribute), `&`
 * (it cannot make a `<`, and escaping it would rewrite every `&&`), the other
 * labels (a body line saying `summary:` opens no entry and binds no id — its
 * author already owns every field of this one), and look-alike characters
 * such as `＜`. Nothing that enforces anything reads those as structure, and
 * T-7 does not accept "the model was not persuaded" as a verdict.
 *
 * Content without any of these fragments renders byte for byte as before.
 * Not imported from `@qianmo/adapter`: this package depends on
 * `@qianmo/memory` only, and the line rules here have no counterpart there.
 */

/** JavaScript's four line terminators plus Python's `str.splitlines` extras. */
const LINE_BREAK_SOURCE =
  '\\r\\n|[\\n\\v\\f\\r\\x1c-\\x1e\\x85\\u{2028}\\u{2029}]'

/** Whitespace a reader skips within one line. */
const INLINE_SPACE = '[^\\S\\n\\v\\f\\r\\u{2028}\\u{2029}]'

const LINE_BREAK = new RegExp(LINE_BREAK_SOURCE, 'gu')

const FRAMING_LINE = new RegExp(
  `(^|${LINE_BREAK_SOURCE})(${INLINE_SPACE}*)` +
    `(\`{3,}|~{3,}|-{3,}${INLINE_SPACE}*entry\\b|` +
    `(?:entry_id|citation)${INLINE_SPACE}*:)`,
  'giu',
)

function escapeAngles(text: string): string {
  return text.replace(/[<>]/g, character =>
    character === '<' ? '&lt;' : '&gt;',
  )
}

/** A value printed after `label: `. */
function inline(value: string): string {
  return escapeAngles(value.replace(LINE_BREAK, ' '))
}

function bodyText(body: string): string {
  return escapeAngles(body).replace(
    FRAMING_LINE,
    (_match, lineStart: string, indent: string, marker: string) =>
      `${lineStart}${indent}&#${marker.codePointAt(0)};${marker.slice(1)}`,
  )
}

/** One entry as it appears in the block. */
export function renderEntry(entry: MemoryEntry): string {
  const tags = entry.tags.length === 0 ? '(none)' : entry.tags.join(', ')
  return [
    `entry_id: ${inline(entry.id)}`,
    `written_at: ${inline(entry.createdAt)}`,
    `source: ${inline(`${entry.source.kind}:${entry.source.id}`)}`,
    `scope: ${inline(scopeLabel(entry))}`,
    `valid_from: ${inline(entry.validAt)}`,
    `tags: ${inline(tags)}`,
    `citation: ${inline(formatCitation(entry))}`,
    `title: ${inline(entry.title)}`,
    `summary: ${inline(entry.summary)}`,
    'body:',
    bodyText(entry.body.trimEnd()),
  ].join('\n')
}

export type Selection = {
  readonly chosen: readonly RankedEntry[]
  readonly mode: InjectionMode
  readonly omittedCount: number
}

/**
 * Decide how much of the candidate set fits.
 *
 * Walks in ranked order and stops at the first entry that would breach either
 * limit — so what survives a squeeze is what ranking judged most relevant, not
 * whatever the filesystem listed first.
 *
 * The character budget alone cannot reduce the block to nothing: a lone entry
 * larger than `maxChars` is still injected. A block that renders empty while
 * the store holds matching memory is indistinguishable, from inside the model,
 * from having no memory at all, and overshooting a soft size limit is the
 * lesser fault. `maxEntries` has no such exception — a caller asking for zero
 * entries is asking a different question and gets exactly that.
 */
export function selectForInjection(
  ranked: readonly RankedEntry[],
  budget: InjectionBudget = INJECTION_BUDGET,
): Selection {
  const chosen: RankedEntry[] = []
  let chars = 0
  for (const candidate of ranked) {
    const cost = renderEntry(candidate.entry).length
    const withinCount = chosen.length < budget.maxEntries
    const withinChars = chars + cost <= budget.maxChars || chosen.length === 0
    if (!withinCount || !withinChars) {
      break
    }
    chosen.push(candidate)
    chars += cost
  }
  const omittedCount = ranked.length - chosen.length
  return {
    chosen,
    mode: omittedCount === 0 ? 'full' : 'ranked',
    omittedCount,
  }
}

const OPEN = '<qianmo-memory'
const CLOSE = '</qianmo-memory>'

/** The line that marks an entry added by the semantic fill (V-8). */
const SEMANTIC_MARK = 'via: semantic'

/**
 * The memory block, ready to be placed in a system prompt.
 *
 * `mode` and `omitted` are printed because they change what the block *means*:
 * in `full` mode "not in the block" is evidence the store does not know, while
 * in `ranked` mode it only means the entry did not make the cut. The model is
 * told which of the two it is looking at, and so is anyone reading a transcript.
 */
export function renderInjection(view: InjectionView): string {
  const hybrid = view.retrieval === 'hybrid'
  const header =
    `${OPEN} as_of="${view.asOf}" mode="${view.mode}" ` +
    `injected="${view.entries.length}" omitted="${view.omittedCount}"` +
    `${hybrid ? ' retrieval="hybrid"' : ''}>`
  const lines = [header]
  if (view.mode === 'full') {
    lines.push(
      '# Every live memory entry in scope is included below. If a claim is ' +
        'not here, this store does not record it.',
    )
  } else {
    lines.push(
      `# The store holds more entries than fit; the ${view.entries.length} ` +
        'most relevant are included and ' +
        `${view.omittedCount} were omitted. Absence here is not evidence of ` +
        'absence in the store.',
    )
  }
  const semantic = new Set(hybrid ? (view.semanticIds ?? []) : [])
  if (semantic.size > 0) {
    lines.push(
      `# Entries marked "${SEMANTIC_MARK}" were selected by similarity to ` +
        'the message, not by shared wording or tags.',
    )
  }
  if (view.degraded) {
    lines.push(
      '# WARNING: part of the memory store could not be read during this ' +
        'recall. The block below may be incomplete for reasons unrelated to ' +
        'what was written.',
    )
  }
  if (view.entries.length === 0) {
    lines.push('(no live memory entries in scope)')
  }
  for (const [index, ranked] of view.entries.entries()) {
    lines.push(`--- entry ${index + 1}/${view.entries.length} ---`)
    // Framing, like the separator above it: outside the entry, so outside
    // the character budget `selectForInjection` counts.
    if (semantic.has(ranked.entry.id)) lines.push(SEMANTIC_MARK)
    lines.push(renderEntry(ranked.entry))
  }
  lines.push(CLOSE)
  return lines.join('\n')
}

/**
 * The rules that make the citation contract binding, in prompt form.
 *
 * The prompt is the *cooperative* half only. Nothing here is trusted: the
 * enforcement is `verifyCitations`, which resolves every id against the store
 * regardless of what the model was told. Charter §6.1 T-7 fixes the standard —
 * 不以模型是否被说服验收 — and it applies to being persuaded *into* a fabricated
 * citation exactly as it applies to being persuaded out of a permission check.
 */
export function citationInstructions(
  toolName: string = MEMORY_ANSWER_TOOL_NAME,
): string {
  return [
    'You answer strictly from the <qianmo-memory> block above.',
    `Reply by calling the \`${toolName}\` tool. Do not answer in prose.`,
    'Put every entry you relied on in `citations`, using the `entry_id` value ' +
      'copied character for character from the block.',
    'Never invent, guess, abbreviate or reformat an id. Ids are checked ' +
      'against the memory store and an unverifiable id causes the whole ' +
      'answer to be rejected.',
    'If the block contains nothing that answers the question, say exactly ' +
      'that and pass an empty `citations` list. An honest "not recorded" is ' +
      'correct; a plausible-looking id is not.',
  ].join('\n')
}

/** System-prompt sections: the rules first, then the memory. */
export function buildRecallSystemPrompt(view: InjectionView): string[] {
  return [citationInstructions(), renderInjection(view)]
}
