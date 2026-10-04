// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  chunkBounds,
  combineChunkResults,
  computeChunk,
  expectedSolution,
  makeDataset,
  parseModelDataset,
  scoreCandidate,
  serializeModelDataset,
} from './p61-dataset.js'

describe('P6.1 deterministic modeling dataset', () => {
  test('the same seed produces the same dataset and another seed does not', () => {
    expect(makeDataset(6101)).toEqual(makeDataset(6101))
    expect(makeDataset(6101)).not.toEqual(makeDataset(6102))
  })

  test('the reset serializer reproduces the checked-in dataset bytes', () => {
    const checkedIn = readFileSync(
      join(import.meta.dir, '..', 'p61-data', 'model-input.json'),
      'utf8',
    )
    expect(serializeModelDataset(makeDataset(6101))).toBe(checkedIn)
  })

  test('chunk bounds cover every candidate exactly once', () => {
    const length = 96
    const covered = Array.from({ length: 20 }, (_, chunk) => {
      const { start, end } = chunkBounds(length, chunk, 20)
      return Array.from({ length: end - start }, (__, index) => start + index)
    }).flat()
    expect(covered).toEqual(Array.from({ length }, (_, index) => index))
  })

  test('chunk aggregation finds the same global best candidate as a direct scan', () => {
    const dataset = makeDataset(6101)
    const chunks = Array.from({ length: 12 }, (_, chunk) =>
      computeChunk(dataset, chunk, 12, 3),
    )
    const combined = combineChunkResults(chunks)
    const direct = dataset.candidates
      .map((__, index) => ({ index, score: scoreCandidate(dataset, index) }))
      .sort(
        (left, right) => left.score - right.score || left.index - right.index,
      )[0]
    expect(combined.bestIndex).toBe(direct?.index)
    expect(combined.bestScore).toBe(direct?.score)
    expect(combined.digest).toHaveLength(64)
  })

  test('the expected digest is stable for the same chunk contract', () => {
    const dataset = makeDataset(6101)
    expect(expectedSolution(dataset, 8, 2)).toEqual(
      expectedSolution(dataset, 8, 2),
    )
    expect(expectedSolution(dataset, 8, 2).digest).not.toBe(
      expectedSolution(dataset, 8, 3).digest,
    )
  })

  test('the parser rejects a matrix whose width differs from the target', () => {
    expect(() =>
      parseModelDataset({
        ...makeDataset(6101),
        candidates: [[1, 2, 3]],
      }),
    ).toThrow(/integer matrix/)
  })

  test('the parser enforces canonical dimensions and generated value ranges', () => {
    expect(() => parseModelDataset(makeDataset(6101, 2, 1))).toThrow(
      /canonical valid widths/,
    )
    expect(() =>
      parseModelDataset({
        ...makeDataset(6101),
        candidates: [
          [2_000, ...Array.from({ length: 23 }, () => 0)],
          ...makeDataset(6101).candidates.slice(1),
        ],
      }),
    ).toThrow(/canonical integer matrix/)
    expect(() =>
      parseModelDataset({ ...makeDataset(6101), weights: Array(24).fill(10) }),
    ).toThrow(/canonical valid widths/)
  })
})
