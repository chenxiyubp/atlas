// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `CertificateDirectory` — the `--trust-ca` replacement for
 * `StaticPublicKeyDirectory` (key-distribution.md §8.1).
 *
 * Same {@link PublicKeyDirectory} interface `@qianmo/capability` already
 * defines, so nothing downstream of `publicKeyOf` changes. What is different
 * is where the keys come from: instead of a fixed map built once from
 * `--trust`, this one caches the registry's published certificates, checks
 * each against a local CA root and a revocation list, and refreshes itself
 * on its own clock.
 *
 * ## `publicKeyOf` stays synchronous, on purpose (§8.1, `token.ts:44-48`)
 *
 * The inbound capability gate calls `publicKeyOf` from inside a message
 * handler, before the sender has proven anything — a lookup that could block
 * would hand an unauthenticated peer control over how long that handler
 * takes. So every network call and every certificate check happens in
 * {@link CertificateDirectory.refresh}, off the hot path, and `publicKeyOf`
 * only ever reads a plain `Map` built by the last refresh. This is why the
 * class does its own verification up front rather than verifying lazily on
 * first lookup — a lazy design would put exactly the blocking work `token.ts`
 * forbids on the one method that must never block.
 *
 * ## Fail-closed, and to what (§6.4)
 *
 * A revocation list that is stale — `now >= nextUpdate`, including "never
 * fetched at all" — does not fail the directory open (every CA-derived key
 * still served) or closed (every lookup refused). It falls back to exactly
 * the explicit entries handed to the constructor or {@link put}, the same
 * set `--trust` has always populated. `#effective` is rebuilt on every
 * refresh so this degrade and its recovery are both silent and immediate —
 * there is no "stuck open" state to notice and clear by hand.
 *
 * {@link CertificateDirectory.handshakeCredentialOf} degrades the same way
 * and for the same reason, which is less obvious there because a certificate
 * *selector* survives the degrade too — see that method's own comment.
 *
 * ## What is verified here, and what is not
 *
 * A certificate must, in order: parse as a §4.2 binding, name the node it
 * was registered under, agree with any `publicKey` field alongside it, have
 * been issued by one of the configured CA roots (F-2), be currently valid
 * (not before `notAfter`, not after — well, not *before* `notBefore` either;
 * the root's own validity counts too), and — only while the revocation list
 * is fresh — not be on it. Any failure drops that one node from the
 * CA-derived cache; it does not throw, because one bad record from a
 * zero-auth registry (§5.2) must not stop every other node from resolving.
 *
 * ## One root or several (§3.3's 90-day overlap)
 *
 * `caCertificatePem` may hold more than one root, and every one of them is
 * used — the same set the TLS layer is handed, because both come out of
 * `trustAnchors.ts`. A malformed trust file is the one thing here that
 * *does* throw, from the constructor: it is local configuration, not a
 * registry record, and a node that started with part of its trust set
 * silently missing would look configured while refusing half the network.
 *
 * What this class does **not** do: verify the RL's own freshness against a
 * clock the operator cannot see (that is exactly {@link publicKeyOf}'s
 * fail-closed behaviour, not a bug to work around), or accept a certificate
 * this CA root did not sign, however well-formed its SANs are — that is
 * precisely T-B's "篡改者可以往注册中心塞一张伪造证书" case, and F-2 is the
 * whole reason it is checkable with zero additional trust.
 */

import { X509Certificate } from 'node:crypto'
import {
  parseAddress,
  parseNodeCertificateBinding,
  type NodeCertificateBinding,
} from '@qianmo/protocol'
import type { PublicKeyDirectory } from '@qianmo/capability'
// Type-only, and deliberately so: the transport reaches this class through a
// runtime `'handshakeCredentialOf' in directory` probe, which means a field
// name drifting on either side of {@link ResolvedHandshakeCredential} would
// otherwise compile clean and then silently downgrade every credential
// handshake to a 4003. Naming the transport's own type here is what makes
// that drift a type error instead.
import type {
  HandshakeCredentialDirectory,
  ResolvedHandshakeCredential,
} from '@qianmo/transport'
import type { RevocationList } from './ca/revocationList.js'
import {
  anchoredValidity,
  parseTrustAnchors,
  verifyRevocationListByAnchors,
} from './trustAnchors.js'

/** Injection point for tests; production always uses the global `fetch`. */
type DirectoryFetch = (input: string, init: RequestInit) => Promise<Response>

/** One shape `GET /v0/agents` returns a row as — only what this class reads. */
interface AgentBody {
  readonly address?: unknown
  readonly publicKey?: unknown
  readonly certificate?: unknown
}

/** A certificate whose binding and CA signature have been verified. */
interface CachedCertificate {
  readonly publicKey: string
  readonly fingerprint256: string
  /** Epoch milliseconds, copied out so cache entries can be rechecked offline. */
  readonly notBefore: number
  /** Epoch milliseconds, copied out so cache entries can be rechecked offline. */
  readonly notAfter: number
}

interface CertificateFact extends CachedCertificate {
  readonly node: string
}

export const CERTIFICATE_CREDENTIAL_SOURCE = 'certificate'
export const EXPLICIT_CREDENTIAL_SOURCE = 'explicit'

interface CertificateCredentialInvalidation {
  readonly node: string
  readonly source: typeof CERTIFICATE_CREDENTIAL_SOURCE
  readonly id: string
}

export interface CertificateDirectoryAuditEvent {
  readonly node: string
  readonly reason: string
}

export type CertificateDirectoryAuditSink = (
  event: CertificateDirectoryAuditEvent,
) => void

/** A contained failure in polling or in a refresh observer. */
export interface CertificateDirectoryErrorEvent {
  readonly phase:
    | 'audit_sink'
    | 'polling_refresh'
    | 'refresh_sink'
    | 'revocation_list'
  readonly reason: string
}

export type CertificateDirectoryErrorSink = (
  event: CertificateDirectoryErrorEvent,
) => void

/** The distinct effects a refresh can have on a connection holder. */
interface CertificateDirectoryRefresh {
  /**
   * Nodes absent from this refresh's effective directory. An untrusted
   * registry may omit a live lease or publish a malformed row, neither of
   * which is authorization to terminate a connection that was authenticated
   * earlier. Consumers may use this for observation, never a 4003 close.
   */
  readonly directoryRemoved: readonly string[]
  /**
   * Nodes whose last verified certificate is certainly unusable: a fresh,
   * CA-signed RL names its fingerprint, or its `notAfter` has elapsed. These
   * are the only removals that revoke already authenticated connections.
   *
   * The list remains present until a refresh sink accepts it, so a transient
   * observer failure cannot silently lose a security close.
   */
  readonly permanentlyInvalidated: readonly string[]
  /** Exact certificate credentials that a transport may close safely. */
  readonly permanentlyInvalidatedCredentials: readonly CertificateCredentialInvalidation[]
}

/** Receives the result of every completed refresh, including polling refreshes. */
type CertificateDirectoryRefreshSink = (
  result: CertificateDirectoryRefresh,
) => void

/**
 * Constructor options. Not exported for the same reason
 * `NodeCertificateRequest` is not: every caller builds the object literal
 * inline at `new CertificateDirectory({...})` and never names the type.
 */
interface CertificateDirectoryOptions {
  /**
   * PEM root certificate(s) — the one thing distributed out of band (§5.1).
   * Several roots during a rotation overlap (§3.3); all of them are used.
   */
  readonly caCertificatePem: string
  /** `<node>=<publicKey>` pairs from `--trust`; always wins over the CA cache. */
  readonly trusted?: Iterable<readonly [string, string]>
  /**
   * Base URL of the registry's HTTP v0 API. Omit to run with no network
   * source at all — {@link refresh} then only re-applies the explicit
   * entries, which is the same state a stale RL degrades to (§6.4). Useful
   * standalone (nothing to poll yet) and as the honest default until a node
   * actually announces to and reads from a live registry.
   */
  readonly registryUrl?: string
  readonly fetch?: DirectoryFetch
  readonly timeoutMs?: number
  /** Defaults to `Date.now`; overridable so tests can move the clock. */
  readonly now?: () => number
  /**
   * Called when an explicit `--trust` entry and the CA-derived cache disagree
   * about the same node's key (§8.2: explicit wins, but silently is not an
   * option for a conflict this sharp).
   */
  readonly onAudit?: CertificateDirectoryAuditSink
  /** Receives contained observer/polling failures without changing refresh state. */
  readonly onError?: CertificateDirectoryErrorSink
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * `CertificateDirectory` — see the module header for the contract this keeps.
 */
export class CertificateDirectory
  implements PublicKeyDirectory, HandshakeCredentialDirectory
{
  readonly #anchors: ReturnType<typeof parseTrustAnchors>
  readonly #registryUrl: string | undefined
  readonly #fetch: DirectoryFetch
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #onAudit: CertificateDirectoryAuditSink | undefined
  readonly #onError: CertificateDirectoryErrorSink | undefined

  readonly #explicit = new Map<string, string>()
  /** The latest complete `/v0/agents` snapshot, used for future admission. */
  #caCache = new Map<string, CachedCertificate>()
  /**
   * Last CA-verified facts, retained after a registry lease disappears.
   *
   * The registry is a discovery courier, not a revocation authority. Keeping
   * these facts lets a later signed RL (or the certificate clock) terminate a
   * connection that was admitted before a temporary directory omission.
   */
  #certificateFacts = new Map<string, CertificateFact>()
  #revocationList: RevocationList | null = null
  #effective = new Map<string, string>()
  /** Fingerprint → exact credential awaiting one successful sink delivery. */
  #pendingPermanentInvalidations = new Map<
    string,
    CertificateCredentialInvalidation
  >()
  /** Evidence already delivered, keyed by fingerprint rather than node name. */
  #deliveredPermanentInvalidations = new Set<string>()
  #refreshing: Promise<CertificateDirectoryRefresh> | null = null
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #onRefresh: CertificateDirectoryRefreshSink | undefined

  constructor(options: CertificateDirectoryOptions) {
    this.#anchors = parseTrustAnchors(options.caCertificatePem, '--trust-ca')
    this.#registryUrl = options.registryUrl?.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#now = options.now ?? (() => Date.now())
    this.#onAudit = options.onAudit
    this.#onError = options.onError
    for (const [node, key] of options.trusted ?? [])
      this.#explicit.set(node, key)
    this.#rebuildEffective()
  }

  /** Synchronous, zero IO — see the module header on why that is load-bearing. */
  publicKeyOf(node: string): string | null {
    return this.#effective.get(node) ?? null
  }

  /** Publish or replace an explicit (`--trust`-equivalent) entry. */
  put(node: string, publicKey: string): void {
    this.#explicit.set(node, publicKey)
    this.#rebuildEffective()
  }

  delete(node: string): void {
    this.#explicit.delete(node)
    this.#rebuildEffective()
  }

  /** Whether the revocation list currently backing the CA-derived cache is fresh. */
  get revocationListFresh(): boolean {
    return this.#rlFresh()
  }

  /** Number of nodes `publicKeyOf` can currently answer for. */
  get size(): number {
    return this.#effective.size
  }

  /** A snapshot of everything `publicKeyOf` can currently answer — S-2's gauge. */
  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.#effective)
  }

  /**
   * Resolve the exact credential named by a signed transport handshake.
   *
   * An explicit entry is local operator authority and therefore wins even
   * when the peer also carries a certificate selector. Three properties of
   * that branch are load-bearing, and each one — quietly changed — turns into
   * a legitimate peer being closed with 4003.
   *
   * ① **The explicit key is served without a single CA-side check.** No RL
   *    freshness test, no `notBefore`/`notAfter` test, no revocation lookup.
   *    An operator who typed `--trust` already trusts that key
   *    unconditionally, and the way to withdraw it is to delete the entry,
   *    not to have the CA publish an RL.
   *
   * ② It follows that **a revoked or an expired fingerprint is still a valid
   *    proof selector.** The selector only says which bytes the peer's second
   *    proof was signed over (`certificate/<fingerprint>`); it takes no part
   *    in admission. The connection's effective credential stays
   *    `explicit/<node>`, so `closePeerCredentials([{node, 'certificate',
   *    F}])` will not close it. That is deliberate — it is the other half
   *    of ①, not an oversight.
   *
   * ③ `selector === node` means "the peer is claiming the explicit
   *    credential". This signature carries no `source` argument, so that
   *    equivalence rests entirely on the two key spaces being disjoint:
   *    `#explicit` is keyed by node segments (`@qianmo/protocol`'s
   *    `SEGMENT_PATTERN`, `/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/`), while
   *    `#certificateFacts` is keyed by `fingerprint256` — upper-case hex with
   *    colons, `BC:3C:86:...`. Neither a colon nor an upper-case letter is a
   *    legal segment character, so no string can be both. Read this again
   *    before widening either key space.
   *
   * The one check a certificate selector does get is **contradiction, not
   * absence**. A retained fact binding this fingerprint to another node, or
   * to a key other than the explicit one, is refused — a conflict that sharp
   * is a configuration error worth surfacing. *No* retained fact is
   * **accepted**, because that is §6.4's degrade: a resident restarted while
   * the registry is unreachable has never pulled a `/v0/agents` row for
   * anyone, and refusing a peer that is right there on the `--trust` list
   * would turn "fail-closed 到 `--trust`" into fail-shut. Nor was the lookup
   * ever a security boundary — a peer holding the explicit private key can
   * take branch ③ instead and obtain a byte-identical effective credential;
   * both paths demand a signature from that same key.
   *
   * With no explicit entry the pure CA path applies, and it is strict in
   * every way the explicit branch is not: the selector must name a retained,
   * currently valid, unrevoked certificate for this node, and the RL must be
   * fresh. The method is intentionally synchronous, like {@link publicKeyOf}.
   */
  handshakeCredentialOf(
    node: string,
    selector: string | undefined,
  ): ResolvedHandshakeCredential | null {
    const explicit = this.#explicit.get(node)
    if (explicit !== undefined) {
      // ③: a selector equal to the node name is the peer claiming
      // `explicit/<node>` itself — exactly what the tail of this branch
      // already returns, with no separate proof identity to report.
      if (selector !== undefined && selector !== node) {
        const claim = this.#certificateFacts.get(selector)
        if (
          claim !== undefined &&
          (claim.node !== node || claim.publicKey !== explicit)
        ) {
          return null
        }
        return {
          publicKey: explicit,
          source: EXPLICIT_CREDENTIAL_SOURCE,
          id: node,
          proofCredential: {
            source: CERTIFICATE_CREDENTIAL_SOURCE,
            id: selector,
          },
        }
      }
      return {
        publicKey: explicit,
        source: EXPLICIT_CREDENTIAL_SOURCE,
        id: node,
      }
    }
    if (selector === undefined || !this.#rlFresh()) return null
    const fact = this.#certificateFacts.get(selector)
    if (fact === undefined || fact.node !== node) return null
    const now = this.#now()
    if (now < fact.notBefore || now >= fact.notAfter) return null
    if (this.#revokedFingerprints().has(selector)) return null
    return {
      publicKey: fact.publicKey,
      source: CERTIFICATE_CREDENTIAL_SOURCE,
      id: selector,
    }
  }

  /** Start polling the registry on its own timer. No-op with no `registryUrl`. */
  startPolling(intervalMs: number): void {
    if (this.#registryUrl === undefined || this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      // A timer has no caller to observe a rejection. Network calls normally
      // fail closed inside `#getJson`, but retain this boundary for injected
      // clocks/fetches and future refresh work.
      void this.refresh().catch(error => {
        this.#reportError('polling_refresh', error)
      })
    }, intervalMs)
    this.#pollTimer.unref?.()
  }

  stopPolling(): void {
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer)
    this.#pollTimer = null
  }

  /**
   * Install the one runtime consumer of refresh invalidations.
   *
   * The listener is deliberately registered after construction: a resident
   * resolves the initial directory before it creates its transport, then hands
   * future polling results to that transport. Replacing it is safe because
   * this class owns only the directory, never the connection holder.
   */
  setRefreshSink(sink: CertificateDirectoryRefreshSink | undefined): void {
    this.#onRefresh = sink
  }

  /**
   * Fetch the registry's agents and revocation list, verify what can be
   * verified, and rebuild the map {@link publicKeyOf} reads. Safe to call
   * concurrently — overlapping calls share one in-flight fetch rather than
   * racing two.
   */
  async refresh(): Promise<CertificateDirectoryRefresh> {
    if (this.#refreshing !== null) return this.#refreshing
    const run = this.#doRefresh()
      .then(result => this.#notifyRefresh(result))
      .finally(() => {
        this.#refreshing = null
      })
    this.#refreshing = run
    return run
  }

  async #doRefresh(): Promise<CertificateDirectoryRefresh> {
    const registryUrl = this.#registryUrl
    if (registryUrl === undefined) {
      return this.#rebuildEffective()
    }

    await this.#refreshRevocationList(registryUrl)
    await this.#refreshCertificates(registryUrl)
    return this.#rebuildEffective()
  }

  async #getJson(registryUrl: string, path: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.#fetch(`${registryUrl}${path}`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      return undefined
    }
    if (!response.ok) return undefined
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }

  /**
   * Refresh the cached RL. A failed fetch, a 404 (nothing published yet) or a
   * bad signature all leave the previous cache untouched — §6.4's "拉不到 |
   * 用缓存的那份" is the same code path as "nothing has changed".
   */
  async #refreshRevocationList(registryUrl: string): Promise<void> {
    const body = await this.#getJson(registryUrl, '/v0/revocation-list')
    if (body === undefined) return
    const verified = verifyRevocationListByAnchors(
      this.#anchors,
      body,
      this.#now(),
    )
    if (verified !== null) this.#acceptRevocationList(verified)
  }

  #acceptRevocationList(candidate: RevocationList): void {
    const current = this.#revocationList
    if (current === null) {
      this.#revocationList = candidate
      return
    }
    if (candidate.issuedAt < current.issuedAt) {
      this.#reportError(
        'revocation_list',
        new Error('refusing a signed revocation-list rollback'),
      )
      return
    }
    if (candidate.issuedAt === current.issuedAt) {
      if (JSON.stringify(candidate) !== JSON.stringify(current)) {
        this.#reportError(
          'revocation_list',
          new Error('refusing conflicting revocation lists with one issuedAt'),
        )
      }
      return
    }
    const candidateFingerprints = new Set(
      candidate.revoked.map(entry => entry.fingerprint256),
    )
    if (
      current.revoked.some(
        entry => !candidateFingerprints.has(entry.fingerprint256),
      )
    ) {
      this.#reportError(
        'revocation_list',
        new Error('refusing a revocation list that removes prior entries'),
      )
      return
    }
    this.#revocationList = candidate
  }

  async #refreshCertificates(registryUrl: string): Promise<void> {
    const body = await this.#getJson(registryUrl, '/v0/agents')
    if (body === undefined || typeof body !== 'object' || body === null) {
      // Fetch failed outright — keep whatever the last successful refresh
      // produced rather than emptying a cache that may still be correct.
      return
    }
    const agents = (body as Record<string, unknown>)['agents']
    if (!Array.isArray(agents)) return

    const fresh = new Map<string, CachedCertificate>()
    for (const raw of agents) {
      const evaluated = this.#evaluate(raw)
      if (evaluated !== null) {
        fresh.set(evaluated.node, evaluated.certificate)
        this.#certificateFacts.set(evaluated.certificate.fingerprint256, {
          node: evaluated.node,
          ...evaluated.certificate,
        })
      }
    }
    this.#caCache = fresh
  }

  #revokedFingerprints(): ReadonlySet<string> {
    if (!this.#rlFresh()) return new Set()
    return new Set(
      this.#revocationList?.revoked.map(entry => entry.fingerprint256),
    )
  }

  #rlFresh(): boolean {
    const list = this.#revocationList
    return list !== null && this.#now() < list.nextUpdate
  }

  /**
   * One agent record, checked all the way through §4.2/§5.2/F-2/§6.4. `null`
   * covers every rejection reason at once — the caller only needs "in or
   * out", and each reason is a one-line comment here rather than a second
   * taxonomy nobody reads.
   */
  #evaluate(
    raw: unknown,
  ): { readonly node: string; readonly certificate: CachedCertificate } | null {
    if (typeof raw !== 'object' || raw === null) return null
    const record = raw as AgentBody
    if (typeof record.certificate !== 'string') return null

    const address = parseAddress(record.address)
    if (address === null) return null

    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(record.certificate)
    } catch {
      return null // not even a parseable certificate
    }
    const binding = parseNodeCertificateBinding(certificate.subjectAltName)
    if (binding === null || binding.node !== address.node) return null
    if (
      typeof record.publicKey === 'string' &&
      record.publicKey !== binding.publicKey
    ) {
      return null // nodekey does not match the record's own declared key
    }
    // F-2: this is the entire "was it forged" question, and it needs nothing
    // but the CA roots. The window it returns already includes the issuing
    // root's own validity, which is what the TLS layer enforces as well.
    const validity = anchoredValidity(this.#anchors, certificate)
    if (validity === null) return null

    return {
      node: binding.node,
      certificate: {
        publicKey: binding.publicKey,
        fingerprint256: certificate.fingerprint256,
        notBefore: validity.notBefore,
        notAfter: validity.notAfter,
      },
    }
  }

  /**
   * Rebuild the map {@link publicKeyOf} reads. The only method allowed to
   * touch `#effective` — every mutation goes through here so the fail-closed
   * rule (§6.4) and the explicit-overrides-CA rule (§8.2) are each written
   * exactly once.
   */
  #rebuildEffective(): CertificateDirectoryRefresh {
    const previous = this.#effective
    let next: Map<string, string>
    if (!this.#rlFresh()) {
      // Fail-closed: the CA-derived cache is not trustworthy right now
      // (stale or never-fetched RL), so it is not consulted at all — only
      // the explicit entries an operator typed remain.
      next = new Map(this.#explicit)
    } else {
      const revoked = this.#revokedFingerprints()
      const now = this.#now()
      next = new Map<string, string>()
      for (const [node, entry] of this.#caCache) {
        // `agents` can be unavailable while a newer RL is available. The
        // cache is therefore only a source of certificate bytes, never an
        // assertion that those bytes remain valid or unrevoked.
        if (
          now >= entry.notBefore &&
          now < entry.notAfter &&
          !revoked.has(entry.fingerprint256)
        ) {
          next.set(node, entry.publicKey)
        }
      }
      for (const [node, key] of this.#explicit) {
        const derived = next.get(node)
        if (derived !== undefined && derived !== key) {
          this.#audit({
            node,
            reason:
              '--trust overrides a different CA-derived key for the same node (§8.2)',
          })
        }
        next.set(node, key)
      }
    }
    this.#effective = next
    const now = this.#now()
    const revoked = this.#revokedFingerprints()
    for (const [fingerprint, entry] of this.#certificateFacts) {
      if (
        now >= entry.notAfter ||
        (this.#rlFresh() && revoked.has(entry.fingerprint256))
      ) {
        if (!this.#deliveredPermanentInvalidations.has(fingerprint)) {
          this.#pendingPermanentInvalidations.set(fingerprint, {
            node: entry.node,
            source: CERTIFICATE_CREDENTIAL_SOURCE,
            id: fingerprint,
          })
        }
      }
    }
    const permanentCredentials = [
      ...this.#pendingPermanentInvalidations.values(),
    ]
    return {
      directoryRemoved: [...previous.keys()].filter(node => !next.has(node)),
      permanentlyInvalidated: [
        ...new Set(permanentCredentials.map(entry => entry.node)),
      ],
      permanentlyInvalidatedCredentials: permanentCredentials,
    }
  }

  /** Notify one connection holder without allowing it to poison refresh state. */
  #notifyRefresh(
    result: CertificateDirectoryRefresh,
  ): CertificateDirectoryRefresh {
    const sink = this.#onRefresh
    if (sink === undefined) return result
    try {
      sink(result)
      for (const credential of result.permanentlyInvalidatedCredentials) {
        this.#pendingPermanentInvalidations.delete(credential.id)
        this.#deliveredPermanentInvalidations.add(credential.id)
      }
    } catch (error) {
      // Do not reject an otherwise successful refresh. Pending permanent
      // events deliberately survive, so the next poll retries this delivery.
      this.#reportError('refresh_sink', error)
    }
    return result
  }

  #audit(event: CertificateDirectoryAuditEvent): void {
    try {
      this.#onAudit?.(event)
    } catch (error) {
      this.#reportError('audit_sink', error)
    }
  }

  #reportError(
    phase: CertificateDirectoryErrorEvent['phase'],
    error: unknown,
  ): void {
    try {
      this.#onError?.({
        phase,
        reason: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // A diagnostic sink is never allowed to make a polling timer reject.
    }
  }
}

/**
 * The one check no `CertificateDirectory` instance can make for itself:
 * whether *this node's own* certificate actually names *this node's own*
 * Ed25519 identity (§12.1 K-2: "nodekey 与其 identity 文件里的公钥一致").
 *
 * `CertificateDirectory` verifies peers' certificates against a CA root; it
 * has no way to know what a peer's local identity file says, and it should
 * not — that would mean every node needing filesystem access to every other
 * node. This check is different in kind: it is a *local* consistency check a
 * node runs on its own `--cert` at startup, before it ever talks to anyone.
 * A node whose certificate was issued for a different key than the one it
 * actually holds cannot use that certificate for anything (its own
 * signatures will never match its own SAN), so refusing to start is strictly
 * better than starting broken.
 *
 * Returns the parsed binding on success; throws — never returns `null` —
 * because every call site here is a startup-time refusal, not a query.
 */
export function assertOwnCertificateMatchesIdentity(
  certificatePem: string,
  node: string,
  ownPublicKey: string,
): NodeCertificateBinding {
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(certificatePem)
  } catch (error) {
    throw new Error(
      `--cert does not parse as a certificate: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const binding = parseNodeCertificateBinding(certificate.subjectAltName)
  if (binding === null) {
    throw new Error(
      '--cert does not carry a valid node certificate binding (key-distribution.md §4.2)',
    )
  }
  if (binding.node !== node) {
    throw new Error(
      `--cert names node ${binding.node}, but this node is ${node}`,
    )
  }
  if (binding.publicKey !== ownPublicKey) {
    // This is the K-2 check, and the one negative case among the four that is
    // NOT about a peer: it fires when an operator hands a node the wrong
    // file — a certificate genuinely signed by the CA, for a real node, just
    // not this one's identity.
    throw new Error(
      `--cert names Ed25519 key ${binding.publicKey}, but this node's ` +
        `identity key is ${ownPublicKey} (nodekey does not match identity)`,
    )
  }
  return binding
}
