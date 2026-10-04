// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 与基座既有记忆机制的映射说明 —— roadmap P2.3 的第四件交付物。
 *
 * The relationship is stated here, in code, rather than in a prose file,
 * because the one part of it that must not drift — which base memory type each
 * Qianmo layer declares itself as — is a value this package writes into every
 * file it persists. Keeping the statement next to the value it governs is the
 * "指针不复制" rule applied to a mapping.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. WHAT THE BASE ACTUALLY HAS  (verified against the code, not the docs)
 *
 *   - A flat, closed four-type taxonomy: `user` / `feedback` / `project` /
 *     `reference` (`src/memdir/memoryTypes.ts`). No hierarchy, no layers.
 *   - One Markdown file per memory, `name` / `description` / `type` frontmatter,
 *     under `<memoryBase>/projects/<sanitised-git-root>/memory/`
 *     (`src/memdir/paths.ts`), plus a `MEMORY.md` index that the system prompt
 *     always loads.
 *   - Recall by `findRelevantMemories()` (`src/memdir/findRelevantMemories.ts`):
 *     it scans frontmatter headers and asks Sonnet to pick up to five files.
 *     **It is a model call, not a deterministic query.**
 *   - No provenance field, no revocation, no time fields at all: the only
 *     timestamp is the file's `mtimeMs`, read from the filesystem.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. THE CALL: UPPER-LAYER PACKAGE OVER A SHARED FILE FORMAT — NOT A MAPPING,
 *    AND NOT A SECOND PARALLEL STORE
 *
 * Three options were on the table. The judgement, and its边界:
 *
 *   (a) Pure mapping — express the three layers *as* base types and keep
 *       everything in the base memory directory.  **Rejected**, on three
 *       findings, any one of which is sufficient:
 *
 *       · The base directory is under an autonomous agent's write authority
 *         *with delete permission*: the shipped prompt tells the model to
 *         "Update or remove memories that turn out to be wrong or outdated"
 *         (`src/memdir/memdir.ts`, `buildMemoryLines`). Our records must be
 *         append-and-mark-only and auditable after retirement (charter §1.5
 *         「可人工废止」, §6.1 T-3 对策④). An invariant cannot live in a
 *         directory another actor is instructed to prune.
 *       · Working memory has no base counterpart *by design*: the base's
 *         `WHAT_NOT_TO_SAVE_SECTION` explicitly excludes "Ephemeral task
 *         details: in-progress work, temporary state, current conversation
 *         context" — precisely the content of charter §1.5's 工作记忆 layer.
 *         Mapping it onto a base type would write content the base tells the
 *         model not to write, and would push it through `MEMORY.md`, which is
 *         loaded into *every* prompt.
 *       · Baseline memory is account-level; the base memory directory is keyed
 *         by git root (`getAutoMemBase()` → `findCanonicalGitRoot`). There is
 *         no per-project location that can hold an account-level series.
 *
 *   (b) A second, unrelated store.  **Rejected**: it would give up the base's
 *       file format, its frontmatter contract and its injection chain for
 *       nothing, and roadmap P2.3 says 优先复用、不另起炉灶.
 *
 *   (c) **Chosen — an upper-layer package that reuses the base's file format
 *       and path derivation, owns its own root, and projects into the base's
 *       injection chain one-way.**  Concretely:
 *
 *       · Format reuse: every entry is a Markdown file with YAML frontmatter
 *         whose `name` / `description` / `type` keys are exactly the base's
 *         (`frontmatter.ts`), so `parseFrontmatter` + `scanMemoryFiles` +
 *         `formatMemoryManifest` read our files unmodified. A test asserts this
 *         against the base parser rather than asserting it in a comment.
 *       · Path reuse: the root is derived from `getMemoryBaseDir()`
 *         (`paths.ts`), so an identity switch (`OCC_IDENTITY`), a config-dir
 *         override, or a CCR persistent memory mount moves Qianmo memory to the
 *         same place it moves base memory.
 *       · Root ownership: `<memoryBase>/memory/{working,project,baseline}/…`,
 *         a sibling of the base's `projects/` tree — outside the directory the
 *         base's extraction agent is told it may prune.
 *       · One-way projection: the base's chain is an *output* of this store,
 *         never an input. Rendering live project-layer entries into the base
 *         recall surface is P3.3's job (检索唤醒并注入提示词); this package's
 *         contribution is that `BASE_MEMORY_TYPE_BY_LAYER` below is already
 *         written into each file, so that projection is a copy, not a
 *         re-classification.
 *
 * 边界 (what this call does *not* claim):
 *
 *   - It does not replace the base memory directory. The base's own auto-memory
 *     keeps working exactly as it does today, on its own files.
 *   - It does not make base recall aware of retirement. `scanMemoryFiles` reads
 *     every `.md` it finds and has no notion of a tombstone; that is one more
 *     reason the canonical records live outside its scan root, and it is the
 *     constraint P3.3's projection has to respect (project only live entries,
 *     re-project on retirement).
 *   - It does not adopt the base's recall path. `findRelevantMemories()` is a
 *     Sonnet call; charter N-8 requires deterministic retrieval for M0. The
 *     query in `store.ts` is deterministic and takes no model in its path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 3. LAYER → BASE TYPE
 *
 *   工作记忆 working  → (none)     base excludes this content class outright
 *   项目记忆 project  → `project`  the one genuine overlap: "ongoing work,
 *                                  goals, initiatives, bugs, or incidents not
 *                                  derivable from code or git history"
 *   基线档案 baseline → (none)     `reference` is *pointers to external systems*,
 *                                  not measured series; there is no honest match
 *
 * Files whose layer maps to nothing simply omit the `type:` key. That is a
 * supported state on the base side: `parseMemoryType` returns `undefined` for a
 * missing value and the manifest formatter drops the tag — the base's own
 * documented behaviour for legacy files.
 */

import type { MemoryType } from '../../../src/memdir/memoryTypes.js'
import type { MemoryLayer } from './entry.js'

/**
 * The declared base counterpart of each Qianmo layer.
 *
 * Typed against the base's own `MemoryType` union on purpose: if the base ever
 * adds or renames a type, this table stops compiling instead of silently
 * writing a `type:` value the base no longer recognises.
 */
export const BASE_MEMORY_TYPE_BY_LAYER: Readonly<
  Record<MemoryLayer, MemoryType | null>
> = {
  working: null,
  project: 'project',
  baseline: null,
}
