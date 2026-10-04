// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A real `--acp` child, driven the way a resident node drives it, against a
 * scripted model double. For `qianmo-resident-permission-bypass.test.ts`.
 *
 * ## What is real
 *
 * The ACP child is `src/entrypoints/cli.tsx --acp` from source, with the
 * shipped defines and feature list, started with the environment
 * `residentAcpEnvironment()` builds for production. It is initialized and handed
 * sessions with the same `_meta` that `ResidentAcpConnection`
 * (`packages/resident/src/acp-client.ts`) sends. Tools, the permission
 * pipeline, hooks, agent and skill loading are all the real ones. No
 * `mock.module`.
 *
 * ## What is not
 *
 * The model. A loopback `Bun.serve` speaks just enough streaming Chat
 * Completions to emit a fixed list of tool calls per scenario, and records the
 * tool result it gets back for each. It proves nothing about what a real model
 * would choose; it proves what the node lets happen once a model has chosen.
 *
 * The host is scripted rather than `ResidentAcpConnection` itself: that class
 * answers every permission request `cancelled` and has no observer, and the
 * properties under test need a host that can *approve* one request and see
 * whether a second one arrived.
 *
 * ## What the host records
 *
 * Every `tool_call` / `tool_call_update` session update and every permission
 * request, in the order the host's connection delivered them, attributed to
 * the scenario by `sessionId` ({@link HostEvent}). The ask snapshot and the
 * `tool_call`-before-`requestPermission` ordering case read that stream; it is
 * the same order a real `ResidentAcpConnection` would see, because both sit on
 * the SDK's single in-order receive loop.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  RequestPermissionRequest,
  SessionNotification,
  Stream,
} from '@agentclientprotocol/sdk'
import {
  getMacroDefines,
  resolveBuildFeatures,
} from '../../../scripts/defines.js'
import { residentAcpEnvironment } from '../../../src/services/qianmo/residentAcpEnv.js'

const PROJECT_ROOT = resolve(import.meta.dir, '../../..')
const CLI_ENTRYPOINT = join(PROJECT_ROOT, 'src/entrypoints/cli.tsx')

/** Marker a sub-agent prompt carries so the double can tell the two apart. */
export const SUBAGENT_MARKER = 'RESIDENT-PERMISSION-SUBAGENT'

/** One scripted tool call. */
export interface ScriptedCall {
  readonly name: string
  readonly input: Record<string, unknown>
}

/**
 * A main-turn step: a fixed call, or one built from the tool results the turn
 * has produced so far — for a call that needs an id an earlier call returned.
 */
export type ScriptedStep =
  | ScriptedCall
  | ((results: readonly string[]) => ScriptedCall)

/** Which requests the scripted host approves; everything else is cancelled. */
export type HostPolicy = (request: RequestPermissionRequest) => boolean

/** A permission request as the host saw it. */
export interface HostRequest {
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly rawInput: string
  readonly answered: 'allow' | 'cancelled'
}

/**
 * One thing the host received, in arrival order.
 *
 * `toolName` is the base's `_meta.claudeCode.toolName` on a `tool_call`
 * update — the only place the tool's name reaches the host, since a
 * permission request carries `title` / `kind` / `rawInput` but not the name
 * (design `authorization-m1.md` F-21).
 */
export type HostEvent =
  | {
      readonly type: 'tool_call'
      readonly toolCallId: string
      readonly toolName: string | null
      readonly parentToolUseId: string | null
    }
  | {
      readonly type: 'tool_call_update'
      readonly toolCallId: string
      readonly status: string | null
    }
  | {
      readonly type: 'permission'
      readonly toolCallId: string
      readonly title: string
      readonly kind: string
    }

/** What one scenario run produced. */
export interface ScenarioResult {
  /** Session updates and permission requests, in the order the host got them. */
  readonly events: HostEvent[]
  /** Permission requests the host received, in order. */
  readonly hostRequests: HostRequest[]
  /**
   * Text of each tool result the main turn's model double received, one entry
   * per step. A result that came with follow-up text in the same round (e.g.
   * `ExecuteExtraTool`'s "not found" note) carries that text too.
   */
  readonly toolResults: string[]
  /** Text of each tool result a sub-agent's model double received. */
  readonly subToolResults: string[]
}

export interface Scenario {
  readonly id: string
  readonly mode: 'dontAsk' | 'acceptEdits' | 'default'
  readonly cwd: string
  readonly steps: readonly ScriptedStep[]
  /** Served to a sub-agent turn (recognised by {@link SUBAGENT_MARKER}). */
  readonly subSteps?: readonly ScriptedCall[]
  /** Defaults to deny-all. */
  readonly hostPolicy?: HostPolicy
  /** Extra time to let an async sub-agent finish after the turn ends. */
  readonly settleMs?: number
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as Record<string, unknown>).text === 'string'
        ? ((part as Record<string, unknown>).text as string)
        : '',
    )
    .join('\n')
}

let frameCounter = 0
function frame(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'resident-permission-double',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'resident-permission-double',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}
function sse(body: string): Response {
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}
function toolReply(call: ScriptedCall): Response {
  frameCounter += 1
  return sse(
    frame(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call_resident_${frameCounter}`,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input),
            },
          },
        ],
      },
      null,
    ) + frame({}, 'tool_calls'),
  )
}
function textReply(text: string): Response {
  return sse(
    frame({ role: 'assistant', content: text }, null) + frame({}, 'stop'),
  )
}

/**
 * One resident node under a scripted model, plus a scripted host.
 *
 * `start()` boots the child and the model; `run(scenario)` drives one turn and
 * hands back what the host and both model turns saw; `stop()` tears it all down.
 */
export class ResidentAcpHarness {
  #child: ChildProcess | undefined
  #model: ReturnType<typeof Bun.serve> | undefined
  #conn: ClientSideConnection | undefined
  #scenarios = new Map<string, Scenario>()
  #mainResults = new Map<string, string[]>()
  #subResults = new Map<string, string[]>()
  #hostRequests = new Map<string, HostRequest[]>()
  #events = new Map<string, HostEvent[]>()
  #scenarioOfSession = new Map<string, string>()
  #current = ''
  #offeredTools: string[] | undefined
  #deferredTools: string[] | undefined
  readonly #stderrPath: string
  readonly #safeMode: boolean
  readonly #extraEnv: Readonly<Record<string, string>>
  readonly #memoryRoot: string | undefined

  /**
   * @param safeMode when `false`, the shipped `CLAUDE_CODE_SAFE_MODE` is removed
   * from the child env. The four bypasses must still be closed by the tool-face,
   * hardline and `canUseTool` ceiling alone — this is the regression guard for
   * `residentGuard.ts` that would not notice if safe mode did all the work.
   * @param extraEnv added to the child env after the production one, e.g. a
   * dead proxy so that a tool the node lets through cannot reach the internet.
   * @param memoryRoot the memory root a host started with `memoryRoot` hands
   * its child, through the same `residentAcpEnvironment` option.
   */
  constructor(
    private readonly configDir: string,
    options: {
      safeMode?: boolean
      extraEnv?: Readonly<Record<string, string>>
      memoryRoot?: string
    } = {},
  ) {
    this.#stderrPath = join(configDir, 'acp-child.stderr')
    this.#safeMode = options.safeMode ?? true
    this.#extraEnv = options.extraEnv ?? {}
    this.#memoryRoot = options.memoryRoot
  }

  get stderrPath(): string {
    return this.#stderrPath
  }

  /** Port of the loopback model double, once started. */
  get modelPort(): number {
    const port = this.#model?.port
    if (port === undefined) throw new Error('harness not started')
    return port
  }

  /**
   * The tool names the child put in the first main-turn model request's
   * `tools` field — the surface a resident model can call directly.
   */
  get offeredTools(): readonly string[] {
    return this.#offeredTools ?? []
  }

  /**
   * The deferred tools the same request announced for `SearchExtraTools` /
   * `ExecuteExtraTool`. Parsed from the base's reminder text; an empty list
   * means the text changed, which the snapshot test treats as drift.
   */
  get deferredTools(): readonly string[] {
    return this.#deferredTools ?? []
  }

  #serve(): void {
    this.#model = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async req => {
        let body: { messages?: unknown; tools?: unknown; stream?: unknown } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          // A non-JSON body is not a model turn; answer the trivial shape.
        }
        if (body.stream !== true) {
          return Response.json({
            id: 'd',
            object: 'chat.completion',
            created: 1,
            model: 'd',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        }
        const messages = Array.isArray(body.messages) ? body.messages : []
        const all = messages.map(m => textOf(m.content)).join('\n')
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0
        if (!hasTools) return textReply('ok')
        if (
          this.#offeredTools === undefined &&
          !all.includes(SUBAGENT_MARKER)
        ) {
          this.#offeredTools = toolNamesOf(body.tools)
          this.#deferredTools = deferredToolsIn(all)
        }

        const last = messages.at(-1)
        const priorToolResults = messages.filter(m => m.role === 'tool')

        // A sub-agent turn: its prompt carries the marker, and its steps live on
        // the scenario named after the marker suffix `SUB:<id>`.
        const subMatch = /SUB:([\w-]+)/.exec(all)
        if (all.includes(SUBAGENT_MARKER) && subMatch) {
          const scenario = this.#scenarios.get(subMatch[1] as string)
          const subSteps = scenario?.subSteps ?? []
          if (last?.role === 'tool') {
            this.#push(this.#subResults, subMatch[1] as string, last.content)
          }
          const i = priorToolResults.length
          return i < subSteps.length
            ? toolReply(subSteps[i] as ScriptedCall)
            : textReply('sub done')
        }

        const scnMatch = /SCN:([\w-]+)/.exec(all)
        const scenario = scnMatch
          ? this.#scenarios.get(scnMatch[1] as string)
          : undefined
        if (!scenario) return textReply('no scenario')
        const results = toolResultsOf(messages)
        this.#mainResults.set(scenario.id, results)
        const i = priorToolResults.length
        const step = scenario.steps[i]
        if (step === undefined) return textReply(`done ${scenario.id}`)
        return toolReply(typeof step === 'function' ? step(results) : step)
      },
    })
  }

  #push(map: Map<string, string[]>, id: string, content: unknown): void {
    const list = map.get(id) ?? []
    list.push(textOf(content).slice(0, 400))
    map.set(id, list)
  }

  async start(): Promise<void> {
    this.#serve()
    const { child, stream } = spawnResidentAcpChild({
      configDir: this.configDir,
      modelBaseUrl: `http://127.0.0.1:${this.#model?.port}/v1`,
      stderrPath: this.#stderrPath,
      safeMode: this.#safeMode,
      extraEnv: this.#extraEnv,
      ...(this.#memoryRoot === undefined
        ? {}
        : { memoryRoot: this.#memoryRoot }),
    })
    this.#child = child
    const harness = this
    const client = {
      async requestPermission(params: RequestPermissionRequest) {
        const policy = harness.#scenarios.get(harness.#current)?.hostPolicy
        const approve =
          policy?.(params) === true &&
          params.options.some(o => o.optionId === 'allow')
        harness.#record(params, approve ? 'allow' : 'cancelled')
        return approve
          ? { outcome: { outcome: 'selected' as const, optionId: 'allow' } }
          : { outcome: { outcome: 'cancelled' as const } }
      },
      async sessionUpdate(params: SessionNotification) {
        harness.#observe(params)
      },
      async extNotification() {},
      async extMethod(method: string) {
        // The notify tool reaches the host through this; answer "sent" so the
        // positive control for qianmo_notify sees the request arrive.
        return method === 'qianmo/notify'
          ? { status: 'sent' }
          : { ok: true, method }
      },
    }
    const conn = new ClientSideConnection(() => client, stream)
    this.#conn = conn
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'qianmo-resident', version: '0' },
      _meta: { qianmo: { resident: true } },
    })
  }

  /** The scenario a session belongs to; falls back to the one running now. */
  #scenarioOf(sessionId: string): string {
    return this.#scenarioOfSession.get(sessionId) ?? this.#current
  }

  #event(sessionId: string, event: HostEvent): void {
    const id = this.#scenarioOf(sessionId)
    const list = this.#events.get(id) ?? []
    list.push(event)
    this.#events.set(id, list)
  }

  #record(params: RequestPermissionRequest, answered: 'allow' | 'cancelled') {
    const call = (params as { toolCall?: Record<string, unknown> }).toolCall
    const id = this.#scenarioOf(params.sessionId)
    const toolCallId = String(call?.toolCallId ?? '')
    const title = String(call?.title ?? '')
    const kind = String(call?.kind ?? '')
    const list = this.#hostRequests.get(id) ?? []
    list.push({
      toolCallId,
      title,
      kind,
      rawInput: JSON.stringify(call?.rawInput ?? {}),
      answered,
    })
    this.#hostRequests.set(id, list)
    this.#event(params.sessionId, {
      type: 'permission',
      toolCallId,
      title,
      kind,
    })
  }

  #observe(params: SessionNotification): void {
    const update = params.update as Record<string, unknown>
    const kind = update.sessionUpdate
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return
    const toolCallId = String(update.toolCallId ?? '')
    if (kind === 'tool_call_update') {
      this.#event(params.sessionId, {
        type: 'tool_call_update',
        toolCallId,
        status: typeof update.status === 'string' ? update.status : null,
      })
      return
    }
    const meta = (update._meta as Record<string, unknown> | undefined)
      ?.claudeCode as Record<string, unknown> | undefined
    this.#event(params.sessionId, {
      type: 'tool_call',
      toolCallId,
      toolName: typeof meta?.toolName === 'string' ? meta.toolName : null,
      parentToolUseId:
        typeof meta?.parentToolUseId === 'string' ? meta.parentToolUseId : null,
    })
  }

  async run(scenario: Scenario): Promise<ScenarioResult> {
    if (!this.#conn) throw new Error('harness not started')
    this.#scenarios.set(scenario.id, scenario)
    this.#current = scenario.id
    const session = await this.#conn.newSession({
      cwd: scenario.cwd,
      mcpServers: [],
      _meta: {
        permissionMode: scenario.mode,
        qianmo: { resident: true, agent: 'main' },
      },
    })
    this.#scenarioOfSession.set(session.sessionId, scenario.id)
    await Promise.race([
      this.#conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `SCN:${scenario.id}` }],
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`scenario ${scenario.id} timed out`)),
          60_000,
        ),
      ),
    ])
    if (scenario.settleMs) {
      await new Promise(r => setTimeout(r, scenario.settleMs))
    }
    return {
      events: this.#events.get(scenario.id) ?? [],
      hostRequests: this.#hostRequests.get(scenario.id) ?? [],
      toolResults: this.#mainResults.get(scenario.id) ?? [],
      subToolResults: this.#subResults.get(scenario.id) ?? [],
    }
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
    await this.#model?.stop(true)
  }
}

/**
 * One entry per tool result in a main-turn request: the result text, plus any
 * user text that arrived in the same round before the next assistant message.
 */
function toolResultsOf(
  messages: readonly { role?: unknown; content?: unknown }[],
): string[] {
  const results: string[] = []
  // True between a tool result and the next assistant message: user text in
  // that window arrived with the result.
  let open = false
  for (const message of messages) {
    if (message.role === 'tool') {
      results.push(textOf(message.content).slice(0, 400))
      open = true
    } else if (message.role === 'user' && open) {
      const follow = textOf(message.content).slice(0, 400)
      results[results.length - 1] = `${results.at(-1)}\n${follow}`
    } else if (message.role === 'assistant') {
      open = false
    }
  }
  return results
}

function toolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap(tool => {
    const fn = (tool as { function?: { name?: unknown } }).function
    return typeof fn?.name === 'string' ? [fn.name] : []
  })
}

/**
 * The names under the base's "deferred tools are now available" reminder: one
 * per line, up to the first blank line.
 */
function deferredToolsIn(text: string): string[] {
  const marker = 'The following deferred tools are now available'
  const start = text.indexOf(marker)
  if (start < 0) return []
  const lines = text.slice(start).split('\n').slice(1)
  const names: string[] = []
  for (const line of lines) {
    const name = line.trim()
    if (name === '') break
    names.push(name)
  }
  return names
}

/**
 * Start `src/entrypoints/cli.tsx --acp` the way a resident node starts its
 * child: from source, with the shipped defines and feature list (so
 * `REACTIVE_COMPACT` and every other default-on branch is live, exactly as in
 * the artifact), in the environment `residentAcpEnvironment()` builds for
 * production, pointed at a scripted OpenAI-compatible model.
 *
 * Returns the child and an ACP stream over its stdio. Whoever holds the stream
 * decides what kind of host to be: the harness above is a scripted one, and
 * `qianmo-empty-model-response.test.ts` puts the resident's own
 * `ResidentAcpConnection` on it.
 */
export function spawnResidentAcpChild(options: {
  readonly configDir: string
  /** `http://127.0.0.1:<port>/v1` */
  readonly modelBaseUrl: string
  readonly stderrPath: string
  /** Defaults to `resident-permission-double`. */
  readonly model?: string
  /** See {@link ResidentAcpHarness}; defaults to `true`. */
  readonly safeMode?: boolean
  /** Added to the child env after the production one. */
  readonly extraEnv?: Readonly<Record<string, string>>
  /** The memory root a host started with `memoryRoot` hands its child. */
  readonly memoryRoot?: string
}): { readonly child: ChildProcess; readonly stream: Stream } {
  const defines = {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  }
  const args = [
    'run',
    ...Object.entries(defines).flatMap(([k, v]) => ['-d', `${k}:${String(v)}`]),
    ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
    CLI_ENTRYPOINT,
    '--acp',
  ]
  const stderr = Bun.file(options.stderrPath).writer()
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: residentChildEnv(options),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', chunk => {
    stderr.write(chunk)
    stderr.flush()
  })
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin as NonNullable<typeof child.stdin>) as never,
    Readable.toWeb(child.stdout as NonNullable<typeof child.stdout>) as never,
  )
  return { child, stream }
}

function residentChildEnv(options: {
  readonly configDir: string
  readonly modelBaseUrl: string
  readonly model?: string
  readonly safeMode?: boolean
  readonly extraEnv?: Readonly<Record<string, string>>
  readonly memoryRoot?: string
}): NodeJS.ProcessEnv {
  const parent: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) parent[k] = v
  }
  for (const k of INHERITED_KEYS_TO_DROP) delete parent[k]
  const env = residentAcpEnvironment(
    {
      ...parent,
      ...options.extraEnv,
      NODE_ENV: 'production',
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: options.configDir,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'sk-resident-permission-double',
      OPENAI_BASE_URL: options.modelBaseUrl,
      OPENAI_MODEL: options.model ?? 'resident-permission-double',
      OPENAI_WIRE_API: 'chat',
      NO_COLOR: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
    },
    options.memoryRoot === undefined ? {} : { memoryRoot: options.memoryRoot },
  )
  // The ceiling-only describe needs the child WITHOUT safe mode, so the hook,
  // agent and skill actually load and the tool-face/hardline/canUseTool
  // guards are the only thing standing between them and an escalation.
  if (options.safeMode === false) delete env.CLAUDE_CODE_SAFE_MODE
  return env
}

/** Credentials and endpoints a developer's shell must not leak into the child. */
const INHERITED_KEYS_TO_DROP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CONFIG_DIR',
  'CI',
  'GEMINI_API_KEY',
  'GROK_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
]
