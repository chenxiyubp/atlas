// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isValidSegment } from '@qianmo/protocol'
import {
  signBytes,
  verifyBytes,
  type NodeKeyPair,
  type PublicKeyDirectory,
} from '@qianmo/capability'
import { FRAME_VERSION } from './frames.js'

/**
 * Pre-shared-key handshake — **explicitly not production grade** (charter N-3).
 *
 * What it does: proves that the dialer holds the same secret as the listener,
 * over a server-chosen single-use nonce, so a captured handshake cannot be
 * replayed onto a second connection.
 *
 * What it does **not** do, and must be replaced before anything real depends
 * on it (M1, per-node keypairs):
 *
 * - one symmetric secret shared by every node — any holder can impersonate any
 *   other node, so `node` in the auth frame is an audit label, never authority;
 * - no rotation, no expiry, no revocation;
 * - connection-level only: individual envelopes are not authenticated, so an
 *   authenticated peer may claim any `from` (that is why the inbound adapter
 *   re-renders `from` itself, protocol.md rule E-1);
 * - no forward secrecy — confidentiality on the wire comes entirely from TLS.
 *
 * The secret itself is never a literal in this repository. It is supplied by
 * the caller, typically via {@link pskFromEnv}.
 *
 * ## The replacement, and why both live here at once
 *
 * P12.3 landed the successor described above: an Ed25519 signature by the
 * dialer's own node key, over the same tuple the MAC covers
 * (key-distribution.md §7.1), plus a signature *back* from the listener
 * (§7.1.1) — because "the peer could verify me" stopped implying "the peer
 * holds the secret too" the moment the proof became asymmetric.
 *
 * The two coexist inside frame version 1 rather than one replacing the other,
 * and that is forced rather than chosen: `frames.ts` compares `v` for strict
 * equality, so a version bump produces two generations that cannot talk at
 * all. Migration therefore rides on an optional field, and this module's job
 * is to decide which proof a given auth frame is offering. See §8.2 for the
 * three phases — this package implements the first two; only `required` on
 * {@link ListenerIdentity} moves a deployment to the third.
 */

/** Shortest secret this package will run with. */
export const PSK_MIN_LENGTH = 16

/** Environment variable {@link pskFromEnv} reads by default. */
export const PSK_ENV_VAR = 'QIANMO_TRANSPORT_PSK'

/** Raised when a secret is missing or too weak to be worth using. */
export class WeakSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeakSecretError'
  }
}

/**
 * Throw unless `psk` is long enough to be worth the handshake.
 *
 * A short secret is worse than an obviously absent one: it looks like security
 * while being brute-forceable, and the resulting outage is remote and silent.
 */
export function assertUsablePsk(psk: string): void {
  if (psk.length < PSK_MIN_LENGTH) {
    throw new WeakSecretError(
      `pre-shared key must be at least ${PSK_MIN_LENGTH} characters, got ${psk.length}`,
    )
  }
}

/**
 * Read the pre-shared key out of the environment.
 *
 * Injection point for the whole package: no default value, no fallback, no
 * literal anywhere in the tree. A missing variable is a startup failure, not a
 * silent downgrade to an unauthenticated socket.
 */
export function pskFromEnv(
  variable: string = PSK_ENV_VAR,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[variable]
  if (value === undefined || value.length === 0) {
    throw new WeakSecretError(`${variable} is not set`)
  }
  assertUsablePsk(value)
  return value
}

/** 32 hex characters of CSPRNG output. */
export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

/** Stable logical connection id generated once per client instance. */
export function newChannelId(): string {
  return randomBytes(16).toString('hex')
}

/** True when a logical connection id has the generated wire shape. */
export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

/**
 * `HMAC-SHA256(psk, [frameVersion, serverNonce, clientNonce, node, channelId])`, hex.
 *
 * The inputs go through `JSON.stringify` of an array rather than string
 * concatenation, so a node name containing a separator cannot be split across
 * two fields to forge a different tuple.
 */
export function computeMac(
  psk: string,
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
): string {
  return createHmac('sha256', psk)
    .update(
      JSON.stringify([
        FRAME_VERSION,
        serverNonce,
        clientNonce,
        node,
        channelId,
      ]),
    )
    .digest('hex')
}

/** Why a handshake was refused. Stable strings — they end up in audit records. */
export enum HandshakeRejection {
  /** The bytes were not a frame of this grammar at all. */
  MalformedFrame = 'malformed_frame',
  /** Frame arrived before/instead of the expected auth frame. */
  UnexpectedFrame = 'unexpected_frame',
  /** `node` is not a legal address segment. */
  BadNode = 'bad_node',
  /** The logical channel id is malformed. */
  BadChannel = 'bad_channel',
  /**
   * The channel id is well-formed, but a channel already carries it under a
   * *different* proven identity.
   *
   * Deliberately **not** {@link HandshakeRejection.BadChannel}: the two call
   * for opposite fixes, and a rejection string that cannot separate them is a
   * rejection string that tells an operator nothing (see the note on
   * {@link HandshakeRejection.SignatureRequired} for why these strings exist).
   * `bad_channel` means the dialer sent nonsense in the field; this one means
   * the dialer is fine and its channel id collided with a retained channel
   * owned by another credential — typically its own, one rotation ago.
   *
   * It is also the one rejection that does **not** close with
   * {@link CLOSE_UNAUTHORIZED}: see {@link CLOSE_CHANNEL_CONFLICT}.
   */
  ChannelIdentityMismatch = 'channel_identity_mismatch',
  /** The echoed nonce is not the one this connection issued. */
  NonceMismatch = 'nonce_mismatch',
  /** The MAC does not match — wrong key, or a forged frame. */
  BadMac = 'bad_mac',
  /**
   * A signature was required and the dialer offered none (§8.2 phase ③).
   *
   * The three signature rejections below and {@link HandshakeRejection.BadMac}
   * are **one path on the wire**: every one of them closes with
   * {@link CLOSE_UNAUTHORIZED} and the same reason string, so a dialer cannot
   * learn from the refusal whether this listener wanted a signature, has never
   * heard of it, or simply did not recognise the one it got. The distinction
   * exists only in the local audit record, which is where an operator needs it
   * — "the directory has no key for you" and "your signature is wrong" call
   * for opposite fixes.
   */
  SignatureRequired = 'signature_required',
  /** A credential proof was required, or only half of the extension arrived. */
  CredentialRequired = 'credential_required',
  /** No published key for the node the dialer claims to be. */
  UnknownSigner = 'unknown_signer',
  /** A signature was offered and it does not verify. */
  BadSignature = 'bad_signature',
  /** The credential proof does not bind the resolved credential to the tuple. */
  BadCredentialProof = 'bad_credential_proof',
}

/** The proof that actually admitted this connection. */
export type HandshakeAuthentication =
  | 'psk'
  | 'signature'
  | 'credential_signature'

/** Opaque metadata identifying the effective credential adopted locally. */
export interface AuthenticatedCredential {
  readonly source: string
  readonly id: string
}

/** This node's claim about the exact credential backing its signature. */
export interface HandshakeCredentialClaim extends AuthenticatedCredential {
  readonly selector: string
}

/**
 * A directory result: verification key plus effective credential metadata.
 * The inherited `source/id` own admitted state and revocation decisions.
 */
export interface ResolvedHandshakeCredential extends AuthenticatedCredential {
  readonly publicKey: string
  /**
   * Credential metadata covered by the peer's proof when it differs from the
   * credential this verifier will adopt locally.
   *
   * For example, a peer can claim a CA certificate fingerprint while an
   * explicit trust entry for the same key wins locally. The proof still has
   * to bind the certificate claim, but the admitted connection must be owned
   * by the effective explicit credential. Omit when both identities are the
   * same (the backwards-compatible directory shape).
   */
  readonly proofCredential?: AuthenticatedCredential
}

/**
 * Optional extension implemented by directories that can distinguish more
 * than one credential for the same node. The transport treats `selector`,
 * `source`, and `id` as opaque values.
 */
export interface HandshakeCredentialDirectory extends PublicKeyDirectory {
  handshakeCredentialOf(
    node: string,
    selector: string | undefined,
  ): ResolvedHandshakeCredential | null
}

/** Outcome of {@link verifyAuth}. */
export type HandshakeResult =
  | {
      readonly ok: true
      readonly node: string
      readonly channelId: string
      readonly authentication: HandshakeAuthentication
      readonly credential?: AuthenticatedCredential
      /** Exact Ed25519 key that verified a signed attempt; absent for PSK. */
      readonly signingPublicKey?: string
    }
  | { readonly ok: false; readonly rejection: HandshakeRejection }

/** What {@link verifyAuth} needs out of an auth frame. */
export interface AuthAttempt {
  readonly node: string
  readonly nonce: string
  readonly clientNonce: string
  readonly channelId: string
  readonly mac: string
  /** Present when the dialer signed; see {@link verifyAuthAttempt}. */
  readonly sig?: string
  /** Opaque selector paired with {@link AuthAttempt.credentialProof}. */
  readonly credential?: string
  /** Independent proof binding {@link AuthAttempt.credential} to the signer. */
  readonly credentialProof?: string
}

/** Constant-time hex comparison; unequal lengths are unequal, not a throw. */
function macEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(actual, 'hex')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Check one auth attempt against the nonce this connection issued.
 *
 * The MAC comparison is constant-time so a wrong key cannot be recovered byte
 * by byte from response timing. The cheap structural checks run first — they
 * leak nothing an attacker does not already know.
 */
export function verifyAuth(
  psk: string,
  serverNonce: string,
  attempt: AuthAttempt,
): HandshakeResult {
  if (!isValidSegment(attempt.node)) {
    return { ok: false, rejection: HandshakeRejection.BadNode }
  }
  if (!isChannelId(attempt.channelId)) {
    return { ok: false, rejection: HandshakeRejection.BadChannel }
  }
  if (attempt.nonce !== serverNonce) {
    return { ok: false, rejection: HandshakeRejection.NonceMismatch }
  }
  const expected = computeMac(
    psk,
    serverNonce,
    attempt.clientNonce,
    attempt.node,
    attempt.channelId,
  )
  if (!macEquals(expected, attempt.mac)) {
    return { ok: false, rejection: HandshakeRejection.BadMac }
  }
  return {
    ok: true,
    node: attempt.node,
    channelId: attempt.channelId,
    authentication: 'psk',
  }
}

/**
 * Domain-separation prefix for every handshake signature (§4.4, §7.1).
 *
 * Mandatory rather than decorative: the node's Ed25519 key also signs
 * capability tokens, and a signature is only ever a claim about *some* bytes.
 * Without a prefix that only this handshake produces, a signature harvested
 * from one of those faces could be replayed onto the other whenever the byte
 * strings happened to line up.
 */
export const HANDSHAKE_SIGNATURE_DOMAIN = 'qianmo-handshake-v1'

/** Domain used only for the optional exact-credential proof. */
export const HANDSHAKE_CREDENTIAL_PROOF_DOMAIN =
  'qianmo-handshake-credential-proof-v1'

function handshakeMessage(fields: readonly (string | number)[]): string {
  return `${HANDSHAKE_SIGNATURE_DOMAIN}\n${JSON.stringify(fields)}`
}

/**
 * The bytes a dialer signs: the very tuple {@link computeMac} covers, behind
 * the domain prefix (§7.1).
 *
 * Reusing the tuple rather than inventing a second one keeps the two proofs
 * interchangeable — a listener checking either is checking the same five
 * facts — and inherits the reason the tuple is a `JSON.stringify`d array in
 * the first place: a node name containing a separator cannot be split across
 * two fields to forge a different tuple.
 */
export function authSigningInput(
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
): string {
  return handshakeMessage([
    FRAME_VERSION,
    serverNonce,
    clientNonce,
    node,
    channelId,
  ])
}

/**
 * The bytes a listener signs: the same tuple plus **its own** node segment
 * (§7.1.1).
 *
 * The sixth field is what makes the two directions un-confusable. A dialer's
 * signature covers a five-element array and a listener's covers a six-element
 * one, so neither can ever be replayed as the other — no matter what the node
 * segments are — and the listener's own name is inside what it signed, which
 * is precisely the claim the dialer wants checked ("you are the node I meant
 * to reach"), not merely "somebody with a key was here".
 */
export function readySigningInput(
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
  listenerNode: string,
): string {
  return handshakeMessage([
    FRAME_VERSION,
    serverNonce,
    clientNonce,
    node,
    channelId,
    listenerNode,
  ])
}

function credentialProofMessage(
  direction: 'auth' | 'ready',
  legacyTuple: readonly (string | number)[],
  selector: string,
  source: string,
  id: string,
): string {
  return `${HANDSHAKE_CREDENTIAL_PROOF_DOMAIN}\n${JSON.stringify([
    direction,
    ...legacyTuple,
    selector,
    source,
    id,
  ])}`
}

/** Exact-credential proof for the dialer direction. */
export function authCredentialProofInput(
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
  selector: string,
  source: string,
  id: string,
): string {
  return credentialProofMessage(
    'auth',
    [FRAME_VERSION, serverNonce, clientNonce, node, channelId],
    selector,
    source,
    id,
  )
}

/** Exact-credential proof for the listener direction. */
export function readyCredentialProofInput(
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
  listenerNode: string,
  selector: string,
  source: string,
  id: string,
): string {
  return credentialProofMessage(
    'ready',
    [FRAME_VERSION, serverNonce, clientNonce, node, channelId, listenerNode],
    selector,
    source,
    id,
  )
}

/**
 * Ed25519 material and the peer directory one side of a handshake needs.
 *
 * `directory` is `@qianmo/capability`'s {@link PublicKeyDirectory}, the same
 * interface the inbound capability gate reads — one node, one answer to "what
 * key does that peer publish", whether the question is asked about a token or
 * about a handshake. `publicKeyOf` is synchronous by that interface's
 * contract, and this is a second reason for it: the lookup happens inside the
 * socket's message handler, before the dialer has proven anything.
 */
export interface HandshakeIdentity {
  /** This node's own key pair. Only the public half ever leaves the process. */
  readonly keys: NodeKeyPair
  readonly directory: PublicKeyDirectory
  /** Exact credential this node can prove, including the wire selector. */
  readonly credential?: HandshakeCredentialClaim
  /**
   * Refuse a peer that offers no signature (§8.2 phase ③).
   *
   * Left off during phases ① and ②, which is what makes a signing node and a
   * pre-shared-key node interoperate. Turning it on is the whole of "PSK is
   * retired here". This does not require an exact credential proof; that is a
   * separate deployment stage controlled by {@link credentialProofRequired}.
   */
  readonly required?: boolean
  /**
   * Nodes that have completed their upgrade and must never fall back to PSK.
   *
   * This is the per-peer form of {@link required}: it permits a staged rollout
   * without inventing a second global bypass. The same policy is applied to a
   * dialer's `ready` verification and a listener's `auth` verification, so a
   * stripped signature is rejected in both directions for every pinned peer.
   */
  readonly requiredPeers?: ReadonlySet<string>
  /** Require the independent exact-credential proof from every signed peer. */
  readonly credentialProofRequired?: boolean
  /** Per-peer form of {@link credentialProofRequired}. */
  readonly credentialProofRequiredPeers?: ReadonlySet<string>
}

/** A listener additionally announces the node its own signature is made under. */
export interface ListenerIdentity extends HandshakeIdentity {
  /** This listener's own node segment, sent on the ready frame. */
  readonly node: string
}

/**
 * Check one auth attempt, taking whichever proof it offered.
 *
 * The order is the same one {@link verifyAuth} keeps and for the same reason:
 * the cheap structural checks first, because they leak nothing an attacker
 * does not already know, and **nothing is consumed or bound before the proof
 * verifies** — the caller does not learn a channel id it may act on until
 * this returns `ok`.
 *
 * Which proof is taken is decided by the listener's configuration first and
 * the frame second:
 *
 * - no `signing` at all ⇒ the MAC, exactly as before this existed. A dialer's
 *   `sig` is not merely unchecked here, it is *unread* — a listener that was
 *   never given a directory has no way to check one, and pretending otherwise
 *   would be the worst of the three outcomes;
 * - `signing` and a `sig` on the frame ⇒ the signature, and the MAC is not
 *   consulted at all;
 * - `signing` without a `sig` ⇒ the MAC, unless the global deployment stage
 *   or this particular peer requires a signature, which refuses.
 *
 * Whether the *credential* extension on that frame is taken up is a second,
 * independent decision, and it is the listener's as well — see
 * {@link readsCredentialClaims}.
 */
export function verifyAuthAttempt(
  psk: string,
  signing: HandshakeIdentity | undefined,
  serverNonce: string,
  attempt: AuthAttempt,
): HandshakeResult {
  if (!isValidSegment(attempt.node)) {
    return { ok: false, rejection: HandshakeRejection.BadNode }
  }
  if (!isChannelId(attempt.channelId)) {
    return { ok: false, rejection: HandshakeRejection.BadChannel }
  }
  if (attempt.nonce !== serverNonce) {
    return { ok: false, rejection: HandshakeRejection.NonceMismatch }
  }
  if (signing !== undefined && attempt.sig !== undefined) {
    const hasCredential = attempt.credential !== undefined
    const hasCredentialProof = attempt.credentialProof !== undefined
    if (hasCredential !== hasCredentialProof) {
      return {
        ok: false,
        rejection: HandshakeRejection.CredentialRequired,
      }
    }
    if (!hasCredential && credentialProofRequiredFor(signing, attempt.node)) {
      return {
        ok: false,
        rejection: HandshakeRejection.CredentialRequired,
      }
    }
    const takesCredential =
      hasCredential && readsCredentialClaims(signing, attempt.node)
    const resolved = takesCredential
      ? resolveHandshakeCredential(signing, attempt.node, attempt.credential)
      : resolveLegacySigningKey(signing, attempt.node)
    if (resolved === null) {
      return { ok: false, rejection: HandshakeRejection.UnknownSigner }
    }
    const signed = authSigningInput(
      serverNonce,
      attempt.clientNonce,
      attempt.node,
      attempt.channelId,
    )
    if (!verifyBytes(resolved.publicKey, signed, attempt.sig)) {
      return { ok: false, rejection: HandshakeRejection.BadSignature }
    }
    if (takesCredential) {
      // Fail **closed**. Every field below is present on today's only producer
      // of a credential-bearing `ResolvedSigningKey`, so none of these guards
      // can fire — which is exactly why they are written as a rejection rather
      // than as extra conjuncts on the `!verifyBytes(...)` test. In that shape
      // a directory that one day stops filling `proofCredential` does not
      // fail: it *skips the proof check* and admits the peer as
      // `credential_signature`, which is the one outcome this whole extension
      // exists to prevent. "I cannot tell what these bytes should have
      // covered" has to read as "they do not cover it".
      const selector = attempt.credential
      const offeredProof = attempt.credentialProof
      const proofCredential = resolved.proofCredential
      if (
        selector === undefined ||
        offeredProof === undefined ||
        resolved.credential === undefined ||
        proofCredential === undefined ||
        !verifyBytes(
          resolved.publicKey,
          authCredentialProofInput(
            serverNonce,
            attempt.clientNonce,
            attempt.node,
            attempt.channelId,
            selector,
            proofCredential.source,
            proofCredential.id,
          ),
          offeredProof,
        )
      ) {
        return {
          ok: false,
          rejection: HandshakeRejection.BadCredentialProof,
        }
      }
    }
    return {
      ok: true,
      node: attempt.node,
      channelId: attempt.channelId,
      authentication:
        resolved.credential === undefined
          ? 'signature'
          : 'credential_signature',
      signingPublicKey: resolved.publicKey,
      ...(resolved.credential === undefined
        ? {}
        : { credential: resolved.credential }),
    }
  }
  if (
    signing !== undefined &&
    (attempt.credential !== undefined || attempt.credentialProof !== undefined)
  ) {
    return { ok: false, rejection: HandshakeRejection.BadSignature }
  }
  if (signatureRequiredFor(signing, attempt.node)) {
    return { ok: false, rejection: HandshakeRejection.SignatureRequired }
  }
  if (credentialProofRequiredFor(signing, attempt.node)) {
    return { ok: false, rejection: HandshakeRejection.CredentialRequired }
  }
  return verifyAuth(psk, serverNonce, attempt)
}

/** The two fields a listener adds to its ready frame when it signs (§7.1.1). */
export function signReady(
  signing: ListenerIdentity,
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
): {
  readonly node: string
  readonly sig: string
  readonly credential?: string
  readonly credentialProof?: string
} {
  const credential = signing.credential
  return {
    node: signing.node,
    sig: signBytes(
      signing.keys,
      readySigningInput(
        serverNonce,
        clientNonce,
        node,
        channelId,
        signing.node,
      ),
    ),
    ...(credential === undefined
      ? {}
      : {
          credential: credential.selector,
          credentialProof: signBytes(
            signing.keys,
            readyCredentialProofInput(
              serverNonce,
              clientNonce,
              node,
              channelId,
              signing.node,
              credential.selector,
              credential.source,
              credential.id,
            ),
          ),
        }),
  }
}

/** Why a dialer refused a ready frame. Stable strings — they reach audit records. */
export enum ReadyRejection {
  /** The listener did not sign, and this dialer requires it (§8.2 phase ③). */
  Unsigned = 'ready_unsigned',
  /** A credential proof was required, or only half of the extension arrived. */
  CredentialRequired = 'ready_credential_required',
  /** Signed, but by a node other than the one this dialer set out to reach. */
  WrongNode = 'ready_wrong_node',
  /** No published key for that node — nothing to check the signature against. */
  UnknownSigner = 'ready_unknown_signer',
  /** A signature was offered and it does not verify. */
  BadSignature = 'ready_bad_signature',
  /** The exact-credential proof does not verify. */
  BadCredentialProof = 'ready_bad_credential_proof',
}

export type ReadyResult =
  | {
      readonly ok: true
      readonly authentication: HandshakeAuthentication
      readonly credential?: AuthenticatedCredential
    }
  | { readonly ok: false; readonly rejection: ReadyRejection }

/** Whether this deployment stage pins `peerNode` to a signed handshake. */
export function signatureRequiredFor(
  signing: HandshakeIdentity | undefined,
  peerNode: string,
): boolean {
  return (
    signing?.required === true || signing?.requiredPeers?.has(peerNode) === true
  )
}

/** Whether policy requires an exact credential proof for `peerNode`. */
export function credentialProofRequiredFor(
  signing: HandshakeIdentity | undefined,
  peerNode: string,
): boolean {
  return (
    signing?.credentialProofRequired === true ||
    signing?.credentialProofRequiredPeers?.has(peerNode) === true
  )
}

/** The tuple both halves of the handshake signed, as the dialer remembers it. */
export interface HandshakeTuple {
  readonly serverNonce: string
  readonly clientNonce: string
  readonly node: string
  readonly channelId: string
}

/**
 * Check the listener's half of the handshake (§7.1.1).
 *
 * `peerNode` is the node the dialer *meant* to reach, and looking the key up
 * under that name rather than under the name on the frame is the whole point:
 * it is what turns a tampered `AgentRecord.endpoint` from a successful
 * redirect into a failed connection (§11 T-B′). A listener that answers with
 * a different name than the dialer asked for is refused before any signature
 * is even checked — the name is the claim being tested.
 *
 * An unsigned ready is opportunistically authenticated only: it is accepted
 * during the coexistence phase, but it has fallen back to PSK and must be
 * recorded as such. Pinning the peer (or enabling the strict deployment
 * stage) refuses that fallback, including when an on-path actor stripped the
 * optional fields.
 */
export function verifyReady(
  peerNode: string,
  signing: HandshakeIdentity,
  tuple: HandshakeTuple,
  frame: {
    readonly node?: string
    readonly sig?: string
    readonly credential?: string
    readonly credentialProof?: string
  },
): ReadyResult {
  if (frame.sig === undefined || frame.node === undefined) {
    if (frame.credential !== undefined || frame.credentialProof !== undefined) {
      return { ok: false, rejection: ReadyRejection.BadSignature }
    }
    if (credentialProofRequiredFor(signing, peerNode)) {
      return { ok: false, rejection: ReadyRejection.CredentialRequired }
    }
    return signatureRequiredFor(signing, peerNode)
      ? { ok: false, rejection: ReadyRejection.Unsigned }
      : { ok: true, authentication: 'psk' }
  }
  if (frame.node !== peerNode) {
    return { ok: false, rejection: ReadyRejection.WrongNode }
  }
  const hasCredential = frame.credential !== undefined
  const hasCredentialProof = frame.credentialProof !== undefined
  if (hasCredential !== hasCredentialProof) {
    return { ok: false, rejection: ReadyRejection.CredentialRequired }
  }
  if (!hasCredential && credentialProofRequiredFor(signing, peerNode)) {
    return { ok: false, rejection: ReadyRejection.CredentialRequired }
  }
  const takesCredential =
    hasCredential && readsCredentialClaims(signing, peerNode)
  const resolved = takesCredential
    ? resolveHandshakeCredential(signing, peerNode, frame.credential)
    : resolveLegacySigningKey(signing, peerNode)
  if (resolved === null) {
    return { ok: false, rejection: ReadyRejection.UnknownSigner }
  }
  const signed = readySigningInput(
    tuple.serverNonce,
    tuple.clientNonce,
    tuple.node,
    tuple.channelId,
    frame.node,
  )
  if (!verifyBytes(resolved.publicKey, signed, frame.sig)) {
    return { ok: false, rejection: ReadyRejection.BadSignature }
  }
  if (takesCredential) {
    // Fail closed, for the reason spelled out in `verifyAuthAttempt` — this is
    // the dialer's half of the same check and must not diverge from it.
    const selector = frame.credential
    const offeredProof = frame.credentialProof
    const proofCredential = resolved.proofCredential
    if (
      selector === undefined ||
      offeredProof === undefined ||
      resolved.credential === undefined ||
      proofCredential === undefined ||
      !verifyBytes(
        resolved.publicKey,
        readyCredentialProofInput(
          tuple.serverNonce,
          tuple.clientNonce,
          tuple.node,
          tuple.channelId,
          frame.node,
          selector,
          proofCredential.source,
          proofCredential.id,
        ),
        offeredProof,
      )
    ) {
      return { ok: false, rejection: ReadyRejection.BadCredentialProof }
    }
  }
  return {
    ok: true,
    authentication:
      resolved.credential === undefined ? 'signature' : 'credential_signature',
    ...(resolved.credential === undefined
      ? {}
      : { credential: resolved.credential }),
  }
}

function hasCredentialDirectory(
  directory: PublicKeyDirectory,
): directory is HandshakeCredentialDirectory {
  return (
    'handshakeCredentialOf' in directory &&
    typeof directory.handshakeCredentialOf === 'function'
  )
}

/**
 * Whether this verifier takes up a credential the peer offered, or judges the
 * frame as the plainly signed one it also is.
 *
 * The question asked here is **"can this verifier form an opinion about
 * credentials at all"**, deliberately *not* "did this particular credential
 * resolve". Those are one keystroke apart and opposite in consequence, so the
 * two answers are worth spelling out:
 *
 * - **No credential directory** (a `--trust`-only listener, §8.2 phase ①). It
 *   holds no view on credentials whatsoever — it cannot admit one, revoke one,
 *   or tell them apart — so a credential-bearing frame carries, for this
 *   verifier, exactly the information a legacy signed frame carries: an
 *   Ed25519 signature over the five-element tuple, checkable against the key
 *   it was handed by hand. Reading it that way is what makes phase ① mean what
 *   §8.2 says it means. The alternative — the behaviour this replaces — is
 *   that the first node to gain a certificate silently loses every peer that
 *   has not gained one yet, `unknown_signer` on a key the listener is holding.
 * - **A credential directory that returned `null`** (unknown selector, or a
 *   certificate on the revocation list). Falling back here would be a
 *   **revocation bypass**: the holder of a revoked certificate whose bare
 *   public key still sits in somebody's `--trust` list would get back in by
 *   offering a credential that does not resolve — turning "send garbage" into
 *   a downgrade primitive, and making §6.4's revocation depend on the peer's
 *   good manners. So that case does not reach this function: it resolves
 *   through the credential path and is refused as {@link
 *   HandshakeRejection.UnknownSigner}, exactly as before.
 *
 * `credentialProofRequired` keeps its veto on top of the first case. A verifier
 * that demands the exact proof and cannot check one refuses rather than
 * downgrades — policy that quietly evaporates when the directory is the wrong
 * shape is not policy.
 *
 * This adds no downgrade surface. An on-path actor may already strip
 * `credential`/`credentialProof` from a v1 frame without disturbing `sig`
 * (§7.1, "混版本事实"), and against a directory-less verifier that already
 * lands on the legacy path today. The fallback reaches the same verdict for
 * the honest frame that the stripped one already reaches; what changes is only
 * that the honest peer no longer has to be attacked in order to connect.
 */
function readsCredentialClaims(
  signing: HandshakeIdentity,
  peerNode: string,
): boolean {
  return (
    hasCredentialDirectory(signing.directory) ||
    credentialProofRequiredFor(signing, peerNode)
  )
}

/**
 * What a directory lookup came back with, in the two shapes it may take.
 *
 * A union rather than one interface with two optional fields, and that is the
 * whole point: "a credential to adopt, but nothing said what the peer's proof
 * should cover" is the fail-open state, and here it does not typecheck. The
 * runtime guards in `verifyAuthAttempt`/`verifyReady` stay as well — this
 * package is consumed from JavaScript too, and a type cannot refuse a value at
 * runtime — but a future producer that forgets `proofCredential` now fails to
 * compile instead of silently admitting peers as `credential_signature`.
 */
type ResolvedSigningKey =
  | {
      readonly publicKey: string
      readonly credential?: undefined
      readonly proofCredential?: undefined
    }
  | {
      readonly publicKey: string
      readonly credential: AuthenticatedCredential
      readonly proofCredential: AuthenticatedCredential
    }

function resolveHandshakeCredential(
  signing: HandshakeIdentity,
  node: string,
  selector: string | undefined,
): ResolvedSigningKey | null {
  if (!hasCredentialDirectory(signing.directory) || selector === undefined)
    return null
  const resolved = signing.directory.handshakeCredentialOf(node, selector)
  if (resolved === null) return null
  const credential = { source: resolved.source, id: resolved.id }
  return {
    publicKey: resolved.publicKey,
    credential,
    proofCredential: resolved.proofCredential ?? credential,
  }
}

function resolveLegacySigningKey(
  signing: HandshakeIdentity,
  node: string,
): ResolvedSigningKey | null {
  const publicKey = signing.directory.publicKeyOf(node)
  return publicKey === null ? null : { publicKey }
}

/**
 * WebSocket close code for a refused handshake.
 *
 * 4003 is what the base already uses for "unauthorized" on its own client
 * sockets (`src/cli/transports/WebSocketTransport.ts:46`), and it treats the
 * code as permanent — no reconnect storm against a door that will not open.
 * Reusing the number keeps both halves of a mixed deployment agreeing on that.
 */
export const CLOSE_UNAUTHORIZED = 4003

/**
 * WebSocket close code for "that channel id belongs to another identity".
 *
 * The single deliberate exception to the rule above it, and it exists because
 * {@link CLOSE_UNAUTHORIZED} is *permanent* by contract — a dialer that gets
 * 4003 stops for good, which is right for "your key is wrong" and catastrophic
 * for "your key is fine, your channel id is taken". A node whose certificate
 * was legitimately re-issued, or whose entry in the listener's directory
 * gained an explicit trust row while it was mid-task, hits the second case
 * with nothing wrong on its side; on 4003 it would take itself out of service
 * permanently without a single byte having changed on the wire.
 *
 * So this code says "retry under a different channel id", and the dialer does
 * exactly that (`client.ts`, bounded). The old channel is left alone to expire
 * on its retention clock — it is **not** handed to the new identity, which is
 * the whole security property this rejection is enforcing.
 *
 * What it costs: a peer that has already cleared L1 can learn that some
 * channel id it named is held by another identity. A channel id is 128 bits of
 * CSPRNG output ({@link newChannelId}), never leaves the two endpoints, and the
 * dialer supplied this one itself — so the leak is "your own id collided",
 * which is what it needs to know to recover. Judged acceptable; nothing else
 * in this file gets a distinguishable code.
 */
export const CLOSE_CHANNEL_CONFLICT = 4004

/** WebSocket close code for a frame that is not part of this grammar. */
export const CLOSE_PROTOCOL_ERROR = 1002
