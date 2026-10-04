// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/chat` document.
 *
 * Same shell as the ledger page — the 264px sand panel, the tokens from
 * `assets/css.ts`, everything inlined so the page still loads nothing from
 * anywhere — with a different body: the panel carries the session rail instead
 * of a register form, and the content pane is a transcript above a composer.
 *
 * ## What survives a refresh and what does not
 *
 * The two mount points (`#chat-sessions`, `#chat-thread`) are replaced by the
 * poller and by the stream; the composer is not. That split is the reason the
 * composer's target chips are filled in by the client from `data-*` on the
 * thread rather than rendered here: a `<textarea>` holding half a question must
 * never be inside a region that a stream event can replace.
 *
 * ## The composer with nothing open
 *
 * Rendered disabled, with the reason, and with the controls left in place. This
 * is the opposite of the wake form's answer on the ledger page, and the two
 * absences are different: no PSK is a **configuration** state that a click will
 * never fix, while "no session open" is a **transient** state one click away in
 * the rail beside it. So the controls stay, disabled, with the sentence that
 * says which click — and the client re-enables them in place when a session
 * opens, without a navigation (see `assets/chatClient.ts` on why a navigation
 * would drop the credential).
 */

import {
  CONSOLE_CHAT_JS,
  CONSOLE_CHAT_JS_ACCOUNTS,
} from '../assets/chatClient.js'
import {
  chevron,
  icon,
  identityControl,
  viewerNotice,
  type PageViewer,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { MAX_CHAT_TEXT_LENGTH } from './chat.js'
import { BRAND, documentHead } from './page.js'
import type { ConsoleRole } from '../auth.js'

export interface ChatPageModel {
  readonly label: string
  readonly now: number
  /** Which credential this render is for. Always `admin` in practice (§4.5). */
  readonly role: ConsoleRole
  /** Output of `renderChatSessions`. */
  readonly sessions: string
  /** Output of `renderChatThread`. */
  readonly thread: string
  /** False when no session is open, which disables the composer. */
  readonly composerEnabled: boolean
  /** Who this page is for, when personal accounts are on (`page.ts`). */
  readonly viewer?: PageViewer
}

/** The one disabled-state sentence this page is allowed. */
const COMPOSER_DISABLED_REASON = '先选一条会话 · 再发消息'

/** Folded away for the same reason as on the ledger page — see `page.ts`. */
function tokenControl(): string {
  return (
    `<details class="adv"><summary>${chevron()}换令牌</summary>` +
    `<div class="adv-body" style="grid-template-columns:minmax(0,1fr)">` +
    `<div class="field"><label for="token">令牌</label>` +
    `<input class="input" type="password" id="token" autocomplete="off" ` +
    `spellcheck="false" placeholder="粘贴新令牌"></div>` +
    `<div class="rowx" style="gap:var(--space-2)">` +
    `<button type="button" class="btn btn-primary btn-small" ` +
    `data-action="token-save">保存</button>` +
    `<button type="button" class="btn btn-secondary btn-small" ` +
    `data-action="token-clear">清除</button>` +
    `<span id="token-state"></span></div>` +
    `</div></details>`
  )
}

/**
 * The composer.
 *
 * `Enter` sends and `Shift+Enter` breaks the line — the convention every chat
 * client on the operator's machine already uses, wired in the client script.
 * The round send button is the page's one filled control, matching the ledger
 * page's rule that the accent marks the primary action and nothing else.
 */
function composer(enabled: boolean): string {
  const off = enabled ? '' : ' disabled'
  const box =
    `<textarea id="chat-text" rows="1" spellcheck="false" ` +
    `maxlength="${attr(String(MAX_CHAT_TEXT_LENGTH))}" ` +
    `aria-describedby="composer-why" ` +
    `placeholder="写下要让这个智能体做的事 · Enter 发送 · Shift Enter 换行"${off}></textarea>`

  const foot =
    `<div class="composer-foot">` +
    `<span class="tag tag-neutral mono" id="composer-target">—</span>` +
    `<span class="state" id="composer-state">` +
    `<span class="dot dot-muted" id="composer-dot"></span>` +
    `<span id="composer-state-text">选一条会话</span></span>` +
    `<button type="submit" class="btn btn-primary btn-icon send" ` +
    `id="chat-send" aria-label="发送"${off}>` +
    icon('arrow-up') +
    `</button></div>`

  return (
    `<form class="composer" id="composer" novalidate>` +
    `<p class="note" id="composer-why"${enabled ? ' hidden' : ''}>` +
    `${escapeHtml(COMPOSER_DISABLED_REASON)}</p>` +
    box +
    foot +
    `<p class="status" id="chat-status" role="status"></p>` +
    `</form>`
  )
}

/** The whole `/chat` document. Self-contained: nothing is fetched. */
export function renderChatPage(model: ChatPageModel): string {
  const title = `${BRAND} · 对话 · ${model.label}`

  const sidebar =
    `<aside class="side">` +
    `<div class="brand">` +
    `<div class="brand-en">AgentNest</div>` +
    // The client rewrites this href to carry the token when it has one in
    // `localStorage`: a top-level navigation cannot send an `Authorization`
    // header. Same trick, and the same accepted exposure, as the `?token=` URL
    // the CLI banner prints. A cookie session needs none of it — the browser
    // attaches the cookie to the navigation by itself, which is exactly why
    // documents accept a cookie alone (`auth.ts`).
    `<a class="brand-cn" id="to-console" href="/">阡陌</a>` +
    `</div>` +
    `<nav class="nav-list" aria-label="章节">` +
    `<a class="nav-item" href="/">` +
    icon('layout-dashboard') +
    `账本</a>` +
    `<a class="nav-item" href="/chat" aria-current="page">` +
    icon('messages-square') +
    `对话</a>` +
    `</nav>` +
    `<div class="divider"></div>` +
    `<div class="chat-rail-mount">${model.sessions}</div>` +
    `<div class="side-foot">` +
    `<p class="inst"><b>${escapeHtml(model.label)}</b></p>` +
    `<div class="divider"></div>` +
    `<div class="fblock"><span class="flabel">实时</span>` +
    `<span id="stream-state"></span></div>` +
    `<div class="divider"></div>` +
    `<div class="stack" style="gap:var(--space-2)">` +
    `<div class="flabel">身份</div>` +
    identityControl(model.role, model.viewer?.roleText) +
    tokenControl() +
    `</div>` +
    `</div></aside>`

  return (
    documentHead(title) +
    `<body>\n` +
    `<div class="shell">\n` +
    sidebar +
    `\n<main class="chat-main">\n` +
    viewerNotice(model.viewer) +
    `<div class="thread-mount" id="thread-mount">${model.thread}</div>\n` +
    composer(model.composerEnabled) +
    `\n</main>\n</div>\n` +
    `<script>${
      model.viewer === undefined ? CONSOLE_CHAT_JS : CONSOLE_CHAT_JS_ACCOUNTS
    }</script>\n` +
    `</body>\n</html>\n`
  )
}
