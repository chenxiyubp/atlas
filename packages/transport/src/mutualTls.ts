// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The mTLS admission fence (key-distribution.md §7.1 layer L0), as **one**
 * object neither half of a deployment can build only part of.
 *
 * ## Why this is a function and not three fields on the options
 *
 * F-10 is a landmine with no signpost: a listener given `ca` but not
 * `requestCert` stops admitting dialers, and the failure surfaces as "suddenly
 * nobody can connect" with an error that never mentions `ca`. F-7 is the
 * matching positive: the three together really do keep a dialer without a
 * CA-issued certificate out at the TLS layer, before a byte of this package's
 * grammar runs.
 *
 * A configuration that can be half-applied will be half-applied — so the three
 * settings are not three settings here. {@link mutualTlsServerOptions} takes
 * the materials and emits all three or nothing; there is no shape a caller can
 * hand it that produces the broken middle.
 *
 * ## What this fence does and does not prove
 *
 * Less than its name suggests, and the gap is measured rather than assumed.
 *
 * On Bun 1.3.13 the listener enforces that a dialer **presented** a
 * certificate; it does not check that the certificate chains to `ca`. A leaf
 * from an unrelated CA gets in, and so does a bare self-signed one — verified
 * across all four shapes `ca` accepts and on both the `fetch` and WebSocket
 * paths (recorded in key-distribution.md §2's 2026-08-19 addendum, and pinned
 * by a test in `mtls.test.ts` that will go red the day Bun tightens it).
 *
 * So this answers "did anything at all show up with a certificate", which
 * still turns away every scan and every misconfigured peer, and is worth
 * having for that. It is **not** an admission fence and must not be recorded
 * as one.
 *
 * It could not say *which node* is on the other end in any case: F-8, measured
 * — the application layer can read no peer certificate at all, on `fetch`
 * handlers and `ServerWebSocket` alike. Node identity lives in the handshake
 * (`handshake.ts`) and only there, which is exactly why the design put it
 * there instead of here.
 *
 * The dialer half has its own gap, in the opposite direction: on the `ws` path
 * Bun *does* verify the chain but **not the hostname**, and
 * `checkServerIdentity` is never invoked at all (measured the same day, same
 * addendum). So the dialer learns "this endpoint holds a certificate our CA
 * signed" and nothing about which machine or which node that is.
 *
 * Both gaps land on the same conclusion, which is the one the design already
 * reached from F-8 alone: **"which node is that" is the two-way handshake
 * signature's question, and it has no second answer.**
 */

import type { TLSOptions } from 'bun'
import type { ClientTlsOptions } from './client.js'

/**
 * One node's TLS materials: its own certificate and key, plus the CA root that
 * every peer's certificate is checked against.
 *
 * All three are required. A caller holding only some of them does not have a
 * degraded fence, it has no fence, and should pass no TLS at all rather than
 * reaching for this.
 */
export interface MutualTlsMaterials {
  /** PEM certificate this node presents — `<node>.tls.crt` (§4.1). */
  readonly cert: string
  /** PEM private key backing it. EC, because F-5 rules out Ed25519 leaves. */
  readonly key: string
  /**
   * PEM CA root, the one thing distributed out of band (§5.1). Two roots one
   * after another during a rotation overlap (§3.3); Bun uses every one.
   */
  readonly ca: string
}

/**
 * Listener-side mTLS: present a certificate, demand one, and check it against
 * the CA root — the F-7 triple, indivisible.
 */
export function mutualTlsServerOptions(
  materials: MutualTlsMaterials,
): TLSOptions {
  return {
    cert: materials.cert,
    key: materials.key,
    ca: materials.ca,
    // These two are what makes `ca` mean "admission" rather than "mystery
    // outage" (F-10). They are written here, together, once.
    requestCert: true,
    rejectUnauthorized: true,
  }
}

/**
 * Dialer-side mTLS: present the same certificate the listener would, and check
 * the listener's against the same root.
 *
 * `rejectUnauthorized` is left at its default rather than set: the default is
 * already "verify", and writing it explicitly invites the next reader to
 * imagine there is a supported way to write `false` here. There is not — see
 * `ClientTlsOptions`.
 */
export function mutualTlsClientOptions(
  materials: MutualTlsMaterials,
): ClientTlsOptions {
  return {
    cert: materials.cert,
    key: materials.key,
    ca: materials.ca,
  }
}
