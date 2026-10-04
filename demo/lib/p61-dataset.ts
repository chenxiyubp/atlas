// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'

export const P61_DATASET_SCHEMA = 'qianmo.p61.dataset.v1' as const
export const DEFAULT_P61_DATASET_SEED = 6101
export const DEFAULT_P61_ROWS = 96
export const DEFAULT_P61_FEATURES = 24

export interface ModelDataset {
  readonly schema: typeof P61_DATASET_SCHEMA
  readonly seed: number
  readonly target: readonly number[]
  readonly weights: readonly number[]
  readonly candidates: readonly (readonly number[])[]
}

export interface ChunkResult {
  readonly chunk: number
  readonly of: number
  readonly start: number
  readonly end: number
  readonly iterations: number
  readonly bestIndex: number
  readonly bestScore: number
  readonly checksum: number
}

export interface ModelSolution {
  readonly bestIndex: number
  readonly bestScore: number
  readonly digest: string
}

const JSON_LINE_WIDTH = 80

function formatIntegerLines(
  values: readonly number[],
  indentation: number,
): string {
  const prefix = ' '.repeat(indentation)
  const lines: string[] = []
  let line = prefix
  for (const [index, value] of values.entries()) {
    const token = `${value}${index === values.length - 1 ? '' : ','}`
    if (line.length === indentation) {
      line += token
    } else if (line.length + token.length + 1 <= JSON_LINE_WIDTH) {
      line += ` ${token}`
    } else {
      lines.push(line)
      line = `${prefix}${token}`
    }
  }
  lines.push(line)
  return lines.join('\n')
}

export function serializeModelDataset(dataset: ModelDataset): string {
  const candidates = dataset.candidates
    .map(
      (candidate, index) =>
        `    [\n${formatIntegerLines(candidate, 6)}\n    ]${index === dataset.candidates.length - 1 ? '' : ','}`,
    )
    .join('\n')
  return `{
  "schema": "${dataset.schema}",
  "seed": ${dataset.seed},
  "target": [
${formatIntegerLines(dataset.target, 4)}
  ],
  "weights": [
${formatIntegerLines(dataset.weights, 4)}
  ],
  "candidates": [
${candidates}
  ]
}\n`
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`)
  return value
}

function makeRandom(initial: number): () => number {
  let state = initial === 0 ? 1 : initial >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
}

export function makeDataset(
  seed: number,
  rows = DEFAULT_P61_ROWS,
  features = DEFAULT_P61_FEATURES,
): ModelDataset {
  positiveInteger(rows, 'rows')
  positiveInteger(features, 'features')
  if (!Number.isInteger(seed)) throw new RangeError('seed must be an integer')

  const random = makeRandom(seed)
  const target = Array.from({ length: features }, () => random() % 1_000)
  const weights = Array.from({ length: features }, () => 1 + (random() % 9))
  const candidates = Array.from({ length: rows }, () =>
    Array.from({ length: features }, () => random() % 1_000),
  )
  return { schema: P61_DATASET_SCHEMA, seed, target, weights, candidates }
}

function integerArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(entry => Number.isInteger(entry))
  )
}

export function parseModelDataset(value: unknown): ModelDataset {
  if (typeof value !== 'object' || value === null)
    throw new TypeError('dataset must be an object')
  const record = value as Record<string, unknown>
  if (record.schema !== P61_DATASET_SCHEMA)
    throw new TypeError(`dataset schema must be ${P61_DATASET_SCHEMA}`)
  const { seed, target, weights, candidates } = record
  if (typeof seed !== 'number' || !Number.isInteger(seed))
    throw new TypeError('dataset seed must be an integer')
  if (!integerArray(target) || !integerArray(weights))
    throw new TypeError('dataset target and weights must be integer arrays')
  if (
    target.length !== DEFAULT_P61_FEATURES ||
    weights.length !== DEFAULT_P61_FEATURES ||
    target.some(entry => entry < 0 || entry >= 1_000) ||
    weights.some(weight => weight < 1 || weight > 9)
  ) {
    throw new TypeError(
      'dataset target and weights must have canonical valid widths and ranges',
    )
  }
  if (
    !Array.isArray(candidates) ||
    candidates.length !== DEFAULT_P61_ROWS ||
    !candidates.every(
      candidate =>
        integerArray(candidate) &&
        candidate.length === DEFAULT_P61_FEATURES &&
        candidate.every(entry => entry >= 0 && entry < 1_000),
    )
  ) {
    throw new TypeError('dataset candidates must be a canonical integer matrix')
  }
  return {
    schema: P61_DATASET_SCHEMA,
    seed,
    target,
    weights,
    candidates: candidates as number[][],
  }
}

export function chunkBounds(
  length: number,
  chunk: number,
  of: number,
): { readonly start: number; readonly end: number } {
  positiveInteger(length, 'length')
  positiveInteger(of, 'of')
  if (of > length) throw new RangeError('of cannot exceed the dataset length')
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= of)
    throw new RangeError(`chunk must be in [0, ${of})`)
  return {
    start: Math.floor((chunk * length) / of),
    end: Math.floor(((chunk + 1) * length) / of),
  }
}

export function scoreCandidate(
  dataset: ModelDataset,
  candidateIndex: number,
): number {
  const candidate = dataset.candidates[candidateIndex]
  if (candidate === undefined)
    throw new RangeError(`candidate ${candidateIndex} is out of range`)
  let score = 0
  for (let index = 0; index < dataset.target.length; index += 1) {
    score +=
      Math.abs(
        (candidate[index] as number) - (dataset.target[index] as number),
      ) * (dataset.weights[index] as number)
  }
  return score
}

export function computeChunk(
  dataset: ModelDataset,
  chunk: number,
  of: number,
  iterations = 1,
): ChunkResult {
  positiveInteger(iterations, 'iterations')
  const { start, end } = chunkBounds(dataset.candidates.length, chunk, of)
  let bestIndex = -1
  let bestScore = Number.POSITIVE_INFINITY
  let checksum = 2_166_136_261

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (
      let candidateIndex = start;
      candidateIndex < end;
      candidateIndex += 1
    ) {
      const score = scoreCandidate(dataset, candidateIndex)
      checksum = Math.imul(
        checksum ^ (score + candidateIndex + iteration),
        16_777_619,
      )
      checksum >>>= 0
      if (
        iteration === 0 &&
        (score < bestScore ||
          (score === bestScore && candidateIndex < bestIndex))
      ) {
        bestIndex = candidateIndex
        bestScore = score
      }
    }
  }

  return {
    chunk,
    of,
    start,
    end,
    iterations,
    bestIndex,
    bestScore,
    checksum,
  }
}

export function combineChunkResults(
  results: readonly ChunkResult[],
): ModelSolution {
  if (results.length === 0) throw new RangeError('results cannot be empty')
  const ordered = [...results].sort((left, right) => left.chunk - right.chunk)
  let bestIndex = -1
  let bestScore = Number.POSITIVE_INFINITY
  for (const result of ordered) {
    if (
      result.bestScore < bestScore ||
      (result.bestScore === bestScore && result.bestIndex < bestIndex)
    ) {
      bestIndex = result.bestIndex
      bestScore = result.bestScore
    }
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(ordered))
    .digest('hex')
  return { bestIndex, bestScore, digest }
}

export function expectedSolution(
  dataset: ModelDataset,
  chunks: number,
  iterations: number,
): ModelSolution {
  return combineChunkResults(
    Array.from({ length: chunks }, (_, chunk) =>
      computeChunk(dataset, chunk, chunks, iterations),
    ),
  )
}
