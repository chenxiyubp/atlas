// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryEventType } from '@qianmo/memory'
import {
  injectedIds,
  recall,
  renderEntry,
  renderInjection,
  type RecallRequest,
  type RecallResult,
} from '../src/index.js'
import { createSandbox, DAY_MS, PROJECT_KEY, type Sandbox } from './helpers.js'

let box: Sandbox

beforeEach(() => {
  box = createSandbox()
})

afterEach(() => {
  box.dispose()
})

/** Recall at the sandbox's current instant, not the wall clock. */
function recallNow(request: RecallRequest = {}): RecallResult {
  return recall(box.store, { asOf: box.clock.now(), ...request })
}

/** The five decisions AC-4 is written around, in miniature. */
function writeFive(): string[] {
  const ids: string[] = []
  for (const [title, body] of [
    ['统一用 Bun 作为运行时与测试器', '不引入 npm / pnpm'],
    ['跨节点消息一律走自研协议', '概念对齐 A2A，不直接采用'],
    ['沙箱选 Dormice + gVisor', 'occ 跑在沙箱内'],
    ['capability 用每节点 Ed25519 签发', 'PSK 只做接入门禁'],
    ['备份自研，不用 Dormice 归档', ''],
  ] as const) {
    ids.push(box.write({ title, body }).id)
    box.clock.advance(DAY_MS)
  }
  return ids
}

describe('candidate selection', () => {
  test('a question that shares no wording still gets every entry', () => {
    const ids = writeFive()

    // Deliberately adversarial: none of these words appears in any entry.
    const result = recallNow({
      question: 'what did we settle on for package management?',
      scope: { layers: ['project'], projectKey: PROJECT_KEY },
    })

    expect(result.mode).toBe('full')
    expect(result.candidateCount).toBe(5)
    expect(result.entries.length).toBe(5)
    expect([...injectedIds(result)].sort()).toEqual([...ids].sort())
    // Every score is zero — the entries are present because of full
    // injection, not because retrieval found them. That is the whole point.
    expect(result.entries.every(r => r.score === 0)).toBe(true)
  })

  test('ranking still decides the order inside a full block', () => {
    writeFive()
    const result = recallNow({
      question: '沙箱用什么',
      scope: { projectKey: PROJECT_KEY },
    })
    expect(result.mode).toBe('full')
    expect(result.entries[0]?.entry.title).toContain('沙箱')
    expect(result.entries[0]?.score).toBeGreaterThan(0)
  })

  test('scope is a partition, not a guess: another project is not a candidate', () => {
    box.write({ title: '本项目的决策' })
    box.store.write({
      scope: { layer: 'project', projectKey: 'other' },
      title: '别的项目的决策',
      summary: '别的项目的决策',
      body: '',
      source: { kind: 'session', id: 'test-session' },
    })

    const result = recallNow({ scope: { projectKey: PROJECT_KEY } })
    expect(result.candidateCount).toBe(1)
    expect(result.entries[0]?.entry.title).toBe('本项目的决策')
  })
})

describe('retirement', () => {
  test('a revoked entry is gone from the very next recall', () => {
    const ids = writeFive()
    const target = ids[0]
    if (target === undefined) throw new Error('fixture changed')

    expect(recallNow().candidateCount).toBe(5)

    box.store.revoke(target, { reason: '决策已推翻', by: 'tester' })

    const after = recallNow()
    expect(after.candidateCount).toBe(4)
    expect(injectedIds(after).has(target)).toBe(false)
    expect(renderInjection(after)).not.toContain(target)
  })

  test('an invalidated fact leaves the present but keeps answering the past', () => {
    const entry = box.write({ title: '当时用的是 npm' })
    box.clock.advance(10 * DAY_MS)
    const invalidatedAt = box.clock.now()
    box.store.invalidate(entry.id, invalidatedAt)
    box.clock.advance(DAY_MS)

    // Asked about now: the fact no longer holds.
    expect(injectedIds(recallNow()).has(entry.id)).toBe(false)
    // Asked about a moment when it did hold: still recalled.
    const earlier = recallNow({
      asOf: new Date(invalidatedAt.getTime() - DAY_MS),
    })
    expect(injectedIds(earlier).has(entry.id)).toBe(true)
  })
})

describe('injection budget', () => {
  test('over the entry budget it degrades to ranked, and says so', () => {
    writeFive()
    const result = recallNow({
      question: '沙箱',
      scope: { projectKey: PROJECT_KEY },
      budget: { maxEntries: 2 },
    })

    expect(result.mode).toBe('ranked')
    expect(result.entries.length).toBe(2)
    expect(result.omittedCount).toBe(3)
    expect(result.entries[0]?.entry.title).toContain('沙箱')

    const block = renderInjection(result)
    expect(block).toContain('mode="ranked"')
    expect(block).toContain('omitted="3"')
    expect(block).toContain('Absence here is not evidence of absence')
  })

  test('the character budget counts the rendered entries', () => {
    const first = box.write({ title: 'a'.repeat(50) })
    box.clock.advance(DAY_MS)
    box.write({ title: 'b'.repeat(50) })

    const oneEntry = renderEntry(first).length
    const result = recallNow({ budget: { maxChars: oneEntry + 10 } })
    expect(result.entries.length).toBe(1)
    expect(result.omittedCount).toBe(1)
  })

  test('a single oversized entry is still injected rather than dropped', () => {
    box.write({ title: 'huge', body: 'x'.repeat(5000) })
    const result = recallNow({ budget: { maxChars: 10 } })
    expect(result.entries.length).toBe(1)
    expect(result.mode).toBe('full')
  })
})

describe('a corrupt file is reported, not swallowed', () => {
  test('recall returns the healthy entries and carries the failure out', () => {
    const ids = writeFive()
    writeFileSync(
      join(box.root, 'project', PROJECT_KEY, 'hand-edited.md'),
      'this is not valid frontmatter at all',
    )

    const result = recallNow({ scope: { projectKey: PROJECT_KEY } })

    // Partial results: every healthy entry is still there.
    expect(result.candidateCount).toBe(ids.length)
    // And the failure reached the caller.
    expect(result.degraded).toBe(true)
    expect(result.events.map(event => event.type)).toContain(
      MemoryEventType.EntryUnreadable,
    )
    expect(renderInjection(result)).toContain('WARNING')
  })

  test('a clean recall carries no events and is not degraded', () => {
    writeFive()
    const result = recallNow()
    expect(result.events).toEqual([])
    expect(result.degraded).toBe(false)
    expect(renderInjection(result)).not.toContain('WARNING')
  })

  test('only the events of this recall are reported', () => {
    writeFive()
    writeFileSync(
      join(box.root, 'project', PROJECT_KEY, 'broken.md'),
      'not frontmatter',
    )

    const first = recallNow()
    const second = recallNow()

    // The same bad file fails again, so each call reports one failure —
    // not one, then two, then three.
    expect(first.events.length).toBe(1)
    expect(second.events.length).toBe(1)
    expect(box.store.events.all().length).toBe(2)
  })
})
