// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The record shape shared by all three memory layers, and the rules that make a
 * record admissible.
 *
 * TWO TIME AXES, AND WHY BOTH ARE MANDATORY
 *
 * Every entry carries four timestamps in two independent pairs, following
 * Graphiti's bi-temporal model (decided in `docs/dev/selection-m0.md` §4,
 * "记忆字段"):
 *
 *   event axis    `validAt` / `invalidAt`   — when the fact was true *in the world*
 *   ingest axis   `createdAt` / `expiredAt` — when this store learned it / retired it
 *
 * They move independently, and the sedimentation task (`archive.ts`) is the
 * clearest case: promoting a working-memory entry into project memory mints a
 * new record whose `createdAt` is *now* (the project table learned it now) but
 * whose `validAt` is inherited unchanged (the fact did not become true again).
 * Collapsing the two into one "timestamp" would either backdate the promotion
 * or forge the fact's age; AC-4 requires the answer to cite a write time, so
 * neither is acceptable.
 *
 * NOTHING IS EVER DELETED
 *
 * Retirement is a mark, not a removal: `expiredAt` plus a {@link MemoryRetirement}
 * are written onto the record and the record stays on disk. Recall filters
 * retired entries out; an audit query asks for them explicitly. This is the
 * "只标记不删除" rule from the same decision row, and it is also what makes
 * charter §1.5's "可人工废止" auditable rather than destructive.
 *
 * A note on the mem0 trap recorded alongside that decision: mem0 v3 (2026-04)
 * removed its ADD/UPDATE/DELETE decision flow in favour of append-only. Designing
 * against its older documentation would produce a store that rewrites history in
 * place — the exact opposite of what is wanted here.
 */

/** The three layers of charter §1.5. Each is a separate table, keyed differently. */
export const MEMORY_LAYERS = ['working', 'project', 'baseline'] as const

export type MemoryLayer = (typeof MEMORY_LAYERS)[number]

/**
 * Where an entry came from. Mandatory, and mandatory to carry through recall:
 * D-6 settled AC-4's provenance mechanism as "small-scale full injection plus a
 * tool-layer citation requirement", which only works if the retrieved record
 * still knows who wrote it. An entry with no usable source is, by AC-4's own
 * negative test, indistinguishable from a hallucinated one.
 */
export const MEMORY_SOURCE_KINDS = [
  'session',
  'agent',
  'user',
  'archive',
  'import',
] as const

export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number]

export type MemorySource = {
  readonly kind: MemorySourceKind
  readonly id: string
}

/**
 * Working memory is keyed by task: the whole point of the layer is that it dies
 * (or sediments) with the task.
 */
export type WorkingScope = {
  readonly layer: 'working'
  readonly projectKey: string
  readonly taskId: string
}

/** Project memory is keyed by project and outlives every task inside it. */
export type ProjectScope = {
  readonly layer: 'project'
  readonly projectKey: string
}

/**
 * Baseline memory is account-level, bucketed by period. The period key is what
 * turns charter §1.5's "基线与周期档案" into something enumerable — usage
 * baselines and long-term trends are only readable as a series.
 */
export type BaselineScope = {
  readonly layer: 'baseline'
  readonly period: string
}

export type MemoryScope = WorkingScope | ProjectScope | BaselineScope

/**
 * Why an entry left recall. `revoked` is a human (or policy) judgement that the
 * record should no longer be used; `archived` means the sedimentation task
 * promoted its content into a higher layer and sealed the original.
 */
export const MEMORY_RETIREMENT_KINDS = ['revoked', 'archived'] as const

export type MemoryRetirementKind = (typeof MEMORY_RETIREMENT_KINDS)[number]

export type MemoryRetirement = {
  readonly kind: MemoryRetirementKind
  readonly reason: string
  readonly by: string
}

export type MemoryEntry = {
  /** Stable citation handle. Appears verbatim in AC-4 answers. */
  readonly id: string
  readonly scope: MemoryScope
  readonly title: string
  /** One line. Deterministic recall matches against this before the body. */
  readonly summary: string
  readonly body: string
  /** Normalised to lower case on write so filtering never depends on casing. */
  readonly tags: readonly string[]
  readonly source: MemorySource
  /** Ingest axis: when this record entered this table. Never rewritten. */
  readonly createdAt: string
  /** Ingest axis: when this record was retired. `null` while it is live. */
  readonly expiredAt: string | null
  /** Event axis: when the fact became true. */
  readonly validAt: string
  /** Event axis: when the fact stopped being true. `null` while it still holds. */
  readonly invalidAt: string | null
  /** Non-null exactly when `expiredAt` is non-null. */
  readonly retirement: MemoryRetirement | null
  /** Ids of the entries this one was distilled from (sedimentation provenance). */
  readonly derivedFrom: readonly string[]
}

export type MemoryWriteInput = {
  readonly scope: MemoryScope
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly source: MemorySource
  readonly tags?: readonly string[]
  readonly validAt?: Date
  readonly invalidAt?: Date | null
  readonly derivedFrom?: readonly string[]
}

/** Thrown when a write would put an inadmissible record on disk. */
export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryValidationError'
  }
}

/**
 * Path segments are attacker-reachable: a project key or task id can arrive in
 * a cross-node message, and charter §6.1 T-7 names exactly that as an injection
 * surface. So the charset is a whitelist, and the leading character may not be
 * a dot — which is what rules out `.`, `..` and every traversal built from them.
 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const TAG = /^[a-z0-9][a-z0-9._:-]{0,47}$/

const MAX_TITLE_LENGTH = 200
const MAX_SUMMARY_LENGTH = 500

export function assertKeySegment(label: string, value: string): void {
  if (!KEY_SEGMENT.test(value)) {
    throw new MemoryValidationError(
      `${label} must match ${String(KEY_SEGMENT)} (got ${JSON.stringify(value)})`,
    )
  }
}

function requireNonEmpty(label: string, value: string, max: number): void {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new MemoryValidationError(
      `${label} is mandatory and must not be blank`,
    )
  }
  if (trimmed.length > max) {
    throw new MemoryValidationError(
      `${label} must be at most ${max} characters (got ${trimmed.length})`,
    )
  }
}

/** Validates the scope and returns it unchanged, narrowed. */
export function validateScope(scope: MemoryScope): MemoryScope {
  switch (scope.layer) {
    case 'working':
      assertKeySegment('scope.projectKey', scope.projectKey)
      assertKeySegment('scope.taskId', scope.taskId)
      return scope
    case 'project':
      assertKeySegment('scope.projectKey', scope.projectKey)
      return scope
    case 'baseline':
      assertKeySegment('scope.period', scope.period)
      return scope
  }
}

function normaliseTags(tags: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>()
  for (const raw of tags ?? []) {
    const tag = raw.trim().toLowerCase()
    if (!TAG.test(tag)) {
      throw new MemoryValidationError(
        `tag must match ${String(TAG)} after lower-casing (got ${JSON.stringify(raw)})`,
      )
    }
    seen.add(tag)
  }
  // Sorted so two writes with the same tag set serialise identically.
  return [...seen].sort()
}

function isoOrThrow(label: string, date: Date): string {
  const time = date.getTime()
  if (!Number.isFinite(time)) {
    throw new MemoryValidationError(`${label} is not a valid Date`)
  }
  return new Date(time).toISOString()
}

/**
 * Turn a caller's write request into the record that will be persisted.
 *
 * Everything the roadmap calls a 强制字段 — source id, write time, tags, the
 * retirement mark — is either supplied and checked here or filled in here, so
 * there is no code path that produces an entry missing one.
 */
export function buildEntry(
  input: MemoryWriteInput,
  id: string,
  now: Date,
): MemoryEntry {
  validateScope(input.scope)
  requireNonEmpty('title', input.title, MAX_TITLE_LENGTH)
  requireNonEmpty('summary', input.summary, MAX_SUMMARY_LENGTH)
  if (!MEMORY_SOURCE_KINDS.includes(input.source.kind)) {
    throw new MemoryValidationError(
      `source.kind must be one of ${MEMORY_SOURCE_KINDS.join(', ')}`,
    )
  }
  requireNonEmpty('source.id', input.source.id, MAX_TITLE_LENGTH)

  const createdAt = isoOrThrow('createdAt', now)
  const validAt = input.validAt
    ? isoOrThrow('validAt', input.validAt)
    : createdAt
  const invalidAt = input.invalidAt
    ? isoOrThrow('invalidAt', input.invalidAt)
    : null
  if (invalidAt !== null && invalidAt < validAt) {
    throw new MemoryValidationError('invalidAt must not precede validAt')
  }

  return {
    id,
    scope: input.scope,
    title: input.title.trim(),
    summary: input.summary.trim(),
    body: input.body,
    tags: normaliseTags(input.tags),
    source: { kind: input.source.kind, id: input.source.id.trim() },
    createdAt,
    expiredAt: null,
    validAt,
    invalidAt,
    retirement: null,
    derivedFrom: [...(input.derivedFrom ?? [])],
  }
}

/**
 * Whether an entry may be returned by recall as of `asOf`.
 *
 * Both axes are consulted, and they answer different questions: `expiredAt`
 * asks "is this record still part of the store's answer set", `invalidAt` asks
 * "was the fact still true at the moment being asked about". A record retired
 * yesterday is invisible to every recall including one asking about last year;
 * a fact that stopped holding yesterday is still visible to a recall asking
 * about last year.
 *
 * All timestamps are `Date#toISOString()` output — fixed width, UTC, always
 * `Z` — so lexicographic comparison is chronological comparison.
 */
export function isRecallable(entry: MemoryEntry, asOf: string): boolean {
  if (entry.expiredAt !== null) {
    return false
  }
  if (entry.validAt > asOf) {
    return false
  }
  return entry.invalidAt === null || entry.invalidAt > asOf
}

/**
 * The citation string the tool layer is required to emit alongside any answer
 * built from memory (D-6). It carries the two things AC-4 names — the entry's
 * id and its write time — plus the provenance that makes a fabricated citation
 * checkable: `getEntry(id)` either returns this record or the citation is fake.
 */
export function formatCitation(entry: MemoryEntry): string {
  return `[${entry.id} · ${entry.source.kind}:${entry.source.id} · ${entry.createdAt}]`
}
