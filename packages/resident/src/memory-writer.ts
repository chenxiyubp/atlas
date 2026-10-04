// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Writing into the memory partition a resident turn reads (design
 * `memory-m1.md` §6.4, P16.W).
 *
 * Before this module nothing in production wrote memory at all, so the working
 * layer of every resident node was empty and the sidecar returned `''` on every
 * turn. There are two writers in M1 and both go through here:
 *
 *   1. `qm memory add / revoke / invalidate` — an operator on the node itself
 *      (`src/cli/handlers/memory.ts`), `source.kind = 'user'`;
 *   2. an agent-side write tool — `source.kind = 'agent'`, one approval per
 *      write (P14). Not wired yet: it waits on P14.4 and the P16.5 bridge.
 *
 * WHY THE PARTITION IS COMPUTED HERE AND NOT BY THE CALLER
 *
 * The directory an entry lands in is `residentRecallScope(agent, contextId)` —
 * the function the sidecar reads with. Writing through the same function is
 * what makes "the operator wrote it, the next turn of that context sees it" a
 * property of the code rather than of two call sites agreeing. A caller that
 * built its own `{ projectKey, taskId }` could put a memory in a directory no
 * turn ever recalls, and nothing would say so.
 *
 * WHAT IS NOT DONE ON THE WAY IN
 *
 * The text is stored as given. Entry content is neutralized where it becomes
 * framing — `renderEntry`, the single exit into any prompt (P16.0, invariant
 * I-8) — so escaping it here as well would show operators a rewritten body and
 * run the neutralizer twice on the way out.
 */

import type { FileMemoryStore, MemoryEntry, WorkingScope } from '@qianmo/memory'
import { residentRecallScope } from './memory-sidecar.js'

/** Which partition: one agent of this node, one requester context. */
export interface ResidentMemoryTarget {
  readonly agent: string
  /**
   * Required and non-empty. `sessionKeyOf` folds an empty context into
   * `default`, which would make "no context given" silently mean "the default
   * bucket"; a write has to name the bucket it goes to.
   */
  readonly contextId: string
}

/**
 * The only two provenances a resident partition accepts. `session`, `archive`
 * and `import` belong to other writers (the sedimentation task, bulk loads),
 * and letting them in here would make the trust level of an entry a matter of
 * what the caller claimed.
 */
export interface ResidentMemorySource {
  readonly kind: 'user' | 'agent'
  readonly id: string
}

/**
 * Not exported: reachable as `Parameters<typeof writeResidentMemory>[1]` for
 * the one other caller that will build one (the agent-side tool, P16.W row 2).
 */
interface ResidentMemoryWrite extends ResidentMemoryTarget {
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly tags?: readonly string[]
  /** Event axis: when the fact became true. Defaults to the write time. */
  readonly validAt?: Date
  /** Event axis: a known end, for a fact that expires (§6.2 row 1). */
  readonly invalidAt?: Date | null
  readonly source: ResidentMemorySource
}

/**
 * Refusals that are the caller's to fix: an unnamed context, an entry that is
 * not in the named partition. Store-level failures (`MemoryStoreError`,
 * `MemoryValidationError`) pass through unchanged.
 */
export class ResidentMemoryWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResidentMemoryWriteError'
  }
}

/** The working-layer scope a `(agent, contextId)` pair reads and writes. */
export function residentMemoryScope(
  target: ResidentMemoryTarget,
): WorkingScope {
  if (target.contextId.length === 0) {
    throw new ResidentMemoryWriteError(
      'a memory write needs an explicit context; an empty one is not "default"',
    )
  }
  const { projectKey, taskId } = residentRecallScope(target)
  if (projectKey === undefined || taskId === undefined) {
    throw new ResidentMemoryWriteError(
      'the resident recall scope named no working partition',
    )
  }
  return { layer: 'working', projectKey, taskId }
}

const RESIDENT_SOURCE_KINDS: ReadonlySet<string> = new Set(['user', 'agent'])

/** Persist one entry into the partition the target's turns recall from. */
export function writeResidentMemory(
  store: FileMemoryStore,
  write: ResidentMemoryWrite,
): MemoryEntry {
  // Checked at run time as well: the agent-side writer's input crosses a
  // process boundary, where the type above is only a hope.
  if (!RESIDENT_SOURCE_KINDS.has(write.source.kind)) {
    throw new ResidentMemoryWriteError(
      `a resident memory write must come from a user or an agent (got ${JSON.stringify(write.source.kind)})`,
    )
  }
  return store.write({
    scope: residentMemoryScope(write),
    title: write.title,
    summary: write.summary,
    body: write.body,
    source: { kind: write.source.kind, id: write.source.id },
    ...(write.tags === undefined ? {} : { tags: write.tags }),
    ...(write.validAt === undefined ? {} : { validAt: write.validAt }),
    ...(write.invalidAt === undefined ? {} : { invalidAt: write.invalidAt }),
  })
}

function sameScope(a: MemoryEntry['scope'], b: WorkingScope): boolean {
  return (
    a.layer === 'working' &&
    a.projectKey === b.projectKey &&
    a.taskId === b.taskId
  )
}

/**
 * Confirm `id` lives in the target's partition before anything changes it.
 *
 * "No such entry" and "that entry is in another partition" get the same
 * message on purpose: a writer confined to one partition — the agent tool, in
 * particular — must not be able to learn which ids exist elsewhere by the shape
 * of a refusal (memory-m1 §6.3 gap 1).
 */
function requireInPartition(
  store: FileMemoryStore,
  target: ResidentMemoryTarget,
  id: string,
): void {
  const scope = residentMemoryScope(target)
  const entry = store.getEntry(id)
  if (entry === null || !sameScope(entry.scope, scope)) {
    throw new ResidentMemoryWriteError(
      `no memory entry ${id} in this agent and context`,
    )
  }
}

/**
 * Withdraw an entry — the ingest axis (`FileMemoryStore.revoke`). It stops
 * being recalled at every `asOf` and stays on disk for audit. For "this fact
 * stopped being true" use {@link invalidateResidentMemory} instead.
 */
export function revokeResidentMemory(
  store: FileMemoryStore,
  request: ResidentMemoryTarget & {
    readonly id: string
    readonly reason: string
    readonly by: string
  },
): MemoryEntry {
  requireInPartition(store, request, request.id)
  return store.revoke(request.id, { reason: request.reason, by: request.by })
}

/**
 * Record that the fact stopped being true — the event axis
 * (`FileMemoryStore.invalidate`). Questions about earlier moments still see it.
 */
export function invalidateResidentMemory(
  store: FileMemoryStore,
  request: ResidentMemoryTarget & { readonly id: string; readonly at?: Date },
): MemoryEntry {
  requireInPartition(store, request, request.id)
  return store.invalidate(request.id, request.at)
}
