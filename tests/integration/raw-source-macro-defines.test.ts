// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a source run of the CLI actually puts on the wire.
//
// Every other view of the system prompt in this repository is mocked. The
// regression test that owns the feedback sentence
// (`src/constants/promptEngineeringAudit.runner.ts`) and the only tool that
// renders the whole prompt (`scripts/dump-prompt.ts`) both go through
// `tests/mocks/systemPromptEnv.ts`, whose first act is to assign a *correct*
// `globalThis.MACRO`. Both were green for the entire time issue #81 was true: a
// real `bun src/entrypoints/cli.tsx` run sent
//
//     - To give feedback, users should
//
// to the model, sentence unfinished, because the entrypoint installed a
// hand-written `globalThis.MACRO` whose `ISSUES_EXPLAINER` was still
// Anthropic's empty string. Nothing in the repository could see it: mocking the
// defines is exactly what hides a defect in the defines.
//
// So this file looks at the one place the answer is unambiguous — the request
// body. It starts a local endpoint, points a real source run at it, and reads
// the system prompt the CLI chose to send. No mocks, no in-process import of
// the prompt modules.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getMacroDefines, macroDefineArgs } from '../../scripts/defines.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../..')
// cwd has to stay the repo root: Bun resolves the `src/*` tsconfig path alias
// from the child's cwd, not from the entrypoint's directory.
const CLI_ENTRYPOINT = 'src/entrypoints/cli.tsx'

const SPAWN_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 180_000

/**
 * Provider variables removed from the child.
 *
 * Two jobs. The prompt must not vary with the developer's shell — a machine
 * logged into OpenCode or ChatGPT would otherwise render a different provider's
 * prompt. And the run must be unable to reach anything but the local endpoint
 * even if provider selection regressed: with every credential stripped and
 * `ANTHROPIC_BASE_URL` pinned at loopback, a request that escapes has nowhere
 * to go.
 */
const STRIPPED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_FORCE_INTERACTIVE',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_VERSION',
  'GEMINI_API_KEY',
  'GROK_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENCODE_API_KEY',
  'OPENCODE_BASE_URL',
  'USER_TYPE',
]

type SourceRun = {
  exitCode: number | null
  stderr: string
  stdout: string
  /** The `system` blocks of the first request that carried one. */
  systemPrompt: string | null
}

/** A minimal Anthropic-shaped reply, in whichever of the two shapes was asked for. */
function reply(streaming: boolean): Response {
  if (!streaming) {
    return Response.json({
      id: 'msg_probe',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
  const events = [
    '{"type":"message_start","message":{"id":"msg_probe","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
    '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    '{"type":"message_stop"}',
  ]
  return new Response(events.map(event => `data: ${event}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * Run the entrypoint from source and hand back the system prompt it sent.
 *
 * `defineArgs` is the point of the file: passing `macroDefineArgs()` is how
 * every launcher in the repository starts a source run.
 */
async function runFromSource(
  defineArgs: readonly string[],
): Promise<SourceRun> {
  let systemPrompt: string | null = null
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      let body: unknown = null
      try {
        body = await request.json()
      } catch {
        // Not every call the CLI makes carries a JSON body (it opens with a
        // HEAD probe); only the one that does matters here.
      }
      const system = (body as { system?: unknown } | null)?.system
      if (systemPrompt === null && system !== undefined) {
        systemPrompt = Array.isArray(system)
          ? system
              .map(block => (block as { text?: string }).text ?? '')
              .join('\n\n')
          : String(system)
      }
      if (new URL(request.url).pathname.endsWith('/messages')) {
        return reply((body as { stream?: boolean } | null)?.stream === true)
      }
      return Response.json({})
    },
  })

  const scratch = mkdtempSync(join(tmpdir(), 'occ-raw-source-macro-'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of STRIPPED_ENV_KEYS) delete env[key]
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  env.ANTHROPIC_API_KEY = 'not-a-real-key-the-endpoint-is-loopback'
  // Both roots point at a throwaway directory: OCC_CONFIG_DIR wins, but the
  // deprecated CLAUDE_CONFIG_DIR fallback must not find real user config either.
  env.OCC_CONFIG_DIR = scratch
  env.CLAUDE_CONFIG_DIR = scratch
  // `bun test` exports NODE_ENV=test, which switches `src/services/vcr.ts` on:
  // the child then replays `fixtures/<name>-<hash>.json` relative to its cwd
  // instead of calling the endpoint. Left unpinned that cwd is the repo root, so
  // the first run of this file records a cassette there and every later run
  // answers from it — the test would go green against a recording of an older
  // prompt and never look at the wire again. A per-run fixtures root always
  // misses, so the request is always made, and the recording dies with the
  // directory.
  env.CLAUDE_CODE_TEST_FIXTURES_ROOT = scratch
  // ...but "a miss means the request is made" only holds off CI. Under `CI`,
  // `vcr.ts` turns a miss into a hard error instead of falling through — a
  // sound rule in general (a missing cassette must not silently reach the
  // network) that is simply wrong here, because the only endpoint this child
  // can reach is the loopback server a few lines above. Without this, the
  // child dies before sending anything, `systemPrompt` stays null, and the
  // test fails on every CI run while passing on every developer machine —
  // which is exactly what happened the first time this repository's CI was
  // able to run at all. `VCR_RECORD=1` restores the fall-through; the cassette
  // it writes lands in `scratch` and dies with it.
  env.VCR_RECORD = '1'
  env.DISABLE_TELEMETRY = '1'
  env.NO_COLOR = '1'

  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      ...defineArgs,
      CLI_ENTRYPOINT,
      '-p',
      'hi',
      '--output-format',
      'json',
    ],
    cwd: PROJECT_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  const watchdog = setTimeout(() => proc.kill(9), SPAWN_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stderr, stdout, systemPrompt }
  } finally {
    clearTimeout(watchdog)
    server.stop(true)
    rmSync(scratch, { force: true, recursive: true })
  }
}

/**
 * The defines that are interpolated mid-sentence.
 *
 * Both inherited Anthropic's empty default, and an empty value here does not
 * read as a missing field — it reads as a sentence that stops. The system
 * prompt's is in `src/constants/prompts/doingTasks.ts`; `FEEDBACK_CHANNEL` ends
 * four workspace-trust warnings in `src/utils/auth/auth.ts` ("post in ").
 */
const SENTENCE_TAIL_DEFINES = [
  'MACRO.ISSUES_EXPLAINER',
  'MACRO.FEEDBACK_CHANNEL',
] as const

describe('MACRO defines on the raw-source path', () => {
  for (const key of SENTENCE_TAIL_DEFINES) {
    test(`${key} is not empty`, () => {
      const value: unknown = JSON.parse(getMacroDefines()[key] ?? '""')
      expect(typeof value).toBe('string')
      expect((value as string).trim()).not.toBe('')
    })
  }

  test(
    'a source run sends the whole feedback sentence to the model',
    async () => {
      const explainer: string = JSON.parse(
        getMacroDefines()['MACRO.ISSUES_EXPLAINER'] ?? '""',
      )
      const run = await runFromSource(macroDefineArgs())

      // Never reaching the endpoint would make every assertion below vacuous,
      // so it is checked first and separately.
      //
      // The child's exit code and both its streams ride along in the failure,
      // because `Received: null` on its own says nothing about *why* the
      // request never arrived. This assertion has already gone red on CI
      // while passing on every developer machine, and that run produced one
      // line of evidence — `Received: null` — which was not enough to act on.
      // The child is the only thing that knows; the parent has to ask it —
      // and asking is what found the cause: `Anthropic API fixture missing`,
      // i.e. VCR had swallowed the request. See `VCR_RECORD` above.
      if (run.systemPrompt === null) {
        throw new Error(
          [
            'the child never sent a system prompt to the loopback endpoint',
            `exitCode=${run.exitCode}`,
            `stdout:\n${run.stdout}`,
            `stderr:\n${run.stderr}`,
          ].join('\n'),
        )
      }
      expect(run.systemPrompt).not.toBeNull()
      const line = (run.systemPrompt ?? '')
        .split('\n')
        .find(candidate => candidate.includes('To give feedback, users should'))
      expect(line).toBeDefined()
      // The exact shape of the defect: the sentence ended at "should".
      expect(line).not.toMatch(/users should\s*$/)
      expect(line).toContain(`To give feedback, users should ${explainer}`)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a source run without the defines fails instead of inventing values',
    async () => {
      // The counterpart guarantee. A launcher that forgets the flags has to say
      // so at once — the alternative, an entrypoint that quietly installs a
      // stand-in object, is what kept the truncated sentence in production for
      // as long as it was there: the reads succeeded, so nothing was reported.
      // `--version` is the entrypoint's zero-import fast path, so this costs one
      // process start and reaches `MACRO.VERSION` immediately.
      const proc = Bun.spawn({
        cmd: [process.execPath, 'run', CLI_ENTRYPOINT, '--version'],
        cwd: PROJECT_ROOT,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1' },
      })
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('MACRO')
    },
    TEST_TIMEOUT_MS,
  )
})
