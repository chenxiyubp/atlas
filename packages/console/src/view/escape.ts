// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single place a string is allowed to become HTML.
 *
 * ## Why this file exists at all
 *
 * Almost nothing the console prints is the console's own. An address, a
 * capability tag, an endpoint, an audit `kind`, a protocol `code`, every value
 * inside a `detail` map — all of it arrives over the network from *another
 * node*, and the whole point of the network is that those nodes are not under
 * this operator's control. A console that renders one of those strings raw is a
 * console where any peer on the network can run script in the operator's
 * browser, against a page that holds the operator's registry token.
 *
 * So the rule here is not "escape untrusted input", which invites a per-value
 * argument about what is trusted. The rule is **every interpolation goes
 * through one of these two functions**, including the ones the console itself
 * produced. There is no whitelist and no exception; a reviewer only has to look
 * for a `${` that is not wrapped, which is a thing a person can actually check.
 *
 * ## Two functions rather than one
 *
 * {@link escapeHtml} covers the five characters that matter in element
 * content — `& < > " '`. {@link attr} is for attribute position and adds the
 * backtick. Every attribute this package writes is double-quoted, so `"` alone
 * would close it; the backtick is there because old IE treats it as a quote
 * character too, and because an `attr()` that is *stricter* than `escapeHtml`
 * is the right default for the position where an escape failure turns directly
 * into an event handler.
 */

/** Element-content replacements. `undefined` value type keeps the `??` honest. */
const HTML_ESCAPES: Readonly<Record<string, string | undefined>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

const HTML_UNSAFE = /[&<>"']/g
const BACKTICK = /`/g

/**
 * Escape a value for element content.
 *
 * `String(value)` rather than a bare `.replace` on purpose: the types say
 * `string`, but these values were `JSON.parse`d off a socket a moment ago, and
 * a number or `null` sneaking through must degrade to a harmless `"null"`
 * rather than throw and take the whole page down with it.
 */
export function escapeHtml(value: string): string {
  return String(value).replace(HTML_UNSAFE, ch => HTML_ESCAPES[ch] ?? ch)
}

/** Escape a value for a double-quoted attribute. Strictly wider than {@link escapeHtml}. */
export function attr(value: string): string {
  return escapeHtml(value).replace(BACKTICK, '&#96;')
}
