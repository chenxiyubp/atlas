// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm watch --sign` against a real `qm resident`, end to end (P13.6).
 *
 * ## Why this file exists
 *
 * A fleet survey ran a watch job through this path with a real model. Delivery,
 * receipt and audit were all green. The job still did nothing, for three
 * separate reasons:
 *
 * 1. `qm watch` signed nothing, so the node recorded
 *    `capability_shadow_refusal` (`task.request from hub needs write-limited,
 *    presented read`). Under the enforcing policy it would have refused;
 * 2. so the agent was handed the untrusted notice, and it declined the job;
 * 3. the node's per-tool steps reached the hub as `notify{kind:'task'}` and
 *    were printed like notifications, although a watch job must stay silent
 *    unless the agent itself calls `qianmo_notify` (§4.1⑤).
 *
 * The unit tests in `src/cli/handlers/__tests__/watch.test.ts` cover each
 * piece. This file checks that the shipped entrypoints wire them together.
 *
 * ## What is real, and the one thing that is not
 *
 * **Real**: `qm watch` and `qm resident`, each its own process from source
 * with the shipped defines and feature list, and each with its own throwaway
 * config root. They talk over a loopback port. The node runs its real ACP child
 * in its default `dontAsk` mode, with the real permission pipeline, the real
 * `Bash` tool running `df -P /`, the real `qianmo_notify` tool, and both audit
 * trails. No `mock.module`.
 *
 * **Not real**: the model. `fixtures/watch-model-double.ts` stands in for it
 * and is deterministic. It reads the notice tier from its prompt, the way the
 * ACP fixture next to the resident tests does, and declines on the untrusted
 * one. So "the node told the agent it was verified" is asserted from what the
 * model actually received.
 *
 * ## Why the node runs `--open-policy --audit-signed-tasks`
 *
 * That is the posture the survey found, and it is the only one where an
 * unsigned request is admitted *and* recorded. The unsigned run below is the
 * negative control: without it, "zero shadow refusals" would also be true of a
 * node that never wrote any.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type AuditRecord, readTrail } from '@qianmo/audit'
import { getMacroDefines, resolveBuildFeatures } from '../../scripts/defines.js'
import {
  EMPTY_JOB_MARKER,
  type ModelDouble,
  RUNBOOK_FILE,
  RUNBOOK_MARKER,
  UNTRUSTED_DIRECTIVE,
  VERIFIED_DIRECTIVE,
  startWatchModelDouble,
} from './fixtures/watch-model-double.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../..')
const CLI_ENTRYPOINT = join(PROJECT_ROOT, 'src/entrypoints/cli.tsx')
const PSK = 'qianmo-watch-signed-e2e-psk-0000000000'
const NODE = 'beta-1'
const AGENT = 'reviewer'
const TARGET = `qianmo://${NODE}/${AGENT}`
const HUB_FROM = 'qianmo://hub/console'

/** A cold `bun` boot of the entrypoint on a loaded CI runner. */
const BOOT_TIMEOUT_MS = 90_000
/** One job: dial, turn with two or three model round trips, answer. */
const JOB_TIMEOUT_MS = 90_000
const FILE_TIMEOUT_MS = 420_000

/** The same list the startup-probe test drops, for the same reason. */
const INHERITED_KEYS_TO_DROP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CI',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'GEMINI_API_KEY',
  'GROK_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'XAI_API_KEY',
  'OCC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
]

/** `bun run -d… --feature… src/entrypoints/cli.tsx`, as `scripts/dev.ts` does. */
function cliPrefix(): readonly string[] {
  const defines = {
    ...getMacroDefines(),
    // What the shipped bundle substitutes in; `bun test` would export `test`.
    'process.env.NODE_ENV': JSON.stringify('production'),
  }
  return [
    'run',
    ...Object.entries(defines).flatMap(([key, value]) => [
      '-d',
      `${key}:${String(value)}`,
    ]),
    ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
    CLI_ENTRYPOINT,
  ]
}

function childEnv(
  configDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of INHERITED_KEYS_TO_DROP) delete env[key]
  return {
    ...env,
    NODE_ENV: 'production',
    OCC_IDENTITY: 'qianmo',
    OCC_CONFIG_DIR: configDir,
    QIANMO_TRANSPORT_PSK: PSK,
    NO_COLOR: '1',
    ...extra,
  }
}

interface Running {
  readonly child: ChildProcess
  stdout(): string
  stderr(): string
  stop(): Promise<void>
}

const running: Running[] = []

function start(args: readonly string[], env: Record<string, string>): Running {
  const child = spawn(process.execPath, [...cliPrefix(), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', chunk => {
    stderr += String(chunk)
  })
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  const handle: Running = {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const killer = setTimeout(() => child.kill('SIGKILL'), 5_000)
        await exited
        clearTimeout(killer)
      }
    },
  }
  running.push(handle)
  return handle
}

async function runToEnd(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const handle = start(args, env)
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    await new Promise<void>(done => handle.child.once('exit', () => done()))
  }
  return {
    code: handle.child.exitCode,
    stdout: handle.stdout(),
    stderr: handle.stderr(),
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs: number,
  diagnose: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`timed out waiting for ${what}\n${diagnose()}`)
}

async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => done(port))
    })
  })
}

async function accepts(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data() {} },
    })
    socket.end()
    return true
  } catch {
    return false
  }
}

function trail(configDir: string): readonly AuditRecord[] {
  return readTrail(join(configDir, 'qianmo', 'audit', 'trail.ndjson')).records
}

function forJob(
  records: readonly AuditRecord[],
  kind: string,
  jobId: string,
): readonly AuditRecord[] {
  return records.filter(
    record => record.kind === kind && record.detail?.contextId === jobId,
  )
}

let root = ''
let hubConfig = ''
let nodeConfig = ''
let port = 0
let hubPublicKey = ''
let model: ModelDouble
let node: Running

/** What one `qm watch` run left behind. */
interface JobRun {
  readonly stdout: string
  readonly stderr: string
  readonly hub: readonly AuditRecord[]
  readonly nodeTrail: readonly AuditRecord[]
  /** The prompt text the model received for this job's turn. */
  readonly prompts: readonly string[]
  readonly steps: ReturnType<ModelDouble['steps']>
}

/**
 * Fire one job through a long-running `qm watch`, wait for its result, stop.
 *
 * Long-running rather than `--once` on purpose: `--once` closes the link as
 * soon as the request is receipted, and a notification needs that link to come
 * back down (H-2: the node never dials). A `--once` run would see no
 * notification whatever the agent did, and the "zero" below would be vacuous.
 */
async function runJob(input: {
  readonly id: string
  readonly threshold: number
  readonly sign: boolean
  /** Replaces the disk-check prompt. */
  readonly prompt?: string
}): Promise<JobRun> {
  const jobsPath = join(root, `${input.id}.json`)
  writeFileSync(
    jobsPath,
    JSON.stringify([
      {
        id: input.id,
        title: 'root filesystem usage',
        target: TARGET,
        url: `ws://127.0.0.1:${port}`,
        prompt:
          input.prompt ??
          `WATCH-DF threshold=${input.threshold}. Run \`df -P /\`. If the ` +
            'root filesystem is at or above the threshold percentage, call ' +
            'qianmo_notify with kind=watch, severity=warn, dedupKey "/". ' +
            'Otherwise do nothing and just finish.',
        // Not anchored: the first plan fires at once, the next is an hour out.
        schedule: { everyMs: 3_600_000 },
        taskTtlMs: 120_000,
        notifyPolicy: 'agent-initiated',
      },
    ]),
  )
  const stepsBefore = model.steps().length
  const requestsBefore = model.requests().length
  const hub = start(
    [
      'watch',
      '--jobs',
      jobsPath,
      '--from',
      HUB_FROM,
      '--state-dir',
      join(root, `state-${input.id}`),
      ...(input.sign ? ['--sign'] : []),
    ],
    childEnv(hubConfig),
  )
  const diagnose = (): string =>
    `--- watch stdout\n${hub.stdout()}\n--- watch stderr\n${hub.stderr()}` +
    `\n--- node stderr (tail)\n${node.stderr().slice(-4000)}` +
    `\n--- model steps\n${JSON.stringify(model.steps().slice(stepsBefore))}`
  await waitFor(
    () =>
      forJob(trail(hubConfig), 'watch_result_received', input.id).length > 0,
    `the result of ${input.id}`,
    JOB_TIMEOUT_MS,
    diagnose,
  )
  // Every notify the turn raised was sent before the turn ended, but the
  // node's receipts are asynchronous. Jobs run one at a time here, so waiting
  // until everything the node ever sent is receipted makes the counts below
  // final. (The node's notify records carry no contextId to filter by.)
  await waitFor(
    () => {
      const records = trail(nodeConfig)
      const sent = records.filter(r => r.kind === 'notify_sent').length
      const delivered = records.filter(
        r => r.kind === 'notify_delivered',
      ).length
      return delivered >= sent
    },
    `the node's notifications for ${input.id} to be receipted`,
    JOB_TIMEOUT_MS,
    diagnose,
  )
  await hub.stop()
  const prompts = model
    .requests()
    .slice(requestsBefore)
    .map(body => JSON.stringify(body.messages ?? []))
    .filter(text => text.includes(`WATCH-DF threshold=${input.threshold}`))
  return {
    stdout: hub.stdout(),
    stderr: hub.stderr(),
    hub: trail(hubConfig),
    nodeTrail: trail(nodeConfig),
    prompts,
    steps: model.steps().slice(stepsBefore),
  }
}

function shadowRefusals(
  records: readonly AuditRecord[],
): readonly AuditRecord[] {
  return records.filter(record => record.kind === 'capability_shadow_refusal')
}

function notifyLines(stdout: string): readonly string[] {
  return stdout.split('\n').filter(line => line.startsWith('[notify]'))
}

/** Each tool the double called, and whether it got real output back. */
function toolResults(
  run: JobRun,
): readonly { readonly tool: string; readonly ok: boolean }[] {
  return run.steps.flatMap(step =>
    step.kind === 'tool-result' ? [{ tool: step.tool, ok: step.ok }] : [],
  )
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-watch-signed-'))
  hubConfig = join(root, 'hub-config')
  nodeConfig = join(root, 'node-config')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // What the double's Read and Grep look for, inside the agent's own
  // workspace, which is the scope a read needs no permission for.
  writeFileSync(
    join(workspace, RUNBOOK_FILE),
    `# disk watch\n${RUNBOOK_MARKER}: page only above the threshold\n`,
  )
  model = startWatchModelDouble()

  // Step 1 of the rollout order: read the hub's key without starting anything.
  const printed = await runToEnd(
    ['watch', '--print-identity', '--from', HUB_FROM],
    childEnv(hubConfig),
  )
  expect(printed.code).toBe(0)
  const line = printed.stdout.trim()
  expect(line).toMatch(/^hub=[A-Za-z0-9_-]{43}$/)
  hubPublicKey = line.slice('hub='.length)

  // Step 2: the node trusts that key. Default session mode (no
  // --allow-workspace-edits): a read-only check must not need write access.
  port = await freePort()
  node = start(
    [
      'resident',
      '--node',
      NODE,
      '--team',
      'nest',
      '--agent',
      `${AGENT}=${workspace}`,
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--open-policy',
      '--audit-signed-tasks',
      '--trust',
      `hub=${hubPublicKey}`,
    ],
    childEnv(nodeConfig, {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'sk-watch-model-double',
      OPENAI_BASE_URL: model.baseUrl,
      OPENAI_MODEL: 'watch-model-double',
      OPENAI_WIRE_API: 'chat',
    }),
  )
  await waitFor(
    () => accepts(port),
    'the node to listen',
    BOOT_TIMEOUT_MS,
    () =>
      `--- node stdout\n${node.stdout()}\n--- node stderr\n${node.stderr()}`,
  )
}, FILE_TIMEOUT_MS)

afterAll(async () => {
  for (const handle of running.splice(0)) await handle.stop()
  await model?.stop()
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('qm watch --sign against a real qm resident', () => {
  test(
    'a signed job with nothing wrong runs the check, is trusted, and tells nobody',
    async () => {
      const run = await runJob({ id: 'disk-quiet', threshold: 101, sign: true })

      // Signed: the banner says so, the fire says so, and the node saw nothing
      // it would have refused.
      expect(run.stdout).toContain(
        `[watch] signing task requests as hub=${hubPublicKey} (write-limited)`,
      )
      expect(run.stderr).not.toContain('NOT signed')
      const fires = run.hub.filter(
        record =>
          record.kind === 'watch_fire' && record.detail?.jobId === 'disk-quiet',
      )
      expect(fires.map(record => record.detail?.signed)).toEqual([true])
      expect(shadowRefusals(run.nodeTrail)).toHaveLength(0)

      // Trusted: what the model received is the verified notice.
      expect(run.prompts.length).toBeGreaterThan(0)
      expect(run.prompts.join('\n')).toContain(VERIFIED_DIRECTIVE)
      expect(run.prompts.join('\n')).toContain(
        '\\"trust\\":\\"verified-capability\\"',
      )
      expect(run.prompts.join('\n')).not.toContain(UNTRUSTED_DIRECTIVE)

      // Executed, in the default dontAsk session mode, which gives no write
      // access. Read and Grep inside the workspace and `df -P /` all ran, and
      // their output came back to the model. A refused tool would show up here
      // as `ok: false` with the refusal text.
      expect(toolResults(run)).toEqual([
        { tool: 'Read', ok: true },
        { tool: 'Grep', ok: true },
        { tool: 'Bash', ok: true },
      ])
      expect(run.steps.map(step => step.kind)).toContain('quiet')

      // Silent: nothing for a person. The three tool steps did reach the hub,
      // so the zero does not come from an empty channel.
      expect(notifyLines(run.stdout)).toEqual([])
      expect(
        forJob(run.hub, 'watch_notify_received', 'disk-quiet'),
      ).toHaveLength(0)
      expect(
        forJob(run.hub, 'watch_step_received', 'disk-quiet').length,
      ).toBeGreaterThanOrEqual(3)
      const results = forJob(run.hub, 'watch_result_received', 'disk-quiet')
      expect(results.map(record => record.detail?.result)).toEqual([
        'completed',
      ])
    },
    FILE_TIMEOUT_MS,
  )

  test(
    'a signed job that finds the condition sends exactly one kind=watch notification',
    async () => {
      const run = await runJob({ id: 'disk-alert', threshold: 0, sign: true })

      expect(shadowRefusals(run.nodeTrail)).toHaveLength(0)
      expect(toolResults(run).every(result => result.ok)).toBe(true)
      expect(run.steps.map(step => step.kind)).toContain('notified')

      const toPerson = forJob(run.hub, 'watch_notify_received', 'disk-alert')
      expect(toPerson).toHaveLength(1)
      expect(toPerson[0]?.detail).toMatchObject({
        kind: 'watch',
        severity: 'warn',
      })
      const lines = notifyLines(run.stdout)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('warn disk-alert root filesystem at')
      // The tool steps still reached the hub, as process data only.
      expect(
        forJob(run.hub, 'watch_step_received', 'disk-alert').length,
      ).toBeGreaterThanOrEqual(3)
    },
    FILE_TIMEOUT_MS,
  )

  test(
    'a job whose model keeps answering with nothing fails, and the hub can tell why',
    async () => {
      // beta-5, 2026-09-27: the gateway answered HTTP 200 with a finish_reason
      // and no content. The node crashed the turn (`-32603 Internal error`);
      // fixing only the crash made the same turn a silent `completed` with an
      // empty body. What must hold instead: a bounded retry, then a failure
      // the hub records as such and can tell apart from any other failure.
      const run = await runJob({
        id: 'disk-empty',
        threshold: 0,
        sign: true,
        prompt: `${EMPTY_JOB_MARKER}: run \`df -P /\` and report the usage.`,
      })

      // One request and two retries, all empty.
      expect(run.steps.filter(step => step.kind === 'empty')).toHaveLength(3)
      const results = forJob(run.hub, 'watch_result_received', 'disk-empty')
      expect(results.map(record => record.detail?.result)).toEqual(['failed'])
      expect(results[0]?.code).toBe('E_TASK_FAILED')
      expect(results[0]?.detail?.failure).toBe('model_empty_response')
      expect(String(results[0]?.detail?.reason)).toMatch(
        /^Model returned only empty responses; retries exhausted: .*finish_reason=stop/,
      )
      expect(notifyLines(run.stdout)).toEqual([])
    },
    FILE_TIMEOUT_MS,
  )

  test(
    'negative control: the same job unsigned warns at startup, is shadow-refused, and is declined',
    async () => {
      const before = shadowRefusals(trail(nodeConfig)).length
      const run = await runJob({
        id: 'disk-unsigned',
        threshold: 0,
        sign: false,
      })

      expect(run.stderr).toContain(
        '[watch] warning: task requests are NOT signed',
      )
      const fires = run.hub.filter(
        record =>
          record.kind === 'watch_fire' &&
          record.detail?.jobId === 'disk-unsigned',
      )
      expect(fires.map(record => record.detail?.signed)).toEqual([false])

      const refusals = shadowRefusals(run.nodeTrail).slice(before)
      expect(refusals.map(record => record.detail?.reason)).toEqual([
        'task.request from hub needs write-limited, presented read',
      ])
      expect(run.prompts.join('\n')).toContain(UNTRUSTED_DIRECTIVE)
      expect(run.steps.map(step => step.kind)).toEqual(['declined-untrusted'])
      expect(notifyLines(run.stdout)).toEqual([])
      expect(
        forJob(run.hub, 'watch_notify_received', 'disk-unsigned'),
      ).toHaveLength(0)
    },
    FILE_TIMEOUT_MS,
  )
})
