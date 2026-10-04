// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two documents an invitee sees: the confirmation card behind an
 * invitation link, and the one page that ever shows a personal credential.
 *
 * ## Why the link does nothing until a button is pressed
 *
 * Invitation links travel through chat apps, and chat apps fetch links to
 * draw previews. A `GET` that consumed the invitation would hand the account
 * to the preview bot. So the token rides in the URL **fragment**, which a
 * browser never sends to a server, and `GET /invite` renders this card and
 * nothing else — it does not even know which invitation it is for. The
 * token reaches the server only in the body of the `POST` the button sends,
 * behind the same cross-origin check as the login form (`tenancy-m1.md`
 * §3.1).
 *
 * The one script on the card copies the fragment into the field and scrubs
 * it out of the address bar. It never touches `localStorage`: an invitation
 * is not a credential, and the credential that comes back is not something
 * this console lets page script keep.
 *
 * ## The credential page
 *
 * Shown once, as the answer to that `POST`, with `no-store` on it. The field
 * is read-only; there is no copy button because a copy button is a script
 * that handles the credential, and this page has no script at all.
 */

import type { AccountRole } from '../accounts.js'
import { icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { BRAND, documentHead } from './page.js'

/** How a role reads on these two cards. */
const ROLE_TEXT: Readonly<Record<AccountRole, string>> = {
  viewer: '只读',
  member: '成员',
  ops: '运维',
}

/** Fills the field from `#<token>` and takes the token out of the address bar. */
const FRAGMENT_SCRIPT =
  `(function () {` +
  `var h = window.location.hash || '';` +
  `if (h.length < 2) return;` +
  `var f = document.getElementById('invite');` +
  `if (f && !f.value) f.value = h.slice(1);` +
  `try { history.replaceState(null, '', window.location.pathname); }` +
  ` catch (e) { window.location.hash = ''; }` +
  `})();`

function errorLine(error: string | undefined): string {
  return error === undefined || error === ''
    ? ''
    : `<p class="bar bar-bad" role="alert">${icon('alert-triangle', {
        small: true,
      })}${escapeHtml(error)}</p>`
}

function brand(label: string): string {
  return (
    `<div class="brand">` +
    `<div class="brand-en">AgentNest</div>` +
    `<div class="brand-cn">阡陌</div>` +
    `</div>` +
    `<p class="inst"><b>${escapeHtml(label)}</b></p>`
  )
}

interface InvitePageModel {
  readonly label: string
  /** The line above the field after a refused attempt. */
  readonly error?: string
}

/** `GET /invite`, and the card again after a refusal. */
export function renderInvitePage(model: InvitePageModel): string {
  return (
    documentHead(`${BRAND} · 开通账号 · ${model.label}`) +
    `<body>\n<div class="stage">\n` +
    `<form class="card elev-lg panel" method="post" action="/invite">` +
    brand(model.label) +
    errorLine(model.error) +
    `<div class="field"><label for="invite">邀请码</label>` +
    `<input class="input" type="password" id="invite" name="invite" ` +
    `autocomplete="off" spellcheck="false" ` +
    `placeholder="打开邀请链接时自动填入" required></div>` +
    `<button type="submit" class="btn btn-primary btn-block">` +
    icon('check', { small: true }) +
    `确认开通</button>` +
    `<div class="tokline">` +
    `<div class="tokrow">确认后生成个人凭据 · 只显示一次</div>` +
    `<div class="tokrow">邀请只能用一次 · 过期作废</div>` +
    `</div>` +
    `<p class="foot">没有收到邀请请联系环境负责人</p>` +
    `</form>\n</div>\n` +
    `<script>${FRAGMENT_SCRIPT}</script>\n` +
    `</body>\n</html>\n`
  )
}

interface CredentialPageModel {
  readonly label: string
  readonly role: AccountRole
  /** The plaintext credential. This render is its only appearance. */
  readonly credential: string
  /** True when the same response also signed the browser in. */
  readonly signedIn: boolean
}

/** The answer to a successful `POST /invite`. No script, no cache. */
export function renderCredentialPage(model: CredentialPageModel): string {
  const next = model.signedIn
    ? `<a class="btn btn-primary btn-block" href="/">进入控制台</a>`
    : `<a class="btn btn-primary btn-block" href="/login">去登录</a>`
  return (
    documentHead(`${BRAND} · 个人凭据 · ${model.label}`) +
    `<body>\n<div class="stage">\n` +
    `<div class="card elev-lg panel">` +
    brand(model.label) +
    `<p class="bar bar-warn" role="status">` +
    icon('shield', { small: true }) +
    `个人凭据只显示这一次 · 现在保存</p>` +
    `<div class="field"><label for="credential">个人凭据 · ` +
    `${escapeHtml(ROLE_TEXT[model.role])}</label>` +
    `<input class="input mono" type="text" id="credential" readonly ` +
    `autocomplete="off" spellcheck="false" ` +
    `value="${attr(model.credential)}"></div>` +
    next +
    `<div class="tokline">` +
    `<div class="tokrow">登录时填在凭据框里 · 脚本用 Authorization Bearer</div>` +
    `<div class="tokrow">不要放进链接或书签 · 丢失后找运维重置</div>` +
    `</div>` +
    `</div>\n</div>\n` +
    `</body>\n</html>\n`
  )
}
