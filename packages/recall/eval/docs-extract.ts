// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turning the repository's own decision records into memory entries — the
 * second corpus of `docs/dev/memory-m1.md` §2.4 item 7 and D-8.
 *
 * Pure functions over markdown text. The generator
 * (`scripts/qianmo-recall-docs-corpus.ts`) feeds them the files as they were
 * at one pinned commit and writes the result to
 * `corpus/docs-dev.generated.ts`; nothing here touches git or the disk.
 *
 * WHAT A RECORD IS
 *
 * Every source row states a topic and what was decided about it. The topic
 * becomes the *question*; the decision and its rationale become the *entry*.
 * The entry deliberately leaves the topic text out, so the question does not
 * share its wording by construction — the pairing is the document's own row,
 * and both halves were written by the document's authors, not by whoever
 * runs this extraction. Change-log rows carry no topic and become entries
 * without a question: decision-shaped text that no question targets.
 *
 * PERSONAL INFORMATION
 *
 * The corpus is sent to model providers during the answer-layer evaluation,
 * so it must not carry personal information even where the source docs do.
 * Names of people and account handles are matched by SHA-256 (the plain
 * values are not written into this repository a second time), and contact
 * details and identifiers by pattern. Every match is replaced by a fixed
 * marker. {@link personalFindings} rescans the output; the generator refuses
 * to write a corpus with any finding left.
 */

import { createHash } from 'node:crypto'

type DocsRecordKind = 'decision' | 'changelog'

export type DocsRecord = {
  /** `<file stem>#<row id>`, unique across the corpus. */
  readonly key: string
  readonly file: string
  readonly kind: DocsRecordKind
  /** `YYYY-MM-DD`: the row's own date, else the document's. */
  readonly date: string
  /** The document's topic text for a decision row; `null` for a change log. */
  readonly question: string | null
  readonly title: string
  readonly summary: string
  readonly body: string
}

/** A table whose rows are decisions: `| id | topic | verdict | rationale |`. */
type TableSource = {
  readonly kind: 'table'
  readonly file: string
  readonly date: string
  /** The header row, cell by cell, exactly as written. */
  readonly header: readonly string[]
  readonly idColumn: number
  readonly topicColumn: number
  readonly verdictColumn: number
  /**
   * Where the entry's detail comes from. For a table whose topic cell holds a
   * bold lead followed by a description, `'topic-rest'` takes the text after
   * the lead and uses only the lead as the question.
   */
  readonly detail: { readonly column: number } | { readonly from: 'topic-rest' }
}

/** `### D-n <question>` sections with a `**决议**：` (or similar) paragraph. */
type HeadingSource = {
  readonly kind: 'heading'
  readonly file: string
  readonly date: string
  readonly level: number
  readonly idPattern: RegExp
  readonly conclusionLabels: readonly string[]
}

/**
 * A `| vX.Y | date | text |` change-log table: the first table after the
 * line `marker` (the documents write it as `**变更记录**`), blank lines
 * between rows included. A row's numbered items (① ② …) become separate
 * records: each is one decision, about as long as a decision-table row.
 */
type ChangeLogSource = {
  readonly kind: 'changelog'
  readonly file: string
  readonly marker: string
}

export type DocsSource = TableSource | HeadingSource | ChangeLogSource

/** Longest title / summary / body an entry keeps, in code points. */
const TITLE_MAX = 60
const SUMMARY_MAX = 120
const BODY_MAX = 480

/** Strip inline markdown down to its text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split one table row into raw cells, honouring `\|`. */
export function tableCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return []
  const cells: string[] = []
  let current = ''
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '\\|'
      i += 1
    } else if (ch === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  return cells
}

const SENTENCE_END = /[。！？；]/u

/**
 * Cut `text` to at most `max` code points: at the first sentence end if one
 * falls inside, else at the last comma-like break inside, else hard with an
 * ellipsis. Returns `[head, rest]`.
 */
export function cutSentence(text: string, max: number): [string, string] {
  const chars = [...text]
  const end = chars.findIndex(ch => SENTENCE_END.test(ch))
  if (end !== -1 && end < max) {
    return [
      chars
        .slice(0, end + 1)
        .join('')
        .trim(),
      chars
        .slice(end + 1)
        .join('')
        .trim(),
    ]
  }
  if (chars.length <= max) return [text.trim(), '']
  const window = chars.slice(0, max)
  const soft = Math.max(
    window.lastIndexOf('，'),
    window.lastIndexOf('、'),
    window.lastIndexOf('：'),
  )
  const at = soft > max / 3 ? soft + 1 : max - 1
  const head = chars.slice(0, at).join('').trim()
  return [soft > max / 3 ? head : `${head}…`, chars.slice(at).join('').trim()]
}

/** Cut to at most `max` code points on sentence ends, whole sentences only. */
function cutBody(text: string, max: number): string {
  let rest = text.trim()
  let kept = ''
  while (rest.length > 0) {
    const [sentence, after] = cutSentence(rest, max)
    if ([...kept].length + [...sentence].length > max) break
    kept += sentence
    rest = after
  }
  if (kept.length === 0 && text.trim().length > 0) {
    return cutSentence(text, max)[0]
  }
  return kept
}

/**
 * An entry from a verdict and a detail text. A verdict written as
 * 「基座已处理：…」 keeps the part before the colon as its title.
 */
function entryFrom(verdict: string, detail: string) {
  const colon = verdict.indexOf('：')
  const [title, afterTitle] =
    colon > 1 && colon < TITLE_MAX
      ? [verdict.slice(0, colon), verdict.slice(colon + 1).trim()]
      : cutSentence(verdict, TITLE_MAX)
  const [summary, afterSummary] = cutSentence(detail, SUMMARY_MAX)
  const body = cutBody([afterTitle, afterSummary].join(' ').trim(), BODY_MAX)
  return { title, summary, body }
}

function stemOf(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.md$/, '')
}

function extractTable(markdown: string, source: TableSource): DocsRecord[] {
  const records: DocsRecord[] = []
  const lines = markdown.split('\n')
  const header = source.header.join('|')
  for (let i = 0; i < lines.length; i += 1) {
    const cells = tableCells(lines[i] ?? '')
    if (cells.join('|') !== header) continue
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = tableCells(lines[j] ?? '')
      if (row.length === 0) break
      const topicRaw = row[source.topicColumn] ?? ''
      // A struck-out row is a retracted finding, not a decision.
      if (topicRaw.trim().startsWith('~~')) continue
      const id = plainText(row[source.idColumn] ?? '')
      const verdict = plainText(row[source.verdictColumn] ?? '')
      let question = plainText(topicRaw)
      let detail = ''
      if ('column' in source.detail) {
        detail = plainText(row[source.detail.column] ?? '')
      } else {
        const lead = /^\*\*(.+?)\*\*[：:]?\s*/.exec(topicRaw.trim())
        question = plainText(lead?.[1] ?? topicRaw)
        detail = plainText(
          lead === null ? '' : topicRaw.trim().slice(lead[0].length),
        )
      }
      records.push({
        key: `${stemOf(source.file)}#${id}`,
        file: source.file,
        kind: 'decision',
        date: source.date,
        question,
        ...entryFrom(verdict, detail),
      })
    }
  }
  return records
}

function extractHeadings(
  markdown: string,
  source: HeadingSource,
): DocsRecord[] {
  const records: DocsRecord[] = []
  const marker = `${'#'.repeat(source.level)} `
  const sections = markdown.split('\n').reduce<string[][]>((acc, line) => {
    if (line.startsWith(marker) || /^#{1,6} /.test(line)) acc.push([line])
    else acc[acc.length - 1]?.push(line)
    return acc
  }, [])
  for (const section of sections) {
    const heading = section[0] ?? ''
    if (!heading.startsWith(marker)) continue
    const title = heading.slice(marker.length).trim()
    const id = source.idPattern.exec(title)?.[0]
    if (id === undefined) continue
    const labelled = section.find(line =>
      source.conclusionLabels.some(label => line.startsWith(`**${label}**：`)),
    )
    if (labelled === undefined) continue
    const conclusion = plainText(labelled.replace(/^\*\*[^*]+\*\*：/, ''))
    const [verdict, detail] = cutSentence(conclusion, TITLE_MAX)
    records.push({
      key: `${stemOf(source.file)}#${id}`,
      file: source.file,
      kind: 'decision',
      date: source.date,
      question: plainText(title.slice(id.length)),
      ...entryFrom(verdict, detail),
    })
  }
  return records
}

/** The circled numbers ① … ⑳ that enumerate items inside a change-log row. */
const CIRCLED = /[\u2460-\u2473]/u

/** Title, summary and body for one piece of a change-log row. */
function changeLogPart(
  raw: string,
): { title: string; summary: string; body: string } | null {
  const lead = /^\*\*(.+?)\*\*/.exec(raw)
  const text = plainText(raw)
  if (text.replace(/[。；：:，,\s]/g, '').length === 0) return null
  const head = plainText(lead?.[1] ?? '')
  const [title, rest] =
    head.length > 0 && [...head].length <= TITLE_MAX
      ? [head, plainText(raw.slice(lead?.[0].length ?? 0))]
      : cutSentence(text, TITLE_MAX)
  const [summary, after] = cutSentence(
    rest.replace(/^[。；：:，,\s]+/, ''),
    SUMMARY_MAX,
  )
  return { title, summary, body: cutBody(after, BODY_MAX) }
}

function extractChangeLog(
  markdown: string,
  source: ChangeLogSource,
): DocsRecord[] {
  const records: DocsRecord[] = []
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => line.trim() === source.marker)
  if (start === -1) return records
  let seenTable = false
  for (const line of lines.slice(start + 1)) {
    const cells = tableCells(line)
    if (cells.length === 0) {
      // Parts of both change logs put a blank line between rows; the table
      // ends at the first line of prose, not at the first blank line.
      if (seenTable && line.trim().length > 0) break
      continue
    }
    seenTable = true
    if (cells.length < 3) continue
    const version = plainText(cells[0] ?? '')
    const date = plainText(cells[1] ?? '')
    if (!/^v\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue
    }
    const raw = (cells[2] ?? '').trim()
    // A row bundles several decisions as ① ② ③ …; each becomes its own
    // record, and the text before the first one (the row's lead) another.
    const parts = raw.split(CIRCLED)
    for (const [index, part] of parts.entries()) {
      const record = changeLogPart(part.trim())
      if (record === null) continue
      records.push({
        key: `${stemOf(source.file)}#${version}${index === 0 ? '' : `.${index}`}`,
        file: source.file,
        kind: 'changelog',
        date,
        question: null,
        ...record,
      })
    }
  }
  return records
}

function rawRecords(markdown: string, source: DocsSource): DocsRecord[] {
  switch (source.kind) {
    case 'table':
      return extractTable(markdown, source)
    case 'heading':
      return extractHeadings(markdown, source)
    case 'changelog':
      return extractChangeLog(markdown, source)
  }
}

/**
 * Extract every record one source yields from its markdown. The memory store
 * requires a non-blank summary; a row whose text ends with its title (the
 * charter's 「v1.0 初稿」) repeats the title there rather than being dropped.
 */
export function extractRecords(
  markdown: string,
  source: DocsSource,
): DocsRecord[] {
  return rawRecords(markdown, source)
    .filter(record => record.title.length > 0)
    .map(record =>
      record.summary.length > 0 ? record : { ...record, summary: record.title },
    )
}

// ── personal information ────────────────────────────────────────────────────

/**
 * SHA-256 (hex, over the NFC string, lower-cased for ASCII) of the tokens
 * that name a person: the six people of the team roster in `docs/README.md`
 * at the pinned commit, and the three account handles that appear in
 * `docs/dev`. Stored as digests so this module does not become one more
 * place that spells them out.
 */
const PERSONAL_TOKEN_SHA256: readonly {
  readonly script: 'han' | 'ascii'
  readonly length: number
  readonly sha256: string
}[] = [
  {
    script: 'han',
    length: 3,
    sha256: '602c6071ae80d3b544934b18424012362577d55c67d95fd67f4304a7278162de',
  },
  {
    script: 'han',
    length: 3,
    sha256: 'df7a662c45e77843df459d2a56e3b9ab2c17c8117161d6ec3e8f82148c36a554',
  },
  {
    script: 'han',
    length: 3,
    sha256: '74ef2a5729df328cbb82c8deb590549cab3764b275f07aac6f69311a8b57511f',
  },
  {
    script: 'han',
    length: 3,
    sha256: '6f34f640cf67d388fcd9b37a1ad2d73f4bdf7debeb70ded21c2f92802c242818',
  },
  {
    script: 'han',
    length: 3,
    sha256: 'b770ad6536892cdec32fa28db7f2880dbcbeba5ff9d409e314947334b40a5848',
  },
  {
    script: 'han',
    length: 3,
    sha256: '88593844e11a091bda7e4dc1089239549604e097ed961362d41b60e069053ae3',
  },
  {
    script: 'ascii',
    length: 11,
    sha256: '091195de554d83f622d239f8c9431cffc5a09daddda3328c29626b0350c447cf',
  },
  {
    script: 'ascii',
    length: 7,
    sha256: 'd7098e31a368e0bf71c58cae2637bb9d6289f162bda95c81aa75e91d9555430f',
  },
  {
    script: 'ascii',
    length: 6,
    sha256: '7119dbad8f45513da0482e3dcbd3721c9b022710caca8c96feeb816288224ad8',
  },
]

export const NAME_MARK = '〔姓名略〕'
const HANDLE_MARK = '〔账号略〕'
const EMAIL_MARK = '〔邮箱略〕'
const PHONE_MARK = '〔号码略〕'
const NUMBER_MARK = '〔编号略〕'
const ADDRESS_MARK = '〔地址略〕'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const LONG_NUMBER = /(?<!\d)\d{8,}(?!\d)/g
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g
const HAN_RUN = /[㐀-䶿一-鿿]+/gu
const ASCII_TOKEN = /[A-Za-z0-9]+/g

function sha256Hex(text: string): string {
  return createHash('sha256').update(text.normalize('NFC')).digest('hex')
}

type TokenList = typeof PERSONAL_TOKEN_SHA256

function hanSpans(
  text: string,
  tokens: TokenList,
): { start: number; end: number }[] {
  const wanted = tokens.filter(t => t.script === 'han')
  const lengths = [...new Set(wanted.map(t => t.length))]
  const digests = new Set(wanted.map(t => t.sha256))
  const spans: { start: number; end: number }[] = []
  for (const match of text.matchAll(HAN_RUN)) {
    const run = match[0]
    const offset = match.index ?? 0
    for (let i = 0; i < run.length; i += 1) {
      for (const length of lengths) {
        if (i + length > run.length) continue
        if (digests.has(sha256Hex(run.slice(i, i + length)))) {
          spans.push({ start: offset + i, end: offset + i + length })
        }
      }
    }
  }
  return spans
}

function asciiSpans(
  text: string,
  tokens: TokenList,
): { start: number; end: number }[] {
  const digests = new Set(
    tokens.filter(t => t.script === 'ascii').map(t => t.sha256),
  )
  const spans: { start: number; end: number }[] = []
  for (const match of text.matchAll(ASCII_TOKEN)) {
    if (digests.has(sha256Hex(match[0].toLowerCase()))) {
      const start = match.index ?? 0
      spans.push({ start, end: start + match[0].length })
    }
  }
  return spans
}

function replaceSpans(
  text: string,
  spans: readonly { start: number; end: number }[],
  mark: string,
): string {
  let out = ''
  let at = 0
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < at) continue
    out += text.slice(at, span.start) + mark
    at = span.end
  }
  return out + text.slice(at)
}

/** Replace every personal detail in `text` with its marker. */
export function redactPersonal(
  text: string,
  tokens: TokenList = PERSONAL_TOKEN_SHA256,
): string {
  let out = text
    .replace(EMAIL, EMAIL_MARK)
    .replace(PHONE, PHONE_MARK)
    .replace(IPV4, ADDRESS_MARK)
    .replace(LONG_NUMBER, NUMBER_MARK)
  out = replaceSpans(out, hanSpans(out, tokens), NAME_MARK)
  out = replaceSpans(out, asciiSpans(out, tokens), HANDLE_MARK)
  return out
}

/** What personal detail is still in `text`; empty when it is clean. */
export function personalFindings(
  text: string,
  tokens: TokenList = PERSONAL_TOKEN_SHA256,
): string[] {
  const findings: string[] = []
  // `match` on a global pattern is stateless; `test` would carry lastIndex.
  if (text.match(EMAIL) !== null) findings.push('email')
  if (text.match(PHONE) !== null) findings.push('phone')
  if (text.match(IPV4) !== null) findings.push('ipv4')
  if (text.match(LONG_NUMBER) !== null) findings.push('long-number')
  if (hanSpans(text, tokens).length > 0) findings.push('name')
  if (asciiSpans(text, tokens).length > 0) findings.push('handle')
  return findings
}
