// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { tokenize } from '../src/index.js'

describe('tokenize', () => {
  test('lower-cases Latin runs and drops single characters', () => {
    expect(tokenize('Use Bun, not npm — a runtime')).toEqual([
      'use',
      'bun',
      'not',
      'npm',
      'runtime',
    ])
  })

  test('splits CJK into bigrams so questions can overlap entries', () => {
    expect(tokenize('运行时')).toEqual(['运行', '行时'])
  })

  test('a lone CJK character survives as itself', () => {
    expect(tokenize('用 Bun')).toEqual(['bun', '用'])
  })

  test('mixed scripts produce both kinds of token', () => {
    const tokens = tokenize('本项目统一用 Bun 作为运行时')
    expect(tokens).toContain('bun')
    expect(tokens).toContain('运行')
    expect(tokens).toContain('统一')
  })

  test('duplicates collapse and first-seen order is kept', () => {
    expect(tokenize('bun bun test bun')).toEqual(['bun', 'test'])
  })

  test('is a pure function of its input', () => {
    const text = '记忆检索唤醒 recall v0'
    expect(tokenize(text)).toEqual(tokenize(text))
  })

  test('stopwords are removed but content words are not', () => {
    const tokens = tokenize('what does the project use for testing')
    expect(tokens).not.toContain('what')
    expect(tokens).not.toContain('the')
    expect(tokens).toContain('project')
    expect(tokens).toContain('testing')
  })

  test('punctuation never becomes a token', () => {
    expect(tokenize('a.b, c! (d)')).toEqual([])
  })
})
