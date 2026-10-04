// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/login` document: one field, one button, and what the two tokens do.
 *
 * ## Why it is a third document rather than a panel on the first
 *
 * The ledger page and the chat page are both things an authenticated operator
 * looks at; this is the door. Rendering it as a state of `renderPage` would
 * mean the roster markup, the wake form and the client script all exist in the
 * response an anonymous caller gets back, which is a wide surface to hand out
 * for the sake of reusing a shell.
 *
 * ## No script at all
 *
 * This is the only page in the package with no `<script>`. The form is a native
 * `POST` to `/login`, so the door still works when script is off, when the
 * client bundle fails to parse, and in the browser somebody keeps around for
 * exactly one job. It also means the page cannot read the credential back out
 * of the field — the cookie it receives is `HttpOnly` and nothing here would
 * know what to do with it anyway (`auth.ts`).
 *
 * ## The shape
 *
 * A panel floating on the cream ground, with two soft blobs behind it. The
 * blobs are inline `<svg>` circles filled from the palette's own tokens, which
 * is the only way this page gets a decorative element at all: there is no build
 * step, no image route, and the CSP allows no host to supply one.
 *
 * The two-role legend under the button is new and is the one thing on this page
 * that is not chrome. Both tokens land on the same field, the console has no
 * account system to tell them apart in advance (`console.md` §8.1), and an
 * operator pasting the view token and then finding no wake button assumes the
 * console is broken. Two lines here cost less than that support round trip.
 *
 * ## What the error line may say
 *
 * Two states, and neither distinguishes "no such token" from "wrong token" —
 * there are only two valid strings on this console and telling a guesser which
 * half of the pair they got close to is free information. The refusal never
 * echoes what was typed, for the same reason `http.ts` never echoes a token
 * into a 401: a credential in a response ends up in a log or a screenshot.
 */

import { icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { BRAND, documentHead } from './page.js'

export interface LoginPageModel {
  /** The instance label, so two consoles in two tabs are told apart. */
  readonly label: string
  /**
   * Where a successful login sends the browser.
   *
   * **Already validated** by `safeRedirect` — this module renders it into a
   * hidden field and does not re-check it, because two places deciding what a
   * safe redirect is would eventually disagree.
   */
  readonly redirect: string
  /** The one line above the field when the last attempt did not work. */
  readonly error?: string
  /**
   * True on a console with personal accounts: the same field then takes a
   * personal credential as well, and the legend says so. Absent, the page is
   * byte for byte what it was.
   */
  readonly accounts?: boolean
}

/** The field label and the button, kept next to each other on purpose. */
const FIELD_LABEL = '令牌'
const SUBMIT_LABEL = '进入'

/** The two decorative blobs. Circles from the palette, no image, no gradient. */
const DECOR =
  `<svg class="deco-a" width="420" height="420" viewBox="0 0 200 200" ` +
  `fill="none" aria-hidden="true">` +
  `<circle cx="80" cy="70" r="76" fill="var(--color-accent-200)"/>` +
  `<circle cx="140" cy="128" r="40" fill="var(--color-accent-2-200)"/></svg>` +
  `<svg class="deco-b" width="460" height="460" viewBox="0 0 200 200" ` +
  `fill="none" aria-hidden="true">` +
  `<circle cx="120" cy="120" r="80" fill="var(--color-accent-2-200)"/>` +
  `<circle cx="58" cy="62" r="34" fill="var(--color-accent-300)"/></svg>`

/** The legend under the button: the two tokens, or credential and tokens. */
function legend(accounts: boolean): string {
  if (!accounts) {
    return (
      `<div class="tokline">` +
      `<div class="tokrow"><span class="tag tag-neutral mono">view</span>` +
      `只读参观 · 看名册与消息链 · 不能唤醒与注销</div>` +
      `<div class="tokrow"><span class="tag tag-accent mono">admin</span>` +
      `可操作 · 注册 唤醒 注销 全部开放</div>` +
      `</div>` +
      `<p class="foot">令牌由环境负责人发放 · 存在浏览器本地 · 退出即清除</p>`
    )
  }
  return (
    `<div class="tokline">` +
    `<div class="tokrow"><span class="tag tag-accent mono">个人</span>` +
    `个人凭据 · 按账号角色开放 · 浏览器只保留会话</div>` +
    `<div class="tokrow"><span class="tag tag-neutral mono">共享</span>` +
    `view 与 admin 令牌 · 迁移期保留</div>` +
    `</div>` +
    `<p class="foot">个人凭据由邀请开通 · 丢失找运维重置 · 退出即结束会话</p>`
  )
}

/** The whole `/login` document. Self-contained: nothing is fetched. */
export function renderLoginPage(model: LoginPageModel): string {
  const accounts = model.accounts === true
  const title = `${BRAND} · 登录 · ${model.label}`
  const error =
    model.error === undefined || model.error === ''
      ? ''
      : `<p class="bar bar-bad" role="alert">${icon('alert-triangle', {
          small: true,
        })}${escapeHtml(model.error)}</p>`

  return (
    documentHead(title) +
    `<body>\n<div class="stage">\n` +
    DECOR +
    `<form class="card elev-lg panel" method="post" action="/login">` +
    `<input type="hidden" name="redirect" value="${attr(model.redirect)}">` +
    `<div class="brand">` +
    `<div class="brand-en">AgentNest</div>` +
    `<div class="brand-cn">阡陌</div>` +
    `</div>` +
    `<p class="inst"><b>${escapeHtml(model.label)}</b></p>` +
    error +
    `<div class="field"><label for="token">` +
    `${escapeHtml(accounts ? '凭据' : FIELD_LABEL)}</label>` +
    // `current-password` rather than `off`: the alternative to a password
    // manager holding a 32-character random string is a text file holding it.
    `<input class="input" type="password" id="token" name="token" ` +
    `autocomplete="current-password" spellcheck="false" ` +
    `placeholder="${accounts ? '粘贴个人凭据或访问令牌' : '粘贴访问令牌'}" ` +
    `autofocus required></div>` +
    `<button type="submit" class="btn btn-primary btn-block">` +
    icon('log-out', { small: true }) +
    `${escapeHtml(SUBMIT_LABEL)}</button>` +
    legend(accounts) +
    `</form>\n</div>\n</body>\n</html>\n`
  )
}
