// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/tunnel` — the connection a lease gets, for as long as it has one
 * (P5.3).
 *
 * Read `contracts.ts` first: it says what this is **not** (a new crypto layer —
 * charter N-3 keeps M0 on TLS + PSK) before saying what it is. The content of
 * "on demand" is that nothing listens before the negotiation and nothing
 * listens after it, and the three teardown paths in `host.ts` are what make the
 * second half true even when the borrower never says goodbye.
 */

export {
  TeardownReason,
  TunnelAuditLog,
  TunnelEventType,
  type TunnelAuditSink,
  type TunnelEvent,
} from './contracts.js'

export {
  TunnelClient,
  type TunnelClientOptions,
} from './client.js'

export {
  DEFAULT_IDLE_TIMEOUT_SEC,
  TunnelHost,
  timerScheduler,
  type CancelTimer,
  type Scheduler,
  type TunnelAddress,
  type TunnelHostOptions,
} from './host.js'
