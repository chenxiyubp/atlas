// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The small, closed subset of markdown a transcript is allowed to render.
 *
 * ## Why there is a renderer here at all
 *
 * This page used to render remote text as `<p>` blocks and nothing else, and
 * the reason was written down: markdown, code fences and autolinking are each a
 * road from "the model on the other end produced a string" to "this page has
 * markup in it". That reasoning was right about the danger and wrong about the
 * remedy — a transcript where every answer arrives as one grey wall of text is
 * a transcript nobody reads, and an operator who cannot tell a command from
 * prose will eventually run the prose.
 *
 * So the refusal is replaced by a **stronger boundary**, not lifted:
 *
 * ## The boundary is the order, not the filter
 *
 * `escapeHtml` runs **first, over the whole string**. Every structural decision
 * after that is made on text in which `<`, `>`, `&`, `"` and `'` are already
 * entities — so no branch here can be tricked into emitting a tag, because by
 * the time any branch runs there is no `<` left to emit. Tags come only from
 * the fixed literals in this file.
 *
 * This is worth stating as a rule because the tempting way to write a markdown
 * renderer is the opposite one: parse the source, then escape the leaves. That
 * shape is correct only if every leaf is found, and the bugs are exactly the
 * leaves nobody thought of. **Any change here that moves work before the escape
 * is a security change, whatever else it looks like.**
 *
 * ## What is in, and what is deliberately out
 *
 * In: fenced code blocks, inline code, unordered lists, bold, paragraphs.
 * These are what an agent's answer actually contains — a command to run, a
 * path, a short list of findings.
 *
 * Out, each for its own reason:
 *
 * - **Links and autolinking.** A link is the one markdown feature whose whole
 *   purpose is to send the reader somewhere the model chose. Rendering remote
 *   text as a clickable target is the difference between "the agent said a URL"
 *   and "this console offered the operator a URL".
 * - **Images.** Same, plus they fetch on render — an `<img>` is an outbound
 *   request this page makes on the model's behalf, and this console loads
 *   nothing from anywhere by design.
 * - **Raw HTML pass-through.** Structurally impossible after the escape, and it
 *   stays that way.
 * - **Tables.** Not a safety matter, a scope one: they need column layout in a
 *   pane that is already narrow, and no answer has needed one yet.
 * - **Nested lists.** Also scope, and stated because the flattening is
 *   otherwise indistinguishable from a bug: an indented sub-item renders as a
 *   sibling of its parent rather than beneath it. One level is what a step list
 *   in an answer needs, and depth would bring its own indent arithmetic into a
 *   pane whose whole width is already spoken for.
 * - **The fence's info string** (` ```ts `). Not rendered, not put in a class —
 *   there is no highlighting here for it to feed, and a class built from remote
 *   text is an attribute value nobody asked for.
 */

import { escapeHtml } from './escape.js'

/**
 * The paragraph class the transcript already used, kept as-is.
 *
 * `white-space: pre-wrap` lives on it, which is why a paragraph can hold its
 * own newlines without this file emitting a single `<br>`.
 */
const PARAGRAPH_CLASS = 'turn-p'

/** A run of text between backticks, and the text around it. */
interface Span {
  readonly code: boolean
  readonly text: string
}

/**
 * Split already-escaped text on single backticks.
 *
 * A trailing unpaired backtick is **literal**, not the start of a code span
 * that swallows the rest of the line: an answer that mentions one backtick is
 * ordinary, and a renderer that reacts by restyling everything after it makes
 * the page look broken for a reason the reader cannot see.
 */
function splitCodeSpans(escaped: string): readonly Span[] {
  const spans: Span[] = []
  let rest = escaped
  while (rest.length > 0) {
    const open = rest.indexOf('`')
    if (open === -1) {
      spans.push({ code: false, text: rest })
      break
    }
    const close = rest.indexOf('`', open + 1)
    // A span stops at the end of its line, the same bound `bold()` keeps with
    // `[^*\n]`. A paragraph is `join('\n')`, so without this a lone backtick
    // in one line can pair with one three lines down and restyle the prose
    // between them — the very failure the unpaired-backtick note above calls
    // out, arriving through the paired branch instead.
    const newline = rest.indexOf('\n', open + 1)
    if (close === -1 || (newline !== -1 && newline < close)) {
      spans.push({ code: false, text: rest.slice(0, open + 1) })
      rest = rest.slice(open + 1)
      continue
    }
    if (open > 0) spans.push({ code: false, text: rest.slice(0, open) })
    spans.push({ code: true, text: rest.slice(open + 1, close) })
    rest = rest.slice(close + 1)
  }
  return spans
}

/**
 * `**bold**`, on a segment already known not to be code.
 *
 * Non-greedy and single-line: `**` opened and never closed stays literal, for
 * the same reason the unpaired backtick does.
 */
function bold(escaped: string): string {
  return escaped.replace(
    /\*\*(?!\s)([^*\n]+?)\*\*/g,
    (_match, inner: string) => `<b>${inner}</b>`,
  )
}

/** Inline marks on one already-escaped line. */
function inline(escaped: string): string {
  return splitCodeSpans(escaped)
    .map(span =>
      span.code ? `<code class="mono">${span.text}</code>` : bold(span.text),
    )
    .join('')
}

/** True for a line that opens or closes a fence. */
function isFence(line: string): boolean {
  return line.trimStart().startsWith('```')
}

/** The bullet a list line uses, or null when the line is not a list item. */
function listItem(line: string): string | null {
  const match = /^\s{0,3}[-*]\s+(.*)$/.exec(line)
  return match === null ? null : (match[1] ?? '')
}

/**
 * Render one already-escaped block of text into the transcript's markup.
 *
 * Exported for the turn renderer; **takes raw text and escapes it here**, so a
 * caller cannot accidentally hand it something pre-escaped by a different rule.
 */
export function renderRichText(text: string): string {
  const escaped = escapeHtml(text)
  const lines = escaped.split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let items: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const body = paragraph.join('\n').trim()
    paragraph = []
    if (body.length > 0) {
      out.push(`<p class="${PARAGRAPH_CLASS}">${inline(body)}</p>`)
    }
  }
  const flushList = (): void => {
    if (items.length === 0) return
    out.push(
      `<ul class="turn-list">${items
        .map(item => `<li>${inline(item)}</li>`)
        .join('')}</ul>`,
    )
    items = []
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (isFence(line)) {
      flushParagraph()
      flushList()
      const body: string[] = []
      index += 1
      // An unclosed fence takes the rest of the block. Every renderer does
      // this, and here it is also the safe direction: the remainder is already
      // escaped, so the worst case is text shown in a monospaced box.
      while (index < lines.length && !isFence(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      out.push(`<pre class="turn-code"><code>${body.join('\n')}</code></pre>`)
      continue
    }
    const item = listItem(line)
    if (item !== null) {
      flushParagraph()
      items.push(item)
      index += 1
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      index += 1
      continue
    }
    flushList()
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  flushList()

  return out.length === 0 ? `<p class="turn-empty">（空）</p>` : out.join('')
}
