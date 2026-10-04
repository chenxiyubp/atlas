// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who may read the console, who may act through it, and where the two tokens
 * come from.
 *
 * ## Two tokens, not one with a flag
 *
 * The same reasoning as the backup service (`packages/backup/src/service.ts`):
 * the console's read face shows a roster and an audit trail, while its write
 * face registers agents, drops them and wakes nodes. A single token with a
 * scope field would put "a viewer cannot wake a node" one boolean away from
 * being wrong. So there are two strings, compared separately, and the admin
 * token is a strict superset of the view token's rights — never the other way
 * around.
 *
 * Comparison is length-independent for the same reason the transport handshake
 * is: a timing side channel on a bearer token is cheap to avoid and expensive
 * to discover.
 *
 * ## Where the token rides
 *
 * Three places, checked in this order by {@link presentedCredentialOf}, first
 * one that resolves to a role wins:
 *
 * - `Authorization: Bearer <token>` — what the page's `fetch()` calls and any
 *   `curl` use.
 * - `?token=<token>` on the query string — what a **browser navigation** uses,
 *   because a URL typed or clicked into an address bar cannot carry a header.
 *   That is the whole reason the CLI prints a URL with the token in it.
 * - the {@link SESSION_COOKIE} cookie — what a browser has after `POST /login`,
 *   so that opening the console means typing a token into a field rather than
 *   hand-splicing one into a URL.
 *
 * A token in a URL is a real (smaller) exposure — shell history, the address
 * bar, a `Referer` header. The HTTP layer answers the last one with
 * `referrer-policy: no-referrer`; the first two are accepted, because the
 * alternative is a console nobody can open.
 *
 * ## The cookie, and what it costs
 *
 * This file used to say the cookie was refused on purpose, and the reason it
 * gave was right: a cookie is **ambient**, attached by the browser to requests
 * the operator's page did not make, which is what turns a write route into a
 * CSRF target. Handing the credential to a field on a login page does not make
 * that argument wrong — it makes it a bill that has to be paid, in three
 * instalments. All three are here rather than spread over the route table,
 * because a CSRF defence assembled from pieces in four files is a CSRF defence
 * nobody can audit.
 *
 * **① The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, host-only.** No
 * `Domain`, so a sibling host cannot claim it, and no script can read it — a
 * strict improvement on the `localStorage` copy the page already keeps, which
 * any injected script could lift.
 *
 * **② `Secure` only when the request really arrived over TLS.** See
 * {@link isSecureRequest}. Setting it unconditionally would be the safer-looking
 * choice and the wrong one: the console is also reached at
 * `http://127.0.0.1:<port>` through an SSH tunnel, and a `Secure` cookie is
 * simply never sent back there, so the login page would accept the token and
 * then bounce the operator straight back to itself.
 *
 * **③ `SameSite=Strict` is not enough, because it ignores the port.** Same-site
 * is scheme + registrable domain; `http://127.0.0.1:9999` — any other local web
 * app, on a machine where this console binds loopback precisely because loopback
 * is trusted — is same-site with this console and its cookie will ride along. So
 * every route that is not a plain document read additionally requires the
 * {@link CONSOLE_HEADER} request header when the credential came from the
 * cookie, and this server answers **no** CORS preflight and sends no
 * `Access-Control-Allow-*` header of any kind. A foreign page can therefore
 * neither set that header (custom headers force a preflight) nor survive the
 * preflight (there is no answer to it). The `Bearer` and `?token=` positions are
 * exempt because they are not ambient: a page that can supply either of them
 * already knows the token, and CSRF is an attack by somebody who does not.
 *
 * **Documents are the deliberate exception.** A top-level navigation — the
 * address bar, a bookmark, a link — cannot carry a custom header, so `GET /`,
 * `GET /chat` and `GET /login` accept the cookie alone. That is safe for a
 * reason worth stating rather than assuming: a foreign site can make the
 * browser *navigate* here, but the same-origin policy stops it reading a byte
 * of what comes back, and rendering a page changes nothing on this console or
 * on the network behind it. The moment such a page wants to *do* something it
 * needs one of the JSON routes, and those are back under rule ③.
 *
 * `GET /v0/chat/stream` gets the same exception for the same structural reason
 * (`EventSource` cannot send headers either) plus one guard of its own: a
 * cookie-only stream request is refused when `Sec-Fetch-Site` says the caller is
 * another origin. That header is set by the browser and cannot be forged by
 * page script, and `same-site` is exactly the value the port-blind rule above
 * would otherwise wave through. It is a belt over braces, never the braces:
 * browsers that do not send it fall back to the rules above, which is why the
 * custom header is what actually fails closed.
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * Shortest token this package will accept, generated or supplied.
 *
 * Same floor as the backup service. It is not an entropy estimate — it is the
 * line under which a token is obviously not a token.
 */
export const MIN_TOKEN_LENGTH = 16

/** Query parameter a browser navigation may carry the token in. */
export const TOKEN_QUERY_PARAM = 'token'

/**
 * Name of the session cookie `POST /login` sets.
 *
 * Host-only and unprefixed on purpose: `__Host-` would be the stricter spelling
 * but it mandates `Secure`, and this console must keep working over plain HTTP
 * on loopback (see the module note, instalment ②).
 */
export const SESSION_COOKIE = 'qianmo_console'

/**
 * The header a cookie-authenticated request must also carry on every route
 * that is not a plain document read. Presence is the whole check — the value
 * carries nothing, because a value would imply it was worth guessing.
 */
export const CONSOLE_HEADER = 'x-qianmo-console'

/** What this console's own client sends. Any non-empty value passes. */
export const CONSOLE_HEADER_VALUE = '1'

/**
 * How long a login lasts.
 *
 * Twelve hours rather than a week: the cookie carries the console token itself,
 * so its lifetime is the window in which a stolen cookie jar is worth stealing,
 * and an operator console is a thing people open during a shift.
 */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60

/** What the presented credential entitles the caller to. */
export type ConsoleRole = 'view' | 'admin' | 'none'

/** Which of the three positions the token arrived in. */
export type CredentialSource = 'bearer' | 'query' | 'cookie' | 'none'

/** A resolved credential, with the facts the CSRF rules need. */
export interface ConsoleCredential {
  readonly role: ConsoleRole
  /** Where the accepted token came from. `none` when nothing matched. */
  readonly source: CredentialSource
  /** True when {@link CONSOLE_HEADER} rode along. */
  readonly header: boolean
  /**
   * True only when the browser positively said this request came from another
   * origin (`Sec-Fetch-Site`). Absent header reads as false — see the module
   * note on why this is a belt and not the braces.
   */
  readonly crossOrigin: boolean
}

/** The two credentials one console instance is started with. */
export interface ConsoleTokens {
  /** Reads the roster, the trail and the limits. Changes nothing. */
  readonly view: string
  /** Everything the view token can do, plus register/deregister/wake. */
  readonly admin: string
}

/** Constant-time bearer comparison. Empty never matches. */
function tokenMatches(presented: string, expected: string): boolean {
  // An empty `presented` against an empty `expected` is `timingSafeEqual` over
  // two empty buffers, which is `true`. `resolveTokens` makes that unreachable
  // in production, but `roleOf` is a public function and this is the one input
  // that must never be allowed to grant a role.
  if (presented.length === 0 || expected.length === 0) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/** The `Authorization: Bearer` value, or `''` when there is no bearer. */
export function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/** The value of one cookie, or `''`. Never throws on a malformed header. */
export function cookieOf(request: Request, name: string): string {
  const raw = request.headers.get('cookie')
  if (raw === null) return ''
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      // A cookie the browser did not get from us. Compared raw; it will not
      // match, and refusing to parse the whole header would be worse.
      return value
    }
  }
  return ''
}

/** One position's contents, in the order {@link presentedCredentialOf} tries. */
function positionsOf(request: Request): readonly {
  readonly source: Exclude<CredentialSource, 'none'>
  readonly token: string
}[] {
  let query = ''
  try {
    query = new URL(request.url).searchParams.get(TOKEN_QUERY_PARAM) ?? ''
  } catch {
    // A request whose URL will not parse has no query string to read.
    query = ''
  }
  return [
    { source: 'bearer', token: bearerOf(request) },
    { source: 'query', token: query },
    { source: 'cookie', token: cookieOf(request, SESSION_COOKIE) },
  ]
}

/**
 * The token this request presents, and which position it came from.
 *
 * The first *non-empty* position wins, header before query before cookie. This
 * answers "what did the caller send", which is all it can answer without the
 * expected pair; "which credential is in force" is {@link credentialOf}, and
 * the two differ when more than one position is filled in.
 */
export function presentedCredentialOf(request: Request): {
  readonly token: string
  readonly source: CredentialSource
} {
  for (const position of positionsOf(request)) {
    if (position.token.length > 0) return position
  }
  return { token: '', source: 'none' }
}

/** The token this request presents. See {@link presentedCredentialOf}. */
export function presentedTokenOf(request: Request): string {
  return presentedCredentialOf(request).token
}

/**
 * Resolve a bare token to a role.
 *
 * Both comparisons always run — no short-circuit — so the answer costs the
 * same whichever token was presented. The admin token also satisfies every
 * view-only route: one operator with one credential is the common case, and
 * making them hold two would guarantee they hold one.
 */
export function roleOfToken(token: string, tokens: ConsoleTokens): ConsoleRole {
  const isAdmin = tokenMatches(token, tokens.admin)
  const isView = tokenMatches(token, tokens.view)
  if (isAdmin) return 'admin'
  if (isView) return 'view'
  return 'none'
}

/**
 * True when the browser said this request came from somewhere else.
 *
 * `Sec-Fetch-Site` is a forbidden header name, so page script cannot set or
 * forge it; `none` is a user-initiated navigation (address bar, bookmark) and
 * counts as ours. An absent header — an old browser, or a non-browser client —
 * reads as same-origin, because failing closed here would refuse `curl` and
 * every proxy that strips unknown headers.
 */
export function isCrossOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site === null) return false
  return site !== 'same-origin' && site !== 'none'
}

/**
 * Resolve the caller's credential: role, position, and the two facts the CSRF
 * rules in `http.ts` need.
 *
 * The positions are tried in order and the first one that *matches* wins, not
 * merely the first one present — a browser that still has a cookie can follow a
 * link whose `?token=` has since been rotated, and treating that as anonymous
 * would log an operator out for holding a stale bookmark. What is never allowed
 * is the reverse promotion: a wrong token cannot borrow the role of a right one
 * that was not presented, because every position is compared against the same
 * two strings.
 */
export function credentialOf(
  request: Request,
  tokens: ConsoleTokens,
): ConsoleCredential {
  const header = request.headers.get(CONSOLE_HEADER) !== null
  const crossOrigin = isCrossOriginRequest(request)
  for (const position of positionsOf(request)) {
    if (position.token.length === 0) continue
    const role = roleOfToken(position.token, tokens)
    if (role !== 'none') {
      return { role, source: position.source, header, crossOrigin }
    }
  }
  return { role: 'none', source: 'none', header, crossOrigin }
}

/** Resolve the caller's role. See {@link credentialOf} for the whole answer. */
export function roleOf(request: Request, tokens: ConsoleTokens): ConsoleRole {
  return credentialOf(request, tokens).role
}

// --- the session cookie --------------------------------------------------

/** Where the login page lives. Named here because {@link safeRedirect} refuses it. */
export const LOGIN_PATH = '/login'

/**
 * True when the request reached this process over TLS.
 *
 * `X-Forwarded-Proto` wins when present because it describes the leg that
 * matters — the browser-facing one — and behind a reverse proxy the socket this
 * process sees is plain HTTP no matter what the operator's URL bar says. The
 * header is client-controlled on a console reached directly, but the only thing
 * a caller achieves by lying is a stricter or a looser cookie **on its own
 * request**; it cannot touch anybody else's. Every reverse proxy worth using
 * sets this header itself rather than passing one through.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim().toLowerCase() ?? ''
    if (first.length > 0) return first === 'https'
  }
  try {
    return new URL(request.url).protocol === 'https:'
  } catch {
    return false
  }
}

/** What {@link sessionCookieHeader} needs to decide. */
export interface SessionCookieOptions {
  /** Add `Secure`. Pass {@link isSecureRequest}, never a constant. */
  readonly secure: boolean
  /** Lifetime. Defaults to {@link SESSION_MAX_AGE_SECONDS}. */
  readonly maxAgeSeconds?: number
}

function serialiseSessionCookie(
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(value)}` +
    // No `Domain`: host-only, so a sibling name on the same registrable domain
    // cannot claim it. The three that follow are the instalments the module
    // note names — script cannot read it, cross-site requests do not carry it,
    // and it is scoped to the whole console rather than to one path.
    '; Path=/' +
    '; HttpOnly' +
    '; SameSite=Strict' +
    `; Max-Age=${maxAgeSeconds}` +
    (secure ? '; Secure' : '')
  )
}

/** The `Set-Cookie` value that logs a browser in. */
export function sessionCookieHeader(
  token: string,
  options: SessionCookieOptions,
): string {
  return serialiseSessionCookie(
    token,
    options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS,
    options.secure,
  )
}

/**
 * The `Set-Cookie` value that logs a browser out.
 *
 * Same attributes as the one it replaces, minus the value and the lifetime: a
 * browser only overwrites a cookie when name, path and domain all match, so a
 * clear that drops `Path=/` leaves the original in place and logs nobody out.
 */
export function clearedSessionCookieHeader(
  options: SessionCookieOptions,
): string {
  return serialiseSessionCookie('', 0, options.secure)
}

/**
 * True when the string carries a C0 control character or DEL.
 *
 * A scan rather than a regular expression: the regex spelling of this needs
 * literal control characters in the source, which is a thing the linter refuses
 * for good reasons and a thing a future editor would silently mangle.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The path a login may send a browser to, or `/` when the request is not one.
 *
 * Everything about this function is a refusal. Only a site-relative path is
 * allowed: no scheme, no host, no protocol-relative `//evil.example`, no
 * backslash (browsers normalise `\` to `/`, so `/\evil.example` is a host), no
 * control character (a smuggled newline is a second response header). Anything
 * that parses to an origin other than the placeholder is discarded rather than
 * repaired, and `/login` itself is discarded too — a redirect back to the login
 * page is a loop the operator has no way out of.
 */
export function safeRedirect(raw: string | null | undefined): string {
  if (raw === undefined || raw === null) return '/'
  const value = raw.trim()
  if (!value.startsWith('/')) return '/'
  if (value.startsWith('//')) return '/'
  if (value.includes('\\')) return '/'
  if (hasControlCharacter(value)) return '/'
  const placeholder = 'http://console.invalid'
  try {
    const probe = new URL(value, placeholder)
    if (probe.origin !== placeholder) return '/'
    if (probe.pathname === LOGIN_PATH) return '/'
    return `${probe.pathname}${probe.search}`
  } catch {
    return '/'
  }
}

/** True for the addresses only this machine can reach. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (host === 'localhost') return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  // The whole 127/8 block, not just 127.0.0.1.
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)
}

/** Everything {@link resolveTokens} needs to decide. */
export interface ResolveTokensInput {
  /** Operator-supplied view token, if any. */
  readonly view?: string
  /** Operator-supplied admin token, if any. */
  readonly admin?: string
  /** The address the server will bind to — the whole basis of the policy. */
  readonly hostname: string
  /** Source of a fresh token. Injected so tests are deterministic. */
  readonly generate: () => string
}

/** An empty string is "not supplied", not "supplied as empty". */
function supplied(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function requireExplicit(
  value: string | undefined,
  which: 'view' | 'admin',
  hostname: string,
): string {
  const given = supplied(value)
  if (given !== undefined) return given
  throw new Error(
    `控制台绑定在非环回地址 ${hostname}，必须显式提供 ${which} token；` +
      `请设置 --${which}-token（或对应环境变量），或改绑 127.0.0.1 让控制台自动生成。`,
  )
}

/**
 * Decide the pair of tokens a console instance runs with.
 *
 * Pure on purpose: the policy lives here and the CLI only calls it, so "when
 * is a console allowed to run without a password" has exactly one answer that
 * can be read in one place and tested without binding a port.
 *
 * Three rules:
 *
 * 1. **Loopback with nothing supplied** — generate. The console is reachable
 *    only from this machine, and the CLI prints the URL with the token in it,
 *    so the operator pays nothing for a credential that still stops another
 *    local process from stumbling in.
 * 2. **Anything but loopback** — both tokens must be supplied, or this throws.
 *    Fail closed: `--host 0.0.0.0` is how a console ends up on a VPS's public
 *    interface, and a generated token that is only printed to a stdout nobody
 *    is reading would leave the roster, the trail and the wake button open to
 *    whoever scans the port first. Refusing to start is the only outcome that
 *    cannot be missed.
 * 3. **Always** — each token is at least {@link MIN_TOKEN_LENGTH} characters
 *    and the two differ. Applied to generated tokens as well, so a `generate`
 *    that returns `''` or the same string twice is a startup failure and not a
 *    console where the view token is the admin token.
 */
export function resolveTokens(input: ResolveTokensInput): ConsoleTokens {
  const loopback = isLoopbackHostname(input.hostname)

  const view = loopback
    ? (supplied(input.view) ?? input.generate())
    : requireExplicit(input.view, 'view', input.hostname)
  const admin = loopback
    ? (supplied(input.admin) ?? input.generate())
    : requireExplicit(input.admin, 'admin', input.hostname)

  if (view.length < MIN_TOKEN_LENGTH || admin.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `控制台 token 至少需要 ${MIN_TOKEN_LENGTH} 个字符；` +
        '请换一个更长的随机串（例如 `openssl rand -hex 16`）。',
    )
  }
  if (view === admin) {
    // One string for both faces would make the two-credential design a comment.
    throw new Error(
      '控制台的 view token 与 admin token 必须不同；' +
        '相同就等于只读用户也能注册、注销和唤醒节点。',
    )
  }

  return { view, admin }
}
