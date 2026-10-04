// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The port through which authorization reaches the inbound gate.
 *
 * The routing layer decides *when* a message is authorized — protocol.md
 * §10.1's rule S-2 fixes that: after the envelope is structurally sound and
 * **before anything with a cost**. It does not decide *how*: that needs keys, a
 * signature scheme and a replay store, all of which live in
 * `@qianmo/capability`.
 *
 * Keeping the port here and the implementation there means this package still
 * imports nothing but `@qianmo/protocol`, and a node that has no capability
 * story yet still gets loop detection and rate limiting rather than nothing.
 */

import type {
  CapabilityLevel,
  NoticeTrust,
  ProtocolErrorCode,
  QianmoMessage,
} from '@qianmo/protocol'

/** What a gate concluded about one message. */
export type CapabilityDecision =
  | {
      readonly ok: true
      /**
       * The level this message carries — a **ceiling** on what it may cause,
       * never a grant added to what the local agent already has (rule S-3).
       */
      readonly level: CapabilityLevel
      /** Issuing node, when a token was presented. */
      readonly issuer?: string
      /**
       * The provenance tier this message earned, decided by the gate and
       * **not** re-derivable downstream (issue #28).
       *
       * Required rather than optional on purpose: the field exists so that a
       * layer which renders the tier does not have to reconstruct it from
       * `issuer` plus a trust list it has no business holding. An optional
       * field would let a gate stay silent and leave every consumer to guess,
       * which is the shape the bug had.
       */
      readonly trust: NoticeTrust
    }
  | {
      readonly ok: false
      /** `E_CAP_INVALID` or `E_CAP_INSUFFICIENT` (protocol.md §11). */
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

/** Verifies the capability a message presents, if any. */
export interface CapabilityGate {
  check(message: QianmoMessage, now: number): CapabilityDecision
}
