// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/router` — the routing layer of the Qianmo network (P4.2).
 *
 * Three mechanisms, and the reason they share a package is that they are the
 * three decisions a node makes about a message without reading it:
 *
 * 1. **loop detection at handler granularity** (`loop.ts`) — `(handler
 *    address, taskId)`, first revisit cut, `LIMITS.maxHops` only as the
 *    backstop behind it (D-2, protocol.md §6.1);
 * 2. **two rate limits that must never be conflated** (`rate.ts`) — the
 *    protocol layer's per-sender inbound budget and the runtime layer's
 *    per-sender-per-target token bucket, with separate ceilings, keys, codes
 *    and audit event types (charter AC-3, protocol.md §6.4);
 * 3. **the audit trail both of them owe** (`audit.ts`) — a cut that leaves no
 *    event carrying the full message chain does not satisfy AC-3, however
 *    correctly it cuts.
 *
 * The second-level dedup table AC-3 also names is **not** here: it already
 * exists as `@qianmo/transport`'s `DedupTable`, keyed on `msgId` then
 * `fingerprint` and expiring on the delivery deadline exactly as §7.2 requires.
 * Reimplementing it in this package would give the network two dedup tables
 * with one contract between them, which is worse than having one in a slightly
 * surprising place.
 */

export {
  DEFAULT_ROUTER_AUDIT_CAPACITY,
  RouterAuditLog,
  RouterEventType,
  chainDetail,
  type RouterAuditEvent,
  type RouterAuditSink,
} from './audit.js'

export type { CapabilityDecision, CapabilityGate } from './capability.js'

export {
  DEFAULT_LOOP_CAPACITY,
  LoopGuard,
  LoopVerdict,
  type LoopGuardOptions,
} from './loop.js'

export {
  DEFAULT_MAX_RATE_KEYS,
  InboundBudget,
  NotifyBudget,
  RUNTIME_RATE,
  RuntimeThrottle,
  TokenBucket,
  type InboundBudgetOptions,
  type NotifyBudgetOptions,
  type RuntimeThrottleOptions,
} from './rate.js'

export {
  E_RUNTIME_THROTTLED,
  NodeRouter,
  type InboundVerdict,
  type NodeRouterOptions,
  type OutboundVerdict,
  type RouterRejectionCode,
  type RouterVerdict,
} from './router.js'
