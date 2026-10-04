// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  authzDigest,
  isAuthzRequest,
  parseApprover,
  parseAuthzDecision,
  verifyAuthzDecisionSignature,
  type AuthzDecisionKind,
  type AuthzOrigin,
  type AuthzRequest,
} from '@qianmo/capability'
import {
  formatAddress,
  isNodePublicKey,
  isValidSegment,
} from '@qianmo/protocol'
import type { ResidentEstop } from './estop.js'
import type { HardlineDenial, ResidentHardline } from './guard.js'

/**
 * File name of the authorization ledger inside the node's `resident/` state
 * directory. That directory is one the hardline refuses whole
 * (`NODE_STATE_DIRS`), which is the whole reason the rows live there: a turn
 * that could write this file could approve itself.
 */
export const AUTHZ_LEDGER_FILE = 'authz.ndjson'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const ID_BYTES = 16
/**
 * How long a pending request waits for a decision. The design fixes the other
 * windows (D-5) but not this one; ten minutes matches the `allow-once` life,
 * so an approval can never outlive the question it answers by more than the
 * question itself lived.
 */
const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1000
/** D-5: an `allow-once` grant is consumed once or dies ten minutes on. */
const ALLOW_ONCE_TTL_MS = 10 * 60 * 1000

/** Why the store said no. `integrity` covers a ledger it cannot trust or write. */
export type AuthzRefusal =
  | 'integrity'
  | 'hardline'
  | 'malformed'
  | 'aud'
  | 'request'
  | 'sub'
  | 'digest'
  | 'expired'
  | 'clock'
  | 'approver'
  | 'signature'
  | 'replay'
  | 'estop'

/** One tool call, as the host saw it. */
export interface AuthzCall {
  readonly agent: string
  readonly contextId: string
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}

/** A binding row (design §3.4): what an approval let through, and until when. */
export interface AuthzGrant {
  readonly grantId: string
  readonly requestId: string
  readonly digest: string
  readonly scope: 'once' | 'window'
  readonly contextId: string
  readonly approver: string
  /** sha256 of the decision exactly as it arrived; joins the audit chain. */
  readonly decisionRef: string
  readonly expiresAt: number
  readonly consumedAt?: number
  readonly revokedAt?: number
}

export type AskOutcome =
  | {
      readonly kind: 'pending'
      readonly request: AuthzRequest
      /** `false` when an identical call was already waiting. */
      readonly created: boolean
    }
  | {
      readonly kind: 'refused'
      readonly reason: 'integrity' | 'hardline' | 'malformed'
      readonly denial?: HardlineDenial
    }

export type DecisionOutcome =
  | {
      readonly ok: true
      readonly request: AuthzRequest
      readonly decision: AuthzDecisionKind
      /** `null` for `deny`. */
      readonly grant: AuthzGrant | null
    }
  | {
      readonly ok: false
      readonly reason: AuthzRefusal
      /** Finer cause where one reason covers several, e.g. which approver check. */
      readonly detail?: string
    }

export type UseOutcome =
  | { readonly kind: 'hit'; readonly grant: AuthzGrant }
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'refused'
      readonly reason: 'integrity' | 'hardline' | 'estop'
      readonly denial?: HardlineDenial
    }

export interface AuthzIntegrityIssue {
  readonly line: number
  readonly kind: 'corrupt_line' | 'inconsistent' | 'unreadable'
}

export interface FileGrantStoreOptions {
  /** `<config>/resident/authz.ndjson`; must be a path the hardline refuses. */
  readonly path: string
  /** This node's name: `aud` of every decision, `iss` of every request. */
  readonly node: string
  /** `--approver <console>=<publicKey>`: whose approvals this node takes. */
  readonly approvers: ReadonlyMap<string, string>
  /**
   * Every key that may command this node — `--trust`, the certificate
   * directory, its own key. Read again for every decision because the
   * certificate directory changes while the node runs (I-6).
   */
  readonly commanderKeys: () => Iterable<string>
  readonly hardline: ResidentHardline
  readonly estop: ResidentEstop
  readonly now?: () => number
  readonly requestTtlMs?: number
}

type LedgerRecord =
  | {
      readonly kind: 'requested'
      readonly at: number
      readonly request: AuthzRequest
    }
  | {
      readonly kind: 'decided'
      readonly at: number
      readonly requestId: string
      readonly decision: AuthzDecisionKind
      readonly approver: string
      readonly nonce: string
      readonly decisionRef: string
      readonly grantId: string | null
      readonly expiresAt: number | null
    }
  | {
      readonly kind: 'expired'
      readonly at: number
      readonly requestId: string
    }
  | { readonly kind: 'consumed'; readonly at: number; readonly grantId: string }
  | { readonly kind: 'revoked'; readonly at: number; readonly grantId: string }
  | {
      readonly kind: 'approver-revoked'
      readonly at: number
      readonly approver: string
    }
  | {
      readonly kind: 'context-ended'
      readonly at: number
      readonly contextId: string
    }
  | { readonly kind: 'estop'; readonly at: number }

const RECORD_KEYS: Readonly<Record<LedgerRecord['kind'], readonly string[]>> = {
  requested: ['kind', 'at', 'request'],
  decided: [
    'kind',
    'at',
    'requestId',
    'decision',
    'approver',
    'nonce',
    'decisionRef',
    'grantId',
    'expiresAt',
  ],
  expired: ['kind', 'at', 'requestId'],
  consumed: ['kind', 'at', 'grantId'],
  revoked: ['kind', 'at', 'grantId'],
  'approver-revoked': ['kind', 'at', 'approver'],
  'context-ended': ['kind', 'at', 'contextId'],
  estop: ['kind', 'at'],
}

const HEX_ID = /^[0-9a-f]{32}$/
const HEX_DIGEST = /^[0-9a-f]{64}$/

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => key in value)
}

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isHexId(value: unknown): value is string {
  return typeof value === 'string' && HEX_ID.test(value)
}

/** A closed record, or `undefined` for anything else — never a guess. */
function parseRecord(value: unknown): LedgerRecord | undefined {
  if (!plainObject(value) || typeof value.kind !== 'string') return undefined
  if (!Object.hasOwn(RECORD_KEYS, value.kind)) return undefined
  const kind = value.kind as LedgerRecord['kind']
  if (!exactKeys(value, RECORD_KEYS[kind]) || !isEpochMs(value.at)) {
    return undefined
  }
  const record = value as LedgerRecord & Record<string, unknown>
  switch (kind) {
    case 'requested':
      return isAuthzRequest(value.request) ? record : undefined
    case 'decided': {
      const allow =
        value.decision === 'allow-once' || value.decision === 'allow-window'
      if (!allow && value.decision !== 'deny') return undefined
      if (
        !isHexId(value.requestId) ||
        !nonEmpty(value.approver) ||
        !nonEmpty(value.nonce) ||
        typeof value.decisionRef !== 'string' ||
        !HEX_DIGEST.test(value.decisionRef)
      ) {
        return undefined
      }
      const grantOk = allow
        ? isHexId(value.grantId) && isEpochMs(value.expiresAt)
        : value.grantId === null && value.expiresAt === null
      return grantOk ? record : undefined
    }
    case 'expired':
      return isHexId(value.requestId) ? record : undefined
    case 'consumed':
    case 'revoked':
      return isHexId(value.grantId) ? record : undefined
    case 'approver-revoked':
      return nonEmpty(value.approver) ? record : undefined
    case 'context-ended':
      return nonEmpty(value.contextId) ? record : undefined
    case 'estop':
      return record
    default:
      return undefined
  }
}

interface RequestState {
  readonly request: AuthzRequest
  status: 'pending' | 'decided' | 'expired'
}

interface GrantState {
  readonly grantId: string
  readonly requestId: string
  readonly digest: string
  readonly scope: 'once' | 'window'
  readonly contextId: string
  readonly approver: string
  readonly decisionRef: string
  readonly expiresAt: number
  consumedAt?: number
  revokedAt?: number
}

function snapshot(grant: GrantState): AuthzGrant {
  return {
    grantId: grant.grantId,
    requestId: grant.requestId,
    digest: grant.digest,
    scope: grant.scope,
    contextId: grant.contextId,
    approver: grant.approver,
    decisionRef: grant.decisionRef,
    expiresAt: grant.expiresAt,
    ...(grant.consumedAt === undefined ? {} : { consumedAt: grant.consumedAt }),
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
  }
}

/** The input as the JSON it will be read back as, or `undefined`. */
function jsonCopy(input: unknown): Record<string, unknown> | undefined {
  if (!plainObject(input)) return undefined
  try {
    const copy: unknown = JSON.parse(JSON.stringify(input))
    return plainObject(copy) ? copy : undefined
  } catch {
    return undefined
  }
}

function newId(): string {
  return randomBytes(ID_BYTES).toString('hex')
}

/**
 * The node's grant store (design `authorization-m1.md` §3.4 / §3.5, P14.3):
 * pending requests and the grants that answer them, as one append-only ledger.
 *
 * ## Why a ledger and not a nonce table
 *
 * An approval is single-use because the request it names moves out of
 * `pending` the moment it is accepted, and that move is on disk before the
 * caller hears "yes". A restart therefore cannot un-use an approval (TH-2): the
 * replayed decision finds its request already decided. The decision's `nonce`
 * is kept too, as the second line the design asks for.
 *
 * ## Damage fails closed
 *
 * Unlike the delivery ledger, a line that does not parse — or that describes a
 * transition the state machine could not have made — stops the store: every
 * call is refused with `integrity` until an operator looks. Skipping a bad
 * `consumed` line would hand an approval a second use. The one exception is a
 * **torn tail**, an incomplete last line: every transition is acknowledged
 * only after its `fsync`, so a torn line is one nobody was told about, and it
 * is cut off before the next append.
 *
 * ## Order of checks for a decision
 *
 * Structure → binding (`aud`, `requestId` names a pending request, `sub`,
 * `digest`) → clock → approver set → signature → nonce → ESTOP → append. The
 * append is the only side effect, and it is last, so nothing a forger can send
 * — a bad signature over a real approval's bytes included — changes what the
 * real approval can still do.
 *
 * ## What it does not know
 *
 * Who the person behind `approver` is: the console vouches for that, the node
 * cannot check it offline (`tenancy-m1.md` §3.5). It takes the console part of
 * the name, checks it is one of its `--approver`s, checks the subject has the
 * P15 shape and is not a legacy principal, and checks that console's key
 * signed the decision.
 */
export class FileGrantStore {
  readonly #path: string
  readonly #node: string
  readonly #approvers: ReadonlyMap<string, string>
  readonly #commanderKeys: () => Iterable<string>
  readonly #hardline: ResidentHardline
  readonly #estop: ResidentEstop
  readonly #now: () => number
  readonly #requestTtlMs: number
  readonly #requests = new Map<string, RequestState>()
  readonly #grants = new Map<string, GrantState>()
  readonly #nonces = new Set<string>()
  readonly #revokedApprovers = new Set<string>()
  #issues: AuthzIntegrityIssue[] = []
  #loaded = false
  #fd: number | null = null
  /** Byte length of the complete lines; a torn tail beyond it is cut. */
  #validLength = 0

  constructor(options: FileGrantStoreOptions) {
    if (options.hardline.pathVerdict(options.path) === null) {
      throw new Error(
        `authz ledger must live where the resident hardline refuses it: ${options.path}`,
      )
    }
    if (!isValidSegment(options.node)) {
      throw new Error(`invalid node name for the grant store: ${options.node}`)
    }
    for (const [name, key] of options.approvers) {
      if (!isValidSegment(name) || !isNodePublicKey(key)) {
        throw new Error(`invalid --approver entry: ${name}`)
      }
    }
    const requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS
    if (!Number.isSafeInteger(requestTtlMs) || requestTtlMs <= 0) {
      throw new Error('authz request TTL must be a positive integer')
    }
    this.#path = options.path
    this.#node = options.node
    this.#approvers = new Map(options.approvers)
    this.#commanderKeys = options.commanderKeys
    this.#hardline = options.hardline
    this.#estop = options.estop
    this.#now = options.now ?? Date.now
    this.#requestTtlMs = requestTtlMs
    const overlap = this.#commanderOverlap()
    if (overlap !== undefined) {
      throw new Error(
        `--approver ${overlap} uses a key that can also command this node (I-6)`,
      )
    }
  }

  get path(): string {
    return this.#path
  }

  /** Damage seen at load. Non-empty means every call is being refused. */
  integrityIssues(): readonly AuthzIntegrityIssue[] {
    this.#load()
    return [...this.#issues]
  }

  /**
   * Record that a call is waiting for approval, or find the identical call
   * already waiting. A call the hardline refuses never becomes a request: no
   * approval may reach it.
   */
  ask(call: AuthzCall & { readonly origin: AuthzOrigin }): AskOutcome {
    if (!this.#usable()) return { kind: 'refused', reason: 'integrity' }
    const denial = this.#hardline.verdict(call.toolName, call.input)
    if (denial !== null) return { kind: 'refused', reason: 'hardline', denial }
    // Stored and hashed as the JSON it will be read back as, so the request
    // after a restart is the request before it.
    const input = jsonCopy(call.input)
    if (!isValidSegment(call.agent) || input === undefined) {
      return { kind: 'refused', reason: 'malformed' }
    }
    const digest = authzDigest({
      node: this.#node,
      agent: call.agent,
      contextId: call.contextId,
      toolName: call.toolName,
      input,
    })
    const now = this.#now()
    for (const state of this.#requests.values()) {
      if (
        state.status === 'pending' &&
        state.request.digest === digest &&
        state.request.exp > now
      ) {
        return { kind: 'pending', request: state.request, created: false }
      }
    }
    const request: AuthzRequest = {
      v: 1,
      requestId: newId(),
      iss: this.#node,
      sub: formatAddress({ node: this.#node, agent: call.agent }),
      contextId: call.contextId,
      toolName: call.toolName,
      input,
      digest,
      origin: call.origin,
      iat: now,
      exp: now + this.#requestTtlMs,
    }
    if (!isAuthzRequest(request)) {
      return { kind: 'refused', reason: 'malformed' }
    }
    if (!this.#append({ kind: 'requested', at: now, request })) {
      return { kind: 'refused', reason: 'integrity' }
    }
    return { kind: 'pending', request, created: true }
  }

  /** Requests still waiting, oldest first — what a reconnecting console drains. */
  pending(): readonly AuthzRequest[] {
    if (!this.#usable()) return []
    const now = this.#now()
    return [...this.#requests.values()]
      .filter(state => state.status === 'pending' && state.request.exp > now)
      .map(state => state.request)
      .sort((left, right) => left.iat - right.iat)
  }

  /** Apply one signed decision. See the class comment for the order. */
  applyDecision(wire: unknown): DecisionOutcome {
    if (!this.#usable()) return { ok: false, reason: 'integrity' }

    const parts = parseAuthzDecision(wire)
    if (parts === null) return { ok: false, reason: 'malformed' }
    const decision = parts.value

    if (decision.aud !== this.#node) return { ok: false, reason: 'aud' }
    const state = this.#requests.get(decision.requestId)
    if (state === undefined) return { ok: false, reason: 'request' }
    if (state.status === 'decided') return { ok: false, reason: 'replay' }
    if (state.status === 'expired') return { ok: false, reason: 'expired' }
    if (decision.sub !== state.request.sub) return { ok: false, reason: 'sub' }
    if (decision.digest !== state.request.digest) {
      return { ok: false, reason: 'digest' }
    }

    const now = this.#now()
    if (state.request.exp <= now || decision.exp <= now) {
      return { ok: false, reason: 'expired' }
    }
    if (decision.nbf > now) {
      return { ok: false, reason: 'clock', detail: 'not-yet-valid' }
    }
    if (decision.exp - decision.nbf > state.request.exp - state.request.iat) {
      return { ok: false, reason: 'clock', detail: 'lifetime' }
    }

    const approver = parseApprover(decision.approver)
    if (!approver.ok) {
      return { ok: false, reason: 'approver', detail: approver.reason }
    }
    const key = this.#approvers.get(approver.console)
    if (key === undefined) {
      return { ok: false, reason: 'approver', detail: 'unknown-console' }
    }
    if (this.#revokedApprovers.has(decision.approver)) {
      return { ok: false, reason: 'approver', detail: 'revoked' }
    }
    if (this.#isCommander(key)) {
      return { ok: false, reason: 'approver', detail: 'commander' }
    }

    if (!verifyAuthzDecisionSignature(parts, key)) {
      return { ok: false, reason: 'signature' }
    }
    if (this.#nonces.has(decision.nonce)) return { ok: false, reason: 'replay' }
    if (this.#estop.engaged()) return { ok: false, reason: 'estop' }

    const allow = decision.decision !== 'deny'
    const grantId = allow ? newId() : null
    const expiresAt = !allow
      ? null
      : now +
        (decision.decision === 'allow-once'
          ? ALLOW_ONCE_TTL_MS
          : decision.windowMs)
    const recorded = this.#append({
      kind: 'decided',
      at: now,
      requestId: decision.requestId,
      decision: decision.decision,
      approver: decision.approver,
      nonce: decision.nonce,
      decisionRef: createHash('sha256')
        .update(String(wire), 'utf8')
        .digest('hex'),
      grantId,
      expiresAt,
    })
    if (!recorded) return { ok: false, reason: 'integrity' }
    const grant = grantId === null ? undefined : this.#grants.get(grantId)
    return {
      ok: true,
      request: state.request,
      decision: decision.decision,
      grant: grant === undefined ? null : snapshot(grant),
    }
  }

  /**
   * May this call run on a standing grant?
   *
   * The hardline is asked first and wins over any grant: a path that became
   * protected after it was approved stays protected. While ESTOP is engaged
   * nothing hits, and every live grant is revoked on the spot, so releasing
   * the brake does not bring them back.
   */
  use(call: AuthzCall): UseOutcome {
    if (!this.#usable()) return { kind: 'refused', reason: 'integrity' }
    const denial = this.#hardline.verdict(call.toolName, call.input)
    if (denial !== null) return { kind: 'refused', reason: 'hardline', denial }
    const now = this.#now()
    if (this.#estop.engaged()) {
      if (this.#live(now).length > 0) this.#append({ kind: 'estop', at: now })
      return { kind: 'refused', reason: 'estop' }
    }
    const input = jsonCopy(call.input)
    if (!isValidSegment(call.agent) || input === undefined) {
      return { kind: 'miss' }
    }
    const digest = authzDigest({
      node: this.#node,
      agent: call.agent,
      contextId: call.contextId,
      toolName: call.toolName,
      input,
    })
    const matches = this.#live(now).filter(
      grant => grant.digest === digest && grant.contextId === call.contextId,
    )
    const window = matches.find(grant => grant.scope === 'window')
    if (window !== undefined) return { kind: 'hit', grant: snapshot(window) }
    const once = matches.find(grant => grant.scope === 'once')
    if (once === undefined) return { kind: 'miss' }
    // The consumption is on disk before the caller may run anything.
    if (!this.#append({ kind: 'consumed', at: now, grantId: once.grantId })) {
      return { kind: 'refused', reason: 'integrity' }
    }
    return { kind: 'hit', grant: snapshot(once) }
  }

  /** Revoke one grant (`authz.revoke`). `false` when it was not live. */
  revoke(grantId: string): boolean {
    if (!this.#usable()) return false
    const now = this.#now()
    const grant = this.#grants.get(grantId)
    if (grant === undefined || !this.#isLive(grant, now)) return false
    return this.#append({ kind: 'revoked', at: now, grantId })
  }

  /**
   * Revoke everything an approver signed and refuse their future decisions.
   * Permanent, because P15 never reuses a subject.
   */
  revokeApprover(approver: string): number {
    if (!this.#usable() || !parseApprover(approver).ok) return 0
    const now = this.#now()
    const live = this.#live(now).filter(grant => grant.approver === approver)
    if (!this.#append({ kind: 'approver-revoked', at: now, approver })) return 0
    return live.length
  }

  /** The session is over: its grants and waiting requests go with it. */
  endContext(contextId: string): number {
    if (!this.#usable() || contextId.length === 0) return 0
    const now = this.#now()
    const live = this.#live(now).filter(grant => grant.contextId === contextId)
    const waiting = [...this.#requests.values()].some(
      state =>
        state.status === 'pending' && state.request.contextId === contextId,
    )
    if (live.length === 0 && !waiting) return 0
    if (!this.#append({ kind: 'context-ended', at: now, contextId })) return 0
    return live.length
  }

  /** Close out requests nobody answered in time; returns them for the audit trail. */
  sweep(): readonly AuthzRequest[] {
    if (!this.#usable()) return []
    const now = this.#now()
    const expired: AuthzRequest[] = []
    for (const state of this.#requests.values()) {
      if (state.status !== 'pending' || state.request.exp > now) continue
      const requestId = state.request.requestId
      if (!this.#append({ kind: 'expired', at: now, requestId })) break
      expired.push(state.request)
    }
    return expired
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
    this.#loaded = false
  }

  #commanderOverlap(): string | undefined {
    const commanders = new Set(this.#commanderKeys())
    for (const [name, key] of this.#approvers) {
      if (commanders.has(key)) return name
    }
    return undefined
  }

  /** A key source that cannot be read counts as a match: fail closed. */
  #isCommander(key: string): boolean {
    try {
      return new Set(this.#commanderKeys()).has(key)
    } catch {
      return true
    }
  }

  #isLive(grant: GrantState, now: number): boolean {
    return (
      grant.revokedAt === undefined &&
      grant.consumedAt === undefined &&
      grant.expiresAt > now
    )
  }

  #live(now: number): GrantState[] {
    return [...this.#grants.values()].filter(grant => this.#isLive(grant, now))
  }

  #usable(): boolean {
    this.#load()
    return this.#issues.length === 0
  }

  /** Fold one record into the state; `false` if it could not have happened. */
  #apply(record: LedgerRecord): boolean {
    switch (record.kind) {
      case 'requested': {
        if (this.#requests.has(record.request.requestId)) return false
        if (record.request.iss !== this.#node) return false
        this.#requests.set(record.request.requestId, {
          request: record.request,
          status: 'pending',
        })
        return true
      }
      case 'decided': {
        const state = this.#requests.get(record.requestId)
        if (state === undefined || state.status !== 'pending') return false
        if (this.#nonces.has(record.nonce)) return false
        if (this.#revokedApprovers.has(record.approver)) return false
        state.status = 'decided'
        this.#nonces.add(record.nonce)
        if (record.grantId === null || record.expiresAt === null) return true
        if (this.#grants.has(record.grantId)) return false
        this.#grants.set(record.grantId, {
          grantId: record.grantId,
          requestId: record.requestId,
          digest: state.request.digest,
          scope: record.decision === 'allow-once' ? 'once' : 'window',
          contextId: state.request.contextId,
          approver: record.approver,
          decisionRef: record.decisionRef,
          expiresAt: record.expiresAt,
        })
        return true
      }
      case 'expired': {
        const state = this.#requests.get(record.requestId)
        if (state === undefined || state.status !== 'pending') return false
        state.status = 'expired'
        return true
      }
      case 'consumed': {
        const grant = this.#grants.get(record.grantId)
        if (
          grant === undefined ||
          grant.scope !== 'once' ||
          grant.consumedAt !== undefined ||
          grant.revokedAt !== undefined
        ) {
          return false
        }
        grant.consumedAt = record.at
        return true
      }
      case 'revoked': {
        const grant = this.#grants.get(record.grantId)
        if (grant === undefined || grant.revokedAt !== undefined) return false
        grant.revokedAt = record.at
        return true
      }
      case 'approver-revoked':
        this.#revokedApprovers.add(record.approver)
        this.#revokeWhere(
          record.at,
          grant => grant.approver === record.approver,
        )
        return true
      case 'context-ended':
        this.#revokeWhere(
          record.at,
          grant => grant.contextId === record.contextId,
        )
        for (const state of this.#requests.values()) {
          if (
            state.status === 'pending' &&
            state.request.contextId === record.contextId
          ) {
            state.status = 'expired'
          }
        }
        return true
      case 'estop':
        this.#revokeWhere(record.at, () => true)
        return true
    }
  }

  /** Revoke what was still standing when the record was written. */
  #revokeWhere(at: number, match: (grant: GrantState) => boolean): void {
    for (const grant of this.#grants.values()) {
      if (
        grant.revokedAt === undefined &&
        grant.consumedAt === undefined &&
        grant.expiresAt > at &&
        match(grant)
      ) {
        grant.revokedAt = at
      }
    }
  }

  #load(): void {
    if (this.#loaded) return
    this.#loaded = true
    this.#requests.clear()
    this.#grants.clear()
    this.#nonces.clear()
    this.#revokedApprovers.clear()
    this.#issues = []
    this.#validLength = 0

    let raw: Buffer
    try {
      const fd = openSync(
        this.#path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      )
      try {
        raw = readFileSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.#issues.push({ line: 0, kind: 'unreadable' })
      return
    }

    this.#validLength = raw.lastIndexOf(0x0a) + 1
    const lines = raw
      .subarray(0, this.#validLength)
      .toString('utf8')
      .split('\n')
    lines.pop()
    for (const [index, line] of lines.entries()) {
      let record: LedgerRecord | undefined
      try {
        record = parseRecord(JSON.parse(line))
      } catch {
        record = undefined
      }
      if (record === undefined) {
        this.#issues.push({ line: index + 1, kind: 'corrupt_line' })
        return
      }
      if (!this.#apply(record)) {
        this.#issues.push({ line: index + 1, kind: 'inconsistent' })
        return
      }
    }
  }

  #handle(): number {
    if (this.#fd === null) {
      const directory = dirname(this.#path)
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
      const fd = openSync(
        this.#path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      try {
        chmodSync(this.#path, FILE_MODE)
        // Cut a torn tail so the next record starts on a line of its own.
        ftruncateSync(fd, this.#validLength)
      } catch (error) {
        closeSync(fd)
        throw error
      }
      this.#fd = fd
    }
    return this.#fd
  }

  /**
   * Append one record and only then apply it. A failed write applies nothing
   * and drops the cached state, so the next call reloads from what is really
   * on disk — including cutting whatever part of this line did land.
   */
  #append(record: LedgerRecord): boolean {
    const line = `${JSON.stringify(record)}\n`
    try {
      const fd = this.#handle()
      if (writeSync(fd, line) !== Buffer.byteLength(line, 'utf8')) {
        throw new Error('short write to the authz ledger')
      }
      fsyncSync(fd)
    } catch {
      this.close()
      return false
    }
    this.#validLength += Buffer.byteLength(line, 'utf8')
    if (!this.#apply(record)) {
      this.#issues.push({ line: 0, kind: 'inconsistent' })
      return false
    }
    return true
  }
}
