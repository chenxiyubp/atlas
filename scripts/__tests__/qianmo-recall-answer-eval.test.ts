// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The answer-layer command line (P16.3): the live request is AC-4's, the
 * live mode skips without credentials and touches nothing, the dry run
 * works offline, and no flag can move the ledger or change a preregistered
 * value.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  TokenLedger,
  TRIAL_TOKEN_CEILING,
} from '../../packages/recall/eval/answer/ledger.js'
import {
  type Exchange,
  FIXTURE_SCHEMA,
  recordingTransport,
  writeFixture,
} from '../../packages/recall/eval/answer/replay.js'
import type { AnswerReport } from '../../packages/recall/eval/answer/report.js'
import {
  m0Retriever,
  REPORT_FILE,
  runAnswerEval,
} from '../../packages/recall/eval/answer/runner.js'
import {
  m1Arm,
  standInEmbedder,
} from '../../packages/recall/eval/answer/semantic.js'
import type {
  AnswerRequest,
  AnswerResponse,
  AnswerTransport,
} from '../../packages/recall/eval/answer/types.js'
import { loadPreregistration } from '../../packages/recall/eval/prereg.js'
import {
  contentHash,
  type EmbeddingProvider,
} from '../../packages/recall/src/embedding.js'
import { parseCli, planOf } from '../qianmo-recall-answer-eval.js'
import {
  buildWireBody,
  liveCredentials,
  loadProviders,
  MAX_TOKENS,
  wireByteLength,
} from '../qianmo-recall-answer-live.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(REPO_ROOT, 'scripts/qianmo-recall-answer-eval.ts')

const directories: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-answer-cli-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** The environment minus the credentials and any config-dir override. */
function envWithout(...names: string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of names) delete env[name]
  return env
}

function runCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
) {
  const result = Bun.spawnSync([process.execPath, 'run', CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('the live request is the AC-4 request', () => {
  const system = ['instructions', '<qianmo-memory>block</qianmo-memory>']

  test('max_tokens 8192, one neutral tool, identical across providers, no seed', () => {
    const providers = loadProviders()
    expect(providers.map(p => p.id)).toEqual(['qianmo-deepseek', 'qianmo-alt'])
    const wires = providers.map(provider =>
      buildWireBody(
        provider,
        { system, turns: [{ role: 'user', text: '问题' }] },
        // Only the body's shape depends on it; no endpoint is written here.
        provider.baseUrl,
      ),
    )
    for (const wire of wires) {
      expect(wire['max_tokens'] ?? wire['max_completion_tokens']).toBe(
        MAX_TOKENS,
      )
      expect(wire['seed']).toBeUndefined()
      expect(wire['response_format']).toBeUndefined()
      expect(JSON.stringify(wire['tools'])).toContain('qianmo_memory_answer')
      expect(wireByteLength(wire)).toBeGreaterThan(
        JSON.stringify(system).length,
      )
    }
    expect(JSON.stringify(wires[0]?.['tools'])).toBe(
      JSON.stringify(wires[1]?.['tools']),
    )
  })

  test('the second round carries the model turn and the rejection as the tool result', () => {
    const [deepseek] = loadProviders()
    if (deepseek === undefined) throw new Error('fixture changed')
    const wire = buildWireBody(
      deepseek,
      {
        system,
        turns: [
          { role: 'user', text: '问题' },
          {
            role: 'assistant',
            thinking: '先查一下',
            text: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'qianmo_memory_answer',
                input: { answer: 'a', citations: ['qm-mem-deadbeef00000000'] },
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call-1',
            content: 'The answer was rejected',
          },
        ],
      },
      deepseek.baseUrl,
    )
    const messages = wire['messages'] as Record<string, unknown>[]
    const assistant = messages.find(m => m['role'] === 'assistant')
    const tool = messages.find(m => m['role'] === 'tool')
    expect(JSON.stringify(assistant?.['tool_calls'])).toContain('call-1')
    expect(tool?.['tool_call_id']).toBe('call-1')
    expect(String(tool?.['content'])).toContain('rejected')
  })

  test('credentials come from the environment only', () => {
    expect(liveCredentials({})).toEqual({ skip: 'OPENAI_API_KEY 未设置' })
    expect(liveCredentials({ OPENAI_API_KEY: 'k' })).toEqual({
      skip: 'OPENAI_BASE_URL 未设置',
    })
    expect(
      liveCredentials({
        OPENAI_API_KEY: 'k',
        OPENAI_BASE_URL: 'u',
        QIANMO_PROVIDER_LIVE: '0',
      }),
    ).toEqual({ skip: 'QIANMO_PROVIDER_LIVE=0 —— 显式关闭了真调用' })
    expect(
      liveCredentials({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'u' }),
    ).toEqual({ apiKey: 'k', baseURL: 'u' })
  })
})

describe('command line', () => {
  test('live without credentials: skipped, exit 0, no ledger and no output written', () => {
    const config = scratch()
    const out = join(config, 'out')
    const result = runCli(
      [
        '--live',
        '--phase',
        'trial',
        '--run-id',
        't1',
        '--out',
        out,
        '--cap-input',
        '1000',
        '--cap-output',
        '1000',
      ],
      {
        ...envWithout('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR'),
        OCC_CONFIG_DIR: config,
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('真调用已跳过')
    expect(existsSync(join(config, 'qianmo'))).toBe(false)
    expect(existsSync(out)).toBe(false)
  }, 60_000)

  test('dry run: offline estimate of a small plan', () => {
    const json = join(scratch(), 'estimate.json')
    const result = runCli(
      ['--dry-run', '--corpus', 'docs-dev-v1', '--tiers', '30', '--json', json],
      envWithout('OPENAI_API_KEY'),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('D-7 批准量级')
    const [only] = JSON.parse(readFileSync(json, 'utf8')) as {
      estimate: { total: { calls: number }; rows: { questions: number }[] }
    }[]
    // 20 questions × 2 providers × 1 repetition × M0 only (trial defaults).
    expect(only?.estimate.total.calls).toBe(40)
    expect(only?.estimate.rows.map(r => r.questions)).toEqual([20])
  }, 60_000)

  test('dry run without flags: the preregistered trial (202 calls) and comparison (1 460 calls)', () => {
    const json = join(scratch(), 'estimate.json')
    const result = runCli(
      ['--dry-run', '--json', json],
      envWithout('OPENAI_API_KEY'),
    )
    expect(result.exitCode).toBe(0)
    const [trial, comparison] = JSON.parse(readFileSync(json, 'utf8')) as {
      phase: string
      estimate: {
        total: {
          calls: number
          input: { high: number }
          output: { high: number }
        }
        rows: { corpus: string; tier: number; questions: number }[]
      }
    }[]
    expect(trial?.phase).toBe('trial')
    expect(trial?.estimate.total.calls).toBe(202)
    // Within P16.4's sub-cap of a tenth of 18.5 M / 4.8 M.
    expect(trial?.estimate.total.input.high).toBeLessThanOrEqual(1_850_000)
    expect(trial?.estimate.total.output.high).toBeLessThanOrEqual(480_000)
    expect(comparison?.phase).toBe('comparison')
    expect(comparison?.estimate.total.calls).toBe(1460)
    const perTier = new Map<string, number>()
    for (const row of comparison?.estimate.rows ?? []) {
      const key = `${row.corpus}/${row.tier}`
      perTier.set(key, (perTier.get(key) ?? 0) + row.questions)
    }
    expect(Object.fromEntries(perTier)).toEqual({
      'synthetic-v1/30': 101,
      'synthetic-v1/500': 101,
      'synthetic-v1/2000': 101,
      'docs-dev-v1/599': 62,
    })
  }, 120_000)

  test('the comparison takes no plan flag', () => {
    const result = runCli(
      ['--dry-run', '--phase', 'comparison', '--reps', '3'],
      envWithout('OPENAI_API_KEY'),
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('the comparison plan is prereg.toml [plan]')
  }, 60_000)

  test('no flag moves the ledger or sets a preregistered value', () => {
    for (const flag of ['--ledger', '--alpha', '--delta', '--bootstrap-seed']) {
      expect(() => parseCli([flag, 'x'])).toThrow(/unknown flag/)
    }
    expect(() =>
      parseCli(['--live', '--phase', 'trial', '--run-id', 'r', '--out', 'o']),
    ).toThrow(/--cap-input and --cap-output/)
    expect(() => parseCli(['--live', '--dry-run'])).toThrow(/choose one/)
    expect(parseCli([]).mode).toBe('dry-run')
  })
})

describe('the M1 arm (P16.6): replay and dry run only', () => {
  /** A scripted model that cites the last entry of whatever block it gets. */
  function citeLast(providerId: string): AnswerTransport {
    const respond = (request: AnswerRequest): AnswerResponse => {
      const ids = [...request.system.join('\n').matchAll(/^entry_id: (\S+)$/gm)]
      const last = ids.at(-1)?.[1]
      return {
        model: `${providerId}-model-v1`,
        thinking: '',
        text: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'qianmo_memory_answer',
            input: {
              answer: last === undefined ? '没有记录。' : '见记忆条目。',
              citations: last === undefined ? [] : [last],
            },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 1000, output: 100 },
      }
    }
    return {
      providerId,
      requestedModel: `${providerId}-model`,
      maxOutputTokens: 8192,
      inputUpperBound: () => 2000,
      send: async request => respond(request),
    }
  }

  test('--replay runs the M1 arm on the fixture vectors and reproduces the recorded run', async () => {
    const directory = scratch()
    const prereg = loadPreregistration()
    const plan = planOf(
      { corpora: null, tiers: [500], reps: null, arms: ['m0', 'm1'] },
      'trial',
      prereg,
      { runId: 'm1-cli', concurrency: 2 },
    )
    const identity = {
      id: 'test-embedder',
      model: 'test-v1',
      dimensions: standInEmbedder.dimensions,
    }
    const vectors: Record<string, number[]> = {}
    const embedder: EmbeddingProvider = {
      ...identity,
      embed: async (texts, options) => {
        const batch = await standInEmbedder.embed(texts, options)
        for (const [index, text] of texts.entries()) {
          vectors[contentHash(text)] = [...(batch.vectors[index] ?? [])]
        }
        return batch
      },
    }
    const sink: Record<string, Exchange> = {}
    const ledger = TokenLedger.open(join(directory, 'ledger.json'), {
      runId: plan.runId,
      phase: plan.phase,
      cap: TRIAL_TOKEN_CEILING,
    })
    let recorded: AnswerReport
    try {
      recorded = await runAnswerEval(plan, {
        transports: plan.providers.map(id =>
          recordingTransport(citeLast(id), sink),
        ),
        retrievers: { m0: m0Retriever, m1: m1Arm(embedder).retrieve },
        ledger,
        outDir: join(directory, 'live'),
        prereg: { values: prereg, sha256: 'test' },
      })
    } finally {
      ledger.close()
    }
    expect(recorded.status).toBe('complete')
    // The M1 arm sent its own block: the two arms' requests differ.
    const differing = Object.entries(sink).filter(
      ([key, exchange]) =>
        key.includes('/m1/') &&
        sink[key.replace('/m1/', '/m0/')]?.requestSha256 !==
          exchange.requestSha256,
    )
    expect(differing.length).toBeGreaterThan(0)

    const fixture = join(directory, 'fixture.json')
    writeFixture(fixture, {
      schema: FIXTURE_SCHEMA,
      exchanges: sink,
      embeddings: { embedder: identity, vectors },
    })
    const out = join(directory, 'replay')
    const result = runCli(
      [
        '--replay',
        fixture,
        '--run-id',
        'm1-cli',
        '--out',
        out,
        '--phase',
        'trial',
        '--tiers',
        '500',
        '--arms',
        'm0,m1',
      ],
      envWithout('OPENAI_API_KEY', 'OPENAI_BASE_URL'),
    )
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    const replayed = JSON.parse(
      readFileSync(join(out, REPORT_FILE), 'utf8'),
    ) as AnswerReport
    // 101 questions × 2 providers × 2 arms.
    expect(replayed.calls.completed).toBe(404)
    expect(replayed.summary).toEqual(recorded.summary)
  }, 120_000)

  test('refused with --live, and with a fixture that has no vectors', () => {
    const directory = scratch()
    const live = runCli(
      [
        '--live',
        '--phase',
        'trial',
        '--run-id',
        't1',
        '--out',
        join(directory, 'live'),
        '--cap-input',
        '1000',
        '--cap-output',
        '1000',
        '--arms',
        'm0,m1',
      ],
      {
        ...envWithout('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR'),
        OCC_CONFIG_DIR: directory,
      },
    )
    expect(live.exitCode).toBe(2)
    expect(live.stderr).toContain('--replay or --dry-run only')
    expect(existsSync(join(directory, 'live'))).toBe(false)
    expect(existsSync(join(directory, 'qianmo'))).toBe(false)

    const fixture = join(directory, 'm0-only.json')
    writeFixture(fixture, { schema: FIXTURE_SCHEMA, exchanges: {} })
    const replay = runCli(
      [
        '--replay',
        fixture,
        '--run-id',
        't2',
        '--out',
        join(directory, 'replay'),
        '--phase',
        'trial',
        '--arms',
        'm0,m1',
      ],
      envWithout('OPENAI_API_KEY'),
    )
    expect(replay.exitCode).toBe(2)
    expect(replay.stderr).toContain('no recorded embeddings')
  }, 60_000)

  test('--dry-run sizes the M1 arm with its own block and reports its embedding tokens', () => {
    const directory = scratch()
    const estimate = (arms: string) => {
      const json = join(directory, `${arms}.json`)
      const result = runCli(
        ['--dry-run', '--tiers', '500', '--arms', arms, '--json', json],
        envWithout('OPENAI_API_KEY'),
      )
      expect(result.exitCode).toBe(0)
      const [only] = JSON.parse(readFileSync(json, 'utf8')) as {
        estimate: {
          total: { calls: number; input: { high: number } }
          embedding: { backfill: number; recall: number } | null
        }
      }[]
      return { stdout: result.stdout, estimate: only?.estimate }
    }
    const m0 = estimate('m0')
    const both = estimate('m0,m1')
    expect(m0.estimate?.embedding).toBeNull()
    expect(both.estimate?.total.calls).toBe(2 * (m0.estimate?.total.calls ?? 0))
    // Not M0's prompt counted twice: M1's block is its own.
    expect(both.estimate?.total.input.high).not.toBe(
      2 * (m0.estimate?.total.input.high ?? 0),
    )
    expect(both.estimate?.embedding?.backfill).toBeGreaterThan(0)
    expect(both.estimate?.embedding?.recall).toBeGreaterThan(0)
    expect(both.stdout).toContain('替身向量（非语义）')
    expect(m0.stdout).not.toContain('M1 臂 embedding')
  }, 120_000)
})
