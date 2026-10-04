// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the `docs-dev-v1` corpus comes from: one pinned commit and an
 * explicit list of source tables and sections (`docs/dev/memory-m1.md`
 * §2.4 item 7, D-8).
 *
 * The commit is `9770e8a7`, the v2.46.2 merge on `main` — the source baseline
 * the v1.0 design itself is checked against. It is reachable from `main`,
 * so any clone with history can regenerate the corpus byte for byte.
 *
 * WHAT IS IN, WHAT IS OUT
 *
 *   - `selection-m0.md` §1: nine decisions, each headed by the question it
 *     settled (「D-1 AC-2 的「休眠态」认不认 Dormice 的 frozen？」).
 *   - `resident-botization.md`: six 「机制 | 判定 | 落点与理由」 tables,
 *     one decision per mechanism.
 *   - `p1.4-provider-verification.md` §4: the capability-difference table;
 *     the one struck-out (retracted) row is skipped.
 *   - `charter.md` and `roadmap.md` change logs: decision-shaped entries with
 *     no question of their own.
 *   - Not `authorization-m1.md`, `memory-m1.md` or `tenancy-m1.md`: at the
 *     pinned commit their D-tables are v0.1 proposals awaiting a ruling, and
 *     a proposal recorded as a decision would be a wrong answer.
 */

import type { DocsSource } from './docs-extract.js'

export const DOCS_SOURCE_COMMIT = '9770e8a70fcdf2c8f1def5d936388b99a815e927'

export const DOCS_SOURCES: readonly DocsSource[] = [
  {
    kind: 'heading',
    file: 'docs/dev/selection-m0.md',
    date: '2026-08-12',
    level: 3,
    idPattern: /^D-\d+/,
    conclusionLabels: ['决议', '结果'],
  },
  {
    kind: 'table',
    file: 'docs/dev/resident-botization.md',
    date: '2026-08-18',
    header: ['#', '机制', '判定', '落点与理由'],
    idColumn: 0,
    topicColumn: 1,
    verdictColumn: 2,
    detail: { column: 3 },
  },
  {
    kind: 'table',
    file: 'docs/dev/p1.4-provider-verification.md',
    date: '2026-08-12',
    header: ['#', '差异', '谁处理', '证据'],
    idColumn: 0,
    topicColumn: 1,
    verdictColumn: 2,
    detail: { from: 'topic-rest' },
  },
  { kind: 'changelog', file: 'docs/dev/charter.md', marker: '**变更记录**' },
  { kind: 'changelog', file: 'docs/dev/roadmap.md', marker: '**变更记录**' },
]
