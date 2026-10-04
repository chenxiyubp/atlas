#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Answer-layer executor for `@qianmo/recall` — `docs/dev/memory-m1.md` §4,
 * D-1 A0–A6 (P16.3). Three modes:
 *
 *   --dry-run   offline token estimate from the real corpora and prompt; no
 *               network, no ledger. Without plan flags it prints the P16.4
 *               trial and the P16.12 comparison, both as preregistered. The
 *               M1 arm's block is built by P16.6's hybrid retrieval on a
 *               stand-in (non-semantic) embedder.
 *   --replay    re-score a recorded run from a fixture; no network. Uses its
 *               own ledger inside the output directory, never the real one.
 *               The M1 arm replays the fixture's recorded embedding vectors.
 *   --live      real calls through the AC-4 request chain. Needs
 *               OPENAI_API_KEY and OPENAI_BASE_URL; without them it prints why
 *               and exits 0 without touching anything. M0 only until the
 *               embedding adapter (P16.7) exists.
 *
 * Usage:
 *   bun run scripts/qianmo-recall-answer-eval.ts --dry-run [plan flags] [--json <path>]
 *   bun run scripts/qianmo-recall-answer-eval.ts --live --phase trial|comparison \
 *       --run-id <id> --out <dir> --cap-input <tokens> --cap-output <tokens> \
 *       [--record <fixture.json>] [--concurrency <n>] [plan flags]
 *   bun run scripts/qianmo-recall-answer-eval.ts --replay <fixture.json> \
 *       --run-id <id> --out <dir> [--phase …] [plan flags]
 *
 * Plans come from packages/recall/eval/prereg.toml: the comparison is `[plan]`
 * and takes no plan flag at all; the trial defaults to `[trial]` and may be
 * narrowed with --corpus <id,…>  --tiers <n,…>  --reps <n>  --arms m0|m0,m1
 * (its numbers never enter a verdict).
 *
 * The token ledger lives at occConfigPath('qianmo', 'recall-eval',
 * 'token-ledger.json'); there is no flag to move it. There is no flag for any
 * preregistered value either: those come from packages/recall/eval/prereg.toml.
 *
 * Exit codes: 0 complete (or skipped), 3 stopped at the token cap (the
 * completed part is written), 4 invalid round (`unreadable`), 1 aborted,
 * 2 usage error.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AnswerPlan,
  answerPlanOf,
  checkPlan,
  m0Retriever,
  REPORT_FILE,
  runAnswerEval,
} from '../packages/recall/eval/answer/runner.js'
import {
  type AnswerEstimate,
  estimateAnswerPlan,
} from '../packages/recall/eval/answer/estimate.js'
import {
  ANSWER_TOKEN_CEILING,
  type Phase,
  TokenLedger,
  TRIAL_TOKEN_CEILING,
} from '../packages/recall/eval/answer/ledger.js'
import {
  type Exchange,
  FIXTURE_SCHEMA,
  readFixture,
  recordingTransport,
  replayTransport,
  writeFixture,
} from '../packages/recall/eval/answer/replay.js'
import type { AnswerReport } from '../packages/recall/eval/answer/report.js'
import { InvalidRound } from '../packages/recall/eval/answer/score.js'
import {
  m1Arm,
  replayEmbedder,
} from '../packages/recall/eval/answer/semantic.js'
import type {
  AnswerTransport,
  Arm,
  ArmRetriever,
} from '../packages/recall/eval/answer/types.js'
import {
  CORPORA,
  type CorpusId,
  isCorpusId,
} from '../packages/recall/eval/corpora.js'
import {
  loadPreregistration,
  PREREGISTRATION_PATH,
  type Preregistration,
  required,
} from '../packages/recall/eval/prereg.js'
import { occConfigPath } from '../src/config/paths.js'
import type { ProviderConfig } from '../src/services/providerRegistry/types.js'
import {
  buildWireBody,
  createLiveTransport,
  liveCredentials,
  loadProviders,
  MAX_TOKENS,
  modelVisibleText,
} from './qianmo-recall-answer-live.js'

type Mode = 'dry-run' | 'live' | 'replay'

type Cli = {
  readonly mode: Mode
  readonly phase: Phase | null
  readonly corpora: readonly CorpusId[] | null
  readonly tiers: readonly number[] | null
  readonly reps: number | null
  readonly arms: readonly Arm[] | null
  readonly runId: string | null
  readonly out: string | null
  readonly capInput: number | null
  readonly capOutput: number | null
  readonly record: string | null
  readonly fixture: string | null
  readonly concurrency: number
  readonly json: string | null
}

class UsageError extends Error {}

/** Where the persistent ledger lives. Derived, never configurable. */
export function ledgerPath(): string {
  return occConfigPath('qianmo', 'recall-eval', 'token-ledger.json')
}

function positiveInteger(flag: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(
      `${flag} expects a positive integer, got ${JSON.stringify(raw)}`,
    )
  }
  return value
}

export function parseCli(argv: readonly string[]): Cli {
  // An object, not a `let`: the writes happen inside `setMode`.
  const chosen: { mode: Mode | null } = { mode: null }
  const cli: {
    -readonly [K in keyof Cli]: Cli[K]
  } = {
    mode: 'dry-run',
    phase: null,
    corpora: null,
    tiers: null,
    reps: null,
    arms: null,
    runId: null,
    out: null,
    capInput: null,
    capOutput: null,
    record: null,
    fixture: null,
    concurrency: 2,
    json: null,
  }
  const setMode = (next: Mode) => {
    if (chosen.mode !== null)
      throw new UsageError('choose one of --dry-run, --live, --replay')
    chosen.mode = next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--dry-run') {
      setMode('dry-run')
      continue
    }
    if (flag === '--live') {
      setMode('live')
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) throw new UsageError(`${flag} needs a value`)
    i += 1
    switch (flag) {
      case '--replay':
        setMode('replay')
        cli.fixture = value
        break
      case '--phase':
        if (value !== 'trial' && value !== 'comparison') {
          throw new UsageError('--phase expects trial|comparison')
        }
        cli.phase = value
        break
      case '--corpus':
        cli.corpora = value.split(',').map(id => {
          if (!isCorpusId(id)) {
            throw new UsageError(
              `--corpus expects ids of ${Object.keys(CORPORA).join(', ')}`,
            )
          }
          return id
        })
        break
      case '--tiers':
        cli.tiers = value.split(',').map(t => positiveInteger(flag, t))
        break
      case '--reps':
        cli.reps = positiveInteger(flag, value)
        break
      case '--arms':
        if (value !== 'm0' && value !== 'm0,m1') {
          throw new UsageError('--arms expects m0 or m0,m1')
        }
        cli.arms = value === 'm0' ? ['m0'] : ['m0', 'm1']
        break
      case '--run-id':
        cli.runId = value
        break
      case '--out':
        cli.out = value
        break
      case '--cap-input':
        cli.capInput = positiveInteger(flag, value)
        break
      case '--cap-output':
        cli.capOutput = positiveInteger(flag, value)
        break
      case '--record':
        cli.record = value
        break
      case '--concurrency':
        cli.concurrency = positiveInteger(flag, value)
        break
      case '--json':
        cli.json = value
        break
      default:
        throw new UsageError(`unknown flag ${flag}`)
    }
  }
  cli.mode = chosen.mode ?? 'dry-run'
  if (cli.mode !== 'dry-run') {
    if (cli.runId === null || cli.out === null) {
      throw new UsageError(`--${cli.mode} needs --run-id and --out`)
    }
    if (cli.phase === null) throw new UsageError(`--${cli.mode} needs --phase`)
  }
  if (
    cli.mode === 'live' &&
    (cli.capInput === null || cli.capOutput === null)
  ) {
    throw new UsageError('--live needs --cap-input and --cap-output (tokens)')
  }
  if (
    cli.mode !== 'live' &&
    (cli.capInput !== null || cli.capOutput !== null)
  ) {
    throw new UsageError('--cap-input / --cap-output belong to --live')
  }
  if (cli.record !== null && cli.mode !== 'live') {
    throw new UsageError('--record belongs to --live')
  }
  if (cli.mode === 'dry-run' && (cli.runId !== null || cli.out !== null)) {
    throw new UsageError('--run-id / --out do not apply to --dry-run')
  }
  return cli
}

/**
 * The plan of a phase: the comparison is `[plan]` as written, and refuses
 * any plan flag; the trial is `[trial]`, narrowed by whatever flags were
 * given.
 */
export function planOf(
  cli: Pick<Cli, 'corpora' | 'tiers' | 'reps' | 'arms'>,
  phase: Phase,
  prereg: Preregistration,
  run: Pick<AnswerPlan, 'runId' | 'concurrency'>,
): AnswerPlan {
  const narrowed =
    cli.corpora !== null ||
    cli.tiers !== null ||
    cli.reps !== null ||
    cli.arms !== null
  if (phase === 'comparison') {
    if (narrowed) {
      throw new UsageError(
        'the comparison plan is prereg.toml [plan]; --corpus / --tiers / --reps / --arms are refused',
      )
    }
    return answerPlanOf(required(prereg.plan, 'plan'), { ...run, phase })
  }
  const base = answerPlanOf(required(prereg.trial, 'trial'), { ...run, phase })
  const ids = cli.corpora ?? base.corpora.map(c => c.id)
  const corpora = ids.map(id => {
    const available = CORPORA[id].tiers
    const preset = base.corpora.find(c => c.id === id)?.tiers ?? [
      Math.min(...available),
    ]
    const tiers =
      cli.tiers === null
        ? preset
        : cli.tiers.filter(tier => available.includes(tier))
    if (tiers.length === 0) {
      throw new UsageError(
        `${id} has none of the tiers ${cli.tiers?.join(',')} (it has ${available.join(',')})`,
      )
    }
    return { id, tiers }
  })
  return {
    ...base,
    corpora,
    repetitions: cli.reps ?? base.repetitions,
    arms: cli.arms ?? base.arms,
  }
}

/** The fixture's providers named by the plan, in the plan's order. */
function providersOf(plan: AnswerPlan): ProviderConfig[] {
  const all = loadProviders()
  return plan.providers.map(id => {
    const provider = all.find(p => p.id === id)
    if (provider === undefined) {
      throw new UsageError(
        `provider ${id} of the plan is not in the AC-5 provider fixture`,
      )
    }
    return provider
  })
}

const fmt = (n: number) => n.toLocaleString('en-US')
const mega = (n: number) => `${(n / 1_000_000).toFixed(2)} M`

const NOT_COUNTED: Readonly<Record<string, string>> = {
  'second rounds after a rejection (only rejected answers get one)':
    '被拒后的第二轮（只有被拒的回答才有）',
  'retries beyond the 20 % margin': '超出 20% 余量的重试',
}

function renderEstimate(
  title: string,
  estimate: AnswerEstimate,
  phase: Phase,
): string {
  const lines = [
    `## ${title}`,
    '',
    `语料 ${estimate.plan.corpora.map(c => `${c.id}[${c.tiers.join('/')}]`).join(' + ')} · 每题每家 ${estimate.plan.repetitions} 次 · 臂 ${estimate.plan.arms.join('+')} · 供应商 ${estimate.plan.providers.join(', ')}`,
    '',
    '| 语料 | 档 | 题型 | 题数 | 调用 | 输入 token 低 | 输入 token 高 | 输出 token 低 | 输出 token 高 |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const row of estimate.rows) {
    lines.push(
      `| ${row.corpus} | ${row.tier} | ${row.kind} | ${row.questions} | ${fmt(row.calls)} | ${fmt(row.input.low)} | ${fmt(row.input.high)} | ${fmt(row.output.low)} | ${fmt(row.output.high)} |`,
    )
  }
  const { total, withMargin } = estimate
  lines.push(
    `| **合计** | | | | **${fmt(total.calls)}** | **${fmt(total.input.low)}** | **${fmt(total.input.high)}** | **${fmt(total.output.low)}** | **${fmt(total.output.high)}** |`,
    `| 含 20% 重试余量 | | | | ${fmt(withMargin.calls)} | ${fmt(withMargin.input.low)} | ${fmt(withMargin.input.high)} | ${fmt(withMargin.output.low)} | ${fmt(withMargin.output.high)} |`,
    '',
    `- 合计：输入 ${mega(total.input.low)}–${mega(total.input.high)}，输出 ${mega(total.output.low)}–${mega(total.output.high)}；含余量输入 ${mega(withMargin.input.low)}–${mega(withMargin.input.high)}，输出 ${mega(withMargin.output.low)}–${mega(withMargin.output.high)}`,
    `- D-7 批准量级：调用 ${fmt(estimate.approved.calls.low)}–${fmt(estimate.approved.calls.high)}，输入 ${mega(estimate.approved.input.low)}–${mega(estimate.approved.input.high)}，输出 ${mega(estimate.approved.output.low)}–${mega(estimate.approved.output.high)}；硬上限 ${mega(estimate.ceiling.input)} / ${mega(estimate.ceiling.output)}`,
    `- 按本计划的平均单次调用，硬上限内能容纳 ${fmt(estimate.callsUnderCeiling.low)}–${fmt(estimate.callsUnderCeiling.high)} 次调用`,
  )
  const limit = phase === 'trial' ? TRIAL_TOKEN_CEILING : estimate.ceiling
  const within = (value: number, cap: number) =>
    value <= cap ? '以内' : '**超出**'
  lines.push(
    `- ${phase === 'trial' ? 'P16.4 子上限（总上限 1/10）' : 'D-7 硬上限'} ${mega(limit.input)} / ${mega(limit.output)}：` +
      `输入上界 ${mega(total.input.high)}（${within(total.input.high, limit.input)}），含余量 ${mega(withMargin.input.high)}（${within(withMargin.input.high, limit.input)}）；` +
      `输出上界 ${mega(total.output.high)}（${within(total.output.high, limit.output)}），含余量 ${mega(withMargin.output.high)}（${within(withMargin.output.high, limit.output)}）`,
  )
  const notCounted = estimate.notCounted.map(note => NOT_COUNTED[note] ?? note)
  lines.push(`- 未计入：${notCounted.join('；')}`)
  if (estimate.embedding !== null) {
    lines.push(
      '- M1 臂：注入块由 P16.6 的混合检索在替身向量（非语义）上选出，反映块的形态与大小，不代表真实 embedding 会选中哪些条目',
      `- M1 臂 embedding（悲观口径，不计入上表与 D-7）：回填 ${fmt(estimate.embedding.backfill)} token（每档一次），查询 ${fmt(estimate.embedding.recall)} token`,
    )
  }
  return lines.join('\n')
}

async function dryRun(cli: Cli): Promise<void> {
  const providers = loadProviders()
  const prereg = loadPreregistration()
  // Only the body's shape depends on the base URL; nothing is sent.
  const measure = (
    request: Parameters<typeof buildWireBody>[1],
    id: string,
  ) => {
    const provider = providers.find(p => p.id === id)
    if (provider === undefined) throw new Error(`no provider ${id}`)
    const baseURL = process.env.OPENAI_BASE_URL ?? provider.baseUrl
    return modelVisibleText(buildWireBody(provider, request, baseURL))
  }
  const phases: [string, Phase][] =
    cli.phase !== null ||
    cli.corpora !== null ||
    cli.tiers !== null ||
    cli.reps !== null ||
    cli.arms !== null
      ? [['按参数的计划', cli.phase ?? 'trial']]
      : [
          ['P16.4 · 30 档试跑（prereg [trial]）', 'trial'],
          ['P16.12 · 对比（prereg [plan]）', 'comparison'],
        ]
  const results: { title: string; phase: Phase; estimate: AnswerEstimate }[] =
    []
  for (const [title, phase] of phases) {
    const plan = planOf(cli, phase, prereg, {
      runId: 'dry-run',
      concurrency: 1,
    })
    const estimate = await estimateAnswerPlan(plan, measure)
    results.push({ title, phase, estimate })
    console.log(renderEstimate(title, estimate, phase))
    console.log('')
  }
  if (cli.json !== null) {
    writeFileSync(cli.json, `${JSON.stringify(results, null, 2)}\n`)
  }
}

function preregistration() {
  const text = readFileSync(PREREGISTRATION_PATH, 'utf8')
  return {
    values: loadPreregistration(),
    sha256: createHash('sha256').update(text).digest('hex'),
  }
}

function exitCodeOf(report: AnswerReport): number {
  switch (report.status) {
    case 'complete':
      return 0
    case 'capped':
      return 3
    case 'invalid':
      return 4
    default:
      return 1
  }
}

function printOutcome(report: AnswerReport, out: string): void {
  const run = report.tokens.ledger.run
  console.log(
    `[answer-eval] status=${report.status} calls=${report.calls.completed}/${report.calls.planned} ` +
      `pairs=${report.calls.pairsCompleted}/${report.calls.pairsPlanned} ` +
      `run tokens=${run.spent.input}/${run.spent.output} of cap ${run.cap.input}/${run.cap.output} ` +
      `report=${join(out, REPORT_FILE)}`,
  )
  if (report.stop !== null) {
    console.log(
      `[answer-eval] stopped: ${report.stop.reason} — ${report.stop.detail}`,
    )
  }
}

async function execute(
  cli: Cli & { runId: string; out: string; phase: Phase },
): Promise<number> {
  const prereg = preregistration()
  const plan = planOf(cli, cli.phase, prereg.values, {
    runId: cli.runId,
    concurrency: cli.concurrency,
  })
  // Refuse an unrunnable plan before the ledger records a run for it.
  try {
    checkPlan(plan, prereg.values)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  if (cli.mode === 'live' && plan.arms.includes('m1')) {
    throw new UsageError(
      'the M1 arm runs with --replay or --dry-run only until the embedding adapter (P16.7) lands; run --arms m0',
    )
  }
  const providers = providersOf(plan)
  const retrievers: Partial<Record<Arm, ArmRetriever>> = { m0: m0Retriever }
  let transports: AnswerTransport[]
  let ledgerFile: string
  let cap: { input: number; output: number }
  const sink: Record<string, Exchange> = {}
  if (cli.mode === 'live') {
    const credentials = liveCredentials()
    if ('skip' in credentials) {
      console.error(
        `[answer-eval] 真调用已跳过：${credentials.skip}。未读写 token 账本。`,
      )
      return 0
    }
    transports = providers.map(provider => {
      const live = createLiveTransport(provider, credentials)
      return cli.record === null ? live : recordingTransport(live, sink)
    })
    ledgerFile = ledgerPath()
    cap = { input: cli.capInput ?? 0, output: cli.capOutput ?? 0 }
  } else {
    const fixture = readFixture(cli.fixture ?? '')
    if (plan.arms.includes('m1')) {
      if (fixture.embeddings === undefined) {
        throw new UsageError(
          'the fixture has no recorded embeddings, so the M1 arm cannot be replayed; run --arms m0',
        )
      }
      retrievers.m1 = m1Arm(replayEmbedder(fixture.embeddings)).retrieve
    }
    transports = providers.map(provider =>
      replayTransport(fixture, {
        providerId: provider.id,
        requestedModel: provider.defaultModel,
        maxOutputTokens: MAX_TOKENS,
      }),
    )
    // Replayed calls cost nothing; the real ledger is not touched.
    ledgerFile = join(cli.out, 'replay-ledger.json')
    cap = cli.phase === 'trial' ? TRIAL_TOKEN_CEILING : ANSWER_TOKEN_CEILING
  }
  const ledger = TokenLedger.open(ledgerFile, {
    runId: cli.runId,
    phase: cli.phase,
    cap,
  })
  try {
    const report = await runAnswerEval(plan, {
      transports,
      retrievers,
      ledger,
      outDir: cli.out,
      prereg,
    })
    printOutcome(report, cli.out)
    return exitCodeOf(report)
  } catch (error) {
    if (!(error instanceof InvalidRound)) throw error
    // The report was written with status `invalid` before the rethrow.
    const written = JSON.parse(
      readFileSync(join(cli.out, REPORT_FILE), 'utf8'),
    ) as AnswerReport
    printOutcome(written, cli.out)
    console.error(`[answer-eval] ${error.message}`)
    return 4
  } finally {
    ledger.close()
    if (cli.record !== null) {
      writeFixture(cli.record, { schema: FIXTURE_SCHEMA, exchanges: sink })
    }
  }
}

if (import.meta.main) {
  let code: number
  try {
    const cli = parseCli(process.argv.slice(2))
    if (cli.mode === 'dry-run') {
      await dryRun(cli)
      code = 0
    } else {
      const { runId, out, phase } = cli
      if (runId === null || out === null || phase === null) {
        throw new UsageError('--run-id, --out and --phase are required')
      }
      code = await execute({ ...cli, runId, out, phase })
    }
  } catch (error) {
    console.error(
      `[answer-eval] ${error instanceof Error ? error.message : String(error)}`,
    )
    code = error instanceof UsageError ? 2 : 1
  }
  process.exit(code)
}
