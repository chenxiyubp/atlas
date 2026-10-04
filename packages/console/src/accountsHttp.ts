// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The HTTP face of personal accounts: the invitation door, the account
 * administration routes, and the account-aware halves of login, logout, the
 * page chrome and the chat scope.
 *
 * | Method | Path | Who | Returns |
 * | --- | --- | --- | --- |
 * | GET | `/invite` | public | `text/html`, the confirmation card; never mints |
 * | POST | `/invite` | public, same-origin | the credential page, once, signed in |
 * | GET | `/v0/accounts` | ops / admin | `{ accounts, invites }`, no secret, no hash |
 * | POST | `/v0/accounts/invites` | ops / admin | `{ inviteId, role, expiresAt, link }` |
 * | DELETE | `/v0/accounts/invites/<id>` | ops / admin | 204 |
 * | POST | `/v0/accounts/<subject>/revoke` | ops / admin | 204 |
 * | POST | `/v0/accounts/<subject>/reset` | ops / admin | `{ subject, inviteId, expiresAt, link }` |
 *
 * None of these exist on a console started without accounts: `http.ts` only
 * routes here when it was handed an {@link AccountBook}, and otherwise the
 * paths fall through to the same 404 they always answered.
 *
 * Role checks for the `/v0/accounts` routes happen in `http.ts`, through the
 * same `guard` every other route uses, before anything here runs — so the
 * protection classes (the console header for a cookie, 401 before 405) are the
 * ones already written down in one place rather than restated here.
 *
 * ## Two cookies, and a login always leaves exactly one
 *
 * During migration a browser can hold the legacy token cookie and a personal
 * session cookie, and `access.ts` tries the legacy one first. So signing in
 * with either kind clears the other — and a personal login closes the session
 * the browser came in with, whoever it belonged to. A logout clears both and
 * closes the server-side session, so the id is dead even in a copy somebody
 * lifted from the browser.
 */

import {
  ACCOUNTS_UNAVAILABLE_LINE,
  ACCOUNT_SESSION_COOKIE,
  ADMIN_BEARER_ONLY_LINE,
  accountSessionCookie,
  adminFingerprint,
  clearedAccountSessionCookie,
  type Access,
  type ConsoleAccounts,
} from './access.js'
import {
  isPersonalCredential,
  type AccountBook,
  type AccountOutcome,
  type AccountRefusal,
  type AccountRole,
  type AccountSubject,
} from './accounts.js'
import {
  LOGIN_PATH,
  SESSION_MAX_AGE_SECONDS,
  clearedSessionCookieHeader,
  cookieOf,
  isCrossOriginRequest,
  isSecureRequest,
  roleOfToken,
  sessionCookieHeader,
  type ConsoleTokens,
} from './auth.js'
import {
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readForm,
  readJsonObject,
  seeOther,
} from './respond.js'
import type { LoginThrottle } from './throttle.js'
import type { PageViewer } from './view/bits.js'
import { renderCredentialPage, renderInvitePage } from './view/invite.js'

/** Everything the invitation door needs from the request that reached it. */
interface InviteDoor {
  readonly book: AccountBook
  readonly label: string
  readonly throttle: LoginThrottle
  readonly clientKey: string
  readonly now: number
}

/** A 303 that sets several cookies: `seeOther` takes one value per header. */
function seeOtherSetting(
  location: string,
  cookies: readonly string[],
): Response {
  const response = seeOther(location)
  for (const cookie of cookies) response.headers.append('set-cookie', cookie)
  return response
}

/** HTTP status for a refusal from the book. */
function statusOf(refusal: AccountRefusal): number {
  switch (refusal.code) {
    case 'unavailable':
      return 503
    case 'refused':
      return 403
    case 'invalid':
      return 400
    case 'not_found':
      return 404
    case 'limit':
      return 429
  }
}

function refusalResponse(refusal: AccountRefusal): Response {
  return fail(statusOf(refusal), refusal.code, refusal.message)
}

/**
 * `GET /invite` and `POST /invite`.
 *
 * The order of the `POST` checks is the point: origin first, so a foreign page
 * cannot spend somebody's invitation; the throttle second, before the book is
 * consulted, so a blocked guesser learns nothing about the token they sent;
 * only then the book, which is the one step that can consume anything.
 */
export async function handleInvite(
  request: Request,
  door: InviteDoor,
): Promise<Response> {
  if (request.method === 'GET') {
    return html(renderInvitePage({ label: door.label }))
  }
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST'])

  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '开通只接受来自本控制台自己页面的提交。')
  }
  const form = await readForm(request)
  if (form === null) return fail(400, 'invalid', '请求体必须是开通表单')

  const wait = door.throttle.retryAfterSeconds(door.clientKey, door.now)
  if (wait > 0) {
    const page = html(
      renderInvitePage({
        label: door.label,
        error: `尝试过多 · 请等 ${wait} 秒`,
      }),
      429,
    )
    page.headers.set('retry-after', String(wait))
    return page
  }

  const accepted = door.book.acceptInvite((form.get('invite') ?? '').trim())
  if (!accepted.ok) {
    if (accepted.refusal.code === 'refused') {
      door.throttle.recordFailure(door.clientKey, door.now)
    }
    // The book's own wording is a sentence for a JSON body; the card keeps to
    // one clause, like every page this console renders.
    const error =
      accepted.refusal.code === 'unavailable'
        ? ACCOUNTS_UNAVAILABLE_LINE
        : accepted.refusal.message
    return html(
      renderInvitePage({ label: door.label, error }),
      statusOf(accepted.refusal),
    )
  }
  door.throttle.clear(door.clientKey)

  // Signed in by the same response, on a session id minted here; whatever
  // session cookie the browser arrived with is closed, not adopted. If the
  // session cannot be opened the credential page is shown anyway — it is the
  // credential's only appearance — and points at the login door instead.
  const secure = isSecureRequest(request)
  const session = door.book.sessionFor(
    accepted.value.subject,
    cookieOf(request, ACCOUNT_SESSION_COOKIE),
  )
  const page = html(
    renderCredentialPage({
      label: door.label,
      role: accepted.value.role,
      credential: accepted.value.credential,
      signedIn: session.ok,
    }),
  )
  if (session.ok) {
    page.headers.append(
      'set-cookie',
      accountSessionCookie(session.value.sid, secure),
    )
    page.headers.append('set-cookie', clearedSessionCookieHeader({ secure }))
  }
  return page
}

/** What the account half of `POST /login` needs from `http.ts`. */
interface LoginDoor {
  readonly accounts: ConsoleAccounts
  readonly tokens: ConsoleTokens
  readonly throttle: LoginThrottle
  readonly clientKey: string
  readonly now: number
  /** The login card again, at `status`, with one line of reason. */
  readonly card: (status: number, error: string) => Response
}

/** The one answer every credential or token that does not work gets. */
const LOGIN_REFUSED = '凭据无效'

/**
 * `POST /login` on a console with accounts, after the origin check, the form
 * and the throttle — `http.ts` runs those exactly as it always has.
 *
 * A personal credential opens a server session; a legacy token sets the
 * legacy cookie as before, subject to the two migration switches. Either way
 * the other cookie is cleared (module note). The admin token in break-glass is
 * refused here with the reason rather than as a bad token: whoever typed it
 * knows it is right, and a "凭据无效" would send them looking for a typo.
 */
export function accountLogin(
  request: Request,
  presented: string,
  target: string,
  door: LoginDoor,
): Response {
  const secure = isSecureRequest(request)
  const previous = cookieOf(request, ACCOUNT_SESSION_COOKIE)
  const book = door.accounts.book

  if (isPersonalCredential(presented)) {
    const opened = book.login(presented, previous)
    if (!opened.ok) {
      if (opened.refusal.code === 'unavailable') {
        return door.card(503, ACCOUNTS_UNAVAILABLE_LINE)
      }
      door.throttle.recordFailure(door.clientKey, door.now)
      return door.card(401, LOGIN_REFUSED)
    }
    door.throttle.clear(door.clientKey)
    return seeOtherSetting(target, [
      accountSessionCookie(opened.value.sid, secure),
      clearedSessionCookieHeader({ secure }),
    ])
  }

  const role = roleOfToken(presented, door.tokens)
  if (
    role === 'none' ||
    (role === 'view' && door.accounts.legacyView === false)
  ) {
    door.throttle.recordFailure(door.clientKey, door.now)
    return door.card(401, LOGIN_REFUSED)
  }
  if (role === 'admin' && door.accounts.breakGlass === true) {
    return door.card(403, ADMIN_BEARER_ONLY_LINE)
  }
  door.throttle.clear(door.clientKey)
  book.logout(previous)
  return seeOtherSetting(target, [
    sessionCookieHeader(presented, {
      secure,
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    }),
    clearedAccountSessionCookie(secure),
  ])
}

/**
 * `POST /logout` on a console with accounts, after the method and origin
 * checks: close the server session and clear both cookies.
 */
export function accountLogout(
  request: Request,
  accounts: ConsoleAccounts,
): Response {
  accounts.book.logout(cookieOf(request, ACCOUNT_SESSION_COOKIE))
  const secure = isSecureRequest(request)
  return seeOtherSetting(LOGIN_PATH, [
    clearedSessionCookieHeader({ secure }),
    clearedAccountSessionCookie(secure),
  ])
}

// --- page chrome ----------------------------------------------------------

const ACCOUNT_ROLE_TEXT: Readonly<Record<AccountRole, string>> = {
  viewer: '只读账号',
  member: '成员账号',
  ops: '运维账号',
}

/** Lit on every page the admin token opens in break-glass (§3.4 ②). */
const BREAK_GLASS_NOTICE =
  'break-glass 会话 · 每次使用都有记录 · 用完请轮换 admin 令牌'

/** Lit while the account book is closed, for whoever can still see a page. */
const UNAVAILABLE_NOTICE =
  '账号库校验未通过 · 个人账号暂停服务 · 详见控制台错误输出'

/** Lit for ops and the admin token once break-glass was used and not rotated. */
const ROTATION_NOTICE = 'admin 令牌用作 break-glass 后还没有轮换'

/**
 * Who a page is rendered for, on a console with accounts. The chip names the
 * kind of credential; the notice is the one line that must not be missed.
 */
export function pageViewer(
  access: Access,
  accounts: ConsoleAccounts,
  tokens: ConsoleTokens,
): PageViewer {
  const principal = access.principal
  const roleText =
    principal === null
      ? ''
      : principal.kind === 'user'
        ? ACCOUNT_ROLE_TEXT[principal.role]
        : principal.subject === 'legacy:view'
          ? '只读令牌'
          : access.breakGlass
            ? 'break-glass'
            : '管理令牌'
  const administers =
    principal !== null &&
    (principal.kind === 'user'
      ? principal.role === 'ops'
      : principal.subject === 'legacy:admin')
  const notice = access.breakGlass
    ? BREAK_GLASS_NOTICE
    : accounts.book.problem !== null
      ? UNAVAILABLE_NOTICE
      : administers &&
          accounts.book.breakGlassStatus(adminFingerprint(tokens)).rotationDue
        ? ROTATION_NOTICE
        : undefined
  return { roleText, ...(notice === undefined ? {} : { notice }) }
}

// --- chat scope -----------------------------------------------------------

/**
 * Which chat sessions a caller may see, and whose a session it opens will be.
 *
 * A `member` sees the sessions its own account opened and nothing else; `ops`
 * and the admin token see all of them, as the admin token always has. The
 * owner is recorded for every session a person opens, ops included, so that
 * P14 can ask whose an approval is (`tenancy-m1.md` §3.5); a session opened
 * with a legacy token has no owner.
 */
export interface ChatScope {
  /** The account a session opened now will belong to. */
  readonly opener: AccountSubject | null
  readonly visible: (sessionId: string) => boolean
}

const EVERY_SESSION: ChatScope = { opener: null, visible: () => true }

export function chatScopeOf(
  access: Access,
  accounts: ConsoleAccounts | undefined,
): ChatScope {
  const principal = access.principal
  if (accounts === undefined || principal?.kind !== 'user') {
    return EVERY_SESSION
  }
  const subject = principal.subject
  if (principal.role === 'ops') return { opener: subject, visible: () => true }
  if (principal.role === 'member') {
    return {
      opener: subject,
      visible: sessionId => accounts.book.ownerOf(sessionId) === subject,
    }
  }
  return { opener: subject, visible: () => false }
}

/**
 * How a person's event stream is kept to its owner and ended with them
 * (§3.3). Absent for a legacy token, whose stream is today's.
 */
export interface StreamScope {
  /** False for an update about a session the caller may not see. */
  readonly visible: (sessionId: string) => boolean
  /** Register with the book so a revocation can end it; returns the release. */
  readonly attach: (close: () => void) => () => void
  /** Re-checked at every heartbeat; false ends the stream. */
  readonly alive: () => boolean
}

export function streamScopeOf(
  access: Access,
  accounts: ConsoleAccounts | undefined,
): StreamScope | undefined {
  const principal = access.principal
  if (accounts === undefined || principal?.kind !== 'user') return undefined
  const book = accounts.book
  const sid = access.sid
  const scope = chatScopeOf(access, accounts)
  return {
    visible: scope.visible,
    attach: close => book.attachStream(principal.subject, sid, close),
    // A session can expire with nobody pushing anything; a bearer has no
    // session to expire, and its revocation or reset is pushed by the book.
    // The re-check does not count as use (`AccountBook.sessionPrincipal`).
    alive: () =>
      sid === null
        ? book.problem === null
        : book.sessionPrincipal(sid, false).ok,
  }
}

/** Longest invitation an issuer may ask for, in the unit the API takes. */
const MAX_TTL_HOURS = 72

/** `ttlHours`, when given, in milliseconds. */
function parseTtl(
  body: Record<string, unknown>,
):
  | { readonly ok: true; readonly ttlMs: number | undefined }
  | { readonly ok: false; readonly message: string } {
  const ttl = body['ttlHours']
  if (ttl === undefined || ttl === null) return { ok: true, ttlMs: undefined }
  if (
    typeof ttl !== 'number' ||
    !Number.isFinite(ttl) ||
    ttl <= 0 ||
    ttl > MAX_TTL_HOURS
  ) {
    return {
      ok: false,
      message: `字段 ttlHours 必须是 0 到 ${MAX_TTL_HOURS} 之间的小时数`,
    }
  }
  return { ok: true, ttlMs: Math.round(ttl * 60 * 60 * 1000) }
}

function parseInviteRequest(body: Record<string, unknown>):
  | {
      readonly ok: true
      readonly role: AccountRole
      readonly ttlMs?: number
      readonly label?: string
    }
  | { readonly ok: false; readonly message: string } {
  const role = body['role']
  if (role !== 'viewer' && role !== 'member' && role !== 'ops') {
    return { ok: false, message: '字段 role 必须是 viewer、member 或 ops' }
  }
  const ttl = parseTtl(body)
  if (!ttl.ok) return ttl
  const ttlMs = ttl.ttlMs
  const rawLabel = body['label']
  let label: string | undefined
  if (rawLabel !== undefined && rawLabel !== null) {
    if (typeof rawLabel !== 'string') {
      return { ok: false, message: '字段 label 必须是字符串' }
    }
    const trimmed = rawLabel.trim()
    if (trimmed !== '') label = trimmed
  }
  return {
    ok: true,
    role,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(label === undefined ? {} : { label }),
  }
}

function answer<T>(
  outcome: AccountOutcome<T>,
  shape: (value: T) => Response,
): Response {
  return outcome.ok ? shape(outcome.value) : refusalResponse(outcome.refusal)
}

/**
 * `/v0/accounts/…`, after `http.ts` has established the caller may administer
 * accounts. `actor` is who the ledger will name: a subject, or `legacy:admin`.
 */
export async function handleAccountsApi(
  request: Request,
  book: AccountBook,
  actor: string,
  segments: readonly string[],
  url: URL,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return answer(book.list(), value => json(value))
  }
  if (segments[2] !== 'invites') {
    const action = segments[3]
    if (segments.length !== 4 || (action !== 'revoke' && action !== 'reset')) {
      return notFound(`unknown path: ${url.pathname}`)
    }
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    const subject = decodeURIComponent(segments[2] ?? '')
    if (action === 'revoke') {
      return answer(
        book.revoke(subject, actor),
        () => new Response(null, { status: 204 }),
      )
    }
    const body = await readJsonObject(request)
    const ttl = parseTtl(body ?? {})
    if (!ttl.ok) return fail(400, 'invalid', ttl.message)
    return answer(book.reset(subject, actor, ttl.ttlMs), invite =>
      json({
        subject,
        inviteId: invite.inviteId,
        expiresAt: invite.expiresAt,
        link: `/invite#${invite.token}`,
      }),
    )
  }
  if (segments.length === 3) {
    if (request.method !== 'POST') return methodNotAllowed(['POST'])
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const parsed = parseInviteRequest(body)
    if (!parsed.ok) return fail(400, 'invalid', parsed.message)
    return answer(
      book.issueInvite({
        role: parsed.role,
        issuedBy: actor,
        ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
        ...(parsed.label === undefined ? {} : { label: parsed.label }),
      }),
      invite =>
        json({
          inviteId: invite.inviteId,
          role: invite.role,
          expiresAt: invite.expiresAt,
          // Relative on purpose: behind a reverse proxy this process does not
          // know the origin the invitee will type, and guessing one is how a
          // link to `http://127.0.0.1:38613` ends up in somebody's chat app.
          // The token is after `#`, so it never reaches a server or a log.
          link: `/invite#${invite.token}`,
        }),
    )
  }
  if (segments.length === 4) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE'])
    return answer(
      book.withdrawInvite(decodeURIComponent(segments[3] ?? ''), actor),
      () => new Response(null, { status: 204 }),
    )
  }
  return notFound(`unknown path: ${url.pathname}`)
}
