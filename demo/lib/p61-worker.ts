// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isAbsolute } from 'node:path'
import { arg, emit, intArg } from './cli-args.js'
import { computeChunk, parseModelDataset } from './p61-dataset.js'

const datasetPath = arg('dataset')
if (
  datasetPath === undefined ||
  !isAbsolute(datasetPath) ||
  /[\0\r\n]/.test(datasetPath)
) {
  throw new Error(
    '--dataset must be an absolute path without control characters',
  )
}

const chunk = intArg('chunk', -1)
const of = intArg('of', -1)
const iterations = intArg('iterations', 1)
const dataset = parseModelDataset(await Bun.file(datasetPath).json())
const startedAt = performance.now()
const result = computeChunk(dataset, chunk, of, iterations)
emit({ ...result, elapsedMs: Math.round(performance.now() - startedAt) })
