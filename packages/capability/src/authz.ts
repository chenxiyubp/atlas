// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two signed objects of the user authorization flow (design
 * `authorization-m1.md` §3.4, P14.3): a node's `AuthzRequest` ("this call is
 * waiting for someone to say yes") and an approver's `AuthzDecision` ("yes /
 * no, for this request, this digest, until then").
 *
 * ## Why neither is a capability token
 *
 * A decision comes from the console, a remote issuer, so a `user-confirmed`
 * capability carrying it would be refused by rule S-1 by construction; the
 * claims set is field-closed and has no room for a digest or an approver; and
 * a capability's one-time use rests on an in-memory nonce table that a restart
 * empties. So these are their own objects, and their one-time use rests on the
 * node's persisted request state (`@qianmo/resident`'s grant store), not here.
 *
 * ## Shape of the wire, shared with capability tokens
 *
 * `<payload>.<signature>`: the payload is the object's JSON in a fixed key
 * order, base64url; the signature is Ed25519 over the payload segment **as it
 * travelled**, so nothing is re-serialized between signing and checking.
 *
 * ## Signing domains
 *
 * The signed bytes are `<domain>\n<payload>`, with one domain per object. A
 * node key signs capability tokens (no prefix), handshakes
 * (`qianmo-handshake-v1`) and requests; a console approval key signs
 * decisions. The prefix is what makes a signature from one face worthless on
 * any other, whatever the payload bytes happen to be.
 *
 * ## What is not here
 *
 * No file system, no clock, no state. Whether a decision *applies* — that it
 * names a pending request of this node, arrived in time, from an approver this
 * node trusts, and has not been used — is decided by the grant store, in the
 * order the design fixes. This module only answers "is this well formed" and
 * "did this key sign it".
 */

import { createHash } from 'node:crypto'
import {
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  SIGNATURE_PATTERN,
  TRUST_UNTRUSTED,
  isValidSegment,
  parseAddress,
  type NoticeTrust,
} from '@qianmo/protocol'
import { signBytes, verifyBytes, type NodeKeyPair } from './keys.js'

/** Domain of a node's signature over an {@link AuthzRequest}. */
export const AUTHZ_REQUEST_DOMAIN = 'qianmo-authz-request-v1'

/** Domain of an approval key's signature over an {@link AuthzDecision}. */
export const AUTHZ_DECISION_DOMAIN = 'qianmo-authz-decision-v1'

/** Longest `allow-window` a decision may ask for (design D-5). */
export const MAX_AUTHZ_WINDOW_MS = 60 * 60 * 1000

export type AuthzDecisionKind = 'allow-once' | 'allow-window' | 'deny'

/** An approver's answer to one pending request (design §3.4 table). */
export interface AuthzDecision {
  readonly v: 1
  /** The node-generated id of the pending request; 32 lowercase hex. */
  readonly requestId: string
  /** The node the decision is for. */
  readonly aud: string
  /** `qianmo://<node>/<agent>`, equal to the pending request's. */
  readonly sub: string
  /** 64 lowercase hex; equal to the pending request's. */
  readonly digest: string
  readonly decision: AuthzDecisionKind
  /** `allow-window`: `0 < windowMs ≤ 60 min`. Otherwise `0`. */
  readonly windowMs: number
  /**
   * `<console>/<subject>`: which console vouches for which person
   * (`tenancy-m1.md` §3.5). The node cannot check the person; it checks that
   * the console named here is one it takes approvals from, and that the
   * signature is that console's.
   */
  readonly approver: string
  /** Epoch ms. */
  readonly nbf: number
  /** Epoch ms. */
  readonly exp: number
  /** Second line of replay defence; the request state is the first. */
  readonly nonce: string
}

/** Where the turn that raised a request came from (design §3.2). */
export interface AuthzOrigin {
  /** The sender's address, or `null` for a turn no peer message started. */
  readonly from: string | null
  readonly taskId: string | null
  readonly traceId: string | null
  /** The trust tier the node itself assigned that message. */
  readonly trust: NoticeTrust
}

/** A node's statement that one tool call is waiting for approval. */
export interface AuthzRequest {
  readonly v: 1
  /** 128 random bits, 32 lowercase hex. */
  readonly requestId: string
  /** The node that raised it and signs it. */
  readonly iss: string
  /** `qianmo://<iss>/<agent>`. */
  readonly sub: string
  readonly contextId: string
  readonly toolName: string
  /** The tool input exactly as the host received it, for the approver to read. */
  readonly input: Readonly<Record<string, unknown>>
  /** {@link authzDigest} of the above; the thing a decision binds to. */
  readonly digest: string
  readonly origin: AuthzOrigin
  /** Epoch ms. */
  readonly iat: number
  /** Epoch ms; the request's TTL ends here. */
  readonly exp: number
}

/** A parsed wire object and the exact bytes its signature covers. */
export interface SignedAuthz<T> {
  /** The payload segment, byte for byte as received. */
  readonly signed: string
  readonly signature: string
  readonly value: T
}

const DECISION_KEYS = [
  'v',
  'requestId',
  'aud',
  'sub',
  'digest',
  'decision',
  'windowMs',
  'approver',
  'nbf',
  'exp',
  'nonce',
] as const satisfies readonly (keyof AuthzDecision)[]

const REQUEST_KEYS = [
  'v',
  'requestId',
  'iss',
  'sub',
  'contextId',
  'toolName',
  'input',
  'digest',
  'origin',
  'iat',
  'exp',
] as const satisfies readonly (keyof AuthzRequest)[]

const ORIGIN_KEYS = [
  'from',
  'taskId',
  'traceId',
  'trust',
] as const satisfies readonly (keyof AuthzOrigin)[]

const REQUEST_ID = /^[0-9a-f]{32}$/
const DIGEST = /^[0-9a-f]{64}$/
const NONCE = /^[A-Za-z0-9_-]{16,128}$/
/** P15's person subject: `u:` and 16 lowercase hex (`tenancy-m1.md` §1.1). */
const SUBJECT = /^u:[0-9a-f]{16}$/
const LEGACY_PREFIX = 'legacy:'
const MAX_APPROVER_LENGTH = 160
const MAX_CONTEXT_LENGTH = 512
const MAX_TOOL_NAME_LENGTH = 128
const DECISIONS: ReadonlySet<string> = new Set([
  'allow-once',
  'allow-window',
  'deny',
])

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Exactly these keys: one more is a statement nobody can say they verified,
 * one fewer is a statement that does not say what it must.
 */
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

function nullableString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0)
}

/** Structural check of a decision — no clock, no keys, no request state. */
function isAuthzDecision(value: unknown): value is AuthzDecision {
  if (!plainObject(value) || !exactKeys(value, DECISION_KEYS)) return false
  const d = value
  if (d.v !== 1) return false
  if (typeof d.requestId !== 'string' || !REQUEST_ID.test(d.requestId)) {
    return false
  }
  if (!isValidSegment(d.aud) || parseAddress(d.sub) === null) return false
  if (typeof d.digest !== 'string' || !DIGEST.test(d.digest)) return false
  if (typeof d.decision !== 'string' || !DECISIONS.has(d.decision)) return false
  if (typeof d.windowMs !== 'number' || !Number.isSafeInteger(d.windowMs)) {
    return false
  }
  const windowOk =
    d.decision === 'allow-window'
      ? d.windowMs > 0 && d.windowMs <= MAX_AUTHZ_WINDOW_MS
      : d.windowMs === 0
  if (!windowOk) return false
  if (
    typeof d.approver !== 'string' ||
    d.approver.length === 0 ||
    d.approver.length > MAX_APPROVER_LENGTH
  ) {
    return false
  }
  if (!isEpochMs(d.nbf) || !isEpochMs(d.exp) || !(d.exp > d.nbf)) return false
  return typeof d.nonce === 'string' && NONCE.test(d.nonce)
}

function isAuthzOrigin(value: unknown): value is AuthzOrigin {
  if (!plainObject(value) || !exactKeys(value, ORIGIN_KEYS)) return false
  return (
    (value.from === null || parseAddress(value.from) !== null) &&
    nullableString(value.taskId) &&
    nullableString(value.traceId) &&
    (value.trust === TRUST_UNTRUSTED ||
      value.trust === NOTICE_TRUST_VERIFIED_CAPABILITY)
  )
}

/** Structural check of a request — no keys, and the digest is not recomputed. */
export function isAuthzRequest(value: unknown): value is AuthzRequest {
  if (!plainObject(value) || !exactKeys(value, REQUEST_KEYS)) return false
  const r = value
  if (r.v !== 1) return false
  if (typeof r.requestId !== 'string' || !REQUEST_ID.test(r.requestId)) {
    return false
  }
  if (!isValidSegment(r.iss)) return false
  const sub = parseAddress(r.sub)
  if (sub === null || sub.node !== r.iss) return false
  if (
    typeof r.contextId !== 'string' ||
    r.contextId.length === 0 ||
    r.contextId.length > MAX_CONTEXT_LENGTH
  ) {
    return false
  }
  if (
    typeof r.toolName !== 'string' ||
    r.toolName.length === 0 ||
    r.toolName.length > MAX_TOOL_NAME_LENGTH
  ) {
    return false
  }
  if (!plainObject(r.input)) return false
  if (typeof r.digest !== 'string' || !DIGEST.test(r.digest)) return false
  if (!isAuthzOrigin(r.origin)) return false
  return isEpochMs(r.iat) && isEpochMs(r.exp) && r.exp > r.iat
}

function encode(keys: readonly string[], value: object): string {
  const source = value as Record<string, unknown>
  const ordered: Record<string, unknown> = {}
  for (const key of keys) ordered[key] = source[key]
  return Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64url')
}

function signingInput(domain: string, signed: string): string {
  return `${domain}\n${signed}`
}

/** Sign a decision with a console approval key; throws on a malformed one. */
export function signAuthzDecision(
  keys: NodeKeyPair,
  decision: AuthzDecision,
): string {
  if (!isAuthzDecision(decision)) {
    throw new Error('refusing to sign a malformed authz decision')
  }
  const signed = encode(DECISION_KEYS, decision)
  return `${signed}.${signBytes(keys, signingInput(AUTHZ_DECISION_DOMAIN, signed))}`
}

/** Sign a request with the raising node's key; throws on a malformed one. */
export function signAuthzRequest(
  keys: NodeKeyPair,
  request: AuthzRequest,
): string {
  if (!isAuthzRequest(request)) {
    throw new Error('refusing to sign a malformed authz request')
  }
  const signed = encode(REQUEST_KEYS, request)
  return `${signed}.${signBytes(keys, signingInput(AUTHZ_REQUEST_DOMAIN, signed))}`
}

function parseWire<T>(
  wire: unknown,
  guard: (value: unknown) => value is T,
): SignedAuthz<T> | null {
  if (typeof wire !== 'string') return null
  const dot = wire.indexOf('.')
  if (dot <= 0 || dot !== wire.lastIndexOf('.')) return null
  const signed = wire.slice(0, dot)
  const signature = wire.slice(dot + 1)
  if (!SIGNATURE_PATTERN.test(signature)) return null
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(signed, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  return guard(value) ? { signed, signature, value } : null
}

/** Split and structurally validate a decision; `null` for anything else. */
export function parseAuthzDecision(
  wire: unknown,
): SignedAuthz<AuthzDecision> | null {
  return parseWire(wire, isAuthzDecision)
}

/** Did the holder of `publicKey` sign this decision, in the decision domain? */
export function verifyAuthzDecisionSignature(
  parts: SignedAuthz<AuthzDecision>,
  publicKey: string,
): boolean {
  return verifyBytes(
    publicKey,
    signingInput(AUTHZ_DECISION_DOMAIN, parts.signed),
    parts.signature,
  )
}

/**
 * A request the holder of `publicKey` signed, in the request domain, whose
 * digest matches its own contents — or `null`.
 *
 * The digest is recomputed so that what an approver is shown (`input`) and
 * what their decision binds to (`digest`) cannot come apart.
 */
export function verifyAuthzRequest(
  wire: unknown,
  publicKey: string,
): AuthzRequest | null {
  const parts = parseWire(wire, isAuthzRequest)
  if (parts === null) return null
  if (
    !verifyBytes(
      publicKey,
      signingInput(AUTHZ_REQUEST_DOMAIN, parts.signed),
      parts.signature,
    )
  ) {
    return null
  }
  const request = parts.value
  const agent = parseAddress(request.sub)?.agent
  if (agent === undefined) return null
  const digest = authzDigest({
    node: request.iss,
    agent,
    contextId: request.contextId,
    toolName: request.toolName,
    input: request.input,
  })
  return digest === request.digest ? request : null
}

/** An approver as the node reads the `approver` field. */
export type ApproverIdentity =
  | {
      readonly ok: true
      /** The console that vouches; must be one of the node's `--approver`s. */
      readonly console: string
      readonly subject: `u:${string}`
    }
  | {
      readonly ok: false
      /**
       * `legacy`: a legacy token principal — `legacy:view`, or the break-glass
       * `legacy:admin` — which never approves (`tenancy-m1.md` §3.4, D7 ③).
       */
      readonly reason: 'legacy' | 'malformed'
    }

/** Read `<console>/<subject>` under the P15 contract (`tenancy-m1.md` §3.5). */
export function parseApprover(value: unknown): ApproverIdentity {
  if (typeof value !== 'string') return { ok: false, reason: 'malformed' }
  if (value.startsWith(LEGACY_PREFIX)) return { ok: false, reason: 'legacy' }
  const slash = value.indexOf('/')
  if (slash <= 0 || slash !== value.lastIndexOf('/')) {
    return { ok: false, reason: 'malformed' }
  }
  const console = value.slice(0, slash)
  const subject = value.slice(slash + 1)
  if (!isValidSegment(console)) return { ok: false, reason: 'malformed' }
  if (subject.startsWith(LEGACY_PREFIX)) return { ok: false, reason: 'legacy' }
  if (!SUBJECT.test(subject)) return { ok: false, reason: 'malformed' }
  return { ok: true, console, subject: subject as `u:${string}` }
}

// ── Digest ────────────────────────────────────────────────────────────────

/**
 * JSON with object keys sorted at every depth and no whitespace. Only ever
 * fed parsed JSON (tool inputs) and the projections built below, so the
 * `JSON.stringify` rules for primitives are the rules.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
    return `{${keys
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The listed fields that are present; an absent one stays absent. */
function pick(
  input: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (input[field] !== undefined) out[field] = input[field]
  }
  return out
}

/** A flag the tool reads as "only when true": absent and `false` are one. */
function flag(value: unknown): boolean {
  return value === true
}

const MAX_PROJECTION_DEPTH = 4

/**
 * The part of a tool input an approval is about (design §3.4 table).
 *
 * Drops what does not change the action — `Bash`'s `description`, `WebFetch`'s
 * `prompt` — and reduces a `Write` body to its hash, so that a model
 * re-issuing the same call with new wording or key order hits the same grant
 * instead of raising a fresh request. Anything not listed is kept whole.
 */
function projectToolInput(
  toolName: string,
  input: unknown,
  depth = 0,
): unknown {
  if (!plainObject(input) || depth > MAX_PROJECTION_DEPTH) return input
  switch (toolName) {
    case 'Bash':
      return {
        command: input.command,
        run_in_background: flag(input.run_in_background),
        dangerouslyDisableSandbox: flag(input.dangerouslyDisableSandbox),
      }
    case 'Write':
      return {
        file_path: input.file_path,
        content_sha256:
          typeof input.content === 'string'
            ? sha256Hex(input.content)
            : canonicalJson(input.content),
      }
    case 'Edit':
      return {
        ...pick(input, ['file_path', 'old_string', 'new_string']),
        replace_all: flag(input.replace_all),
      }
    case 'Read':
      return pick(input, ['file_path', 'offset', 'limit'])
    case 'WebFetch':
      return pick(input, ['url'])
    case 'ExecuteExtraTool':
      return {
        tool_name: input.tool_name,
        params:
          typeof input.tool_name === 'string'
            ? projectToolInput(input.tool_name, input.params, depth + 1)
            : input.params,
      }
    default:
      return input
  }
}

/** What an approval binds to (design §3.4). */
export function authzDigest(call: {
  readonly node: string
  readonly agent: string
  readonly contextId: string
  readonly toolName: string
  readonly input: unknown
}): string {
  return sha256Hex(
    canonicalJson([
      call.node,
      call.agent,
      call.contextId,
      call.toolName,
      projectToolInput(call.toolName, call.input),
    ]),
  )
}
