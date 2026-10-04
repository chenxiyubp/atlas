// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The console's HTTP face: one page, a handful of JSON routes and three HTML
 * fragments, over `Bun.serve`.
 *
 * Shaped like `packages/registry/src/http.ts` — hand-written routing, no
 * framework, {@link createConsoleHandler} exposed separately from
 * {@link startConsoleServer} so every route can be exercised with a plain
 * `Request` and a fake port, without binding anything.
 *
 * ## Route table
 *
 * | Method | Path | Role | Returns |
 * | --- | --- | --- | --- |
 * | GET | `/` | view | `text/html`, the whole page |
 * | GET | `/login` | public | `text/html`, the token field |
 * | POST | `/login` | public | 303 + `Set-Cookie`, or the field again |
 * | POST | `/logout` | public | 303 + a cleared cookie |
 * | GET | `/assets/app.css` | public | `text/css` |
 * | GET | `/assets/app.js` | public | `text/javascript` |
 * | GET | `/v0/health` | public | `{ status: 'ok' }` |
 * | GET | `/v0/agents` | view | `{ agents }` |
 * | POST | `/v0/agents` | admin | the registered `ConsoleAgent` |
 * | DELETE | `/v0/agents/<enc address>` | admin | 204 |
 * | POST | `/v0/agents/<enc address>/heartbeat` | admin | `ConsoleAgent` |
 * | GET | `/v0/audit?…` | view | `AuditPage` |
 * | GET | `/v0/audit/chain/<enc traceId>` | view | `{ chain }`, may be null |
 * | GET | `/v0/limits` | view | `LimitsSnapshot` |
 * | GET | `/v0/servers` | view | `{ servers }`, or 501 without a mapping |
 * | PUT | `/v0/servers/<enc server>/note` | admin | the stored `ServerNote` |
 * | POST | `/v0/wake` | admin | `WakeOutcome`, or 501 without a wake port |
 * | GET | `/fragments/{roster,audit,limits}` | view | `text/html` fragment |
 * | GET | `/fragments/chain/<enc traceId>` | view | `text/html` fragment |
 * | GET | `/chat?session=<id>` | **admin** | `text/html`, the chat page |
 * | GET | `/v0/chat/targets` | **admin** | `{ targets }` |
 * | GET | `/v0/chat/sessions` | **admin** | `{ sessions }` |
 * | POST | `/v0/chat/sessions` | **admin** | the opened `ChatSession` |
 * | GET | `/v0/chat/sessions/<enc id>` | **admin** | `ChatTranscript` |
 * | POST | `/v0/chat/sessions/<enc id>/messages` | **admin** | the operator `ChatTurn` |
 * | GET | `/v0/chat/stream` | **admin** | `text/event-stream` |
 * | GET | `/fragments/chat/sessions?active=<id>` | **admin** | `text/html` fragment |
 * | GET | `/fragments/chat/thread/<enc id>` | **admin** | `text/html` fragment |
 * | GET, POST | `/invite` | public | accounts only — see `accountsHttp.ts` |
 * | * | `/v0/accounts/…` | admin | accounts only — see `accountsHttp.ts` |
 *
 * The last two rows exist only on a console handed an `AccountBook`; without
 * one they are the plain 404 they always were.
 *
 * ## With personal accounts
 *
 * A console started with {@link ConsoleServerOptions.accounts} reads every
 * request through `access.ts` instead of `credentialOf`, and the table above
 * changes in exactly these places (`tenancy-m1.md` §3.2–§3.4):
 *
 * - `ops` is read as admin and `viewer` / `member` as view, so every row keeps
 *   its role column; a session cookie is read as a cookie, so the three
 *   protection classes below apply to it unchanged.
 * - The chat rows admit a `member` as well as admin, **scoped to the sessions
 *   that member opened**: lists are filtered, and another person's session
 *   answers the same 404 as one that does not exist, before the port is asked.
 *   `viewer` and the view token still cannot see that a conversation exists.
 *   The stream carries only the caller's sessions and ends when the account
 *   is revoked or reset, its session expires, or the book closes.
 * - `/login` also takes a personal credential and answers with a server
 *   session; `/logout` also ends that session on the server.
 * - A personal credential in `?token=` is refused with a 400 on every route;
 *   in break-glass mode the admin token works only as a Bearer, every page it
 *   opens carries a lit notice, and every response to it the
 *   `x-qianmo-break-glass` header.
 * - The page scripts are the variants that never keep a personal credential
 *   in `localStorage` (`assets/client.ts`).
 *
 * Without accounts none of this runs, and `test/legacyParity.test.ts` pins
 * that the answers are byte for byte what they were.
 *
 * ## Chat is admin-only, all of it
 *
 * Every row above with `chat` in it needs the admin token, **including the
 * read-only ones**. Two reasons, and either alone would be enough: sending
 * spends the far node's model budget, and a transcript is the one thing on this
 * console that contains free-form content rather than ids and counts — §7.2
 * says the rest of the page never touches a payload, and this page is the
 * exception. A view token therefore does not merely fail to send; it cannot see
 * that the conversation exists. The ledger page hides the nav link for the same
 * reason it hides it when there is no chat channel at all.
 *
 * When `deps.chat` is absent, `/chat` answers **404** (there is no such page on
 * this instance) while `/v0/chat/*` answers **501** (the route exists in this
 * version; this console has no channel behind it). A browser gets the honest
 * answer and a script gets the diagnosable one. Both are still behind the admin
 * check, so an anonymous caller cannot probe which consoles have chat wired.
 *
 * The last row is an addition to the agreed table, not a redesign of it: the
 * view layer exports `renderChain` and the trace cells it renders carry
 * `data-action="chain"`, so the client needs somewhere to fetch that panel
 * from as **markup**. The JSON `/v0/audit/chain/…` route stays exactly as
 * specified, for callers that want the data.
 *
 * ## A server id is chosen from the startup list, never supplied
 *
 * `PUT /v0/servers/<id>/note` looks the id up in `deps.nodeServers` before it
 * reads the body, and answers 403 when it is not there. This is the same rule
 * `handleWake` applies to a wake target and it is there for the same reason: the
 * set of things this console will act on is fixed when it starts, so a caller
 * holding the admin token cannot grow it by typing into the page. Without the
 * check, a note route would be an arbitrary key-value store that anyone with
 * that token could fill up.
 *
 * A console started without any `--node-server` answers 501 on both routes
 * rather than 200 with an empty list: "this console was not told where anything
 * runs" and "nothing runs anywhere" are different facts.
 *
 * The two asset routes are public because a browser does not attach the
 * console's credential to a `<link>` or `<script>` it discovers inside a page
 * (see `auth.ts` on where the token rides). They are compiled-in constants
 * containing no instance data, so serving them to an anonymous local caller
 * gives nothing away; gating them would only produce an unstyled page.
 *
 * The whole address rides in **one** percent-encoded path segment, the same
 * convention the registry uses (`qianmo%3A%2F%2Fnode-b%2Freviewer`): `URL`
 * leaves the escapes alone, so the split still yields the expected segment
 * count and one `decodeURIComponent` hands the address back.
 *
 * ## A port that is down is not a 500
 *
 * Every `ConsoleDeps` port answers with a typed failure instead of throwing,
 * and this layer keeps that promise visible: a failure becomes the status that
 * describes it (503 when the registry is unreachable, 404 when the address is
 * gone, …) carrying `failure.message`, never a 500.
 *
 * The HTML routes go further and do not fail at all. **The page must open when
 * the registry is down** — that is when someone is looking at it. So `/` and
 * the fragments hand `(value | null, failure | null)` to the view layer and
 * answer 200 with a page that renders the failure in place of the panel it
 * belongs to. A console that 503s as a whole because one of three panels could
 * not load is a console that tells you nothing at the moment you need it.
 *
 * ## 401 before 405
 *
 * Role is checked before the method on every non-public route: an anonymous
 * caller should not learn which verbs a route accepts. Unknown paths answer
 * 404 without consulting the credential at all — there is no role that would
 * make them exist. Neither 401 nor 403 ever echoes the token it received.
 *
 * ## Three protection classes, because a cookie is ambient
 *
 * Since `POST /login` may hand the browser a cookie, every route has to say
 * what an ambient credential is allowed to do on it. `auth.ts` holds the
 * argument; this file holds the assignment, and there are exactly three values:
 *
 * - **`document`** — `GET /` and `GET /chat`. A cookie alone is enough: a
 *   top-level navigation cannot carry a custom header, and a foreign page that
 *   forces one still cannot read the response or change anything by causing it.
 * - **`stream`** — `GET /v0/chat/stream`, which is an `EventSource` and equally
 *   header-less. A cookie alone is enough *unless* `Sec-Fetch-Site` says the
 *   caller is another origin, which is the one case `SameSite` misses because
 *   it ignores the port.
 * - **`guarded`** — everything else that needs a credential: every write, every
 *   JSON read, every HTML fragment. A cookie must be accompanied by the
 *   {@link CONSOLE_HEADER} header, which a cross-origin caller cannot set
 *   without a preflight this server never answers.
 *
 * The `Bearer` and `?token=` positions are unaffected in all three: they are
 * not ambient, so they are not a CSRF vector.
 *
 * ## Unauthenticated: a redirect for a browser, a 401 for everything else
 *
 * A `GET` whose `Accept` asks for `text/html` is a person in a browser, and
 * sending them a JSON 401 they cannot act on is how a console gets a reputation
 * for being broken — they get a 303 to `/login` with a validated `redirect`
 * back. Everything else keeps the 401 JSON exactly as before, because a `curl`
 * or a poller that gets HTML and a 200 instead of a 401 has been lied to. The
 * one refinement is 403: an operator holding a view token who navigates to an
 * admin page is shown the login card **in place**, with the reason, rather than
 * being bounced to `/login` — they are already authenticated, so a page that
 * redirected them would redirect them straight back.
 */

import {
  adminFingerprint,
  resolveAccess,
  type Access,
  type AccessRefusal,
  type ConsoleAccounts,
} from './access.js'
import { assertTokensUnlikeAccountSecrets } from './accounts.js'
import {
  accountLogin,
  accountLogout,
  chatScopeOf,
  handleAccountsApi,
  handleInvite,
  pageViewer,
  streamScopeOf,
  type ChatScope,
  type StreamScope,
} from './accountsHttp.js'
import {
  CONSOLE_CLIENT_JS,
  CONSOLE_CLIENT_JS_ACCOUNTS,
} from './assets/client.js'
import { CONSOLE_CSS } from './assets/css.js'
import {
  CONSOLE_HEADER,
  LOGIN_PATH,
  SESSION_MAX_AGE_SECONDS,
  TOKEN_QUERY_PARAM,
  clearedSessionCookieHeader,
  isCrossOriginRequest,
  isSecureRequest,
  roleOfToken,
  safeRedirect,
  sessionCookieHeader,
  type ConsoleCredential,
  type ConsoleTokens,
} from './auth.js'
import type {
  AuditFilter,
  ChatPort,
  ChatTarget,
  ChatUpdate,
  ConsoleAgent,
  ConsoleAuditSource,
  ConsoleDeps,
  ConsoleFailure,
  ConsoleResult,
  LimitsSnapshot,
  NodeServer,
  RegisterAgentInput,
  WakeInput,
} from './deps.js'
import {
  agentFilterOptions,
  renderRoster,
  wakeTargetOptions,
} from './view/agents.js'
import {
  AUDIT_WINDOWS,
  renderAudit,
  renderAuditSources,
  renderChain,
} from './view/audit.js'
import { failureBar, type PageViewer } from './view/bits.js'
import {
  MAX_CHAT_TEXT_LENGTH,
  renderChatSessions,
  renderChatThread,
} from './view/chat.js'
import { renderChatPage } from './view/chatPage.js'
import { rosterLease } from './view/format.js'
import { renderLimits } from './view/limits.js'
import {
  MAX_SERVER_NOTE_LENGTH,
  renderServers,
  serverCards,
} from './view/servers.js'
import { renderLoginPage } from './view/login.js'
import { renderPage } from './view/page.js'
import {
  DOCUMENT_HEADERS,
  fail,
  html,
  json,
  methodNotAllowed,
  notFound,
  readForm,
  readJsonObject,
  seeOther,
} from './respond.js'
import { LoginThrottle } from './throttle.js'

/** Prefix of every JSON route in this API version. */
export const API_PREFIX = '/v0'

/**
 * Hard ceiling on the audit tail, whatever the query string asks for.
 *
 * The trail is an append-only file that grows for as long as the network runs.
 * A page that renders all of it is a page that stops rendering.
 */
export const MAX_AUDIT_LIMIT = 500

/** Header shown when the operator did not name this console. */
const DEFAULT_LABEL = '阡陌控制台'

/**
 * The CLI name §10.2's copyable `ca issue` line is written under, when the
 * host did not say.
 *
 * A fallback rather than a source: the name has exactly one spelling
 * (`src/constants/identity.ts`), the host reads it from there, and this
 * package is a leaf that cannot. Reached only by a caller that wired a
 * certificate port and no name, which is a wiring mistake rather than a
 * configuration — so the fallback is the right string rather than a blank.
 */
const DEFAULT_BIN_NAME = 'qm'
const DEFAULT_AUDIT_SOURCE_NODE = 'default'

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** HTTP status for a port failure. Never 500 — the port answered. */
function statusFor(code: ConsoleFailure['code']): number {
  switch (code) {
    case 'unreachable':
      return 503
    case 'not_found':
      return 404
    case 'unsupported':
      return 501
    // 403, and emphatically not 503: the far node was reached, read the
    // request and declined it. A 503 tells a caller — and every retry loop
    // written against one — that the service is momentarily away and the same
    // bytes will work later, which for a policy refusal is false in both
    // halves (issue #29).
    case 'refused':
      return 403
    // `rejected` (a rule on this side would not let it leave) and `invalid`
    // (the input itself) both land on 400: the ports cannot tell a conflict
    // from a malformed address, and inventing a 409 here would be a guess the
    // client would act on.
    case 'rejected':
    case 'invalid':
      return 400
  }
}

function failureResponse(failure: ConsoleFailure): Response {
  return fail(statusFor(failure.code), failure.code, failure.message)
}

function valueOf<T>(result: ConsoleResult<T>): T | null {
  return result.ok ? result.value : null
}

function failureOf<T>(result: ConsoleResult<T>): ConsoleFailure | null {
  return result.ok ? null : result.failure
}

/**
 * What an ambient (cookie) credential is allowed to do on a route. The module
 * note above defines the three; `auth.ts` argues for them.
 */
type Protection = 'document' | 'stream' | 'guarded'

/** What a JSON caller is told when a view token reached an admin route. */
const ADMIN_REQUIRED = '该操作需要 admin token，当前凭据只有只读权限。'

/**
 * The same fact for the login card, in the page's own register.
 *
 * Deliberately not the string above: everything the console renders keeps to
 * one clause and no full stop (`view/page.ts`, and the copy gates in
 * `test/view.test.ts`), while an error *body* is read by a developer and may
 * spend a sentence saying what to do.
 */
const ADMIN_REQUIRED_LINE = '该页面需要 admin 令牌'

/** What a failed login is told. Never which half of the pair was close. */
const LOGIN_REFUSED = '令牌无效'

/**
 * Enforce the role a route needs, and what the credential's *position* is
 * allowed to reach.
 *
 * 401 when nothing valid was presented, 403 when a view token reached an admin
 * route or when a cookie reached a route it may not carry alone. Neither body
 * repeats the token — a credential that shows up in a response ends up in a
 * log, a screenshot or a bug report.
 *
 * Role comes first and position second on purpose: a caller with no valid
 * credential must get the same 401 whether or not it also happened to send the
 * console header, or the header becomes a probe for "is this a real cookie".
 */
function guard(
  credential: ConsoleCredential,
  need: 'view' | 'admin',
  protection: Protection,
): Response | null {
  if (credential.role === 'none') {
    return fail(
      401,
      'unauthorized',
      '需要控制台 token：带 `Authorization: Bearer <token>` 头，或在 URL 上加 `?token=<token>`，或在登录页填一次。',
    )
  }
  if (credential.source === 'cookie') {
    if (protection === 'guarded' && !credential.header) {
      return fail(
        403,
        'forbidden',
        `cookie 凭据的请求必须同时带 ${CONSOLE_HEADER} 请求头；` +
          '这条规则挡的是跨源页面借浏览器自动附带的 cookie 发出的请求。',
      )
    }
    if (protection === 'stream' && credential.crossOrigin) {
      return fail(
        403,
        'forbidden',
        'cookie 凭据只能从本控制台自己的页面打开这条流。',
      )
    }
  }
  if (need === 'admin' && credential.role !== 'admin') {
    return fail(403, 'forbidden', ADMIN_REQUIRED)
  }
  return null
}

/** What a `viewer` account is told on a chat route. */
const CHAT_MEMBER_REQUIRED = '对话需要成员或运维账号；只读账号看不到会话。'

/** The same, on the login card. */
const CHAT_MEMBER_REQUIRED_LINE = '该页面需要成员或运维账号'

/**
 * The one answer to a session a member may not see, whether it belongs to
 * somebody else or does not exist at all — the host's own wording for the
 * second case, so the two cannot be told apart (`tenancy-m1.md` §3.2).
 */
const CHAT_SESSION_NOT_FOUND = '这条会话不在本控制台的记录里'

/**
 * The chat face's guard. Without accounts, and for the two legacy tokens, it
 * is today's rule: admin, all of it (module note). A person needs a `member`
 * or `ops` account; `ops` reads as admin already, so only `member` is the new
 * case, and `viewer` is refused with the reason.
 */
function guardChat(access: Access, protection: Protection): Response | null {
  const principal = access.principal
  if (principal?.kind !== 'user') {
    return guard(access.credential, 'admin', protection)
  }
  const denied = guard(access.credential, 'view', protection)
  if (denied !== null) return denied
  return principal.role === 'viewer'
    ? fail(403, 'forbidden', CHAT_MEMBER_REQUIRED)
    : null
}

/** True when this caller gets the chat face at all. */
function mayChat(access: Access): boolean {
  const principal = access.principal
  return principal?.kind === 'user'
    ? principal.role !== 'viewer'
    : access.credential.role === 'admin'
}

// --- the login door ------------------------------------------------------

/**
 * True when this request is a person navigating rather than a script calling.
 *
 * `Accept` is the whole judgement, and it is only consulted for a `GET`: a
 * `POST` that happens to accept HTML is still a caller that asked for an
 * action, and answering it with a redirect to a login form would turn a refused
 * write into a 303 the caller reports as success.
 */
function wantsHtml(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  return (request.headers.get('accept') ?? '').includes('text/html')
}

/**
 * Where to send a browser that has no credential, with the way back.
 *
 * The `token` parameter is stripped out of the return path before it is
 * encoded. It is there because a stale bookmark carried it, it did not work,
 * and preserving it would put a dead credential into the `Location` header, the
 * browser's history and every access log between here and there.
 */
function loginRedirect(url: URL): Response {
  const back = new URL(url.toString())
  back.searchParams.delete(TOKEN_QUERY_PARAM)
  const target = `${back.pathname}${back.search}`
  const query = target === '/' ? '' : `?redirect=${encodeURIComponent(target)}`
  return seeOther(`${LOGIN_PATH}${query}`)
}

/** The login document, at whatever status the reason calls for. */
function loginPage(
  deps: ConsoleDeps,
  options: {
    readonly redirect: string
    readonly status?: number
    readonly error?: string
    readonly headers?: Record<string, string>
    /** A console with accounts: the field takes a personal credential too. */
    readonly accounts?: boolean
  },
): Response {
  const body = renderLoginPage({
    label: deps.label ?? DEFAULT_LABEL,
    redirect: options.redirect,
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.accounts === true ? { accounts: true } : {}),
  })
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...DOCUMENT_HEADERS,
      ...(options.headers ?? {}),
    },
  })
}

/**
 * Turn a refusal into the form the caller can act on.
 *
 * A script keeps the JSON it would have got before this page existed. A browser
 * gets the door: `/login` when it has nothing, and the card in place when it
 * has a view token and asked for an admin page — bouncing *that* caller to
 * `/login` would only bounce them back, because they are already logged in.
 */
function documentDenial(
  request: Request,
  denied: Response,
  deps: ConsoleDeps,
  url: URL,
  access?: Access,
): Response {
  if (!wantsHtml(request)) return denied
  if (denied.status === 401) return loginRedirect(url)
  if (denied.status === 403) {
    const back = new URL(url.toString())
    back.searchParams.delete(TOKEN_QUERY_PARAM)
    const person = access?.principal?.kind === 'user'
    return loginPage(deps, {
      redirect: safeRedirect(`${back.pathname}${back.search}`),
      status: 403,
      error: person ? CHAT_MEMBER_REQUIRED_LINE : ADMIN_REQUIRED_LINE,
      ...(access === undefined ? {} : { accounts: true }),
    })
  }
  return denied
}

/**
 * A request the account rules refused before any route saw it
 * (`access.ts`): the JSON a script can act on, or the login card with the
 * reason for a browser.
 */
function accessRefused(
  request: Request,
  refusal: AccessRefusal,
  deps: ConsoleDeps,
  url: URL,
): Response {
  if (!wantsHtml(request)) {
    return fail(refusal.status, refusal.code, refusal.message)
  }
  const back = new URL(url.toString())
  back.searchParams.delete(TOKEN_QUERY_PARAM)
  return loginPage(deps, {
    redirect: safeRedirect(`${back.pathname}${back.search}`),
    status: refusal.status,
    error: refusal.line,
    accounts: true,
  })
}

/**
 * `GET /login` renders the field; `POST /login` checks it and sets the cookie.
 *
 * Public, because a door that needs a key is not a door. Three things are worth
 * reading:
 *
 * **The throttle runs before the comparison**, so a blocked caller learns
 * nothing about the token they just sent — including whether it was right.
 *
 * **`Sec-Fetch-Site` refuses a cross-origin POST.** Login CSRF is not the worst
 * bug in the world here (an attacker who can force a login already knows a
 * token, and knowing one is the whole game), but the check is free and it also
 * removes this endpoint as a guessing oracle that a foreign page could drive
 * through a victim's browser.
 *
 * **Success answers 303, never 200 with a page.** The cookie is brand new and
 * the browser has to make a fresh request for the destination to be rendered
 * with it; answering the POST with the console itself would render the page for
 * a caller that, from the server's point of view, was not carrying the cookie
 * yet.
 */
async function handleLogin(
  request: Request,
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  credential: ConsoleCredential,
  throttle: LoginThrottle,
  url: URL,
  clientKey: string,
  now: number,
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  const asked = safeRedirect(url.searchParams.get('redirect'))
  const accountsOn = accounts !== undefined

  if (request.method === 'GET') {
    // Already carrying a credential: there is nothing to fill in. The console
    // itself is the honest answer, not a form that would refuse to appear.
    if (credential.role !== 'none') return seeOther(asked)
    return loginPage(deps, {
      redirect: asked,
      ...(accountsOn ? { accounts: true } : {}),
    })
  }
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST'])

  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '登录只接受来自本控制台自己页面的提交。')
  }

  const form = await readForm(request)
  if (form === null) {
    return fail(400, 'invalid', '请求体必须是登录表单')
  }
  const target = safeRedirect(form.get('redirect'))

  const wait = throttle.retryAfterSeconds(clientKey, now)
  if (wait > 0) {
    return loginPage(deps, {
      redirect: target,
      status: 429,
      error: `尝试过多 · 请等 ${wait} 秒`,
      headers: { 'retry-after': String(wait) },
      ...(accountsOn ? { accounts: true } : {}),
    })
  }

  const presented = (form.get('token') ?? '').trim()
  if (accounts !== undefined) {
    return accountLogin(request, presented, target, {
      accounts,
      tokens,
      throttle,
      clientKey,
      now,
      card: (status, error) =>
        loginPage(deps, { redirect: target, status, error, accounts: true }),
    })
  }
  const role = roleOfToken(presented, tokens)
  if (role === 'none') {
    throttle.recordFailure(clientKey, now)
    // The status is honest and the wording is not specific: "no such token" and
    // "wrong token" are the same answer, and neither repeats what was typed.
    return loginPage(deps, {
      redirect: target,
      status: 401,
      error: LOGIN_REFUSED,
    })
  }

  throttle.clear(clientKey)
  return seeOther(target, {
    'set-cookie': sessionCookieHeader(presented, {
      secure: isSecureRequest(request),
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    }),
  })
}

/**
 * `POST /logout` — drop the cookie and go back to the door.
 *
 * Needs no credential: the only thing it changes is the caller's own browser
 * state, and demanding a valid token to *stop* using one would strand anybody
 * whose token was rotated while they had a tab open. The `Sec-Fetch-Site` check
 * is here anyway, because the nuisance version of this (a same-site page on
 * another port logging an operator out on a loop) costs three lines to remove.
 */
function handleLogout(
  request: Request,
  accounts: ConsoleAccounts | undefined,
): Response {
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  if (isCrossOriginRequest(request)) {
    return fail(403, 'forbidden', '退出只接受来自本控制台自己页面的提交。')
  }
  if (accounts !== undefined) return accountLogout(request, accounts)
  return seeOther(LOGIN_PATH, {
    'set-cookie': clearedSessionCookieHeader({
      secure: isSecureRequest(request),
    }),
  })
}

// --- query parsing -------------------------------------------------------

function textParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Epoch milliseconds or an ISO string, whichever the caller typed.
 *
 * An unparseable value reads as "not given" rather than as an error: these
 * come from a text box on a page that reloads itself, and a filter that 400s
 * on a half-typed date is a filter nobody finishes typing. All-digit input is
 * always epoch ms — `2026` means 1970, not the year.
 */
function parseTimestamp(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (/^-?\d+$/.test(trimmed)) {
    const epoch = Number(trimmed)
    return Number.isSafeInteger(epoch) ? epoch : undefined
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Tail size, clamped rather than rejected.
 *
 * Anything present but not a positive integer — `0`, `-3`, `abc`, `12.5` — and
 * anything above {@link MAX_AUDIT_LIMIT} becomes the ceiling. An absent (or
 * empty) parameter stays absent so the port applies its own default.
 */
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) return MAX_AUDIT_LIMIT
  return Math.min(value, MAX_AUDIT_LIMIT)
}

/**
 * The relative windows the trail filter's segmented control can submit.
 *
 * Resolved here rather than in the browser because the filter form is a plain
 * `method="get"` that has to keep working with script disabled, and a radio
 * button cannot compute `now - 24h`. Anything else in the parameter is ignored
 * rather than refused — it arrives from a URL somebody may have edited by hand,
 * and a 400 on a filter is a filter nobody finishes typing.
 *
 * Derived from the view's own table rather than restated: the segmented control
 * and this parser have to agree on both the spelling and the span, and two
 * hand-kept lists agree only until one of them is edited.
 */
const AUDIT_WINDOW_MS: ReadonlyMap<string, number> = new Map(
  AUDIT_WINDOWS.map(([value, , span]) => [value, span]),
)

/**
 * Read the audit filter out of a query string.
 *
 * Exported and pure so the clamping rules can be tested without a request:
 * they are the part of this file most likely to be quietly wrong. `now` is a
 * parameter for the same reason every other clock in this package is: a window
 * of "the last hour" has to be reproducible in a test.
 */
export function parseAuditFilter(
  url: URL,
  now: number = Date.now(),
): AuditFilter {
  const params = url.searchParams
  const filter: {
    source?: string
    outcome?: string
    traceId?: string
    taskId?: string
    agent?: string
    from?: number
    to?: number
    window?: string
    limit?: number
  } = {}

  const source = textParam(params, 'source')
  if (source !== undefined) filter.source = source
  const outcome = textParam(params, 'outcome')
  if (outcome !== undefined) filter.outcome = outcome
  const traceId = textParam(params, 'traceId')
  if (traceId !== undefined) filter.traceId = traceId
  const taskId = textParam(params, 'taskId')
  if (taskId !== undefined) filter.taskId = taskId
  const agent = textParam(params, 'agent')
  if (agent !== undefined) filter.agent = agent

  const from = parseTimestamp(params.get('from'))
  if (from !== undefined) filter.from = from
  const to = parseTimestamp(params.get('to'))
  if (to !== undefined) filter.to = to

  // An explicit instant wins over a relative window: the advanced panel's
  // from/to pair *is* what the 自定义 segment means, and a window that quietly
  // overrode a hand-typed timestamp would make the two controls fight.
  const windowKey = textParam(params, 'window')
  const span =
    windowKey === undefined ? undefined : AUDIT_WINDOW_MS.get(windowKey)
  if (
    span !== undefined &&
    windowKey !== undefined &&
    from === undefined &&
    to === undefined
  ) {
    filter.window = windowKey
    filter.from = now - span
  }

  const limit = parseLimit(params.get('limit'))
  if (limit !== undefined) filter.limit = limit

  return filter
}

// --- body parsing --------------------------------------------------------

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

function requiredString(
  body: Record<string, unknown>,
  key: string,
): Parsed<string> {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, message: `字段 ${key} 必须是非空字符串` }
  }
  return { ok: true, value }
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): Parsed<string | undefined> {
  const value = body[key]
  if (value === undefined || value === null)
    return { ok: true, value: undefined }
  if (typeof value !== 'string') {
    return { ok: false, message: `字段 ${key} 必须是字符串` }
  }
  return { ok: true, value }
}

function parseRegisterInput(
  body: Record<string, unknown>,
): Parsed<RegisterAgentInput> {
  const address = requiredString(body, 'address')
  if (!address.ok) return address
  const endpoint = requiredString(body, 'endpoint')
  if (!endpoint.ok) return endpoint
  const publicKey = optionalString(body, 'publicKey')
  if (!publicKey.ok) return publicKey
  const status = optionalString(body, 'status')
  if (!status.ok) return status

  const rawCapabilities = body['capabilities']
  let capabilities: readonly string[] | undefined
  if (rawCapabilities !== undefined && rawCapabilities !== null) {
    if (
      !Array.isArray(rawCapabilities) ||
      rawCapabilities.some(item => typeof item !== 'string')
    ) {
      return { ok: false, message: '字段 capabilities 必须是字符串数组' }
    }
    capabilities = rawCapabilities as readonly string[]
  }

  return {
    ok: true,
    value: {
      address: address.value,
      endpoint: endpoint.value,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(publicKey.value === undefined ? {} : { publicKey: publicKey.value }),
      ...(status.value === undefined ? {} : { status: status.value }),
    },
  }
}

function parseWakeInput(body: Record<string, unknown>): Parsed<WakeInput> {
  const from = requiredString(body, 'from')
  if (!from.ok) return from
  const to = requiredString(body, 'to')
  if (!to.ok) return to
  const prompt = requiredString(body, 'prompt')
  if (!prompt.ok) return prompt
  const node = optionalString(body, 'node')
  if (!node.ok) return node
  // Optional, and empty means "the one this console was started with".
  // `createWakePort` pins the receipt URL and refuses any other value
  // (`consolePorts.ts`), so the field could only ever hold one string — the
  // form stopped asking for it, and a body without it is not malformed. Still
  // type-checked when present: a caller that sends a number is confused about
  // something and should hear about it.
  const url = optionalString(body, 'url')
  if (!url.ok) return url

  const rawAfter = body['afterMs']
  let afterMs: number | undefined
  if (rawAfter !== undefined && rawAfter !== null) {
    if (
      typeof rawAfter !== 'number' ||
      !Number.isFinite(rawAfter) ||
      rawAfter < 0
    ) {
      return { ok: false, message: '字段 afterMs 必须是非负数（毫秒）' }
    }
    afterMs = rawAfter
  }

  return {
    ok: true,
    value: {
      ...(node.value === undefined ? {} : { node: node.value }),
      from: from.value,
      to: to.value,
      prompt: prompt.value,
      url: url.value ?? '',
      ...(afterMs === undefined ? {} : { afterMs }),
    },
  }
}

function auditSources(deps: ConsoleDeps): readonly ConsoleAuditSource[] {
  return (
    deps.audits ?? [
      {
        node: DEFAULT_AUDIT_SOURCE_NODE,
        audit: deps.audit,
        kind: 'authoritative',
      },
    ]
  )
}

function auditSourceOf(
  deps: ConsoleDeps,
  node: string | undefined,
): ConsoleAuditSource | undefined {
  const sources = auditSources(deps)
  if (node === undefined || node === '') {
    return sources.length === 1 ? sources[0] : undefined
  }
  return sources.find(source => source.node === node)
}

async function readAuditSources(deps: ConsoleDeps, filter: AuditFilter) {
  return await Promise.all(
    auditSources(deps).map(async source => {
      const result = await source.audit.read(filter)
      return {
        node: source.node,
        kind: source.kind,
        ...(source.maxLagMinutes === undefined
          ? {}
          : { maxLagMinutes: source.maxLagMinutes }),
        page: valueOf(result),
        failure: failureOf(result),
      }
    }),
  )
}

// --- HTML routes ---------------------------------------------------------

/** The roster fragment, plus the list it was rendered from. */
interface RosterRender {
  readonly html: string
  /**
   * The agents themselves, so the page around the fragment can build its two
   * address pickers (the wake target and the trail's node filter) from the
   * *same* read rather than asking the registry a second time.
   */
  readonly agents: readonly ConsoleAgent[] | null
}

async function rosterFragment(
  deps: ConsoleDeps,
  now: number,
): Promise<RosterRender> {
  // Two independent reads, overlapped: the certificate face lives behind the
  // same zero-auth registry the roster does (§5.2), and serialising them would
  // double the page's worst case for no gain. A certificate port that fails is
  // a strip on the page, never a 500 — same rule as every other port here.
  const certificatePort = deps.certificates
  const [result, certificates] = await Promise.all([
    deps.registry.list(),
    certificatePort?.read(),
  ])
  const agents = valueOf(result)
  return {
    html: renderRoster(
      agents,
      failureOf(result),
      now,
      deps.limits.registryTtlMs,
      certificatePort === undefined || certificates === undefined
        ? undefined
        : {
            snapshot: valueOf(certificates),
            failure: failureOf(certificates),
            roots: certificatePort.roots(),
            binName: deps.binName ?? DEFAULT_BIN_NAME,
          },
      deps.nodeServers,
    ),
    agents,
  }
}

/**
 * The limits snapshot as the page states it.
 *
 * Only `registryTtlMs` differs from `deps.limits`: on the page it is the lease
 * the registry actually grants ({@link rosterLease}), read off the same roster
 * the header and every row are judged from, so the three places that print a
 * lease cannot disagree with each other or with the registry. `deps.limits`
 * carries the package default and stays what `/v0/limits` reports; it is the
 * number shown only when the roster offers nothing to read a lease from.
 */
function pageLimits(
  deps: ConsoleDeps,
  agents: readonly ConsoleAgent[] | null,
): LimitsSnapshot {
  return {
    ...deps.limits,
    registryTtlMs: rosterLease(agents ?? [], deps.limits.registryTtlMs),
  }
}

/**
 * The servers section, or nothing at all.
 *
 * `undefined` — not an empty string — when this console was started without a
 * mapping: `page.ts` then leaves the whole section out rather than rendering a
 * header over an explanation nobody asked for. Degradation here is "the feature
 * is not on this console", which is a different thing from "the feature failed".
 *
 * A note read that fails does **not** take the section with it: the machines
 * come from the startup flags and are still true, so the strip goes above them.
 */
async function serversFragment(
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  now: number,
): Promise<string | undefined> {
  const nodeServers = nodeServersOf(deps)
  if (nodeServers.length === 0) return undefined
  const notes = await deps.serverNotes?.list()
  return renderServers({
    cards: serverCards(nodeServers, notes?.ok === true ? notes.value : []),
    failure: notes === undefined ? null : failureOf(notes),
    // Both halves matter: a view token may read a note but not write one, and
    // a console with no store may not write one whoever is holding it.
    editable: credential.role === 'admin' && deps.serverNotes !== undefined,
    notesEnabled: deps.serverNotes !== undefined,
    now,
  })
}

async function auditFragment(
  deps: ConsoleDeps,
  filter: AuditFilter,
  agentOptions?: string,
): Promise<string> {
  const sources = auditSources(deps)
  if (sources.length === 1 && deps.audits === undefined) {
    const result = await deps.audit.read(filter)
    return renderAudit(valueOf(result), failureOf(result), filter, agentOptions)
  }
  return renderAuditSources(
    await readAuditSources(deps, filter),
    filter,
    agentOptions,
  )
}

/**
 * The roster the chat views annotate themselves with.
 *
 * A failed lookup is `null`, not an empty list: "the registry says this agent
 * is gone" and "nobody could ask the registry" are different facts and the view
 * renders them differently (`view/chat.ts`, `targetState`).
 */
async function chatTargets(
  chat: ChatPort,
): Promise<readonly ChatTarget[] | null> {
  const result = await chat.targets()
  return result.ok ? result.value : null
}

/**
 * The failure a member gets for a session it may not see, in place of any
 * port call: the same `not_found` the port gives for one that does not exist.
 */
const HIDDEN_SESSION: ConsoleFailure = {
  code: 'not_found',
  message: CHAT_SESSION_NOT_FOUND,
}

async function chatSessionsFragment(
  chat: ChatPort,
  activeId: string | null,
  now: number,
  scope: ChatScope,
): Promise<string> {
  const [sessions, targets] = await Promise.all([
    chat.sessions(),
    chatTargets(chat),
  ])
  return renderChatSessions({
    // Fetched whole and filtered here: the port has no notion of an owner,
    // and the ownership record lives beside it in the account book.
    sessions: sessions.ok
      ? sessions.value.filter(session => scope.visible(session.id))
      : [],
    targets: targets ?? [],
    failure: failureOf(sessions),
    activeId: activeId !== null && scope.visible(activeId) ? activeId : null,
    now,
  })
}

/** The thread fragment plus the one bit the page around it needs. */
interface ChatThreadRender {
  readonly html: string
  /** True when a session really opened — what enables the composer. */
  readonly open: boolean
}

async function chatThreadFragment(
  chat: ChatPort,
  sessionId: string | null,
  now: number,
  scope: ChatScope,
): Promise<ChatThreadRender> {
  if (sessionId === null || sessionId === '') {
    return {
      html: renderChatThread({
        transcript: null,
        failure: null,
        target: null,
        now,
      }),
      open: false,
    }
  }
  if (!scope.visible(sessionId)) {
    return {
      html: renderChatThread({
        transcript: null,
        failure: HIDDEN_SESSION,
        target: null,
        now,
      }),
      open: false,
    }
  }
  const [transcript, targets] = await Promise.all([
    chat.transcript(sessionId),
    chatTargets(chat),
  ])
  const address = transcript.ok ? transcript.value.session.target : ''
  return {
    html: renderChatThread({
      transcript: valueOf(transcript),
      failure: failureOf(transcript),
      target: targets?.find(target => target.address === address) ?? null,
      registryDown: targets === null,
      now,
    }),
    // The composer is enabled by a transcript that actually loaded, not by the
    // query string naming one: a stale `?session=` out of a bookmark must not
    // put a live send button under a failure strip.
    open: transcript.ok,
  }
}

async function handleChatPage(
  deps: ConsoleDeps,
  chat: ChatPort,
  credential: ConsoleCredential,
  url: URL,
  now: number,
  scope: ChatScope,
  viewer: PageViewer | undefined,
): Promise<Response> {
  const sessionId = textParam(url.searchParams, 'session') ?? null
  const [sessions, thread] = await Promise.all([
    chatSessionsFragment(chat, sessionId, now, scope),
    chatThreadFragment(chat, sessionId, now, scope),
  ])
  return html(
    renderChatPage({
      label: deps.label ?? DEFAULT_LABEL,
      now,
      sessions,
      thread: thread.html,
      composerEnabled: thread.open,
      role: credential.role,
      ...(viewer === undefined ? {} : { viewer }),
    }),
  )
}

async function handleIndex(
  deps: ConsoleDeps,
  access: Access,
  url: URL,
  now: number,
  viewer: PageViewer | undefined,
): Promise<Response> {
  const credential = access.credential
  const filter = parseAuditFilter(url, now)
  // Both panels are independent reads; a slow registry should not serialise
  // in front of the trail. The trail's *markup* does depend on the roster —
  // its node filter offers the addresses that exist rather than a box to
  // retype one into — so the two reads still overlap and only the render
  // waits.
  const [roster, trails, servers] = await Promise.all([
    rosterFragment(deps, now),
    readAuditSources(deps, filter),
    serversFragment(deps, credential, now),
  ])
  const targetOptions = wakeTargetOptions(
    roster.agents,
    now,
    deps.limits.registryTtlMs,
  )
  const audit =
    auditSources(deps).length === 1 && deps.audits === undefined
      ? renderAudit(
          trails[0]?.page ?? null,
          trails[0]?.failure ?? null,
          filter,
          agentFilterOptions(roster.agents, filter.agent),
        )
      : renderAuditSources(
          trails,
          filter,
          agentFilterOptions(roster.agents, filter.agent),
        )
  return html(
    renderPage({
      label: deps.label ?? DEFAULT_LABEL,
      now,
      roster: roster.html,
      audit,
      targetOptions,
      ...(deps.wakeUrl === undefined ? {} : { wakeUrl: deps.wakeUrl }),
      ...(deps.wakeTargets === undefined
        ? {}
        : { wakeTargets: deps.wakeTargets }),
      ...(deps.identity === undefined ? {} : { identity: deps.identity }),
      ...(servers === undefined ? {} : { servers }),
      limits: renderLimits(pageLimits(deps, roster.agents)),
      // The form is rendered disabled with a reason rather than hidden: an
      // operator who cannot find the wake button assumes the console is broken.
      wakeEnabled:
        deps.wake !== undefined ||
        deps.wakeTargets?.some(target => target.wake !== undefined) === true,
      // Gated on role, not merely on whether a channel is wired: the module
      // note above ("Chat is admin-only, all of it") says a view token must
      // not even learn that a conversation exists. A link that is present but
      // 403s on click leaks exactly that, so the nav item is hidden from
      // anyone who is not admin, channel or no channel.
      //
      // With accounts, a `member` gets the link too: the chat face is theirs,
      // scoped to their own sessions (`mayChat`).
      chatEnabled: deps.chat !== undefined && mayChat(access),
      auditFilter: filter,
      // The sidebar states which of the two credentials this is, and offers the
      // way out of a cookie the page cannot read (`bits.ts`).
      role: credential.role,
      ...(viewer === undefined ? {} : { viewer }),
    }),
  )
}

// --- JSON routes ---------------------------------------------------------

async function handleAgentsCollection(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
): Promise<Response> {
  if (request.method === 'GET') {
    const denied = guard(credential, 'view', 'guarded')
    if (denied !== null) return denied
    const result = await deps.registry.list()
    return result.ok
      ? json({ agents: result.value })
      : failureResponse(result.failure)
  }
  if (request.method === 'POST') {
    const denied = guard(credential, 'admin', 'guarded')
    if (denied !== null) return denied
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const input = parseRegisterInput(body)
    if (!input.ok) return fail(400, 'invalid', input.message)
    const result = await deps.registry.register(input.value)
    // 200, not 201: the port answers with the record either way and cannot say
    // whether this address was new, so claiming "created" would be a guess.
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  return methodNotAllowed(['GET', 'POST'])
}

async function handleAgentItem(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  address: string,
): Promise<Response> {
  const denied = guard(credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE'])
  const result = await deps.registry.deregister(address)
  return result.ok
    ? new Response(null, { status: 204 })
    : failureResponse(result.failure)
}

async function handleHeartbeat(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  address: string,
): Promise<Response> {
  const denied = guard(credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const result = await deps.registry.heartbeat(address)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

async function handleWake(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
): Promise<Response> {
  const denied = guard(credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const wake = deps.wake
  if (wake === undefined && deps.wakeTargets === undefined) {
    return fail(
      501,
      'unsupported',
      '该控制台没有配置唤醒通道（缺少传输层 PSK），因此不能发起唤醒；' +
        '请在启动 occ console 时提供 PSK 后重试。',
    )
  }
  const body = await readJsonObject(request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const input = parseWakeInput(body)
  if (!input.ok) return fail(400, 'invalid', input.message)
  const configuredTargets = deps.wakeTargets
  if (configuredTargets !== undefined) {
    if (input.value.node === undefined || input.value.node.trim() === '') {
      return fail(400, 'invalid', '多目标唤醒必须给出 node')
    }
    const target = configuredTargets.find(
      candidate => candidate.node === input.value.node,
    )
    if (target === undefined) {
      return fail(403, 'rejected', '唤醒节点不在启动时配置的白名单中')
    }
    if (!input.value.to.startsWith('qianmo://' + target.node + '/')) {
      return fail(403, 'rejected', '唤醒地址与所选节点不匹配')
    }
    if (target.wake === undefined) {
      return fail(
        501,
        'unsupported',
        '节点 ' + target.node + ' 没有可用的唤醒 PSK',
      )
    }
    // The URL is selected only from the startup allowlist. A client-supplied
    // URL is intentionally discarded before it reaches the pinned wake port.
    const result = await target.wake.send({
      ...input.value,
      url: target.url,
    })
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  if (wake === undefined) {
    return fail(501, 'unsupported', '该控制台没有配置唤醒通道')
  }
  const result = await wake.send(input.value)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

/** The machines this console was started with. Empty means the face is off. */
function nodeServersOf(deps: ConsoleDeps): readonly NodeServer[] {
  return deps.nodeServers ?? []
}

const SERVERS_UNSUPPORTED =
  '该控制台没有配置服务器归属（启动时缺少 --node-server），因此没有可看的服务器；' +
  '请在启动 occ console 时用 --node-server <node>=<server> 指定后重试。'

/** An empty string is a legitimate value: it is how an operator clears a note. */
function parseServerNote(body: Record<string, unknown>): Parsed<string> {
  const value = body['note']
  if (typeof value !== 'string') {
    return { ok: false, message: '字段 note 必须是字符串' }
  }
  if (value.length > MAX_SERVER_NOTE_LENGTH) {
    return {
      ok: false,
      message: `备注最多 ${MAX_SERVER_NOTE_LENGTH} 个字符`,
    }
  }
  return { ok: true, value }
}

async function handleServers(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
): Promise<Response> {
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const nodeServers = nodeServersOf(deps)
  if (nodeServers.length === 0) {
    return fail(501, 'unsupported', SERVERS_UNSUPPORTED)
  }
  const notes = await deps.serverNotes?.list()
  if (notes !== undefined && !notes.ok) return failureResponse(notes.failure)
  return json({ servers: serverCards(nodeServers, notes?.value ?? []) })
}

/**
 * Write one machine's note.
 *
 * The allowlist check runs **before the body is read**, so an unknown id costs
 * a lookup rather than however many bytes the caller decided to send. See the
 * module note on why the id can only be one of the startup values.
 */
async function handleServerNote(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  server: string,
): Promise<Response> {
  const denied = guard(credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'PUT') return methodNotAllowed(['PUT'])
  const nodeServers = nodeServersOf(deps)
  if (nodeServers.length === 0) {
    return fail(501, 'unsupported', SERVERS_UNSUPPORTED)
  }
  if (!nodeServers.some(entry => entry.server === server)) {
    return fail(403, 'rejected', '该服务器不在启动时配置的白名单中')
  }
  const notes = deps.serverNotes
  if (notes === undefined) {
    return fail(
      501,
      'unsupported',
      '该控制台没有配置备注存储，因此不能保存备注。',
    )
  }
  const body = await readJsonObject(request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const note = parseServerNote(body)
  if (!note.ok) return fail(400, 'invalid', note.message)
  const result = await notes.set(server, note.value)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

async function handleAudit(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  url: URL,
  now: number,
): Promise<Response> {
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const requestedNode = textParam(url.searchParams, 'node')
  const source = auditSourceOf(deps, requestedNode)
  if (source !== undefined) {
    const result = await source.audit.read(parseAuditFilter(url, now))
    return result.ok ? json(result.value) : failureResponse(result.failure)
  }
  if (requestedNode !== undefined) {
    return fail(404, 'not_found', '未配置该审计节点')
  }
  const sources = await readAuditSources(deps, parseAuditFilter(url, now))
  return json({ audits: sources })
}

async function handleChain(
  request: Request,
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  traceId: string,
  node: string | undefined,
): Promise<Response> {
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  const source = auditSourceOf(deps, node)
  if (source === undefined) {
    return fail(
      node === undefined ? 400 : 404,
      node === undefined ? 'invalid' : 'not_found',
      node === undefined ? '多链审计详情必须给出 node' : '未配置该审计节点',
    )
  }
  const result = await source.audit.chain(traceId)
  // A trace with no records is `{ chain: null }` and a 200: "that trace is not
  // in this trail" is an answer, not a failure of the lookup.
  return result.ok
    ? json({ chain: result.value })
    : failureResponse(result.failure)
}

// --- chat ----------------------------------------------------------------

/**
 * How often the stream writes a comment line when nothing has happened.
 *
 * Not decoration. An `EventSource` over an idle connection is indistinguishable
 * from a dead one until something is written, and every layer between the
 * browser and this process — a reverse proxy, a laptop's NAT table, an SSH
 * tunnel — will eventually reclaim a socket that has said nothing. 15 s is well
 * inside the shortest of those, and a comment line costs 14 bytes.
 */
export const CHAT_STREAM_HEARTBEAT_MS = 15_000

/** What the browser is told to wait before redialling a dropped stream. */
const CHAT_STREAM_RETRY_MS = 3_000

const EVENT_STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  // Turns off response buffering in the proxies that honour it. Without it a
  // buffering proxy holds every event until the stream closes, which looks
  // exactly like a console that never answers.
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
} as const

function chatUnsupported(): Response {
  return fail(
    501,
    'unsupported',
    '该控制台没有配置聊天通道；请在启动 occ console 时给 --chat-url 与传输层 PSK 后重试。',
  )
}

/**
 * The live stream, as Server-Sent Events.
 *
 * Every event is a bare `{sessionId, revision}` and the page answers it by
 * refetching a server-rendered fragment. Pushing the message *content* down
 * this pipe would be one line shorter and would open a second path by which a
 * remote agent's output reaches the DOM — the whole point of `view/chat.ts`
 * escaping on the way out is that there is only one such path.
 *
 * Teardown is the part worth reading: `subscribe` returns an unsubscribe
 * function, the heartbeat is an interval, and both have to be released whether
 * the browser navigated away (`cancel`) or the enqueue threw because the
 * controller is already closed. A leaked subscription on a long-lived console
 * is a listener list that only grows.
 */
function chatStream(chat: ChatPort, scope?: StreamScope): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let detach: (() => void) | null = null

  const release = (): void => {
    unsubscribe?.()
    unsubscribe = null
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
    detach?.()
    detach = null
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          // The peer is gone and the controller is closed. Nothing to report
          // and nothing to retry — just stop paying for it.
          release()
        }
      }
      // Ended from this side: the account behind it was revoked or reset, its
      // session ran out, or the book closed (`accountsHttp.ts`, `StreamScope`).
      const end = (): void => {
        release()
        try {
          controller.close()
        } catch {
          // Already closed by the peer; the release above is what mattered.
        }
      }
      // A comment first: it completes the response headers immediately, so the
      // browser fires `open` rather than sitting in `CONNECTING` until the
      // first real event, which may be minutes away.
      push(`retry: ${CHAT_STREAM_RETRY_MS}\n: open\n\n`)
      unsubscribe = chat.subscribe((update: ChatUpdate) => {
        // A person hears about their own sessions only. The event carries no
        // content, but a session id and its cadence are still somebody else's.
        if (scope !== undefined && !scope.visible(update.sessionId)) return
        push(`event: chat\ndata: ${JSON.stringify(update)}\n\n`)
      })
      heartbeat = setInterval(() => {
        if (scope !== undefined && !scope.alive()) {
          end()
          return
        }
        push(': keep-alive\n\n')
      }, CHAT_STREAM_HEARTBEAT_MS)
      heartbeat.unref?.()
      if (scope !== undefined) detach = scope.attach(end)
    },
    cancel() {
      release()
    },
  })

  return new Response(body, { status: 200, headers: EVENT_STREAM_HEADERS })
}

function parseChatText(body: Record<string, unknown>): Parsed<string> {
  const text = requiredString(body, 'text')
  if (!text.ok) return text
  if (text.value.length > MAX_CHAT_TEXT_LENGTH) {
    return {
      ok: false,
      message: `消息最长 ${MAX_CHAT_TEXT_LENGTH} 个字符，这条有 ${text.value.length} 个`,
    }
  }
  return text
}

async function handleChatSessions(
  request: Request,
  chat: ChatPort,
  scope: ChatScope,
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  if (request.method === 'GET') {
    const result = await chat.sessions()
    return result.ok
      ? json({
          sessions: result.value.filter(session => scope.visible(session.id)),
        })
      : failureResponse(result.failure)
  }
  if (request.method === 'POST') {
    const body = await readJsonObject(request)
    if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
    const target = requiredString(body, 'target')
    if (!target.ok) return fail(400, 'invalid', target.message)
    const result = await chat.open(target.value)
    if (!result.ok) return failureResponse(result.failure)
    if (scope.opener !== null && accounts !== undefined) {
      // The owner is written before the session is handed back: a session a
      // person opened must never be seen without one. If the book cannot take
      // it, the book is closed now and the caller's next request is a 503
      // anyway; the session stays in the store, owned by nobody, which only
      // ops and the admin token can see.
      const owned = accounts.book.recordOwner(result.value.id, scope.opener)
      if (!owned.ok) {
        return fail(503, 'unavailable', owned.refusal.message)
      }
    }
    return json(result.value)
  }
  return methodNotAllowed(['GET', 'POST'])
}

async function dispatchChatApi(
  request: Request,
  deps: ConsoleDeps,
  access: Access,
  url: URL,
  segments: readonly string[],
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  const name = segments[2]
  // The stream is the one route here an `EventSource` opens, and an
  // `EventSource` cannot send the console header any more than a navigation
  // can — so it is classed `stream` rather than `guarded` and leans on
  // `Sec-Fetch-Site` instead. See the module note.
  const protection: Protection =
    name === 'stream' && segments.length === 3 ? 'stream' : 'guarded'
  // Admin before existence: an anonymous caller must not learn which consoles
  // have a chat channel wired by comparing 401 against 501.
  const denied = guardChat(access, protection)
  if (denied !== null) return denied
  const chat = deps.chat
  if (chat === undefined) return chatUnsupported()
  const scope = chatScopeOf(access, accounts)

  if (name === 'targets' && segments.length === 3) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    const result = await chat.targets()
    return result.ok
      ? json({ targets: result.value })
      : failureResponse(result.failure)
  }

  if (name === 'stream' && segments.length === 3) {
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return chatStream(chat, streamScopeOf(access, accounts))
  }

  if (name === 'sessions') {
    if (segments.length === 3) {
      return await handleChatSessions(request, chat, scope, accounts)
    }
    const sessionId = decodeURIComponent(segments[3] ?? '')
    if (segments.length === 4) {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      if (!scope.visible(sessionId)) return failureResponse(HIDDEN_SESSION)
      const result = await chat.transcript(sessionId)
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
    if (segments.length === 5 && segments[4] === 'messages') {
      if (request.method !== 'POST') return methodNotAllowed(['POST'])
      if (!scope.visible(sessionId)) return failureResponse(HIDDEN_SESSION)
      const body = await readJsonObject(request)
      if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
      const text = parseChatText(body)
      if (!text.ok) return fail(400, 'invalid', text.message)
      const result = await chat.send({ sessionId, text: text.value })
      return result.ok ? json(result.value) : failureResponse(result.failure)
    }
  }

  return notFound(`unknown path: ${url.pathname}`)
}

// --- dispatch ------------------------------------------------------------

async function dispatchApi(
  request: Request,
  deps: ConsoleDeps,
  access: Access,
  url: URL,
  segments: readonly string[],
  now: number,
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  const head = segments[1]
  const credential = access.credential

  // Only when accounts are on: without a book this path is the plain 404 it
  // has always been (`test/legacyParity.test.ts`). `ops` reads as admin, so
  // the guard is the one every admin route uses; the ledger names the person,
  // or `legacy:admin` for the token.
  if (head === 'accounts' && accounts !== undefined) {
    const denied = guard(credential, 'admin', 'guarded')
    if (denied !== null) return denied
    const principal = access.principal
    return await handleAccountsApi(
      request,
      accounts.book,
      principal?.kind === 'user' ? principal.subject : 'legacy:admin',
      segments,
      url,
    )
  }

  if (head === 'health' && segments.length === 2) {
    // Public: a liveness probe that needs a credential is a probe nobody wires.
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return json({ status: 'ok' })
  }

  if (head === 'limits' && segments.length === 2) {
    const denied = guard(credential, 'view', 'guarded')
    if (denied !== null) return denied
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return json(deps.limits)
  }

  if (head === 'wake' && segments.length === 2) {
    return await handleWake(request, deps, credential)
  }

  if (head === 'chat' && segments.length >= 3) {
    return await dispatchChatApi(request, deps, access, url, segments, accounts)
  }

  if (head === 'servers') {
    if (segments.length === 2) {
      return await handleServers(request, deps, credential)
    }
    // The id rides in one percent-encoded segment, the same convention an
    // address uses. The charset the host enforces stops short of `/`, but it
    // allows `:` — an IPv6 literal is a legitimate machine name — so the
    // segment still has to be decoded rather than read raw.
    if (segments.length === 4 && segments[3] === 'note') {
      return await handleServerNote(
        request,
        deps,
        credential,
        decodeURIComponent(segments[2] ?? ''),
      )
    }
    return notFound(`unknown path: ${url.pathname}`)
  }

  if (head === 'audit') {
    if (segments.length === 2)
      return await handleAudit(request, deps, credential, url, now)
    if (segments.length === 4 && segments[2] === 'chain') {
      return await handleChain(
        request,
        deps,
        credential,
        decodeURIComponent(segments[3] ?? ''),
        textParam(url.searchParams, 'node'),
      )
    }
    return notFound(`unknown path: ${url.pathname}`)
  }

  if (head === 'agents') {
    if (segments.length === 2) {
      return await handleAgentsCollection(request, deps, credential)
    }
    const address = decodeURIComponent(segments[2] ?? '')
    if (segments.length === 3) {
      return await handleAgentItem(request, deps, credential, address)
    }
    if (segments.length === 4 && segments[3] === 'heartbeat') {
      return await handleHeartbeat(request, deps, credential, address)
    }
    return notFound(`unknown path: ${url.pathname}`)
  }

  return notFound(`unknown path: ${url.pathname}`)
}

async function chainFragment(
  deps: ConsoleDeps,
  traceId: string,
  node: string | undefined,
): Promise<string> {
  const source = auditSourceOf(deps, node)
  if (source === undefined) {
    return failureBar(
      {
        code: node === undefined ? 'invalid' : 'not_found',
        message:
          node === undefined ? '多链审计详情必须给出 node' : '未配置该审计节点',
      },
      '读取消息链失败',
    )
  }
  const result = await source.audit.chain(traceId)
  // `renderChain` takes no failure argument — a chain either reconstructs or
  // it does not — so an unreadable trail borrows the same red strip the other
  // two fragments show. Answering this route with JSON instead would hand the
  // client something it cannot put in the DOM.
  return result.ok
    ? renderChain(result.value)
    : failureBar(result.failure, '读取消息链失败')
}

async function dispatchFragment(
  request: Request,
  deps: ConsoleDeps,
  access: Access,
  url: URL,
  segments: readonly string[],
  now: number,
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  const name = segments[1] ?? ''
  const isChain = name === 'chain' && segments.length === 3
  const credential = access.credential

  // The two chat fragments take the admin path in full — see the module note
  // on why the chat face has no read-only tier.
  if (name === 'chat') {
    const deniedAdmin = guardChat(access, 'guarded')
    if (deniedAdmin !== null) return deniedAdmin
    const chat = deps.chat
    if (chat === undefined) return chatUnsupported()
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    const scope = chatScopeOf(access, accounts)
    if (segments[2] === 'sessions' && segments.length === 3) {
      const active = textParam(url.searchParams, 'active') ?? null
      return html(await chatSessionsFragment(chat, active, now, scope))
    }
    if (segments[2] === 'thread' && segments.length === 4) {
      const sessionId = decodeURIComponent(segments[3] ?? '')
      return html((await chatThreadFragment(chat, sessionId, now, scope)).html)
    }
    return notFound(`unknown path: ${url.pathname}`)
  }

  if (
    !isChain &&
    (segments.length !== 2 ||
      (name !== 'roster' && name !== 'audit' && name !== 'limits'))
  ) {
    return notFound(`unknown path: ${url.pathname}`)
  }
  const denied = guard(credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  if (isChain) {
    return html(
      await chainFragment(
        deps,
        decodeURIComponent(segments[2] ?? ''),
        textParam(url.searchParams, 'node'),
      ),
    )
  }
  if (name === 'roster') return html((await rosterFragment(deps, now)).html)
  if (name === 'audit') {
    return html(await auditFragment(deps, parseAuditFilter(url, now)))
  }
  // The same section the page renders, so the same registry read behind it: a
  // fragment that printed the package default here would put the page's
  // 注册租约 back to 1 分 30 秒 on its first refresh. A registry that is down
  // costs the observed lease, not the fragment.
  const listed = await deps.registry.list()
  return html(renderLimits(pageLimits(deps, valueOf(listed))))
}

/**
 * Set on every response to a request made with the admin token in
 * break-glass (§3.4 ②), so a script's own logs show it too, not only the page.
 */
const BREAK_GLASS_HEADER = 'x-qianmo-break-glass'

async function route(
  request: Request,
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  throttle: LoginThrottle,
  clientKey: string,
  now: () => number,
  accounts: ConsoleAccounts | undefined,
): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter(s => s.length > 0)

  // Public, and deliberately checked before any credential: see the module
  // note on why the two assets are not gated.
  if (segments[0] === 'assets' && segments.length === 2) {
    if (segments[1] !== 'app.css' && segments[1] !== 'app.js') {
      return notFound(`unknown path: ${url.pathname}`)
    }
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return segments[1] === 'app.css'
      ? asset(CONSOLE_CSS, 'text/css; charset=utf-8')
      : asset(
          accounts === undefined
            ? CONSOLE_CLIENT_JS
            : CONSOLE_CLIENT_JS_ACCOUNTS,
          'text/javascript; charset=utf-8',
        )
  }

  // Without accounts this is `credentialOf` and nothing else (`access.ts`).
  const access = resolveAccess(request, tokens, accounts)
  if (!access.breakGlass || accounts === undefined) {
    return await routeAs(
      request,
      deps,
      tokens,
      throttle,
      clientKey,
      now,
      accounts,
      access,
      url,
      segments,
    )
  }
  // Recorded before the route runs, so a request that fails still counts as a
  // use; never refused for failing to record (`AccountBook.recordBreakGlass`).
  accounts.book.recordBreakGlass(
    adminFingerprint(tokens),
    request.method,
    url.pathname,
  )
  const response = await routeAs(
    request,
    deps,
    tokens,
    throttle,
    clientKey,
    now,
    accounts,
    access,
    url,
    segments,
  )
  response.headers.set(BREAK_GLASS_HEADER, '1')
  return response
}

async function routeAs(
  request: Request,
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  throttle: LoginThrottle,
  clientKey: string,
  now: () => number,
  accounts: ConsoleAccounts | undefined,
  access: Access,
  url: URL,
  segments: readonly string[],
): Promise<Response> {
  const credential = access.credential

  // The door, and the way back out of it. Both public: a login page that needs
  // a credential is a login page nobody can reach, and a logout that needs one
  // strands whoever's token was rotated while their tab was open.
  if (segments[0] === 'login' && segments.length === 1) {
    return await handleLogin(
      request,
      deps,
      tokens,
      credential,
      throttle,
      url,
      clientKey,
      now(),
      accounts,
    )
  }

  if (segments[0] === 'logout' && segments.length === 1) {
    return handleLogout(request, accounts)
  }

  // The invitation door. Public like `/login` — an invitee has no credential
  // yet, that is the point — and absent entirely without accounts.
  if (
    accounts !== undefined &&
    segments[0] === 'invite' &&
    segments.length === 1
  ) {
    return await handleInvite(request, {
      book: accounts.book,
      label: deps.label ?? DEFAULT_LABEL,
      throttle,
      clientKey,
      now: now(),
    })
  }

  // Everything below needs a credential, and a request the account rules
  // refused (a personal credential in a link, the admin token outside a
  // Bearer header in break-glass, a closed account book) goes no further.
  if (access.refusal !== null) {
    return accessRefused(request, access.refusal, deps, url)
  }
  const denial = accounts === undefined ? undefined : access
  const viewer =
    accounts === undefined ? undefined : pageViewer(access, accounts, tokens)

  if (segments.length === 0) {
    const denied = guard(credential, 'view', 'document')
    if (denied !== null) {
      return documentDenial(request, denied, deps, url, denial)
    }
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return await handleIndex(deps, access, url, now(), viewer)
  }

  if (segments[0] === 'chat' && segments.length === 1) {
    const denied = guardChat(access, 'document')
    if (denied !== null) {
      return documentDenial(request, denied, deps, url, denial)
    }
    const chat = deps.chat
    // 404 rather than 501: this is a page, and on this instance there is no
    // such page. A script asking `/v0/chat/*` gets the 501 instead.
    if (chat === undefined) return notFound(`unknown path: ${url.pathname}`)
    if (request.method !== 'GET') return methodNotAllowed(['GET'])
    return await handleChatPage(
      deps,
      chat,
      credential,
      url,
      now(),
      chatScopeOf(access, accounts),
      viewer,
    )
  }

  if (segments[0] === 'v0') {
    return await dispatchApi(
      request,
      deps,
      access,
      url,
      segments,
      now(),
      accounts,
    )
  }

  if (segments[0] === 'fragments' && segments.length >= 2) {
    return await dispatchFragment(
      request,
      deps,
      access,
      url,
      segments,
      now(),
      accounts,
    )
  }

  return notFound(`unknown path: ${url.pathname}`)
}

/**
 * Just enough of `Bun.Server` to key the login throttle.
 *
 * Declared here rather than imported so this package keeps compiling — and
 * testing — without a Bun type in the signature: `Bun.serve` hands its `fetch`
 * a server that satisfies this structurally, and a test hands it nothing.
 */
export interface ClientAddressSource {
  requestIP(request: Request): { readonly address: string } | null
}

/**
 * Who the login throttle counts against.
 *
 * The peer address of the socket, and deliberately **not** `X-Forwarded-For`:
 * on a directly-reached console that header is written by the caller, so
 * trusting it would hand every attacker a fresh bucket per attempt. Behind a
 * reverse proxy every caller therefore shares one key — see `throttle.ts` on
 * why that is accepted. An address this layer cannot see falls back to a single
 * shared bucket rather than to no throttling at all.
 */
function clientKeyOf(request: Request, source?: ClientAddressSource): string {
  const address = source?.requestIP(request)?.address ?? ''
  return address === '' ? 'unknown' : address
}

/**
 * Build the console's request handler.
 *
 * Exposed separately from {@link startConsoleServer} so every route can be
 * driven with a plain `Request` — no port, no teardown, no timing. The second
 * parameter is what `Bun.serve` passes its `fetch`; it is optional so a test
 * can keep calling `handle(request)` with one argument.
 *
 * The login throttle is created here, once per console instance rather than
 * once per module: two consoles in one process (which is what the test suite
 * is) must not be able to lock each other out.
 */
export function createConsoleHandler(
  deps: ConsoleDeps,
  tokens: ConsoleTokens,
  accounts?: ConsoleAccounts,
): (request: Request, source?: ClientAddressSource) => Promise<Response> {
  if (accounts !== undefined) {
    assertTokensUnlikeAccountSecrets(tokens)
    // Once, at start: if the admin token last used as break-glass is not the
    // one in force now, the rotation happened and is written down (§3.4 ④).
    accounts.book.breakGlassStatus(adminFingerprint(tokens))
  }
  const now = deps.now ?? Date.now
  const throttle = new LoginThrottle()
  return async (
    request: Request,
    source?: ClientAddressSource,
  ): Promise<Response> => {
    try {
      return await route(
        request,
        deps,
        tokens,
        throttle,
        clientKeyOf(request, source),
        now,
        accounts,
      )
    } catch (error) {
      // Only reachable when a port breaks its contract and throws. The message
      // is included because the ports are ours and a silent 500 on a
      // loopback tool costs an hour; ports must therefore keep credentials out
      // of their error messages.
      const message = error instanceof Error ? error.message : String(error)
      return fail(500, 'internal', `控制台内部错误：${message}`)
    }
  }
}

export interface ConsoleServerOptions {
  /** Bind address. Loopback by default — see `auth.ts` on what else costs. */
  readonly hostname?: string
  /** The pair from `resolveTokens`. Required: there is no anonymous console. */
  readonly tokens: ConsoleTokens
  /** Personal accounts. Absent is today's console, byte for byte. */
  readonly accounts?: ConsoleAccounts
}

/** Live server handle returned by {@link startConsoleServer}. */
export interface ConsoleServerHandle {
  /** Port actually bound — meaningful when starting on port `0`. */
  readonly port: number
  /** Base URL, without a trailing slash and **without** the token. */
  readonly url: string
  stop(): Promise<void>
}

/**
 * Start the console. Pass `0` (the default) to let the OS pick a free port and
 * read the real one back from the handle.
 *
 * `options` is required even though `port` has a default — the tokens have no
 * safe default, so a caller that wants an ephemeral port writes
 * `startConsoleServer(deps, undefined, { tokens })`.
 */
export function startConsoleServer(
  deps: ConsoleDeps,
  port = 0,
  options: ConsoleServerOptions,
): ConsoleServerHandle {
  const hostname = options.hostname ?? '127.0.0.1'
  const server = Bun.serve({
    port,
    hostname,
    // Derived from the heartbeat rather than picked, and that is the whole
    // point: `Bun.serve` defaults to a 10 s idle timeout and closes any
    // connection that has said nothing for that long. A 15 s heartbeat under a
    // 10 s timeout means the chat stream is killed every ten seconds — measured
    // on Bun 1.3.13, the browser reports `ERR_INCOMPLETE_CHUNKED_ENCODING` and
    // redials, so the page keeps working and nothing looks broken except a
    // console full of errors and a reconnect storm. Writing the relationship
    // down as arithmetic is what stops the two numbers drifting apart again.
    idleTimeout: Math.min(
      255,
      Math.ceil((CHAT_STREAM_HEARTBEAT_MS / 1_000) * 2),
    ),
    fetch: createConsoleHandler(deps, options.tokens, options.accounts),
  })

  return {
    // Bun types `Server.port` as `number | undefined` because unix-socket
    // servers have no port. This server always binds TCP, so it is a number.
    port: server.port as number,
    url: `http://${hostname}:${server.port}`,
    stop: async (): Promise<void> => {
      await server.stop(true)
    },
  }
}
