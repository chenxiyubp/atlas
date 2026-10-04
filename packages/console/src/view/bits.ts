// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The small shapes every section reuses.
 *
 * Kept in one file so a failure reads the same in the node roster as in the
 * trail. A console where "registry unreachable" and "trail unreadable" look
 * like two different kinds of event trains the operator to skim past one.
 *
 * ## Colour states a fact, and shape states it a second time
 *
 * {@link state} and {@link toned} are the only two functions here that emit a
 * colour, and both of them are saying something about the network: 在线 /
 * 滞后 / 过期, 通过 / 拒绝 / 丢弃, 断裂. Each of the four status dots is also a
 * different *shape* — filled disc, hollow terracotta ring, hollow neutral ring,
 * neutral bar — so a roster read without colour vision still separates them.
 * The accent hue is spent on exactly two things that are not facts: the primary
 * action and the focus ring.
 *
 * ## Icons are inline, never fetched
 *
 * {@link icon} emits a Lucide shape as an inline `<svg>`. The stylesheet is
 * forbidden from containing `url(`, the CSP forbids every off-origin host, and
 * the `<select>` chevrons are absolutely positioned copies of the same markup
 * rather than a background image — so the whole icon set is one `switch` and no
 * request. Decorative icons carry `aria-hidden`; an icon-only button carries an
 * `aria-label` at its call site.
 */

import { attr, escapeHtml } from './escape.js'
import type { ConsoleRole } from '../auth.js'
import type { ConsoleFailure } from '../deps.js'

export type Tone = 'ok' | 'warn' | 'bad' | 'critical' | 'muted'

/** The Lucide shapes this console draws with. Paths, not a font, not a sprite. */
const ICON_PATHS: Readonly<Record<string, string>> = {
  'layout-dashboard':
    '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/>' +
    '<rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
  'messages-square':
    '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/>' +
    '<path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  server:
    '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>' +
    '<path d="M6 6h.01"/><path d="M6 18h.01"/>',
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  'log-out':
    '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  'refresh-cw':
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  'alert-triangle':
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/>',
}

/**
 * One inline icon.
 *
 * `name` is always one of this module's own literals — an unknown name renders
 * an empty frame rather than throwing, because a missing glyph must never be
 * the reason a roster fails to render.
 */
export function icon(
  name: keyof typeof ICON_PATHS | string,
  options: { readonly small?: boolean; readonly cls?: string } = {},
): string {
  const size = options.small === true ? 'i-sm' : 'i'
  const extra = options.cls === undefined ? '' : ` ${options.cls}`
  return (
    `<svg class="${attr(size)}${attr(extra)}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2.75" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ''}</svg>`
  )
}

/** The disclosure chevron, which also rotates when its `<details>` is open. */
export function chevron(): string {
  return icon('chevron-down', { small: true, cls: 'chev' })
}

/** A one-line strip. Facts and a number, never a paragraph. */
export function bar(tone: Tone, text: string, extraClass = ''): string {
  const cls = `bar bar-${tone}${extraClass === '' ? '' : ` ${extraClass}`}`
  return `<p class="${cls}">${escapeHtml(text)}</p>`
}

/**
 * What went wrong, as a verb the subject can carry.
 *
 * `注册中心` + `unreachable` reads out as `注册中心不可达 · 连接被拒绝`: the
 * thing, what happened to it, then the detail. The old strip said
 * `注册中心 · <message>`, which made every failure depend on the port having
 * written a good sentence — and the ports write what their transport handed
 * them.
 *
 * The raw `code` still rides at the end even though `deps.ts` calls it "for
 * tests, not for users": when an operator files a bug report it is the one part
 * of the string that survives being retyped by hand.
 */
const FAILURE_LEAD: Readonly<Record<ConsoleFailure['code'], string>> = {
  unreachable: '不可达',
  // 与 `rejected` 分开的两个词，不是同义反复：`rejected` 是本机这一侧不让发，
  // `refused` 是对端收到了并自己决定不做。读起来必须能看出该去查谁（issue #29）。
  refused: '被对端拒绝',
  rejected: '被拒绝',
  not_found: '未找到',
  unsupported: '不支持',
  invalid: '无效',
}

export function failureBar(failure: ConsoleFailure, subject: string): string {
  const lead = `${subject}${FAILURE_LEAD[failure.code] ?? '出错'}`
  return (
    `<p class="bar bar-bad" role="alert">` +
    icon('alert-triangle', { small: true }) +
    `<span>${escapeHtml(lead)} · ${escapeHtml(failure.message)}</span>` +
    `<code class="bar-code">${escapeHtml(failure.code)}</code></p>`
  )
}

/**
 * A status dot and a word.
 *
 * The class names (`state`, `dot`, `dot-<tone>`) are a contract with
 * `assets/chatClient.ts`, which repaints the composer's dot by writing
 * `dot dot-<tone>` into `className`. The stylesheet gives each of the four a
 * different shape as well as a different colour.
 */
export function state(tone: Tone, text: string): string {
  return (
    `<span class="state"><span class="dot dot-${tone}"></span>` +
    `${escapeHtml(text)}</span>`
  )
}

/**
 * A word in the colour of the thing it is reporting, with no dot.
 *
 * For the dense count lines, where a row of dots would turn the line into
 * beadwork.
 */
export function toned(tone: Tone, text: string): string {
  return `<span class="tone-${tone}">${escapeHtml(text)}</span>`
}

/** A pill-shaped label: capability tags, active filters, id fragments. */
export function chip(text: string, title?: string): string {
  const attrs = title === undefined ? '' : ` title="${attr(title)}"`
  return `<span class="chip mono"${attrs}>${escapeHtml(text)}</span>`
}

/**
 * Split `qianmo://<node>/<agent>` into its two halves.
 *
 * Forgiving on purpose: this string came off the network. Anything that does
 * not have both halves is reported as a node with no agent segment, which
 * renders as the whole address — visible and inert, rather than dropped.
 */
export function splitAddress(value: string): {
  readonly node: string
  readonly agent: string
} {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/]+)\/(.+)$/i.exec(value)
  if (match === null) return { node: value, agent: '' }
  return { node: `${match[1] ?? ''}${match[2] ?? ''}`, agent: match[3] ?? '' }
}

/**
 * An address with its agent segment lifted into a pill.
 *
 * The signature element of this console. `qianmo://node-a/reviewer` is a long
 * monospaced string of which exactly one part is what the operator is scanning
 * for; giving that part a terracotta pill is what lets a column of addresses be
 * read at a glance instead of character by character.
 */
export function address(value: string, cls = 'addr'): string {
  const parts = splitAddress(value)
  const title = ` title="${attr(value)}"`
  if (parts.agent === '') {
    return `<span class="${attr(cls)}"${title}>${escapeHtml(value)}</span>`
  }
  return (
    `<span class="${attr(cls)}"${title}>${escapeHtml(parts.node)}/` +
    `<b>${escapeHtml(parts.agent)}</b></span>`
  )
}

/** A pill in one of the three palettes. Facts, never actions. */
export function tag(
  text: string,
  tone: Tone = 'muted',
  title?: string,
): string {
  const palette =
    tone === 'ok' ? 'accent-2' : tone === 'muted' ? 'neutral' : 'accent'
  const attrs = title === undefined ? '' : ` title="${attr(title)}"`
  return `<span class="tag tag-${palette}"${attrs}>${escapeHtml(text)}</span>`
}

/** The empty state. One short line, and nothing else. */
export function hint(text: string): string {
  return `<p class="hint">${escapeHtml(text)}</p>`
}

/**
 * Horizontal scroll container for wide tables. Wide content scrolls inside its
 * own box; the page body never scrolls sideways.
 */
export function scroll(inner: string): string {
  return `<div class="scroll">${inner}</div>`
}

/** For a value that is genuinely absent, so an empty cell is never ambiguous. */
export function absent(): string {
  return '<span class="absent">—</span>'
}

/**
 * A section header: the Latin kicker, the Chinese noun, and whatever the
 * section wants to state on the right.
 *
 * `stats` is echoed onto the header element as `data-*` so `page.ts` can build
 * the overview cards out of numbers a fragment already computed, rather than
 * `PageModel` growing a second, raw copy of every count on the page. The keys
 * are our own literals, never attacker input, but the values still go through
 * {@link attr} — the discipline in `escape.ts` is "every interpolation", not
 * "every interpolation that looks risky today".
 */
export function sectionHead(
  kicker: string,
  name: string,
  options: {
    readonly id?: string
    readonly headingId?: string
    readonly sub?: boolean
    readonly tail?: string
    readonly stats?: Readonly<Record<string, string | number | boolean>>
  } = {},
): string {
  const level = options.sub === true ? 'h3' : 'h2'
  const id = options.id === undefined ? '' : ` id="${attr(options.id)}"`
  const headingId =
    options.headingId === undefined ? '' : ` id="${attr(options.headingId)}"`
  const statsAttrs =
    options.stats === undefined
      ? ''
      : Object.entries(options.stats)
          .map(([key, value]) => ` data-${key}="${attr(String(value))}"`)
          .join('')
  const tail = options.tail === undefined ? '' : options.tail
  return (
    `<div class="sec-head"${id}${statsAttrs}>` +
    `<div><div class="kicker">${escapeHtml(kicker)}</div>` +
    `<${level}${headingId}>${escapeHtml(name)}</${level}></div>` +
    tail +
    `</div>`
  )
}

/** The `·` between two numbers on a count line. Quiet enough to be a comma. */
export function railSep(): string {
  return '<span class="sep">·</span>'
}

/**
 * Which of the two credentials this page is being read with, and the way out.
 *
 * Both halves earn their pixels. The admin token is a strict superset of the
 * view token (`auth.ts`), so an operator holding one has no way to tell from
 * the page which one it is — until something is missing and the page looks
 * broken rather than restricted. And a console whose credential lives in a
 * cookie needs a door out of it: before the login page existed, "use a
 * different token" meant editing a URL; with an `HttpOnly` cookie it would
 * otherwise mean opening the browser's cookie settings.
 *
 * The logout control is a native form rather than a button the script wires up,
 * so it keeps working on the same terms as the login page it leads back to.
 * `none` renders nothing: a page reached without a credential is not a page
 * this function is ever asked about.
 */
const ROLE_TEXT: Readonly<Record<ConsoleRole, string>> = {
  admin: '管理',
  view: '只读',
  none: '',
}

export function identityControl(role: ConsoleRole, roleText?: string): string {
  if (role === 'none') return ''
  return (
    `<div class="fblock identity">` +
    `<span class="tag tag-accent" id="role">` +
    icon('shield', { small: true }) +
    `${escapeHtml(roleText ?? ROLE_TEXT[role])}</span>` +
    `<form id="logout-form" method="post" action="/logout">` +
    `<button type="submit" class="btn btn-ghost">` +
    icon('log-out', { small: true }) +
    `退出</button></form>` +
    `</div>`
  )
}

/**
 * Who a page is rendered for, when personal accounts are on
 * (`tenancy-m1.md` §3). Absent on a console without accounts, and then every
 * page is byte for byte what it was.
 */
export interface PageViewer {
  /** The role chip's text, in place of the two legacy ones. */
  readonly roleText: string
  /**
   * One line lit at the top of the page and never dismissed: break-glass in
   * use, the account book closed, an admin token that was used and not yet
   * rotated (§3.4 ②④).
   */
  readonly notice?: string
}

/** The lit line a {@link PageViewer} may carry. */
export function viewerNotice(viewer: PageViewer | undefined): string {
  if (viewer?.notice === undefined) return ''
  return (
    `<p class="bar bar-warn" role="alert" id="account-notice">` +
    icon('alert-triangle', { small: true }) +
    `${escapeHtml(viewer.notice)}</p>`
  )
}
