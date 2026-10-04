#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Retrieval-layer baseline for `@qianmo/recall` — `docs/dev/memory-m1.md` §3.
 *
 * Offline and deterministic: no model, no network, no wall clock. It measures
 * which entries `recall()` puts in front of a model, not what a model does
 * with them. The answer layer (hit rate, hallucinated-citation rate) needs a
 * real model and is a separate protocol; nothing printed here is an
 * answer-layer number.
 *
 * Exit code is 0 whenever the run completes. This is a measurement, not a
 * gate: the numbers are not compared against any threshold.
 *
 * Usage:
 *   bun run qianmo:recall-baseline                         # markdown summary
 *   bun run qianmo:recall-baseline --json /tmp/base.json   # also the full report
 *   bun run qianmo:recall-baseline --seed 7 --tiers 30,500 --decay default,off
 *
 * Without `--corpus` this is the v0.1 corpus and the v0.1 report, unchanged:
 * its outputs are the M0 reference published by SHA-256 in §3. The M1
 * corpora (P16.2b) are selected explicitly and run under their own
 * preregistered seeds and tiers, which is why `--seed` / `--tiers` are
 * refused there:
 *   bun run qianmo:recall-baseline --corpus synthetic-v1 [--decay default,off] [--json <path>]
 *   bun run qianmo:recall-baseline --corpus docs-dev-v1
 *   bun run qianmo:recall-baseline --corpus synthetic-v1 --digest   # corpus hash only
 */

import { writeFileSync } from 'node:fs'
import {
  CORPORA,
  type CorpusId,
  isCorpusId,
} from '../packages/recall/eval/corpora.js'
import {
  corpusBaselineJson,
  renderCorpusMarkdown,
  runCorpusBaseline,
} from '../packages/recall/eval/corpus-baseline.js'
import { DEFAULT_SEED, DEFAULT_TIERS } from '../packages/recall/eval/dataset.js'
import {
  type DecayMode,
  renderMarkdown,
  runBaseline,
} from '../packages/recall/eval/run.js'

type Cli = {
  readonly seed: number
  readonly tiers: readonly number[]
  readonly decay: readonly DecayMode[]
  readonly json: string | null
  readonly corpus: CorpusId | null
  readonly digest: boolean
  /** `--seed` or `--tiers` was given. */
  readonly sampling: boolean
}

function parseIntegers(flag: string, raw: string): number[] {
  return raw.split(',').map(part => {
    const value = Number(part.trim())
    if (!Number.isInteger(value)) {
      throw new Error(`${flag} expects integers, got ${JSON.stringify(raw)}`)
    }
    return value
  })
}

function parseDecay(raw: string): DecayMode[] {
  return raw.split(',').map(part => {
    const value = part.trim()
    if (value !== 'default' && value !== 'off') {
      throw new Error(`--decay expects default|off, got ${JSON.stringify(raw)}`)
    }
    return value
  })
}

function parseCli(argv: readonly string[]): Cli {
  let seed = DEFAULT_SEED
  let tiers: readonly number[] = DEFAULT_TIERS
  let decay: readonly DecayMode[] = ['default', 'off']
  let json: string | null = null
  let corpus: CorpusId | null = null
  let digest = false
  let sampling = false
  let decaySet = false
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--digest') {
      digest = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    switch (flag) {
      case '--seed':
        seed = parseIntegers(flag, value)[0] ?? DEFAULT_SEED
        sampling = true
        break
      case '--tiers':
        tiers = parseIntegers(flag, value)
        sampling = true
        break
      case '--decay':
        decay = parseDecay(value)
        decaySet = true
        break
      case '--corpus':
        if (!isCorpusId(value)) {
          throw new Error(
            `--corpus expects one of ${Object.keys(CORPORA).join(', ')}, got ${JSON.stringify(value)}`,
          )
        }
        corpus = value
        break
      case '--json':
        json = value
        break
      default:
        throw new Error(`unknown flag ${flag}`)
    }
    i += 1
  }
  if (corpus !== null && !decaySet) decay = ['default']
  if (digest && corpus === null) throw new Error('--digest needs --corpus')
  return { seed, tiers, decay, json, corpus, digest, sampling }
}

function runCorpus(cli: Cli & { readonly corpus: CorpusId }): void {
  if (cli.sampling) {
    throw new Error(
      '--seed / --tiers are refused with --corpus: an M1 corpus runs under its preregistered seeds and tiers',
    )
  }
  if (cli.digest) {
    console.log(CORPORA[cli.corpus].digest())
    return
  }
  const started = performance.now()
  const report = runCorpusBaseline(cli.corpus, { decay: cli.decay })
  const elapsed = Math.round(performance.now() - started)
  console.log(renderCorpusMarkdown(report))
  if (cli.json !== null) {
    writeFileSync(cli.json, corpusBaselineJson(report))
  }
  console.error(`[recall-baseline] ${cli.corpus} done in ${elapsed} ms`)
}

if (import.meta.main) {
  const cli = parseCli(process.argv.slice(2))
  if (cli.corpus !== null) {
    runCorpus({ ...cli, corpus: cli.corpus })
    process.exit(0)
  }
  const started = performance.now()
  const report = runBaseline(cli)
  const elapsed = Math.round(performance.now() - started)
  console.log(renderMarkdown(report))
  if (cli.json !== null) {
    writeFileSync(cli.json, `${JSON.stringify(report, null, 2)}\n`)
  }
  // Timing goes to stderr so stdout stays byte-identical across runs.
  console.error(`[recall-baseline] done in ${elapsed} ms`)
}
