// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The document the three fragments hang on.
 *
 * `renderPage` owns everything that must survive a refresh: the sidebar, the
 * register form, the wake form, the two confirm dialogs, the mount points, the
 * stylesheet and the script. The fragments own everything that changes.
 * Splitting it that way lets a five-second poller run without taking the
 * keyboard focus out of a half-typed address.
 *
 * ## The shell: a sand panel, and the ledger beside it
 *
 * A 264px panel down the left carrying the wordmark, three nav items and the
 * session controls, with the sections stacked to the right of it. Under 1000px
 * the panel becomes a block above the content, because there is no room left on
 * a phone-width screen for a rail down the side.
 *
 * **The 140px noun rail every row used to open with is gone.** It bought a
 * column of small grey nouns at the cost of 140px on every row of the page, and
 * the counts it carried read better where they came from — beside the section
 * name, on one line, in the header. What replaced it is `sectionHead` (see
 * `bits.ts`): a Latin kicker, the Chinese noun under it, and the section's own
 * numbers on the right.
 *
 * ## The overview cards read the headers, not a second copy of the data
 *
 * `renderRoster` and `renderAudit` already compute the counts their headers
 * print; `renderLimits` already computes the rate and the lease TTL. Rather
 * than give `PageModel` a second, raw shape of the same numbers just so the
 * four cards at the top of the page can have them, the header markup carries
 * them out as `data-*` attributes (see the `stats` option on `sectionHead`) and
 * {@link overviewSection} reads those back off the already-rendered fragment
 * strings. One source of truth for each number, even though it crosses a module
 * boundary as a string rather than as a value.
 *
 * ## Three forms, each with two fields showing and the rest folded away
 *
 * Register keeps 地址 and 端点 in the open (capabilities became four
 * checkboxes with the common one pre-ticked); wake keeps 目标 and 提示词; the
 * trail filter keeps 结果 and 时间. Everything else is behind a native
 * `<details>`, which opens with script disabled and cannot be left half-open by
 * a poll because the poller never touches these forms.
 *
 * The wake form's 回调 box is gone outright. It could only ever hold the one
 * URL the console is pinned to — `createWakePort` refuses any other value —
 * so it was a field that existed to be left empty. It is now a line of read-
 * only small print stating where a receipt will go, and the HTTP side treats
 * the absent field as "use the pinned one" rather than as a 400.
 *
 * ## Two irreversible actions, two confirm dialogs
 *
 * 注销 and 唤醒 each open a dialog that restates *what is about to happen to
 * which address* before the verb is repeated on the confirm button. Both
 * dialogs are rendered here, hidden, and filled in by the client with
 * `textContent` — a dialog inside the polled roster fragment would be replaced
 * out from under the operator mid-read.
 *
 * ## The page loads nothing
 *
 * No stylesheet link, no script src, no font file, no image. CSS and JS are
 * inlined from `../assets/`, every icon is an inline `<svg>`, and the CSP says
 * the same thing in a form the browser enforces: `default-src 'none'` with
 * `connect-src 'self'` for polling. A console that reaches out to a CDN is a
 * console whose contents depend on a third party's good behaviour while it
 * holds a registry token.
 *
 * ## The wake form when there is no PSK
 *
 * `ConsoleDeps.wake` is optional. When it is absent the fields render inside a
 * disabled `<fieldset>` with the reason, and **no submit button at all**. A
 * greyed-out button still invites a click; a missing one, next to the name of
 * the variable, says what to go and do.
 */

import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from '../assets/client.js'
import { CONSOLE_CSS } from '../assets/css.js'
import { NODES_HEADING_ID } from './agents.js'
import {
  chevron,
  icon,
  identityControl,
  sectionHead,
  viewerNotice,
  type PageViewer,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDuration } from './format.js'
import type { ConsoleRole } from '../auth.js'
import type { AuditFilter, WakeTarget } from '../deps.js'

export interface PageModel {
  readonly label: string
  readonly now: number
  /**
   * Which credential this render is for.
   *
   * Required rather than optional: the sidebar states it, and a page that
   * silently forgot to would leave an operator guessing why a button they
   * remember is not there (`bits.ts`, `identityControl`).
   */
  readonly role: ConsoleRole
  /** Output of `renderRoster`. */
  readonly roster: string
  /** Output of `renderAudit`. */
  readonly audit: string
  /** Output of `renderLimits`. */
  readonly limits: string
  /**
   * Output of `renderServers`, when this console knows where its nodes run.
   *
   * Absent leaves the section out of the document entirely rather than
   * rendering an empty one: a console started without `--node-server` has
   * nothing to attribute, and a 服务器 header over a blank box reads as a
   * feature that broke rather than one that was not configured.
   *
   * Unlike the roster and the trail, this markup is **not** polled — it holds
   * a textarea somebody may be halfway through typing (`view/servers.ts`).
   */
  readonly servers?: string
  readonly wakeEnabled: boolean
  readonly auditFilter: AuditFilter
  /**
   * `<option>` markup for every address in the roster, from
   * `wakeTargetOptions`. Empty renders the wake target as a text box, which is
   * the honest fallback when the registry could not be read.
   */
  readonly targetOptions?: string
  /** Where a wake receipt goes. Rendered as read-only small print. */
  readonly wakeUrl?: string
  /** Fixed named wake endpoints; the browser can select but never supply one. */
  readonly wakeTargets?: readonly WakeTarget[]
  /** The address this console speaks as, prefilled into 发起方. */
  readonly identity?: string
  /**
   * Whether `/chat` exists on this instance.
   *
   * Optional, and absent means no: a console started without a chat channel
   * has no chat page to link to, and a nav item that 404s is worse than no
   * nav item. Unlike the wake form, this one is hidden rather than disabled —
   * the wake form is a block inside a page somebody is already looking at,
   * while this is a door to a page that would have nothing on it.
   */
  readonly chatEnabled?: boolean
  /**
   * Who this page is for, when personal accounts are on. Its presence also
   * picks the page script that refuses to keep a personal credential
   * (`assets/client.ts`).
   */
  readonly viewer?: PageViewer
}

/**
 * Content-Security-Policy, as strict as an inline-everything page can be.
 *
 * `'unsafe-inline'` is unavoidable for the one style and the one script — but
 * every *host* directive stays `'none'`, which is the half that matters: no
 * origin other than this one can contribute anything, and `connect-src 'self'`
 * keeps the token from being sent anywhere else.
 *
 * `img-src data:` is the one loosening, and it buys exactly one thing: the
 * favicon, which is an inline SVG data URI in the document head. `data:` is not
 * an origin — nothing can be fetched through it and no third party can put
 * anything there — so the property this policy exists for ("no host other than
 * this one contributes anything") is untouched.
 */
export const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  // `connect-src` also covers `EventSource`: the chat page's stream is a
  // same-origin `GET /v0/chat/stream`, and without this directive the browser
  // would refuse to open it while reporting nothing useful.
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  'img-src data:',
  "font-src 'none'",
].join('; ')

/**
 * The tab mark: 阡 on a terracotta ground, as a data URI.
 *
 * Written out rather than fetched, like everything else on this page. The
 * `xmlns` is mandatory for an SVG that arrives through a `data:` URI — inside
 * the document body an inline `<svg>` inherits the HTML parser's namespace,
 * but a standalone document has nothing to inherit from.
 */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="9" fill="#c67139"/>' +
      '<text x="16" y="23" font-size="21" font-family="serif" ' +
      'text-anchor="middle" fill="#f5ead8">阡</text></svg>',
  )

const REFRESH_CHOICES: readonly (readonly [string, string])[] = [
  ['2000', '2s'],
  ['5000', '5s'],
  ['10000', '10s'],
  ['30000', '30s'],
]

const DEFAULT_REFRESH = '5000'

/** Wake delay ceiling, matching the one `createWakePort` enforces. */
const MAX_WAKE_AFTER_MS = 60_000

/** The capabilities the register form offers as ticks rather than as prose. */
const CAPABILITY_CHOICES: readonly (readonly [string, boolean])[] = [
  ['task.request', true],
  ['task.result', false],
  ['chat.message', false],
  ['audit.read', false],
]

/**
 * The product mark. The instance name sits beside it, never merged into it.
 *
 * Exported because all three documents put it in their `<title>` and one string
 * spelled three times is three strings.
 */
export const BRAND = '阡陌 console'

const WORDMARK_CN = '阡陌'
const WORDMARK_EN = 'AgentNest'

/**
 * The filter, as the query string the poller replays.
 *
 * Instants go out as epoch milliseconds — exact and zone-free. The filter form
 * beside it can only emit `datetime-local` strings, so the HTTP side has to
 * read both shapes anyway; given that, the poller uses the precise one.
 *
 * A relative `window` is replayed as itself, and its resolved `from` is left
 * out: "the last 24 hours" has to keep meaning that on the next poll, not the
 * instant it happened to resolve to when the page was first rendered.
 */
function auditQuery(filter: AuditFilter): string {
  const params = new URLSearchParams()
  const put = (key: string, value: string | number | undefined) => {
    if (value === undefined) return
    const text = String(value)
    if (text !== '') params.set(key, text)
  }
  put('source', filter.source)
  put('outcome', filter.outcome)
  put('traceId', filter.traceId)
  put('taskId', filter.taskId)
  put('agent', filter.agent)
  if (filter.window === undefined) {
    put('from', filter.from)
    put('to', filter.to)
  } else {
    put('window', filter.window)
  }
  put('limit', filter.limit)
  return params.toString()
}

function field(
  name: string,
  label: string,
  placeholder: string,
  options: { readonly required?: boolean; readonly wide?: boolean } = {},
): string {
  const cls = options.wide === true ? 'field field-wide' : 'field'
  // Required is a bare asterisk after the label, not a red tag. Colour on this
  // page means state, and "you have not typed this yet" is not a state of the
  // network.
  const mark = options.required === true ? '<i class="req">*</i>' : ''
  const required = options.required === true ? ' required' : ''
  const id = `f-${name}`
  return (
    `<div class="${cls}"><label for="${attr(id)}">${escapeHtml(
      label,
    )}${mark}</label>` +
    `<input class="input" type="text" id="${attr(id)}" name="${attr(name)}" ` +
    `placeholder="${attr(
      placeholder,
    )}" autocomplete="off" spellcheck="false"${required}></div>`
  )
}

/** One section, header on top of its body. */
function section(
  id: string,
  head: string,
  body: string,
  extraClass = '',
): string {
  const cls = extraClass === '' ? 'sec' : `sec ${extraClass}`
  return `<section class="${cls}" id="${attr(id)}">${head}${body}</section>`
}

function capabilityChecks(): string {
  return CAPABILITY_CHOICES.map(
    ([value, on]) =>
      `<label class="chk"><input type="checkbox" name="capabilities" ` +
      `value="${attr(value)}"${on ? ' checked' : ''}><span class="bx">` +
      icon('check', { small: true }) +
      `</span><span class="mono">${escapeHtml(value)}</span></label>`,
  ).join('')
}

function registerForm(): string {
  return (
    `<form id="register-form" class="card elev-sm" novalidate>` +
    `<div class="form-grid">` +
    field('address', '地址', 'qianmo://node-a/reviewer', { required: true }) +
    // The registry's isValidEndpoint takes a schemed URL (ws:// et al.) or a
    // qianmo:// address — a bare host:port is refused with a 400. The
    // placeholder must teach a format that will actually be accepted.
    field('endpoint', '端点', 'ws://主机:端口 · 也接受 qianmo:// 地址', {
      required: true,
    }) +
    `</div>` +
    `<div class="field"><span>能力</span>` +
    `<div class="rowx" style="gap:var(--space-2)">${capabilityChecks()}</div>` +
    `</div>` +
    `<details class="adv"><summary>${chevron()}高级选项 · 状态与公钥</summary>` +
    `<div class="adv-body">` +
    `<div class="field"><label for="f-status">状态 · 默认在线</label>` +
    `<span class="sel"><select class="input" id="f-status" name="status">` +
    `<option value="online" selected>在线</option>` +
    `<option value="dormant">休眠</option>` +
    `</select>${chevron()}</span></div>` +
    `<div class="field field-wide"><label for="f-publicKey">` +
    `公钥 · 可选 · 留空则该地址不参与签名校验</label>` +
    `<textarea class="input" id="f-publicKey" name="publicKey" rows="3" ` +
    `spellcheck="false" placeholder="ed25519 公钥 · base64"></textarea></div>` +
    `</div></details>` +
    `<div class="rowx">` +
    `<button type="submit" class="btn btn-primary">` +
    icon('plus', { small: true }) +
    `注册</button>` +
    `<span class="note">注册即获得一份租约 · 到期前必须续心跳</span>` +
    `</div>` +
    `</form>` +
    `<p class="status" id="register-status" role="status"></p>`
  )
}

/**
 * The one disabled-state sentence the page is allowed.
 *
 * Both halves are load-bearing: what is unavailable, and the exact name of the
 * thing to go and set. "唤醒不可用" on its own sends somebody to the docs.
 */
const WAKE_DISABLED_REASON = '唤醒不可用 · 未设置 QIANMO_TRANSPORT_PSK'

function wakeTarget(options: string | undefined): string {
  if (options === undefined || options === '') {
    return field('to', '目标', 'qianmo://node-b/reviewer', { required: true })
  }
  return (
    `<div class="field"><label for="wake-to">目标</label>` +
    `<span class="sel"><select class="input" id="wake-to" name="to">` +
    `${options}</select>${chevron()}</span></div>`
  )
}

function wakeReceipt(url: string | undefined): string {
  if (url === undefined || url === '') return ''
  return (
    `<div class="hintline" style="margin-top:var(--space-2)">` +
    icon('info', { small: true }) +
    `唤醒回执 · <span class="mono">${escapeHtml(url)}</span></div>`
  )
}

function wakeNodeTargets(targets: readonly WakeTarget[] | undefined): string {
  if (targets === undefined || targets.length === 0) return ''
  const options = targets
    .map(target => {
      const suffix = target.wake === undefined ? ' · PSK 不可用' : ' · 已配置'
      return (
        '<option value="' +
        attr(target.node) +
        '"' +
        (target.wake === undefined ? ' disabled' : '') +
        '>' +
        escapeHtml(target.node + suffix) +
        '</option>'
      )
    })
    .join('')
  return (
    '<div class="field"><label for="wake-node">唤醒节点</label>' +
    '<span class="sel"><select class="input" id="wake-node" name="node">' +
    options +
    '</select>' +
    chevron() +
    '</span></div>'
  )
}

function wakeBody(model: PageModel): string {
  const identity = model.identity ?? ''
  const fields =
    `<div class="form-grid wake-grid">` +
    `<div>${wakeNodeTargets(model.wakeTargets)}${wakeTarget(model.targetOptions)}${wakeReceipt(model.wakeUrl)}</div>` +
    `<div class="field"><label for="wake-prompt">提示词<i class="req">*</i></label>` +
    `<textarea class="input" id="wake-prompt" name="prompt" rows="4" ` +
    `placeholder="告诉这个智能体要做什么 · 例如 把 packages/console 的 CSS token 按用途分组并回报数量"` +
    `></textarea></div>` +
    `</div>` +
    `<details class="adv"><summary>${chevron()}高级选项 · 发起方与延迟</summary>` +
    `<div class="adv-body">` +
    `<div class="field"><label for="wake-from">发起方 · 已预填当前控制台身份</label>` +
    // readonly, never disabled: a disabled field is not submitted, and the
    // HTTP side still requires `from`.
    `<input class="input" id="wake-from" name="from" value="${attr(
      identity,
    )}"${identity === '' ? '' : ' readonly'}></div>` +
    `<div class="field"><label for="wake-after">延迟（毫秒）· 上限 ${MAX_WAKE_AFTER_MS}</label>` +
    `<input class="input" id="wake-after" name="afterMs" type="number" ` +
    `value="0" min="0" max="${MAX_WAKE_AFTER_MS}"></div>` +
    `</div></details>`

  if (model.wakeEnabled) {
    return (
      `<form id="wake-form" class="card elev-sm" novalidate>${fields}` +
      `<div class="rowx">` +
      `<button type="submit" class="btn btn-primary">` +
      icon('zap', { small: true }) +
      `唤醒</button>` +
      `<span class="note">点一下会先弹确认 · 确认后才真的投递</span>` +
      `</div></form>` +
      `<p class="status" id="wake-status" role="status"></p>`
    )
  }
  return (
    `<div class="card elev-sm">` +
    `<p class="note" id="wake-why">${escapeHtml(WAKE_DISABLED_REASON)}</p>` +
    `<fieldset disabled aria-describedby="wake-why">${fields}</fieldset>` +
    `</div>`
  )
}

function refreshControl(): string {
  const options = REFRESH_CHOICES.map(
    ([value, label]) =>
      `<option value="${attr(value)}"${
        value === DEFAULT_REFRESH ? ' selected' : ''
      }>${escapeHtml(label)}</option>`,
  ).join('')
  return (
    `<div class="stack" style="gap:var(--space-2)">` +
    `<div class="flabel">刷新</div>` +
    `<div class="fblock">` +
    `<label class="sw"><input type="checkbox" id="auto-refresh" checked>` +
    `<span class="trk"></span>自动刷新</label>` +
    `<span class="sel"><select class="input btn-small" id="refresh-interval" ` +
    `aria-label="刷新间隔">${options}</select></span>` +
    `</div><span id="refresh-state"></span></div>`
  )
}

/**
 * The token box, folded away.
 *
 * A console reached with a cookie never needs it, and one reached with a
 * `?token=` link has already stored the token by the time the page paints — so
 * an always-open password field beside the logout button is a field whose only
 * everyday function is to be ignored. Behind a disclosure it is still one click
 * from "look at this console as the other role for a minute".
 */
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
 * Three nav items, not five.
 *
 * The five anchors this replaced were a jump list down a page that is six
 * screens tall — 总览 and 节点 landed within 200px of each other, and 注册 and
 * 唤醒 are forms an operator arrives at by scrolling past the thing they are
 * about to act on. What is left is the three *places* this console has: the
 * ledger, the conversation, and the ceilings.
 */
function sidebarNav(model: PageModel, nodes: string | null): string {
  const count =
    nodes === null ? '' : `<span class="cnt">${escapeHtml(nodes)} 节点</span>`
  // The client rewrites the chat href to carry the token before it can be
  // clicked, when there is one in `localStorage`: a top-level navigation sends
  // no `Authorization` header. A cookie session does not need the rewrite — the
  // browser attaches the cookie to the navigation itself (`auth.ts`).
  const chat =
    model.chatEnabled === true
      ? `<a class="nav-item" id="to-chat" href="/chat">` +
        icon('messages-square') +
        `对话</a>`
      : ''
  return (
    `<nav class="nav-list" aria-label="章节">` +
    `<a class="nav-item" href="#nodes-section" aria-current="page">` +
    icon('layout-dashboard') +
    `账本${count}</a>` +
    chat +
    `<a class="nav-item" href="#limits-section">` +
    icon('gauge') +
    `限额</a>` +
    `</nav>`
  )
}

/**
 * The left panel: wordmark, the three places, then the instance identity and
 * the two controls that used to live in a top bar.
 *
 * The clock that used to sit here is gone, element and interval both. It
 * restated the operating system's own menu bar once a second, and every one of
 * those ticks was a write into a page that is otherwise only touched by a
 * five-second poll.
 */
function sidebar(model: PageModel, nodes: string | null): string {
  return (
    `<aside class="side">` +
    `<div class="brand">` +
    `<div class="brand-en">${escapeHtml(WORDMARK_EN)}</div>` +
    `<a class="brand-cn" href="#overview">${escapeHtml(WORDMARK_CN)}</a>` +
    `</div>` +
    sidebarNav(model, nodes) +
    `<div class="side-foot">` +
    `<p class="inst"><b>${escapeHtml(model.label)}</b></p>` +
    `<div class="divider"></div>` +
    refreshControl() +
    `<div class="divider"></div>` +
    `<div class="stack" style="gap:var(--space-2)">` +
    `<div class="flabel">身份</div>` +
    identityControl(model.role, model.viewer?.roleText) +
    tokenControl() +
    `</div>` +
    `</div></aside>`
  )
}

function statCard(card: {
  readonly kicker: string
  readonly value: string
  readonly unit?: string
  readonly hint: string
  readonly glyph: string
  readonly blob?: string
}): string {
  const blob = card.blob === undefined ? 'blob' : `blob ${card.blob}`
  const unit =
    card.unit === undefined
      ? ''
      : `<span class="u">${escapeHtml(card.unit)}</span>`
  return (
    `<div class="card elev-sm stat">` +
    `<div class="stat-top">` +
    `<div class="card-kicker">${escapeHtml(card.kicker)}</div>` +
    `<span class="${blob}">${icon(card.glyph)}</span>` +
    `</div>` +
    `<div class="stat-num">${escapeHtml(card.value)}${unit}</div>` +
    `<div class="card-meta">${card.hint}</div>` +
    `</div>`
  )
}

/**
 * Read one `data-*` number back off a fragment this module did not render.
 *
 * The key is always one of our own literals (see the `stats` note on
 * `sectionHead`), so this is not parsing hostile input — it is one module
 * reading a value another module already computed and escaped, rather than
 * `PageModel` growing a second, raw copy of every count on the page.
 */
function fragmentStat(html: string, key: string): string | null {
  const match = html.match(new RegExp(`data-${key}="([^"]*)"`))
  return match === null ? null : match[1]
}

const OVERVIEW_HEADING_ID = 'h-overview'

/**
 * The four cards above the ledger: how many agents, how much trail (and
 * whether its local and off-host checks agree), how long a lease lasts, and
 * the protocol rate ceiling. Every number here already exists on the page one scroll down —
 * this section is a summary, not a second source, which is why it reads its
 * numbers off the rendered fragments rather than being handed raw data.
 */
function overviewSection(model: PageModel): string {
  const nodesTotal = fragmentStat(model.roster, 'total')
  const nodesOnline = fragmentStat(model.roster, 'online')
  const trailTotal = fragmentStat(model.audit, 'total')
  const trailIssues = fragmentStat(model.audit, 'issues')
  const trailIntact = fragmentStat(model.audit, 'intact')
  const witness = fragmentStat(model.audit, 'witness')
  const auditState = fragmentStat(model.audit, 'audit-state')
  const ttlMs = fragmentStat(model.limits, 'ttl-ms')
  const rate = fragmentStat(model.limits, 'rate')
  const issues = trailIssues === null ? 0 : Number(trailIssues)

  const cards = [
    statCard({
      kicker: '智能体',
      value: nodesTotal ?? '—',
      hint:
        nodesOnline === null
          ? '—'
          : `<span class="tone-ok">在线 ${escapeHtml(nodesOnline)}</span>`,
      glyph: 'server',
    }),
    statCard({
      kicker: '消息链',
      value: trailTotal ?? '—',
      hint:
        auditState === 'unavailable'
          ? `<span class="tag tag-neutral">部分未读取</span>`
          : // Ahead of every integrity verdict: a chain that is not there has
            // none, and this card's whole job is to stop reading that as 完整.
            auditState === 'absent'
            ? `<span class="tag tag-accent">未建立</span>`
            : auditState === 'tampered'
              ? `<span class="tag tag-critical">锚点不符</span>`
              : auditState === 'stale' || auditState === 'unwitnessed'
                ? `<span class="tag tag-neutral">未见证</span>`
                : auditState === 'uncovered'
                  ? `<span class="tag tag-neutral">未覆盖</span>`
                  : auditState === 'broken'
                    ? `<span class="tag tag-accent">断裂 ${escapeHtml(
                        String(issues),
                      )}</span>`
                    : auditState === 'verified'
                      ? `<span class="tag tag-accent-2">链完整</span>`
                      : trailIntact === 'false' || issues > 0
                        ? `<span class="tag tag-accent">断裂 ${escapeHtml(
                            String(issues),
                          )}</span>`
                        : witness === 'tampered'
                          ? `<span class="tag tag-critical">锚点不符</span>`
                          : witness === 'verified'
                            ? `<span class="tag tag-accent-2">链完整</span>`
                            : `<span class="tag tag-neutral">未见证</span>`,
      glyph: 'activity',
      blob: 'blob-2',
    }),
    statCard({
      kicker: '注册租约',
      value: ttlMs === null ? '—' : formatDuration(Number(ttlMs)),
      hint: 'TTL · 到期即摘牌',
      glyph: 'clock',
      blob: 'blob-n',
    }),
    statCard({
      kicker: '速率预算',
      value: rate ?? '—',
      unit: '/ 分',
      hint: '节点 × 节点',
      glyph: 'zap',
    }),
  ].join('')

  return section(
    'overview',
    sectionHead('Overview', '总览', { headingId: OVERVIEW_HEADING_ID }),
    `<div class="cards g4">${cards}</div>`,
  )
}

/**
 * The 注销 confirmation.
 *
 * Rendered once, here, hidden. The address, the current state and the note are
 * written in by the client with `textContent` when a row's 注销 is pressed —
 * the dialog cannot live inside the roster fragment, which a poll replaces
 * every five seconds.
 */
function deregisterDialog(): string {
  return (
    `<div class="dialog-backdrop" id="confirm-deregister" hidden>` +
    `<div class="dialog" role="dialog" aria-modal="true" ` +
    `aria-labelledby="confirm-deregister-title">` +
    `<div class="dlg-top"><span class="dlg-icon">` +
    icon('power') +
    `</span><div class="dialog-title" id="confirm-deregister-title">` +
    `注销这个智能体</div></div>` +
    `<div class="dialog-body">` +
    `<div class="recap"><div class="recap-row"><span class="k">地址</span>` +
    `<span class="addr mono" id="confirm-deregister-addr"></span></div></div>` +
    `<p>这个地址会立刻从名册摘除 · 在途消息按丢弃处理 · ` +
    `节点重新注册之前不能再被唤醒</p>` +
    `</div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">取消</button>` +
    `<button type="button" class="btn btn-danger" ` +
    `data-action="confirm-deregister">` +
    icon('power', { small: true }) +
    `注销</button>` +
    `</div></div></div>`
  )
}

/** The 唤醒 confirmation: the target, who is asking, the delay, the prompt. */
function wakeDialog(): string {
  return (
    `<div class="dialog-backdrop" id="confirm-wake" hidden>` +
    `<div class="dialog" role="dialog" aria-modal="true" ` +
    `aria-labelledby="confirm-wake-title">` +
    `<div class="dlg-top"><span class="dlg-icon dlg-icon-2">` +
    icon('zap') +
    `</span><div class="dialog-title" id="confirm-wake-title">` +
    `唤醒这个智能体</div></div>` +
    `<div class="dialog-body">` +
    `<div class="recap">` +
    `<div class="recap-row"><span class="k">目标</span>` +
    `<span class="addr mono" id="confirm-wake-to"></span></div>` +
    `<div class="recap-row"><span class="k">发起方</span>` +
    `<span class="addr mono" id="confirm-wake-from"></span></div>` +
    `<div class="recap-row"><span class="k">延迟</span>` +
    `<span class="mono" id="confirm-wake-after"></span></div>` +
    `</div>` +
    `<p class="note">提示词</p>` +
    `<p class="quote" id="confirm-wake-prompt"></p>` +
    `</div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">再改改</button>` +
    `<button type="button" class="btn btn-primary" ` +
    `data-action="confirm-wake">` +
    icon('zap', { small: true }) +
    `唤醒</button>` +
    `</div></div></div>`
  )
}

/** The `<head>` every one of the three documents shares. */
export function documentHead(title: string): string {
  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${attr(CSP)}">\n` +
    `<link rel="icon" href="${attr(FAVICON)}">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>${CONSOLE_CSS}</style>\n` +
    `</head>\n`
  )
}

/** The whole document. Self-contained: nothing is fetched from anywhere. */
export function renderPage(model: PageModel): string {
  const title = `${BRAND} · ${model.label}`
  const nodes = fragmentStat(model.roster, 'total')

  const overview = overviewSection(model)

  const roster = section(
    'nodes-section',
    '',
    `<div id="roster">${model.roster}</div>`,
  )

  // Directly under the roster, because it answers the question the roster
  // raises: every endpoint up there reads 127.0.0.1 on a tunnelled fleet.
  const servers =
    model.servers === undefined
      ? ''
      : `${section('servers-section', '', `<div id="servers">${model.servers}</div>`)}\n`

  const register = section(
    'register',
    sectionHead('Register', '注册', {
      sub: true,
      tail: `<span class="note">常驻两个字段 · 状态与公钥折叠</span>`,
    }),
    registerForm(),
  )

  const wake = section(
    'wake-section',
    sectionHead('Wake', '唤醒', {
      headingId: 'h-wake',
      tail: `<span class="note">目标取自名册 · 发起方与延迟折叠</span>`,
    }),
    wakeBody(model),
  )

  const trail = section(
    'trail-section',
    '',
    `<div id="audit" data-query="${attr(auditQuery(model.auditFilter))}">` +
      `${model.audit}</div>` +
      `<div class="chain-panel" id="chain" hidden></div>`,
  )

  const limits = section(
    'limits-section',
    sectionHead('Limits', '限额', {
      headingId: 'h-limits',
      tail: `<span class="note">只读 · 数值真源在 @qianmo/protocol 的 LIMITS</span>`,
    }),
    `<div class="card elev-sm" id="limits">${model.limits}</div>`,
  )

  return (
    documentHead(title) +
    `<body>\n` +
    `<div class="shell">\n` +
    sidebar(model, nodes) +
    `\n<main class="main" aria-labelledby="${NODES_HEADING_ID}">\n` +
    viewerNotice(model.viewer) +
    `${overview}\n${roster}\n${servers}${wake}\n${trail}\n${register}\n${limits}\n` +
    `</main>\n</div>\n` +
    deregisterDialog() +
    (model.wakeEnabled ? wakeDialog() : '') +
    `\n<script>${
      model.viewer === undefined
        ? CONSOLE_CLIENT_JS
        : CONSOLE_CLIENT_JS_ACCOUNTS
    }</script>\n` +
    `</body>\n</html>\n`
  )
}
