#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { macroDefineArgs } from './defines.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const RESULT_SCHEMA = 'qianmo.p32.task-result.v1'
const PROXY_CREDENTIAL = ['p32', 'proxy', 'credential'].join('-')
const PROVIDER_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GROK_API_KEY',
  'GROK_BASE_URL',
  'GROK_MODEL',
  'OPENCODE_API_KEY',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
] as const

type TaskKind = 'add-function' | 'fix-bug' | 'add-type'
type FailurePhase =
  | 'configuration'
  | 'clone'
  | 'install'
  | 'fixture'
  | 'baseline'
  | 'agent'
  | 'scope'
  | 'verification'

interface CommandResult {
  readonly command: readonly string[]
  readonly exitCode: number
  readonly durationMs: number
}

interface TaskFailure {
  readonly phase: FailurePhase
  readonly code: string
  readonly message: string
}

interface TaskResult {
  readonly taskId: string
  readonly repository: 'atlas'
  readonly kind: TaskKind
  readonly phase: 'completed' | 'failed'
  readonly allowedFiles: readonly string[]
  readonly changedFiles: readonly string[]
  readonly baselineExitCode: number
  readonly agentExitCode: number | null
  readonly testExitCode: number | null
  readonly sandboxEnforced: boolean
  readonly checks: readonly CommandResult[]
  readonly passed: boolean
  readonly artifacts: {
    readonly directory: string
    readonly agentOutput: string
    readonly patch: string
    readonly testLog: string
  }
  readonly failure: TaskFailure | null
}

interface SuiteResult {
  readonly schemaVersion: typeof RESULT_SCHEMA
  readonly runId: string
  readonly repository: 'atlas'
  readonly sourceCommit: string | null
  readonly provider: {
    readonly kind: 'anthropic-native'
    readonly model: string | null
  }
  readonly startedAt: string
  readonly completedAt: string
  readonly artifactsRoot: string
  readonly tasks: readonly TaskResult[]
  readonly summary: {
    readonly expected: number
    readonly completed: number
    readonly passed: number
    readonly failed: number
    readonly pass: boolean
  }
  readonly failure: TaskFailure | null
}

interface ProviderProxy {
  readonly baseUrl: string
  readonly model: string | null
  readonly secrets: readonly string[]
  stop(): void
}

interface TaskSpec {
  readonly id: string
  readonly kind: TaskKind
  readonly allowedFiles: readonly string[]
  readonly protectedFiles: readonly string[]
  readonly checks: readonly (readonly string[])[]
  readonly prompt: string
  prepare(repo: string): void
}

interface Args {
  readonly taskIds: readonly string[]
  readonly outputBase: string | undefined
}

function replaceOnce(path: string, before: string, after: string): void {
  const content = readFileSync(path, 'utf8')
  const first = content.indexOf(before)
  if (first < 0 || content.indexOf(before, first + before.length) >= 0) {
    throw new Error(`fixture anchor must occur exactly once in ${path}`)
  }
  writeFileSync(path, content.replace(before, after), 'utf8')
}

function insertBeforeLast(
  path: string,
  marker: string,
  addition: string,
): void {
  const content = readFileSync(path, 'utf8')
  const index = content.lastIndexOf(marker)
  if (index < 0) throw new Error(`fixture marker not found in ${path}`)
  writeFileSync(
    path,
    `${content.slice(0, index)}${addition}${content.slice(index)}`,
    'utf8',
  )
}

function removeIfPresent(path: string, value: string): void {
  const content = readFileSync(path, 'utf8')
  if (!content.includes(value)) return
  writeFileSync(path, content.replace(value, ''), 'utf8')
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (content, secret) =>
      secret.length < 4 ? content : content.replaceAll(secret, '[REDACTED]'),
    value,
  )
}

function removeSuccessfulReceiptType(path: string): void {
  const typeDefinition = `
export type SuccessfulReceiptFrame = Omit<ReceiptFrame, 'status' | 'code' | 'reason'> & {
  readonly status: ReceiptStatus.Accepted | ReceiptStatus.Duplicate
}
`
  removeIfPresent(path, typeDefinition)
  removeIfPresent(path, '  type SuccessfulReceiptFrame,\n')
}

function removeAgentOf(repo: string): void {
  const address = join(repo, 'packages/protocol/src/address.ts')
  const index = join(repo, 'packages/protocol/src/index.ts')
  removeIfPresent(
    address,
    `
/** Agent segment of an address string, or \`null\` when malformed. */
export function agentOf(raw: unknown): string | null {
  return parseAddress(raw)?.agent ?? null
}
`,
  )
  removeIfPresent(index, '  agentOf,\n')
}

function restoreJitterBug(path: string): void {
  const content = readFileSync(path, 'utf8')
  const expectedRetryGuard = `    if (
      this.expectedRetryAt !== null &&
      now - this.expectedRetryAt > threshold
    ) {
`
  const lastAttemptGuard =
    '    if (this.lastAttemptAt !== null && now - this.lastAttemptAt > threshold) {\n'
  const fixedSchedule = `    this.attempts += 1
    const delayMs = backoffDelay(this.attempts, this.options, this.random)
    this.expectedRetryAt = now + delayMs
`
  const buggySchedule = `    this.lastAttemptAt = now
    this.attempts += 1
    const delayMs = backoffDelay(this.attempts, this.options, this.random)
`

  if (!content.includes('expectedRetryAt')) return
  if (
    !content.includes(expectedRetryGuard) ||
    !content.includes(fixedSchedule)
  ) {
    throw new Error(`fixed jitter implementation not found in ${path}`)
  }
  const restored = content
    .replace(expectedRetryGuard, lastAttemptGuard)
    .replace(fixedSchedule, buggySchedule)
    .replaceAll('expectedRetryAt', 'lastAttemptAt')
  writeFileSync(path, restored)
}

const TASKS: readonly TaskSpec[] = [
  {
    id: 'protocol-agent-of',
    kind: 'add-function',
    allowedFiles: [
      'packages/protocol/src/address.ts',
      'packages/protocol/src/index.ts',
    ],
    protectedFiles: ['packages/protocol/test/address.test.ts'],
    checks: [
      ['bun', 'test', 'packages/protocol/test/address.test.ts'],
      ['bunx', 'tsc', '-p', 'packages/protocol/tsconfig.json', '--noEmit'],
    ],
    prompt: [
      'Implement the missing `agentOf(raw)` address helper in this Atlas repository.',
      'It must return the agent segment for a valid qianmo address and null for malformed input, matching `nodeOf` semantics.',
      'Export it from the @qianmo/protocol package entry point.',
      'Modify only packages/protocol/src/address.ts and packages/protocol/src/index.ts.',
      'Do not modify tests. Run the focused test and package TypeScript check until both pass.',
    ].join('\n'),
    prepare(repo) {
      removeAgentOf(repo)
      const test = join(repo, 'packages/protocol/test/address.test.ts')
      replaceOnce(test, '  addressEquals,\n', '  addressEquals,\n  agentOf,\n')
      insertBeforeLast(
        test,
        '\n})\n',
        "\n  test('agentOf extracts the agent segment', () => {\n    expect(agentOf('qianmo://edge-7/writer')).toBe('writer')\n    expect(agentOf('garbage')).toBeNull()\n  })\n",
      )
    },
  },
  {
    id: 'transport-jitter-freeze',
    kind: 'fix-bug',
    allowedFiles: ['packages/transport/src/backoff.ts'],
    protectedFiles: ['packages/transport/test/backoff.test.ts'],
    checks: [
      ['bun', 'test', 'packages/transport/test/backoff.test.ts'],
      ['bunx', 'tsc', '-p', 'packages/transport/tsconfig.json', '--noEmit'],
    ],
    prompt: [
      'Fix the reconnect time-jump bug exposed by the new regression test.',
      'With timeJumpFactor 1.1, a retry that fires exactly at its jittered scheduled delay must not be mistaken for a freeze, including the maximum legal +25% jitter at the 30 second ceiling.',
      'A genuinely late 34.7 second E4 thaw still must be detected.',
      'Modify only packages/transport/src/backoff.ts. Do not modify tests.',
      'Run the focused test and package TypeScript check until both pass.',
    ].join('\n'),
    prepare(repo) {
      restoreJitterBug(join(repo, 'packages/transport/src/backoff.ts'))
      const test = join(repo, 'packages/transport/test/backoff.test.ts')
      insertBeforeLast(
        test,
        '\n})\n',
        `
  test('maximum legal jitter is not mistaken for a freeze at factor 1.1', () => {
    const schedule = new ReconnectSchedule(
      { ...DEFAULT_BACKOFF, timeJumpFactor: 1.1 },
      () => 1,
    )
    let now = 0
    for (let index = 0; index < 8; index++) {
      const decision = schedule.next(now)
      expect(decision.action).toBe('retry')
      if (decision.action !== 'retry') break
      expect(decision.timeJumpDetected).toBe(false)
      now += decision.delayMs
    }
  })

  test('a 34.7 second E4 thaw is detected at factor 1.1', () => {
    const schedule = new ReconnectSchedule(
      { ...DEFAULT_BACKOFF, timeJumpFactor: 1.1 },
      noJitter,
    )
    schedule.next(0)
    const decision = schedule.next(34_700)
    expect(decision.action).toBe('retry')
    if (decision.action === 'retry') {
      expect(decision.timeJumpDetected).toBe(true)
    }
  })
`,
      )
    },
  },
  {
    id: 'transport-success-receipt-type',
    kind: 'add-type',
    allowedFiles: [
      'packages/transport/src/frames.ts',
      'packages/transport/src/index.ts',
    ],
    protectedFiles: [
      'packages/transport/test/successful-receipt-status.test.ts',
    ],
    checks: [
      [
        'bun',
        'test',
        'packages/transport/test/successful-receipt-status.test.ts',
      ],
      ['bunx', 'tsc', '-p', 'packages/transport/tsconfig.json', '--noEmit'],
    ],
    prompt: [
      'Add and export a `SuccessfulReceiptFrame` type for transport receipts.',
      'It must be a receipt frame whose status is exactly ReceiptStatus.Accepted | ReceiptStatus.Duplicate; rejected receipts must not be assignable, and successful frames must not expose code or reason fields.',
      'Export it from the @qianmo/transport package entry point.',
      'Modify only packages/transport/src/frames.ts and packages/transport/src/index.ts.',
      'Do not modify tests. Run the focused test and package TypeScript check until both pass.',
    ].join('\n'),
    prepare(repo) {
      removeSuccessfulReceiptType(
        join(repo, 'packages/transport/src/frames.ts'),
      )
      removeSuccessfulReceiptType(join(repo, 'packages/transport/src/index.ts'))
      const path = join(
        repo,
        'packages/transport/test/successful-receipt-status.test.ts',
      )
      writeFileSync(
        path,
        `import { describe, expect, test } from 'bun:test'
import {
  FRAME_VERSION,
  FrameType,
  ReceiptStatus,
  type SuccessfulReceiptFrame,
} from '../src/index.js'

describe('SuccessfulReceiptFrame', () => {
  test('contains only receipts that let the sender retire an envelope', () => {
    const accepted = {
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm-1',
      status: ReceiptStatus.Accepted,
    } satisfies SuccessfulReceiptFrame
    const duplicate = {
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm-2',
      status: ReceiptStatus.Duplicate,
    } satisfies SuccessfulReceiptFrame
    expect([accepted.status, duplicate.status]).toEqual([
      ReceiptStatus.Accepted,
      ReceiptStatus.Duplicate,
    ])

    const rejected = {
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm-3',
      // @ts-expect-error rejected receipts must stay on the error path
      status: ReceiptStatus.Rejected,
    } satisfies SuccessfulReceiptFrame
    expect(String(rejected.status)).toBe('rejected')

    const withCode = {
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm-4',
      status: ReceiptStatus.Accepted,
      // @ts-expect-error successful receipts must not expose error fields
      code: 'E_INTERNAL',
    } satisfies SuccessfulReceiptFrame
    expect(String(withCode.code)).toBe('E_INTERNAL')
  })
})
`,
        'utf8',
      )
    },
  },
]

function parseArgs(argv: readonly string[]): Args {
  let taskIds: readonly string[] = TASKS.map(task => task.id)
  let outputBase: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--tasks') {
      taskIds = (argv[++index] ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    } else if (arg === '--output-dir') {
      const value = argv[++index]
      if (value === undefined || value === '') {
        throw new Error('--output-dir requires a path')
      }
      outputBase = resolve(value)
    } else {
      throw new Error(`unknown option ${String(arg)}`)
    }
  }
  if (taskIds.length === 0) throw new Error('--tasks must not be empty')
  return { taskIds, outputBase }
}

function startProviderProxy(): ProviderProxy {
  const upstreamRaw = process.env['ANTHROPIC_BASE_URL']
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (upstreamRaw === undefined || apiKey === undefined) {
    throw new Error('native provider endpoint and credential are required')
  }
  const model = process.env['ANTHROPIC_MODEL'] ?? null
  const secrets = PROVIDER_ENV_NAMES.flatMap(name => {
    const value = process.env[name]
    return value === undefined ? [] : [value]
  })
  for (const name of PROVIDER_ENV_NAMES) delete process.env[name]
  const upstream = new URL(upstreamRaw)
  if (upstream.username !== '' || upstream.password !== '') {
    secrets.push(upstream.username, upstream.password)
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url)
      const target = new URL(
        `${incoming.pathname}${incoming.search}`,
        upstream.origin,
      )
      const headers = new Headers(request.headers)
      headers.set('x-api-key', apiKey)
      headers.set('authorization', `Bearer ${apiKey}`)
      headers.delete('host')
      return await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : request.body,
        redirect: 'manual',
      })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    model,
    secrets,
    stop: () => server.stop(true),
  }
}

interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function run(
  command: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): ProcessResult {
  const result = Bun.spawnSync([...command], {
    cwd,
    ...(env === undefined ? {} : { env }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

async function runAsync(
  command: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<ProcessResult> {
  const child = Bun.spawn([...command], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function runChecks(
  commands: readonly (readonly string[])[],
  cwd: string,
): {
  readonly results: readonly CommandResult[]
  readonly exitCode: number
  readonly output: string
} {
  const results: CommandResult[] = []
  const output: string[] = []
  let exitCode = 0
  for (const command of commands) {
    const started = Date.now()
    const result = run(command, cwd)
    const durationMs = Date.now() - started
    results.push({ command, exitCode: result.exitCode, durationMs })
    output.push(
      `$ ${command.join(' ')}\n${result.stdout}${result.stderr}`.trimEnd(),
    )
    if (result.exitCode !== 0) exitCode = result.exitCode
  }
  return { results, exitCode, output: `${output.join('\n\n')}\n` }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function changedFiles(repo: string): string[] {
  const result = run(['git', 'status', '--porcelain=v1'], repo)
  if (result.exitCode !== 0) throw new Error(result.stderr.trim())
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const path = line.slice(3)
      const arrow = path.indexOf(' -> ')
      return arrow < 0 ? path : path.slice(arrow + 4)
    })
    .sort()
}

function commitFixture(repo: string, files: readonly string[]): void {
  const add = run(['git', 'add', '--', ...files], repo)
  if (add.exitCode !== 0) throw new Error(add.stderr.trim())
  const commit = run(
    [
      'git',
      '-c',
      'user.name=P3.2 harness',
      '-c',
      'user.email=p32@example.invalid',
      'commit',
      '-q',
      '-m',
      'test: add P3.2 task regression',
    ],
    repo,
  )
  if (commit.exitCode !== 0) throw new Error(commit.stderr.trim())
}

function failure(
  phase: FailurePhase,
  code: string,
  message: string,
): TaskFailure {
  return { phase, code, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failedTask(
  spec: TaskSpec,
  directory: string,
  detail: TaskFailure,
  partial: {
    readonly changedFiles?: readonly string[]
    readonly baselineExitCode?: number
    readonly agentExitCode?: number | null
    readonly testExitCode?: number | null
    readonly checks?: readonly CommandResult[]
  } = {},
): TaskResult {
  return {
    taskId: spec.id,
    repository: 'atlas',
    kind: spec.kind,
    phase: 'failed',
    allowedFiles: spec.allowedFiles,
    changedFiles: partial.changedFiles ?? [],
    baselineExitCode: partial.baselineExitCode ?? 0,
    agentExitCode: partial.agentExitCode ?? null,
    testExitCode: partial.testExitCode ?? null,
    sandboxEnforced: false,
    checks: partial.checks ?? [],
    passed: false,
    artifacts: {
      directory,
      agentOutput: join(directory, 'agent-output.json'),
      patch: join(directory, 'model.patch'),
      testLog: join(directory, 'task-tests.log'),
    },
    failure: detail,
  }
}

async function runTask(
  spec: TaskSpec,
  suiteRoot: string,
  sourceCommit: string,
  proxy: ProviderProxy,
): Promise<TaskResult> {
  const directory = join(suiteRoot, spec.id)
  const repo = join(directory, 'repo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const cloned = run(
    ['git', 'clone', '--quiet', '--no-hardlinks', REPO_ROOT, repo],
    directory,
  )
  if (cloned.exitCode !== 0) {
    return failedTask(
      spec,
      directory,
      failure('clone', 'CLONE_FAILED', cloned.stderr.trim()),
    )
  }
  const checkedOut = run(
    ['git', 'checkout', '--quiet', '--detach', sourceCommit],
    repo,
  )
  if (checkedOut.exitCode !== 0) {
    return failedTask(
      spec,
      directory,
      failure('clone', 'CHECKOUT_FAILED', checkedOut.stderr.trim()),
    )
  }

  const installed = run(['bun', 'install', '--frozen-lockfile'], repo)
  writeFileSync(
    join(directory, 'install.log'),
    redact(`${installed.stdout}${installed.stderr}`, proxy.secrets),
  )
  if (installed.exitCode !== 0) {
    return failedTask(
      spec,
      directory,
      failure(
        'install',
        'INSTALL_FAILED',
        'bun install --frozen-lockfile failed',
      ),
    )
  }

  try {
    spec.prepare(repo)
    commitFixture(repo, [...spec.protectedFiles, ...spec.allowedFiles])
  } catch (error) {
    return failedTask(
      spec,
      directory,
      failure('fixture', 'FIXTURE_FAILED', errorMessage(error)),
    )
  }

  const protectedHashes = new Map(
    spec.protectedFiles.map(path => [path, sha256File(join(repo, path))]),
  )
  const fixtureChanged = changedFiles(repo)
  if (fixtureChanged.length > 0) {
    return failedTask(
      spec,
      directory,
      failure(
        'fixture',
        'FIXTURE_COMMIT_DIRTY',
        `fixture commit left changed files: ${fixtureChanged.join(', ')}`,
      ),
      { changedFiles: fixtureChanged },
    )
  }
  const baseline = runChecks(spec.checks, repo)
  writeFileSync(
    join(directory, 'baseline-tests.log'),
    redact(baseline.output, proxy.secrets),
  )
  if (baseline.exitCode === 0) {
    return failedTask(
      spec,
      directory,
      failure(
        'baseline',
        'BASELINE_NOT_RED',
        'task checks passed before the agent changed production code',
      ),
      { baselineExitCode: baseline.exitCode, checks: baseline.results },
    )
  }

  const configDir = join(directory, 'config')
  const homeDir = join(directory, 'home')
  const tempDir = join(directory, 'tmp')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(configDir, 'settings.json'),
    `${JSON.stringify(
      {
        permissions: {
          allow: [
            `Read(//${repo.replace(/^\//, '')}/**)`,
            ...spec.allowedFiles.map(
              path => `Edit(//${join(repo, path).replace(/^\//, '')})`,
            ),
            'Bash(bun test:*)',
            'Bash(bunx tsc:*)',
            'Bash(bunx biome:*)',
            'Bash(git diff:*)',
            'Bash(git status:*)',
          ],
          deny: [
            `Read(//${homedir().replace(/^\//, '')}/**)`,
            `Edit(//${homedir().replace(/^\//, '')}/**)`,
            `Read(//${REPO_ROOT.replace(/^\//, '')}/**)`,
            `Edit(//${REPO_ROOT.replace(/^\//, '')}/**)`,
          ],
        },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          credentials: true,
          network: {
            allowedDomains: [],
            strictAllowlist: true,
            allowLocalBinding: false,
          },
          filesystem: {
            denyRead: [REPO_ROOT, configDir],
            allowRead: [process.execPath],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  const childEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: homeDir,
    TMPDIR: tempDir,
    SHELL: process.env['SHELL'] ?? '/bin/sh',
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    NO_COLOR: '1',
    CI: '1',
    OCC_DISABLE_RUNTIME_FARM: '1',
    OCC_CONFIG_DIR: configDir,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: PROXY_CREDENTIAL,
    ANTHROPIC_BASE_URL: proxy.baseUrl,
  }

  const prompt = [
    spec.prompt,
    '',
    'This is an isolated clone of the Atlas team repository.',
    `Allowed production files: ${spec.allowedFiles.join(', ')}`,
    `Protected regression files: ${spec.protectedFiles.join(', ')}`,
  ].join('\n')
  // `-d MACRO.*`: the entrypoint is source, and `MACRO.*` only exists after a
  // transpile-time substitution. Without the flags the first read throws
  // (issue #81).
  const agent = await runAsync(
    [
      'bun',
      'run',
      ...macroDefineArgs(),
      join(REPO_ROOT, 'src/entrypoints/cli.tsx'),
      '-p',
      prompt,
      '--tools',
      'Read,Edit,Bash',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'json',
      '--max-turns',
      '30',
    ],
    repo,
    childEnv,
  )
  const agentStdout = redact(agent.stdout, proxy.secrets)
  const agentStderr = redact(agent.stderr, proxy.secrets)
  writeFileSync(join(directory, 'agent-output.json'), agentStdout)
  writeFileSync(join(directory, 'agent-stderr.log'), agentStderr)
  const sandboxEnforced =
    !agentStderr.includes('Sandbox disabled') &&
    !agentStderr.includes('sandbox required but unavailable') &&
    !agentStderr.includes('Sandbox Error')

  const changed = changedFiles(repo)
  const patch = run(['git', 'diff', '--binary'], repo)
  writeFileSync(
    join(directory, 'model.patch'),
    redact(patch.stdout, proxy.secrets),
  )
  const checks = runChecks(spec.checks, repo)
  writeFileSync(
    join(directory, 'task-tests.log'),
    redact(checks.output, proxy.secrets),
  )

  const protectedChanged = spec.protectedFiles.filter(
    path => sha256File(join(repo, path)) !== protectedHashes.get(path),
  )
  const outsideScope = changed.filter(path => !spec.allowedFiles.includes(path))
  let detail: TaskFailure | null = null
  if (!sandboxEnforced) {
    detail = failure(
      'agent',
      'SANDBOX_NOT_ENFORCED',
      'headless sandbox reported unavailable or failed to initialize',
    )
  } else if (agent.exitCode !== 0) {
    detail = failure(
      'agent',
      'AGENT_FAILED',
      `headless agent exited with code ${agent.exitCode}`,
    )
  } else if (protectedChanged.length > 0) {
    detail = failure(
      'scope',
      'PROTECTED_FILE_CHANGED',
      protectedChanged.join(', '),
    )
  } else if (outsideScope.length > 0) {
    detail = failure('scope', 'OUTSIDE_SCOPE', outsideScope.join(', '))
  } else if (checks.exitCode !== 0) {
    detail = failure(
      'verification',
      'TASK_CHECK_FAILED',
      `task checks exited with code ${checks.exitCode}`,
    )
  }

  return {
    taskId: spec.id,
    repository: 'atlas',
    kind: spec.kind,
    phase: detail === null ? 'completed' : 'failed',
    allowedFiles: spec.allowedFiles,
    changedFiles: changed,
    baselineExitCode: baseline.exitCode,
    agentExitCode: agent.exitCode,
    testExitCode: checks.exitCode,
    sandboxEnforced,
    checks: checks.results,
    passed: detail === null,
    artifacts: {
      directory,
      agentOutput: join(directory, 'agent-output.json'),
      patch: join(directory, 'model.patch'),
      testLog: join(directory, 'task-tests.log'),
    },
    failure: detail,
  }
}

function suiteFailure(
  startedAt: string,
  artifactsRoot: string,
  sourceCommit: string | null,
  detail: TaskFailure,
): SuiteResult {
  return {
    schemaVersion: RESULT_SCHEMA,
    runId: artifactsRoot.split('/').at(-1) ?? 'unknown',
    repository: 'atlas',
    sourceCommit,
    provider: {
      kind: 'anthropic-native',
      model: process.env['ANTHROPIC_MODEL'] ?? null,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    artifactsRoot,
    tasks: [],
    summary: { expected: 0, completed: 0, passed: 0, failed: 0, pass: false },
    failure: detail,
  }
}

async function main(): Promise<SuiteResult> {
  const startedAt = new Date().toISOString()
  const runId = `p32-${startedAt.replace(/[:.]/g, '-')}`
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    const root = join(tmpdir(), runId)
    return suiteFailure(
      startedAt,
      root,
      null,
      failure('configuration', 'INVALID_ARGUMENT', errorMessage(error)),
    )
  }

  const base = args.outputBase ?? mkdtempSync(join(tmpdir(), 'qianmo-p32-'))
  mkdirSync(base, { recursive: true, mode: 0o700 })
  chmodSync(base, 0o700)
  const artifactsRoot = join(base, runId)
  mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 })

  const commit = run(['git', 'rev-parse', 'HEAD'], REPO_ROOT)
  const sourceCommit = commit.exitCode === 0 ? commit.stdout.trim() : null
  if (sourceCommit === null) {
    return suiteFailure(
      startedAt,
      artifactsRoot,
      null,
      failure('configuration', 'SOURCE_COMMIT_FAILED', commit.stderr.trim()),
    )
  }
  const selected: TaskSpec[] = []
  for (const id of args.taskIds) {
    const spec = TASKS.find(task => task.id === id)
    if (spec === undefined) {
      return suiteFailure(
        startedAt,
        artifactsRoot,
        sourceCommit,
        failure('configuration', 'UNKNOWN_TASK', id),
      )
    }
    selected.push(spec)
  }
  if (!process.env['ANTHROPIC_API_KEY']) {
    return suiteFailure(
      startedAt,
      artifactsRoot,
      sourceCommit,
      failure(
        'configuration',
        'MISSING_PROVIDER_CREDENTIAL',
        'ANTHROPIC_API_KEY is required and is never written to artifacts',
      ),
    )
  }

  let proxy: ProviderProxy
  try {
    proxy = startProviderProxy()
  } catch (error) {
    return suiteFailure(
      startedAt,
      artifactsRoot,
      sourceCommit,
      failure('configuration', 'PROVIDER_PROXY_FAILED', errorMessage(error)),
    )
  }
  const tasks: TaskResult[] = []
  try {
    for (const spec of selected) {
      try {
        tasks.push(await runTask(spec, artifactsRoot, sourceCommit, proxy))
      } catch (error) {
        tasks.push(
          failedTask(
            spec,
            join(artifactsRoot, spec.id),
            failure(
              'verification',
              'INTERNAL_ERROR',
              redact(errorMessage(error), proxy.secrets),
            ),
          ),
        )
      }
    }
  } finally {
    proxy.stop()
  }
  const passed = tasks.filter(task => task.passed).length
  const summary = {
    expected: selected.length,
    completed: tasks.length,
    passed,
    failed: tasks.length - passed,
    pass: tasks.length === selected.length && passed === selected.length,
  }
  return {
    schemaVersion: RESULT_SCHEMA,
    runId,
    repository: 'atlas',
    sourceCommit,
    provider: {
      kind: 'anthropic-native',
      model: proxy.model,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    artifactsRoot,
    tasks,
    summary,
    failure: null,
  }
}

const result = await main()
mkdirSync(result.artifactsRoot, { recursive: true, mode: 0o700 })
writeFileSync(
  join(result.artifactsRoot, 'report.json'),
  `${JSON.stringify(result, null, 2)}\n`,
)
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exit(result.summary.pass ? 0 : 1)
