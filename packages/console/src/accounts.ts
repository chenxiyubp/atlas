// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Personal accounts on the console: who they are, how they come to exist, the
 * sessions they hold, and the book that remembers all of it
 * (`tenancy-m1.md` §1.1, §3.1–§3.5).
 *
 * ## Invitation, not registration, and no password
 *
 * An account exists because an `ops` holder (or, during migration, the admin
 * token) issued an invitation for one. The invitation is a single-use random
 * token bound to a role, alive for at most {@link INVITE_TTL_MS}; consuming it
 * mints the account and its **personal credential** — 32 random bytes, shown
 * once, stored as a SHA-256. There is no password: recovering one needs an
 * out-of-band channel, and the invitation already is that channel, so a reset
 * is "clear the credential, issue a new invitation for the same account"
 * (§3.1).
 *
 * ## Sessions are the server's, and they end
 *
 * A browser holds a session id, never the credential. The id is minted here,
 * only here — a login or a redemption always gets a fresh one and closes the
 * one the browser came in with — and the session table keeps its hash. A
 * session ends when it is logged out, when its account is revoked or reset,
 * after {@link SESSION_IDLE_MS} without a request, or {@link SESSION_ABSOLUTE_MS}
 * after it began, whichever comes first (§3.3). The table is on disk, so a
 * console restart does not log everybody out; idleness is tracked in memory
 * and written at most every {@link SESSION_TOUCH_PERSIST_MS}, so after a
 * restart a session can expire up to that much *early*, never late.
 *
 * ## One place decides, one place remembers
 *
 * Everything here is synchronous on purpose. "This invitation has not been
 * used" and "it is used now" must be one step: an `await` between them is the
 * window in which two concurrent redemptions of the same token both succeed.
 * The ledger port is synchronous for the same reason (`deps.ts`,
 * `LedgerPort`).
 *
 * Both ledgers replay strictly (`ledger.ts`) and then every line must make
 * sense against the ones before it: an invitation consumed twice, a session
 * closed that was never opened, a revocation of an account that does not
 * exist, a record kind this version does not know. Any of those leaves the
 * book **unavailable** — personal access is refused, an alarm is raised, and
 * the two legacy tokens keep working so an operator can still reach the
 * console to see why. A write that fails does the same: memory and disk must
 * never be allowed to disagree, and the only safe side to fall on is the
 * closed one. A skipped `revoked` line is a person let back in; this book
 * does not skip.
 *
 * ## What is never on disk
 *
 * The invitation token, the personal credential and the session id. Each is
 * hashed before it is written, and the first two exist in plaintext in exactly
 * one response each.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { SESSION_MAX_AGE_SECONDS } from './auth.js'
import type { LedgerPort } from './deps.js'
import {
  encodeLedgerEntry,
  ledgerDigest,
  nextPrevious,
  readLedger,
  type LedgerData,
  type LedgerEntry,
} from './ledger.js'

/** Every personal credential starts with this. See {@link isPersonalCredential}. */
export const PERSONAL_CREDENTIAL_PREFIX = 'qmu_'

/** Every invitation token starts with this. */
const INVITE_TOKEN_PREFIX = 'qmi_'

/** Every session id starts with this. */
const SESSION_ID_PREFIX = 'qms_'

/** How long an invitation lives unless the issuer asks for less (§3.1: ≤ 72 h). */
const INVITE_TTL_MS = 72 * 60 * 60 * 1000

/** Shortest invitation an issuer may ask for. Anything shorter is a typo. */
const MIN_INVITE_TTL_MS = 5 * 60 * 1000

/**
 * Open (unused, unexpired, not withdrawn) invitations the console will hold
 * at once.
 *
 * Twenty covers a batch of new users for a 20–50 person beta, and caps what a
 * stolen `ops` credential can hand out before anybody reads the list. It is
 * also the ceiling on per-person quotas multiplying (§4.2): accounts only come
 * from invitations.
 */
export const MAX_OPEN_INVITES = 20

/** A session with no request for this long is over (§3.3). */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000

/**
 * A session is over this long after it began, busy or not. The same twelve
 * hours the legacy cookie lives (`auth.ts`), so the two credentials a browser
 * may carry during migration expire on one clock.
 */
export const SESSION_ABSOLUTE_MS = SESSION_MAX_AGE_SECONDS * 1000

/**
 * How often a busy session's last-seen time is written down. See the module
 * note: the error this introduces after a restart is on the early side.
 */
const SESSION_TOUCH_PERSIST_MS = 15 * 60 * 1000

/**
 * How often a break-glass *read* is written down. Every write request is
 * recorded; a page left open on the admin token polls every few seconds, and
 * one line per poll is the ledger bloat §3.4 warns about. The per-request
 * trail is P15.9's action ledger, not this book.
 */
const BREAK_GLASS_READ_RECORD_MS = 10 * 60 * 1000

/** Longest note an issuer can attach to an invitation / account. */
const MAX_LABEL_LENGTH = 40

/** Bytes of randomness in every secret this module mints. */
const SECRET_BYTES = 32

/** Longest chat context id the book will record an owner for. */
const MAX_CONTEXT_ID_LENGTH = 200

/** The ledger format version this code writes and accepts. */
const LEDGER_VERSION = 1

/**
 * Every key a ledger record may carry. `#append` refuses any other, so a
 * record cannot grow a plaintext field by accident: a secret reaches disk only
 * as one of the `…Hash` keys. `test/invites.test.ts` scans this list.
 */
const LEDGER_FIELDS: ReadonlySet<string> = new Set([
  'ledger',
  'version',
  'inviteId',
  'tokenHash',
  'role',
  'expiresAt',
  'issuedBy',
  'subject',
  'label',
  'credentialHash',
  'by',
  'sidHash',
  'reason',
  'contextId',
  'fingerprint',
  'method',
  'path',
  'from',
  'to',
])

/** What an account may do. `tenancy-m1.md` §3.2 has the table. */
export type AccountRole = 'viewer' | 'member' | 'ops'

/** A person, as the console names them: `u:` and 16 lowercase hex digits. */
export type AccountSubject = `u:${string}`

/**
 * Who is asking (`tenancy-m1.md` §1.1). A discriminated union rather than a
 * string sentinel, so "is this a person" is a type check and not a prefix
 * test somebody forgets.
 *
 * `credential` says how the person got here: a browser session, a personal
 * credential presented as `Authorization: Bearer`, or — reserved for P14 — an
 * approval session. `authenticatedAt` is when that credential was last proven:
 * the login for a session, the request itself for a bearer. P14 reads both to
 * decide what may approve (`authorization-m1.md` §3.3).
 *
 * The legacy tokens are principals too, so that code downstream asks one
 * question; they are never people, never own a session and never approve.
 */
export type ConsolePrincipal =
  | {
      readonly kind: 'user'
      readonly subject: AccountSubject
      readonly role: AccountRole
      readonly authenticatedAt: number
      readonly credential: 'session' | 'approval-session' | 'bearer'
    }
  | {
      readonly kind: 'legacy'
      readonly subject: 'legacy:view' | 'legacy:admin'
      readonly credential: 'session' | 'bearer'
    }

const ROLES: ReadonlySet<string> = new Set(['viewer', 'member', 'ops'])
const SUBJECT = /^u:[0-9a-f]{16}$/
const INVITE_ID = /^[0-9a-f]{16}$/
const DIGEST = /^[0-9a-f]{64}$/
const FINGERPRINT = /^[0-9a-f]{16}$/
/** Who may be named as the one who issued, withdrew or revoked something. */
const ACTOR = /^(u:[0-9a-f]{16}|legacy:admin)$/
const CLOSE_REASONS: ReadonlySet<string> = new Set([
  'logout',
  'rotated',
  'revoked',
  'reset',
  'expired',
])

type CloseReason = 'logout' | 'rotated' | 'revoked' | 'reset' | 'expired'

function isRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && ROLES.has(value)
}

function isSubject(value: unknown): value is AccountSubject {
  return typeof value === 'string' && SUBJECT.test(value)
}

/**
 * Refuse a legacy token that looks like one of this module's secrets.
 *
 * The prefixes are how the console tells a personal credential in a query
 * string from a legacy token that is allowed there, and how the page script
 * decides what it may keep. A legacy token that happened to start with one
 * would make both calls wrong, so a console with accounts on will not start
 * with one. `resolveTokens` is not touched for this (`tenancy-m1.md` §3.4):
 * its three rules are about the tokens, this one is about accounts.
 */
export function assertTokensUnlikeAccountSecrets(tokens: {
  readonly view: string
  readonly admin: string
}): void {
  for (const [which, token] of [
    ['view', tokens.view],
    ['admin', tokens.admin],
  ] as const) {
    if (
      token.startsWith(PERSONAL_CREDENTIAL_PREFIX) ||
      token.startsWith(INVITE_TOKEN_PREFIX) ||
      token.startsWith(SESSION_ID_PREFIX)
    ) {
      throw new Error(
        `开启账号时 ${which} token 不能以 ${PERSONAL_CREDENTIAL_PREFIX}、` +
          `${INVITE_TOKEN_PREFIX} 或 ${SESSION_ID_PREFIX} 开头；` +
          '这三个前缀留给个人凭据、邀请与会话，请换一枚 token。',
      )
    }
  }
}

/** True for a string shaped like a personal credential. Shape, not validity. */
export function isPersonalCredential(value: string): boolean {
  return value.startsWith(PERSONAL_CREDENTIAL_PREFIX)
}

/**
 * The part of the admin token the book may remember: 16 hex digits of its
 * SHA-256. Enough to tell "the token used then" from "the token in force
 * now", which is all rotation needs; not a way back to the token.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)
}

/**
 * May this principal approve an ask raised in a session owned by `owner`?
 * The contract P14 builds on (`tenancy-m1.md` §3.5, D10; `authorization-m1.md`
 * §3.3).
 *
 * Two axes, both required:
 *
 * - **who** — the owner of the session, or any personal `ops` account. An ask
 *   with no owner (`DEFAULT_CONTEXT`, a watch job, a peer's request) only ops
 *   may approve. `legacy:view` never, and the admin token never — as
 *   break-glass or otherwise (D7 ③).
 * - **with what** — an approval session or the personal credential itself. A
 *   plain browser session is ambient and long-lived, which is exactly what an
 *   approval must not ride on; P14 mints approval sessions for this.
 */
export function mayApprove(
  principal: ConsolePrincipal,
  owner: AccountSubject | null,
): boolean {
  if (principal.kind !== 'user') return false
  if (principal.credential === 'session') return false
  if (principal.role === 'ops') return true
  return (
    principal.role === 'member' && owner !== null && owner === principal.subject
  )
}

/** Why the book said no. `code` is for the HTTP layer, `message` for people. */
export interface AccountRefusal {
  readonly code: 'unavailable' | 'refused' | 'invalid' | 'not_found' | 'limit'
  readonly message: string
}

export type AccountOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: AccountRefusal }

/** The one answer every unusable, expired, withdrawn or unknown invitation gets. */
const INVITE_REFUSED = '邀请无效或已失效'

/** The one answer every credential or session that does not work gets. */
const CREDENTIAL_REFUSED = '凭据无效'

/** What the issuer gets back, exactly once. */
interface IssuedInvite {
  readonly inviteId: string
  /** The plaintext token. Not stored anywhere; this is its only appearance. */
  readonly token: string
  readonly role: AccountRole
  readonly expiresAt: number
  /** Present on a reset invitation: the account it restores. */
  readonly subject?: AccountSubject
}

/** What the invitee gets back, exactly once. */
interface AcceptedInvite {
  readonly subject: AccountSubject
  readonly role: AccountRole
  /** The plaintext personal credential. Its only appearance. */
  readonly credential: string
}

/** A freshly opened browser session. */
interface OpenedSession {
  /** The plaintext session id, for the cookie. The table keeps its hash. */
  readonly sid: string
  readonly principal: ConsolePrincipal
}

/** One invitation as the account list shows it. Never the token or its hash. */
interface InviteSummary {
  readonly inviteId: string
  readonly role: AccountRole
  readonly issuedAt: number
  readonly expiresAt: number
  readonly issuedBy: string
  readonly state: 'open' | 'expired' | 'consumed' | 'withdrawn'
  readonly subject?: AccountSubject
  readonly label?: string
}

/** One account as the account list shows it. Never the credential or its hash. */
interface AccountSummary {
  readonly subject: AccountSubject
  readonly role: AccountRole
  readonly createdAt: number
  readonly state: 'active' | 'reset' | 'revoked'
  readonly sessions: number
  readonly label?: string
}

/** What a revocation listener is told. P14 fans approvals out from this. */
export interface AccountEnded {
  readonly subject: AccountSubject
  /** `revoked` is final; `reset` means the person will be back with a new credential. */
  readonly reason: 'revoked' | 'reset'
}

/** Where the admin token stands, for the break-glass prompt (§3.4 ④). */
interface BreakGlassStatus {
  /** When the token now in force was last used as break-glass, if ever. */
  readonly lastUsedAt: number | null
  /** True when that use has not been followed by a rotation. */
  readonly rotationDue: boolean
}

interface InviteState {
  readonly inviteId: string
  readonly tokenHash: string
  readonly role: AccountRole
  readonly issuedAt: number
  readonly expiresAt: number
  readonly issuedBy: string
  readonly subject?: AccountSubject
  readonly label?: string
  state: 'open' | 'consumed' | 'withdrawn'
}

interface AccountState {
  readonly subject: AccountSubject
  readonly role: AccountRole
  readonly createdAt: number
  readonly label?: string
  credentialHash: string | null
  revoked: boolean
}

interface SessionState {
  readonly sidHash: string
  readonly subject: AccountSubject
  readonly createdAt: number
  lastSeenAt: number
  persistedAt: number
  closed: boolean
}

interface StreamHandle {
  readonly sidHash: string | null
  readonly close: () => void
}

export interface AccountBookOptions {
  /** The account ledger (`accounts.ndjson`). */
  readonly accounts: LedgerPort
  /** The session table (`sessions.ndjson`). */
  readonly sessions: LedgerPort
  readonly now?: () => number
  /** Source of randomness. Injected only so a collision can be forced in a test. */
  readonly randomBytes?: (size: number) => Uint8Array
  /** Where an alarm goes. The host writes it to stderr. */
  readonly onAlarm?: (message: string) => void
}

/** SHA-256 hex of a secret. The only form a secret takes on disk. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** True when a label is acceptable; `undefined` is always acceptable. */
function labelProblem(label: string | undefined): string | null {
  if (label === undefined) return null
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    return `备注须为 1 到 ${MAX_LABEL_LENGTH} 个字符`
  }
  for (let i = 0; i < label.length; i += 1) {
    const code = label.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return '备注不能含控制字符'
  }
  return null
}

function str(data: LedgerData, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' ? value : undefined
}

function num(data: LedgerData, key: string): number | undefined {
  const value = data[key]
  return typeof value === 'number' ? value : undefined
}

function refuse<T>(
  code: AccountRefusal['code'],
  message: string,
): AccountOutcome<T> {
  return { ok: false, refusal: { code, message } }
}

/** One ledger: the file, and where its chain ends. */
class Chain {
  readonly port: LedgerPort
  readonly name: string
  count = 0
  previous = ''

  constructor(port: LedgerPort, name: string) {
    this.port = port
    this.name = name
  }
}

export class AccountBook {
  readonly #now: () => number
  readonly #random: (size: number) => Uint8Array
  readonly #onAlarm: (message: string) => void
  readonly #accounts: Chain
  readonly #sessionsChain: Chain

  readonly #invites = new Map<string, InviteState>()
  readonly #inviteByHash = new Map<string, string>()
  readonly #accountsBySubject = new Map<AccountSubject, AccountState>()
  readonly #subjectByCredential = new Map<string, AccountSubject>()
  readonly #sessions = new Map<string, SessionState>()
  readonly #owners = new Map<string, AccountSubject>()
  readonly #streams = new Map<AccountSubject, Set<StreamHandle>>()
  readonly #endListeners = new Set<(event: AccountEnded) => void>()

  /** Fingerprint → last break-glass use, as replayed and as recorded since. */
  readonly #breakGlassUses = new Map<string, number>()
  /** Fingerprints a rotation away from has been recorded for. */
  readonly #rotatedFrom = new Set<string>()
  #lastBreakGlassRead = Number.NEGATIVE_INFINITY

  #problem: string | null = null
  #lastAlarmAt = Number.NEGATIVE_INFINITY

  constructor(options: AccountBookOptions) {
    this.#now = options.now ?? Date.now
    this.#random = options.randomBytes ?? (size => nodeRandomBytes(size))
    this.#onAlarm = options.onAlarm ?? (() => {})
    this.#accounts = new Chain(options.accounts, 'accounts')
    this.#sessionsChain = new Chain(options.sessions, 'sessions')
    // Accounts first: every session names an account, and a session table
    // read against an unreadable account ledger has nothing to be checked by.
    if (this.#load(this.#accounts, entry => this.#applyAccount(entry))) {
      this.#load(this.#sessionsChain, entry => this.#applySession(entry))
    }
  }

  /** Null when the book is usable; otherwise the reason it is not. */
  get problem(): string | null {
    return this.#problem
  }

  /**
   * Repeat the alarm for a refused request, at most once a minute.
   *
   * The first alarm fires when the problem is found, which on a console that
   * runs for weeks is a line nobody will scroll back to. The requests that
   * bounce off an unavailable book are what keep it in front of somebody.
   */
  remindUnavailable(): void {
    if (this.#problem === null) return
    const now = this.#now()
    if (now - this.#lastAlarmAt < 60_000) return
    this.#lastAlarmAt = now
    this.#onAlarm(`console accounts: ${this.#problem}；个人账号暂停服务`)
  }

  // --- loading -----------------------------------------------------------

  #fail(reason: string): void {
    if (this.#problem === null) this.#problem = reason
    this.#lastAlarmAt = this.#now()
    this.#onAlarm(`console accounts: ${reason}；个人账号暂停服务`)
    // Nothing a closed book knew can be trusted to end on its own schedule
    // any more; every live stream of every person ends now.
    this.#closeAllStreams()
  }

  /** Replay one ledger. False when it could not be trusted. */
  #load(chain: Chain, apply: (entry: LedgerEntry) => string | null): boolean {
    let text: string | null
    try {
      text = chain.port.read()
    } catch (error) {
      this.#fail(
        `${chain.port.path} 读不出来（${error instanceof Error ? error.message : String(error)}）`,
      )
      return false
    }
    const read = readLedger(text ?? '')
    if (!read.ok) {
      this.#fail(
        `${chain.port.path} 第 ${read.issue.line} 行：${read.issue.reason}`,
      )
      return false
    }
    for (const entry of read.entries) {
      const problem =
        entry.seq === 1 ? this.#header(chain, entry) : apply(entry)
      if (problem !== null) {
        this.#fail(`${chain.port.path} 第 ${entry.seq} 行：${problem}`)
        return false
      }
    }
    chain.count = read.entries.length
    chain.previous = nextPrevious(read.entries)
    if (chain.count === 0) {
      return this.#append(chain, 'ledger.header', {
        ledger: chain.name,
        version: LEDGER_VERSION,
      })
    }
    return true
  }

  #header(chain: Chain, entry: LedgerEntry): string | null {
    if (entry.kind !== 'ledger.header') return '首行不是账头'
    if (str(entry.data, 'ledger') !== chain.name) return '账名不对'
    if (num(entry.data, 'version') !== LEDGER_VERSION) {
      return `版本不是 ${LEDGER_VERSION}`
    }
    return null
  }

  /** Append one entry. False when it did not land, and the book is closed. */
  #append(chain: Chain, kind: string, data: LedgerData): boolean {
    if (this.#problem !== null) return false
    for (const key of Object.keys(data)) {
      // A programming error rather than a state of the world, so it throws
      // instead of closing the book: nothing was written.
      if (!LEDGER_FIELDS.has(key)) {
        throw new Error(`ledger field ${key} is not on the persisted list`)
      }
    }
    const entry: LedgerEntry = {
      seq: chain.count + 1,
      at: this.#now(),
      kind,
      data,
      prev: chain.previous,
    }
    try {
      chain.port.append(encodeLedgerEntry(entry))
    } catch (error) {
      this.#fail(
        `${chain.port.path} 写不进去（${error instanceof Error ? error.message : String(error)}）`,
      )
      return false
    }
    chain.count = entry.seq
    chain.previous = ledgerDigest(entry)
    return true
  }

  // --- replay ------------------------------------------------------------

  /** Apply one account-ledger entry, or say why it cannot be applied. */
  #applyAccount(entry: LedgerEntry): string | null {
    const data = entry.data
    switch (entry.kind) {
      case 'invite.issued': {
        const inviteId = str(data, 'inviteId')
        const tokenHash = str(data, 'tokenHash')
        const role = data['role']
        const expiresAt = num(data, 'expiresAt')
        const issuedBy = str(data, 'issuedBy')
        const subject = data['subject']
        const label = str(data, 'label')
        if (inviteId === undefined || !INVITE_ID.test(inviteId)) {
          return 'inviteId 不对'
        }
        if (this.#invites.has(inviteId)) return 'inviteId 重复'
        if (tokenHash === undefined || !DIGEST.test(tokenHash)) {
          return 'tokenHash 不对'
        }
        if (this.#inviteByHash.has(tokenHash)) return 'tokenHash 重复'
        if (!isRole(role)) return 'role 不对'
        if (expiresAt === undefined || expiresAt <= entry.at) {
          return 'expiresAt 不对'
        }
        if (issuedBy === undefined || !ACTOR.test(issuedBy)) {
          return 'issuedBy 不对'
        }
        if (subject !== undefined) {
          if (!isSubject(subject)) return 'subject 不对'
          const account = this.#accountsBySubject.get(subject)
          if (account === undefined || account.revoked) {
            return '重置邀请指向的账号不存在或已吊销'
          }
          if (account.role !== role) return '重置邀请的角色与账号不符'
        }
        if (labelProblem(label) !== null) return 'label 不对'
        this.#invites.set(inviteId, {
          inviteId,
          tokenHash,
          role,
          issuedAt: entry.at,
          expiresAt,
          issuedBy,
          ...(subject === undefined ? {} : { subject }),
          ...(label === undefined ? {} : { label }),
          state: 'open',
        })
        this.#inviteByHash.set(tokenHash, inviteId)
        return null
      }
      case 'invite.withdrawn': {
        const invite = this.#invites.get(str(data, 'inviteId') ?? '')
        if (invite === undefined) return '撤回了不存在的邀请'
        if (invite.state !== 'open') return '撤回了不是未用状态的邀请'
        if (!ACTOR.test(str(data, 'by') ?? '')) return 'by 不对'
        invite.state = 'withdrawn'
        return null
      }
      case 'account.created': {
        const invite = this.#invites.get(str(data, 'inviteId') ?? '')
        const subject = data['subject']
        const credentialHash = str(data, 'credentialHash')
        const label = str(data, 'label')
        if (invite === undefined) return '开户所用的邀请不存在'
        if (invite.state !== 'open') return '开户所用的邀请不是未用状态'
        if (invite.subject !== undefined) return '重置邀请被当成开户邀请'
        if (entry.at > invite.expiresAt) return '开户时邀请已过期'
        if (!isSubject(subject)) return 'subject 不对'
        if (this.#accountsBySubject.has(subject)) return 'subject 重复'
        if (data['role'] !== invite.role) return 'role 与邀请不符'
        if (credentialHash === undefined || !DIGEST.test(credentialHash)) {
          return 'credentialHash 不对'
        }
        if (this.#subjectByCredential.has(credentialHash)) {
          return 'credentialHash 重复'
        }
        if (labelProblem(label) !== null) return 'label 不对'
        invite.state = 'consumed'
        this.#accountsBySubject.set(subject, {
          subject,
          role: invite.role,
          createdAt: entry.at,
          ...(label === undefined ? {} : { label }),
          credentialHash,
          revoked: false,
        })
        this.#subjectByCredential.set(credentialHash, subject)
        return null
      }
      case 'credential.issued': {
        const invite = this.#invites.get(str(data, 'inviteId') ?? '')
        const subject = data['subject']
        const credentialHash = str(data, 'credentialHash')
        if (invite === undefined) return '重置所用的邀请不存在'
        if (invite.state !== 'open') return '重置所用的邀请不是未用状态'
        if (!isSubject(subject) || invite.subject !== subject) {
          return '重置邀请与账号对不上'
        }
        if (entry.at > invite.expiresAt) return '重置时邀请已过期'
        const account = this.#accountsBySubject.get(subject)
        if (account === undefined || account.revoked) {
          return '重置了不存在或已吊销的账号'
        }
        if (account.credentialHash !== null) return '重置前旧凭据没有作废'
        if (credentialHash === undefined || !DIGEST.test(credentialHash)) {
          return 'credentialHash 不对'
        }
        if (this.#subjectByCredential.has(credentialHash)) {
          return 'credentialHash 重复'
        }
        invite.state = 'consumed'
        account.credentialHash = credentialHash
        this.#subjectByCredential.set(credentialHash, subject)
        return null
      }
      case 'credential.cleared':
      case 'account.revoked': {
        const subject = data['subject']
        if (!isSubject(subject)) return 'subject 不对'
        if (!ACTOR.test(str(data, 'by') ?? '')) return 'by 不对'
        const account = this.#accountsBySubject.get(subject)
        if (account === undefined) return '作废了不存在的账号'
        if (account.revoked) return '作废了已吊销的账号'
        if (entry.kind === 'credential.cleared') {
          if (account.credentialHash === null) return '作废了已作废的凭据'
        } else {
          account.revoked = true
        }
        if (account.credentialHash !== null) {
          this.#subjectByCredential.delete(account.credentialHash)
        }
        account.credentialHash = null
        return null
      }
      case 'chat.owned': {
        const contextId = str(data, 'contextId')
        const subject = data['subject']
        if (
          contextId === undefined ||
          contextId.length === 0 ||
          contextId.length > MAX_CONTEXT_ID_LENGTH
        ) {
          return 'contextId 不对'
        }
        if (this.#owners.has(contextId)) return '同一会话记了两个属主'
        if (!isSubject(subject) || !this.#accountsBySubject.has(subject)) {
          return '属主不是已知账号'
        }
        this.#owners.set(contextId, subject)
        return null
      }
      case 'breakglass.used': {
        const fingerprint = str(data, 'fingerprint')
        const method = str(data, 'method')
        const path = str(data, 'path')
        if (fingerprint === undefined || !FINGERPRINT.test(fingerprint)) {
          return 'fingerprint 不对'
        }
        if (method === undefined || !/^[A-Z]{3,7}$/.test(method)) {
          return 'method 不对'
        }
        if (path === undefined || !path.startsWith('/') || path.length > 200) {
          return 'path 不对'
        }
        this.#breakGlassUses.set(fingerprint, entry.at)
        return null
      }
      case 'breakglass.rotated': {
        const from = str(data, 'from')
        const to = str(data, 'to')
        if (from === undefined || !FINGERPRINT.test(from)) return 'from 不对'
        if (to === undefined || !FINGERPRINT.test(to) || to === from) {
          return 'to 不对'
        }
        this.#rotatedFrom.add(from)
        return null
      }
      default:
        // A kind this version does not know is not skipped: skipping is how a
        // record that mattered — a revocation written by a newer build —
        // silently stops mattering.
        return `不认识的记录 ${entry.kind}`
    }
  }

  /** Apply one session-table entry, or say why it cannot be applied. */
  #applySession(entry: LedgerEntry): string | null {
    const sidHash = str(entry.data, 'sidHash')
    if (sidHash === undefined || !DIGEST.test(sidHash)) return 'sidHash 不对'
    switch (entry.kind) {
      case 'session.opened': {
        const subject = entry.data['subject']
        if (this.#sessions.has(sidHash)) return 'sidHash 重复'
        if (!isSubject(subject) || !this.#accountsBySubject.has(subject)) {
          return '会话的主体不是已知账号'
        }
        this.#sessions.set(sidHash, {
          sidHash,
          subject,
          createdAt: entry.at,
          lastSeenAt: entry.at,
          persistedAt: entry.at,
          closed: false,
        })
        return null
      }
      case 'session.touched':
      case 'session.closed': {
        const session = this.#sessions.get(sidHash)
        if (session === undefined) return '会话不存在'
        if (session.closed) return '会话已关闭'
        if (entry.kind === 'session.touched') {
          session.lastSeenAt = entry.at
          session.persistedAt = entry.at
          return null
        }
        if (!CLOSE_REASONS.has(str(entry.data, 'reason') ?? '')) {
          return 'reason 不对'
        }
        session.closed = true
        return null
      }
      default:
        return `不认识的记录 ${entry.kind}`
    }
  }

  // --- secrets -----------------------------------------------------------

  #secret(prefix: string): string {
    return `${prefix}${base64url(this.#random(SECRET_BYTES))}`
  }

  /** A fresh id that no invitation has ever carried. */
  #newInviteId(): string {
    for (;;) {
      const id = hex(this.#random(8))
      if (!this.#invites.has(id)) return id
    }
  }

  /** A fresh subject that no account has ever carried, revoked ones included. */
  #newSubject(): AccountSubject {
    for (;;) {
      const subject: AccountSubject = `u:${hex(this.#random(8))}`
      if (!this.#accountsBySubject.has(subject)) return subject
    }
  }

  #unavailable<T>(): AccountOutcome<T> {
    this.remindUnavailable()
    return refuse(
      'unavailable',
      '账号库校验未通过，个人账号暂停服务；请运维查看控制台的错误输出',
    )
  }

  /** The account behind a subject, when it can still be used. */
  #usable(subject: AccountSubject): AccountState | null {
    const account = this.#accountsBySubject.get(subject)
    if (account === undefined || account.revoked) return null
    if (account.credentialHash === null) return null
    return account
  }

  // --- invitations -------------------------------------------------------

  /** Invitations that could still be consumed right now. */
  #openInvites(now: number): number {
    let open = 0
    for (const invite of this.#invites.values()) {
      if (invite.state === 'open' && invite.expiresAt > now) open += 1
    }
    return open
  }

  #checkIssue(
    issuedBy: string,
    ttlMs: number | undefined,
    label: string | undefined,
  ): AccountOutcome<number> {
    if (!ACTOR.test(issuedBy)) return refuse('invalid', '签发人不对')
    const ttl = ttlMs ?? INVITE_TTL_MS
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < MIN_INVITE_TTL_MS ||
      ttl > INVITE_TTL_MS
    ) {
      return refuse('invalid', '邀请时效须在 5 分钟到 72 小时之间')
    }
    const problem = labelProblem(label)
    if (problem !== null) return refuse('invalid', problem)
    if (this.#openInvites(this.#now()) >= MAX_OPEN_INVITES) {
      return refuse(
        'limit',
        `未用的邀请已有 ${MAX_OPEN_INVITES} 份，先撤回或等它们过期`,
      )
    }
    return { ok: true, value: ttl }
  }

  /**
   * Issue an invitation. The token in the answer is the only copy there will
   * ever be; the ledger gets its hash.
   */
  issueInvite(input: {
    readonly role: AccountRole
    readonly issuedBy: string
    readonly ttlMs?: number
    readonly label?: string
  }): AccountOutcome<IssuedInvite> {
    if (this.#problem !== null) return this.#unavailable()
    if (!isRole(input.role)) {
      return refuse('invalid', '角色只能是 viewer、member 或 ops')
    }
    const checked = this.#checkIssue(input.issuedBy, input.ttlMs, input.label)
    if (!checked.ok) return checked
    return this.#issue(
      input.role,
      input.issuedBy,
      checked.value,
      input.label,
      undefined,
    )
  }

  #issue(
    role: AccountRole,
    issuedBy: string,
    ttl: number,
    label: string | undefined,
    subject: AccountSubject | undefined,
  ): AccountOutcome<IssuedInvite> {
    const now = this.#now()
    const token = this.#secret(INVITE_TOKEN_PREFIX)
    const tokenHash = hashSecret(token)
    const inviteId = this.#newInviteId()
    const expiresAt = now + ttl
    const data: Record<string, string | number> = {
      inviteId,
      tokenHash,
      role,
      expiresAt,
      issuedBy,
    }
    if (subject !== undefined) data['subject'] = subject
    if (label !== undefined) data['label'] = label
    if (!this.#append(this.#accounts, 'invite.issued', data)) {
      return this.#unavailable()
    }
    this.#invites.set(inviteId, {
      inviteId,
      tokenHash,
      role,
      issuedAt: now,
      expiresAt,
      issuedBy,
      ...(subject === undefined ? {} : { subject }),
      ...(label === undefined ? {} : { label }),
      state: 'open',
    })
    this.#inviteByHash.set(tokenHash, inviteId)
    return {
      ok: true,
      value: {
        inviteId,
        token,
        role,
        expiresAt,
        ...(subject === undefined ? {} : { subject }),
      },
    }
  }

  /** Withdraw an open invitation, which also frees its place under the cap. */
  withdrawInvite(inviteId: string, by: string): AccountOutcome<void> {
    if (this.#problem !== null) return this.#unavailable()
    const invite = this.#invites.get(inviteId)
    if (invite === undefined || invite.state !== 'open') {
      return refuse('not_found', '没有这份未用的邀请')
    }
    if (!ACTOR.test(by)) return refuse('invalid', '操作人不对')
    if (!this.#append(this.#accounts, 'invite.withdrawn', { inviteId, by })) {
      return this.#unavailable()
    }
    invite.state = 'withdrawn'
    return { ok: true, value: undefined }
  }

  /**
   * Consume an invitation and mint the credential it promised: a new account,
   * or a new credential for the account a reset invitation names.
   *
   * Unknown, expired, consumed and withdrawn all get the same refusal, and none
   * of them changes anything: telling a holder which of the four it was is
   * information about somebody else's invitation.
   */
  acceptInvite(token: string): AccountOutcome<AcceptedInvite> {
    if (this.#problem !== null) return this.#unavailable()
    const refused = refuse<AcceptedInvite>('refused', INVITE_REFUSED)
    if (!token.startsWith(INVITE_TOKEN_PREFIX)) return refused
    const inviteId = this.#inviteByHash.get(hashSecret(token))
    const invite =
      inviteId === undefined ? undefined : this.#invites.get(inviteId)
    const now = this.#now()
    if (
      invite === undefined ||
      invite.state !== 'open' ||
      now > invite.expiresAt
    ) {
      return refused
    }
    const credential = this.#secret(PERSONAL_CREDENTIAL_PREFIX)
    const credentialHash = hashSecret(credential)

    if (invite.subject !== undefined) {
      const account = this.#accountsBySubject.get(invite.subject)
      if (
        account === undefined ||
        account.revoked ||
        account.credentialHash !== null
      ) {
        return refused
      }
      const appended = this.#append(this.#accounts, 'credential.issued', {
        inviteId: invite.inviteId,
        subject: account.subject,
        credentialHash,
      })
      if (!appended) return this.#unavailable()
      invite.state = 'consumed'
      account.credentialHash = credentialHash
      this.#subjectByCredential.set(credentialHash, account.subject)
      return {
        ok: true,
        value: { subject: account.subject, role: account.role, credential },
      }
    }

    const subject = this.#newSubject()
    const data: Record<string, string> = {
      inviteId: invite.inviteId,
      subject,
      role: invite.role,
      credentialHash,
    }
    if (invite.label !== undefined) data['label'] = invite.label
    if (!this.#append(this.#accounts, 'account.created', data)) {
      return this.#unavailable()
    }
    invite.state = 'consumed'
    this.#accountsBySubject.set(subject, {
      subject,
      role: invite.role,
      createdAt: now,
      ...(invite.label === undefined ? {} : { label: invite.label }),
      credentialHash,
      revoked: false,
    })
    this.#subjectByCredential.set(credentialHash, subject)
    return { ok: true, value: { subject, role: invite.role, credential } }
  }

  // --- credentials and sessions ------------------------------------------

  /**
   * The principal a personal credential stands for, presented as a bearer.
   * `authenticatedAt` is now: the credential was proven by this very request.
   */
  bearerPrincipal(credential: string): AccountOutcome<ConsolePrincipal> {
    if (this.#problem !== null) return this.#unavailable()
    if (!isPersonalCredential(credential)) {
      return refuse('refused', CREDENTIAL_REFUSED)
    }
    const subject = this.#subjectByCredential.get(hashSecret(credential))
    const account = subject === undefined ? null : this.#usable(subject)
    if (account === null) return refuse('refused', CREDENTIAL_REFUSED)
    return {
      ok: true,
      value: {
        kind: 'user',
        subject: account.subject,
        role: account.role,
        authenticatedAt: this.#now(),
        credential: 'bearer',
      },
    }
  }

  #closeSession(session: SessionState, reason: CloseReason): boolean {
    if (session.closed) return true
    if (
      !this.#append(this.#sessionsChain, 'session.closed', {
        sidHash: session.sidHash,
        reason,
      })
    ) {
      return false
    }
    session.closed = true
    this.#closeStreams(session.subject, session.sidHash)
    return true
  }

  #sessionOf(sid: string): SessionState | undefined {
    if (!sid.startsWith(SESSION_ID_PREFIX)) return undefined
    return this.#sessions.get(hashSecret(sid))
  }

  /**
   * Open a browser session for an account whose credential was just proven.
   *
   * `previous` is whatever session cookie the browser came in with. It is
   * never adopted — the new id is always minted here — and it is closed, so a
   * session id planted in somebody's browser before they log in is worth
   * nothing after (§3.3, session fixation).
   */
  #openSession(
    account: AccountState,
    previous: string,
  ): AccountOutcome<OpenedSession> {
    const prior = this.#sessionOf(previous)
    if (prior !== undefined && !this.#closeSession(prior, 'rotated')) {
      return this.#unavailable()
    }
    const sid = this.#secret(SESSION_ID_PREFIX)
    const sidHash = hashSecret(sid)
    if (
      !this.#append(this.#sessionsChain, 'session.opened', {
        sidHash,
        subject: account.subject,
      })
    ) {
      return this.#unavailable()
    }
    const now = this.#now()
    this.#sessions.set(sidHash, {
      sidHash,
      subject: account.subject,
      createdAt: now,
      lastSeenAt: now,
      persistedAt: now,
      closed: false,
    })
    return {
      ok: true,
      value: {
        sid,
        principal: {
          kind: 'user',
          subject: account.subject,
          role: account.role,
          authenticatedAt: now,
          credential: 'session',
        },
      },
    }
  }

  /** `POST /login` with a personal credential. */
  login(credential: string, previous: string): AccountOutcome<OpenedSession> {
    const proven = this.bearerPrincipal(credential)
    if (!proven.ok) return proven
    const account =
      proven.value.kind === 'user' ? this.#usable(proven.value.subject) : null
    if (account === null) return refuse('refused', CREDENTIAL_REFUSED)
    return this.#openSession(account, previous)
  }

  /** The session a freshly redeemed invitation signs its browser in with. */
  sessionFor(
    subject: AccountSubject,
    previous: string,
  ): AccountOutcome<OpenedSession> {
    if (this.#problem !== null) return this.#unavailable()
    const account = this.#usable(subject)
    if (account === null) return refuse('refused', CREDENTIAL_REFUSED)
    return this.#openSession(account, previous)
  }

  /**
   * The principal behind a session cookie, or why there is none.
   *
   * `touch` is false for the stream's own re-checks: an open `EventSource` is
   * not somebody using the console, and letting it count would make a
   * forgotten tab an idle session that never idles.
   */
  sessionPrincipal(
    sid: string,
    touch = true,
  ): AccountOutcome<ConsolePrincipal> {
    if (this.#problem !== null) return this.#unavailable()
    const session = this.#sessionOf(sid)
    if (session === undefined || session.closed) {
      return refuse('refused', CREDENTIAL_REFUSED)
    }
    const account = this.#usable(session.subject)
    if (account === null) return refuse('refused', CREDENTIAL_REFUSED)
    const now = this.#now()
    if (
      now - session.createdAt >= SESSION_ABSOLUTE_MS ||
      now - session.lastSeenAt >= SESSION_IDLE_MS
    ) {
      if (!this.#closeSession(session, 'expired')) return this.#unavailable()
      return refuse('refused', CREDENTIAL_REFUSED)
    }
    if (touch) {
      session.lastSeenAt = now
      if (now - session.persistedAt >= SESSION_TOUCH_PERSIST_MS) {
        if (
          !this.#append(this.#sessionsChain, 'session.touched', {
            sidHash: session.sidHash,
          })
        ) {
          return this.#unavailable()
        }
        session.persistedAt = now
      }
    }
    return {
      ok: true,
      value: {
        kind: 'user',
        subject: account.subject,
        role: account.role,
        authenticatedAt: session.createdAt,
        credential: 'session',
      },
    }
  }

  /**
   * End a session. Unknown and already-closed ids are fine — logging out is
   * the one request that must work whatever state the caller is in.
   */
  logout(sid: string): void {
    if (this.#problem !== null) return
    const session = this.#sessionOf(sid)
    if (session !== undefined) this.#closeSession(session, 'logout')
  }

  // --- revocation --------------------------------------------------------

  /**
   * Tell `listener` whenever an account is revoked or reset. The hook P14's
   * approval fan-out hangs on (§3.5, "主体吊销"); nothing else listens today.
   */
  onAccountEnded(listener: (event: AccountEnded) => void): () => void {
    this.#endListeners.add(listener)
    return () => {
      this.#endListeners.delete(listener)
    }
  }

  /** Close every session of `subject`, then every stream, then tell listeners. */
  #end(account: AccountState, reason: 'revoked' | 'reset'): boolean {
    for (const session of this.#sessions.values()) {
      if (session.subject === account.subject && !session.closed) {
        if (!this.#closeSession(session, reason)) return false
      }
    }
    this.#closeStreams(account.subject, null)
    for (const listener of this.#endListeners) {
      try {
        listener({ subject: account.subject, reason })
      } catch (error) {
        this.#onAlarm(
          `console accounts: 吊销回调出错（${error instanceof Error ? error.message : String(error)}）`,
        )
      }
    }
    return true
  }

  /**
   * Revoke an account for good. The next request with any of its credentials
   * or sessions is a 401, and every stream it holds ends now (§3.3).
   */
  revoke(subject: string, by: string): AccountOutcome<void> {
    if (this.#problem !== null) return this.#unavailable()
    if (!ACTOR.test(by)) return refuse('invalid', '操作人不对')
    const account = isSubject(subject)
      ? this.#accountsBySubject.get(subject)
      : undefined
    if (account === undefined || account.revoked) {
      return refuse('not_found', '没有这个在用的账号')
    }
    if (
      !this.#append(this.#accounts, 'account.revoked', {
        subject: account.subject,
        by,
      })
    ) {
      // The file did not take it; the person is out of this process anyway.
      account.revoked = true
      this.#closeStreams(account.subject, null)
      return this.#unavailable()
    }
    account.revoked = true
    if (account.credentialHash !== null) {
      this.#subjectByCredential.delete(account.credentialHash)
    }
    account.credentialHash = null
    if (!this.#end(account, 'revoked')) return this.#unavailable()
    return { ok: true, value: undefined }
  }

  /**
   * Reset an account: its credential stops working now, every session and
   * stream ends, and a new invitation for the same account comes back — the
   * only way that person gets back in, with the sessions they own intact.
   */
  reset(
    subject: string,
    by: string,
    ttlMs?: number,
  ): AccountOutcome<IssuedInvite> {
    if (this.#problem !== null) return this.#unavailable()
    const account = isSubject(subject)
      ? this.#accountsBySubject.get(subject)
      : undefined
    if (account === undefined || account.revoked) {
      return refuse('not_found', '没有这个在用的账号')
    }
    // Checked before anything is cleared: a reset that voids the credential
    // and then cannot issue the invitation leaves somebody locked out for no
    // reason.
    const checked = this.#checkIssue(by, ttlMs, account.label)
    if (!checked.ok) return checked
    if (account.credentialHash !== null) {
      if (
        !this.#append(this.#accounts, 'credential.cleared', {
          subject: account.subject,
          by,
        })
      ) {
        return this.#unavailable()
      }
      this.#subjectByCredential.delete(account.credentialHash)
      account.credentialHash = null
    }
    if (!this.#end(account, 'reset')) return this.#unavailable()
    // An earlier reset link for the same person dies with this one: only the
    // newest invitation may restore the account.
    for (const invite of this.#invites.values()) {
      if (invite.subject === account.subject && invite.state === 'open') {
        if (
          !this.#append(this.#accounts, 'invite.withdrawn', {
            inviteId: invite.inviteId,
            by,
          })
        ) {
          return this.#unavailable()
        }
        invite.state = 'withdrawn'
      }
    }
    return this.#issue(
      account.role,
      by,
      checked.value,
      account.label,
      account.subject,
    )
  }

  // --- streams -----------------------------------------------------------

  /**
   * Register a live stream held by `subject`, and how to end it. Returns the
   * way to unregister. `sid` binds it to one session as well, so logging that
   * session out ends it without touching the person's other tabs.
   */
  attachStream(
    subject: AccountSubject,
    sid: string | null,
    close: () => void,
  ): () => void {
    const handle: StreamHandle = {
      sidHash: sid === null ? null : hashSecret(sid),
      close,
    }
    let set = this.#streams.get(subject)
    if (set === undefined) {
      set = new Set()
      this.#streams.set(subject, set)
    }
    set.add(handle)
    return () => {
      const current = this.#streams.get(subject)
      current?.delete(handle)
      if (current?.size === 0) this.#streams.delete(subject)
    }
  }

  /** Live streams held by `subject`. What the revocation cases count down to zero. */
  openStreams(subject: AccountSubject): number {
    return this.#streams.get(subject)?.size ?? 0
  }

  #closeStreams(subject: AccountSubject, sidHash: string | null): void {
    const set = this.#streams.get(subject)
    if (set === undefined) return
    for (const handle of [...set]) {
      if (sidHash === null || handle.sidHash === sidHash) {
        set.delete(handle)
        handle.close()
      }
    }
    if (set.size === 0) this.#streams.delete(subject)
  }

  #closeAllStreams(): void {
    for (const subject of [...this.#streams.keys()]) {
      this.#closeStreams(subject, null)
    }
  }

  // --- ownership ---------------------------------------------------------

  /** Record who opened a chat session. Once per session, never changed. */
  recordOwner(
    contextId: string,
    subject: AccountSubject,
  ): AccountOutcome<void> {
    if (this.#problem !== null) return this.#unavailable()
    if (
      contextId.length === 0 ||
      contextId.length > MAX_CONTEXT_ID_LENGTH ||
      this.#owners.has(contextId)
    ) {
      return refuse('invalid', '会话 id 不对或已有属主')
    }
    if (!this.#accountsBySubject.has(subject)) {
      return refuse('not_found', '没有这个账号')
    }
    if (!this.#append(this.#accounts, 'chat.owned', { contextId, subject })) {
      return this.#unavailable()
    }
    this.#owners.set(contextId, subject)
    return { ok: true, value: undefined }
  }

  /**
   * The account that owns a chat session, or `null` — for a session opened by
   * a legacy token, for one this console never saw, and for anything while
   * the book is unavailable (nobody is shown as owning anything then).
   */
  ownerOf(contextId: string): AccountSubject | null {
    if (this.#problem !== null) return null
    return this.#owners.get(contextId) ?? null
  }

  // --- break-glass -------------------------------------------------------

  /**
   * Note a request made with the admin token while it is break-glass
   * (§3.4 ②④). Every write is recorded; reads at most every ten minutes.
   * Never refuses the request: failing to record is an alarm, not a lockout
   * of the one credential that exists for when things are broken.
   */
  recordBreakGlass(fingerprint: string, method: string, path: string): void {
    if (!FINGERPRINT.test(fingerprint)) return
    const now = this.#now()
    const read = method === 'GET' || method === 'HEAD'
    this.#breakGlassUses.set(fingerprint, now)
    if (read && now - this.#lastBreakGlassRead < BREAK_GLASS_READ_RECORD_MS) {
      return
    }
    if (read) this.#lastBreakGlassRead = now
    if (this.#problem !== null) return
    this.#append(this.#accounts, 'breakglass.used', {
      fingerprint,
      method: /^[A-Z]{3,7}$/.test(method) ? method : 'OTHER',
      path: path.startsWith('/') ? path.slice(0, 200) : '/',
    })
  }

  /**
   * Where the admin token in force stands. Called at startup with its
   * fingerprint: if the token last used as break-glass is a different one, the
   * rotation happened and is written down once.
   */
  breakGlassStatus(current: string): BreakGlassStatus {
    if (this.#problem === null) {
      for (const [fingerprint] of this.#breakGlassUses) {
        if (fingerprint !== current && !this.#rotatedFrom.has(fingerprint)) {
          if (
            this.#append(this.#accounts, 'breakglass.rotated', {
              from: fingerprint,
              to: current,
            })
          ) {
            this.#rotatedFrom.add(fingerprint)
          }
        }
      }
    }
    const lastUsedAt = this.#breakGlassUses.get(current) ?? null
    return { lastUsedAt, rotationDue: lastUsedAt !== null }
  }

  // --- reading -----------------------------------------------------------

  /** Accounts and invitations, newest first, with no secret and no hash in them. */
  list(): AccountOutcome<{
    readonly accounts: readonly AccountSummary[]
    readonly invites: readonly InviteSummary[]
  }> {
    if (this.#problem !== null) return this.#unavailable()
    const now = this.#now()
    const live = new Map<AccountSubject, number>()
    for (const session of this.#sessions.values()) {
      if (session.closed) continue
      if (now - session.createdAt >= SESSION_ABSOLUTE_MS) continue
      if (now - session.lastSeenAt >= SESSION_IDLE_MS) continue
      live.set(session.subject, (live.get(session.subject) ?? 0) + 1)
    }
    const accounts: AccountSummary[] = [...this.#accountsBySubject.values()]
      .map(account => ({
        subject: account.subject,
        role: account.role,
        createdAt: account.createdAt,
        state: account.revoked
          ? ('revoked' as const)
          : account.credentialHash === null
            ? ('reset' as const)
            : ('active' as const),
        sessions: account.revoked ? 0 : (live.get(account.subject) ?? 0),
        ...(account.label === undefined ? {} : { label: account.label }),
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
    const invites: InviteSummary[] = [...this.#invites.values()]
      .map(invite => ({
        inviteId: invite.inviteId,
        role: invite.role,
        issuedAt: invite.issuedAt,
        expiresAt: invite.expiresAt,
        issuedBy: invite.issuedBy,
        state:
          invite.state === 'open' && now > invite.expiresAt
            ? ('expired' as const)
            : invite.state,
        ...(invite.subject === undefined ? {} : { subject: invite.subject }),
        ...(invite.label === undefined ? {} : { label: invite.label }),
      }))
      .sort((a, b) => b.issuedAt - a.issuedAt)
    return { ok: true, value: { accounts, invites } }
  }
}
