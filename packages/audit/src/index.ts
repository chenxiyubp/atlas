// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/audit` — the trail, and the queries that make it worth keeping
 * (P7.2).
 *
 * One append-only file, one record shape, every layer writing into it. The
 * per-package audit rings stay where they are: those are for a running process,
 * this is for the question asked three days later, and the question is always
 * the same one — *take this task and show me everything that happened to it,
 * including what was refused*.
 *
 * `trail.ts` is careful about what "cannot be changed" means here: the writer
 * genuinely cannot modify (append-only fd, no method that seeks or deletes),
 * an outside edit is genuinely detectable (hash chain), and an outside edit is
 * **not prevented but is detected with an off-host witness, except inside its
 * anchoring window**. This package supplies the local half; the boundary and
 * deployment conditions live in `docs/dev/audit-witness.md` §7.
 */

export {
  AuditSource,
  GENESIS_PREVIOUS,
  canonicalize,
  digestOf,
  traceIdSegment,
  type AuditInput,
  type AuditRecord,
} from './record.js'

export {
  AuditTrail,
  readTrail,
  type TrailIntegrityIssue,
  type TrailReadResult,
} from './trail.js'

export {
  formatChain,
  queryTrail,
  reconstructChain,
  type MessageChain,
  type TrailQuery,
} from './query.js'
