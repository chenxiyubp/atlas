// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who is asking, when personal accounts are on (`tenancy-m1.md` §1.1, §3.3,
 * §3.4).
 *
 * ## Beside `auth.ts`, not inside it
 *
 * The legacy rules — two tokens, three positions, `resolveTokens` — are not
 * touched (§3.4: "三条策略一条不改"). This module is the second, separate
 * reading of a request, and the two never call each other's policy: without
 * accounts {@link resolveAccess} is `credentialOf` and nothing else, which is
 * what keeps a console that never turns accounts on byte-for-byte the same.
 *
 * ## Where each credential may ride
 *
 * | Position | Legacy token | Personal credential | Session id |
 * | --- | --- | --- | --- |
 * | `Authorization: Bearer` | yes (admin: the only one in break-glass) | yes — for scripts | — |
 * | `?token=` | yes (not admin in break-glass) | **refused outright** | — |
 * | `qianmo_console` cookie | yes (not admin in break-glass) | never set there | — |
 * | `qianmo_session` cookie | — | — | yes |
 *
 * A personal credential in a query string is not skipped, it is refused with
 * a 400 and the request goes no further: it has already been written into a
 * browser history and an access log, and a console that quietly carried on
 * would teach the habit. It is never looked up either, so the refusal says
 * nothing about whether it was a real one.
 *
 * The positions are tried in the order above and the first that *matches*
 * wins, as `credentialOf` does. A session cookie is last so that a script
 * holding a bearer is never overridden by whatever cookie a shared machine's
 * browser happens to carry.
 *
 * ## What the rest of the HTTP layer sees
 *
 * {@link Access.credential} is the legacy-shaped verdict every existing guard
 * already reads — `ops` reads as `admin`, `viewer` and `member` as `view`, and
 * a session cookie as `cookie`, so the CSRF rules (`auth.ts` module note) apply
 * to it unchanged. {@link Access.principal} is the person, for the routes that
 * care whose something is.
 */

import {
  CONSOLE_HEADER,
  SESSION_COOKIE,
  TOKEN_QUERY_PARAM,
  bearerOf,
  cookieOf,
  credentialOf,
  isCrossOriginRequest,
  roleOfToken,
  type ConsoleCredential,
  type ConsoleRole,
  type ConsoleTokens,
} from './auth.js'
import {
  SESSION_ABSOLUTE_MS,
  isPersonalCredential,
  tokenFingerprint,
  type AccountBook,
  type AccountOutcome,
  type AccountSubject,
  type ConsolePrincipal,
} from './accounts.js'

/**
 * The cookie a personal session rides in. Carries the session id and nothing
 * else — never the credential (§3.3).
 */
export const ACCOUNT_SESSION_COOKIE = 'qianmo_session'

/** Personal accounts, as the HTTP layer receives them (`tenancy-m1.md` §3). */
export interface ConsoleAccounts {
  readonly book: AccountBook
  /**
   * The view token, during migration (§1.5). `false` is M-2b: the view token
   * stops working in every position. Default `true`.
   */
  readonly legacyView?: boolean
  /**
   * M-3: the admin token becomes break-glass (§3.4 D7) — Bearer only, a lit
   * notice on every page, every use recorded, never an approver. Default
   * `false`.
   */
  readonly breakGlass?: boolean
}

/** A request the account rules refuse before any route sees it. */
export interface AccessRefusal {
  readonly status: number
  readonly code: 'invalid' | 'forbidden' | 'unavailable'
  /** For a JSON body: a sentence that says what to do. */
  readonly message: string
  /** For the login card: one clause, in the page's register. */
  readonly line: string
}

/** The whole answer to "who is asking". */
export interface Access {
  /** Legacy-shaped verdict; see the module note. */
  readonly credential: ConsoleCredential
  /** The person or legacy token behind it; `null` when nothing matched. */
  readonly principal: ConsolePrincipal | null
  /** The session id, when the principal came from the session cookie. */
  readonly sid: string | null
  /** Set when the request must be refused whatever it asked for. */
  readonly refusal: AccessRefusal | null
  /** True when this is the admin token in break-glass mode. */
  readonly breakGlass: boolean
}

const PERSONAL_IN_QUERY =
  '个人凭据不能放在链接里：它已经进了浏览器历史与访问日志，请让运维重置。' +
  '浏览器请在登录页登录，脚本请用 Authorization: Bearer。'

const PERSONAL_IN_QUERY_LINE = '个人凭据不能放进链接 · 请找运维重置'

const ADMIN_BEARER_ONLY =
  'admin 令牌已转为 break-glass，只接受 Authorization: Bearer；' +
  '日常请用个人 ops 账号登录。'

/** Also what the login form says to the admin token in break-glass. */
export const ADMIN_BEARER_ONLY_LINE =
  'admin 令牌只接受 Bearer 头 · 日常请用个人运维账号'

/** What the login card says while the account book is closed. */
export const ACCOUNTS_UNAVAILABLE_LINE = '个人账号暂停服务 · 请联系运维'

function legacyPrincipal(
  credential: ConsoleCredential,
): ConsolePrincipal | null {
  if (credential.role === 'none') return null
  return {
    kind: 'legacy',
    subject: credential.role === 'admin' ? 'legacy:admin' : 'legacy:view',
    credential: credential.source === 'cookie' ? 'session' : 'bearer',
  }
}

function roleOfPrincipal(principal: ConsolePrincipal): ConsoleRole {
  if (principal.kind === 'legacy') {
    return principal.subject === 'legacy:admin' ? 'admin' : 'view'
  }
  return principal.role === 'ops' ? 'admin' : 'view'
}

function unavailable(message: string): AccessRefusal {
  return {
    status: 503,
    code: 'unavailable',
    message,
    line: ACCOUNTS_UNAVAILABLE_LINE,
  }
}

/**
 * Resolve who is asking. Without accounts this is exactly `credentialOf`.
 *
 * `touch` is false only for the stream's periodic re-check: see
 * `AccountBook.sessionPrincipal`.
 */
export function resolveAccess(
  request: Request,
  tokens: ConsoleTokens,
  accounts: ConsoleAccounts | undefined,
  touch = true,
): Access {
  if (accounts === undefined) {
    const credential = credentialOf(request, tokens)
    return {
      credential,
      principal: legacyPrincipal(credential),
      sid: null,
      refusal: null,
      breakGlass: false,
    }
  }

  const header = request.headers.get(CONSOLE_HEADER) !== null
  const crossOrigin = isCrossOriginRequest(request)
  const breakGlass = accounts.breakGlass === true
  const legacyView = accounts.legacyView !== false
  const none: Access = {
    credential: { role: 'none', source: 'none', header, crossOrigin },
    principal: null,
    sid: null,
    refusal: null,
    breakGlass: false,
  }
  const refused = (refusal: AccessRefusal): Access => ({ ...none, refusal })

  let query = ''
  try {
    query = new URL(request.url).searchParams.get(TOKEN_QUERY_PARAM) ?? ''
  } catch {
    query = ''
  }
  if (isPersonalCredential(query)) {
    return refused({
      status: 400,
      code: 'invalid',
      message: PERSONAL_IN_QUERY,
      line: PERSONAL_IN_QUERY_LINE,
    })
  }

  /** A legacy token in one position, with the migration switches applied. */
  const legacyRole = (token: string): ConsoleRole => {
    if (token.length === 0) return 'none'
    const role = roleOfToken(token, tokens)
    if (role === 'view' && !legacyView) return 'none'
    return role
  }

  const user = (
    outcome: AccountOutcome<ConsolePrincipal>,
    source: 'bearer' | 'cookie',
    sid: string | null,
  ): Access | null => {
    if (outcome.ok) {
      return {
        credential: {
          role: roleOfPrincipal(outcome.value),
          source,
          header,
          crossOrigin,
        },
        principal: outcome.value,
        sid,
        refusal: null,
        breakGlass: false,
      }
    }
    if (outcome.refusal.code === 'unavailable') {
      return refused(unavailable(outcome.refusal.message))
    }
    return null
  }

  // ① Bearer: a personal credential, or a legacy token.
  const bearer = bearerOf(request)
  if (isPersonalCredential(bearer)) {
    const found = user(accounts.book.bearerPrincipal(bearer), 'bearer', null)
    if (found !== null) return found
  } else {
    const role = legacyRole(bearer)
    if (role !== 'none') {
      const credential: ConsoleCredential = {
        role,
        source: 'bearer',
        header,
        crossOrigin,
      }
      return {
        credential,
        principal: legacyPrincipal(credential),
        sid: null,
        refusal: null,
        breakGlass: role === 'admin' && breakGlass,
      }
    }
  }

  // ② ?token= and ③ the legacy cookie: legacy tokens only, and never the
  // admin token while it is break-glass.
  for (const [source, token] of [
    ['query', query],
    ['cookie', cookieOf(request, SESSION_COOKIE)],
  ] as const) {
    const role = legacyRole(token)
    if (role === 'none') continue
    if (role === 'admin' && breakGlass) {
      // An explicit link is refused with the reason; a stale cookie from before
      // M-3 is simply not honoured, so a personal session behind it still works.
      if (source === 'query') {
        return refused({
          status: 403,
          code: 'forbidden',
          message: ADMIN_BEARER_ONLY,
          line: ADMIN_BEARER_ONLY_LINE,
        })
      }
      continue
    }
    const credential: ConsoleCredential = { role, source, header, crossOrigin }
    return {
      credential,
      principal: legacyPrincipal(credential),
      sid: null,
      refusal: null,
      breakGlass: false,
    }
  }

  // ④ The session cookie.
  const sid = cookieOf(request, ACCOUNT_SESSION_COOKIE)
  if (sid.length > 0) {
    const found = user(
      accounts.book.sessionPrincipal(sid, touch),
      'cookie',
      sid,
    )
    if (found !== null) return found
  }
  return none
}

/**
 * Who is asking, as a principal — the contract P14 builds on
 * (`tenancy-m1.md` §3.5). `null` for nobody, and for a request the account
 * rules refuse.
 */
export function principalOf(
  request: Request,
  tokens: ConsoleTokens,
  accounts: ConsoleAccounts | undefined,
): ConsolePrincipal | null {
  const access = resolveAccess(request, tokens, accounts)
  return access.refusal === null ? access.principal : null
}

/**
 * The account that owns a chat session (its `contextId`), or `null` for a
 * session no personal account opened — the other half of the P14 contract.
 */
export function ownerOf(
  accounts: ConsoleAccounts,
  contextId: string,
): AccountSubject | null {
  return accounts.book.ownerOf(contextId)
}

/** The fingerprint the break-glass records are kept under. */
export function adminFingerprint(tokens: ConsoleTokens): string {
  return tokenFingerprint(tokens.admin)
}

/** The `Set-Cookie` that signs a browser in with a personal session. */
export function accountSessionCookie(sid: string, secure: boolean): string {
  return (
    `${ACCOUNT_SESSION_COOKIE}=${sid}` +
    '; Path=/; HttpOnly; SameSite=Strict' +
    // The session's absolute lifetime: the cookie never outlives the row
    // behind it, and the server refuses the row first either way.
    `; Max-Age=${String(Math.floor(SESSION_ABSOLUTE_MS / 1000))}` +
    (secure ? '; Secure' : '')
  )
}

/** The `Set-Cookie` that drops it. Same attributes, or the browser keeps the old one. */
export function clearedAccountSessionCookie(secure: boolean): string {
  return (
    `${ACCOUNT_SESSION_COOKIE}=` +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' +
    (secure ? '; Secure' : '')
  )
}
