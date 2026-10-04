// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The startup model-credential probe (issue #37 ①), run the only way that can
 * prove it exists: a real `qm resident` process against a real HTTP endpoint.
 *
 * ## Why this file exists at all
 *
 * The probe already had a thorough unit suite —
 * `src/cli/handlers/__tests__/residentModelProbe.test.ts`, 19 tests, green
 * from the day it merged. It was also **dead code in the shipped binary the
 * entire time**: `qm resident` is a fast path in `entrypoints/cli.tsx`,
 * dispatched before anything calls `enableConfigs()`, so the first line of
 * `residentModelProbeInputs()` threw `Config accessed before allowed.`, the
 * throw was folded into a `skipped` verdict nobody printed, and the acceptance
 * fleet observed exactly what a node with no probe observes: zero requests at
 * the endpoint, zero bytes in `<node>.err`.
 *
 * The unit tests could not see it because they inject `inputs` and `fetchImpl`
 * — which is the right way to test the resolver and the prober, and precisely
 * the two steps that skip over the failure. **Injection was the reason the
 * suite was green, not an accident of it.** So the guard against a repeat
 * cannot be another injected test; it has to start the binary and watch the
 * socket.
 *
 * ## What is real here and what is not
 *
 * **Real**: the `qm` entrypoint, its dispatch, `runResident`, the config gate,
 * the credential resolution, and one honest outbound HTTP request over
 * loopback. Nothing is mocked; there is no `mock.module` in this file.
 *
 * **Not real — one thing, named**: the model provider. It is a `Bun.serve` on
 * 127.0.0.1 that answers 401 or 200 by prior arrangement. Nothing here is
 * evidence about any vendor's behaviour; what is under test is whether this
 * node asks the question at all, and what it says about the answer.
 *
 * ## NODE_ENV is load-bearing
 *
 * The config gate reads `if (!configReadingAllowed && process.env.NODE_ENV !==
 * 'test') throw`, and `bun test` exports `NODE_ENV=test`. A child that simply
 * inherits this process's environment therefore **never trips the gate at
 * all** — which would leave the most important thing here untested while every
 * assertion still passed. It is not the artifact either: several base auth
 * paths take CI/test-only branches that a deployed node never sees. The
 * shipped bundle substitutes `'production'` in at build time, so this file
 * does the same, as a `-d` define and as an environment variable.
 *
 * The same reasoning governs every other inherited variable; see
 * `INHERITED_KEYS_TO_DROP`.
 *
 * ## Cost
 *
 * Three node boots, started concurrently and asserted afterwards, so the wall
 * clock is one boot. Two credential shapes are needed rather than one — see
 * `Lane` — and each scenario asserts that a request was actually sent *before*
 * it asserts anything about what was or was not said, because a probe that
 * never fires satisfies every silence assertion ever written. That is not a
 * hypothetical failure mode; it is the one being fixed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getMacroDefines, resolveBuildFeatures } from '../../scripts/defines.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../..')
const CLI_ENTRYPOINT = join(PROJECT_ROOT, 'src/entrypoints/cli.tsx')

let cachedPrefix: readonly string[] | undefined

/**
 * `bun run -d… --feature… src/entrypoints/cli.tsx`, exactly as `scripts/dev.ts`
 * builds it.
 *
 * **The feature list is not optional decoration here.** A resident spawns its
 * ACP child during startup (`services/qianmo/resident.ts#startAcp`), and that
 * child is `<cli> --acp`, a branch gated on `feature('ACP')`. Run the
 * entrypoint bare and the child dies with `unknown option '--acp'` — a node
 * that boots, prints a clean banner, and can never do any work. Testing that
 * shape would be testing a configuration nobody ships.
 *
 * Both lists come from `scripts/defines.ts` rather than being copied, for the
 * reason a copy always fails: it drifts the next time the default feature list
 * changes, and the symptom of that drift is a suite that passes against a
 * binary nobody has.
 */
function cliPrefix(): readonly string[] {
  if (cachedPrefix !== undefined) return cachedPrefix
  const defines = {
    ...getMacroDefines(),
    // What the shipped bundle substitutes in. It is also what closes the config
    // gate — see the header — so it stays pinned here rather than inherited.
    'process.env.NODE_ENV': JSON.stringify('production'),
  }
  const defineArgs = Object.entries(defines).flatMap(([key, value]) => [
    '-d',
    `${key}:${String(value)}`,
  ])
  const featureArgs = [...resolveBuildFeatures()].flatMap(name => [
    '--feature',
    name,
  ])
  cachedPrefix = [
    process.execPath,
    'run',
    ...defineArgs,
    ...featureArgs,
    CLI_ENTRYPOINT,
  ]
  return cachedPrefix
}

/** Long enough for a cold `bun` boot of the entrypoint on a loaded CI runner. */
const BANNER_TIMEOUT_MS = 60_000
/** The probe is fire-and-forget and lands just after the banner. */
const PROBE_TIMEOUT_MS = 30_000
/** Whole-file budget: two boots plus both waits, with room to spare. */
const TEST_TIMEOUT_MS = 180_000

/** The stable prefix of the refusal warning; the tail carries the endpoint. */
const REFUSED_PREFIX =
  "[resident] this node's model endpoint REFUSED its credential: HTTP 401 from "
/** The "the check itself did not run" line — the one this bug used to need. */
const UNAVAILABLE_PREFIX =
  '[resident] the startup model-credential check could not run:'
/** The "no credential visible at all" line, from the other startup check. */
const MISSING_PREFIX = '[resident] no model credential is visible to this node'

const roots: string[] = []
const stopped: (() => Promise<void>)[] = []

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs: number,
  diagnose: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(100)
  }
  // The message "timed out waiting for X" has no diagnostic value on its own;
  // what the reader needs is the process's own output at the moment it gave up.
  throw new Error(
    `timed out waiting for ${what} (${timeoutMs}ms)\n${diagnose()}`,
  )
}

interface StubUpstream {
  /**
   * Origin only, no path. The two lanes want different bases — the Anthropic
   * wire appends `v1/messages` itself while the OpenAI one expects the `/v1`
   * to already be there — so each lane composes what it needs rather than this
   * carrying a guess that is wrong for one of them.
   */
  readonly origin: string
  readonly paths: string[]
}

/**
 * A model endpoint that answers with one status and records what it was asked.
 *
 * `refuse` returns the 401 shape a revoked key produces; `ok` returns a body
 * the probe will read as "reachable" — which for this probe means only that
 * the status was not 401/403/407, so one body serves both lanes. It sends a
 * single non-streaming request, so there is no SSE branch here, unlike the
 * acceptance suite's stub, which also has to satisfy a real agent turn.
 */
function startStubUpstream(behavior: 'refuse' | 'ok'): StubUpstream {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      paths.push(new URL(request.url).pathname)
      if (behavior === 'refuse') {
        return Response.json(
          {
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
            },
          },
          { status: 401 },
        )
      }
      return Response.json({
        id: 'stub-completion',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
      })
    },
  })
  const port = server.port
  if (port === undefined) throw new Error('stub upstream got no TCP port')
  stopped.push(() => server.stop(true))
  return { origin: `http://127.0.0.1:${port}`, paths }
}

interface ResidentNode {
  stdout(): string
  stderr(): string
  stop(): Promise<void>
}

/**
 * How a node is credentialed, which is the axis this file actually turns on.
 *
 * **Two shapes are needed and each guards a different half of the fix; either
 * one alone is a false green, measured rather than assumed.**
 *
 *   `stored`  The credential exists only inside the node's config directory —
 *             what `qm auth login` leaves behind, and what the beta fleet
 *             runs. Reading it requires the config gate, so this is the shape
 *             that goes dark when the gate is left closed: `hasAnyModelCredential()`
 *             throws, the throw is swallowed into "no credential", and the node
 *             announces "no stored login under this OCC_CONFIG_DIR" **about a
 *             node that has one** while the probe silently declines to run.
 *
 *   `openai`  A key in the environment, on the OpenAI-compatible lane, paired
 *             with `CI=1` and no Anthropic key — the combination that makes
 *             `getAnthropicApiKeyWithSource()` throw from a branch that exists
 *             only for CI. This node must still probe its own perfectly good
 *             key, which holds only while the Anthropic headers stay deferred.
 *
 * A node credentialed from `ANTHROPIC_API_KEY` would be the obvious third
 * shape and is deliberately absent: every step of that lookup short-circuits on
 * the environment variable, so it never reads config and proves nothing here.
 * That version of this file passes with the gate fix reverted.
 */
type Lane = 'stored' | 'openai'

/**
 * The child's whole environment.
 *
 * Every key that could change the answer is set or removed here rather than
 * inherited, because a suite whose verdict depends on the developer's shell is
 * a suite that will one day be green on a machine and red on a runner with no
 * way to tell which one was lying.
 */
function childEnv(
  configDir: string,
  lane: Lane,
  upstream: StubUpstream,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // A developer's own credentials and endpoints must not reach the child: they
  // would redirect the probe away from the stub, and the assertion that no
  // request arrived would then be measuring the wrong thing entirely.
  for (const key of INHERITED_KEYS_TO_DROP) delete env[key]
  return {
    ...env,
    // See the file header: without this the config gate never trips.
    NODE_ENV: 'production',
    OCC_IDENTITY: 'qianmo',
    OCC_CONFIG_DIR: configDir,
    CLAUDE_CONFIG_DIR: configDir,
    QIANMO_TRANSPORT_PSK: 'qianmo-startup-probe-psk-000000',
    NO_COLOR: '1',
    ...laneEnv(lane, upstream),
  }
}

/**
 * Environment this test must not inherit.
 *
 * `CI` is on the list because the two lanes want opposite values for it and
 * the runner supplies one of them; each lane sets what it needs afterwards.
 */
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
]

function laneEnv(lane: Lane, upstream: StubUpstream): Record<string, string> {
  if (lane === 'openai') {
    return {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'sk-qianmo-startup-probe-stub',
      OPENAI_BASE_URL: `${upstream.origin}/v1`,
      OPENAI_MODEL: 'qianmo-startup-probe-stub',
      // Pinned rather than inherited so this reads the same on a laptop and on
      // a runner: it is the switch that arms the CI-only throw described above.
      CI: '1',
    }
  }
  // No credential in the environment at all: this node's key is the one
  // `plantStoredLogin` wrote into its config directory, and reaching it is the
  // whole point. Only the endpoint and the model are pinned.
  return {
    ANTHROPIC_BASE_URL: upstream.origin,
    ANTHROPIC_SMALL_FAST_MODEL: 'qianmo-startup-probe-stub',
  }
}

/**
 * Give a node a credential that exists **only** behind the config gate.
 *
 * `<configDir>/.config.json` is the path `getGlobalClaudeFile()` checks first,
 * so this is the node's global config in the plainest possible form. Writing
 * it is what makes this file able to tell a working config gate from a closed
 * one: with the gate open the node finds this key and probes with it; with the
 * gate closed the read throws, the throw is swallowed, and the node reports
 * that no stored login exists.
 *
 * If that fallback path is ever removed, this plant stops taking effect and
 * the node reports no credential — which fails the assertions below loudly
 * rather than quietly passing them.
 */
function plantStoredLogin(configDir: string): void {
  writeFileSync(
    join(configDir, '.config.json'),
    JSON.stringify({ primaryApiKey: 'sk-ant-qianmo-startup-probe-stored' }),
    { encoding: 'utf8', mode: 0o600 },
  )
}

/**
 * Start one node.
 *
 * `--port 0` on purpose: nothing here dials the node, so the acceptance
 * driver's reason for allocating a port by hand (the banner does not report
 * one, so an external dialler cannot find it) does not apply, and letting the
 * kernel choose removes the only race this file would otherwise have.
 */
function startResident(
  node: string,
  lane: Lane,
  upstream: StubUpstream,
): ResidentNode {
  const root = mkdtempSync(join(tmpdir(), `qm-probe-${node}-`))
  roots.push(root)
  const configDir = join(root, 'config')
  const workspace = join(root, 'ws')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  if (lane === 'stored') plantStoredLogin(configDir)

  const proc = Bun.spawn({
    cmd: [
      ...cliPrefix(),
      'resident',
      '--node',
      node,
      '--team',
      'probe',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--agent',
      `main=${workspace}`,
      '--open-policy',
    ],
    cwd: PROJECT_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnv(configDir, lane, upstream),
  })

  // Both pipes must be drained continuously: a resident is a long-lived
  // process, so reading them at exit would mean reading them never, and a full
  // pipe buffer would block the child mid-write — which looks exactly like a
  // node that started and then did nothing.
  let out = ''
  let err = ''
  void drain(proc.stdout, chunk => {
    out += chunk
  })
  void drain(proc.stderr, chunk => {
    err += chunk
  })

  let stopping: Promise<void> | undefined
  const handle: ResidentNode = {
    stdout: () => out,
    stderr: () => err,
    stop: () => {
      stopping ??= (async () => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGTERM')
          const died = await Promise.race([
            proc.exited.then(() => true),
            sleep(3_000).then(() => false),
          ])
          if (!died) {
            proc.kill('SIGKILL')
            await proc.exited
          }
        }
      })()
      return stopping
    },
  }
  stopped.push(() => handle.stop())
  return handle
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) onChunk(decoder.decode(value, { stream: true }))
    }
  } catch {
    // A killed process ends its streams with an exception. Not an observation.
  }
}

interface Fixture {
  upstream: StubUpstream
  node: ResidentNode
}

const fixtures = new Map<string, Fixture>()

function fixture(name: string): Fixture {
  const found = fixtures.get(name)
  if (found === undefined) throw new Error(`fixture ${name} was never started`)
  return found
}

/** Start one node against its own stub, and remember both under `name`. */
function launch(name: string, lane: Lane, behavior: 'refuse' | 'ok'): void {
  const upstream = startStubUpstream(behavior)
  fixtures.set(name, { upstream, node: startResident(name, lane, upstream) })
}

/**
 * Wait for one node's probe to land, then hand back what it wrote.
 *
 * Every assertion in this file is ordered behind this call, because silence is
 * only evidence once the question has been put — a probe that never fires
 * satisfies every `not.toContain` ever written, which is precisely how the
 * defect survived a green suite.
 */
async function probed(name: string, path: string): Promise<string> {
  const { upstream, node } = fixture(name)
  await waitFor(
    () => upstream.paths.length > 0,
    `the probe request from ${name} to reach its stub upstream`,
    PROBE_TIMEOUT_MS,
    () => `stderr:\n${node.stderr()}`,
  )
  expect(upstream.paths).toEqual([path])
  return node.stderr()
}

describe('a real `qm resident` asks its endpoint about its credential', () => {
  beforeAll(async () => {
    // Started together, asserted afterwards: the wall time of this file is one
    // node boot rather than three.
    launch('storednode', 'stored', 'refuse')
    launch('healthynode', 'stored', 'ok')
    launch('openailanenode', 'openai', 'refuse')
    await Promise.all(
      [...fixtures.entries()].map(async ([name, { node }]) => {
        await waitFor(
          () => node.stdout().includes('"publicKey"'),
          `the startup banner of ${name}`,
          BANNER_TIMEOUT_MS,
          () => `stdout:\n${node.stdout()}\nstderr:\n${node.stderr()}`,
        )
      }),
    )
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    for (const stop of stopped.reverse()) await stop().catch(() => {})
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  test(
    'a stored login is found, asked about, and reported as refused',
    async () => {
      // The assertion the whole regression turns on. Before the fix this stayed
      // at zero forever: the credential could not be read, so nothing was sent,
      // and `<node>.err` never grew a byte to say so.
      const stderr = await probed('storednode', '/v1/messages')
      await waitFor(
        () => fixture('storednode').node.stderr().includes(REFUSED_PREFIX),
        'the refusal warning on stderr',
        PROBE_TIMEOUT_MS,
        () => `stderr:\n${stderr}`,
      )
      const settled = fixture('storednode').node.stderr()
      // Actionable, not merely present: the ACP child inherits this process's
      // environment, so nothing short of a restart fixes it.
      expect(settled).toContain('rotate the key')
      expect(settled).toContain('restart this node')
      // And it must be the refusal that fired, not "the check did not run".
      expect(settled).not.toContain(UNAVAILABLE_PREFIX)
      // The gate's other casualty, and the more insidious one: with config
      // unreadable the node announced "no stored login under this
      // OCC_CONFIG_DIR" about a node that has exactly that, sending whoever
      // read it to re-run a login that had never failed.
      expect(settled).not.toContain(MISSING_PREFIX)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a working credential is asked about too, and then nothing is said',
    async () => {
      await probed('healthynode', '/v1/messages')
      // Let anything that was coming arrive before asserting nothing did.
      await sleep(1_000)
      const stderr = fixture('healthynode').node.stderr()
      expect(stderr).not.toContain(REFUSED_PREFIX)
      expect(stderr).not.toContain(UNAVAILABLE_PREFIX)
      expect(stderr).not.toContain(MISSING_PREFIX)
      // `<node>.err` staying at zero bytes is the property that makes the other
      // warnings worth reading at all; pin it whole rather than by prefix.
      expect(stderr).toBe('')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a node on another lane is not blinded by the Anthropic credential stack',
    async () => {
      // This node holds a good OpenAI key and no Anthropic one, with `CI` set —
      // the combination that makes getAnthropicApiKeyWithSource() throw from a
      // branch that exists only for CI. Resolved eagerly, that throw reached
      // the probe before it had even chosen a provider and no request was sent.
      // Measured against a real node: zero requests then, one now.
      const stderr = await probed('openailanenode', '/v1/chat/completions')
      await waitFor(
        () => fixture('openailanenode').node.stderr().includes(REFUSED_PREFIX),
        'the refusal warning on the OpenAI-lane node',
        PROBE_TIMEOUT_MS,
        () => `stderr:\n${stderr}`,
      )
      expect(fixture('openailanenode').node.stderr()).not.toContain(
        UNAVAILABLE_PREFIX,
      )
    },
    TEST_TIMEOUT_MS,
  )
})
