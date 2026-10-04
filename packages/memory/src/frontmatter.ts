// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * On-disk representation: one Markdown file per entry, YAML frontmatter on top.
 *
 * The format is the base's, not a new one. `name`, `description` and `type` are
 * the exact keys `src/memdir/memoryTypes.ts` documents and `scanMemoryFiles`
 * reads, so a base-side scan of a Qianmo directory produces a usable manifest
 * without a single line of adapter code. Everything Qianmo adds is namespaced
 * `qm_*`, which the base's frontmatter type already tolerates (it carries an
 * index signature) and its memory scan simply ignores.
 *
 * Every value is written as JSON. A JSON string is a valid YAML double-quoted
 * scalar and a JSON array of strings is a valid YAML flow sequence, so this
 * buys exact round-tripping — colons, `#`, newlines, leading dashes, CJK — for
 * both parsers at once, with no YAML emitter and no quoting heuristics to get
 * subtly wrong.
 */

import {
  MEMORY_LAYERS,
  MEMORY_RETIREMENT_KINDS,
  MEMORY_SOURCE_KINDS,
  type MemoryEntry,
  type MemoryLayer,
  type MemoryRetirement,
  type MemoryRetirementKind,
  type MemoryScope,
  type MemorySourceKind,
} from './entry.js'
import { BASE_MEMORY_TYPE_BY_LAYER } from './mapping.js'

/** Thrown when a file under the memory root is not a well-formed entry. */
export class MemoryParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryParseError'
  }
}

const FENCE = '---\n'
const CLOSING = '\n---\n'

function scalar(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value)
}

function sequence(values: readonly string[]): string {
  return `[${values.map(v => JSON.stringify(v)).join(', ')}]`
}

function projectKeyOf(scope: MemoryScope): string | null {
  return scope.layer === 'baseline' ? null : scope.projectKey
}

export function serializeEntry(entry: MemoryEntry): string {
  const baseType = BASE_MEMORY_TYPE_BY_LAYER[entry.scope.layer]
  const lines: string[] = [
    // Base-compatible keys first, so a human opening the file sees the same
    // three fields they see in any other memory file.
    `name: ${scalar(entry.title)}`,
    `description: ${scalar(entry.summary)}`,
  ]
  if (baseType !== null) {
    lines.push(`type: ${scalar(baseType)}`)
  }
  lines.push(
    `qm_id: ${scalar(entry.id)}`,
    `qm_layer: ${scalar(entry.scope.layer)}`,
    `qm_project_key: ${scalar(projectKeyOf(entry.scope))}`,
    `qm_task_id: ${scalar(entry.scope.layer === 'working' ? entry.scope.taskId : null)}`,
    `qm_period: ${scalar(entry.scope.layer === 'baseline' ? entry.scope.period : null)}`,
    `qm_source_kind: ${scalar(entry.source.kind)}`,
    `qm_source_id: ${scalar(entry.source.id)}`,
    `qm_tags: ${sequence(entry.tags)}`,
    `qm_created_at: ${scalar(entry.createdAt)}`,
    `qm_expired_at: ${scalar(entry.expiredAt)}`,
    `qm_valid_at: ${scalar(entry.validAt)}`,
    `qm_invalid_at: ${scalar(entry.invalidAt)}`,
    `qm_retired_kind: ${scalar(entry.retirement?.kind ?? null)}`,
    `qm_retired_reason: ${scalar(entry.retirement?.reason ?? null)}`,
    `qm_retired_by: ${scalar(entry.retirement?.by ?? null)}`,
    `qm_derived_from: ${sequence(entry.derivedFrom)}`,
  )
  return `${FENCE}${lines.join('\n')}${CLOSING}${entry.body}`
}

type Fields = ReadonlyMap<string, unknown>

function splitDocument(text: string): { fields: Fields; body: string } {
  if (!text.startsWith(FENCE)) {
    throw new MemoryParseError(
      'entry file must open with a `---` frontmatter fence',
    )
  }
  const closingAt = text.indexOf(CLOSING, FENCE.length - 1)
  if (closingAt === -1) {
    throw new MemoryParseError(
      'entry file has no closing `---` frontmatter fence',
    )
  }
  const fields = new Map<string, unknown>()
  const head = text.slice(FENCE.length, closingAt)
  // Messages below name the key and the line number, never the value. They
  // travel to the event channel (`events.ts`) and from there into whatever an
  // operator is logging, so echoing the offending text would push memory
  // content somewhere the memory root's 0600 permissions no longer cover.
  const lines = head.length === 0 ? [] : head.split('\n')
  for (const [index, line] of lines.entries()) {
    const colon = line.indexOf(': ')
    if (colon === -1) {
      throw new MemoryParseError(
        `frontmatter line ${index + 1} is not \`key: value\``,
      )
    }
    const key = line.slice(0, colon)
    const raw = line.slice(colon + 2)
    try {
      fields.set(key, JSON.parse(raw) as unknown)
    } catch {
      throw new MemoryParseError(
        `frontmatter value for \`${key}\` (line ${index + 1}) is not JSON`,
      )
    }
  }
  return { fields, body: text.slice(closingAt + CLOSING.length) }
}

function requireString(fields: Fields, key: string): string {
  const value = fields.get(key)
  if (typeof value !== 'string') {
    throw new MemoryParseError(`frontmatter \`${key}\` must be a string`)
  }
  return value
}

function optionalString(fields: Fields, key: string): string | null {
  const value = fields.get(key)
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    throw new MemoryParseError(
      `frontmatter \`${key}\` must be a string or null`,
    )
  }
  return value
}

function requireStringList(fields: Fields, key: string): readonly string[] {
  const value = fields.get(key)
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    throw new MemoryParseError(
      `frontmatter \`${key}\` must be a list of strings`,
    )
  }
  return value as string[]
}

function requireMember<T extends string>(
  fields: Fields,
  key: string,
  allowed: readonly T[],
): T {
  const value = requireString(fields, key)
  const found = allowed.find(a => a === value)
  if (found === undefined) {
    throw new MemoryParseError(
      `frontmatter \`${key}\` must be one of ${allowed.join(', ')} (got ${value})`,
    )
  }
  return found
}

function readScope(fields: Fields): MemoryScope {
  const layer: MemoryLayer = requireMember(fields, 'qm_layer', MEMORY_LAYERS)
  switch (layer) {
    case 'working':
      return {
        layer,
        projectKey: requireString(fields, 'qm_project_key'),
        taskId: requireString(fields, 'qm_task_id'),
      }
    case 'project':
      return { layer, projectKey: requireString(fields, 'qm_project_key') }
    case 'baseline':
      return { layer, period: requireString(fields, 'qm_period') }
  }
}

/**
 * Retirement metadata and `expiredAt` must agree. They are two halves of one
 * fact — "this record left recall, and here is why" — and a file carrying only
 * one of them would let a retired entry answer a recall, or let an audit see a
 * tombstone with no reason attached.
 */
function readRetirement(
  fields: Fields,
  expiredAt: string | null,
): MemoryRetirement | null {
  const kindRaw = optionalString(fields, 'qm_retired_kind')
  if (kindRaw === null) {
    if (expiredAt !== null) {
      throw new MemoryParseError(
        'entry has `qm_expired_at` but no `qm_retired_kind`',
      )
    }
    return null
  }
  if (expiredAt === null) {
    throw new MemoryParseError(
      'entry has `qm_retired_kind` but no `qm_expired_at`',
    )
  }
  const kind: MemoryRetirementKind = requireMember(
    fields,
    'qm_retired_kind',
    MEMORY_RETIREMENT_KINDS,
  )
  return {
    kind,
    reason: requireString(fields, 'qm_retired_reason'),
    by: requireString(fields, 'qm_retired_by'),
  }
}

export function parseEntry(text: string): MemoryEntry {
  const { fields, body } = splitDocument(text)
  const expiredAt = optionalString(fields, 'qm_expired_at')
  const sourceKind: MemorySourceKind = requireMember(
    fields,
    'qm_source_kind',
    MEMORY_SOURCE_KINDS,
  )
  return {
    id: requireString(fields, 'qm_id'),
    scope: readScope(fields),
    title: requireString(fields, 'name'),
    summary: requireString(fields, 'description'),
    body,
    tags: requireStringList(fields, 'qm_tags'),
    source: { kind: sourceKind, id: requireString(fields, 'qm_source_id') },
    createdAt: requireString(fields, 'qm_created_at'),
    expiredAt,
    validAt: requireString(fields, 'qm_valid_at'),
    invalidAt: optionalString(fields, 'qm_invalid_at'),
    retirement: readRetirement(fields, expiredAt),
    derivedFrom: requireStringList(fields, 'qm_derived_from'),
  }
}
