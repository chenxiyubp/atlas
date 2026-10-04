// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Content neutralization for remote text (design `resident-botization.md` §4.5,
 * hermes E7; charter T-7 / `protocol.md` §10.2).
 *
 * WHAT WAS ALREADY DONE, AND WHAT WAS MISSING
 *
 * `wrapper.ts` isolates a remote envelope **structurally**: the remote object
 * never owns the top level (M-2) and the provenance `notice` is written by the
 * receiver from a fixed template (§9.4). Both hold regardless of what the
 * remote says.
 *
 * What neither does is look at the remote `text` itself. That text is handed to
 * the model verbatim, and the base renders a mailbox batch by interpolating it
 * into a tag:
 *
 *     <teammate-message teammate_id="${from}" summary="${summary}">
 *     ${text}
 *     </teammate-message>
 *
 * Nothing escapes anything. A remote `text` containing `</teammate-message>`
 * closes the block early, and everything after it reads as the host's own
 * framing rather than as somebody else's data. A remote `from` containing a
 * quote opens a new attribute. Those are delimiter attacks, and they work
 * whether or not the model is "convinced" of anything — which is the point,
 * because T-7's acceptance bar is written down as **not** "the model was not
 * persuaded".
 *
 * WHAT THIS ESCAPES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * `<` and `>` (plus `"` inside attribute values) become HTML entities. That is
 * the whole of the delimiter surface for a tag-framed prompt: no pseudo-tag, no
 * `<![CDATA[` / `]]>` pair and no partial-tag trick survives it, and it needs no
 * list of known-bad tag names — a matcher for `</teammate-message>` would be
 * walked around with a different case or a space before the `>`.
 *
 * `&` is **not** escaped, on purpose. Escaping it would make the mapping
 * strictly injective, which is tidier, and it would also rewrite every `&&` in
 * every shell snippet a peer sends. The cost is real (an agent that copies the
 * command gets a broken one) and the benefit is cosmetic: leaving `&` alone
 * cannot produce a `<` or a `>`, so no delimiter can be reconstructed from it.
 * Ambiguity between "the peer wrote `&lt;`" and "the peer wrote `<`" is a
 * display detail, not a boundary.
 *
 * Fences are defanged by their first character only, and only when they sit
 * where a fence can actually open — at the start of a line. Rewriting every
 * backtick would destroy inline code for no gain; a run that is not
 * line-leading is not a fence.
 */

/** Line-leading runs of three or more backticks or tildes: a markdown fence. */
const FENCE = /^([`~])\1{2,}/gm

/**
 * The same rule without `g`.
 *
 * A global regexp carries `lastIndex` across `test()` calls, so reusing
 * {@link FENCE} for a predicate would answer differently on identical input
 * depending on what was asked before it — the kind of bug that shows up as one
 * flaky assertion and gets rerun rather than read.
 */
const FENCE_PROBE = /^([`~])\1{2,}/m

const ENTITY: Readonly<Record<string, string>> = Object.freeze({
  '<': '&lt;',
  '>': '&gt;',
  '`': '&#96;',
  '~': '&#126;',
  '"': '&quot;',
})

function entity(character: string): string {
  return ENTITY[character] ?? character
}

/**
 * Neutralize remote text destined for the body of a prompt block.
 *
 * Idempotent in the way that matters: applying it twice cannot manufacture a
 * delimiter, because the output contains no `<` or `>` at all.
 */
export function sanitizeRemoteText(text: string): string {
  return text
    .replace(/[<>]/g, entity)
    .replace(FENCE, match => `${entity(match.charAt(0))}${match.slice(1)}`)
}

/**
 * Neutralize a remote value destined for an attribute value.
 *
 * Same as {@link sanitizeRemoteText} plus the quote that ends an attribute.
 * Separate function rather than a flag because the two call sites are not
 * interchangeable: a body that escaped quotes would mangle ordinary prose, and
 * an attribute that did not would let `from` grow a second attribute.
 */
export function sanitizeRemoteAttribute(value: string): string {
  return sanitizeRemoteText(value).replace(/"/g, entity)
}

/**
 * True when `value` still carries a delimiter this module is meant to remove.
 *
 * Exists so a caller can *assert* rather than trust: the resident's assembled
 * prompt scan uses it to state that sanitization ran, instead of assuming a
 * call somewhere upstream did.
 */
export function hasUnneutralizedDelimiter(value: string): boolean {
  return /[<>]/.test(value) || FENCE_PROBE.test(value)
}
