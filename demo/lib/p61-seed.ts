// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { arg, emit, intArg } from './cli-args.js'
import {
  DEFAULT_P61_DATASET_SEED,
  makeDataset,
  serializeModelDataset,
} from './p61-dataset.js'

if (!process.argv.includes('--reset')) {
  throw new Error('p61-seed only writes with the explicit --reset flag')
}

const output = resolve(
  arg('output') ?? join(import.meta.dir, '..', 'p61-data', 'model-input.json'),
)
if (/[\0\r\n]/.test(output))
  throw new Error('--output must not contain control characters')
const seed = intArg('seed', DEFAULT_P61_DATASET_SEED)
const dataset = makeDataset(seed)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, serializeModelDataset(dataset), { mode: 0o644 })
emit({
  schema: dataset.schema,
  seed: dataset.seed,
  rows: dataset.candidates.length,
  features: dataset.target.length,
  output,
})
