// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/memory` — the storage layer for charter §1.5's three memory layers.
 *
 * Scope note: this package stores and schematises. Recall-and-inject (检索唤醒)
 * is P3.3's task; what lives here is the guarantee it depends on — that every
 * record carries a citable id, a source, a write time and a retirement mark, so
 * AC-4's "标注记忆条目来源 ID 与写入时间" is a lookup rather than a hope.
 *
 * The relationship to the base's own memory system, and why it is a shared file
 * format rather than a type mapping or a second store, is stated in
 * `mapping.ts`.
 */

export {
  archiveWorkingMemory,
  type ArchiveDecision,
  type ArchiveOptions,
  type ArchiveResult,
} from './archive.js'
export {
  formatCitation,
  isRecallable,
  MEMORY_LAYERS,
  MEMORY_RETIREMENT_KINDS,
  MEMORY_SOURCE_KINDS,
  MemoryValidationError,
  type BaselineScope,
  type MemoryEntry,
  type MemoryLayer,
  type MemoryRetirement,
  type MemoryRetirementKind,
  type MemoryScope,
  type MemorySource,
  type MemorySourceKind,
  type MemoryWriteInput,
  type ProjectScope,
  type WorkingScope,
} from './entry.js'
export {
  DEFAULT_EVENT_CAPACITY,
  MemoryEventRecorder,
  MemoryEventType,
  type MemoryEvent,
  type MemoryEventDetail,
  type MemoryEventSink,
} from './events.js'
export { MemoryParseError, parseEntry, serializeEntry } from './frontmatter.js'
export { BASE_MEMORY_TYPE_BY_LAYER } from './mapping.js'
export { defaultMemoryRoot, QIANMO_MEMORY_DIRNAME, scopeDir } from './paths.js'
export {
  FileMemoryStore,
  MemoryStoreError,
  type MemoryQuery,
  type MemoryStoreOptions,
} from './store.js'
