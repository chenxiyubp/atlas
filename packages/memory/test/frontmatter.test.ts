// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The file format claim from `mapping.ts` §2: Qianmo entries are base memory
 * files. That is asserted here against the base's own parser and its own
 * directory scanner — not against a second implementation of the same idea,
 * which would only prove this package agrees with itself.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseMemoryType } from '../../../src/memdir/memoryTypes.js'
import { scanMemoryFiles } from '../../../src/memdir/memoryScan.js'
import { parseFrontmatter } from '../../../src/utils/text/frontmatterParser.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BASE_MEMORY_TYPE_BY_LAYER,
  MemoryParseError,
  parseEntry,
  serializeEntry,
} from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

let sandbox: Sandbox

beforeEach(() => {
  sandbox = createSandbox()
})

afterEach(() => {
  sandbox.dispose()
})

const AWKWARD_TITLE = 'Bun: 运行时 & 测试器 — "不引入 npm"'
const AWKWARD_BODY = '---\nnot a fence\n\n- item: value # not a comment\n'

describe('serialize / parse', () => {
  test('round-trips values that would break a naive YAML emitter', () => {
    const written = sandbox.store.write({
      scope: { layer: 'working', projectKey: 'atlas', taskId: 't1' },
      title: AWKWARD_TITLE,
      summary: 'colons: everywhere, and a [bracket]',
      body: AWKWARD_BODY,
      source: { kind: 'session', id: 'sess-1' },
      tags: ['a.b', 'c:d'],
    })
    const path = join(
      sandbox.root,
      'working',
      'atlas',
      't1',
      `${written.id}.md`,
    )
    expect(parseEntry(readFileSync(path, 'utf8'))).toEqual(written)
    expect(parseEntry(serializeEntry(written))).toEqual(written)
  })

  test('a file with a tombstone but no reason is rejected, not half-read', () => {
    const entry = sandbox.store.write({
      scope: { layer: 'project', projectKey: 'atlas' },
      title: 't',
      summary: 's',
      body: '',
      source: { kind: 'user', id: 'u' },
    })
    const tampered = serializeEntry(entry).replace(
      'qm_expired_at: null',
      'qm_expired_at: "2026-09-21T00:00:00.000Z"',
    )
    expect(() => parseEntry(tampered)).toThrow(MemoryParseError)
  })
})

describe('the base can read these files unmodified', () => {
  test("base parseFrontmatter sees the base's own three keys", () => {
    const entry = sandbox.store.write({
      scope: { layer: 'project', projectKey: 'atlas' },
      title: AWKWARD_TITLE,
      summary: 'This project standardises on Bun.',
      body: AWKWARD_BODY,
      source: { kind: 'session', id: 'sess-1' },
    })
    const path = join(sandbox.root, 'project', 'atlas', `${entry.id}.md`)
    const parsed = parseFrontmatter(readFileSync(path, 'utf8'), path)

    expect(parsed.frontmatter.name).toBe(AWKWARD_TITLE)
    expect(parsed.frontmatter.description).toBe(
      'This project standardises on Bun.',
    )
    expect(BASE_MEMORY_TYPE_BY_LAYER.project).toBe('project')
    expect(parseMemoryType(parsed.frontmatter.type)).toBe('project')
    expect(parsed.content).toBe(AWKWARD_BODY)
  })

  test('layers with no base counterpart omit `type:` and degrade gracefully', () => {
    const entry = sandbox.store.write({
      scope: { layer: 'baseline', period: '2026-09' },
      title: 'September baseline',
      summary: 'Median 3.1M tokens/day.',
      body: '',
      source: { kind: 'import', id: 'usage-export' },
    })
    const path = join(sandbox.root, 'baseline', '2026-09', `${entry.id}.md`)
    const parsed = parseFrontmatter(readFileSync(path, 'utf8'), path)
    expect(BASE_MEMORY_TYPE_BY_LAYER.baseline).toBeNull()
    expect(parsed.frontmatter.type).toBeUndefined()
    expect(parseMemoryType(parsed.frontmatter.type)).toBeUndefined()
  })

  test('base scanMemoryFiles builds a usable manifest over a Qianmo layer dir', async () => {
    const entry = sandbox.store.write({
      scope: { layer: 'project', projectKey: 'atlas' },
      title: 'Runtime decision',
      summary: 'This project standardises on Bun.',
      body: 'why',
      source: { kind: 'session', id: 'sess-1' },
    })
    const headers = await scanMemoryFiles(
      join(sandbox.root, 'project', 'atlas'),
      new AbortController().signal,
    )
    expect(headers).toHaveLength(1)
    expect(headers[0]?.filename).toBe(`${entry.id}.md`)
    expect(headers[0]?.description).toBe('This project standardises on Bun.')
    expect(headers[0]?.type).toBe('project')
  })
})
