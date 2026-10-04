// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `docs-dev-v1` corpus: the extraction rules on small fixtures, the
 * redaction, the committed corpus, and — where the pinned commit is in the
 * clone — byte-for-byte regeneration.
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { generate, OUTPUT } from '../../../scripts/qianmo-recall-docs-corpus.js'
import {
  DOCS_DEV_RECORD_COUNT,
  DOCS_DEV_RECORDS_JSON,
  DOCS_DEV_SOURCE_COMMIT,
} from '../eval/corpus/docs-dev.generated.js'
import {
  buildDocsDataset,
  DOCS_TIERS,
  docsRecords,
} from '../eval/docs-corpus.js'
import {
  cutSentence,
  extractRecords,
  NAME_MARK,
  personalFindings,
  plainText,
  redactPersonal,
  tableCells,
} from '../eval/docs-extract.js'
import { DOCS_SOURCE_COMMIT } from '../eval/docs-sources.js'

const sha = (text: string) =>
  createHash('sha256').update(text.normalize('NFC')).digest('hex')

describe('extraction rules', () => {
  test('inline markdown reduces to text', () => {
    expect(plainText('**采纳** `x.ts` [链接](./a.md)<br>下一行')).toBe(
      '采纳 x.ts 链接 下一行',
    )
    expect(tableCells('| a | b \\| c | d |')).toEqual(['a', 'b \\| c', 'd'])
  })

  test('sentences are cut at their end, else at a comma, else hard', () => {
    expect(cutSentence('第一句。第二句。', 60)).toEqual([
      '第一句。',
      '第二句。',
    ])
    expect(cutSentence('短', 60)).toEqual(['短', ''])
    const [head] = cutSentence(`${'字'.repeat(30)}，${'字'.repeat(40)}`, 60)
    expect(head).toBe(`${'字'.repeat(30)}，`)
    const [hard] = cutSentence('字'.repeat(80), 60)
    expect([...hard].length).toBe(60)
    expect(hard.endsWith('…')).toBe(true)
  })

  test('decision tables: topic is the question, verdict and rationale the entry', () => {
    const markdown = [
      '| # | 机制 | 判定 | 落点与理由 |',
      '|---|---|---|---|',
      '| A1 | 某个机制 | **本轮不做** | 它解决的问题不存在。去向：以后再说。 |',
      '| A2 | ~~撤销的机制~~ | 采纳 | 不该出现 |',
      '',
    ].join('\n')
    const records = extractRecords(markdown, {
      kind: 'table',
      file: 'docs/dev/x.md',
      date: '2026-01-02',
      header: ['#', '机制', '判定', '落点与理由'],
      idColumn: 0,
      topicColumn: 1,
      verdictColumn: 2,
      detail: { column: 3 },
    })
    expect(records).toEqual([
      {
        key: 'x#A1',
        file: 'docs/dev/x.md',
        kind: 'decision',
        date: '2026-01-02',
        question: '某个机制',
        title: '本轮不做',
        summary: '它解决的问题不存在。',
        body: '去向：以后再说。',
      },
    ])
  })

  test('headed decisions take the question from the heading', () => {
    const markdown = [
      '### D-1 要不要做这件事？',
      '',
      '**事实**：略。',
      '',
      '**决议**：**做**，理由写在这里。补充一句。',
      '',
      '### D-2 没有决议的一节',
      '',
      '**事实**：略。',
    ].join('\n')
    const records = extractRecords(markdown, {
      kind: 'heading',
      file: 'docs/dev/y.md',
      date: '2026-01-03',
      level: 3,
      idPattern: /^D-\d+/,
      conclusionLabels: ['决议'],
    })
    expect(records.map(r => [r.key, r.question, r.title])).toEqual([
      ['y#D-1', '要不要做这件事？', '做，理由写在这里。'],
    ])
  })

  test('change logs: blank lines between rows, numbered items split', () => {
    const markdown = [
      '**变更记录**',
      '',
      '| 版本 | 日期 | 说明 |',
      '|---|---|---|',
      '| v1.0 | 2026-01-01 | 初稿 |',
      '',
      '| **v1.1** | **2026-01-02** | **总述**。① **第一项**：内容一。② 第二项内容。 |',
      '',
      '正文开始。',
      '| v9.9 | 2026-09-09 | 表外，不算 |',
    ].join('\n')
    const records = extractRecords(markdown, {
      kind: 'changelog',
      file: 'docs/dev/z.md',
      marker: '**变更记录**',
    })
    expect(records.map(r => [r.key, r.title, r.summary])).toEqual([
      ['z#v1.0', '初稿', '初稿'],
      ['z#v1.1', '总述', '总述'],
      ['z#v1.1.1', '第一项', '内容一。'],
      ['z#v1.1.2', '第二项内容。', '第二项内容。'],
    ])
    expect(records.every(r => r.question === null)).toBe(true)
  })
})

describe('personal information', () => {
  const tokens = [
    { script: 'han' as const, length: 3, sha256: sha('甲乙丙') },
    { script: 'ascii' as const, length: 7, sha256: sha('someone') },
  ]

  test('names, handles, contacts and identifiers are replaced', () => {
    const text =
      '负责人甲乙丙决定；见 github.com/SomeOne/repo，' +
      '邮件 a.b@example.com，电话 13812345678，学号 20231234，主机 10.0.0.1。'
    const redacted = redactPersonal(text, tokens)
    expect(redacted).toBe(
      `负责人${NAME_MARK}决定；见 github.com/〔账号略〕/repo，` +
        '邮件 〔邮箱略〕，电话 〔号码略〕，学号 〔编号略〕，主机 〔地址略〕。',
    )
    expect(personalFindings(redacted, tokens)).toEqual([])
    expect(personalFindings(text, tokens).sort()).toEqual(
      ['email', 'handle', 'ipv4', 'long-number', 'name', 'phone'].sort(),
    )
  })

  test('the committed corpus has no personal detail left', () => {
    expect(personalFindings(DOCS_DEV_RECORDS_JSON)).toEqual([])
  })
})

describe('the committed corpus', () => {
  test('is intact, pinned to the manifest commit, and keyed uniquely', () => {
    const records = docsRecords()
    expect(DOCS_DEV_SOURCE_COMMIT).toBe(DOCS_SOURCE_COMMIT)
    expect(records.length).toBe(DOCS_DEV_RECORD_COUNT)
    expect(new Set(records.map(r => r.key)).size).toBe(records.length)
    const questions = records.filter(r => r.question !== null)
    expect(questions.length).toBeGreaterThan(50)
    for (const record of records) {
      expect(record.title.length).toBeGreaterThan(0)
      expect(record.summary.length).toBeGreaterThan(0)
    }
  })

  test('tiers: exact live count, questions only where their gold is present', () => {
    for (const tier of DOCS_TIERS) {
      const dataset = buildDocsDataset(tier)
      expect(dataset.entries.length).toBe(tier)
      const keys = new Set(dataset.entries.map(e => e.key))
      for (const query of dataset.queries) {
        expect(query.gold.every(key => keys.has(key))).toBe(true)
        expect(query.question.length).toBeGreaterThan(0)
      }
      expect(JSON.stringify(buildDocsDataset(tier))).toBe(
        JSON.stringify(dataset),
      )
    }
    expect(() => buildDocsDataset(31)).toThrow(RangeError)
  })

  test('regenerates byte for byte from the pinned commit', () => {
    const text = generate()
    if (text === null) {
      // A shallow clone does not have the commit; nothing to compare.
      console.error(
        `[docs-corpus] ${DOCS_SOURCE_COMMIT} not in this clone; regeneration check skipped`,
      )
      return
    }
    expect(text).toBe(readFileSync(OUTPUT, 'utf8'))
  }, 60_000)
})
