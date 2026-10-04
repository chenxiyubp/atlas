// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/registry` — where agents announce themselves and find each other.
 *
 * Ships an in-process table, an optional crash-safe file backing so the table
 * and the published revocation list survive a restart, and a thin HTTP v0
 * surface over `Bun.serve` whose writes can be gated by a write token (P15.8);
 * no third-party dependencies.
 */

export { ManualClock, systemClock, type Clock } from './clock.js'

export {
  AgentStatus,
  DEFAULT_RENEW_INTERVAL_MS,
  DEFAULT_TTL_MS,
  InMemoryRegistry,
  MAX_CAPABILITIES,
  MAX_CERTIFICATE_LENGTH,
  REGISTRY_SNAPSHOT_VERSION,
  RegistryErrorCode,
  isSignedRevocationListShape,
  isValidEndpoint,
  isValidPublicKey,
  renewIntervalFor,
  type AgentRecord,
  type DeclaredStatus,
  type RegisterInput,
  type RegisterResult,
  type RegistryAuditEvent,
  type RegistryAuditSink,
  type RegistryOptions,
} from './registry.js'

export {
  FileRegistryStore,
  FileRevocationListStore,
  defaultRegistryStatePath,
  revocationListStatePathFor,
  type RegistryStore,
} from './store.js'

export { readRegistryWriteTokenFile } from './token.js'

export {
  API_PREFIX,
  createRegistryHandler,
  startRegistryServer,
  type RegistryServerHandle,
  type RegistryServerOptions,
} from './http.js'
