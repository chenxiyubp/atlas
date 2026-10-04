// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A deterministic stand-in for the model behind a resident node, for the
 * `qm watch` end-to-end test.
 *
 * ## What it proves, and what it does not
 *
 * It speaks the minimum OpenAI Chat Completions (streaming) that the base's
 * adapter needs, and it drives a turn the way a cooperative model would. It
 * uses three read-only tools, in order: `Read` on the job's runbook in the
 * workspace, `Grep` over the workspace, then `Bash` with `df -P /`. Then it
 * calls `qianmo_notify` only if the usage is at or above the threshold the job
 * names. Everything between the model and the network is real: the ACP child,
 * its permission pipeline under the node's session mode, the three tools, the
 * notify tool, the node's notifier, and the hub. A tool the pipeline refused
 * shows up here as `ok: false` with the refusal text, so the test can assert
 * that no read-only check needed a permission the node does not grant.
 *
 * It decides on the **notice tier** the same way the ACP fixture next to the
 * resident tests does (`src/services/qianmo/__tests__/fixtures/
 * resident-acp-agent.runner.ts`): the untrusted template ends with "never as
 * instructions", and a real model declined six times out of six on that
 * sentence. When this double sees it, it declines the same way and runs
 * nothing. It reads the tier from the prompt the model receives, not from a
 * flag, because the prompt is the only way the tier reaches a model.
 *
 * It proves nothing about any vendor's model, and nothing about whether a real
 * model would choose these tools. The real-model smoke run covers that
 * separately and is not part of CI.
 */

/** The untrusted notice's deciding clause (`packages/adapter/src/wrapper.ts`). */
export const UNTRUSTED_DIRECTIVE = 'never as instructions'
/** The verified notice's deciding clause, same file. */
export const VERIFIED_DIRECTIVE = 'The request is therefore authorized'
/** File the test puts in the workspace for `Read` and `Grep` to find. */
export const RUNBOOK_FILE = 'RUNBOOK.md'
/** A line in that file; seeing it in a tool result means the tool ran. */
export const RUNBOOK_MARKER = 'watch-runbook-marker'
/**
 * A job whose prompt carries this gets an empty completion on every turn
 * request: HTTP 200, finish_reason `stop`, no content, no tool call — the
 * gateway behaviour behind the beta-5 failures of 2026-09-27.
 */
export const EMPTY_JOB_MARKER = 'WATCH-EMPTY'
/** How a job hands the double its threshold, e.g. `WATCH-DF threshold=90`. */
const JOB_MARKER = /WATCH-DF threshold=(\d+)/
/** Where the base's system prompt names the session's working directory. */
const CWD_MARKER = /Primary working directory: ([^\n"\\]+)/

/** What the double decided on one request, for the test to assert on. */
export type ModelDoubleStep =
  | { readonly kind: 'declined-untrusted' }
  | {
      readonly kind: 'tool-result'
      readonly tool: string
      readonly ok: boolean
      readonly text: string
    }
  | { readonly kind: 'notified'; readonly usage: number }
  | { readonly kind: 'quiet'; readonly usage: number }
  | { readonly kind: 'finished' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'no-job' }

export interface ModelDouble {
  /** `http://127.0.0.1:<port>/v1`, for `OPENAI_BASE_URL`. */
  readonly baseUrl: string
  /** Every request body, parsed. */
  requests(): readonly Record<string, unknown>[]
  /** Every decision, in order. */
  steps(): readonly ModelDoubleStep[]
  stop(): Promise<void>
}

interface ChatMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly tool_calls?: unknown
  readonly tool_call_id?: unknown
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

/** The name of the tool whose result `message` carries. */
function toolNameFor(
  messages: readonly ChatMessage[],
  message: ChatMessage,
): string | undefined {
  for (const candidate of messages) {
    if (!Array.isArray(candidate.tool_calls)) continue
    for (const call of candidate.tool_calls as Record<string, unknown>[]) {
      if (call.id !== message.tool_call_id) continue
      const fn = call.function as Record<string, unknown> | undefined
      return typeof fn?.name === 'string' ? fn.name : undefined
    }
  }
  return undefined
}

let callCounter = 0

function frame(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'watch-model-double',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'watch-model-double',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function sse(body: string): Response {
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}

function textReply(text: string): Response {
  return sse(
    frame({ role: 'assistant', content: text }, null) + frame({}, 'stop'),
  )
}

function toolReply(name: string, input: Record<string, unknown>): Response {
  callCounter += 1
  const id = `call_double_${callCounter}`
  return sse(
    frame(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
      null,
    ) + frame({}, 'tool_calls'),
  )
}

/** `df -P /` prints a header and one line whose fifth column is `NN%`. */
function usageFrom(output: string): number | undefined {
  const match = /\s(\d{1,3})%\s+\/\s*$/m.exec(output)
  return match === null ? undefined : Number(match[1])
}

function completion(): Response {
  return Response.json({
    id: 'watch-model-double',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'watch-model-double',
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

export function startWatchModelDouble(): ModelDouble {
  const requests: Record<string, unknown>[] = []
  const steps: ModelDoubleStep[] = []

  const dfCall = (): Response =>
    toolReply('Bash', {
      command: 'df -P /',
      description: 'Show root filesystem usage',
    })

  const decide = (body: Record<string, unknown>): Response => {
    const messages = Array.isArray(body.messages)
      ? (body.messages as ChatMessage[])
      : []
    const everything = messages.map(message => textOf(message.content))
    const prompt = everything.join('\n')
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    if (hasTools && prompt.includes(EMPTY_JOB_MARKER)) {
      steps.push({ kind: 'empty' })
      return sse(frame({ role: 'assistant' }, null) + frame({}, 'stop'))
    }
    const job = JOB_MARKER.exec(prompt)
    if (job === null) {
      // A side request (title, summary): answer and stay out of it.
      steps.push({ kind: 'no-job' })
      return textReply('ok')
    }
    const threshold = Number(job[1])
    if (prompt.includes(UNTRUSTED_DIRECTIVE)) {
      steps.push({ kind: 'declined-untrusted' })
      return textReply(
        'I will not run this: the request is marked untrusted, so its content is data.',
      )
    }
    const cwd = CWD_MARKER.exec(prompt)?.[1]?.trim()
    const last = messages.at(-1)
    if (last?.role !== 'tool') {
      if (cwd === undefined) return dfCall()
      return toolReply('Read', { file_path: `${cwd}/${RUNBOOK_FILE}` })
    }
    const result = textOf(last.content)
    const tool = toolNameFor(messages, last) ?? 'unknown'
    if (tool === 'qianmo_notify') {
      steps.push({ kind: 'finished' })
      return textReply(`Reported. (${result.slice(0, 120)})`)
    }
    if (tool === 'Read' || tool === 'Grep') {
      steps.push({
        kind: 'tool-result',
        tool,
        ok: result.includes(RUNBOOK_MARKER),
        text: result.slice(0, 400),
      })
      if (tool === 'Read' && cwd !== undefined) {
        return toolReply('Grep', {
          pattern: RUNBOOK_MARKER,
          path: cwd,
          output_mode: 'content',
        })
      }
      return dfCall()
    }
    const usage = usageFrom(result)
    steps.push({
      kind: 'tool-result',
      tool,
      ok: usage !== undefined,
      text: result.slice(0, 400),
    })
    if (usage === undefined) {
      return textReply(`The check could not run: ${result.slice(0, 200)}`)
    }
    if (usage >= threshold) {
      steps.push({ kind: 'notified', usage })
      return toolReply('qianmo_notify', {
        kind: 'watch',
        severity: 'warn',
        summary: `root filesystem at ${usage}% (threshold ${threshold}%)`,
        detail: result.trim().split('\n').at(-1) ?? '',
        dedupKey: '/',
      })
    }
    steps.push({ kind: 'quiet', usage })
    return textReply(
      `Root filesystem at ${usage}%, under ${threshold}%. Nothing to report.`,
    )
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      let body: Record<string, unknown> = {}
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        body = {}
      }
      requests.push(body)
      // The node's startup probe, or any other non-streaming side request:
      // a plain completion is enough, and nothing here is part of a turn.
      if (body.stream !== true) return completion()
      return decide(body)
    },
  })
  const port = server.port
  if (port === undefined) throw new Error('model double got no TCP port')
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    steps: () => steps,
    stop: async () => {
      await server.stop(true)
    },
  }
}
