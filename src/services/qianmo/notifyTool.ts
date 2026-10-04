// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qianmo_notify` — the whole tool surface a resident turn is given, and the
 * structural half of hermes E4.
 *
 * ## What E4 asks for, and why this file is the answer
 *
 * *"An unattended turn must not be able to create more unattended turns."*
 * The usual way to satisfy that is a policy: a scheduling tool that refuses
 * when it notices it is running under a timer. Policies are checked at run
 * time by code someone can forget to call, and this one would have to hold for
 * every future tool anyone adds.
 *
 * So the answer here is not a check. **The node has no scheduling API to
 * expose.** `@qianmo/scheduler` runs in the hub process; the resident links
 * against no part of it, and there is no message type an agent could send that
 * would create a job. {@link residentToolSurface} is the complete list of what
 * a resident turn is handed beyond the base tools, it has exactly one entry,
 * and `__tests__/notifyTool.test.ts` asserts that list rather than trusting it.
 *
 * The assertion is on the *list*, not on a grep for "schedule": a rule that
 * only recognizes the words we thought of today would pass a tool called
 * `qianmo_watch_every_hour`. Both are checked — the exact surface, and a
 * decoy proving the pattern half can see a violation when there is one.
 *
 * ## Why `qianmo_` and not `mcp__qianmo__notify`
 *
 * The design sketch (§4.5) reached for an MCP server behind
 * `newSession({ mcpServers })`, on the understanding that the base already
 * wired that parameter through. It does not: `createSessionMethod` uses
 * `params.mcpServers` only to compute a session fingerprint and hands the
 * query engine `mcpClients: []` unconditionally, so no MCP server declared
 * that way has ever produced a tool. Routing through the MCP client stack to
 * fix that would also rename the tool — every MCP tool is `mcp__<server>__…`
 * — which collides with the `qianmo_` prefix rule the same design fixes in
 * E8. A tool injected directly keeps the name the DoD names, and keeps the
 * base touch to one gated branch.
 */

import { z } from 'zod/v4'
import { NOTIFY_KINDS, NOTIFY_SEVERITIES } from '@qianmo/protocol'
import { buildTool, type ToolDef, type Tools } from '../../Tool.js'
import type { QianmoNotifyRequest, QianmoNotifyVerdict } from './notifyWire.js'

export const QIANMO_NOTIFY_TOOL_NAME = 'qianmo_notify'

/**
 * How the tool reaches the resident host.
 *
 * Injected rather than imported so the tool has no idea an ACP connection
 * exists — which is what lets it be exercised without one.
 */
interface QianmoNotifyBridge {
  readonly sessionId: string
  announce(request: QianmoNotifyRequest): Promise<QianmoNotifyVerdict>
}

const DESCRIPTION =
  'Send one short notification to the operator who runs this node. Use it only when a human needs to know something now; routine findings belong in the answer to the task, which is recorded either way.'

const PROMPT = `Announce something to the human operating this node.

This is the ONLY way anything you do reaches a person directly. Everything else
you produce is recorded and can be read later, but nobody is paged for it — that
silence is the intended default for an unattended run, not a limitation to work
around.

Send one when, and only when:
- a watch job found the condition it was watching for;
- something you were asked to keep running has stopped, or is about to;
- you cannot finish the task and waiting will make it worse.

Do not send one to report that a task finished normally, to acknowledge an
instruction, or to repeat something you already announced this run — the node
enforces a hard ceiling of ${'`'}notifyRatePerMinute${'`'} announcements a minute and
anything past it waits.

Keep ${'`'}summary${'`'} to a single line someone can act on without opening anything.
Put the evidence in ${'`'}detail${'`'}. Set ${'`'}dedupKey${'`'} to a stable string for a recurring
condition, and the node will suppress repeats of it that are still undelivered.

The result tells you what actually happened to it. "queued" means the operator's
console is unreachable right now and the node is holding the notification for
it — that is normal and needs nothing from you; do not send it again.`

const inputSchema = z.object({
  kind: z
    .enum(NOTIFY_KINDS)
    .describe(
      'What sort of thing this is: watch (a monitored condition fired), task (something about work you were given), health (this node or agent itself).',
    ),
  severity: z
    .enum(NOTIFY_SEVERITIES)
    .describe(
      'How loud: info, warn, or error. Informational, not a filter — it does not change whether the notification is sent.',
    ),
  summary: z
    .string()
    .min(1)
    .describe('One line a human can act on. No leading label, no timestamp.'),
  detail: z
    .string()
    .optional()
    .describe('The evidence: what was observed, where, and how you know.'),
  dedupKey: z
    .string()
    .optional()
    .describe(
      'A stable key for a recurring condition. While a notification with this key is still undelivered, a second one carrying it is suppressed instead of queued.',
    ),
})
type InputSchema = typeof inputSchema

const outputSchema = z.object({
  status: z
    .enum(['sent', 'queued', 'unsupported', 'duplicate', 'rejected'])
    .describe(
      'sent: on the wire. queued: recorded, waiting for the operator console to come back or for the rate window to open. unsupported: the console is too old to receive notifications. duplicate: suppressed by dedupKey. rejected: not recorded, see detail.',
    ),
  detail: z.string().optional().describe('Why, when the status needs a why.'),
  retryAfterMs: z
    .number()
    .optional()
    .describe('Set only when the rate window is what held it back.'),
})
type OutputSchema = typeof outputSchema

type QianmoNotifyOutput = z.infer<OutputSchema>

/** Text the model reads back. Each status says what it means for the turn. */
function verdictText(verdict: QianmoNotifyVerdict): string {
  switch (verdict.status) {
    case 'sent':
      return 'Notification sent to the operator.'
    case 'queued':
      return verdict.retryAfterMs === undefined
        ? 'Notification recorded. The operator console is not reachable right now; the node will deliver it when the console comes back. Do not send it again.'
        : `Notification recorded but held: this node is at its notification ceiling for the current minute. A slot opens in about ${Math.ceil(
            verdict.retryAfterMs / 1000,
          )}s and the node will deliver it then. Do not send it again.`
    case 'unsupported':
      return 'Not sent: the operator console does not support notifications (older protocol version). Put what you wanted to say in your answer instead.'
    case 'duplicate':
      return 'Not sent: a notification with the same dedupKey is still waiting to be delivered.'
    case 'rejected':
      return `Not sent: ${verdict.detail ?? 'the node refused it'}.`
  }
}

/**
 * Build the tool for one ACP session.
 *
 * Per session rather than a module singleton, because `sessionId` is how the
 * host attributes the announcement to a running turn — and a singleton would
 * have to guess, which on a node that serves several agents is a guess that is
 * wrong exactly when two of them are busy.
 */
function createQianmoNotifyTool(bridge: QianmoNotifyBridge): Tools[number] {
  return buildTool({
    name: QIANMO_NOTIFY_TOOL_NAME,
    // Always in the model's tool list. A resident turn may be the only chance
    // anyone gets to hear about what it found, and a deferred tool is one the
    // model has to think to go looking for.
    alwaysLoad: true,
    maxResultSizeChars: 2_000,
    isConcurrencySafe() {
      return false
    },
    // Not a read: it interrupts a person. Marking it read-only would let it
    // through gates meant for things that cannot be noticed.
    isReadOnly() {
      return false
    },
    isOpenWorld() {
      return true
    },
    toAutoClassifierInput(input) {
      return input.summary
    },
    async description() {
      return DESCRIPTION
    },
    async prompt() {
      return PROMPT
    },
    inputSchema,
    outputSchema,
    async call(input) {
      const verdict = await bridge.announce({
        sessionId: bridge.sessionId,
        kind: input.kind,
        severity: input.severity,
        summary: input.summary,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        ...(input.dedupKey === undefined ? {} : { dedupKey: input.dedupKey }),
      })
      return { data: verdict }
    },
    renderToolUseMessage(input) {
      return `Notify operator (${input.severity}): ${input.summary}`
    },
    userFacingName: () => 'notify',
    mapToolResultToToolResultBlockParam(content, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: verdictText(content),
      }
    },
  } satisfies ToolDef<InputSchema, QianmoNotifyOutput>)
}

/**
 * Everything a resident ACP session is given beyond the base tool set.
 *
 * The E4 surface, and the reason it is a function returning a list rather than
 * an inline `[...]` at the call site: a list at the call site is a list nobody
 * can assert about without booting an ACP agent. This one is pinned by
 * `src/services/qianmo/__tests__/notifyTool.test.ts`, and anything a future
 * batch adds here has to walk past that assertion.
 */
export function residentToolSurface(bridge: QianmoNotifyBridge): Tools {
  return [createQianmoNotifyTool(bridge)]
}
